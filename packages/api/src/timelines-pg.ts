/**
 * Note timelines as upstream computes them: notes/timeline, notes/local-timeline,
 * notes/hybrid-timeline, notes/global-timeline, notes/user-list-timeline, channels/timeline,
 * users/notes.
 *
 * Upstream reads these from Redis "fanout timelines" (FTT, lists filled by
 * NoteCreateService.pushToTl) filtered by FanoutTimelineEndpointService, falling back to the
 * endpoint's `getFromDb` query; with `meta.enableFanoutTimeline = false` it uses `getFromDb`
 * only. There is no Redis here: with enableFanoutTimeline on, each FTT list is evaluated as
 * the SQL predicate of the notes pushToTl would have pushed to it (no per-list cap, no
 * follower hibernation), and FanoutTimelineEndpointService's batch / filter / fallback
 * algorithm runs over it unchanged. With it off, `getFromDb` is ported as is.
 */

import type { PackNoteSource } from "../../packers/src/index.js";
import type { ApiEnv } from "./env.js";
import { apiErrorResponse } from "./errors.js";
import { authenticatePg, extractToken } from "./auth-pg.js";
import { buildPackConfig } from "./meta-source.js";
import { packNotesFromPg, rowToPackNote } from "./notes-pg.js";
import { withHyperdriveClient, type PgQueryable } from "./pg.js";
import { mutedChannelIdsPg, NOTE_JOINS, NoteQuery, timelineCursor } from "./note-query.js";
import { metaRowPg } from "./user-lite-pg.js";
import { getUserPoliciesPg } from "./policies-pg.js";
import { DEFAULT_POLICIES } from "../../packers/src/index.js";
import { clientError as err } from "./handler-kit.js";

type Body = Record<string, unknown>;
type Ctx = { hasCredential: boolean; request: Request };

const E = {
  ltlDisabled: err("LTL_DISABLED", "45a6eb02-7695-4393-b023-dd3be9aaaefd", "Local timeline has been disabled."),
  ltlBoth: err("BOTH_WITH_REPLIES_AND_WITH_FILES", "dd9c8400-1cb5-4eef-8a31-200c5f933793", "Specifying both withReplies and withFiles is not supported"),
  stlDisabled: err("STL_DISABLED", "620763f4-f621-4533-ab33-0577a1a3c342", "Hybrid timeline has been disabled."),
  stlBoth: err("BOTH_WITH_REPLIES_AND_WITH_FILES", "dfaa3eb7-8002-4cb7-bcc4-1095df46656f", "Specifying both withReplies and withFiles is not supported"),
  gtlDisabled: err("GTL_DISABLED", "0332fc13-6ab2-4427-ae80-a9fadffd1a6b", "Global timeline has been disabled."),
  noSuchList: err("NO_SUCH_LIST", "8fb1fbd5-e476-4c37-9fb0-43d55b63a2ff", "No such list."),
  noSuchChannel: err("NO_SUCH_CHANNEL", "4d0eeeba-a02c-4c3c-9966-ef60d38d2e7f", "No such channel."),
  usersNotesBoth: err("BOTH_WITH_REPLIES_AND_WITH_FILES", "91c8cb9f-36ed-46e7-9ca2-7df96ed6e222", "Specifying both withReplies and withFiles is not supported"),
};

async function viewer(env: ApiEnv, body: Body, ctx: Ctx): Promise<string | null> {
  if (!ctx.hasCredential) return null;
  const token = extractToken(ctx.request, body);
  return token ? ((await authenticatePg(env, token))?.user.id ?? null) : null;
}

async function policiesOf(env: ApiEnv, c: PgQueryable, meId: string | null): Promise<Record<string, unknown>> {
  if (meId) return getUserPoliciesPg(env, c, meId);
  const m = await metaRowPg(c);
  return { ...DEFAULT_POLICIES, ...((m.policies as Record<string, unknown> | undefined) ?? {}) };
}

// ------------------------------------------------------------------ SQL pieces

/** misc/is-reply (`viewer` = a bound param or null) */
const isReplySql = (n: string, viewerParam: string | null) =>
  `(${n}."replyId" IS NOT NULL AND ${n}."replyUserId" IS DISTINCT FROM ${n}."userId"${viewerParam ? ` AND ${n}."replyUserId" IS DISTINCT FROM ${viewerParam}` : ""})`;
/** misc/is-renote isQuote */
const isQuoteSql = (n: string) => `(${n}.text IS NOT NULL OR ${n}.cw IS NOT NULL OR ${n}."replyId" IS NOT NULL OR ${n}."hasPoll" OR ${n}."fileIds" != '{}')`;
const hasFilesSql = (n: string) => `${n}."fileIds" != '{}'`;
/** "renote without text / files / poll" brackets of the getFromDb queries */
const hasContentSql = `(note.text IS NOT NULL OR note."fileIds" != '{}' OR 0 < (SELECT COUNT(*) FROM poll WHERE poll."noteId" = note.id))`;

/** UtilityService.isBlockedHost as SQL over a host column. */
function blockedHostSql(q: NoteQuery, hostCol: string, blocked: string[]): string {
  if (!blocked.length) return "FALSE";
  return `(${hostCol} IS NOT NULL AND ('.' || lower(${hostCol})) LIKE ANY(${q.p(blocked.map((x) => `%.${x}`))}::varchar[]))`;
}

// ------------------------------------------------------------------ fanout timeline emulation

type FttOptions = {
  untilId: string | null;
  sinceId: string | null;
  limit: number;
  allowPartial: boolean;
  meId: string | null;
  useDbFallback: boolean;
  /** the union of the FTT lists, as a predicate on `note` (binds via q.p) */
  lists: (q: NoteQuery) => string;
  noteFilter?: (q: NoteQuery) => string;
  alwaysIncludeMyNotes?: boolean;
  ignoreAuthorFromBlock?: boolean;
  ignoreAuthorFromMute?: boolean;
  ignoreAuthorFromInstanceBlock?: boolean;
  ignoreAuthorChannelFromMute?: boolean;
  excludeNoFiles?: boolean;
  excludeReplies?: boolean;
  excludePureRenotes: boolean;
  ignoreAuthorFromUserSuspension?: boolean;
  dbFallback: (untilId: string | null, sinceId: string | null, limit: number) => Promise<PackNoteSource[]>;
};

/** FanoutTimelineEndpointService.getMiNotes over the SQL-evaluated FTT lists. */
async function fanoutTimeline(c: PgQueryable, meta: Record<string, unknown>, ps: FttOptions): Promise<PackNoteSource[]> {
  const dbFallback = ps.useDbFallback ? ps.dbFallback : async () => [] as PackNoteSource[];
  const ascending = Boolean(ps.sinceId && !ps.untilId);

  // with sinceId the cached ids are all newer than it, so upstream always falls back (sinceId < oldest)
  if (ps.sinceId != null) return dbFallback(ps.untilId, ps.sinceId, ps.limit);

  const filterOf = (q: NoteQuery): string => {
    const conds: string[] = [];
    let base = ps.noteFilter ? ps.noteFilter(q) : "TRUE";
    if (ps.alwaysIncludeMyNotes && ps.meId) base = `(note."userId" = ${q.p(ps.meId)} OR ${base})`;
    conds.push(base);
    if (ps.excludeNoFiles) conds.push(hasFilesSql("note"));
    if (ps.excludeReplies) conds.push(`NOT ${isReplySql("note", ps.meId ? q.p(ps.meId) : null)}`);
    if (ps.excludePureRenotes) conds.push(`(note."renoteId" IS NULL OR ${isQuoteSql("note")})`);
    if (ps.meId) {
      const me = q.p(ps.meId);
      const blockingMe = `(SELECT "blockerId" FROM blocking WHERE "blockeeId" = ${me})`;
      const muting = `(SELECT "muteeId" FROM muting WHERE "muterId" = ${me} AND ("expiresAt" IS NULL OR "expiresAt" > now()))`;
      const renoteMuting = `(SELECT "muteeId" FROM renote_muting WHERE "muterId" = ${me})`;
      const related = (n: string, set: string, ignoreAuthor?: boolean) =>
        `(${n}.id IS NOT NULL AND (${ignoreAuthor ? "FALSE" : `${n}."userId" IN ${set}`}
          OR (COALESCE(${n}."replyUserId", ${n === "note" ? `reply."userId"` : "NULL"}) IS DISTINCT FROM ${n}."userId" AND COALESCE(${n}."replyUserId", ${n === "note" ? `reply."userId"` : "NULL"}) IN ${set})
          OR (COALESCE(${n}."renoteUserId", ${n === "note" ? `renote."userId"` : "NULL"}) IS DISTINCT FROM ${n}."userId" AND COALESCE(${n}."renoteUserId", ${n === "note" ? `renote."userId"` : "NULL"}) IN ${set})))`;
      conds.push(`NOT ${related("note", blockingMe, ps.ignoreAuthorFromBlock)}`);
      conds.push(`NOT ${related("note", muting, ps.ignoreAuthorFromMute)}`);
      conds.push(`NOT ${related("renote", blockingMe, ps.ignoreAuthorFromBlock)}`);
      conds.push(`NOT ${related("renote", muting, ps.ignoreAuthorFromMute)}`);
      if (!ps.ignoreAuthorFromMute) conds.push(`NOT (note."renoteId" IS NOT NULL AND NOT ${isQuoteSql("note")} AND note."userId" IN ${renoteMuting})`);
      const inst = `COALESCE((SELECT to_jsonb(up) -> 'mutedInstances' FROM user_profile up WHERE up."userId" = ${me}), '[]'::jsonb)`;
      conds.push(`NOT COALESCE(${inst} ? "user".host, FALSE)`);
      conds.push(`NOT COALESCE(${inst} ? "replyUser".host, FALSE)`);
      conds.push(`NOT COALESCE(${inst} ? "renoteUser".host, FALSE)`);
      const mutedCh = `(SELECT "channelId" FROM channel_muting WHERE "userId" = ${me} AND ("expiresAt" IS NULL OR "expiresAt" > now()))`;
      if (!ps.ignoreAuthorChannelFromMute) conds.push(`NOT COALESCE(note."channelId" IN ${mutedCh}, FALSE)`);
      conds.push(`NOT COALESCE(renote."channelId" IS DISTINCT FROM note."channelId" AND renote."channelId" IN ${mutedCh}, FALSE)`);
    }
    const blocked = Array.isArray(meta.blockedHosts) ? (meta.blockedHosts as string[]) : [];
    if (!ps.ignoreAuthorFromInstanceBlock) conds.push(`NOT ${blockedHostSql(q, `note."userHost"`, blocked)}`);
    conds.push(`NOT (note."userId" IS DISTINCT FROM note."renoteUserId" AND ${blockedHostSql(q, `note."renoteUserHost"`, blocked)})`);
    conds.push(`NOT (note."userId" IS DISTINCT FROM note."replyUserId" AND ${blockedHostSql(q, `note."replyUserHost"`, blocked)})`);
    if (ps.meId == null && meta.ugcVisibilityForVisitor && meta.ugcVisibilityForVisitor !== "all") {
      if (meta.ugcVisibilityForVisitor === "none") conds.push("FALSE");
      if (meta.ugcVisibilityForVisitor === "local") conds.push(`note."userHost" IS NULL`);
    }
    if (!ps.ignoreAuthorFromUserSuspension) conds.push(`"user"."isSuspended" = FALSE`);
    conds.push(`NOT (note."userId" IS DISTINCT FROM note."renoteUserId" AND COALESCE("renoteUser"."isSuspended", FALSE))`);
    conds.push(`NOT (note."userId" IS DISTINCT FROM note."replyUserId" AND COALESCE("replyUser"."isSuspended", FALSE))`);
    return conds.map((x) => `(${x})`).join(" AND ");
  };

  // getMulti + the filtered fetch of those notes, in one round trip: `ids` are the list ids
  // before `before` (exclusive), newest first, read as keyset pages (ids are unique, so this is the
  // slice upstream takes from the list by position); the rows are the ones the filter keeps.
  const dir = ascending ? "ASC" : "DESC";
  const page = async (before: string | null, count: number): Promise<{ ids: string[]; got: PackNoteSource[] }> => {
    const q = new NoteQuery(meta);
    const idSql = `SELECT note.id FROM note note WHERE (${ps.lists(q)})${before ? ` AND note.id < ${q.p(before)}` : ""} ORDER BY note.id ${dir} LIMIT ${q.p(count)}`;
    q.and(`note.id IN (SELECT id FROM ids)`);
    q.and(filterOf(q));
    q.order = `note.id ${dir}`;
    const rows = (await c.query(
      `WITH ids AS (${idSql})
       SELECT (SELECT array_agg(id ORDER BY id ${dir}) FROM ids) AS "_pageIds", k.*
       FROM (SELECT 1) AS one LEFT JOIN (${q.sql(null)}) AS k ON TRUE ORDER BY k.id ${dir}`,
      q.params,
    )).rows;
    const ids = ((rows[0]?._pageIds as string[] | null) ?? []).map(String);
    return { ids, got: rows.filter((r) => r.id != null).map(rowToPackNote) };
  };

  const timeline: PackNoteSource[] = [];
  let lastSuccessfulRate = 1;
  let last: string | null = null;
  for (;;) {
    const remaining = ps.limit - timeline.length;
    const countToGet = Math.ceil(remaining * Math.min(1.1 / lastSuccessfulRate, 3));
    const { ids, got } = await page(last ?? ps.untilId, countToGet);
    // an empty list: upstream's `noteIds.length === 0` → getFromDb
    if (ids.length === 0) break;
    last = ids[ids.length - 1]!;
    timeline.push(...got);
    lastSuccessfulRate = got.length / ids.length;
    if (ps.allowPartial ? timeline.length !== 0 : timeline.length >= ps.limit) return timeline.slice(0, ps.limit);
    if (ids.length < countToGet) break;
  }
  const remaining = ps.limit - timeline.length;
  return [...timeline, ...(await dbFallback(last ?? ps.untilId, ps.sinceId, remaining))];
}

const bool = (v: unknown, def: boolean) => (typeof v === "boolean" ? v : def);
const int = (v: unknown, def: number) => (typeof v === "number" ? v : def);

async function packed(env: ApiEnv, notes: PackNoteSource[], meId: string | null) {
  return packNotesFromPg(env, notes, buildPackConfig(env), meId);
}

const ftt = (meta: Record<string, unknown>) => meta.enableFanoutTimeline !== false;
const fttDbFallback = (meta: Record<string, unknown>) => meta.enableFanoutTimelineDbFallback !== false;

// ------------------------------------------------------------------ notes/timeline

/** Who I follow (split by withReplies) and which channels: read once per request. */
type HomeRelations = { withReplies: string[]; noReplies: string[]; channels: string[] };

async function homeRelations(c: PgQueryable, meId: string): Promise<HomeRelations> {
  const rel: HomeRelations = { withReplies: [], noReplies: [], channels: [] };
  // followed users and channels in one round trip
  for (const r of (await c.query(
    `SELECT 'u' AS k, "followeeId" AS id, "withReplies" FROM following WHERE "followerId" = $1
     UNION ALL SELECT 'c', "followeeId", NULL FROM channel_following WHERE "followerId" = $1`,
    [meId],
  )).rows) {
    if (r.k === "c") rel.channels.push(String(r.id));
    else (r.withReplies === true ? rel.withReplies : rel.noReplies).push(String(r.id));
  }
  return rel;
}

/** `note."userId"` in `withReplies`, or in `noReplies` and not a reply (a reply rule per membership / follow). */
function authorsSql(q: NoteQuery, withReplies: string[], noReplies: string[], notReply: string): string {
  const parts: string[] = [];
  if (withReplies.length) parts.push(`note."userId" = ANY(${q.p(withReplies)}::varchar[])`);
  if (noReplies.length) parts.push(`(note."userId" = ANY(${q.p(noReplies)}::varchar[]) AND ${notReply})`);
  return parts.length ? `(${parts.join(" OR ")})` : "FALSE";
}

/**
 * pushToTl → homeTimeline:{me} (+WithFiles): followees' notes (reply rules), followed channels,
 * own notes. The follows are bound as arrays (not an EXISTS per note under the OR), so the
 * planner reads the authors' notes from the ("userId", id) index instead of scanning `note`.
 */
function homeListSql(q: NoteQuery, meId: string, rel: HomeRelations, withFiles: boolean): string {
  const me = q.p(meId);
  const followee = `note."channelId" IS NULL AND ${authorsSql(q, rel.withReplies, rel.noReplies, `NOT ${isReplySql("note", me)}`)}
    AND NOT (note.visibility = 'specified' AND NOT (${me} = ANY(note."visibleUserIds")))`;
  const channel = rel.channels.length ? `note."channelId" = ANY(${q.p(rel.channels)}::varchar[])` : "FALSE";
  const own = `note."channelId" IS NULL AND note."userId" = ${me} AND note."userHost" IS NULL AND NOT (note.visibility = 'specified' AND ${me} = ANY(note."visibleUserIds"))`;
  return `((${followee}) OR (${channel}) OR (${own}))${withFiles ? ` AND ${hasFilesSql("note")}` : ""}`;
}

/** localTimeline / localTimelineWithFiles / localTimelineWithReplies / localTimelineWithReplyTo:{id} */
function localListSql(q: NoteQuery, kind: "plain" | "files" | "replies" | "replyTo", meId?: string): string {
  const base = `note."channelId" IS NULL AND note.visibility = 'public' AND note."userHost" IS NULL`;
  switch (kind) {
    case "plain": return `(${base} AND NOT ${isReplySql("note", null)})`;
    case "files": return `(${base} AND NOT ${isReplySql("note", null)} AND ${hasFilesSql("note")})`;
    case "replies": return `(${base} AND ${isReplySql("note", null)})`;
    case "replyTo": return `(${base} AND ${isReplySql("note", null)} AND note."replyUserHost" IS NULL AND note."replyUserId" = ${q.p(meId)})`;
  }
}

/** noteFilter of home / hybrid: hide replies to followers-only notes of users I don't follow. */
const replyFollowersFilter = (meId: string) => (q: NoteQuery) => {
  const me = q.p(meId);
  return `NOT (reply.id IS NOT NULL AND reply.visibility = 'followers' AND reply."userId" != ${me}
    AND reply."userId" NOT IN (SELECT "followeeId" FROM following WHERE "followerId" = ${me}))`;
};

function renoteFlagFilters(q: NoteQuery, meId: string, ps: { includeMyRenotes: boolean; includeRenotedMyNotes: boolean; includeLocalRenotes: boolean }) {
  if (ps.includeMyRenotes === false) q.and(`note."userId" != ${q.p(meId)} OR note."renoteId" IS NULL OR ${hasContentSql}`);
  if (ps.includeRenotedMyNotes === false) q.and(`note."renoteUserId" != ${q.p(meId)} OR note."renoteId" IS NULL OR ${hasContentSql}`);
  if (ps.includeLocalRenotes === false) q.and(`note."renoteUserHost" IS NOT NULL OR note."renoteId" IS NULL OR ${hasContentSql}`);
}

async function homeFromDb(c: PgQueryable, meta: Record<string, unknown>, meId: string, ps: { untilId: string | null; sinceId: string | null; limit: number; includeMyRenotes: boolean; includeRenotedMyNotes: boolean; includeLocalRenotes: boolean; withFiles: boolean; withRenotes: boolean }, rel?: HomeRelations) {
  rel ??= await homeRelations(c, meId);
  const followees = [...rel.withReplies, ...rel.noReplies];
  const muting = await mutedChannelIdsPg(c, meId);
  const followingCh = rel.channels.filter((x) => !muting.includes(x));
  const q = new NoteQuery(meta).paginate(ps.sinceId, ps.untilId);
  const meOrFollowees = [meId, ...followees];
  if (followees.length > 0 && followingCh.length > 0) {
    q.and(`(note."userId" = ANY(${q.p(meOrFollowees)}::varchar[]) AND note."channelId" IS NULL) OR note."channelId" = ANY(${q.p(followingCh)}::varchar[])`);
  } else if (followees.length > 0) {
    let s = `note."channelId" IS NULL AND note."userId" = ANY(${q.p(meOrFollowees)}::varchar[])`;
    if (muting.length > 0) s += ` AND (note."renoteChannelId" IS NULL OR note."renoteChannelId" != ALL(${q.p(muting)}::varchar[]))`;
    q.and(s);
  } else if (followingCh.length > 0) {
    q.and(`note."channelId" = ANY(${q.p(followingCh)}::varchar[]) OR note."userId" = ${q.p(meId)}`);
  } else {
    q.and(`note."channelId" IS NULL AND note."userId" = ${q.p(meId)}`);
  }
  q.notReplyToOthers();
  q.visibility(meId);
  q.baseFiltering(meId);
  q.mutedUserRenotes(meId);
  renoteFlagFilters(q, meId, ps);
  if (ps.withFiles) q.and(hasFilesSql("note"));
  if (ps.withRenotes === false) q.and(`note."renoteId" IS NULL OR ${hasContentSql}`);
  return q.run(c, ps.limit);
}

export async function homeTimelinePg(env: ApiEnv, body: Body, ctx: Ctx): Promise<unknown> {
  const meId = (await viewer(env, body, ctx))!;
  const { untilId, sinceId } = timelineCursor(body);
  const ps = {
    untilId, sinceId,
    limit: int(body.limit, 10),
    includeMyRenotes: bool(body.includeMyRenotes, true),
    includeRenotedMyNotes: bool(body.includeRenotedMyNotes, true),
    includeLocalRenotes: bool(body.includeLocalRenotes, true),
    withFiles: bool(body.withFiles, false),
    withRenotes: bool(body.withRenotes, true),
  };
  const notes = await withHyperdriveClient(env.HYPERDRIVE!, async (c) => {
    const meta = await metaRowPg(c);
    const rel = await homeRelations(c, meId);
    if (!ftt(meta)) return homeFromDb(c, meta, meId, ps, rel);
    return fanoutTimeline(c, meta, {
      untilId, sinceId, limit: ps.limit, allowPartial: bool(body.allowPartial, false), meId,
      useDbFallback: fttDbFallback(meta),
      lists: (q) => homeListSql(q, meId, rel, ps.withFiles),
      alwaysIncludeMyNotes: true,
      excludePureRenotes: !ps.withRenotes,
      noteFilter: replyFollowersFilter(meId),
      dbFallback: (u, s, l) => homeFromDb(c, meta, meId, { ...ps, untilId: u, sinceId: s, limit: l }, rel),
    });
  });
  return packed(env, notes, meId);
}

// ------------------------------------------------------------------ notes/local-timeline

async function localFromDb(c: PgQueryable, meta: Record<string, unknown>, meId: string | null, ps: { untilId: string | null; sinceId: string | null; limit: number; withFiles: boolean; withReplies: boolean }) {
  const q = new NoteQuery(meta).paginate(ps.sinceId, ps.untilId);
  q.and(`(note.visibility = 'public') AND (note."userHost" IS NULL) AND (note."channelId" IS NULL)`);
  q.visibility(meId);
  q.baseFiltering(meId);
  if (meId) {
    q.mutedUserRenotes(meId);
    await q.excludeMutedRenoteChannels(c, meId);
  }
  if (ps.withFiles) q.and(hasFilesSql("note"));
  if (!ps.withReplies) q.notReplyToOthers();
  return q.run(c, ps.limit);
}

export async function localTimelinePg(env: ApiEnv, body: Body, ctx: Ctx): Promise<unknown> {
  const meId = await viewer(env, body, ctx);
  const { untilId, sinceId } = timelineCursor(body);
  const ps = { untilId, sinceId, limit: int(body.limit, 10), withFiles: bool(body.withFiles, false), withReplies: bool(body.withReplies, false), withRenotes: bool(body.withRenotes, true) };
  const res = await withHyperdriveClient(env.HYPERDRIVE!, async (c) => {
    const policies = await policiesOf(env, c, meId);
    if (!policies.ltlAvailable) return E.ltlDisabled;
    if (ps.withReplies && ps.withFiles) return E.ltlBoth;
    const meta = await metaRowPg(c);
    if (!ftt(meta)) return localFromDb(c, meta, meId, ps);
    return fanoutTimeline(c, meta, {
      untilId, sinceId, limit: ps.limit, allowPartial: bool(body.allowPartial, false), meId,
      useDbFallback: fttDbFallback(meta),
      lists: (q) => ps.withFiles ? localListSql(q, "files")
        : ps.withReplies ? `(${localListSql(q, "plain")} OR ${localListSql(q, "replies")})`
        : meId ? `(${localListSql(q, "plain")} OR ${localListSql(q, "replyTo", meId)})`
        : localListSql(q, "plain"),
      alwaysIncludeMyNotes: true,
      excludePureRenotes: !ps.withRenotes,
      dbFallback: (u, s, l) => localFromDb(c, meta, meId, { ...ps, untilId: u, sinceId: s, limit: l }),
    });
  });
  if (!Array.isArray(res)) return apiErrorResponse(res, 400);
  return packed(env, res, meId);
}

// ------------------------------------------------------------------ notes/hybrid-timeline

async function hybridFromDb(c: PgQueryable, meta: Record<string, unknown>, meId: string, ps: { untilId: string | null; sinceId: string | null; limit: number; includeMyRenotes: boolean; includeRenotedMyNotes: boolean; includeLocalRenotes: boolean; withFiles: boolean; withReplies: boolean }, rel?: HomeRelations) {
  rel ??= await homeRelations(c, meId);
  const followees = [...rel.withReplies, ...rel.noReplies];
  const muting = await mutedChannelIdsPg(c, meId);
  const followingCh = rel.channels.filter((x) => !muting.includes(x));
  const q = new NoteQuery(meta).paginate(ps.sinceId, ps.untilId);
  if (followees.length > 0) q.and(`note."userId" = ANY(${q.p([meId, ...followees])}::varchar[]) OR ((note.visibility = 'public') AND (note."userHost" IS NULL))`);
  else q.and(`note."userId" = ${q.p(meId)} OR ((note.visibility = 'public') AND (note."userHost" IS NULL))`);
  if (followingCh.length > 0) q.and(`note."channelId" = ANY(${q.p(followingCh)}::varchar[]) OR note."channelId" IS NULL`);
  else q.and(`note."channelId" IS NULL`);
  if (muting.length > 0) q.and(`note."renoteChannelId" IS NULL OR note."renoteChannelId" != ALL(${q.p(muting)}::varchar[])`);
  if (!ps.withReplies) q.notReplyToOthers();
  q.visibility(meId);
  q.baseFiltering(meId);
  q.mutedUserRenotes(meId);
  renoteFlagFilters(q, meId, ps);
  if (ps.withFiles) q.and(hasFilesSql("note"));
  return q.run(c, ps.limit);
}

export async function hybridTimelinePg(env: ApiEnv, body: Body, ctx: Ctx): Promise<unknown> {
  const meId = (await viewer(env, body, ctx))!;
  const { untilId, sinceId } = timelineCursor(body);
  const ps = {
    untilId, sinceId,
    limit: int(body.limit, 10),
    includeMyRenotes: bool(body.includeMyRenotes, true),
    includeRenotedMyNotes: bool(body.includeRenotedMyNotes, true),
    includeLocalRenotes: bool(body.includeLocalRenotes, true),
    withFiles: bool(body.withFiles, false),
    withRenotes: bool(body.withRenotes, true),
    withReplies: bool(body.withReplies, false),
  };
  const res = await withHyperdriveClient(env.HYPERDRIVE!, async (c) => {
    const policies = await policiesOf(env, c, meId);
    if (!policies.ltlAvailable) return E.stlDisabled;
    if (ps.withReplies && ps.withFiles) return E.stlBoth;
    const meta = await metaRowPg(c);
    const rel = await homeRelations(c, meId);
    if (!ftt(meta)) return hybridFromDb(c, meta, meId, ps, rel);
    return fanoutTimeline(c, meta, {
      untilId, sinceId, limit: ps.limit, allowPartial: bool(body.allowPartial, false), meId,
      useDbFallback: fttDbFallback(meta),
      lists: (q) => ps.withFiles ? `(${homeListSql(q, meId, rel, true)} OR ${localListSql(q, "files")})`
        : ps.withReplies ? `(${homeListSql(q, meId, rel, false)} OR ${localListSql(q, "plain")} OR ${localListSql(q, "replies")})`
        : `(${homeListSql(q, meId, rel, false)} OR ${localListSql(q, "plain")} OR ${localListSql(q, "replyTo", meId)})`,
      alwaysIncludeMyNotes: true,
      excludePureRenotes: !ps.withRenotes,
      noteFilter: replyFollowersFilter(meId),
      dbFallback: (u, s, l) => hybridFromDb(c, meta, meId, { ...ps, untilId: u, sinceId: s, limit: l }, rel),
    });
  });
  if (!Array.isArray(res)) return apiErrorResponse(res, 400);
  return packed(env, res, meId);
}

// ------------------------------------------------------------------ notes/global-timeline

export async function globalTimelinePg(env: ApiEnv, body: Body, ctx: Ctx): Promise<unknown> {
  const meId = await viewer(env, body, ctx);
  const res = await withHyperdriveClient(env.HYPERDRIVE!, async (c) => {
    const policies = await policiesOf(env, c, meId);
    if (!policies.gtlAvailable) return E.gtlDisabled;
    const meta = await metaRowPg(c);
    const q = new NoteQuery(meta).paginate(
      typeof body.sinceId === "string" ? body.sinceId : null,
      typeof body.untilId === "string" ? body.untilId : null,
      typeof body.sinceDate === "number" ? body.sinceDate : null,
      typeof body.untilDate === "number" ? body.untilDate : null,
    );
    q.and(`note.visibility = 'public'`).and(`note."channelId" IS NULL`);
    q.baseFiltering(meId);
    if (meId == null) q.ugcVisibilityForVisitor();
    if (meId) q.mutedUserRenotes(meId);
    if (body.withFiles === true) q.and(hasFilesSql("note"));
    if (body.withRenotes === false) q.and(`note."renoteId" IS NULL OR ${hasContentSql}`);
    return q.run(c, int(body.limit, 10));
  });
  if (!Array.isArray(res)) return apiErrorResponse(res, 400);
  return packed(env, res, meId);
}

// ------------------------------------------------------------------ notes/user-list-timeline

async function listFromDb(c: PgQueryable, meta: Record<string, unknown>, meId: string, listId: string, ps: { untilId: string | null; sinceId: string | null; limit: number; includeMyRenotes: boolean; includeRenotedMyNotes: boolean; includeLocalRenotes: boolean; withFiles: boolean; withRenotes: boolean }) {
  const q = new NoteQuery(meta).paginate(ps.sinceId, ps.untilId);
  q.joins = `${NOTE_JOINS} INNER JOIN user_list_membership "userListMemberships" ON "userListMemberships"."userId" = note."userId"`;
  q.and(`"userListMemberships"."userListId" = ${q.p(listId)}`);
  q.and(`note."channelId" IS NULL`);
  q.and(`note."replyId" IS NULL
    OR (note."replyId" IS NOT NULL AND note."replyUserId" = note."userId")
    OR (note."replyId" IS NOT NULL AND note."replyUserId" = ${q.p(meId)})
    OR (note."replyId" IS NOT NULL AND "userListMemberships"."withReplies" = TRUE)`);
  q.visibility(meId);
  q.baseFiltering(meId);
  q.mutedUserRenotes(meId);
  await q.excludeMutedRenoteChannels(c, meId);
  renoteFlagFilters(q, meId, ps);
  if (ps.withRenotes === false) q.and(`note."renoteId" IS NULL OR ${hasContentSql}`);
  if (ps.withFiles) q.and(hasFilesSql("note"));
  return q.run(c, ps.limit);
}

/** The list's members split by withReplies (read once per request). */
async function listMembers(c: PgQueryable, listId: string): Promise<{ withReplies: string[]; noReplies: string[] }> {
  const m = { withReplies: [] as string[], noReplies: [] as string[] };
  for (const r of (await c.query(`SELECT "userId", "withReplies" FROM user_list_membership WHERE "userListId" = $1`, [listId])).rows) {
    (r.withReplies === true ? m.withReplies : m.noReplies).push(String(r.userId));
  }
  return m;
}

/**
 * pushToTl → userListTimeline:{list} (+WithFiles). The list belongs to `meId` (the membership's
 * userListUserId); its members are bound as arrays, as in homeListSql.
 */
function listListSql(q: NoteQuery, meId: string, members: { withReplies: string[]; noReplies: string[] }, withFiles: boolean): string {
  const owner = q.p(meId);
  const notReply = `NOT (note."replyId" IS NOT NULL AND note."replyUserId" IS DISTINCT FROM note."userId" AND note."replyUserId" IS DISTINCT FROM ${owner})`;
  return `(note."channelId" IS NULL AND ${authorsSql(q, members.withReplies, members.noReplies, notReply)}
      AND NOT (note.visibility = 'specified' AND note."userId" != ${owner} AND NOT (${owner} = ANY(note."visibleUserIds")))
      AND NOT (note.visibility = 'followers' AND ${owner} != note."userId"
        AND NOT EXISTS (SELECT 1 FROM following f WHERE f."followeeId" = note."userId" AND f."followerId" = ${owner} AND f."followerHost" IS NULL))${withFiles ? ` AND ${hasFilesSql("note")}` : ""})`;
}

export async function userListTimelinePg(env: ApiEnv, body: Body, ctx: Ctx): Promise<unknown> {
  const meId = (await viewer(env, body, ctx))!;
  const { untilId, sinceId } = timelineCursor(body);
  const ps = {
    untilId, sinceId,
    limit: int(body.limit, 10),
    includeMyRenotes: bool(body.includeMyRenotes, true),
    includeRenotedMyNotes: bool(body.includeRenotedMyNotes, true),
    includeLocalRenotes: bool(body.includeLocalRenotes, true),
    withFiles: bool(body.withFiles, false),
    withRenotes: bool(body.withRenotes, true),
  };
  const res = await withHyperdriveClient(env.HYPERDRIVE!, async (c) => {
    const list = (await c.query(`SELECT id FROM user_list WHERE id = $1 AND "userId" = $2`, [body.listId, meId])).rows[0];
    if (!list) return E.noSuchList;
    const listId = String(list.id);
    const meta = await metaRowPg(c);
    if (!ftt(meta)) return listFromDb(c, meta, meId, listId, ps);
    const members = await listMembers(c, listId);
    return fanoutTimeline(c, meta, {
      untilId, sinceId, limit: ps.limit, allowPartial: bool(body.allowPartial, false), meId,
      useDbFallback: fttDbFallback(meta),
      lists: (q) => listListSql(q, meId, members, ps.withFiles),
      alwaysIncludeMyNotes: true,
      excludePureRenotes: !ps.withRenotes,
      dbFallback: (u, s, l) => listFromDb(c, meta, meId, listId, { ...ps, untilId: u, sinceId: s, limit: l }),
    });
  });
  if (!Array.isArray(res)) return apiErrorResponse(res, 400);
  return packed(env, res, meId);
}

// ------------------------------------------------------------------ channels/timeline

async function channelFromDb(c: PgQueryable, meta: Record<string, unknown>, meId: string | null, channelId: string, ps: { untilId: string | null; sinceId: string | null; limit: number }) {
  const q = new NoteQuery(meta).paginate(ps.sinceId, ps.untilId);
  q.and(`note."channelId" = ${q.p(channelId)}`);
  q.baseFiltering(meId);
  if (meId == null) q.ugcVisibilityForVisitor();
  if (meId) {
    const muting = (await mutedChannelIdsPg(c, meId)).filter((x) => x !== channelId);
    if (muting.length > 0) {
      q.and(`note."channelId" != ALL(${q.p(muting)}::varchar[])`);
      q.and(`note."renoteChannelId" IS NULL OR note."renoteChannelId" != ALL(${q.p(muting)}::varchar[])`);
    }
  }
  return q.run(c, ps.limit);
}

export async function channelTimelinePg(env: ApiEnv, body: Body, ctx: Ctx): Promise<unknown> {
  const meId = await viewer(env, body, ctx);
  const { untilId, sinceId } = timelineCursor(body);
  const limit = int(body.limit, 10);
  const res = await withHyperdriveClient(env.HYPERDRIVE!, async (c) => {
    const ch = (await c.query(`SELECT id FROM channel WHERE id = $1`, [body.channelId])).rows[0];
    if (!ch) return E.noSuchChannel;
    const channelId = String(ch.id);
    const meta = await metaRowPg(c);
    if (!ftt(meta)) return channelFromDb(c, meta, meId, channelId, { untilId, sinceId, limit });
    return fanoutTimeline(c, meta, {
      untilId, sinceId, limit, allowPartial: bool(body.allowPartial, false), meId,
      useDbFallback: true,
      lists: (q) => `note."channelId" = ${q.p(channelId)}`,
      excludePureRenotes: false,
      ignoreAuthorChannelFromMute: true,
      dbFallback: (u, s, l) => channelFromDb(c, meta, meId, channelId, { untilId: u, sinceId: s, limit: l }),
    });
  });
  if (!Array.isArray(res)) return apiErrorResponse(res, 400);
  return packed(env, res, meId);
}

// ------------------------------------------------------------------ users/notes

async function userFromDb(c: PgQueryable, meta: Record<string, unknown>, meId: string | null, ps: { untilId: string | null; sinceId: string | null; limit: number; userId: string; withChannelNotes: boolean; withFiles: boolean; withRenotes: boolean }) {
  const muting = meId ? await mutedChannelIdsPg(c, meId) : [];
  const isSelf = meId != null && meId === ps.userId;
  const q = new NoteQuery(meta).paginate(ps.sinceId, ps.untilId);
  q.joins = `${NOTE_JOINS} LEFT JOIN channel channel ON channel.id = note."channelId"`;
  q.and(`note."userId" = ${q.p(ps.userId)}`);
  if (ps.withChannelNotes) {
    if (muting.length > 0) q.and(`note."channelId" IS NULL OR note."channelId" != ALL(${q.p(muting)}::varchar[])`);
    if (!isSelf) q.and(`note."channelId" IS NULL OR channel."isSensitive" = FALSE`);
  } else {
    q.and(`note."channelId" IS NULL`);
  }
  if (muting.length > 0) q.and(`note."renoteChannelId" IS NULL OR note."renoteChannelId" != ALL(${q.p(muting)}::varchar[])`);
  q.visibility(meId);
  if (meId == null) q.ugcVisibilityForVisitor();
  q.baseFiltering(meId, { excludeAuthor: true, excludeUserFromMute: ps.userId });
  if (ps.withFiles) q.and(hasFilesSql("note"));
  if (ps.withRenotes === false) q.and(`note."userId" != ${q.p(ps.userId)} OR note."renoteId" IS NULL OR ${hasContentSql}`);
  return q.run(c, ps.limit);
}

export async function usersNotesPg(env: ApiEnv, body: Body, ctx: Ctx): Promise<unknown> {
  const meId = await viewer(env, body, ctx);
  const { untilId, sinceId } = timelineCursor(body);
  const userId = String(body.userId);
  const ps = {
    untilId, sinceId, userId,
    limit: int(body.limit, 10),
    withReplies: bool(body.withReplies, false),
    withRenotes: bool(body.withRenotes, true),
    withChannelNotes: bool(body.withChannelNotes, false),
    withFiles: bool(body.withFiles, false),
  };
  if (ps.withReplies && ps.withFiles) return apiErrorResponse(E.usersNotesBoth, 400);
  const res = await withHyperdriveClient(env.HYPERDRIVE!, async (c) => {
    if (meId != null) {
      const blocked = (await c.query(`SELECT 1 AS x FROM blocking WHERE "blockerId" = $1 AND "blockeeId" = $2 LIMIT 1`, [userId, meId])).rows.length > 0;
      if (blocked) return [];
    }
    const meta = await metaRowPg(c);
    if (!ftt(meta)) return userFromDb(c, meta, meId, ps);
    const isSelf = meId != null && meId === userId;
    const isFollowing = meId != null && (await c.query(`SELECT 1 AS x FROM following WHERE "followerId" = $1 AND "followeeId" = $2 LIMIT 1`, [meId, userId])).rows.length > 0;
    return fanoutTimeline(c, meta, {
      untilId, sinceId, limit: ps.limit, allowPartial: bool(body.allowPartial, false), meId,
      useDbFallback: true,
      lists: (q) => {
        const u = q.p(userId);
        // userTimeline (+WithFiles), userTimelineWithReplies, userTimelineWithChannel
        const lists = [`(note."channelId" IS NULL AND note."userId" = ${u} AND NOT ${isReplySql("note", null)}${ps.withFiles ? ` AND ${hasFilesSql("note")}` : ""})`];
        if (ps.withReplies) lists.push(`(note."channelId" IS NULL AND note."userId" = ${u} AND ${isReplySql("note", null)})`);
        if (ps.withChannelNotes) lists.push(`(note."channelId" IS NOT NULL AND note."userId" = ${u})`);
        return `(${lists.join(" OR ")})`;
      },
      ignoreAuthorFromMute: true,
      ignoreAuthorFromInstanceBlock: true,
      ignoreAuthorFromUserSuspension: true,
      excludeReplies: ps.withChannelNotes && !ps.withReplies,
      excludeNoFiles: ps.withChannelNotes && ps.withFiles,
      excludePureRenotes: !ps.withRenotes,
      noteFilter: (q) => {
        const conds = [];
        if (!isSelf) conds.push(`NOT COALESCE((SELECT "isSensitive" FROM channel WHERE channel.id = note."channelId"), FALSE)`);
        conds.push(meId
          ? `NOT (note.visibility = 'specified' AND ${q.p(meId)} != note."userId" AND NOT (${q.p(meId)} = ANY(note."visibleUserIds")))`
          : `note.visibility != 'specified'`);
        if (!isFollowing && !isSelf) conds.push(`note.visibility != 'followers'`);
        return conds.join(" AND ");
      },
      dbFallback: (u, s, l) => userFromDb(c, meta, meId, { ...ps, untilId: u, sinceId: s, limit: l }),
    });
  });
  return packed(env, res, meId);
}
