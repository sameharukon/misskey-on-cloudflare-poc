/**
 * OnceGuard Durable Object (this worker): "claim this key once within a TTL", the role Redis
 * `SET key value EX ttl NX` plays upstream. One instance per scope (e.g. `totp:{userId}`), so
 * claims are strongly consistent. Expired keys are pruned on each claim.
 *
 * POST /claim { key, ttlSec } → { ok: true } the first time, { ok: false } while it is held.
 */

import type { ApiEnv } from "./env.js";

type OnceGuardState = {
  storage: {
    get<T = unknown>(key: string): Promise<T | undefined>;
    put(key: string, value: unknown): Promise<void>;
  };
};

export class OnceGuard {
  constructor(private readonly state: OnceGuardState) {}

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/put" || path === "/take") return this.values(path, request);
    const b = (await request.json().catch(() => ({}))) as { key?: unknown; ttlSec?: unknown };
    if (typeof b.key !== "string" || typeof b.ttlSec !== "number" || b.ttlSec <= 0) return Response.json({ error: "bad_request" }, { status: 400 });
    const now = Date.now();
    const held = (await this.state.storage.get<Record<string, number>>("keys")) ?? {};
    for (const [k, exp] of Object.entries(held)) if (exp <= now) delete held[k];
    if (held[b.key] != null) return Response.json({ ok: false });
    held[b.key] = now + b.ttlSec * 1000;
    await this.state.storage.put("keys", held);
    return Response.json({ ok: true });
  }

  /**
   * Single-use values with a TTL (upstream Redis `SETEX` + `GETDEL`, e.g. WebAuthn challenges).
   * POST /put { key, value, ttlSec } overwrites; POST /take { key } → { value } once, null after
   * that or once expired.
   */
  private async values(path: string, request: Request): Promise<Response> {
    const b = (await request.json().catch(() => ({}))) as { key?: unknown; value?: unknown; ttlSec?: unknown };
    if (typeof b.key !== "string") return Response.json({ error: "bad_request" }, { status: 400 });
    const now = Date.now();
    const vals = (await this.state.storage.get<Record<string, { v: string; exp: number }>>("vals")) ?? {};
    for (const [k, e] of Object.entries(vals)) if (e.exp <= now) delete vals[k];
    if (path === "/put") {
      if (typeof b.value !== "string" || typeof b.ttlSec !== "number" || b.ttlSec <= 0) return Response.json({ error: "bad_request" }, { status: 400 });
      vals[b.key] = { v: b.value, exp: now + b.ttlSec * 1000 };
      await this.state.storage.put("vals", vals);
      return Response.json({ ok: true });
    }
    const hit = vals[b.key];
    delete vals[b.key];
    await this.state.storage.put("vals", vals);
    return Response.json({ value: hit?.v ?? null });
  }
}

/** Fallback for `putOnce` / `takeOnce` without the ONCE_GUARD binding: this isolate only. */
const localValues = new Map<string, { v: string; exp: number }>();

function valueScope(key: string): string {
  // a fixed set of instances so expired entries are pruned by later calls
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return `vals:${h % 16}`;
}

/** Store `value` under `key` for `ttlSec` (overwriting). */
export async function putOnce(env: ApiEnv, key: string, value: string, ttlSec: number): Promise<void> {
  const ns = env.ONCE_GUARD;
  if (!ns) {
    localValues.set(key, { v: value, exp: Date.now() + ttlSec * 1000 });
    return;
  }
  const res = await ns.get(ns.idFromName(valueScope(key))).fetch("https://once.internal/put", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key, value, ttlSec }),
  });
  if (!res.ok) throw new Error(`OnceGuard put failed: ${res.status}`);
}

/** Read and delete `key` (null when absent or expired). */
export async function takeOnce(env: ApiEnv, key: string): Promise<string | null> {
  const ns = env.ONCE_GUARD;
  if (!ns) {
    const e = localValues.get(key);
    localValues.delete(key);
    return e && e.exp > Date.now() ? e.v : null;
  }
  const res = await ns.get(ns.idFromName(valueScope(key))).fetch("https://once.internal/take", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key }),
  });
  if (!res.ok) return null;
  return ((await res.json()) as { value?: string | null }).value ?? null;
}

/**
 * Claim `key` in `scope`. Without the ONCE_GUARD binding (offline / tests without it) every
 * claim succeeds, i.e. no replay protection.
 */
export async function claimOnce(env: ApiEnv, scope: string, key: string, ttlSec: number): Promise<boolean> {
  const ns = env.ONCE_GUARD;
  if (!ns) return true;
  const res = await ns.get(ns.idFromName(scope)).fetch("https://once.internal/claim", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key, ttlSec }),
  });
  if (!res.ok) return false;
  return Boolean(((await res.json()) as { ok?: boolean }).ok);
}
