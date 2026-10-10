/**
 * RoleService.getUserRoles / evalCond without Worker env dependencies, so the fanout
 * consumer (misskey-cf-timeline) can resolve an author's roles for `roleTimeline` too.
 */

import { parseAidxTime } from "../../id/src/index.js";
import { isolateCached, META_ISOLATE_TTL_MS, requestMemo, type PgQueryable } from "./hyperdrive.js";

export type RolePolicy = { useDefault?: boolean; priority?: number; value?: unknown };

export type RoleLite = {
  id: string;
  name: string;
  color: string | null;
  iconUrl: string | null;
  description: string;
  policies: Record<string, RolePolicy>;
  isModerator: boolean;
  isAdministrator: boolean;
  isPublic: boolean;
  isExplorable: boolean;
  asBadge: boolean;
  displayOrder: number;
};

const ROLE_LITE_COLS = `r.id, r.name, r.color, r."iconUrl", r.description, r.policies, r."isModerator", r."isAdministrator", r."isPublic", r."isExplorable", r."asBadge", r."displayOrder", r."condFormula"`;

function toRoleLite(row: Record<string, unknown>): RoleLite {
  return {
    id: String(row.id),
    name: String(row.name ?? ""),
    color: (row.color as string | null) ?? null,
    iconUrl: (row.iconUrl as string | null) ?? null,
    description: String(row.description ?? ""),
    policies: (row.policies && typeof row.policies === "object" ? row.policies : {}) as Record<string, RolePolicy>,
    isModerator: Boolean(row.isModerator),
    isAdministrator: Boolean(row.isAdministrator),
    isPublic: Boolean(row.isPublic),
    isExplorable: Boolean(row.isExplorable),
    asBadge: Boolean(row.asBadge),
    displayOrder: Number(row.displayOrder ?? 0),
  };
}

async function assignedRoles(c: PgQueryable, userId: string): Promise<RoleLite[]> {
  const r = await c.query(
    `SELECT ${ROLE_LITE_COLS}
     FROM role_assignment ra JOIN role r ON r.id = ra."roleId"
     WHERE ra."userId" = $1 AND (ra."expiresAt" IS NULL OR ra."expiresAt" > now())`,
    [userId],
  );
  return r.rows.map(toRoleLite);
}

/** The user columns RoleService.evalCond reads. */
export type CondUser = {
  id: string;
  host: string | null;
  isSuspended: boolean;
  isLocked: boolean;
  isBot: boolean;
  isCat: boolean;
  isExplorable: boolean;
  followersCount: number;
  followingCount: number;
  notesCount: number;
};

type CondValue = { type?: string; values?: CondValue[]; value?: unknown; roleId?: string; sec?: number };

/** RoleService.evalCond: unknown types and malformed formulas evaluate to false. */
export function evalCond(user: CondUser, assignedRoleIds: string[], value: CondValue, now = Date.now()): boolean {
  try {
    const n = Number(value.value);
    const created = () => (parseAidxTime(user.id) ?? new Date(0)).getTime();
    switch (value.type) {
      // a missing `values` throws → false, as upstream
      case "and": return value.values!.every((v) => evalCond(user, assignedRoleIds, v, now));
      case "or": return value.values!.some((v) => evalCond(user, assignedRoleIds, v, now));
      case "not": return !evalCond(user, assignedRoleIds, value.value as CondValue, now);
      case "roleAssignedTo": return assignedRoleIds.includes(String(value.roleId));
      case "isLocal": return user.host == null;
      case "isRemote": return user.host != null;
      case "isSuspended": return user.isSuspended;
      case "isLocked": return user.isLocked;
      case "isBot": return user.isBot;
      case "isCat": return user.isCat;
      case "isExplorable": return user.isExplorable;
      case "createdLessThan": return created() > now - Number(value.sec) * 1000;
      case "createdMoreThan": return created() < now - Number(value.sec) * 1000;
      case "followersLessThanOrEq": return user.followersCount <= n;
      case "followersMoreThanOrEq": return user.followersCount >= n;
      case "followingLessThanOrEq": return user.followingCount <= n;
      case "followingMoreThanOrEq": return user.followingCount >= n;
      case "notesLessThanOrEq": return user.notesCount <= n;
      case "notesMoreThanOrEq": return user.notesCount >= n;
      default: return false;
    }
  } catch {
    return false;
  }
}

/** RoleService.getUserRoles: assigned (non-expired) roles + conditional roles whose formula matches. */
export async function getUserRolesPg(c: PgQueryable, userId: string): Promise<RoleLite[]> {
  return requestMemo(`roles:${userId}`, () => loadUserRolesPg(c, userId), { clone: true });
}

/**
 * getUserRolesPg for several users in three queries at most (assignments, conditional roles from
 * the isolate cache, the users' columns), instead of two or three per user. Each user's
 * result is memoized for the request as getUserRolesPg would.
 */
export async function getUsersRolesPg(c: PgQueryable, userIds: string[]): Promise<Map<string, RoleLite[]>> {
  const ids = [...new Set(userIds)];
  const out = new Map<string, RoleLite[]>();
  if (!ids.length) return out;
  const assigned = new Map<string, RoleLite[]>(ids.map((id) => [id, []]));
  for (const row of (await c.query(
    `SELECT ra."userId" AS "_userId", ${ROLE_LITE_COLS}
     FROM role_assignment ra JOIN role r ON r.id = ra."roleId"
     WHERE ra."userId" = ANY($1::varchar[]) AND (ra."expiresAt" IS NULL OR ra."expiresAt" > now())`,
    [ids],
  )).rows) assigned.get(String(row._userId))?.push(toRoleLite(row));
  const cond = await conditionalRoles(c);
  const users = new Map<string, CondUser>();
  if (cond.length) {
    for (const u of (await c.query(
      `SELECT id, host, "isSuspended", "isLocked", "isBot", "isCat", "isExplorable", "followersCount", "followingCount", "notesCount" FROM "user" WHERE id = ANY($1::varchar[])`,
      [ids],
    )).rows) users.set(String(u.id), condUser(u));
  }
  for (const id of ids) {
    const mine = assigned.get(id)!;
    const user = users.get(id);
    const roleIds = mine.map((r) => r.id);
    const matched = user ? cond.filter((row) => !roleIds.includes(String(row.id)) && evalCond(user, roleIds, (row.condFormula ?? {}) as CondValue)).map(toRoleLite) : [];
    const roles = [...mine, ...matched];
    out.set(id, roles);
    void requestMemo(`roles:${id}`, async () => structuredClone(roles), { clone: true });
  }
  return out;
}

/** Conditional roles (with their condFormula), cached per isolate and dropped on role writes. */
export function conditionalRoles(c: PgQueryable): Promise<Record<string, unknown>[]> {
  return isolateCached(
    c,
    "role:conditional",
    META_ISOLATE_TTL_MS,
    async () => (await c.query(`SELECT ${ROLE_LITE_COLS} FROM role r WHERE r.target = 'conditional'`)).rows,
  );
}

function condUser(u: Record<string, unknown>): CondUser {
  return {
    id: String(u.id),
    host: (u.host as string | null) ?? null,
    isSuspended: Boolean(u.isSuspended),
    isLocked: Boolean(u.isLocked),
    isBot: Boolean(u.isBot),
    isCat: Boolean(u.isCat),
    isExplorable: Boolean(u.isExplorable),
    followersCount: Number(u.followersCount ?? 0),
    followingCount: Number(u.followingCount ?? 0),
    notesCount: Number(u.notesCount ?? 0),
  };
}

async function loadUserRolesPg(c: PgQueryable, userId: string): Promise<RoleLite[]> {
  const assigned = await assignedRoles(c, userId);
  const cond = await conditionalRoles(c);
  if (!cond.length) return assigned;
  const u = (await c.query(
    `SELECT id, host, "isSuspended", "isLocked", "isBot", "isCat", "isExplorable", "followersCount", "followingCount", "notesCount" FROM "user" WHERE id = $1`,
    [userId],
  )).rows[0];
  if (!u) return assigned;
  const user = condUser(u);
  const ids = assigned.map((r) => r.id);
  const matched = cond.filter((row) => !ids.includes(String(row.id)) && evalCond(user, ids, (row.condFormula ?? {}) as CondValue)).map(toRoleLite);
  return [...assigned, ...matched];
}
