/**
 * Account migration (upstream endpoints/i/move.ts + AccountMoveService, and the remote side of
 * ApPersonService.processRemoteMove).
 *
 * i/move resolves the destination (local, known remote, or WebFinger), re-fetches it, requires the
 * old account's URI in its alsoKnownAs, then moveFromLocal: alsoKnownAs / movedToUri / movedAt,
 * Update(Person) to followers and relays, Move to followers, `meUpdated`, the old account's
 * followings are unfollowed 24 hours later, and postMoveProcess runs.
 *
 * postMoveProcess (also for a remote account the inbox sees moving): blocks of the old account are
 * re-applied to the new one, mutes and list memberships copied, role assignments whose role has
 * `preserveAssignmentOnMoveAccount` copied, antennas listing the old account get the new one,
 * follower / following counts adjusted as upstream, and the old account's local followers follow
 * the new account. Blocks, follows and the delayed unfollow are bounded `accountMove` steps on
 * `mk-jobs` (50 rows per step, re-enqueued); without the queue binding they run inline.
 */

import { genAidx } from "../../id/src/index.js";
import type { ApiEnv } from "./env.js";
import { apiErrorResponse, CREDENTIAL_REQUIRED, INTERNAL_ERROR, INVALID_PARAM, type ApiErrorBody } from "./errors.js";
import { authenticatePg, extractToken } from "./auth-pg.js";
import { withHyperdriveClient, type PgQueryable } from "./pg.js";
import { buildPackConfig } from "./meta-source.js";
import { getRootUserId } from "./users-pg.js";
import { createNotification } from "./notifications-do.js";
import { publishToUserStream } from "./stream-publish.js";
import { packMe } from "./client-endpoints-pg.js";
import * as g from "./graph-pg.js";
import * as O from "./ap/outbound.js";
import { localActorUri } from "./ap/deliver.js";
import { bumpInstance } from "./ap/instances.js";
import { fetchSystemAccountC } from "./ap/relay.js";
import { parseLocalUserUri, resolveRemoteAcct, resolveRemoteUser } from "./ap/remote.js";
import { hd } from "./handler-kit.js";
import { fromSimpleArray, toSimpleArray } from "../../db/src/simple-array.js";
import { enqueueJob } from "./queues/jobs-queue.js";

type Ctx = { hasCredential: boolean; request: Request };
type Body = Record<string, unknown>;
type Handler = (env: ApiEnv, body: Body, ctx: Ctx) => Promise<Response | unknown>;

const STEP = 50;
/** Unfollow after 24 hours (CF Queues delay at most 12 h per hop). */
const UNFOLLOW_DELAY_MS = 24 * 3600_000;
const MAX_QUEUE_DELAY_S = 12 * 3600;

const err = (code: string, id: string, message: string): ApiErrorBody => ({ code, id, message, kind: "client" });
export const MOVE_ERRORS = {
  destinationAccountForbids: err("DESTINATION_ACCOUNT_FORBIDS", "b5c90186-4ab0-49c8-9bba-a1f766282ba4", "Destination account doesn't have proper 'Known As' alias, or has already moved."),
  rootForbidden: err("NOT_ROOT_FORBIDDEN", "4362e8dc-731f-4ad8-a694-be2a88922a24", "The root can't migrate."),
  noSuchUser: err("NO_SUCH_USER", "fcd2eef9-a9b2-4c4f-8624-038099e90aa5", "No such user."),
  uriNull: err("URI_NULL", "bf326f31-d430-4f97-9933-5d61e4d48a23", "User ActivityPup URI is null."),
  localUriNull: err("URI_NULL", "95ba11b9-90e8-43a5-ba16-7acc1ab32e71", "Local User ActivityPup URI is null."),
  alreadyMoved: err("ALREADY_MOVED", "b234a14e-9ebe-4581-8000-074b3c215962", "Account was already moved to another account."),
};

export type MoveUser = {
  id: string;
  username: string;
  host: string | null;
  /** AP id (local users: `{url}/users/{id}`) */
  uri: string;
  movedToUri: string | null;
  alsoKnownAs: string[] | null;
  isLocked: boolean;
};

async function loadUserC(c: PgQueryable, env: ApiEnv, where: "id" | "uri", value: string): Promise<MoveUser | null> {
  const row = (await c.query(
    `SELECT id, username, host, uri, "movedToUri", "alsoKnownAs", "isLocked" FROM "user"
     WHERE ${where === "id" ? "id" : "uri"} = $1 LIMIT 1`,
    [value],
  )).rows[0];
  if (!row) return null;
  const host = (row.host as string | null) ?? null;
  return {
    id: String(row.id),
    username: String(row.username),
    host,
    uri: host == null ? localActorUri(env, String(row.id)) : String(row.uri ?? ""),
    movedToUri: (row.movedToUri as string | null) ?? null,
    alsoKnownAs: fromSimpleArray(row.alsoKnownAs),
    isLocked: Boolean(row.isLocked),
  };
}

export async function loadMoveUser(env: ApiEnv, id: string): Promise<MoveUser | null> {
  return withHyperdriveClient(hd(env), (c) => loadUserC(c, env, "id", id));
}

/** ApPersonService.fetchPerson: a local URI → the local user, else the remote user with that uri. */
async function fetchPerson(env: ApiEnv, uri: string): Promise<MoveUser | null> {
  const localId = parseLocalUserUri(env, uri);
  return withHyperdriveClient(hd(env), async (c) => {
    if (localId) {
      const u = await loadUserC(c, env, "id", localId);
      return u && u.host == null ? u : null;
    }
    return loadUserC(c, env, "uri", uri);
  });
}

// ---------------------------------------------------------------- jobs

export type AccountMoveJob =
  /** re-block the new account for each blocker of the old one */
  | { kind: "accountMove"; op: "block"; srcId: string; dstId: string; cursor?: string }
  /** local followers of the old account follow the new one */
  | { kind: "accountMove"; op: "follow"; srcId: string; dstId: string; cursor?: string }
  /** the old (local) account unfollows everyone, after notBefore */
  | { kind: "accountMove"; op: "unfollow"; srcId: string; notBefore: number };

async function enqueue(env: ApiEnv, job: AccountMoveJob, delaySeconds?: number): Promise<void> {
  if (env.Q_JOBS) {
    await enqueueJob(env, job, delaySeconds ? { delaySeconds } : undefined);
    return;
  }
  // offline / tests: run every step now (a delayed unfollow runs at once)
  let next: AccountMoveJob | null = job;
  while (next) next = await runAccountMoveStep(env, next, { ignoreDelay: true });
}

/** One bounded step; returns the follow-up job or null when done. */
export async function runAccountMoveStep(env: ApiEnv, job: AccountMoveJob, opts: { ignoreDelay?: boolean } = {}): Promise<AccountMoveJob | null> {
  if (job.op === "unfollow") {
    const wait = job.notBefore - Date.now();
    if (wait > 0 && !opts.ignoreDelay) {
      await enqueueJob(env, job, { delaySeconds: Math.min(MAX_QUEUE_DELAY_S, Math.ceil(wait / 1000)) });
      return null;
    }
    const followees = await withHyperdriveClient(hd(env), async (c) =>
      (await c.query(`SELECT "followeeId" FROM following WHERE "followerId" = $1 ORDER BY id LIMIT ${STEP}`, [job.srcId])).rows.map((r) => String(r.followeeId)),
    );
    for (const followeeId of followees) await unfollowAsService(env, job.srcId, followeeId);
    return followees.length === STEP ? job : null;
  }
  if (job.op === "block") {
    const rows = await withHyperdriveClient(hd(env), async (c) =>
      (await c.query(
        `SELECT b."blockerId", u.host FROM blocking b JOIN "user" u ON u.id = b."blockerId"
         WHERE b."blockeeId" = $1 AND ($2::varchar IS NULL OR b."blockerId" > $2)
           AND NOT EXISTS (SELECT 1 FROM blocking d WHERE d."blockeeId" = $3 AND d."blockerId" = b."blockerId")
         ORDER BY b."blockerId" LIMIT ${STEP}`,
        [job.srcId, job.cursor ?? null, job.dstId],
      )).rows,
    );
    for (const r of rows) await blockAsService(env, String(r.blockerId), r.host == null, job.dstId);
    return rows.length === STEP ? { ...job, cursor: String(rows[rows.length - 1]!.blockerId) } : null;
  }
  // follow: the old account's local followers (except the proxy account) follow the new one
  const followers = await withHyperdriveClient(hd(env), async (c) => {
    const proxyId = await fetchSystemAccountC(c, "proxy");
    return (await c.query(
      `SELECT "followerId" FROM following
       WHERE "followeeId" = $1 AND "followerHost" IS NULL AND "followerId" <> $2 AND ($3::varchar IS NULL OR "followerId" > $3)
       ORDER BY "followerId" LIMIT ${STEP}`,
      [job.srcId, proxyId, job.cursor ?? null],
    )).rows.map((r) => String(r.followerId));
  });
  for (const followerId of followers) await followAsService(env, followerId, job.dstId);
  return followers.length === STEP ? { ...job, cursor: followers[followers.length - 1]! } : null;
}

/** RelationshipProcessor follow → UserFollowingService.follow (requests, notifications, AP, webhooks). */
async function followAsService(env: ApiEnv, followerId: string, followeeId: string): Promise<void> {
  try {
    const r = await g.followWithPolicy(env, followerId, followeeId);
    if (r === "followed") {
      await createNotification(env, followeeId, { type: "follow", notifierId: followerId });
      const { webhooksForFollow } = await import("./webhooks-pg.js");
      await webhooksForFollow(env, followerId, followeeId);
    } else if (r === "requested") {
      await createNotification(env, followeeId, { type: "receiveFollowRequest", notifierId: followerId });
      await O.deliverFollow(env, followerId, followeeId);
    }
  } catch (e) {
    console.warn(`move follow failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** RelationshipProcessor unfollow → UserFollowingService.unfollow (Undo(Follow) to a remote followee, webhook). */
async function unfollowAsService(env: ApiEnv, followerId: string, followeeId: string): Promise<void> {
  if (!(await g.unfollow(env, followerId, followeeId))) return;
  await O.deliverUndoFollow(env, followerId, followeeId);
  const { webhooksForUnfollow } = await import("./webhooks-pg.js");
  await webhooksForUnfollow(env, followerId, followeeId);
}

/** RelationshipProcessor block → UserBlockingService.block (Block delivered by a local blocker). */
async function blockAsService(env: ApiEnv, blockerId: string, blockerIsLocal: boolean, blockeeId: string): Promise<void> {
  if ((await g.block(env, blockerId, blockeeId)) === "blocked" && blockerIsLocal) await O.deliverBlock(env, blockerId, blockeeId);
}

// ---------------------------------------------------------------- AccountMoveService

/** Full acct with this server's host for local users (UtilityService.getFullApAccount). */
function fullAcct(env: ApiEnv, username: string, host: string | null): string {
  return `${username}@${host ?? buildPackConfig(env).host}`.toLowerCase();
}

function parseAcct(acct: string): { username: string; host: string | null } {
  const a = acct.startsWith("@") ? acct.slice(1) : acct;
  const i = a.indexOf("@");
  return i < 0 ? { username: a, host: null } : { username: a.slice(0, i), host: a.slice(i + 1).split("@")[0]! };
}

async function copyMutingsC(c: PgQueryable, src: MoveUser, dst: MoveUser): Promise<void> {
  const old = (await c.query(
    `SELECT "muterId", "expiresAt" FROM muting WHERE "muteeId" = $1 AND ("expiresAt" IS NULL OR "expiresAt" > now())`,
    [src.id],
  )).rows;
  if (old.length === 0) return;
  const indefinitely = new Set((await c.query(`SELECT "muterId" FROM muting WHERE "muteeId" = $1 AND "expiresAt" IS NULL`, [dst.id])).rows.map((r) => String(r.muterId)));
  for (const m of old) {
    if (indefinitely.has(String(m.muterId))) continue;
    await c.query(`INSERT INTO muting (id, "muterId", "muteeId", "expiresAt") VALUES ($1, $2, $3, $4)`, [genAidx(Date.now()), m.muterId, dst.id, m.expiresAt ?? null]);
  }
}

async function copyRoles(env: ApiEnv, src: MoveUser, dst: MoveUser): Promise<void> {
  const notify = await withHyperdriveClient(hd(env), async (c) => {
    const assigns = (await c.query(
      `SELECT a."roleId", a."expiresAt", r."isPublic" FROM role_assignment a JOIN role r ON r.id = a."roleId"
       WHERE a."userId" = $1 AND (a."expiresAt" IS NULL OR a."expiresAt" > now()) AND r."preserveAssignmentOnMoveAccount" = TRUE`,
      [src.id],
    )).rows;
    const out: string[] = [];
    for (const a of assigns) {
      // RoleService.assign: an expired assignment is replaced, a live one is AlreadyAssigned (skipped)
      const existing = (await c.query(`SELECT id, "expiresAt" FROM role_assignment WHERE "roleId" = $1 AND "userId" = $2`, [a.roleId, dst.id])).rows[0];
      if (existing) {
        if (existing.expiresAt && new Date(String(existing.expiresAt)).getTime() < Date.now()) {
          await c.query(`DELETE FROM role_assignment WHERE "roleId" = $1 AND "userId" = $2`, [a.roleId, dst.id]);
        } else continue;
      }
      await c.query(`INSERT INTO role_assignment (id, "userId", "roleId", "expiresAt") VALUES ($1, $2, $3, $4)`, [genAidx(Date.now()), dst.id, a.roleId, a.expiresAt ?? null]);
      await c.query(`UPDATE role SET "lastUsedAt" = now() WHERE id = $1`, [a.roleId]);
      if (a.isPublic && dst.host == null) out.push(String(a.roleId));
    }
    return out;
  });
  for (const roleId of notify) await createNotification(env, dst.id, { type: "roleAssigned", notifierId: null, roleId });
}

/** updateLists: the new account joins every list the old one is in (no removal, no limit check). */
async function updateLists(env: ApiEnv, src: MoveUser, dst: MoveUser): Promise<void> {
  const proxyId = await withHyperdriveClient(hd(env), async (c) => {
    const old = (await c.query(`SELECT "userListId", "userListUserId" FROM user_list_membership WHERE "userId" = $1`, [src.id])).rows;
    if (old.length === 0) return null;
    const existing = new Set((await c.query(`SELECT "userListId" FROM user_list_membership WHERE "userId" = $1`, [dst.id])).rows.map((r) => String(r.userListId)));
    for (const m of old) {
      if (existing.has(String(m.userListId))) continue;
      await c.query(
        `INSERT INTO user_list_membership (id, "userId", "userListId", "userListUserId") VALUES ($1, $2, $3, $4)`,
        [genAidx(Date.now()), dst.id, m.userListId, m.userListUserId],
      );
    }
    // as UserListService.push: the proxy account follows a remote member
    return dst.host != null ? fetchSystemAccountC(c, "proxy") : null;
  });
  if (proxyId) await followAsService(env, proxyId, dst.id);
}

/** AntennaService.onMoveAccount: antennas listing the old account also list the new one. */
async function antennasOnMove(env: ApiEnv, src: MoveUser, dst: MoveUser): Promise<void> {
  const srcAcct = fullAcct(env, src.username, src.host);
  const dstAcct = "@" + (dst.host ? `${dst.username}@${dst.host}` : dst.username);
  await withHyperdriveClient(hd(env), async (c) => {
    const antennas = (await c.query(`SELECT id, users FROM antenna WHERE cardinality(users) > 0`)).rows;
    for (const a of antennas) {
      const users = (a.users as string[]) ?? [];
      if (!users.some((u) => { const p = parseAcct(u); return fullAcct(env, p.username, p.host) === srcAcct; })) continue;
      await c.query(`UPDATE antenna SET users = array_append(users, $2) WHERE id = $1`, [a.id, dstAcct]);
    }
  });
}

/** adjustFollowingCounts: counts drop as if unfollowed, while the following rows stay. */
async function adjustFollowingCounts(env: ApiEnv, localFollowerIds: string[], old: MoveUser): Promise<void> {
  if (localFollowerIds.length === 0) return;
  await withHyperdriveClient(hd(env), async (c) => {
    await c.query(`UPDATE "user" SET "followersCount" = 0, "followingCount" = 0 WHERE id = $1`, [old.id]);
    await c.query(`UPDATE "user" SET "followingCount" = "followingCount" - 1 WHERE id = ANY($1::varchar[])`, [localFollowerIds]);
    await c.query(
      `UPDATE "user" SET "followersCount" = "followersCount" - 1 WHERE id IN (SELECT "followeeId" FROM following WHERE "followerId" = $1)`,
      [old.id],
    );
  });
  if (old.host != null) await bumpInstance(env, old.host, "followersCount", -localFollowerIds.length);
}

/** AccountMoveService.postMoveProcess. */
export async function postMoveProcess(env: ApiEnv, src: MoveUser, dst: MoveUser): Promise<void> {
  try {
    await enqueue(env, { kind: "accountMove", op: "block", srcId: src.id, dstId: dst.id });
    await withHyperdriveClient(hd(env), (c) => copyMutingsC(c, src, dst));
    await copyRoles(env, src, dst);
    await updateLists(env, src, dst);
    await antennasOnMove(env, src, dst);
  } catch (e) {
    /* skip if any error happens (upstream) */
    console.warn(`postMoveProcess copy failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  const localFollowerIds = await withHyperdriveClient(hd(env), async (c) => {
    const proxyId = await fetchSystemAccountC(c, "proxy");
    return (await c.query(
      `SELECT "followerId" FROM following WHERE "followeeId" = $1 AND "followerHost" IS NULL AND "followerId" <> $2`,
      [src.id, proxyId],
    )).rows.map((r) => String(r.followerId));
  });
  try {
    await adjustFollowingCounts(env, localFollowerIds, src);
  } catch {
    /* skip if any error happens */
  }
  if (localFollowerIds.length) await enqueue(env, { kind: "accountMove", op: "follow", srcId: src.id, dstId: dst.id });
}

/** AccountMoveService.moveFromLocal → MeDetailed. */
export async function moveFromLocal(env: ApiEnv, src: MoveUser, dst: MoveUser): Promise<Record<string, unknown> | Response> {
  const dstUri = dst.uri;
  const alsoKnownAs = src.alsoKnownAs?.includes(dstUri) ? src.alsoKnownAs : [...(src.alsoKnownAs ?? []), dstUri];
  await withHyperdriveClient(hd(env), (c) =>
    c.query(`UPDATE "user" SET "alsoKnownAs" = $2, "movedToUri" = $3, "movedAt" = now() WHERE id = $1`, [src.id, toSimpleArray(alsoKnownAs), dstUri]),
  );
  Object.assign(src, { alsoKnownAs, movedToUri: dstUri });
  await O.deliverPersonUpdate(env, src.id); // followers + relays
  await O.deliverMove(env, src.id, dst);
  const iObj = await packMe(env, src.id, { includeSecrets: true });
  if (!(iObj instanceof Response)) await publishToUserStream(env, src.id, "main", "meUpdated", iObj);
  // unfollow after 24 hours
  await enqueue(env, { kind: "accountMove", op: "unfollow", srcId: src.id, notBefore: Date.now() + UNFOLLOW_DELAY_MS }, MAX_QUEUE_DELAY_S);
  await postMoveProcess(env, src, dst);
  return iObj;
}

/**
 * ApPersonService.processRemoteMove for a remote user whose movedToUri just changed
 * (called by resolveRemoteUser). `movePreventUris` guards against move loops.
 */
export async function processRemoteMove(env: ApiEnv, srcId: string, movePreventUris: string[] = []): Promise<string> {
  const src = await loadMoveUser(env, srcId);
  if (!src || src.host == null) return "skip: not remote";
  if (!src.movedToUri) return "skip: no movedToUri";
  if (src.uri === src.movedToUri) return "skip: movedTo itself (src)";
  if (movePreventUris.length > 10) return "skip: too many moves";
  let dst = await fetchPerson(env, src.movedToUri);
  if (dst && dst.host == null) {
    // local destination: as stored
  } else if (dst) {
    if (movePreventUris.includes(src.movedToUri)) return "skip: circular move";
    await resolveRemoteUser(env, src.movedToUri, { refresh: true, movePreventUris: [...movePreventUris, src.uri] });
    dst = (await fetchPerson(env, src.movedToUri)) ?? dst;
  } else {
    if (parseLocalUserUri(env, src.movedToUri)) return "failed: movedTo is local but not found";
    const r = await resolveRemoteUser(env, src.movedToUri);
    dst = await loadMoveUser(env, r.id);
    if (!dst) return "failed: movedTo not stored";
  }
  if (dst.movedToUri === dst.uri) return "skip: movedTo itself (dst)";
  if (src.movedToUri !== dst.uri) return "skip: missmatch uri";
  if (dst.movedToUri === src.uri) return "skip: dst.movedToUri === src.uri";
  if (!dst.alsoKnownAs || dst.alsoKnownAs.length === 0) return "skip: dst.alsoKnownAs is empty";
  if (!dst.alsoKnownAs.includes(src.uri)) return "skip: alsoKnownAs does not include from.uri";
  await postMoveProcess(env, src, dst);
  return "ok";
}

// ---------------------------------------------------------------- endpoint

const iMove: Handler = async (env, body, ctx) => {
  if (!ctx.hasCredential) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  const token = extractToken(ctx.request, body);
  const a = token ? await authenticatePg(env, token) : null;
  if (!a) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  if (typeof body.moveToAccount !== "string") return apiErrorResponse(INVALID_PARAM, 400);
  if (!body.moveToAccount) return apiErrorResponse(MOVE_ERRORS.noSuchUser, 400);
  if ((await getRootUserId(env)) === a.user.id) return apiErrorResponse(MOVE_ERRORS.rootForbidden, 400);
  const me = await loadMoveUser(env, a.user.id);
  if (!me) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  if (me.movedToUri) return apiErrorResponse(MOVE_ERRORS.alreadyMoved, 400);

  // RemoteUserResolveService.resolveUser
  const { username, host } = parseAcct(body.moveToAccount);
  const localHost = buildPackConfig(env).host.toLowerCase();
  let dstId: string | null;
  try {
    if (host == null || host.toLowerCase() === localHost) {
      dstId = await withHyperdriveClient(hd(env), async (c) =>
        (await c.query(`SELECT id FROM "user" WHERE "usernameLower" = $1 AND host IS NULL LIMIT 1`, [username.toLowerCase()])).rows[0]?.id as string | undefined ?? null,
      );
    } else {
      dstId = (await resolveRemoteAcct(env, username, host)).id;
    }
  } catch (e) {
    console.warn(`failed to resolve remote user: ${e instanceof Error ? e.message : String(e)}`);
    dstId = null;
  }
  if (!dstId) return apiErrorResponse(MOVE_ERRORS.noSuchUser, 400);
  let dst = await loadMoveUser(env, dstId);
  if (!dst) return apiErrorResponse(MOVE_ERRORS.noSuchUser, 400);
  // apPersonService.updatePerson(newUri) + resolvePerson(newUri)
  if (dst.host != null) {
    try {
      await resolveRemoteUser(env, dst.uri, { refresh: true });
    } catch {
      return apiErrorResponse(INTERNAL_ERROR, 500);
    }
    dst = await fetchPerson(env, dst.uri);
    if (!dst) return apiErrorResponse(INTERNAL_ERROR, 500);
  }
  // the destination must list the old account as an alias. Upstream matches substrings
  // (`knownAs.includes(fromUrl)`); here the alias must be the actor URI itself (host case and a
  // trailing slash aside), as for an incoming Move
  const fromUrl = normalizeActorUri(localActorUri(env, me.id));
  const allowed = (dst.alsoKnownAs ?? []).some((k) => normalizeActorUri(k) === fromUrl);
  if (!allowed || dst.movedToUri) return apiErrorResponse(MOVE_ERRORS.destinationAccountForbids, 400);
  return moveFromLocal(env, me, dst);
};

/** An actor URI for comparison: parsed (host lower-cased), without a trailing slash; null if not a URL. */
function normalizeActorUri(uri: string): string | null {
  try {
    const u = new URL(uri.trim());
    return u.href.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

function pgOnly(h: Handler): Handler {
  return async (env, body, ctx) => {
    if (!env.HYPERDRIVE?.connectionString) {
      return apiErrorResponse({ message: "Hyperdrive required.", code: "HYPERDRIVE_UNBOUND", id: "00000000-0000-4000-8000-0000000000b1", kind: "server" }, 501);
    }
    return h(env, body, ctx);
  };
}

export const accountMoveHandlers: Record<string, Handler> = {
  "i/move": pgOnly(iMove),
};

