/**
 * Federation / instance management on PG, following upstream:
 * federation/followers|following|instances|show-instance|stats|users|update-remote-user,
 * admin/federation/update-instance|delete-all-files|remove-all-following|
 * refresh-remote-instance-metadata, ap/get|show, admin/relays/add|list|remove.
 *
 * Packs FederationInstance like InstanceEntityService (isBlocked / isSilenced /
 * isMediaSilenced from meta's host lists, softwareSuspended from deliverSuspendedSoftware,
 * moderationNote for moderators only). `instance` rows are kept by the AP layer
 * (ap/instances.ts). Upstream's plain `Error`s (instance not found, relay not found, remote
 * fetch failures in ap/get) answer 500 INTERNAL_ERROR as there.
 */

import { getApId, isActor, isPost, type ApObject } from "../../ap/src/index.js";
import { adminGate } from "./admin-gate.js";
import type { ApiEnv } from "./env.js";
import { apiErrorResponse, CREDENTIAL_REQUIRED, INTERNAL_ERROR } from "./errors.js";
import { withHyperdriveClient, type PgQueryable } from "./pg.js";
import { isModeratorPg, moderationLogPg } from "./policies-pg.js";
import { packUsers, pagination } from "./client-endpoints-pg.js";
import { likeEscape } from "./clips-pg.js";
import { buildPackConfig } from "./meta-source.js";
import { getNotePg, getNotesByIdsPg, packNotesFromPg } from "./notes-pg.js";
import { deleteObjects } from "./drive-pg.js";
import { publishToUserStream } from "./stream-publish.js";
import { genAidx, parseAidxTime } from "../../id/src/index.js";
import * as g from "./graph-pg.js";
import * as O from "./ap/outbound.js";
import { getFederationPolicy, hostAllowed, hostOf } from "./ap/federation.js";
import { ApPermanentError, apGet, localBase, parseLocalNoteUri, parseLocalUserUri, resolveRemoteUser } from "./ap/remote.js";
import { createRemoteNote, resolveNoteByUri } from "./ap/inbox.js";
import { renderLocalNote, renderLocalPerson } from "./ap/routes.js";
import { fetchInstanceMetadata, findInstanceC, isDeliverSuspendedSoftware, toPuny } from "./ap/instances.js";
import { addRelay, listRelays, removeRelay } from "./ap/relay.js";
import { authUserId as auth, clientError as err, errorResponse as fail, hd, invalidParam as bad, optionalUserId as optionalMe } from "./handler-kit.js";
import { metaRowPg } from "./user-lite-pg.js";

type Ctx = { hasCredential: boolean; request: Request; waitUntil?: (p: Promise<unknown>) => void };
type Body = Record<string, unknown>;
type Handler = (env: ApiEnv, body: Body, ctx: Ctx) => Promise<Response | unknown>;
type Row = Record<string, unknown>;

const E = {
  showFederationNotAllowed: err("FEDERATION_NOT_ALLOWED", "974b799e-1a29-4889-b706-18d4dd93e266", "Federation for this host is not allowed."),
  showUriInvalid: err("URI_INVALID", "1a5eab56-e47b-48c2-8d5e-217b897d70db", "URI is invalid."),
  showRequestFailed: err("REQUEST_FAILED", "81b539cf-4f57-4b29-bc98-032c33c0792e", "Request failed."),
  showResponseInvalid: err("RESPONSE_INVALID", "70193c39-54f3-4813-82f0-70a680f7495b", "Response from remote server is invalid."),
  showNoSuchObject: err("NO_SUCH_OBJECT", "dc94d745-1262-4e63-a17d-fecaa57efc82", "No such object."),
  relayInvalidUrl: err("INVALID_URL", "fb8c92d3-d4e5-44e7-b3d4-800d5cef8b2c", "Invalid URL"),
};

const internal = () => apiErrorResponse(INTERNAL_ERROR, 500);
const noContent = () => new Response(null, { status: 204 });
const iso = (v: unknown) => (v ? new Date(String(v)).toISOString() : null);
const str = (v: unknown): v is string => typeof v === "string";
const optBool = (v: unknown) => v === undefined || v === null || typeof v === "boolean";

async function gate(env: ApiEnv, body: Body, ctx: Ctx, level: "moderator" | "admin"): Promise<{ denied: Response } | { me: string | null }> {
  const denied = await adminGate(ctx.request, env as never, body, level);
  if (denied) return { denied };
  return { me: await auth(env, body, { ...ctx, hasCredential: true }) };
}

function intParam(v: unknown, def: number, min: number, max: number): number | null {
  if (v === undefined) return def;
  return Number.isInteger(v) && (v as number) >= min && (v as number) <= max ? (v as number) : null;
}

function pageParamsOk(body: Body): boolean {
  return (
    [body.sinceId, body.untilId].every((v) => v === undefined || str(v)) &&
    [body.sinceDate, body.untilDate].every((v) => v === undefined || Number.isInteger(v))
  );
}

// ---------------------------------------------------------------- FederationInstance pack

type HostLists = {
  blockedHosts: string[];
  silencedHosts: string[];
  mediaSilencedHosts: string[];
  deliverSuspendedSoftware: { software: string; versionRange: string }[];
};

/** `fresh`: read the row uncached (upstream federation/instances filters use metaService.fetch(true)). */
async function hostLists(c: PgQueryable, fresh = false): Promise<HostLists> {
  const m = fresh
    ? (((await c.query(`SELECT to_jsonb(m) AS m FROM meta m ORDER BY id DESC LIMIT 1`)).rows[0]?.m ?? {}) as Row)
    : await metaRowPg(c);
  const arr = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);
  return {
    blockedHosts: arr(m.blockedHosts),
    silencedHosts: arr(m.silencedHosts),
    mediaSilencedHosts: arr(m.mediaSilencedHosts),
    deliverSuspendedSoftware: Array.isArray(m.deliverSuspendedSoftware)
      ? (m.deliverSuspendedSoftware as Row[]).filter((x) => x && str(x.software) && str(x.versionRange)) as HostLists["deliverSuspendedSoftware"]
      : [],
  };
}

/** UtilityService.isBlockedHost / isSilencedHost (suffix match) */
const suffixMatch = (list: string[], host: string) => list.some((x) => `.${host.toLowerCase()}`.endsWith(`.${x}`));

function packInstance(i: Row, lists: HostLists, iAmModerator: boolean): Record<string, unknown> {
  const host = String(i.host);
  const softwareSuspended = isDeliverSuspendedSoftware(lists.deliverSuspendedSoftware, i as { softwareName: unknown; softwareVersion: unknown });
  const state = String(i.suspensionState ?? "none");
  return {
    id: i.id,
    firstRetrievedAt: iso(i.firstRetrievedAt),
    host,
    usersCount: Number(i.usersCount ?? 0),
    notesCount: Number(i.notesCount ?? 0),
    followingCount: Number(i.followingCount ?? 0),
    followersCount: Number(i.followersCount ?? 0),
    isNotResponding: Boolean(i.isNotResponding),
    isSuspended: state !== "none" || softwareSuspended,
    suspensionState: state === "none" && softwareSuspended ? "softwareSuspended" : state,
    isBlocked: suffixMatch(lists.blockedHosts, host),
    softwareName: i.softwareName ?? null,
    softwareVersion: i.softwareVersion ?? null,
    openRegistrations: i.openRegistrations ?? null,
    name: i.name ?? null,
    description: i.description ?? null,
    maintainerName: i.maintainerName ?? null,
    maintainerEmail: i.maintainerEmail ?? null,
    isSilenced: suffixMatch(lists.silencedHosts, host),
    isMediaSilenced: lists.mediaSilencedHosts.some((x) => host.toLowerCase() === x),
    iconUrl: i.iconUrl ?? null,
    faviconUrl: i.faviconUrl ?? null,
    themeColor: i.themeColor ?? null,
    infoUpdatedAt: iso(i.infoUpdatedAt),
    latestRequestReceivedAt: iso(i.latestRequestReceivedAt),
    moderationNote: iAmModerator ? (i.moderationNote ?? "") : null,
  };
}

async function packInstances(env: ApiEnv, c: PgQueryable, rows: Row[], me: string | null): Promise<Record<string, unknown>[]> {
  if (rows.length === 0) return [];
  const lists = await hostLists(c);
  const mod = me ? await isModeratorPg(env, c, me) : false;
  return rows.map((r) => packInstance(r, lists, mod));
}

const I_COLS = `i.id, i."firstRetrievedAt", i.host, i."usersCount", i."notesCount", i."followingCount", i."followersCount",
  i."latestRequestReceivedAt", i."isNotResponding", i."suspensionState"::text AS "suspensionState", i."softwareName", i."softwareVersion",
  i."openRegistrations", i.name, i.description, i."maintainerName", i."maintainerEmail", i."iconUrl", i."faviconUrl", i."themeColor",
  i."infoUpdatedAt", i."moderationNote"`;

// ---------------------------------------------------------------- federation/*

/** federation/followers (followeeHost = host) and federation/following (followerHost = host). */
function followingsOfHost(list: "followers" | "following"): Handler {
  return async (env, body, ctx) => {
    const me = await optionalMe(env, body, ctx);
    if (me === "invalid") return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
    const limit = intParam(body.limit, 10, 1, 100);
    if (!str(body.host) || limit == null || !pageParamsOk(body)) return bad();
    const rows = await withHyperdriveClient(hd(env), async (c) => {
      const params: unknown[] = [body.host];
      const p = pagination(body, params, "f.id");
      const where = [list === "followers" ? `f."followeeHost" = $1` : `f."followerHost" = $1`, ...p.where];
      let join = "";
      if (!(me && (await isModeratorPg(env, c, me)))) {
        // QueryService.generateFollowingRelationVisibilityQuery
        const owner = list === "followers" ? `f."followeeId"` : `f."followerId"`;
        const vis = list === "followers" ? `op."followersVisibility"` : `op."followingVisibility"`;
        join = `JOIN user_profile op ON op."userId" = ${owner}`;
        if (!me) {
          where.push(`${vis} = 'public'`);
        } else {
          params.push(me);
          const m = `$${params.length}`;
          where.push(`(${vis} = 'public' OR ${owner} = ${m} OR (${vis} = 'followers' AND ${owner} IN (SELECT "followeeId" FROM following WHERE "followerId" = ${m})))`);
        }
      }
      params.push(limit);
      return (await c.query(
        `SELECT f.id, f."followeeId", f."followerId" FROM following f ${join}
         WHERE ${where.join(" AND ")} ORDER BY f.id ${p.order} LIMIT $${params.length}`,
        params,
      )).rows;
    });
    const me2 = me as string | null;
    const users = (await packUsers(env, [...new Set(rows.map((r) => String(r.followeeId)))], me2, true)) as Row[];
    const byId = new Map(users.map((u) => [String(u.id), u]));
    return rows
      .filter((r) => byId.has(String(r.followeeId)))
      .map((r) => ({
        id: r.id,
        createdAt: (parseAidxTime(String(r.id)) ?? new Date(0)).toISOString(),
        followeeId: r.followeeId,
        followerId: r.followerId,
        followee: byId.get(String(r.followeeId)),
      }));
  };
}

const SORTS: Record<string, string> = {
  // TypeORM's second orderBy() replaces the first: upstream effectively sorts by followersCount
  "+pubSub": `i."followersCount" DESC`,
  "-pubSub": `i."followersCount" ASC`,
  "+notes": `i."notesCount" DESC`,
  "-notes": `i."notesCount" ASC`,
  "+users": `i."usersCount" DESC`,
  "-users": `i."usersCount" ASC`,
  "+following": `i."followingCount" DESC`,
  "-following": `i."followingCount" ASC`,
  "+followers": `i."followersCount" DESC`,
  "-followers": `i."followersCount" ASC`,
  "+firstRetrievedAt": `i."firstRetrievedAt" DESC`,
  "-firstRetrievedAt": `i."firstRetrievedAt" ASC`,
  "+latestRequestReceivedAt": `i."latestRequestReceivedAt" DESC NULLS LAST`,
  "-latestRequestReceivedAt": `i."latestRequestReceivedAt" ASC NULLS FIRST`,
};

const instances: Handler = async (env, body, ctx) => {
  const me = await optionalMe(env, body, ctx);
  if (me === "invalid") return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  const limit = intParam(body.limit, 30, 1, 100);
  const offset = body.offset === undefined ? 0 : Number.isInteger(body.offset) ? (body.offset as number) : null;
  const bools = ["blocked", "notResponding", "suspended", "silenced", "federating", "subscribing", "publishing"] as const;
  if (limit == null || offset == null) return bad();
  if (offset < 0) return internal(); // no minimum upstream: PG rejects a negative OFFSET
  if (!bools.every((k) => optBool(body[k]))) return bad();
  if (body.host !== undefined && body.host !== null && !str(body.host)) return bad();
  if (body.sort !== undefined && body.sort !== null && !(str(body.sort) && SORTS[body.sort])) return bad();
  return withHyperdriveClient(hd(env), async (c) => {
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (v: unknown) => (params.push(v), `$${params.length}`);
    const lists = typeof body.blocked === "boolean" || typeof body.silenced === "boolean" ? await hostLists(c, true) : null;
    if (typeof body.blocked === "boolean") {
      if (body.blocked) where.push(lists!.blockedHosts.length === 0 ? "1=0" : `i.host = ANY(${add(lists!.blockedHosts)}::varchar[])`);
      else if (lists!.blockedHosts.length > 0) where.push(`NOT (i.host = ANY(${add(lists!.blockedHosts)}::varchar[]))`);
    }
    if (typeof body.notResponding === "boolean") where.push(`i."isNotResponding" = ${body.notResponding ? "TRUE" : "FALSE"}`);
    if (typeof body.suspended === "boolean") where.push(`i."suspensionState" ${body.suspended ? "!=" : "="} 'none'`);
    if (typeof body.silenced === "boolean") {
      if (body.silenced) {
        if (lists!.silencedHosts.length === 0) return [];
        where.push(`i.host = ANY(${add(lists!.silencedHosts)}::varchar[])`);
      } else if (lists!.silencedHosts.length > 0) {
        where.push(`NOT (i.host = ANY(${add(lists!.silencedHosts)}::varchar[]))`);
      }
    }
    if (typeof body.federating === "boolean") {
      where.push(body.federating ? `(i."followingCount" > 0 OR i."followersCount" > 0)` : `(i."followingCount" = 0 AND i."followersCount" = 0)`);
    }
    if (typeof body.subscribing === "boolean") where.push(`i."followersCount" ${body.subscribing ? ">" : "="} 0`);
    if (typeof body.publishing === "boolean") where.push(`i."followingCount" ${body.publishing ? ">" : "="} 0`);
    if (str(body.host) && body.host.length > 0) where.push(`i.host LIKE ${add(`%${likeEscape(body.host.toLowerCase())}%`)}`);
    const order = (str(body.sort) && SORTS[body.sort]) || `i.id DESC`;
    const rows = (await c.query(
      `SELECT ${I_COLS} FROM instance i ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY ${order} LIMIT ${add(limit)} OFFSET ${add(offset)}`,
      params,
    )).rows;
    return packInstances(env, c, rows, me);
  });
};

const showInstance: Handler = async (env, body, ctx) => {
  const me = await optionalMe(env, body, ctx);
  if (me === "invalid") return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  if (!str(body.host)) return bad();
  return withHyperdriveClient(hd(env), async (c) => {
    const row = (await c.query(`SELECT ${I_COLS} FROM instance i WHERE i.host = $1`, [toPuny(body.host as string)])).rows[0];
    return row ? (await packInstances(env, c, [row], me))[0] : null;
  });
};

const federationStats: Handler = async (env, body, ctx) => {
  const me = await optionalMe(env, body, ctx);
  if (me === "invalid") return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  const limit = intParam(body.limit, 10, 1, 100);
  if (limit == null) return bad();
  return withHyperdriveClient(hd(env), async (c) => {
    const sub = (await c.query(`SELECT ${I_COLS} FROM instance i WHERE i."followersCount" > 0 ORDER BY i."followersCount" DESC LIMIT $1`, [limit])).rows;
    const pub = (await c.query(`SELECT ${I_COLS} FROM instance i WHERE i."followingCount" > 0 ORDER BY i."followingCount" DESC LIMIT $1`, [limit])).rows;
    const count = async (col: string) => Number((await c.query(`SELECT count(*)::int AS n FROM following WHERE "${col}" IS NOT NULL`)).rows[0]?.n ?? 0);
    const allSub = await count("followeeHost");
    const allPub = await count("followerHost");
    const sum = (rows: Row[], k: string) => rows.reduce((a, r) => a + Number(r[k] ?? 0), 0);
    return {
      topSubInstances: await packInstances(env, c, sub, me),
      otherFollowersCount: Math.max(0, allSub - sum(sub, "followersCount")),
      topPubInstances: await packInstances(env, c, pub, me),
      otherFollowingCount: Math.max(0, allPub - sum(pub, "followingCount")),
    };
  });
};

const federationUsers: Handler = async (env, body, ctx) => {
  const me = await optionalMe(env, body, ctx);
  if (me === "invalid") return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  const limit = intParam(body.limit, 10, 1, 100);
  if (!str(body.host) || limit == null || !pageParamsOk(body)) return bad();
  const ids = await withHyperdriveClient(hd(env), async (c) => {
    const params: unknown[] = [body.host];
    const p = pagination(body, params, "u.id");
    params.push(limit);
    return (await c.query(
      `SELECT u.id FROM "user" u WHERE ${[`u.host = $1`, ...p.where].join(" AND ")} ORDER BY u.id ${p.order} LIMIT $${params.length}`,
      params,
    )).rows.map((r) => String(r.id));
  });
  return packUsers(env, ids, me, true);
};

const updateRemoteUser: Handler = async (env, body, ctx) => {
  const me = await auth(env, body, ctx);
  if (!me) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  if (!str(body.userId)) return bad();
  const user = await withHyperdriveClient(hd(env), async (c) =>
    (await c.query(`SELECT id, host, uri FROM "user" WHERE id = $1`, [body.userId])).rows[0],
  );
  // GetterService.getRemoteUser: IdentifiableError / Error → 500
  if (!user || user.host == null || !user.uri) return internal();
  try {
    await resolveRemoteUser(env, String(user.uri), { refresh: true });
  } catch {
    return internal();
  }
  return noContent();
};

// ---------------------------------------------------------------- admin/federation/*

async function instanceByHost(c: PgQueryable, host: string): Promise<Row | null> {
  return findInstanceC(c, toPuny(host));
}

const updateInstance: Handler = async (env, body, ctx) => {
  const gt = await gate(env, body, ctx, "moderator");
  if ("denied" in gt) return gt.denied;
  if (!str(body.host) || !(body.isSuspended === undefined || typeof body.isSuspended === "boolean") || !(body.moderationNote === undefined || str(body.moderationNote))) return bad();
  return withHyperdriveClient(hd(env), async (c) => {
    const i = await instanceByHost(c, body.host as string);
    if (!i) return internal(); // Error('instance not found')
    const before = String(i.suspensionState) !== "none";
    const changeSuspension = typeof body.isSuspended === "boolean" && before !== body.isSuspended;
    const sets: string[] = [];
    const params: unknown[] = [i.id];
    if (changeSuspension) {
      params.push(body.isSuspended ? "manuallySuspended" : "none");
      sets.push(`"suspensionState" = $${params.length}`);
    }
    if (str(body.moderationNote)) {
      params.push(body.moderationNote);
      sets.push(`"moderationNote" = $${params.length}`);
    }
    if (sets.length) await c.query(`UPDATE instance SET ${sets.join(", ")} WHERE id = $1`, params);
    if (gt.me) {
      const info = { id: i.id, host: i.host };
      if (changeSuspension) await moderationLogPg(c, gt.me, body.isSuspended ? "suspendRemoteInstance" : "unsuspendRemoteInstance", info, genAidx(Date.now()));
      if (str(body.moderationNote) && i.moderationNote !== body.moderationNote) {
        await moderationLogPg(c, gt.me, "updateRemoteInstanceNote", { ...info, before: i.moderationNote, after: body.moderationNote }, genAidx(Date.now()));
      }
    }
    return noContent();
  });
};

const deleteAllFiles: Handler = async (env, body, ctx) => {
  const gt = await gate(env, body, ctx, "moderator");
  if ("denied" in gt) return gt.denied;
  if (!str(body.host)) return bad();
  // DriveService.deleteFile for each file of the host (objects unless isLink, then the row)
  for (;;) {
    const rows = await withHyperdriveClient(hd(env), async (c) =>
      (await c.query(`DELETE FROM drive_file WHERE id IN (SELECT id FROM drive_file WHERE "userHost" = $1 LIMIT 200) RETURNING *`, [body.host])).rows,
    );
    if (rows.length === 0) break;
    for (const f of rows) {
      if (!f.isLink) await deleteObjects(env, f);
      if (f.userId) await publishToUserStream(env, String(f.userId), "drive", "fileDeleted", f.id);
    }
  }
  return noContent();
};

const removeAllFollowing: Handler = async (env, body, ctx) => {
  const gt = await gate(env, body, ctx, "moderator");
  if ("denied" in gt) return gt.denied;
  if (!str(body.host)) return bad();
  const pairs = await withHyperdriveClient(hd(env), async (c) =>
    (await c.query(
      `SELECT f."followerId", f."followeeId", ee.host AS "followeeHost" FROM following f
       JOIN "user" er ON er.id = f."followerId" JOIN "user" ee ON ee.id = f."followeeId" WHERE f."followerHost" = $1`,
      [body.host],
    )).rows,
  );
  // QueueService.createUnfollowJob(silent) → UserFollowingService.unfollow
  for (const p of pairs) {
    if (!(await g.unfollow(env, String(p.followerId), String(p.followeeId)))) continue;
    if (p.followeeHost == null) await O.deliverFollowAnswer(env, "reject", String(p.followeeId), String(p.followerId), null);
  }
  return noContent();
};

const refreshRemoteInstanceMetadata: Handler = async (env, body, ctx) => {
  const gt = await gate(env, body, ctx, "moderator");
  if ("denied" in gt) return gt.denied;
  if (!str(body.host)) return bad();
  const i = await withHyperdriveClient(hd(env), (c) => instanceByHost(c, body.host as string));
  if (!i) return internal(); // Error('instance not found')
  const job = fetchInstanceMetadata(env, i, true);
  if (ctx.waitUntil) ctx.waitUntil(job);
  else await job;
  return noContent();
};

// ---------------------------------------------------------------- ap/get, ap/show

/** UtilityService.isFederationAllowedUri (self host always allowed). */
async function federationAllowed(env: ApiEnv, uri: string): Promise<boolean> {
  const host = hostOf(uri);
  if (!host) return false;
  if (host === hostOf(localBase(env))) return true;
  try {
    return hostAllowed(await getFederationPolicy(env), host);
  } catch {
    return false;
  }
}

const apGetHandler: Handler = async (env, body, ctx) => {
  const gt = await gate(env, body, ctx, "admin");
  if ("denied" in gt) return gt.denied;
  if (!str(body.uri)) return bad();
  const uri = body.uri;
  try {
    if (!(await federationAllowed(env, uri))) return internal();
    if (hostOf(uri) === hostOf(localBase(env))) {
      // Resolver.resolveLocal
      const userId = parseLocalUserUri(env, uri);
      if (userId) return (await renderLocalPerson(env, userId)) ?? internal();
      const noteId = parseLocalNoteUri(env, uri);
      const note = noteId ? await getNotePg(env, noteId) : null;
      if (note && (note.visibility === "public" || note.visibility === "home") && !note.localOnly) return await renderLocalNote(env, note);
      return internal();
    }
    return await apGet(env, uri);
  } catch {
    return internal();
  }
};

type Found = { user?: string | null; note?: string | null };

async function findLocalByApId(env: ApiEnv, uri: string): Promise<Found> {
  const localUser = parseLocalUserUri(env, uri);
  const localNote = parseLocalNoteUri(env, uri);
  return withHyperdriveClient(hd(env), async (c) => {
    const u = localUser
      ? (await c.query(`SELECT id FROM "user" WHERE id = $1 AND host IS NULL`, [localUser])).rows[0]
      : (await c.query(`SELECT id FROM "user" WHERE uri = $1 LIMIT 1`, [uri])).rows[0];
    const n = localNote
      ? (await c.query(`SELECT id FROM note WHERE id = $1 AND "userHost" IS NULL`, [localNote])).rows[0]
      : (await c.query(`SELECT id FROM note WHERE uri = $1 LIMIT 1`, [uri])).rows[0];
    return { user: u ? String(u.id) : null, note: n ? String(n.id) : null };
  });
}

async function mergePack(env: ApiEnv, me: string, f: Found): Promise<Record<string, unknown> | null> {
  if (f.user) {
    const [u] = (await packUsers(env, [f.user], me, true)) as unknown[];
    return u ? { type: "User", object: u } : null;
  }
  if (f.note) {
    try {
      const notes = await getNotesByIdsPg(env, [f.note]);
      const [n] = await packNotesFromPg(env, notes, buildPackConfig(env), me);
      return n ? { type: "Note", object: n } : null;
    } catch {
      return null;
    }
  }
  return null;
}

const apShow: Handler = async (env, body, ctx) => {
  const me = await auth(env, body, ctx);
  if (!me) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  if (!str(body.uri)) return bad();
  const uri = body.uri;
  try {
    new URL(uri);
  } catch {
    return internal(); // extractDbHost(new URL()) throws
  }
  if (!(await federationAllowed(env, uri))) return fail(E.showFederationNotAllowed);
  let local = await mergePack(env, me, await findLocalByApId(env, uri));
  if (local) return local;
  if (hostOf(uri) === hostOf(localBase(env))) return fail(E.showNoSuchObject);

  let object: ApObject;
  try {
    object = await apGet(env, uri);
  } catch (e) {
    if (e instanceof ApPermanentError && e.message === "unsafe url") return fail(E.showUriInvalid);
    if (e instanceof SyntaxError || (e instanceof ApPermanentError && (e.message === "not an object" || e.message === "too large"))) return fail(E.showResponseInvalid);
    return fail(E.showRequestFailed);
  }
  const id = getApId(object);
  if (id == null) return fail(E.showResponseInvalid);
  if (uri !== id) {
    if (!(await federationAllowed(env, id))) return fail(E.showFederationNotAllowed);
    local = await mergePack(env, me, await findLocalByApId(env, id));
    if (local) return local;
  }
  try {
    const found: Found = {};
    // re-fetch from the canonical id unless that is where the object came from
    const hint = uri === id ? object : undefined;
    if (isActor(object)) found.user = (await resolveRemoteUser(env, id, { refresh: true, object: hint })).id;
    else if (isPost(object)) {
      if (hint) {
        const authorUri = getApId(object.attributedTo);
        if (authorUri && (await federationAllowed(env, authorUri))) {
          found.note = await createRemoteNote(env, object, await resolveRemoteUser(env, authorUri));
        }
      } else {
        found.note = await resolveNoteByUri(env, id);
      }
    }
    return (await mergePack(env, me, found)) ?? fail(E.showNoSuchObject);
  } catch {
    return fail(E.showRequestFailed);
  }
};

// ---------------------------------------------------------------- admin/relays/*

const relaysAdd: Handler = async (env, body, ctx) => {
  const gt = await gate(env, body, ctx, "moderator");
  if ("denied" in gt) return gt.denied;
  if (!str(body.inbox)) return bad();
  try {
    if (new URL(body.inbox).protocol !== "https:") throw new Error("https only");
  } catch {
    return fail(E.relayInvalidUrl);
  }
  try {
    return await addRelay(env, body.inbox);
  } catch {
    return internal(); // duplicate inbox (unique index)
  }
};

const relaysList: Handler = async (env, body, ctx) => {
  const gt = await gate(env, body, ctx, "moderator");
  if ("denied" in gt) return gt.denied;
  return listRelays(env);
};

const relaysRemove: Handler = async (env, body, ctx) => {
  const gt = await gate(env, body, ctx, "moderator");
  if ("denied" in gt) return gt.denied;
  if (!str(body.inbox)) return bad();
  return (await removeRelay(env, body.inbox)) ? noContent() : internal(); // Error('relay not found')
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
  "federation/followers": followingsOfHost("followers"),
  "federation/following": followingsOfHost("following"),
  "federation/instances": instances,
  "federation/show-instance": showInstance,
  "federation/stats": federationStats,
  "federation/users": federationUsers,
  "federation/update-remote-user": updateRemoteUser,
  "admin/federation/update-instance": updateInstance,
  "admin/federation/delete-all-files": deleteAllFiles,
  "admin/federation/remove-all-following": removeAllFollowing,
  "admin/federation/refresh-remote-instance-metadata": refreshRemoteInstanceMetadata,
  "ap/get": apGetHandler,
  "ap/show": apShow,
  "admin/relays/add": relaysAdd,
  "admin/relays/list": relaysList,
  "admin/relays/remove": relaysRemove,
};

export const federationHandlers: Record<string, Handler> = Object.fromEntries(Object.entries(RAW).map(([k, h]) => [k, pgOnly(h)]));

