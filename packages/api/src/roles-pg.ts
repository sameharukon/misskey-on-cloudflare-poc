/**
 * Roles (W7.9) on PG `role` / `role_assignment` (upstream schema):
 * admin/roles/create|update|delete|list|show|assign|unassign|users and roles/list|show|users|notes.
 * Follows upstream RoleService / RoleEntityService: admins create/update/delete, moderators read
 * and edit members (only when `canEditMembersByModerator`, else admins), moderation_log entries,
 * `roleAssigned` notification for public roles. Policies are combined at read time by
 * policies-pg.ts, so changes apply on the next request (no role cache to invalidate).
 *
 * roles/notes: upstream reads Redis `roleTimeline:{id}`; here the TimelineShard `role:{id}` that the
 * fanout consumer fills (role-timeline.ts in misskey-cf-timeline). Without the DO binding it falls
 * back to a PG query over the role's assigned members' public notes.
 */

import { genAidx, genAidxFromDate, parseAidxTime } from "../../id/src/index.js";
import { DEFAULT_POLICIES } from "../../packers/src/index.js";
import type { ApiEnv } from "./env.js";
import { apiErrorResponse, CREDENTIAL_REQUIRED, INTERNAL_ERROR } from "./errors.js";
import { authenticatePg, extractToken } from "./auth-pg.js";
import { withHyperdriveClient, type PgQueryable } from "./pg.js";
import { isAdministratorPg, moderationLogPg } from "./policies-pg.js";
import { listNotes, packUsers, pagination } from "./client-endpoints-pg.js";
import { listTimelineIdsFromDo } from "./notes-pg.js";
import { createNotification } from "./notifications-do.js";
import { adminGate } from "./admin-gate.js";
import { clientError as err, errorResponse as fail, hd, invalidParam as bad } from "./handler-kit.js";

type Ctx = { hasCredential: boolean; request: Request };
type Body = Record<string, unknown>;
export type RoleHandler = (env: ApiEnv, body: Body, ctx: Ctx) => Promise<Response | unknown>;

const noSuchRole = (id: string) => err("NO_SUCH_ROLE", id, "No such role.");
const noSuchUser = (id: string) => err("NO_SUCH_USER", id, "No such user.");
const membersDenied = (id: string) => err("ACCESS_DENIED", id, "Only administrators can edit members of the role.");
const E = {
  update: noSuchRole("cd23ef55-09ad-428a-ac61-95a45e124b32"),
  delete: noSuchRole("de0d6ecd-8e0a-4253-88ff-74bc89ae3d45"),
  show: noSuchRole("07dc7d34-c0d8-49b7-96c6-db3ce64ee0b3"),
  assignNoSuchRole: noSuchRole("6503c040-6af4-4ed9-bf07-f2dd16678eab"),
  assignNoSuchUser: noSuchUser("558ea170-f653-4700-94d0-5a818371d0df"),
  assignDenied: membersDenied("25b5bc31-dc79-4ebd-9bd2-c84978fd052c"),
  unassignNoSuchRole: noSuchRole("6e519036-a70d-4c76-b679-bc8fb18194e2"),
  unassignNoSuchUser: noSuchUser("2b730f78-1179-461b-88ad-d24c9af1a5ce"),
  unassignDenied: membersDenied("24636eee-e8c1-493e-94b2-e16ad401e262"),
  adminUsers: noSuchRole("224eff5e-2488-4b18-b3e7-f50d94421648"),
  publicNotes: noSuchRole("eb70323a-df61-4dd4-ad90-89c83c7cf26e"),
  publicShow: noSuchRole("de5502bf-009a-4639-86c1-fec349e46dcb"),
  publicUsers: noSuchRole("30aaaee3-4792-48dc-ab0d-cf501a575ac5"),
};

const str = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : undefined);
const noContent = () => new Response(null, { status: 204 });
/** `limit: { type: 'integer', minimum: 1, maximum: 100, default: 10 }` (validated by pageParamsOk). */
const limitOf = (body: Body) => (body.limit === undefined ? 10 : (body.limit as number));
/** limit + sinceId / untilId / sinceDate / untilDate as upstream's paramDef. */
function pageParamsOk(body: Body): boolean {
  if (body.limit !== undefined && !(Number.isInteger(body.limit) && (body.limit as number) >= 1 && (body.limit as number) <= 100)) return false;
  for (const k of ["sinceId", "untilId"]) if (body[k] !== undefined && typeof body[k] !== "string") return false;
  for (const k of ["sinceDate", "untilDate"]) if (body[k] !== undefined && !Number.isInteger(body[k])) return false;
  return true;
}
const UNEXPIRED = `(ra."expiresAt" IS NULL OR ra."expiresAt" > now())`;

async function optAuth(env: ApiEnv, body: Body, ctx: Ctx): Promise<string | null | "invalid"> {
  if (!ctx.hasCredential) return null;
  const token = extractToken(ctx.request, body);
  if (!token) return null;
  return (await authenticatePg(env, token))?.user.id ?? "invalid";
}

/** requireModerator / requireAdmin; returns the caller id (null when the admin surface is open in dev). */
async function gate(env: ApiEnv, body: Body, ctx: Ctx, level: "moderator" | "admin"): Promise<{ denied: Response } | { me: string | null }> {
  const denied = await adminGate(ctx.request, env as never, body, level);
  if (denied) return { denied };
  const token = extractToken(ctx.request, body);
  return { me: token ? ((await authenticatePg(env, token))?.user.id ?? null) : null };
}

type RoleRow = Record<string, unknown> & { id: string; name: string; policies: Record<string, unknown> };

const ROLE_COLS = `id, "updatedAt", "lastUsedAt", name, description, color, "iconUrl", target, "condFormula", "isPublic", "asBadge",
  "isModerator", "isAdministrator", "isExplorable", "preserveAssignmentOnMoveAccount", "canEditMembersByModerator", "displayOrder", policies`;

async function getRole(c: PgQueryable, id: string, where = ""): Promise<RoleRow | null> {
  return ((await c.query(`SELECT ${ROLE_COLS} FROM role WHERE id = $1 ${where}`, [id])).rows[0] as RoleRow | undefined) ?? null;
}

/** The role row as upstream logs it. */
function rawRole(r: RoleRow) {
  return { ...r, updatedAt: r.updatedAt ? new Date(String(r.updatedAt)).toISOString() : null, lastUsedAt: r.lastUsedAt ? new Date(String(r.lastUsedAt)).toISOString() : null };
}

/** RoleEntityService.pack (policies filled with defaults, usersCount = unexpired assignments). */
export async function packRoles(c: PgQueryable, roles: RoleRow[]): Promise<Record<string, unknown>[]> {
  if (!roles.length) return [];
  const counts = new Map<string, number>();
  const r = await c.query(
    `SELECT ra."roleId", count(*)::int AS n FROM role_assignment ra WHERE ra."roleId" = ANY($1::varchar[]) AND ${UNEXPIRED} GROUP BY ra."roleId"`,
    [roles.map((x) => x.id)],
  );
  for (const row of r.rows) counts.set(String(row.roleId), Number(row.n));
  return roles.map((role) => {
    const policies: Record<string, unknown> = { ...((role.policies as Record<string, unknown>) ?? {}) };
    for (const [k, v] of Object.entries(DEFAULT_POLICIES)) {
      if (policies[k] == null) policies[k] = { useDefault: true, priority: 0, value: v };
    }
    return {
      id: role.id,
      createdAt: (parseAidxTime(role.id) ?? new Date(0)).toISOString(),
      updatedAt: new Date(String(role.updatedAt)).toISOString(),
      name: role.name,
      description: String(role.description ?? ""),
      color: (role.color as string | null) ?? null,
      iconUrl: (role.iconUrl as string | null) ?? null,
      target: String(role.target ?? "manual"),
      condFormula: role.condFormula ?? {},
      isPublic: Boolean(role.isPublic),
      isAdministrator: Boolean(role.isAdministrator),
      isModerator: Boolean(role.isModerator),
      isExplorable: Boolean(role.isExplorable),
      asBadge: Boolean(role.asBadge),
      preserveAssignmentOnMoveAccount: Boolean(role.preserveAssignmentOnMoveAccount),
      canEditMembersByModerator: Boolean(role.canEditMembersByModerator),
      displayOrder: Number(role.displayOrder ?? 0),
      policies,
      usersCount: counts.get(role.id) ?? 0,
    };
  });
}

// ---------------------------------------------------------------- admin/roles create / update / delete

/** paramDef fields with their checks; `required` = upstream create's required list. */
const FIELDS: Record<string, { col: string; ok: (v: unknown) => boolean; json?: boolean }> = {
  name: { col: "name", ok: (v) => typeof v === "string" },
  description: { col: "description", ok: (v) => typeof v === "string" },
  color: { col: "color", ok: (v) => v === null || typeof v === "string" },
  iconUrl: { col: "iconUrl", ok: (v) => v === null || typeof v === "string" },
  target: { col: "target", ok: (v) => v === "manual" || v === "conditional" },
  condFormula: { col: "condFormula", ok: (v) => !!v && typeof v === "object" && !Array.isArray(v), json: true },
  isPublic: { col: "isPublic", ok: (v) => typeof v === "boolean" },
  isModerator: { col: "isModerator", ok: (v) => typeof v === "boolean" },
  isAdministrator: { col: "isAdministrator", ok: (v) => typeof v === "boolean" },
  isExplorable: { col: "isExplorable", ok: (v) => typeof v === "boolean" },
  asBadge: { col: "asBadge", ok: (v) => typeof v === "boolean" },
  preserveAssignmentOnMoveAccount: { col: "preserveAssignmentOnMoveAccount", ok: (v) => typeof v === "boolean" },
  canEditMembersByModerator: { col: "canEditMembersByModerator", ok: (v) => typeof v === "boolean" },
  displayOrder: { col: "displayOrder", ok: (v) => typeof v === "number" && Number.isFinite(v) },
  policies: { col: "policies", ok: (v) => !!v && typeof v === "object" && !Array.isArray(v), json: true },
};
const CREATE_REQUIRED = ["name", "description", "color", "iconUrl", "target", "condFormula", "isPublic", "isModerator", "isAdministrator", "asBadge", "canEditMembersByModerator", "displayOrder", "policies"];

function validFields(body: Body, required: string[]): boolean {
  for (const [k, f] of Object.entries(FIELDS)) {
    if (body[k] === undefined) {
      if (required.includes(k)) return false;
      continue;
    }
    if (!f.ok(body[k])) return false;
  }
  return true;
}

const rolesCreate: RoleHandler = async (env, body, ctx) => {
  const g = await gate(env, body, ctx, "admin");
  if ("denied" in g) return g.denied;
  if (!validFields(body, CREATE_REQUIRED)) return bad();
  return withHyperdriveClient(hd(env), async (c) => {
    const now = Date.now();
    const id = genAidx(now);
    const cols = ["id", "updatedAt", "lastUsedAt"];
    const vals: unknown[] = [id, new Date(now).toISOString(), new Date(now).toISOString()];
    const casts = ["", "", ""];
    for (const [k, f] of Object.entries(FIELDS)) {
      // isExplorable defaults to false; the others are required, preserveAssignmentOnMoveAccount uses the column default
      if (body[k] === undefined) continue;
      cols.push(f.col);
      vals.push(f.json ? JSON.stringify(body[k]) : body[k]);
      casts.push(f.json ? "::jsonb" : "");
    }
    await c.query(
      `INSERT INTO role (${cols.map((x) => `"${x}"`).join(", ")}) VALUES (${vals.map((_, i) => `$${i + 1}${casts[i]}`).join(", ")})`,
      vals,
    );
    const role = (await getRole(c, id))!;
    if (g.me) await moderationLogPg(c, g.me, "createRole", { roleId: id, role: rawRole(role) }, genAidx(Date.now()));
    return (await packRoles(c, [role]))[0];
  });
};

const rolesUpdate: RoleHandler = async (env, body, ctx) => {
  const g = await gate(env, body, ctx, "admin");
  if ("denied" in g) return g.denied;
  const roleId = str(body.roleId);
  if (!roleId || !validFields(body, [])) return bad();
  return withHyperdriveClient(hd(env), async (c) => {
    const before = await getRole(c, roleId);
    if (!before) return fail(E.update);
    const sets = [`"updatedAt" = now()`];
    const params: unknown[] = [];
    for (const [k, f] of Object.entries(FIELDS)) {
      if (body[k] === undefined) continue;
      params.push(f.json ? JSON.stringify(body[k]) : body[k]);
      sets.push(`"${f.col}" = $${params.length}${f.json ? "::jsonb" : ""}`);
    }
    params.push(roleId);
    await c.query(`UPDATE role SET ${sets.join(", ")} WHERE id = $${params.length}`, params);
    const after = (await getRole(c, roleId))!;
    if (g.me) await moderationLogPg(c, g.me, "updateRole", { roleId, before: rawRole(before), after: rawRole(after) }, genAidx(Date.now()));
    return noContent();
  });
};

const rolesDelete: RoleHandler = async (env, body, ctx) => {
  const g = await gate(env, body, ctx, "admin");
  if ("denied" in g) return g.denied;
  const roleId = str(body.roleId);
  if (!roleId) return bad();
  return withHyperdriveClient(hd(env), async (c) => {
    const role = await getRole(c, roleId);
    if (!role) return fail(E.delete);
    // assignments go with the role (FK ON DELETE CASCADE upstream); explicit for schemas without it
    await c.query(`DELETE FROM role_assignment WHERE "roleId" = $1`, [roleId]);
    await c.query(`DELETE FROM role WHERE id = $1`, [roleId]);
    if (g.me) await moderationLogPg(c, g.me, "deleteRole", { roleId, role: rawRole(role) }, genAidx(Date.now()));
    return noContent();
  });
};

// ---------------------------------------------------------------- admin/roles read

const rolesList: RoleHandler = async (env, body, ctx) => {
  const g = await gate(env, body, ctx, "moderator");
  if ("denied" in g) return g.denied;
  return withHyperdriveClient(hd(env), async (c) =>
    packRoles(c, (await c.query(`SELECT ${ROLE_COLS} FROM role ORDER BY "lastUsedAt" DESC`)).rows as RoleRow[]),
  );
};

const rolesShow: RoleHandler = async (env, body, ctx) => {
  const g = await gate(env, body, ctx, "moderator");
  if ("denied" in g) return g.denied;
  const roleId = str(body.roleId);
  if (!roleId) return bad();
  return withHyperdriveClient(hd(env), async (c) => {
    const role = await getRole(c, roleId);
    if (!role) return fail(E.show);
    return (await packRoles(c, [role]))[0];
  });
};

/** Unexpired assignments of a role, paginated on the assignment id. */
async function roleAssignments(c: PgQueryable, roleId: string, body: Body): Promise<{ id: string; userId: string; expiresAt: unknown }[]> {
  const params: unknown[] = [roleId];
  const pg = pagination(body, params, "ra.id");
  params.push(limitOf(body));
  const r = await c.query(
    `SELECT ra.id, ra."userId", ra."expiresAt" FROM role_assignment ra JOIN "user" u ON u.id = ra."userId"
     WHERE ${[`ra."roleId" = $1`, UNEXPIRED, ...pg.where].join(" AND ")} ORDER BY ra.id ${pg.order} LIMIT $${params.length}`,
    params,
  );
  return r.rows.map((x) => ({ id: String(x.id), userId: String(x.userId), expiresAt: x.expiresAt }));
}

const rolesUsers: RoleHandler = async (env, body, ctx) => {
  const g = await gate(env, body, ctx, "moderator");
  if ("denied" in g) return g.denied;
  const roleId = str(body.roleId);
  if (!roleId || !pageParamsOk(body)) return bad();
  const rows = await withHyperdriveClient(hd(env), async (c) => ((await getRole(c, roleId)) ? roleAssignments(c, roleId, body) : null));
  if (!rows) return fail(E.adminUsers);
  const users = new Map(((await packUsers(env, rows.map((r) => r.userId), g.me, true)) as { id: string }[]).map((u) => [u.id, u]));
  return rows.filter((r) => users.has(r.userId)).map((r) => ({
    id: r.id,
    createdAt: (parseAidxTime(r.id) ?? new Date(0)).toISOString(),
    user: users.get(r.userId),
    expiresAt: r.expiresAt ? new Date(String(r.expiresAt)).toISOString() : null,
  }));
};

// ---------------------------------------------------------------- assign / unassign

async function userRow(c: PgQueryable, id: string): Promise<{ id: string; username: string; host: string | null } | null> {
  const u = (await c.query(`SELECT id, username, host FROM "user" WHERE id = $1`, [id])).rows[0];
  return u ? { id: String(u.id), username: String(u.username), host: (u.host as string | null) ?? null } : null;
}

const rolesAssign: RoleHandler = async (env, body, ctx) => {
  const g = await gate(env, body, ctx, "moderator");
  if ("denied" in g) return g.denied;
  const roleId = str(body.roleId);
  const userId = str(body.userId);
  if (!roleId || !userId || (body.expiresAt != null && typeof body.expiresAt !== "number")) return bad();
  const out = await withHyperdriveClient(hd(env), async (c) => {
    const role = await getRole(c, roleId);
    if (!role) return fail(E.assignNoSuchRole);
    if (!role.canEditMembersByModerator && !(g.me && (await isAdministratorPg(env, c, g.me)))) return fail(E.assignDenied);
    const user = await userRow(c, userId);
    if (!user) return fail(E.assignNoSuchUser);
    const expiresAt = typeof body.expiresAt === "number" && body.expiresAt ? body.expiresAt : null;
    // upstream: an expiry in the past is silently ignored
    if (expiresAt != null && expiresAt <= Date.now()) return noContent();
    const existing = (await c.query(`SELECT id, "expiresAt" FROM role_assignment WHERE "roleId" = $1 AND "userId" = $2`, [roleId, userId])).rows[0];
    if (existing) {
      if (existing.expiresAt && new Date(String(existing.expiresAt)).getTime() < Date.now()) {
        await c.query(`DELETE FROM role_assignment WHERE "roleId" = $1 AND "userId" = $2`, [roleId, userId]);
      } else {
        // upstream throws AlreadyAssignedError, which the endpoint does not map (500)
        return apiErrorResponse(INTERNAL_ERROR, 500);
      }
    }
    await c.query(`INSERT INTO role_assignment (id, "userId", "roleId", "expiresAt") VALUES ($1, $2, $3, $4)`, [
      genAidx(Date.now()), userId, roleId, expiresAt != null ? new Date(expiresAt).toISOString() : null,
    ]);
    await c.query(`UPDATE role SET "lastUsedAt" = now() WHERE id = $1`, [roleId]);
    if (g.me) {
      await moderationLogPg(c, g.me, "assignRole", {
        roleId, roleName: role.name, userId, userUsername: user.username, userHost: user.host,
        expiresAt: expiresAt != null ? new Date(expiresAt).toISOString() : null,
      }, genAidx(Date.now()));
    }
    return { notify: Boolean(role.isPublic) && user.host === null };
  });
  if (out instanceof Response) return out;
  if (out.notify) await createNotification(env, userId, { type: "roleAssigned", notifierId: null, roleId });
  return noContent();
};

const rolesUnassign: RoleHandler = async (env, body, ctx) => {
  const g = await gate(env, body, ctx, "moderator");
  if ("denied" in g) return g.denied;
  const roleId = str(body.roleId);
  const userId = str(body.userId);
  if (!roleId || !userId) return bad();
  return withHyperdriveClient(hd(env), async (c) => {
    const role = await getRole(c, roleId);
    if (!role) return fail(E.unassignNoSuchRole);
    if (!role.canEditMembersByModerator && !(g.me && (await isAdministratorPg(env, c, g.me)))) return fail(E.unassignDenied);
    const user = await userRow(c, userId);
    if (!user) return fail(E.unassignNoSuchUser);
    const existing = (await c.query(`SELECT id, "expiresAt" FROM role_assignment WHERE "roleId" = $1 AND "userId" = $2`, [roleId, userId])).rows[0];
    // RoleService.NotAssignedError is not mapped by the endpoint (its declared NOT_ASSIGNED is unused) → 500
    if (!existing) return apiErrorResponse(INTERNAL_ERROR, 500);
    await c.query(`DELETE FROM role_assignment WHERE "roleId" = $1 AND "userId" = $2`, [roleId, userId]);
    if (existing.expiresAt && new Date(String(existing.expiresAt)).getTime() < Date.now()) return apiErrorResponse(INTERNAL_ERROR, 500);
    await c.query(`UPDATE role SET "lastUsedAt" = now() WHERE id = $1`, [roleId]);
    if (g.me) {
      await moderationLogPg(c, g.me, "unassignRole", { roleId, roleName: role.name, userId, userUsername: user.username, userHost: user.host }, genAidx(Date.now()));
    }
    return noContent();
  });
};

// ---------------------------------------------------------------- roles/* (public)

const publicList: RoleHandler = async (env, body, ctx) => {
  const me = await optAuth(env, body, ctx);
  if (!me || me === "invalid") return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  return withHyperdriveClient(hd(env), async (c) =>
    packRoles(c, (await c.query(`SELECT ${ROLE_COLS} FROM role WHERE "isPublic" = TRUE AND "isExplorable" = TRUE ORDER BY id`)).rows as RoleRow[]),
  );
};

const publicShow: RoleHandler = async (env, body, ctx) => {
  const me = await optAuth(env, body, ctx);
  if (me === "invalid") return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  const roleId = str(body.roleId);
  if (!roleId) return bad();
  return withHyperdriveClient(hd(env), async (c) => {
    const role = await getRole(c, roleId, `AND "isPublic" = TRUE`);
    if (!role) return fail(E.publicShow);
    return (await packRoles(c, [role]))[0];
  });
};

const publicUsers: RoleHandler = async (env, body, ctx) => {
  const me = await optAuth(env, body, ctx);
  if (me === "invalid") return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  const roleId = str(body.roleId);
  if (!roleId || !pageParamsOk(body)) return bad();
  const rows = await withHyperdriveClient(hd(env), async (c) =>
    (await getRole(c, roleId, `AND "isPublic" = TRUE AND "isExplorable" = TRUE`)) ? roleAssignments(c, roleId, body) : null,
  );
  if (!rows) return fail(E.publicUsers);
  const users = new Map(((await packUsers(env, rows.map((r) => r.userId), me, true)) as { id: string }[]).map((u) => [u.id, u]));
  return rows.filter((r) => users.has(r.userId)).map((r) => ({ id: r.id, user: users.get(r.userId) }));
};

const publicNotes: RoleHandler = async (env, body, ctx) => {
  const me = await optAuth(env, body, ctx);
  if (!me || me === "invalid") return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  const roleId = str(body.roleId);
  if (!roleId || !pageParamsOk(body)) return bad();
  const role = await withHyperdriveClient(hd(env), (c) => getRole(c, roleId, `AND "isPublic" = TRUE`));
  if (!role) return fail(E.publicNotes);
  if (!role.isExplorable) return [];
  const dateId = (v: unknown) => (typeof v === "number" ? genAidxFromDate(new Date(v)) : undefined);
  const ids = await listTimelineIdsFromDo(env, `role:${role.id}`, {
    limit: limitOf(body),
    untilId: str(body.untilId) ?? dateId(body.untilDate),
    sinceId: str(body.sinceId) ?? dateId(body.sinceDate),
  });
  if (ids) {
    if (!ids.length) return [];
    return listNotes(
      env,
      me,
      body,
      (params) => {
        params.push(ids);
        return `n.visibility = 'public' AND n.id = ANY($${params.length}::varchar[])`;
      },
      { limit: limitOf(body) },
    );
  }
  return listNotes(
    env,
    me,
    body,
    (params) => {
      params.push(role.id);
      return `n.visibility = 'public' AND n."userId" IN (SELECT ra."userId" FROM role_assignment ra WHERE ra."roleId" = $${params.length} AND ${UNEXPIRED})`;
    },
    { limit: limitOf(body) },
  );
};

// ---------------------------------------------------------------- registry

function pgOnly(h: RoleHandler): RoleHandler {
  return async (env, body, ctx) => {
    if (!env.HYPERDRIVE?.connectionString) {
      return apiErrorResponse({ message: "Hyperdrive required.", code: "HYPERDRIVE_UNBOUND", id: "00000000-0000-4000-8000-0000000000b1", kind: "server" }, 501);
    }
    return h(env, body, ctx);
  };
}

const RAW: Record<string, RoleHandler> = {
  "admin/roles/create": rolesCreate,
  "admin/roles/update": rolesUpdate,
  "admin/roles/delete": rolesDelete,
  "admin/roles/list": rolesList,
  "admin/roles/show": rolesShow,
  "admin/roles/users": rolesUsers,
  "admin/roles/assign": rolesAssign,
  "admin/roles/unassign": rolesUnassign,
  "roles/list": publicList,
  "roles/show": publicShow,
  "roles/users": publicUsers,
  "roles/notes": publicNotes,
};

export const roleHandlers: Record<string, RoleHandler> = Object.fromEntries(Object.entries(RAW).map(([k, h]) => [k, pgOnly(h)]));

