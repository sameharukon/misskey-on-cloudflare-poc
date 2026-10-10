/**
 * Read-through cache for meta / emojis.
 * Works with Workers KV binding or in-memory Map (tests / local).
 */

import { META_PACKED_DETAILED_KEY } from "@misskey-cf/shared";

export interface CacheStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
  delete?(key: string): Promise<void>;
}

/** In-memory fake for unit tests (and when KV unbound). */
export class MemoryCacheStore implements CacheStore {
  private map = new Map<string, { value: string; expiresAt?: number }>();

  async get(key: string): Promise<string | null> {
    const row = this.map.get(key);
    if (!row) return null;
    if (row.expiresAt != null && Date.now() > row.expiresAt) {
      this.map.delete(key);
      return null;
    }
    return row.value;
  }

  async put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void> {
    const expiresAt =
      opts?.expirationTtl != null ? Date.now() + opts.expirationTtl * 1000 : undefined;
    this.map.set(key, { value, expiresAt });
  }

  async delete(key: string): Promise<void> {
    this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }
}

/** Adapt Workers KV namespace (get/put) to CacheStore. */
export function kvToCacheStore(kv: {
  get(key: string, type?: "text"): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
  delete?(key: string): Promise<void>;
}): CacheStore {
  return {
    get: (key) => kv.get(key, "text"),
    put: (key, value, opts) => kv.put(key, value, opts),
    delete: kv.delete ? (key) => kv.delete!(key) : undefined,
  };
}

export const CACHE_KEYS = {
  metaPackedLite: "meta:packed:lite",
  metaPackedDetailed: META_PACKED_DETAILED_KEY,
  emojisSimple: "emojis:simple",
} as const;

export const DEFAULT_META_TTL_SEC = 60;
export const DEFAULT_EMOJI_TTL_SEC = 3600;

export async function cacheGetJson<T>(store: CacheStore, key: string): Promise<T | null> {
  const raw = await store.get(key);
  if (raw == null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/**
 * Best-effort: the value has been computed and is answered anyway. KV refuses a second write to
 * the same key within a second (429), which happens when several isolates miss at once.
 */
export async function cachePutJson(
  store: CacheStore,
  key: string,
  value: unknown,
  ttlSec: number,
): Promise<void> {
  try {
    await store.put(key, JSON.stringify(value), { expirationTtl: ttlSec });
  } catch (e) {
    console.warn(`cache put failed (${key}): ${e instanceof Error ? e.message : String(e)}`);
  }
}
