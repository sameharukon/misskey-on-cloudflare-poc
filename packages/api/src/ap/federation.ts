/**
 * Federation policy from meta (federation / federationHosts / blockedHosts).
 * federation=none → no outbound delivery, inbound rejected, AP GETs 403.
 */

import type { ApiEnv } from "../env.js";
import { withHyperdriveClient } from "../pg.js";
import { metaRowPg } from "../user-lite-pg.js";

export type FederationPolicy = {
  mode: "all" | "specified" | "none";
  hosts: string[];
  blockedHosts: string[];
};

const overrides = new WeakMap<object, FederationPolicy>();
let cache: { p: FederationPolicy; at: number } | null = null;

/** Tests: force a policy for an env object. */
export function setFederationPolicy(env: object, p: FederationPolicy): void {
  overrides.set(env, p);
}

export function resetFederationCache(): void {
  cache = null;
}

export async function getFederationPolicy(env: ApiEnv): Promise<FederationPolicy> {
  const o = overrides.get(env);
  if (o) return o;
  if (!env.HYPERDRIVE?.connectionString) return { mode: "none", hosts: [], blockedHosts: [] };
  if (cache && Date.now() - cache.at < 30_000) return cache.p;
  const { p, read } = await withHyperdriveClient(env.HYPERDRIVE, async (c) => {
    // metaRowPg answers {} on a database error; then read the row directly so the error surfaces
    // (an inbox answers 500 and the sender retries) instead of reading as federation "none"
    let row = await metaRowPg(c);
    if (row.id == null) {
      row = (await c.query(`SELECT federation, "federationHosts", "blockedHosts" FROM meta ORDER BY id DESC LIMIT 1`)).rows[0] ?? {};
    }
    const mode = row.federation === "all" || row.federation === "specified" ? row.federation : "none";
    const arr = (v: unknown) => (Array.isArray(v) ? v.map((x) => String(x).toLowerCase()) : []);
    return { p: { mode, hosts: arr(row.federationHosts), blockedHosts: arr(row.blockedHosts) } as FederationPolicy, read: row.id != null || row.federation != null };
  });
  // no meta row yet (before setup): not kept, so the first setup is seen at once
  if (read) cache = { p, at: Date.now() };
  return p;
}

function hostMatches(list: string[], host: string): boolean {
  const h = host.toLowerCase();
  return list.some((x) => h === x || h.endsWith(`.${x}`));
}

/** UtilityService.isBlockedHost: the host or a parent domain is in blockedHosts. */
export function hostBlocked(p: FederationPolicy, host: string): boolean {
  return hostMatches(p.blockedHosts, host);
}

export function hostAllowed(p: FederationPolicy, host: string | null | undefined): boolean {
  if (!host) return false;
  if (p.mode === "none") return false;
  if (hostMatches(p.blockedHosts, host)) return false;
  if (p.mode === "specified") return hostMatches(p.hosts, host);
  return true;
}

export function hostOf(u: string): string | null {
  try {
    return new URL(u).host.toLowerCase();
  } catch {
    return null;
  }
}
