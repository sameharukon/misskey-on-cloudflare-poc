/**
 * Remaining small client / top-level endpoints, following upstream:
 * announcements/show, my/apps, users/recommendation, users/get-frequently-replied-users,
 * users/get-following-users-by-birthday, notes, users, retention (+ daily aggregation from cron),
 * page-push, email-address/available, server-info, test, reset-db, fetch-rss,
 * fetch-external-resources.
 */

import { fetchChecked } from "./safe-fetch.js";
import { genAidx, parseAidxTime } from "../../id/src/index.js";
import type { ApiEnv } from "./env.js";
import { apiErrorResponse, CREDENTIAL_REQUIRED, INTERNAL_ERROR, type ApiErrorBody } from "./errors.js";
import { withHyperdriveClient, type PgQueryable } from "./pg.js";
import { packAnnouncement, packUsers, pagination, visibilitySql } from "./client-endpoints-pg.js";
import { buildPackConfig } from "./meta-source.js";
import { getNotesByIdsPg, packNotesFromPg } from "./notes-pg.js";
import { publishToUserStream } from "./stream-publish.js";
import { parseFeed } from "./rss.js";
import { authUserId as auth, errorResponse as fail, hd, invalidParam as bad, optionalUserId as optionalMe } from "./handler-kit.js";
import { metaRowPg } from "./user-lite-pg.js";

type Ctx = { hasCredential: boolean; request: Request };
type Body = Record<string, unknown>;
type Handler = (env: ApiEnv, body: Body, ctx: Ctx) => Promise<Response | unknown>;
type Row = Record<string, unknown>;

const err = (code: string, id: string, message: string, kind: ApiErrorBody["kind"] = "client"): ApiErrorBody => ({ message, code, id, kind });
const E = {
  noSuchAnnouncement: err("NO_SUCH_ANNOUNCEMENT", "b57b5e1d-4f49-404a-9edb-46b00268f121", "No such announcement."),
  repliedNoSuchUser: err("NO_SUCH_USER", "e6965129-7b2a-40a4-bae2-cd84cd434822", "No such user."),
  noSuchPage: err("NO_SUCH_PAGE", "4a13ad31-6729-46b4-b9af-e86b265c2e74", "No such page."),
  invalidUrl: err("INVALID_URL", "89b7ee05-ccfc-4bdd-9b13-61172fd1e06c", "Invalid URL."),
  fetchRssUnavailable: err("FETCH_RSS_UNAVAILABLE", "91e6ff44-c63f-4725-9ad0-b7a40d7f7655", "RSS fetching is temporarily unavailable.", "server"),
  fetchRssFailed: err("FETCH_RSS_FAILED", "8db5d3d8-31d7-452f-b0cc-ca3b8925de12", "Failed to fetch RSS.", "server"),
  invalidSchema: err("EXT_RESOURCE_RETURNED_INVALID_SCHEMA", "bb774091-7a15-4a70-9dc5-6ac8cf125856", "External resource returned invalid schema."),
  hashUnmatched: err("EXT_RESOURCE_HASH_DIDNT_MATCH", "693ba8ba-b486-40df-a174-72f8279b56a4", "Hash did not match."),
};

const noContent = () => new Response(null, { status: 204 });
const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);
const DAY = 24 * 3600_000;

const limitOf = (body: Body, def = 10): number | null => {
  const l = body.limit === undefined ? def : body.limit;
  return isInt(l) && l >= 1 && l <= 100 ? l : null;
};
const offsetOf = (body: Body): number | null => {
  const o = body.offset === undefined ? 0 : body.offset;
  return isInt(o) && o >= 0 ? o : null;
};

/** Latest `meta` row as JSON (columns this schema may not have read as undefined). */
async function metaRow(c: PgQueryable): Promise<Row> {
  return metaRowPg(c);
}

/** Users the viewer mutes or blocks / is blocked by (upstream generateMutedUserQueryForUsers + generateBlockQueryForUsers). */
function excludeRelatedSql(col: string, meParam: string): string {
  return `${col} NOT IN (SELECT "muteeId" FROM muting WHERE "muterId" = ${meParam} AND ("expiresAt" IS NULL OR "expiresAt" > now()))
    AND ${col} NOT IN (SELECT "blockeeId" FROM blocking WHERE "blockerId" = ${meParam})
    AND ${col} NOT IN (SELECT "blockerId" FROM blocking WHERE "blockeeId" = ${meParam})`;
}

// ---------------------------------------------------------------- announcements/show, my/apps

const announcementShow: Handler = async (env, body, ctx) => {
  const me = await optionalMe(env, body, ctx);
  if (me === "invalid") return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  if (typeof body.announcementId !== "string") return bad();
  return withHyperdriveClient(hd(env), async (c) => {
    const a = (await c.query(`SELECT * FROM announcement WHERE id = $1`, [body.announcementId])).rows[0];
    if (!a || (a.userId && a.userId !== me)) return fail(E.noSuchAnnouncement);
    if (!me) return packAnnouncement(a, null, undefined);
    const read = (await c.query(`SELECT 1 AS ok FROM announcement_read WHERE "announcementId" = $1 AND "userId" = $2`, [a.id, me])).rows.length > 0;
    return packAnnouncement(a, me, read);
  });
};

const myApps: Handler = async (env, body, ctx) => {
  const me = await auth(env, body, ctx);
  if (!me) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  const limit = limitOf(body);
  const offset = offsetOf(body);
  if (limit == null || offset == null) return bad();
  return withHyperdriveClient(hd(env), async (c) => {
    const apps = (await c.query(
      `SELECT a.*, EXISTS (SELECT 1 FROM access_token t WHERE t."appId" = a.id AND t."userId" = $1) AS "isAuthorized"
       FROM app a WHERE a."userId" = $1 ORDER BY a.id LIMIT $2 OFFSET $3`,
      [me, limit, offset],
    )).rows;
    return apps.map((a) => ({ id: a.id, name: a.name, callbackUrl: a.callbackUrl ?? null, permission: a.permission ?? [], isAuthorized: Boolean(a.isAuthorized) }));
  });
};

// ---------------------------------------------------------------- users/*

/**
 * upstream users/recommendation applies generateBlockedUserQueryForNotes (`note.userId` …) to a
 * query over `user` only, so PostgreSQL rejects it ("missing FROM-clause entry for table note")
 * and every call ends in INTERNAL_ERROR. Reproduced as is.
 */
const recommendation: Handler = async (env, body, ctx) => {
  const me = await auth(env, body, ctx);
  if (!me) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  throw new Error('missing FROM-clause entry for table "note"');
};

const frequentlyRepliedUsers: Handler = async (env, body, ctx) => {
  const me = await optionalMe(env, body, ctx);
  if (me === "invalid") return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  const limit = limitOf(body);
  if (limit == null || typeof body.userId !== "string") return bad();
  const counts = await withHyperdriveClient(hd(env), async (c) => {
    const u = (await c.query(`SELECT id FROM "user" WHERE id = $1`, [body.userId])).rows[0];
    if (!u) return null;
    const params: unknown[] = [u.id];
    const viewer = me ? `$${params.push(me)}` : null;
    // the target's own notes are always visible to themselves
    const ugcNone = !me && (await metaRow(c)).ugcVisibilityForVisitor === "none";
    const vis = me === u.id ? "TRUE" : ugcNone ? "FALSE" : visibilitySql(viewer, "n");
    const recent = (await c.query(
      `SELECT n."replyId" FROM note n WHERE n."userId" = $1 AND n."replyId" IS NOT NULL AND ${vis} ORDER BY n.id DESC LIMIT 1000`,
      params,
    )).rows.map((r) => String(r.replyId));
    if (!recent.length) return new Map<string, number>();
    const p2: unknown[] = [recent];
    const viewer2 = me ? `$${p2.push(me)}` : null;
    const targets = (await c.query(
      `SELECT n."userId" FROM note n WHERE n.id = ANY($1::varchar[]) AND ${ugcNone ? "FALSE" : visibilitySql(viewer2, "n")}`,
      p2,
    )).rows;
    const m = new Map<string, number>();
    for (const t of targets) m.set(String(t.userId), (m.get(String(t.userId)) ?? 0) + 1);
    return m;
  });
  if (counts == null) return fail(E.repliedNoSuchUser);
  if (!counts.size) return [];
  const peak = Math.max(...counts.values());
  const top = [...counts.keys()].sort((a, b) => counts.get(b)! - counts.get(a)!).slice(0, limit);
  const users = new Map(((await packUsers(env, top, me, true)) as { id: string }[]).map((u) => [u.id, u]));
  return top.filter((id) => users.has(id)).map((id) => ({ user: users.get(id), weight: counts.get(id)! / peak }));
};

type MonthDay = { month: number; day: number };
const monthDay = (v: unknown): MonthDay | null => {
  if (!v || typeof v !== "object") return null;
  const { month, day } = v as Record<string, unknown>;
  return isInt(month) && month >= 1 && month <= 12 && isInt(day) && day >= 1 && day <= 31 ? { month, day } : null;
};

const followingByBirthday: Handler = async (env, body, ctx) => {
  const me = await auth(env, body, ctx);
  if (!me) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  const limit = limitOf(body);
  const offset = offsetOf(body);
  if (limit == null || offset == null || !body.birthday || typeof body.birthday !== "object") return bad();
  const b = body.birthday as Record<string, unknown>;
  const params: unknown[] = [me];
  let cond: string;
  if (Object.hasOwn(b, "begin") && Object.hasOwn(b, "end")) {
    const begin = monthDay(b.begin);
    const end = monthDay(b.end);
    if (!begin || !end) return bad();
    const bv = begin.month * 100 + begin.day;
    const ev = end.month * 100 + end.day;
    params.push(bv, ev);
    cond = bv <= ev
      ? `get_birthday_date(p.birthday) BETWEEN $2 AND $3`
      : `(get_birthday_date(p.birthday) BETWEEN $2 AND 1231 OR get_birthday_date(p.birthday) BETWEEN 101 AND $3)`;
  } else {
    const md = monthDay(b);
    if (!md) return bad();
    params.push(md.month * 100 + md.day);
    cond = `get_birthday_date(p.birthday) BETWEEN $2 AND $2`;
  }
  params.push(offset, limit);
  const rows = await withHyperdriveClient(hd(env), async (c) =>
    (await c.query(
      `SELECT f."followeeId" AS user_id, get_birthday_date(p.birthday) AS birthday_date
       FROM following f JOIN user_profile p ON p."userId" = f."followeeId"
       WHERE f."followerId" = $1 AND ${cond}
       ORDER BY birthday_date ASC OFFSET $${params.length - 1} LIMIT $${params.length}`,
      params,
    )).rows,
  );
  const users = new Map(((await packUsers(env, rows.map((r) => String(r.user_id)), me, false)) as { id: string }[]).map((u) => [u.id, u]));
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return rows
    .map((r) => {
      const md = Number(r.birthday_date);
      const d = new Date(today);
      d.setMonth(Math.floor(md / 100) - 1, md % 100);
      if (d.getTime() < today.getTime()) d.setFullYear(today.getFullYear() + 1);
      const p = (n: number) => String(n).padStart(2, "0");
      return { id: String(r.user_id), birthday: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`, user: users.get(String(r.user_id)) };
    })
    .filter((x) => x.user != null);
};

// ---------------------------------------------------------------- notes, users (directory listings)

/** upstream generateUgcVisibilityQueryForVisitor (meta.ugcVisibilityForVisitor: all | local | none). */
async function visitorUgcSql(c: PgQueryable, hostCol: string): Promise<string | null> {
  const v = (await metaRow(c)).ugcVisibilityForVisitor;
  if (v === "none") return "FALSE";
  if (v === "local") return `${hostCol} IS NULL`;
  return null;
}

const notes: Handler = async (env, body, ctx) => {
  const me = await optionalMe(env, body, ctx);
  if (me === "invalid") return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  const limit = limitOf(body);
  if (limit == null) return bad();
  for (const k of ["local", "reply", "renote", "withFiles", "poll"]) if (body[k] !== undefined && typeof body[k] !== "boolean") return bad();
  const ids = await withHyperdriveClient(hd(env), async (c) => {
    const params: unknown[] = [];
    const p = pagination(body, params, "n.id");
    const where = [`n.visibility = 'public'`, `n."localOnly" = FALSE`, ...p.where];
    if (body.local) where.push(`n."userHost" IS NULL`);
    if (!me) {
      const v = await visitorUgcSql(c, `n."userHost"`);
      if (v) where.push(v);
    }
    if (body.reply !== undefined) where.push(body.reply ? `n."replyId" IS NOT NULL` : `n."replyId" IS NULL`);
    if (body.renote !== undefined) where.push(body.renote ? `n."renoteId" IS NOT NULL` : `n."renoteId" IS NULL`);
    if (body.withFiles !== undefined) where.push(body.withFiles ? `n."fileIds" <> '{}'` : `n."fileIds" = '{}'`);
    if (body.poll !== undefined) where.push(body.poll ? `n."hasPoll" = TRUE` : `n."hasPoll" = FALSE`);
    params.push(limit);
    return (await c.query(
      `SELECT n.id FROM note n JOIN "user" u ON u.id = n."userId" WHERE ${where.join(" AND ")} ORDER BY n.id ${p.order} LIMIT $${params.length}`,
      params,
    )).rows.map((r) => String(r.id));
  });
  if (!ids.length) return [];
  const rows = await getNotesByIdsPg(env, ids);
  const byId = new Map(rows.map((n) => [n.id, n]));
  // upstream packs without a viewer
  return packNotesFromPg(env, ids.map((id) => byId.get(id)).filter((n): n is NonNullable<typeof n> => !!n), buildPackConfig(env), null);
};

const SORTS: Record<string, string> = {
  "+follower": `u."followersCount" DESC`,
  "-follower": `u."followersCount" ASC`,
  "+createdAt": `u.id DESC`,
  "-createdAt": `u.id ASC`,
  "+updatedAt": `u."updatedAt" DESC`,
  "-updatedAt": `u."updatedAt" ASC`,
};

const users: Handler = async (env, body, ctx) => {
  const me = await optionalMe(env, body, ctx);
  if (me === "invalid") return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  const limit = limitOf(body);
  const offset = offsetOf(body);
  if (limit == null || offset == null) return bad();
  if (body.sort !== undefined && !(String(body.sort) in SORTS)) return bad();
  const state = body.state ?? "all";
  const origin = body.origin ?? "local";
  if (!["all", "alive"].includes(state as string) || !["combined", "local", "remote"].includes(origin as string)) return bad();
  if (body.hostname != null && typeof body.hostname !== "string") return bad();
  const ids = await withHyperdriveClient(hd(env), async (c) => {
    const params: unknown[] = [];
    const where = [`u."isExplorable" = TRUE`, `u."isSuspended" = FALSE`];
    if (state === "alive") where.push(`u."updatedAt" > $${params.push(new Date(Date.now() - 5 * DAY).toISOString())}`);
    if (origin === "local") where.push(`u.host IS NULL`);
    else if (origin === "remote") where.push(`u.host IS NOT NULL`);
    if (body.hostname) where.push(`u.host = $${params.push((body.hostname as string).toLowerCase())}`);
    if (typeof body.sort === "string" && body.sort.endsWith("updatedAt")) where.push(`u."updatedAt" IS NOT NULL`);
    if (me) where.push(excludeRelatedSql("u.id", `$${params.push(me)}`));
    params.push(limit, offset);
    return (await c.query(
      `SELECT u.id FROM "user" u WHERE ${where.join(" AND ")}
       ORDER BY ${typeof body.sort === "string" ? SORTS[body.sort] : `u.id ASC`} LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    )).rows.map((r) => String(r.id));
  });
  return packUsers(env, ids, me, true);
};

// ---------------------------------------------------------------- retention

const retention: Handler = async (env) =>
  withHyperdriveClient(hd(env), async (c) => {
    const rows = (await c.query(`SELECT "createdAt", "usersCount", data FROM retention_aggregation ORDER BY id DESC LIMIT 30`)).rows;
    return rows.map((r) => ({ createdAt: new Date(r.createdAt as string).toISOString(), users: Number(r.usersCount), data: r.data ?? {} }));
  });

/**
 * AggregateRetentionProcessorService (upstream: daily at 0:00): today's signups, and for each
 * record of the last ~31 days how many of its users were active today. `dateKey` is unique, so a
 * second run on the same day stops at the insert.
 */
export async function aggregateRetentionPg(env: ApiEnv, now = new Date()): Promise<boolean> {
  if (!env.HYPERDRIVE?.connectionString) return false;
  const dateKey = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
  return withHyperdriveClient(hd(env), async (c) => {
    if ((await c.query(`SELECT 1 AS ok FROM retention_aggregation WHERE "dateKey" = $1`, [dateKey])).rows.length) return false;
    const since = genAidx(now.getTime() - DAY);
    const signups = (await c.query(`SELECT id FROM "user" WHERE host IS NULL AND id > $1`, [since])).rows.map((r) => String(r.id));
    try {
      await c.query(
        `INSERT INTO retention_aggregation (id, "createdAt", "updatedAt", "dateKey", "userIds", "usersCount") VALUES ($1, $2, $2, $3, $4, $5)`,
        [genAidx(now.getTime()), now.toISOString(), dateKey, signups, signups.length],
      );
    } catch {
      return false; // another run won the race (unique dateKey)
    }
    const active = new Set(
      (await c.query(`SELECT id FROM "user" WHERE host IS NULL AND "lastActiveDate" > $1`, [new Date(now.getTime() - DAY).toISOString()])).rows.map((r) => String(r.id)),
    );
    const past = (await c.query(`SELECT id, "userIds", data FROM retention_aggregation WHERE "createdAt" > $1 AND "dateKey" <> $2`, [new Date(now.getTime() - 31 * DAY).toISOString(), dateKey])).rows;
    for (const r of past) {
      const data = { ...((r.data as Record<string, number> | null) ?? {}), [dateKey]: ((r.userIds as string[] | null) ?? []).filter((id) => active.has(id)).length };
      await c.query(`UPDATE retention_aggregation SET "updatedAt" = $2, data = $3::jsonb WHERE id = $1`, [r.id, now.toISOString(), JSON.stringify(data)]);
    }
    return true;
  });
}

// ---------------------------------------------------------------- page-push, email-address/available

const pagePush: Handler = async (env, body, ctx) => {
  const me = await auth(env, body, ctx);
  if (!me) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  if (typeof body.pageId !== "string" || typeof body.event !== "string") return bad();
  const page = await withHyperdriveClient(hd(env), async (c) => (await c.query(`SELECT id, "userId" FROM page WHERE id = $1`, [body.pageId])).rows[0]);
  if (!page) return fail(E.noSuchPage);
  const user = ((await packUsers(env, [me], String(page.userId), true)) as unknown[])[0];
  await publishToUserStream(env, String(page.userId), "main", "pageEvent", { pageId: body.pageId, event: body.event, var: body.var, userId: me, user });
  return noContent();
};

const EMAIL_RE = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;

/**
 * EmailService.validateEmailForAccount. With `env`, the active validation (verifymail / truemail
 * APIs, otherwise the deep-email-validator checks: disposable list and MX over DoH; `email.ts`)
 * runs when `meta.enableActiveEmailValidation` is on.
 */
export async function validateEmailForAccountPg(c: PgQueryable, email: string, env?: ApiEnv): Promise<{ available: boolean; reason: string | null }> {
  if (!EMAIL_RE.test(email)) return { available: false, reason: "format" };
  const used = (await c.query(`SELECT 1 AS ok FROM user_profile WHERE "emailVerified" = TRUE AND email = $1 LIMIT 1`, [email])).rows.length > 0;
  if (used) return { available: false, reason: "used" };
  const meta = await metaRow(c);
  if (env && meta.enableActiveEmailValidation) {
    const { activeEmailValidation, mapValidationReason } = await import("./email.js");
    const v = await activeEmailValidation(env, meta, email);
    if (!v.valid) return { available: false, reason: mapValidationReason(v.reason) };
  }
  const banned = (meta.bannedEmailDomains as string[] | undefined) ?? [];
  const domain = email.split("@")[1]!.toLowerCase();
  if (banned.some((x) => `.${domain}`.endsWith(`.${x}`))) return { available: false, reason: "banned" };
  return { available: true, reason: null };
}

const emailAvailable: Handler = async (env, body) => {
  if (typeof body.emailAddress !== "string") return bad();
  return withHyperdriveClient(hd(env), (c) => validateEmailForAccountPg(c, body.emailAddress as string, env));
};

// ---------------------------------------------------------------- server-info, test, reset-db

/** No machine to report on a Worker: upstream's `enableServerMachineStats: false` answer. */
const serverInfo: Handler = async () => ({ machine: "?", cpu: { model: "?", cores: 0 }, mem: { total: 0 }, fs: { total: 0, used: 0 } });

/** upstream returns `ps` as validated (defaults filled in; `i` and unknown keys kept). */
const test: Handler = async (_env, body) => body;

/** upstream: only with NODE_ENV=test (throws otherwise → INTERNAL_ERROR). */
const resetDb: Handler = async () => apiErrorResponse(INTERNAL_ERROR, 500);

// ---------------------------------------------------------------- fetch-rss, fetch-external-resources

const MAX_URL_LENGTH = 8192;
const MAX_RSS_SIZE = 1024 * 1024;

async function readCapped(res: Response, max: number): Promise<string> {
  if (Number(res.headers.get("content-length") ?? 0) > max) throw new Error("too large");
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      throw new Error("too large");
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const ch of chunks) {
    buf.set(ch, off);
    off += ch.byteLength;
  }
  return new TextDecoder().decode(buf);
}

const MAX_CONCURRENT_RSS = 32;
/** upstream keeps these per process; here per isolate. */
const rssInFlight = new Map<string, Promise<unknown>>();
let rssActive = 0;

const fetchRss: Handler = async (env, body) => {
  if (typeof body.url !== "string") return bad();
  if (body.url.length === 0 || body.url.length > MAX_URL_LENGTH) return fail(E.invalidUrl);
  let url: URL;
  try {
    url = new URL(body.url);
  } catch {
    return fail(E.invalidUrl);
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username !== "" || url.password !== "") return fail(E.invalidUrl);
  url.hash = "";
  const key = url.href;
  const pending = rssInFlight.get(key);
  if (pending) return pending;
  if (rssActive >= MAX_CONCURRENT_RSS) return apiErrorResponse(E.fetchRssUnavailable, 503);
  rssActive++;
  const req = (async () => {
    try {
      // every redirect hop is checked (scheme and host)
      const { res } = await fetchChecked(env.AP_FETCH ?? fetch, key, {
        headers: { Accept: "application/rss+xml, */*", "user-agent": "misskey-cf (fetch-rss)" },
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
      return parseFeed(await readCapped(res, MAX_RSS_SIZE));
    } catch {
      return apiErrorResponse(E.fetchRssFailed, 422);
    } finally {
      rssInFlight.delete(key);
      rssActive--;
    }
  })();
  rssInFlight.set(key, req);
  const r = await req;
  // a Response body can be read once: callers sharing the request get a copy
  return r instanceof Response ? r.clone() : r;
};

const fetchExternalResources: Handler = async (env, body, ctx) => {
  const me = await auth(env, body, ctx);
  if (!me) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  if (typeof body.url !== "string" || typeof body.hash !== "string") return bad();
  let res: { type?: unknown; data?: unknown };
  try {
    const { res: r } = await fetchChecked(env.AP_FETCH ?? fetch, body.url, { headers: { Accept: "application/json, */*", "user-agent": "misskey-cf" }, signal: AbortSignal.timeout(10_000) });
    if (!r.ok) throw new Error(`status ${r.status}`);
    res = JSON.parse(await readCapped(r, 10 * 1024 * 1024)) as typeof res;
  } catch {
    return apiErrorResponse(INTERNAL_ERROR, 500); // upstream: the HTTP error propagates
  }
  if (!res?.data || !res.type) return fail(E.invalidSchema);
  // upstream calls res.data.replace(): a non-string is a TypeError → INTERNAL_ERROR
  if (typeof res.data !== "string") throw new TypeError("res.data.replace is not a function");
  const digest = await crypto.subtle.digest("SHA-512", new TextEncoder().encode(res.data.replace(/\r\n/g, "\n")));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  if (hex !== body.hash) return fail(E.hashUnmatched);
  return { type: res.type, data: res.data };
};

// ---------------------------------------------------------------- registry

function pgOnly(h: Handler): Handler {
  return async (env, body, ctx) => {
    if (!env.HYPERDRIVE?.connectionString) {
      return apiErrorResponse({ message: "Hyperdrive required.", code: "HYPERDRIVE_UNBOUND", id: "00000000-0000-4000-8000-0000000000b1", kind: "server" }, 501);
    }
    return h(env, body, ctx);
  };
}

const RAW: Record<string, Handler> = {
  "announcements/show": announcementShow,
  "my/apps": myApps,
  "users/recommendation": recommendation,
  "users/get-frequently-replied-users": frequentlyRepliedUsers,
  "users/get-following-users-by-birthday": followingByBirthday,
  notes,
  users,
  retention,
  "page-push": pagePush,
  "email-address/available": emailAvailable,
};

export const miscHandlers: Record<string, Handler> = {
  ...Object.fromEntries(Object.entries(RAW).map(([k, h]) => [k, pgOnly(h)])),
  // no PG needed
  "server-info": serverInfo,
  test,
  "reset-db": resetDb,
  "fetch-rss": fetchRss,
  "fetch-external-resources": pgOnly(fetchExternalResources),
};

void parseAidxTime;
