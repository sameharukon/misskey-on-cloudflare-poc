import type { ApiEnv } from "./env.js";
import { kvToCacheStore, type CacheStore } from "./cache.js";

/** Prefer test inject, then Workers KV binding. */
export function resolveCacheStore(env: ApiEnv): CacheStore | null {
  if (env.__cacheStore) return env.__cacheStore;
  if (env.META_CACHE && typeof env.META_CACHE.get === "function") {
    const kv = env.META_CACHE;
    if (typeof kv.put === "function") {
      return kvToCacheStore({
        get: (key, type) => kv.get(key, type),
        put: (key, value, opts) => kv.put!(key, value, opts),
        delete: kv.delete ? (key) => kv.delete!(key) : undefined,
      });
    }
    return {
      get: (key) => kv.get(key, "text"),
      put: async () => {},
    };
  }
  return null;
}

/**
 * A computed JSON value kept in the cache store for `ttlSec` (KV's minimum is 60 s). Reads and
 * writes are best-effort: without a store, or when it fails, the value is computed every time.
 */
export async function readThroughJson<T>(env: ApiEnv, key: string, ttlSec: number, compute: () => Promise<T>): Promise<T> {
  const store = resolveCacheStore(env);
  if (store) {
    try {
      const hit = await store.get(key);
      if (hit != null) return JSON.parse(hit) as T;
    } catch {
      /* compute below */
    }
  }
  const value = await compute();
  if (store) await store.put(key, JSON.stringify(value), { expirationTtl: Math.max(60, ttlSec) }).catch(() => {});
  return value;
}
