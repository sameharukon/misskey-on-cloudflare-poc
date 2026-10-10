/**
 * Role policies + moderator check on PG, following upstream RoleService:
 * base = DEFAULT_POLICIES ⊕ meta.policies, then the user's roles (manually assigned,
 * non-expired + conditional roles whose condFormula matches, RoleService.getUserRoles)
 * are combined per key with upstream's priority (2 > 1 > 0) and aggregate rules.
 */

import { DEFAULT_POLICIES } from "../../packers/src/index.js";
import type { ApiEnv } from "./env.js";
import { loadMetaSource } from "./meta-source.js";
import { withHyperdriveClient, type PgQueryable } from "./pg.js";
import { getUserRolesPg, getUsersRolesPg, type RoleLite, type RolePolicy } from "./role-cond.js";
import { getRootUserId } from "./users-pg.js";

export { evalCond, getUserRolesPg, getUsersRolesPg, type CondUser } from "./role-cond.js";

type Policies = Record<string, unknown>;

const anyTrue = (vs: unknown[]) => vs.some((v) => v === true);
const max = (vs: unknown[]) => Math.max(...vs.map(Number));

/** Upstream aggregate per policy key; unknown keys fall back to max/any. */
const AGG: Record<string, (vs: unknown[]) => unknown> = {
  uploadableFileTypes: (vs) => {
    const set = new Set<string>();
    for (const v of vs) for (const t of Array.isArray(v) ? v : []) if (typeof t === "string" && t.trim()) set.add(t.trim());
    return [...set];
  },
  chatAvailability: (vs) => (vs.includes("available") ? "available" : vs.includes("readonly") ? "readonly" : "unavailable"),
};

export function combinePolicies(base: Policies, roles: { policies: Record<string, RolePolicy> }[]): Policies {
  if (roles.length === 0) return { ...base };
  const out: Policies = { ...base };
  for (const key of Object.keys(base)) {
    const agg = AGG[key] ?? (typeof base[key] === "boolean" ? anyTrue : typeof base[key] === "number" ? max : (vs: unknown[]) => vs[0]);
    const ps = roles.map((r) => r.policies?.[key] ?? { priority: 0, useDefault: true });
    const pick = (list: RolePolicy[]) => agg(list.map((p) => (p.useDefault !== false ? base[key] : p.value)));
    const p2 = ps.filter((p) => p.priority === 2);
    const p1 = ps.filter((p) => p.priority === 1);
    out[key] = p2.length ? pick(p2) : p1.length ? pick(p1) : pick(ps);
  }
  return out;
}

export async function getUserPoliciesPg(env: ApiEnv, c: PgQueryable, userId: string): Promise<Policies> {
  const meta = await loadMetaSource(env);
  const base = { ...DEFAULT_POLICIES, ...((meta as { policies?: Policies }).policies ?? {}) } as Policies;
  return combinePolicies(base, await getUserRolesPg(c, userId));
}

/** getUserPoliciesPg and getUserRolesPg for several users at once (packing many users). */
export async function getUsersRolesAndPoliciesPg(env: ApiEnv, c: PgQueryable, userIds: string[]): Promise<Map<string, { roles: RoleLite[]; policies: Policies }>> {
  const meta = await loadMetaSource(env);
  const base = { ...DEFAULT_POLICIES, ...((meta as { policies?: Policies }).policies ?? {}) } as Policies;
  const out = new Map<string, { roles: RoleLite[]; policies: Policies }>();
  for (const [id, roles] of await getUsersRolesPg(c, userIds)) out.set(id, { roles, policies: combinePolicies(base, roles) });
  return out;
}

/** RoleService.getUserPolicies(userId | null): the base policies for anonymous callers. */
export async function policiesForPg(env: ApiEnv, userId: string | null): Promise<Policies> {
  if (!userId) {
    const meta = await loadMetaSource(env);
    return { ...DEFAULT_POLICIES, ...((meta as { policies?: Policies }).policies ?? {}) } as Policies;
  }
  return withHyperdriveClient(env.HYPERDRIVE!, (c) => getUserPoliciesPg(env, c, userId));
}

/** root, or any assigned role with isModerator / isAdministrator. */
export async function isModeratorPg(env: ApiEnv, c: PgQueryable, userId: string): Promise<boolean> {
  if ((await getRootUserId(env)) === userId) return true;
  return (await getUserRolesPg(c, userId)).some((r) => r.isModerator || r.isAdministrator);
}

/** root, or any assigned role with isAdministrator (upstream RoleService.isAdministrator). */
export async function isAdministratorPg(env: ApiEnv, c: PgQueryable, userId: string): Promise<boolean> {
  if ((await getRootUserId(env)) === userId) return true;
  return (await getUserRolesPg(c, userId)).some((r) => r.isAdministrator);
}

/** Ids of the user's roles (assigned + matching conditional). */
export async function userRoleIdsPg(c: PgQueryable, userId: string): Promise<string[]> {
  return (await getUserRolesPg(c, userId)).map((r) => r.id);
}

/**
 * ApiCallService `requiredRolePolicy` gate: root, any administrator role, or the
 * policy being truthy for the user.
 */
export async function hasRolePolicyPg(env: ApiEnv, c: PgQueryable, userId: string, policy: string): Promise<boolean> {
  if ((await getRootUserId(env)) === userId) return true;
  const roles = await getUserRolesPg(c, userId);
  if (roles.some((r) => r.isAdministrator)) return true;
  const meta = await loadMetaSource(env);
  const base = { ...DEFAULT_POLICIES, ...((meta as { policies?: Policies }).policies ?? {}) } as Policies;
  return Boolean(combinePolicies(base, roles)[policy]);
}

/** ModerationLogService.log (PG `moderation_log`). Best-effort. */
export async function moderationLogPg(c: PgQueryable, userId: string, type: string, info: Record<string, unknown>, id: string): Promise<void> {
  try {
    await c.query(`INSERT INTO moderation_log (id, "userId", type, info) VALUES ($1, $2, $3, $4::jsonb)`, [id, userId, type, JSON.stringify(info)]);
  } catch (e) {
    console.warn(`moderation_log insert failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}
