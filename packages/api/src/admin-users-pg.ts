/**
 * User moderation (W7.9) on PG: admin/suspend-user|unsuspend-user|update-user-note|reset-password|
 * show-user|show-users (moderators) and admin/get-user-ips|show-moderation-logs (administrators).
 * Follows upstream: moderation_log entries, moderators / administrators cannot be suspended,
 * only administrators may view or reset an administrator. Upstream's plain `Error('user not
 * found')` cases answer 500 INTERNAL_ERROR as there.
 *
 * Suspension: auth-pg already refuses suspended users' tokens, so their sessions stop at once.
 * UserSuspendService's follow-up runs after the response (waitUntil when available): follow
 * requests from / to the user are deleted, a local user's Delete (Undo(Delete) on unsuspend) goes
 * to every known shared inbox, and every following of the user is removed silently (Undo(Follow)
 * to a remote followee / Reject to a remote follower).
 */

import bcrypt from "bcryptjs";
import { genAidx, parseAidxTime } from "../../id/src/index.js";
import type { ApiEnv } from "./env.js";
import { apiErrorResponse, INTERNAL_ERROR } from "./errors.js";
import { authenticatePg, extractToken } from "./auth-pg.js";
import { withHyperdriveClient, type PgQueryable } from "./pg.js";
import { getUserPoliciesPg, isAdministratorPg, isModeratorPg, moderationLogPg, userRoleIdsPg } from "./policies-pg.js";
import { packUsers, pagination } from "./client-endpoints-pg.js";
import { likeEscape } from "./clips-pg.js";
import { packRoles } from "./roles-pg.js";
import { adminGate } from "./admin-gate.js";
import { clientError as err, errorResponse as fail, hd, invalidParam as bad } from "./handler-kit.js";

type Ctx = { hasCredential: boolean; request: Request; waitUntil?: (p: Promise<unknown>) => void };
type Body = Record<string, unknown>;
export type AdminUserHandler = (env: ApiEnv, body: Body, ctx: Ctx) => Promise<Response | unknown>;

const E = {
  resetNoSuchUser: err("NO_SUCH_USER", "ccafc7fe-5074-4edd-9dc0-8ef9ef6a701d", "No such user."),
  resetDenied: err("ACCESS_DENIED", "cda8f8ce-89a6-4f92-8055-33bbe0c1464d", "Access denied."),
};

const str = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : undefined);
const internal = () => apiErrorResponse(INTERNAL_ERROR, 500);
const noContent = () => new Response(null, { status: 204 });
const iso = (v: unknown) => (v ? new Date(String(v)).toISOString() : null);
/** `limit: { type: 'integer', minimum: 1, maximum: 100, default: 10 }` */
const limitOk = (v: unknown) => v === undefined || (Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 100);

async function gate(env: ApiEnv, body: Body, ctx: Ctx, level: "moderator" | "admin"): Promise<{ denied: Response } | { me: string | null }> {
  const denied = await adminGate(ctx.request, env as never, body, level);
  if (denied) return { denied };
  const token = extractToken(ctx.request, body);
  return { me: token ? ((await authenticatePg(env, token))?.user.id ?? null) : null };
}

type UserRow = { id: string; username: string; host: string | null; isSuspended: boolean };

async function getUser(c: PgQueryable, id: string): Promise<UserRow | null> {
  const r = (await c.query(`SELECT id, username, host, "isSuspended" FROM "user" WHERE id = $1`, [id])).rows[0];
  return r ? { id: String(r.id), username: String(r.username), host: (r.host as string | null) ?? null, isSuspended: Boolean(r.isSuspended) } : null;
}

const who = (u: UserRow) => ({ userId: u.id, userUsername: u.username, userHost: u.host });

/** upstream secureRndstr (default alphabet 0-9a-zA-Z) */
export function secureRndstr(length: number): string {
  const chars = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => chars[Math.min(chars.length - 1, Math.floor((b / 0xff) * chars.length))]).join("");
}

// ---------------------------------------------------------------- suspend / unsuspend / note / password

/** UserSuspendService.postSuspend / postUnsuspend + unFollowAll (suspend only). Best-effort, as upstream. */
export async function suspendFollowUp(env: ApiEnv, user: UserRow, suspend: boolean): Promise<void> {
  const [{ localActorUri, enqueueDeliver }, { localBase }, O, g] = await Promise.all([
    import("./ap/deliver.js"), import("./ap/remote.js"), import("./ap/outbound.js"), import("./graph-pg.js"),
  ]);
  const { inboxes, followees } = await withHyperdriveClient(hd(env), async (c) => {
    if (suspend) {
      await c.query(`DELETE FROM follow_request WHERE "followeeId" = $1`, [user.id]);
      await c.query(`DELETE FROM follow_request WHERE "followerId" = $1`, [user.id]);
    }
    const inboxes = user.host == null
      ? (await c.query(
        `SELECT DISTINCT COALESCE("followerSharedInbox", "followeeSharedInbox") AS inbox FROM following
         WHERE "followerSharedInbox" IS NOT NULL OR "followeeSharedInbox" IS NOT NULL`,
      )).rows.map((r) => r.inbox as string | null).filter((x): x is string => Boolean(x))
      : [];
    const followees = suspend
      ? (await c.query(`SELECT f."followeeId", u.host FROM following f JOIN "user" u ON u.id = f."followeeId" WHERE f."followerId" = $1`, [user.id])).rows
      : [];
    return { inboxes, followees };
  });
  if (inboxes.length) {
    // upstream renderDelete(genLocalUserUri(user.id), user) (wrapped in Undo for unsuspend)
    const actor = localActorUri(env, user.id);
    const del = { type: "Delete", actor, object: `${localBase(env)}/users/${user.id}`, published: new Date().toISOString() };
    const activity = suspend ? del : { type: "Undo", actor, object: del, published: new Date().toISOString() };
    await enqueueDeliver(env, user.id, inboxes, activity).catch(() => undefined);
  }
  // unFollowAll: silent unfollow jobs (UserFollowingService.unfollow)
  for (const f of followees) {
    const followeeId = String(f.followeeId);
    if (!(await g.unfollow(env, user.id, followeeId).catch(() => false))) continue;
    if (user.host == null && f.host != null) await O.deliverUndoFollow(env, user.id, followeeId);
    else if (user.host != null && f.host == null) await O.deliverFollowAnswer(env, "reject", followeeId, user.id, null);
  }
}

function suspendHandler(suspend: boolean): AdminUserHandler {
  return async (env, body, ctx) => {
    const g = await gate(env, body, ctx, "moderator");
    if ("denied" in g) return g.denied;
    const userId = str(body.userId);
    if (!userId) return bad();
    return withHyperdriveClient(hd(env), async (c) => {
      const user = await getUser(c, userId);
      if (!user) return internal();
      // upstream: Error('cannot suspend moderator account')
      if (suspend && (await isModeratorPg(env, c, user.id))) return internal();
      await c.query(`UPDATE "user" SET "isSuspended" = $2 WHERE id = $1`, [user.id, suspend]);
      if (g.me) await moderationLogPg(c, g.me, suspend ? "suspend" : "unsuspend", who(user), genAidx(Date.now()));
      const followUp = suspendFollowUp(env, user, suspend).catch((e) => console.warn(`suspend follow-up failed: ${e instanceof Error ? e.message : String(e)}`));
      if (ctx.waitUntil) ctx.waitUntil(followUp);
      else await followUp;
      return noContent();
    });
  };
}

const updateUserNote: AdminUserHandler = async (env, body, ctx) => {
  const g = await gate(env, body, ctx, "moderator");
  if ("denied" in g) return g.denied;
  const userId = str(body.userId);
  if (!userId || typeof body.text !== "string") return bad();
  return withHyperdriveClient(hd(env), async (c) => {
    const user = await getUser(c, userId);
    if (!user) return internal();
    const before = (await c.query(`SELECT "moderationNote" FROM user_profile WHERE "userId" = $1`, [user.id])).rows[0];
    if (!before) return internal();
    await c.query(`UPDATE user_profile SET "moderationNote" = $2 WHERE "userId" = $1`, [user.id, body.text]);
    if (g.me) {
      await moderationLogPg(c, g.me, "updateUserNote", { ...who(user), before: before.moderationNote ?? "", after: body.text }, genAidx(Date.now()));
    }
    return noContent();
  });
};

const resetPassword: AdminUserHandler = async (env, body, ctx) => {
  const g = await gate(env, body, ctx, "moderator");
  if ("denied" in g) return g.denied;
  const userId = str(body.userId);
  if (!userId) return bad();
  return withHyperdriveClient(hd(env), async (c) => {
    const user = await getUser(c, userId);
    if (!user) return fail(E.resetNoSuchUser);
    if (g.me !== user.id && (await isAdministratorPg(env, c, user.id))) return fail(E.resetDenied);
    const password = secureRndstr(8);
    const hash = await bcrypt.hash(password, await bcrypt.genSalt(8));
    await c.query(`UPDATE user_profile SET password = $2 WHERE "userId" = $1`, [user.id, hash]);
    if (g.me) await moderationLogPg(c, g.me, "resetPassword", who(user), genAidx(Date.now()));
    return { password };
  });
};

// ---------------------------------------------------------------- show-user / show-users

const showUser: AdminUserHandler = async (env, body, ctx) => {
  const g = await gate(env, body, ctx, "moderator");
  if ("denied" in g) return g.denied;
  const userId = str(body.userId);
  if (!userId) return bad();
  return withHyperdriveClient(hd(env), async (c) => {
    const u = (await c.query(`SELECT * FROM "user" WHERE id = $1`, [userId])).rows[0];
    const p = (await c.query(`SELECT * FROM user_profile WHERE "userId" = $1`, [userId])).rows[0];
    if (!u || !p) return internal();
    // upstream: Error('cannot show info of admin') unless the caller is an administrator too
    if ((await isAdministratorPg(env, c, userId)) && !(g.me && (await isAdministratorPg(env, c, g.me)))) return internal();
    const policies = await getUserPoliciesPg(env, c, userId);
    const assigns = (await c.query(
      `SELECT id, "roleId", "expiresAt" FROM role_assignment WHERE "userId" = $1 AND ("expiresAt" IS NULL OR "expiresAt" > now()) ORDER BY id`,
      [userId],
    )).rows;
    // upstream: roles = RoleService.getUserRoles (assigned + matching conditional), roleAssigns = assignments
    const roleIds = await userRoleIdsPg(c, userId);
    const roles = roleIds.length
      ? await packRoles(c, (await c.query(`SELECT * FROM role WHERE id = ANY($1::varchar[])`, [roleIds])).rows as never)
      : [];
    let signins: unknown[] = [];
    try {
      signins = (await c.query(`SELECT id, "userId", ip, headers, success FROM signin WHERE "userId" = $1 ORDER BY id DESC`, [userId])).rows.map((s) => ({
        // the raw MiSignin entity (no createdAt column)
        id: String(s.id), userId: String(s.userId), ip: s.ip, headers: s.headers, success: Boolean(s.success),
      }));
    } catch {
      /* no signin table */
    }
    return {
      email: p.email ?? null,
      emailVerified: Boolean(p.emailVerified),
      followedMessage: p.followedMessage ?? null,
      autoAcceptFollowed: Boolean(p.autoAcceptFollowed),
      noCrawle: Boolean(p.noCrawle),
      preventAiLearning: Boolean(p.preventAiLearning),
      alwaysMarkNsfw: Boolean(p.alwaysMarkNsfw),
      autoSensitive: Boolean(p.autoSensitive),
      carefulBot: Boolean(p.carefulBot),
      injectFeaturedNote: Boolean(p.injectFeaturedNote),
      receiveAnnouncementEmail: Boolean(p.receiveAnnouncementEmail),
      mutedWords: p.mutedWords ?? [],
      mutedInstances: p.mutedInstances ?? [],
      notificationRecieveConfig: p.notificationRecieveConfig ?? {},
      isModerator: await isModeratorPg(env, c, userId),
      isSilenced: !policies.canPublicNote,
      isSuspended: Boolean(u.isSuspended),
      isHibernated: Boolean(u.isHibernated),
      lastActiveDate: iso(u.lastActiveDate),
      moderationNote: p.moderationNote ?? "",
      signins,
      policies,
      roles,
      roleAssigns: assigns.map((a) => ({
        createdAt: (parseAidxTime(String(a.id)) ?? new Date(0)).toISOString(),
        expiresAt: iso(a.expiresAt),
        roleId: String(a.roleId),
      })),
    };
  });
};

const SORTS: Record<string, string> = {
  "+follower": `u."followersCount" DESC`,
  "-follower": `u."followersCount" ASC`,
  "+createdAt": `u.id DESC`,
  "-createdAt": `u.id ASC`,
  "+updatedAt": `u."updatedAt" DESC NULLS LAST`,
  "-updatedAt": `u."updatedAt" ASC NULLS FIRST`,
  "+lastActiveDate": `u."lastActiveDate" DESC NULLS LAST`,
  "-lastActiveDate": `u."lastActiveDate" ASC NULLS FIRST`,
};
const STATES = ["all", "alive", "available", "admin", "moderator", "adminOrModerator", "suspended"];
const ROLE_HOLDERS = (cond: string) =>
  `u.id IN (SELECT ra."userId" FROM role_assignment ra JOIN role r ON r.id = ra."roleId" WHERE (ra."expiresAt" IS NULL OR ra."expiresAt" > now()) AND ${cond})`;

const showUsers: AdminUserHandler = async (env, body, ctx) => {
  const g = await gate(env, body, ctx, "moderator");
  if ("denied" in g) return g.denied;
  if (body.sort !== undefined && !SORTS[body.sort as string]) return bad();
  if (body.state !== undefined && !STATES.includes(body.state as string)) return bad();
  if (body.origin !== undefined && !["combined", "local", "remote"].includes(body.origin as string)) return bad();
  for (const k of ["username", "hostname"]) if (body[k] != null && typeof body[k] !== "string") return bad();
  if (!limitOk(body.limit) || (body.offset !== undefined && !Number.isInteger(body.offset))) return bad();
  const limit = (body.limit as number | undefined) ?? 10;
  const offset = (body.offset as number | undefined) ?? 0;
  // `offset` has no minimum upstream: a negative one reaches PG and fails there
  if (offset < 0) return internal();
  const ids = await withHyperdriveClient(hd(env), async (c) => {
    const w: string[] = [];
    const params: unknown[] = [];
    switch (body.state) {
      case "available": w.push(`u."isSuspended" = FALSE`); break;
      case "alive": w.push(`u."updatedAt" > now() - interval '5 days'`); break;
      case "suspended": w.push(`u."isSuspended" = TRUE`); break;
      // upstream getAdministratorIds / getModeratorIds: holders of such roles (root is not implied)
      case "admin": w.push(ROLE_HOLDERS(`r."isAdministrator"`)); break;
      case "moderator": w.push(ROLE_HOLDERS(`r."isModerator"`), `NOT ${ROLE_HOLDERS(`r."isAdministrator"`)}`); break;
      case "adminOrModerator": w.push(ROLE_HOLDERS(`(r."isModerator" OR r."isAdministrator")`)); break;
    }
    if (body.origin === "local") w.push(`u.host IS NULL`);
    if (body.origin === "remote") w.push(`u.host IS NOT NULL`);
    if (typeof body.username === "string" && body.username) {
      params.push(`${likeEscape(body.username.toLowerCase())}%`);
      w.push(`u."usernameLower" LIKE $${params.length}`);
    }
    if (typeof body.hostname === "string" && body.hostname) {
      params.push(body.hostname.toLowerCase());
      w.push(`u.host = $${params.length}`);
    }
    params.push(limit, offset);
    const r = await c.query(
      `SELECT u.id FROM "user" u ${w.length ? `WHERE ${w.join(" AND ")}` : ""}
       ORDER BY ${SORTS[body.sort as string] ?? "u.id ASC"} LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return r.rows.map((x) => String(x.id));
  });
  return packUsers(env, ids, g.me, true);
};

// ---------------------------------------------------------------- admin-only reads

const getUserIps: AdminUserHandler = async (env, body, ctx) => {
  const g = await gate(env, body, ctx, "admin");
  if ("denied" in g) return g.denied;
  const userId = str(body.userId);
  if (!userId) return bad();
  // rows exist only when IP logging is on (upstream meta.enableIpLogging); nothing records them here yet
  return withHyperdriveClient(hd(env), async (c) =>
    (await c.query(`SELECT ip, "createdAt" FROM user_ip WHERE "userId" = $1 ORDER BY id DESC LIMIT 30`, [userId])).rows.map((x) => ({
      ip: String(x.ip),
      createdAt: new Date(String(x.createdAt)).toISOString(),
    })),
  );
};

const showModerationLogs: AdminUserHandler = async (env, body, ctx) => {
  const g = await gate(env, body, ctx, "admin");
  if ("denied" in g) return g.denied;
  for (const k of ["type", "userId", "search"]) if (body[k] != null && typeof body[k] !== "string") return bad();
  for (const k of ["sinceId", "untilId"]) if (body[k] !== undefined && typeof body[k] !== "string") return bad();
  for (const k of ["sinceDate", "untilDate"]) if (body[k] !== undefined && !Number.isInteger(body[k])) return bad();
  if (!limitOk(body.limit)) return bad();
  const limit = (body.limit as number | undefined) ?? 10;
  const rows = await withHyperdriveClient(hd(env), async (c) => {
    const params: unknown[] = [];
    const pg = pagination(body, params, "l.id");
    const w = [...pg.where];
    if (typeof body.type === "string") {
      params.push(body.type);
      w.push(`l.type = $${params.length}`);
    }
    if (typeof body.userId === "string") {
      params.push(body.userId);
      w.push(`l."userId" = $${params.length}`);
    }
    if (typeof body.search === "string") {
      params.push(`%${likeEscape(body.search)}%`);
      w.push(`l.info::text ILIKE $${params.length}`);
    }
    params.push(limit);
    return (await c.query(
      `SELECT l.id, l."userId", l.type, l.info FROM moderation_log l ${w.length ? `WHERE ${w.join(" AND ")}` : ""}
       ORDER BY l.id ${pg.order} LIMIT $${params.length}`,
      params,
    )).rows;
  });
  const users = new Map(((await packUsers(env, [...new Set(rows.map((r) => String(r.userId)))], null, true)) as { id: string }[]).map((u) => [u.id, u]));
  return rows.map((r) => ({
    id: String(r.id),
    createdAt: (parseAidxTime(String(r.id)) ?? new Date(0)).toISOString(),
    type: String(r.type),
    info: r.info,
    userId: String(r.userId),
    user: users.get(String(r.userId)) ?? null,
  }));
};

// ---------------------------------------------------------------- registry

function pgOnly(h: AdminUserHandler): AdminUserHandler {
  return async (env, body, ctx) => {
    if (!env.HYPERDRIVE?.connectionString) {
      return apiErrorResponse({ message: "Hyperdrive required.", code: "HYPERDRIVE_UNBOUND", id: "00000000-0000-4000-8000-0000000000b1", kind: "server" }, 501);
    }
    return h(env, body, ctx);
  };
}

const RAW: Record<string, AdminUserHandler> = {
  "admin/suspend-user": suspendHandler(true),
  "admin/unsuspend-user": suspendHandler(false),
  "admin/update-user-note": updateUserNote,
  "admin/reset-password": resetPassword,
  "admin/show-user": showUser,
  "admin/show-users": showUsers,
  "admin/get-user-ips": getUserIps,
  "admin/show-moderation-logs": showModerationLogs,
};

export const adminUserHandlers: Record<string, AdminUserHandler> = Object.fromEntries(Object.entries(RAW).map(([k, h]) => [k, pgOnly(h)]));

