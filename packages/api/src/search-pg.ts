/**
 * Search & hashtags (W7.6) on PG, SQL LIKE only (upstream `fulltextSearch.provider: sqlLike`;
 * no Meilisearch / pgroonga):
 * notes/search, notes/search-by-tag, users/search, hashtags/list|search|show|users|trend,
 * plus hashtag extraction (mfm-js, as upstream) and the `hashtag` table bookkeeping used by
 * notes/create (mentioned*) and i/update (attached*). admin/roles/update-default-policies
 * lets an admin enable `canSearchNotes` (off by default upstream).
 */

import { NoteQuery } from "./note-query.js";
import { metaRowPg } from "./user-lite-pg.js";
import * as mfm from "mfm-js";
import { genAidx, genAidxFromDate, parseAidxTime } from "../../id/src/index.js";
import { DEFAULT_POLICIES } from "../../packers/src/index.js";
import type { ApiEnv } from "./env.js";
import { apiErrorResponse, CREDENTIAL_REQUIRED } from "./errors.js";
import { authenticatePg, extractToken } from "./auth-pg.js";
import { buildPackConfig, loadMetaSource } from "./meta-source.js";
import { packNotesFromPg } from "./notes-pg.js";
import { invalidateMetaCache } from "./meta-runtime.js";
import { withHyperdriveClient, type PgQueryable } from "./pg.js";
import { getUserPoliciesPg, hasRolePolicyPg, moderationLogPg } from "./policies-pg.js";
import { listNotes, packUsers } from "./client-endpoints-pg.js";
import { likeEscape } from "./clips-pg.js";
import { adminGate } from "./admin-gate.js";
import { ROLE_PERMISSION_DENIED } from "./emojis-pg.js";
import { clientError as err, errorResponse as fail, hd, invalidParam as bad } from "./handler-kit.js";

type Ctx = { hasCredential: boolean; request: Request };
type Body = Record<string, unknown>;
export type SearchHandler = (env: ApiEnv, body: Body, ctx: Ctx) => Promise<Response | unknown>;

const E = {
  unavailable: err("UNAVAILABLE", "0b44998d-77aa-4427-80d0-d2c9b8523011", "Search of notes unavailable."),
  noSuchHashtag: err("NO_SUCH_HASHTAG", "110ee688-193e-4a3a-9ecf-c167b2e6981e", "No such hashtag."),
};
const intOf = (v: unknown, def: number, min: number, max: number) =>
  typeof v === "number" && Number.isFinite(v) ? Math.max(min, Math.min(max, Math.floor(v))) : def;

/** Optional credential: null when anonymous, "invalid" when a credential was sent but did not authenticate. */
async function optAuth(env: ApiEnv, body: Body, ctx: Ctx): Promise<string | null | "invalid"> {
  if (!ctx.hasCredential) return null;
  const token = extractToken(ctx.request, body);
  if (!token) return null;
  return (await authenticatePg(env, token))?.user.id ?? "invalid";
}

// ---------------------------------------------------------------- hashtag helpers

/** upstream misc/normalize-for-search */
export function normalizeForSearch(tag: string): string {
  return tag.normalize("NFKC").toLowerCase();
}

/** upstream misc/safe-for-sql */
export function safeForSql(text: string): boolean {
  return !/[\0\x08\x09\x1a\n\r"'\\%]/g.test(text);
}

function extractHashtagsFromNodes(nodes: mfm.MfmNode[]): string[] {
  const tags = mfm.extract(nodes, (n) => n.type === "hashtag").map((n) => (n as mfm.MfmHashtag).props.hashtag);
  return [...new Set(tags)];
}

/**
 * NoteCreateService: hashtags from text + cw + poll choices (mfm-js), unique, ≤128 chars each,
 * first 32. Returns the raw tags; note.tags stores them normalized.
 */
export function extractNoteHashtags(text: string | null, cw: string | null, choices: string[] = []): string[] {
  const nodes = [
    ...(text ? mfm.parse(text) : []),
    ...(cw ? mfm.parse(cw) : []),
    ...choices.flatMap((c) => mfm.parse(c)),
  ];
  return extractHashtagsFromNodes(nodes).filter((t) => Array.from(t).length <= 128).splice(0, 32);
}

/** i/update: profile description hashtags, normalized, first 32. */
export function extractProfileHashtags(description: string | null): string[] {
  if (description == null) return [];
  return extractHashtagsFromNodes(mfm.parse(description)).map(normalizeForSearch).splice(0, 32);
}

const COLS = {
  mentioned: { total: "mentioned", local: "mentionedLocal", remote: "mentionedRemote" },
  attached: { total: "attached", local: "attachedLocal", remote: "attachedRemote" },
} as const;

/** HashtagService.updateHashtag (increment / decrement on the `hashtag` table). */
export async function updateHashtagPg(
  c: PgQueryable,
  user: { id: string; host: string | null },
  rawTag: string,
  isUserAttached = false,
  inc = true,
): Promise<void> {
  const tag = normalizeForSearch(rawTag);
  const col = isUserAttached ? COLS.attached : COLS.mentioned;
  const tIds = `${col.total}UserIds`;
  const tCnt = `${col.total}UsersCount`;
  const lrIds = `${user.host == null ? col.local : col.remote}UserIds`;
  const lrCnt = `${user.host == null ? col.local : col.remote}UsersCount`;
  if (inc) {
    const append = (ids: string) => `CASE WHEN NOT (hashtag."${ids}" @> ARRAY[$2::varchar]) THEN array_append(hashtag."${ids}", $2::varchar) ELSE hashtag."${ids}" END`;
    const incr = (ids: string, cnt: string) => `CASE WHEN NOT (hashtag."${ids}" @> ARRAY[$2::varchar]) THEN hashtag."${cnt}" + 1 ELSE hashtag."${cnt}" END`;
    await c.query(
      `INSERT INTO hashtag (id, name, "${tIds}", "${tCnt}", "${lrIds}", "${lrCnt}")
       VALUES ($3, $1, ARRAY[$2::varchar], 1, ARRAY[$2::varchar], 1)
       ON CONFLICT (name) DO UPDATE SET
         "${tIds}" = ${append(tIds)}, "${tCnt}" = ${incr(tIds, tCnt)},
         "${lrIds}" = ${append(lrIds)}, "${lrCnt}" = ${incr(lrIds, lrCnt)}`,
      [tag, user.id, genAidx(Date.now())],
    );
  } else {
    const dec = (ids: string, cnt: string) => `CASE WHEN ("${ids}" @> ARRAY[$2::varchar]) THEN "${cnt}" - 1 ELSE "${cnt}" END`;
    await c.query(
      `UPDATE hashtag SET
         "${tIds}" = array_remove("${tIds}", $2::varchar), "${tCnt}" = ${dec(tIds, tCnt)},
         "${lrIds}" = array_remove("${lrIds}", $2::varchar), "${lrCnt}" = ${dec(lrIds, lrCnt)}
       WHERE name = $1`,
      [tag, user.id],
    );
  }
}

/** HashtagService.updateHashtags (note author → mentioned*). */
export async function updateHashtagsPg(env: ApiEnv, user: { id: string; host: string | null }, tags: string[]): Promise<void> {
  if (!tags.length) return;
  await withHyperdriveClient(hd(env), async (c) => {
    for (const t of tags) await updateHashtagPg(c, user, t);
  });
}

/**
 * i/update: recompute `user.tags` from the (new or current) description and run
 * HashtagService.updateUsertags (attached* counts; removed tags are decremented).
 */
export async function updateUserTagsPg(env: ApiEnv, userId: string, newDescription: string | null | undefined): Promise<string[]> {
  return withHyperdriveClient(hd(env), async (c) => {
    const r = await c.query(
      `SELECT u.host, u.tags, p.description FROM "user" u LEFT JOIN user_profile p ON p."userId" = u.id WHERE u.id = $1`,
      [userId],
    );
    const row = r.rows[0];
    if (!row) return [];
    const desc = newDescription === undefined ? ((row.description as string | null) ?? null) : newDescription;
    const tags = extractProfileHashtags(desc);
    const old = Array.isArray(row.tags) ? (row.tags as string[]) : [];
    await c.query(`UPDATE "user" SET tags = $2::varchar[] WHERE id = $1`, [userId, tags]);
    const user = { id: userId, host: (row.host as string | null) ?? null };
    for (const t of tags) await updateHashtagPg(c, user, t, true, true);
    for (const t of old.filter((x) => !tags.includes(x))) await updateHashtagPg(c, user, t, true, false);
    return tags;
  });
}

// ---------------------------------------------------------------- policies

async function basePolicies(env: ApiEnv): Promise<Record<string, unknown>> {
  const meta = await loadMetaSource(env);
  return { ...DEFAULT_POLICIES, ...((meta as { policies?: Record<string, unknown> }).policies ?? {}) };
}

async function policiesFor(env: ApiEnv, me: string | null): Promise<Record<string, unknown>> {
  if (!me) return basePolicies(env);
  return withHyperdriveClient(hd(env), (c) => getUserPoliciesPg(env, c, me));
}

// ---------------------------------------------------------------- notes/search

const notesSearch: SearchHandler = async (env, body, ctx) => {
  const me = await optAuth(env, body, ctx);
  if (me === "invalid") return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  const untilId = typeof body.untilId === "string" ? body.untilId : body.untilDate ? genAidx(Number(body.untilDate)) : null;
  const sinceId = typeof body.sinceId === "string" ? body.sinceId : body.sinceDate ? genAidx(Number(body.sinceDate)) : null;
  // upstream: policies.canSearchNotes (false by default) → UNAVAILABLE
  if (!(await policiesFor(env, me)).canSearchNotes) return fail(E.unavailable);
  // SearchService.searchNoteByLike
  const notes = await withHyperdriveClient(hd(env), async (c) => {
    const q = new NoteQuery(await metaRowPg(c)).paginate(sinceId, untilId);
    if (typeof body.userId === "string") q.and(`note."userId" = ${q.p(body.userId)}`);
    else if (typeof body.channelId === "string") q.and(`note."channelId" = ${q.p(body.channelId)}`);
    q.and(`LOWER(note.text) LIKE ${q.p(`%${likeEscape(String(body.query).toLowerCase())}%`)}`);
    if (typeof body.host === "string" && body.host) {
      if (body.host === ".") q.and(`note."userHost" IS NULL`);
      else q.and(`note."userHost" = ${q.p(body.host)}`);
    }
    if (typeof body.rangeStartAt === "number") q.and(`note.id > ${q.p(genAidx(body.rangeStartAt - 1))}`);
    if (typeof body.rangeEndAt === "number") q.and(`note.id < ${q.p(genAidx(body.rangeEndAt + 1))}`);
    q.visibility(me);
    if (me == null) q.ugcVisibilityForVisitor();
    q.baseFiltering(me);
    return q.run(c, typeof body.limit === "number" ? body.limit : 10);
  });
  return packNotesFromPg(env, notes, buildPackConfig(env), me);
};

// ---------------------------------------------------------------- notes/search-by-tag

const notesSearchByTag: SearchHandler = async (env, body, ctx) => {
  const me = await optAuth(env, body, ctx);
  if (me === "invalid") return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  const notes = await withHyperdriveClient(hd(env), async (c) => {
    const q = new NoteQuery(await metaRowPg(c)).paginate(
      typeof body.sinceId === "string" ? body.sinceId : null,
      typeof body.untilId === "string" ? body.untilId : null,
      typeof body.sinceDate === "number" ? body.sinceDate : null,
      typeof body.untilDate === "number" ? body.untilDate : null,
    );
    q.visibility(me);
    if (me == null) q.ugcVisibilityForVisitor();
    q.baseFiltering(me);
    // upstream throws Error('Injection') for unsafe tags; `e === 'Injection'` never matches, so it is an INTERNAL_ERROR
    const tagCond = (t: string) => {
      const n = normalizeForSearch(t);
      if (!safeForSql(n)) throw new Error("Injection");
      return `${q.p([n])}::varchar[] <@ note.tags`;
    };
    if (typeof body.tag === "string") q.and(tagCond(body.tag));
    else q.and((body.query as string[][]).map((tags) => `(${tags.map(tagCond).join(" AND ")})`).join(" OR "));
    if (body.reply != null) q.and(body.reply ? `note."replyId" IS NOT NULL` : `note."replyId" IS NULL`);
    if (body.renote != null) q.and(body.renote ? `note."renoteId" IS NOT NULL` : `note."renoteId" IS NULL`);
    if (body.withFiles === true) q.and(`note."fileIds" != '{}'`);
    if (body.poll != null) q.and(body.poll ? `note."hasPoll" = TRUE` : `note."hasPoll" = FALSE`);
    return q.run(c, typeof body.limit === "number" ? body.limit : 10);
  });
  return packNotesFromPg(env, notes, buildPackConfig(env), me);
};

// ---------------------------------------------------------------- users/search

const LOCAL_USERNAME = /^\w{1,20}$/;
const ORIGINS = ["local", "remote", "combined"];

const usersSearch: SearchHandler = async (env, body, ctx) => {
  const me = await optAuth(env, body, ctx);
  if (me === "invalid") return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  if (typeof body.query !== "string") return bad();
  if (body.origin !== undefined && !ORIGINS.includes(body.origin as string)) return bad();
  if (body.detail !== undefined && typeof body.detail !== "boolean") return bad();
  // requiredRolePolicy: canSearchUsers (root / administrator role / policy). Anonymous → base policy.
  const allowed = me
    ? await withHyperdriveClient(hd(env), (c) => hasRolePolicyPg(env, c, me, "canSearchUsers"))
    : Boolean((await basePolicies(env)).canSearchUsers);
  if (!allowed) return apiErrorResponse(ROLE_PERMISSION_DENIED, 403);

  const query = body.query.trim();
  const limit = intOf(body.limit, 10, 1, 100);
  const offset = intOf(body.offset, 0, 0, Number.MAX_SAFE_INTEGER);
  const origin = (body.origin as string | undefined) ?? "combined";
  const isUsername = query.startsWith("@") && !query.includes(" ") && query.indexOf("@", 1) === -1;
  const active = `(u."updatedAt" IS NULL OR u."updatedAt" > now() - interval '30 days') AND u."isSuspended" = FALSE`;

  const ids = await withHyperdriveClient(hd(env), async (c) => {
    // name / username
    const p1: unknown[] = [`%${likeEscape(query)}%`];
    let nameCond = `u.name ILIKE $1`;
    if (isUsername) {
      p1.push(`${likeEscape(query.replace("@", "").toLowerCase())}%`);
      nameCond += ` OR u."usernameLower" LIKE $${p1.length}`;
    } else if (LOCAL_USERNAME.test(query)) {
      p1.push(`%${likeEscape(query.toLowerCase())}%`);
      nameCond += ` OR u."usernameLower" LIKE $${p1.length}`;
    }
    const w1 = [`(${nameCond})`, active];
    if (me) {
      p1.push(me);
      w1.push(`u.id NOT IN (SELECT "muteeId" FROM muting WHERE "muterId" = $${p1.length})`);
    }
    if (origin === "local") w1.push(`u.host IS NULL`);
    else if (origin === "remote") w1.push(`u.host IS NOT NULL`);
    p1.push(limit, offset);
    const r1 = await c.query(
      `SELECT u.id FROM "user" u WHERE ${w1.join(" AND ")}
       ORDER BY u."updatedAt" DESC NULLS LAST, u.id DESC LIMIT $${p1.length - 1} OFFSET $${p1.length}`,
      p1,
    );
    const out = r1.rows.map((r) => String(r.id));
    if (out.length < limit) {
      // profile description
      const p2: unknown[] = [`%${likeEscape(query)}%`];
      const w2 = [`p.description ILIKE $1`];
      if (me) {
        p2.push(me);
        w2.push(`p."userId" NOT IN (SELECT "muteeId" FROM muting WHERE "muterId" = $${p2.length})`);
      }
      if (origin === "local") w2.push(`p."userHost" IS NULL`);
      else if (origin === "remote") w2.push(`p."userHost" IS NOT NULL`);
      p2.push(limit, offset);
      const r2 = await c.query(
        `SELECT u.id FROM "user" u
         WHERE u.id IN (SELECT p."userId" FROM user_profile p WHERE ${w2.join(" AND ")}) AND ${active}
         ORDER BY u."updatedAt" DESC NULLS LAST, u.id DESC LIMIT $${p2.length - 1} OFFSET $${p2.length}`,
        p2,
      );
      // upstream concatenates both lists as is (a user can appear twice)
      for (const r of r2.rows) out.push(String(r.id));
    }
    return out;
  });
  return packUsers(env, ids, me, body.detail !== false);
};

// ---------------------------------------------------------------- hashtags/*

const HASHTAG_COLS = `name, "mentionedUsersCount", "mentionedLocalUsersCount", "mentionedRemoteUsersCount",
  "attachedUsersCount", "attachedLocalUsersCount", "attachedRemoteUsersCount"`;

/** HashtagEntityService.pack */
function packHashtag(r: Record<string, unknown>) {
  return {
    tag: String(r.name),
    mentionedUsersCount: Number(r.mentionedUsersCount ?? 0),
    mentionedLocalUsersCount: Number(r.mentionedLocalUsersCount ?? 0),
    mentionedRemoteUsersCount: Number(r.mentionedRemoteUsersCount ?? 0),
    attachedUsersCount: Number(r.attachedUsersCount ?? 0),
    attachedLocalUsersCount: Number(r.attachedLocalUsersCount ?? 0),
    attachedRemoteUsersCount: Number(r.attachedRemoteUsersCount ?? 0),
  };
}

const LIST_SORT: Record<string, string> = {
  mentionedUsers: "mentionedUsersCount",
  mentionedLocalUsers: "mentionedLocalUsersCount",
  mentionedRemoteUsers: "mentionedRemoteUsersCount",
  attachedUsers: "attachedUsersCount",
  attachedLocalUsers: "attachedLocalUsersCount",
  attachedRemoteUsers: "attachedRemoteUsersCount",
};

const hashtagsList: SearchHandler = async (env, body) => {
  const sort = typeof body.sort === "string" ? body.sort : "";
  const col = LIST_SORT[sort.slice(1)];
  if (!col || (sort[0] !== "+" && sort[0] !== "-")) return bad();
  const w: string[] = [];
  if (body.attachedToUserOnly === true) w.push(`"attachedUsersCount" != 0`);
  if (body.attachedToLocalUserOnly === true) w.push(`"attachedLocalUsersCount" != 0`);
  if (body.attachedToRemoteUserOnly === true) w.push(`"attachedRemoteUsersCount" != 0`);
  const rows = await withHyperdriveClient(hd(env), async (c) =>
    (await c.query(
      `SELECT ${HASHTAG_COLS} FROM hashtag ${w.length ? `WHERE ${w.join(" AND ")}` : ""}
       ORDER BY "${col}" ${sort[0] === "+" ? "DESC" : "ASC"}, id LIMIT $1`,
      [intOf(body.limit, 10, 1, 100)],
    )).rows,
  );
  return rows.map(packHashtag);
};

const hashtagsSearch: SearchHandler = async (env, body) => {
  if (typeof body.query !== "string") return bad();
  const rows = await withHyperdriveClient(hd(env), async (c) =>
    (await c.query(
      `SELECT name FROM hashtag WHERE name LIKE $1 ORDER BY "mentionedLocalUsersCount" DESC, id LIMIT $2 OFFSET $3`,
      [`${likeEscape((body.query as string).toLowerCase())}%`, intOf(body.limit, 10, 1, 100), intOf(body.offset, 0, 0, Number.MAX_SAFE_INTEGER)],
    )).rows,
  );
  return rows.map((r) => String(r.name));
};

const hashtagsShow: SearchHandler = async (env, body) => {
  if (typeof body.tag !== "string") return bad();
  const row = await withHyperdriveClient(hd(env), async (c) =>
    (await c.query(`SELECT ${HASHTAG_COLS} FROM hashtag WHERE name = $1`, [normalizeForSearch(body.tag as string)])).rows[0],
  );
  if (!row) return fail(E.noSuchHashtag);
  return packHashtag(row);
};

const USERS_SORT: Record<string, string> = {
  "+follower": `u."followersCount" DESC`,
  "-follower": `u."followersCount" ASC`,
  "+createdAt": `u.id DESC`,
  "-createdAt": `u.id ASC`,
  "+updatedAt": `u."updatedAt" DESC`,
  "-updatedAt": `u."updatedAt" ASC`,
};

const hashtagsUsers: SearchHandler = async (env, body, ctx) => {
  const me = await optAuth(env, body, ctx);
  if (me === "invalid") return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  if (typeof body.tag !== "string") return bad();
  const order = USERS_SORT[body.sort as string];
  if (!order) return bad();
  if (body.state !== undefined && body.state !== "all" && body.state !== "alive") return bad();
  if (body.origin !== undefined && !ORIGINS.includes(body.origin as string)) return bad();
  const tag = normalizeForSearch(body.tag);
  // upstream throws Error('Injection') -> INTERNAL_ERROR
  if (!safeForSql(tag)) throw new Error("Injection");
  const w = [`u.tags @> $1::varchar[]`, `u."isSuspended" = FALSE`];
  if (body.state === "alive") w.push(`u."updatedAt" > now() - interval '5 days'`);
  const origin = (body.origin as string | undefined) ?? "local";
  if (origin === "local") w.push(`u.host IS NULL`);
  else if (origin === "remote") w.push(`u.host IS NOT NULL`);
  const ids = await withHyperdriveClient(hd(env), async (c) =>
    (await c.query(
      `SELECT u.id FROM "user" u WHERE ${w.join(" AND ")} ORDER BY ${order}, u.id LIMIT $2 OFFSET $3`,
      [[tag], intOf(body.limit, 10, 1, 100), intOf(body.offset, 0, 0, Number.MAX_SAFE_INTEGER)],
    )).rows.map((r) => String(r.id)),
  );
  return packUsers(env, ids, me, true);
};

// ---------------------------------------------------------------- hashtags/trend

const HOUR = 60 * 60 * 1000;
const TEN_MIN = 10 * 60 * 1000;
const FEATURED_EPOCH = Date.UTC(2023, 0, 1);
const CHART_RANGE = 20;
const TREND_CACHE_MS = 60 * 1000; // upstream cacheSec: 60
let trendCache: { at: number; value: unknown[] } | null = null;

/** UtilityService.isKeyWordIncluded (RE2 → RegExp). */
export function isKeyWordIncluded(text: string, keyWords: string[]): boolean {
  if (keyWords.length === 0 || text === "") return false;
  return keyWords.some((filter) => {
    const m = filter.match(/^\/(.+)\/(.*)$/);
    if (!m) return filter.split(" ").every((k) => text.includes(k));
    try {
      return new RegExp(m[1]!, m[2]).test(text);
    } catch {
      return false;
    }
  });
}

/**
 * Upstream ranks hashtags with Redis (FeaturedService, 1-hour windows; a user counts once
 * per tag per window) and charts unique users per 10-minute window (HyperLogLog). Here both
 * come from PG `note` rows (public/home, non-empty tags) of the last 200 minutes, read in
 * one primary-key range scan. Ranking order matches upstream: current window by score, then
 * previous-window tags not already listed (top 11 each).
 */
export function computeTrend(
  rows: { id: string; userId: string; tags: string[] }[],
  now: number,
  hidden: Set<string>,
  sensitiveWords: string[],
): { tag: string; chart: number[]; usersCount: number }[] {
  const curWindow = Math.floor((now - FEATURED_EPOCH) / HOUR);
  const curStart = FEATURED_EPOCH + curWindow * HOUR;
  const prevStart = curStart - HOUR;
  const bucket0 = Math.floor(now / TEN_MIN) * TEN_MIN;
  const cur = new Map<string, Set<string>>();
  const prev = new Map<string, Set<string>>();
  const chart = new Map<string, Set<string>[]>();
  for (const r of rows) {
    const t = parseAidxTime(r.id)?.getTime();
    if (t == null) continue;
    for (const raw of new Set(r.tags)) {
      const tag = normalizeForSearch(raw);
      if (hidden.has(tag) || isKeyWordIncluded(tag, sensitiveWords)) continue;
      const win = t >= curStart ? cur : t >= prevStart ? prev : null;
      if (win) (win.get(tag) ?? win.set(tag, new Set()).get(tag)!).add(r.userId);
      const i = t >= bucket0 ? 0 : Math.floor((bucket0 - 1 - t) / TEN_MIN) + 1;
      if (i < CHART_RANGE) {
        const arr = chart.get(tag) ?? chart.set(tag, Array.from({ length: CHART_RANGE }, () => new Set<string>())).get(tag)!;
        arr[i]!.add(r.userId);
      }
    }
  }
  const top = (m: Map<string, Set<string>>) =>
    [...m.entries()].sort((a, b) => b[1].size - a[1].size || (a[0] < b[0] ? -1 : 1)).slice(0, 11).map(([k]) => k);
  const ranking = [...top(cur)];
  for (const k of top(prev)) if (!ranking.includes(k)) ranking.push(k);
  return ranking.map((tag) => {
    const c = (chart.get(tag) ?? []).map((s) => s.size);
    while (c.length < CHART_RANGE) c.push(0);
    return { tag, chart: c, usersCount: Math.max(...c) };
  });
}

const hashtagsTrend: SearchHandler = async (env) => {
  if (!env.HYPERDRIVE?.connectionString) return [];
  const now = Date.now();
  if (trendCache && now - trendCache.at < TREND_CACHE_MS && !(env as { __noTrendCache?: boolean }).__noTrendCache) return trendCache.value;
  const since = genAidxFromDate(new Date(Math.floor(now / TEN_MIN) * TEN_MIN - CHART_RANGE * TEN_MIN)).slice(0, 8);
  const { rows, hidden, sensitive } = await withHyperdriveClient(hd(env), async (c) => {
    // older schema without these columns: nothing hidden
    const m = await metaRowPg(c);
    const r = await c.query(
      `SELECT id, "userId", tags FROM note
       WHERE id > $1 AND tags <> '{}' AND visibility IN ('public', 'home') ORDER BY id DESC LIMIT 5000`,
      [since],
    );
    return {
      rows: r.rows.map((x) => ({ id: String(x.id), userId: String(x.userId), tags: (x.tags as string[]) ?? [] })),
      hidden: new Set(((m.hiddenTags as string[] | null | undefined) ?? []).map(normalizeForSearch)),
      sensitive: (m.sensitiveWords as string[] | null | undefined) ?? [],
    };
  });
  const value = computeTrend(rows, now, hidden, sensitive);
  trendCache = { at: now, value };
  return value;
};

// ---------------------------------------------------------------- admin/roles/update-default-policies

const updateDefaultPolicies: SearchHandler = async (env, body, ctx) => {
  const denied = await adminGate(ctx.request, env as never, body, "admin");
  if (denied) return denied;
  const p = body.policies;
  if (!p || typeof p !== "object" || Array.isArray(p)) return bad();
  const me = (await authenticatePg(env, extractToken(ctx.request, body) ?? ""))?.user.id ?? null;
  await withHyperdriveClient(hd(env), async (c) => {
    const cur = (await c.query(`SELECT id, policies FROM meta ORDER BY id DESC LIMIT 1`, [])).rows[0];
    if (!cur) return;
    await c.query(`UPDATE meta SET policies = $2::jsonb WHERE id = $1`, [cur.id, JSON.stringify(p)]);
    if (me) await moderationLogPg(c, me, "updateServerSettings", { before: cur.policies ?? {}, after: p }, genAidx(Date.now()));
  });
  await invalidateMetaCache(env);
  return new Response(null, { status: 204 });
};

// ---------------------------------------------------------------- registry

function pgOnly(h: SearchHandler): SearchHandler {
  return async (env, body, ctx) => {
    if (!env.HYPERDRIVE?.connectionString) {
      return apiErrorResponse({ message: "Hyperdrive required.", code: "HYPERDRIVE_UNBOUND", id: "00000000-0000-4000-8000-0000000000b1", kind: "server" }, 501);
    }
    return h(env, body, ctx);
  };
}

const RAW: Record<string, SearchHandler> = {
  "notes/search": notesSearch,
  "notes/search-by-tag": notesSearchByTag,
  "users/search": usersSearch,
  "hashtags/list": hashtagsList,
  "hashtags/search": hashtagsSearch,
  "hashtags/show": hashtagsShow,
  "hashtags/users": hashtagsUsers,
  "admin/roles/update-default-policies": updateDefaultPolicies,
};

export const searchHandlers: Record<string, SearchHandler> = {
  ...Object.fromEntries(Object.entries(RAW).map(([k, h]) => [k, pgOnly(h)])),
  // PG-free fallback: [] without Hyperdrive (the web client calls it at boot)
  "hashtags/trend": hashtagsTrend,
};

