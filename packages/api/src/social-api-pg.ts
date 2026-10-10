/**
 * users/show, users/relation, users/followers, users/following, following/*, blocking/*,
 * mute/*, renote-mute/*, i/notifications, notifications/mark-all-as-read on PG, ported from
 * the upstream endpoints (error ids, check order, packed shapes, pagination order).
 * Registered after the older handler tables, so these win.
 */

import { genAidx, genAidxFromDate, parseAidxTime } from "../../id/src/index.js";
import { packUserLite } from "../../packers/src/index.js";
import type { ApiEnv } from "./env.js";
import { apiErrorResponse, CREDENTIAL_REQUIRED, type ApiErrorBody } from "./errors.js";
import { ENDPOINT_META } from "./endpoint-meta.gen.js";
import { authenticatePg, extractToken } from "./auth-pg.js";
import { buildPackConfig } from "./meta-source.js";
import { withHyperdriveClient, type PgQueryable } from "./pg.js";
import { getUsersByIdsPg } from "./notes-pg.js";
import { getRelationsPg, packUserDetailedPg, packUsersDetailedPg } from "./user-detailed-pg.js";
import { isModeratorPg } from "./policies-pg.js";
import { metaRowPg } from "./user-lite-pg.js";
import {
  acceptFollowRequestPg,
  blockPg,
  cancelFollowRequestPg,
  followPg,
  rejectFollowRequestPg,
  unblockPg,
  unfollowPg,
} from "./user-relations-pg.js";
import { listNotifications, markAllNotificationsRead, packNotificationsPg } from "./notifications-do.js";
import { hd } from "./handler-kit.js";

type Body = Record<string, unknown>;
type Ctx = { hasCredential: boolean; request: Request };
type Handler = (env: ApiEnv, body: Body, ctx: Ctx) => Promise<Response | unknown>;

const err = (code: string, id: string, message: string, extra: Partial<ApiErrorBody> = {}): ApiErrorBody => ({ message, code, id, kind: "client", ...extra });
const noSuchUser = (id: string) => err("NO_SUCH_USER", id, "No such user.");
const fail = (e: ApiErrorBody, status = 400) => apiErrorResponse(e, status);

const E = {
  showNoSuchUser: noSuchUser("4362f8dc-731f-4ad8-a694-be5a88922a24"),
  showFailedToResolve: err("FAILED_TO_RESOLVE_REMOTE_USER", "ef7b9be4-9cba-4e6f-ab41-90ed171c7d3c", "Failed to resolve remote user.", { kind: "server" }),
  followersNoSuchUser: noSuchUser("27fa5435-88ab-43de-9360-387de88727cd"),
  followersForbidden: err("FORBIDDEN", "3c6a84db-d619-26af-ca14-06232a21df8a", "Forbidden."),
  followingNoSuchUser: noSuchUser("63e4aba4-4156-4e53-be25-c9559e42d71b"),
  followingForbidden: err("FORBIDDEN", "f6cdb0df-c19f-ec5c-7dbb-0ba84a1f92ba", "Forbidden."),
  birthdayInvalid: err("BIRTHDAY_DATE_FORMAT_INVALID", "a2b007b9-4782-4eba-abd3-93b05ed4130d", "Birthday date format is invalid."),
  createNoSuchUser: noSuchUser("fcd2eef9-a9b2-4c4f-8624-038099e90aa5"),
  createSelf: err("FOLLOWEE_IS_YOURSELF", "26fbe7bb-a331-4857-af17-205b426669a9", "Followee is yourself."),
  alreadyFollowing: err("ALREADY_FOLLOWING", "35387507-38c7-4cb9-9197-300b93783fa0", "You are already following that user."),
  blocking: err("BLOCKING", "4e2206ec-aa4f-4960-b865-6c23ac38e2d9", "You are blocking that user."),
  blocked: err("BLOCKED", "c4ab57cc-4e41-45e9-bfd9-584f61e35ce0", "You are blocked by that user."),
  deleteNoSuchUser: noSuchUser("5b12c78d-2b28-4dca-99d2-f56139b42ff8"),
  deleteSelf: err("FOLLOWEE_IS_YOURSELF", "d9e400b9-36b0-4808-b1d8-79e707f1296c", "Followee is yourself."),
  notFollowing: err("NOT_FOLLOWING", "5dbf82f5-c92b-40b1-87d1-6c8c0741fd09", "You are not following that user."),
  updateNoSuchUser: noSuchUser("14318698-f67e-492a-99da-5353a5ac52be"),
  updateSelf: err("FOLLOWEE_IS_YOURSELF", "4c4cbaf9-962a-463b-8418-a5e365dbf2eb", "Followee is yourself."),
  updateNotFollowing: err("NOT_FOLLOWING", "b8dc75cf-1cb5-46c9-b14b-5f1ffbd782c9", "You are not following that user."),
  invalidateNoSuchUser: noSuchUser("b77e6ae6-a3e5-40da-9cc8-c240115479cc"),
  invalidateSelf: err("FOLLOWER_IS_YOURSELF", "07dc03b9-03da-422d-885b-438313707662", "Follower is yourself."),
  invalidateNotFollowing: err("NOT_FOLLOWING", "918faac3-074f-41ae-9c43-ed5d2946770d", "The other use is not following you."),
  acceptNoSuchUser: noSuchUser("66ce1645-d66c-46bb-8b79-96739af885bd"),
  noFollowRequest: err("NO_FOLLOW_REQUEST", "bcde4f8b-0913-4614-8881-614e522fb041", "No follow request."),
  rejectNoSuchUser: noSuchUser("abc2ffa6-25b2-4380-ba99-321ff3a94555"),
  cancelNoSuchUser: noSuchUser("4e68c551-fc4c-4e46-bb41-7d4a37bf9dab"),
  requestNotFound: err("FOLLOW_REQUEST_NOT_FOUND", "089b125b-d338-482a-9a09-e2622ac9f8d4", "Follow request not found."),
  blockNoSuchUser: noSuchUser("7cc4f851-e2f1-4621-9633-ec9e1d00c01e"),
  blockSelf: err("BLOCKEE_IS_YOURSELF", "88b19138-f28d-42c0-8499-6a31bbd0fdc6", "Blockee is yourself."),
  alreadyBlocking: err("ALREADY_BLOCKING", "787fed64-acb9-464a-82eb-afbd745b9614", "You are already blocking that user."),
  unblockNoSuchUser: noSuchUser("8621d8bf-c358-4303-a066-5ea78610eb3f"),
  unblockSelf: err("BLOCKEE_IS_YOURSELF", "06f6fac6-524b-473c-a354-e97a40ae6eac", "Blockee is yourself."),
  notBlocking: err("NOT_BLOCKING", "291b2efa-60c6-45c0-9f6a-045c8f9b02cd", "You are not blocking that user."),
  muteNoSuchUser: noSuchUser("6fef56f3-e765-4957-88e5-c6f65329b8a5"),
  muteSelf: err("MUTEE_IS_YOURSELF", "a4619cb2-5f23-484b-9301-94c903074e10", "Mutee is yourself."),
  alreadyMuting: err("ALREADY_MUTING", "7e7359cb-160c-4956-b08f-4d1c653cd007", "You are already muting that user."),
  unmuteNoSuchUser: noSuchUser("b851d00b-8ab1-4a56-8b1b-e24187cb48ef"),
  unmuteSelf: err("MUTEE_IS_YOURSELF", "f428b029-6b39-4d48-a1d2-cc1ae6dd5cf9", "Mutee is yourself."),
  notMuting: err("NOT_MUTING", "5467d020-daa9-4553-81e1-135c0c35a96d", "You are not muting that user."),
  rmNoSuchUser: noSuchUser("5e0a5dff-1e94-4202-87ae-4d9c89eb2271"),
  rmSelf: err("MUTEE_IS_YOURSELF", "37285718-52f7-4aef-b7de-c38b8e8a8420", "Mutee is yourself."),
  rmAlready: err("ALREADY_MUTING", "ccfecbe4-1f1c-4fc2-8a3d-c3ffee61cb7b", "You are already muting that user."),
  rmDelNoSuchUser: noSuchUser("9b6728cf-638c-4aa1-bedb-e07d8101474d"),
  rmDelSelf: err("MUTEE_IS_YOURSELF", "619b1314-0850-4597-a242-e245f3da42af", "Mutee is yourself."),
  rmNotMuting: err("NOT_MUTING", "2e4ef874-8bf0-4b4b-b069-4598f6d05817", "You are not muting that user."),
};

/** The authenticated caller (the router's gate already enforced requireCredential). */
async function me(env: ApiEnv, body: Body, ctx: Ctx): Promise<string | null> {
  const token = extractToken(ctx.request, body);
  return token ? ((await authenticatePg(env, token))?.user.id ?? null) : null;
}

/** GetterService.getUser */
async function userExists(c: PgQueryable, id: unknown): Promise<boolean> {
  return (await c.query(`SELECT 1 AS x FROM "user" WHERE id = $1`, [id])).rows.length > 0;
}

/** QueryService.makePaginationQuery over `col` → where / order fragments. */
export function paginationSql(body: Body, params: unknown[], col: string): { where: string[]; order: string } {
  const p = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  const sinceId = typeof body.sinceId === "string" ? body.sinceId : null;
  const untilId = typeof body.untilId === "string" ? body.untilId : null;
  const sinceDate = typeof body.sinceDate === "number" ? body.sinceDate : null;
  const untilDate = typeof body.untilDate === "number" ? body.untilDate : null;
  if (sinceId && untilId) return { where: [`${col} > ${p(sinceId)}`, `${col} < ${p(untilId)}`], order: `${col} DESC` };
  if (sinceId) return { where: [`${col} > ${p(sinceId)}`], order: `${col} ASC` };
  if (untilId) return { where: [`${col} < ${p(untilId)}`], order: `${col} DESC` };
  if (sinceDate && untilDate) return { where: [`${col} > ${p(genAidx(sinceDate))}`, `${col} < ${p(genAidx(untilDate))}`], order: `${col} DESC` };
  if (sinceDate) return { where: [`${col} > ${p(genAidx(sinceDate))}`], order: `${col} ASC` };
  if (untilDate) return { where: [`${col} < ${p(genAidx(untilDate))}`], order: `${col} DESC` };
  return { where: [], order: `${col} DESC` };
}

const iso = (id: string) => (parseAidxTime(id) ?? new Date(0)).toISOString();

async function packLite(env: ApiEnv, ids: string[], meId: string | null) {
  const users = await getUsersByIdsPg(env, ids, meId);
  const config = buildPackConfig(env);
  return new Map([...users].map(([id, u]) => [id, packUserLite(u, config) as unknown as Record<string, unknown>]));
}

async function detailedMap(env: ApiEnv, ids: string[], meId: string | null) {
  const list = await packUsersDetailedPg(env, ids, meId, { schema: "UserDetailedNotMe", many: true });
  return new Map(list.map((u) => [String(u.id), u]));
}

// ---------------------------------------------------------------- users/show

const usersShow: Handler = async (env, body, ctx) => {
  const meId = await me(env, body, ctx);
  const ids = await withHyperdriveClient(hd(env), async (c) => {
    const isModerator = meId ? await isModeratorPg(env, c, meId) : false;
    const meta = await metaRowPg(c);
    return { isModerator, ugc: String(meta.ugcVisibilityForVisitor ?? "all") };
  });
  if (typeof body.username === "string") body.username = body.username.trim();
  if (Array.isArray(body.userIds)) {
    const req = body.userIds as string[];
    if (req.length === 0) return [];
    const found = await withHyperdriveClient(hd(env), async (c) => {
      const where = [`id = ANY($1::varchar[])`];
      if (!ids.isModerator) {
        where.push(`"isSuspended" = FALSE`);
        if (ids.ugc === "local" && meId == null) where.push(`host IS NULL`);
      }
      return new Set((await c.query(`SELECT id FROM "user" WHERE ${where.join(" AND ")}`, [req])).rows.map((r) => String(r.id)));
    });
    const ordered = req.filter((id) => found.has(id));
    const packed = await packUsersDetailedPg(env, ordered, meId, { schema: "UserDetailed", many: true });
    const byId = new Map(packed.map((u) => [String(u.id), u]));
    return ordered.map((id) => byId.get(id)).filter(Boolean);
  }
  let userId: string | null;
  if (typeof body.host === "string" && "username" in body) {
    if (ids.ugc === "local" && meId == null) return fail({ ...E.showNoSuchUser }, 404);
    try {
      const { resolveUserIdByAcct } = await import("./remote-user-resolve.js");
      userId = await resolveUserIdByAcct(env, String(body.username), body.host);
    } catch (e) {
      console.warn(`failed to resolve remote user: ${e instanceof Error ? e.message : String(e)}`);
      return fail(E.showFailedToResolve, 500);
    }
  } else {
    userId = await withHyperdriveClient(hd(env), async (c) => {
      const r = typeof body.userId === "string"
        ? await c.query(`SELECT id FROM "user" WHERE id = $1`, [body.userId])
        : await c.query(`SELECT id FROM "user" WHERE "usernameLower" = $1 AND host IS NULL`, [String(body.username).toLowerCase()]);
      return r.rows[0] ? String(r.rows[0].id) : null;
    });
  }
  const row = userId
    ? await withHyperdriveClient(hd(env), async (c) => (await c.query(`SELECT id, host, "isSuspended" FROM "user" WHERE id = $1`, [userId])).rows[0])
    : null;
  if (!row || (!ids.isModerator && row.isSuspended)) return fail(E.showNoSuchUser, 404);
  if (ids.ugc === "local" && row.host != null && meId == null) return fail(E.showNoSuchUser, 404);
  return packUserDetailedPg(env, String(row.id), meId, { schema: "UserDetailed" });
};

// ---------------------------------------------------------------- users/relation

const usersRelation: Handler = async (env, body, ctx) => {
  const meId = (await me(env, body, ctx))!;
  const ids = Array.isArray(body.userId) ? (body.userId as string[]) : [String(body.userId)];
  const rels = await withHyperdriveClient(hd(env), (c) => getRelationsPg(c, meId, ids));
  return ids.map((id) => rels.get(id) ?? relationFalse(id));
};

function relationFalse(id: string) {
  return { id, following: null, isFollowing: false, isFollowed: false, hasPendingFollowRequestFromYou: false, hasPendingFollowRequestToYou: false, isBlocking: false, isBlocked: false, isMuted: false, isRenoteMuted: false };
}

// ---------------------------------------------------------------- users/followers, users/following

function followList(kind: "followers" | "following"): Handler {
  return async (env, body, ctx) => {
    const meId = await me(env, body, ctx);
    const res = await withHyperdriveClient(hd(env), async (c) => {
      const r = typeof body.userId === "string"
        ? await c.query(`SELECT id FROM "user" WHERE id = $1`, [body.userId])
        : body.host == null
          ? await c.query(`SELECT id FROM "user" WHERE "usernameLower" = $1 AND host IS NULL`, [String(body.username).toLowerCase()])
          : await c.query(`SELECT id FROM "user" WHERE "usernameLower" = $1 AND host = $2`, [String(body.username).toLowerCase(), String(body.host).toLowerCase()]);
      if (!r.rows[0]) return kind === "followers" ? E.followersNoSuchUser : E.followingNoSuchUser;
      const userId = String(r.rows[0].id);
      const prof = ((await c.query(`SELECT to_jsonb(p) AS p FROM user_profile p WHERE "userId" = $1`, [userId])).rows[0]?.p ?? {}) as Record<string, unknown>;
      const vis = String((kind === "followers" ? prof.followersVisibility : prof.followingVisibility) ?? "public");
      const forbidden = kind === "followers" ? E.followersForbidden : E.followingForbidden;
      if (vis !== "public" && !(meId && (await isModeratorPg(env, c, meId)))) {
        if (vis === "private") {
          if (meId == null || meId !== userId) return forbidden;
        } else if (vis === "followers") {
          if (meId == null) return forbidden;
          if (meId !== userId) {
            const ok = (await c.query(`SELECT 1 AS x FROM following WHERE "followeeId" = $1 AND "followerId" = $2 LIMIT 1`, [userId, meId])).rows.length > 0;
            if (!ok) return forbidden;
          }
        }
      }
      const params: unknown[] = [userId];
      const pg = paginationSql(body, params, "f.id");
      const where = [kind === "followers" ? `f."followeeId" = $1` : `f."followerId" = $1`, ...pg.where];
      let join = kind === "followers" ? `JOIN "user" u ON u.id = f."followerId"` : `JOIN "user" u ON u.id = f."followeeId"`;
      if (kind === "following" && typeof body.birthday === "string") {
        // @deprecated birthday filter (still read upstream although not in paramDef)
        const parts = body.birthday.split("-");
        parts.shift();
        const md = parseInt(parts.join(""));
        if (Number.isNaN(md)) return E.birthdayInvalid;
        join += ` JOIN user_profile fp ON fp."userId" = f."followeeId"`;
        params.push(md);
        where.push(`get_birthday_date(fp.birthday) BETWEEN $${params.length} AND $${params.length}`);
      }
      params.push(typeof body.limit === "number" ? body.limit : 10);
      return (await c.query(
        `SELECT f.id, f."followeeId", f."followerId" FROM following f ${join} WHERE ${where.join(" AND ")} ORDER BY ${pg.order} LIMIT $${params.length}`,
        params,
      )).rows.map((x) => ({ id: String(x.id), followeeId: String(x.followeeId), followerId: String(x.followerId) }));
    });
    if (!Array.isArray(res)) return fail(res);
    const users = await detailedMap(env, res.map((f) => (kind === "followers" ? f.followerId : f.followeeId)), meId);
    return res.map((f) => ({
      id: f.id,
      createdAt: iso(f.id),
      followeeId: f.followeeId,
      followerId: f.followerId,
      ...(kind === "following" ? { followee: users.get(f.followeeId) } : { follower: users.get(f.followerId) }),
    }));
  };
}

// ---------------------------------------------------------------- following/*

const followingCreate: Handler = async (env, body, ctx) => {
  const meId = (await me(env, body, ctx))!;
  if (meId === body.userId) return fail(E.createSelf);
  if (!(await withHyperdriveClient(hd(env), (c) => userExists(c, body.userId)))) return fail(E.createNoSuchUser);
  const r = await followPg(env, meId, String(body.userId), { withReplies: typeof body.withReplies === "boolean" ? body.withReplies : undefined });
  if (r === "already_following") return fail(E.alreadyFollowing);
  if (r === "blocking") return fail(E.blocking);
  if (r === "blocked") return fail(E.blocked);
  return (await packLite(env, [String(body.userId)], meId)).get(String(body.userId));
};

const followingDelete: Handler = async (env, body, ctx) => {
  const meId = (await me(env, body, ctx))!;
  if (meId === body.userId) return fail(E.deleteSelf);
  const ok = await withHyperdriveClient(hd(env), async (c) => {
    if (!(await userExists(c, body.userId))) return E.deleteNoSuchUser;
    if (!(await c.query(`SELECT 1 AS x FROM following WHERE "followerId" = $1 AND "followeeId" = $2`, [meId, body.userId])).rows.length) return E.notFollowing;
    return null;
  });
  if (ok) return fail(ok);
  await unfollowPg(env, meId, String(body.userId));
  return (await packLite(env, [String(body.userId)], meId)).get(String(body.userId));
};

const followingUpdate: Handler = async (env, body, ctx) => {
  const meId = (await me(env, body, ctx))!;
  if (meId === body.userId) return fail(E.updateSelf);
  const r = await withHyperdriveClient(hd(env), async (c) => {
    if (!(await userExists(c, body.userId))) return E.updateNoSuchUser;
    const f = (await c.query(`SELECT id FROM following WHERE "followerId" = $1 AND "followeeId" = $2`, [meId, body.userId])).rows[0];
    if (!f) return E.updateNotFollowing;
    const sets: string[] = [];
    const params: unknown[] = [f.id];
    if (body.notify != null) {
      params.push(body.notify === "none" ? null : body.notify);
      sets.push(`notify = $${params.length}`);
    }
    if (body.withReplies != null) {
      params.push(body.withReplies);
      sets.push(`"withReplies" = $${params.length}`);
    }
    if (sets.length) await c.query(`UPDATE following SET ${sets.join(", ")} WHERE id = $1`, params);
    return null;
  });
  if (r) return fail(r);
  return (await packLite(env, [meId], meId)).get(meId);
};

const followingUpdateAll: Handler = async (env, body, ctx) => {
  const meId = (await me(env, body, ctx))!;
  await withHyperdriveClient(hd(env), async (c) => {
    const sets: string[] = [];
    const params: unknown[] = [meId];
    if (body.notify != null) {
      params.push(body.notify === "none" ? null : body.notify);
      sets.push(`notify = $${params.length}`);
    }
    if (body.withReplies != null) {
      params.push(body.withReplies);
      sets.push(`"withReplies" = $${params.length}`);
    }
    if (sets.length) await c.query(`UPDATE following SET ${sets.join(", ")} WHERE "followerId" = $1`, params);
  });
  return null;
};

const followingInvalidate: Handler = async (env, body, ctx) => {
  const meId = (await me(env, body, ctx))!;
  if (meId === body.userId) return fail(E.invalidateSelf);
  const r = await withHyperdriveClient(hd(env), async (c) => {
    if (!(await userExists(c, body.userId))) return E.invalidateNoSuchUser;
    if (!(await c.query(`SELECT 1 AS x FROM following WHERE "followerId" = $1 AND "followeeId" = $2`, [body.userId, meId])).rows.length) return E.invalidateNotFollowing;
    return null;
  });
  if (r) return fail(r);
  await unfollowPg(env, String(body.userId), meId);
  return (await packLite(env, [String(body.userId)], meId)).get(String(body.userId));
};

const followingList: Handler = async (env, body, ctx) => {
  const meId = (await me(env, body, ctx))!;
  const rows = await withHyperdriveClient(hd(env), async (c) => {
    const params: unknown[] = [meId];
    const pg = paginationSql(body, params, "f.id");
    const where = [`f."followerId" = $1`, ...pg.where];
    if (body.notification === true) where.push(`f.notify IS NOT NULL`);
    params.push(typeof body.limit === "number" ? body.limit : 10);
    return (await c.query(
      `SELECT f.id, f."followeeId", f."followerId" FROM following f JOIN "user" u ON u.id = f."followeeId"
       WHERE ${where.join(" AND ")} ORDER BY ${pg.order} LIMIT $${params.length}`,
      params,
    )).rows;
  });
  const users = await detailedMap(env, rows.map((r) => String(r.followeeId)), meId);
  return rows.map((r) => ({ id: String(r.id), createdAt: iso(String(r.id)), followeeId: String(r.followeeId), followerId: String(r.followerId), followee: users.get(String(r.followeeId)) }));
};

function requestList(kind: "incoming" | "outgoing"): Handler {
  return async (env, body, ctx) => {
    const meId = (await me(env, body, ctx))!;
    const rows = await withHyperdriveClient(hd(env), async (c) => {
      const params: unknown[] = [meId];
      const pg = paginationSql(body, params, "id");
      const where = [kind === "incoming" ? `"followeeId" = $1` : `"followerId" = $1`, ...pg.where];
      params.push(typeof body.limit === "number" ? body.limit : 10);
      return (await c.query(`SELECT id, "followerId", "followeeId" FROM follow_request WHERE ${where.join(" AND ")} ORDER BY ${pg.order} LIMIT $${params.length}`, params)).rows;
    });
    const users = await packLite(env, rows.flatMap((r) => [String(r.followerId), String(r.followeeId)]), meId);
    return rows.map((r) => ({ id: String(r.id), follower: users.get(String(r.followerId)), followee: users.get(String(r.followeeId)) }));
  };
}

const requestsAccept: Handler = async (env, body, ctx) => {
  const meId = (await me(env, body, ctx))!;
  if (!(await withHyperdriveClient(hd(env), (c) => userExists(c, body.userId)))) return fail(E.acceptNoSuchUser);
  if (!(await acceptFollowRequestPg(env, meId, String(body.userId)))) return fail(E.noFollowRequest);
  return null;
};

const requestsReject: Handler = async (env, body, ctx) => {
  const meId = (await me(env, body, ctx))!;
  if (!(await withHyperdriveClient(hd(env), (c) => userExists(c, body.userId)))) return fail(E.rejectNoSuchUser);
  await rejectFollowRequestPg(env, meId, String(body.userId));
  return null;
};

const requestsCancel: Handler = async (env, body, ctx) => {
  const meId = (await me(env, body, ctx))!;
  if (!(await withHyperdriveClient(hd(env), (c) => userExists(c, body.userId)))) return fail(E.cancelNoSuchUser);
  if (!(await cancelFollowRequestPg(env, String(body.userId), meId))) return fail(E.requestNotFound);
  return (await packLite(env, [String(body.userId)], meId)).get(String(body.userId));
};

// ---------------------------------------------------------------- blocking/*

const blockingCreate: Handler = async (env, body, ctx) => {
  const meId = (await me(env, body, ctx))!;
  if (meId === body.userId) return fail(E.blockSelf);
  const r = await withHyperdriveClient(hd(env), async (c) => {
    if (!(await userExists(c, body.userId))) return E.blockNoSuchUser;
    if ((await c.query(`SELECT 1 AS x FROM blocking WHERE "blockerId" = $1 AND "blockeeId" = $2`, [meId, body.userId])).rows.length) return E.alreadyBlocking;
    return null;
  });
  if (r) return fail(r);
  await blockPg(env, meId, String(body.userId));
  return packUserDetailedPg(env, String(body.userId), meId, { schema: "UserDetailedNotMe" });
};

const blockingDelete: Handler = async (env, body, ctx) => {
  const meId = (await me(env, body, ctx))!;
  if (meId === body.userId) return fail(E.unblockSelf);
  const r = await withHyperdriveClient(hd(env), async (c) => {
    if (!(await userExists(c, body.userId))) return E.unblockNoSuchUser;
    if (!(await c.query(`SELECT 1 AS x FROM blocking WHERE "blockerId" = $1 AND "blockeeId" = $2`, [meId, body.userId])).rows.length) return E.notBlocking;
    return null;
  });
  if (r) return fail(r);
  await unblockPg(env, meId, String(body.userId));
  return packUserDetailedPg(env, String(body.userId), meId, { schema: "UserDetailedNotMe" });
};

function simpleList(table: "blocking" | "muting" | "renote_muting", owner: string, target: string, key: string): Handler {
  return async (env, body, ctx) => {
    const meId = (await me(env, body, ctx))!;
    const rows = await withHyperdriveClient(hd(env), async (c) => {
      const params: unknown[] = [meId];
      const pg = paginationSql(body, params, "id");
      params.push(typeof body.limit === "number" ? body.limit : 30);
      return (await c.query(`SELECT * FROM ${table} WHERE "${owner}" = $1${pg.where.map((w) => ` AND ${w}`).join("")} ORDER BY ${pg.order} LIMIT $${params.length}`, params)).rows;
    });
    const users = await detailedMap(env, rows.map((r) => String(r[target])), meId);
    return rows.map((r) => {
      const id = String(r.id);
      const out: Record<string, unknown> = { id, createdAt: iso(id) };
      if (table === "muting") out.expiresAt = r.expiresAt ? new Date(String(r.expiresAt)).toISOString() : null;
      out[target] = String(r[target]);
      out[key] = users.get(String(r[target]));
      return out;
    });
  };
}

// ---------------------------------------------------------------- mute/*

const muteCreate: Handler = async (env, body, ctx) => {
  const meId = (await me(env, body, ctx))!;
  if (meId === body.userId) return fail(E.muteSelf);
  return withHyperdriveClient(hd(env), async (c) => {
    if (!(await userExists(c, body.userId))) return fail(E.muteNoSuchUser);
    if ((await c.query(`SELECT 1 AS x FROM muting WHERE "muterId" = $1 AND "muteeId" = $2`, [meId, body.userId])).rows.length) return fail(E.alreadyMuting);
    const expiresAt = typeof body.expiresAt === "number" ? body.expiresAt : null;
    if (expiresAt && expiresAt <= Date.now()) return null;
    await c.query(`INSERT INTO muting (id, "expiresAt", "muterId", "muteeId") VALUES ($1, $2, $3, $4)`, [genAidxFromDate(new Date()), expiresAt ? new Date(expiresAt) : null, meId, body.userId]);
    return null;
  });
};

const muteDelete: Handler = async (env, body, ctx) => {
  const meId = (await me(env, body, ctx))!;
  if (meId === body.userId) return fail(E.unmuteSelf);
  return withHyperdriveClient(hd(env), async (c) => {
    if (!(await userExists(c, body.userId))) return fail(E.unmuteNoSuchUser);
    const r = await c.query(`DELETE FROM muting WHERE "muterId" = $1 AND "muteeId" = $2 RETURNING id`, [meId, body.userId]);
    if (!r.rows.length) return fail(E.notMuting);
    return null;
  });
};

const renoteMuteCreate: Handler = async (env, body, ctx) => {
  const meId = (await me(env, body, ctx))!;
  if (meId === body.userId) return fail(E.rmSelf);
  return withHyperdriveClient(hd(env), async (c) => {
    if (!(await userExists(c, body.userId))) return fail(E.rmNoSuchUser);
    if ((await c.query(`SELECT 1 AS x FROM renote_muting WHERE "muterId" = $1 AND "muteeId" = $2`, [meId, body.userId])).rows.length) return fail(E.rmAlready);
    await c.query(`INSERT INTO renote_muting (id, "muterId", "muteeId") VALUES ($1, $2, $3)`, [genAidxFromDate(new Date()), meId, body.userId]);
    return null;
  });
};

const renoteMuteDelete: Handler = async (env, body, ctx) => {
  const meId = (await me(env, body, ctx))!;
  if (meId === body.userId) return fail(E.rmDelSelf);
  return withHyperdriveClient(hd(env), async (c) => {
    if (!(await userExists(c, body.userId))) return fail(E.rmDelNoSuchUser);
    const r = await c.query(`DELETE FROM renote_muting WHERE "muterId" = $1 AND "muteeId" = $2 RETURNING id`, [meId, body.userId]);
    if (!r.rows.length) return fail(E.rmNotMuting);
    return null;
  });
};

// ---------------------------------------------------------------- notifications

export const NOTIFICATION_TYPES = ["note", "follow", "mention", "reply", "renote", "quote", "reaction", "pollEnded", "scheduledNotePosted", "scheduledNotePostFailed", "receiveFollowRequest", "followRequestAccepted", "roleAssigned", "chatRoomInvitationReceived", "achievementEarned", "exportCompleted", "login", "createToken", "test", "app"];
export const OBSOLETE_NOTIFICATION_TYPES = ["pollVote", "groupInvited"];

const iNotifications: Handler = async (env, body, ctx) => {
  const meId = (await me(env, body, ctx))!;
  const { untilId, sinceId } = {
    untilId: typeof body.untilId === "string" ? body.untilId : body.untilDate ? genAidx(Number(body.untilDate)) : undefined,
    sinceId: typeof body.sinceId === "string" ? body.sinceId : body.sinceDate ? genAidx(Number(body.sinceDate)) : undefined,
  };
  const includeTypes = Array.isArray(body.includeTypes) ? (body.includeTypes as string[]) : undefined;
  const excludeTypes = Array.isArray(body.excludeTypes) ? (body.excludeTypes as string[]) : undefined;
  if (includeTypes && includeTypes.length === 0) return [];
  if (NOTIFICATION_TYPES.every((t) => excludeTypes?.includes(t))) return [];
  const items = await listNotifications(env, meId, {
    limit: typeof body.limit === "number" ? body.limit : 10,
    untilId,
    sinceId,
    includeTypes: includeTypes?.filter((t) => !OBSOLETE_NOTIFICATION_TYPES.includes(t)),
    excludeTypes: excludeTypes?.filter((t) => !OBSOLETE_NOTIFICATION_TYPES.includes(t)),
  });
  if (body.markAsRead !== false) await markAllNotificationsRead(env, meId);
  return packNotificationsPg(env, items, buildPackConfig(env), meId);
};

const notificationsMarkAllAsRead: Handler = async (env, body, ctx) => {
  const meId = (await me(env, body, ctx))!;
  await markAllNotificationsRead(env, meId, true);
  return null;
};

function pgOnly(h: Handler): Handler {
  return async (env, body, ctx) => {
    if (!env.HYPERDRIVE?.connectionString) {
      return apiErrorResponse({ message: "Hyperdrive required.", code: "HYPERDRIVE_UNBOUND", id: "00000000-0000-4000-8000-0000000000b1", kind: "server" }, 501);
    }
    return h(env, body, ctx);
  };
}

const RAW: Record<string, Handler> = {
  "users/show": usersShow,
  "users/relation": usersRelation,
  "users/followers": followList("followers"),
  "users/following": followList("following"),
  "following/create": followingCreate,
  "following/delete": followingDelete,
  "following/update": followingUpdate,
  "following/update-all": followingUpdateAll,
  "following/invalidate": followingInvalidate,
  "following/list": followingList,
  "following/requests/list": requestList("incoming"),
  "following/requests/sent": requestList("outgoing"),
  "following/requests/accept": requestsAccept,
  "following/requests/reject": requestsReject,
  "following/requests/cancel": requestsCancel,
  "blocking/create": blockingCreate,
  "blocking/delete": blockingDelete,
  "blocking/list": simpleList("blocking", "blockerId", "blockeeId", "blockee"),
  "mute/create": muteCreate,
  "mute/delete": muteDelete,
  "mute/list": simpleList("muting", "muterId", "muteeId", "mutee"),
  "renote-mute/create": renoteMuteCreate,
  "renote-mute/delete": renoteMuteDelete,
  "renote-mute/list": simpleList("renote_muting", "muterId", "muteeId", "mutee"),
  "i/notifications": iNotifications,
  "notifications/mark-all-as-read": notificationsMarkAllAsRead,
};

/**
 * ApiCallService's credential check at the handler too (the router's call gate does it for
 * HTTP calls; this keeps direct handler calls — tests, internal callers — equivalent).
 */
export function withCredentialGuard(name: string, h: Handler): Handler {
  const m = ENDPOINT_META[name];
  if (!(m?.requireCredential || m?.requireModerator || m?.requireAdmin)) return h;
  return async (env, body, ctx) => {
    if (!extractToken(ctx.request, body)) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
    return h(env, body, ctx);
  };
}

/** PG handlers with the credential guard (501 without Hyperdrive). */
export function pgOverrides(table: Record<string, Handler>): Record<string, Handler> {
  return Object.fromEntries(Object.entries(table).map(([k, h]) => [k, pgOnly(withCredentialGuard(k, h))]));
}

export const socialApiHandlers: Record<string, Handler> = pgOverrides(RAW);
