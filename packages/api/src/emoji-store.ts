import type { ApiEnv } from "./env.js";
import {
  CACHE_KEYS,
  DEFAULT_EMOJI_TTL_SEC,
  cacheGetJson,
  cachePutJson,
  type CacheStore,
} from "./cache.js";
import { resolveCacheStore } from "./cache-resolve.js";
import { loadLocalEmojisPg } from "./emojis-pg.js";

/** Local custom emoji row (subset of MiEmoji). */
export interface BootstrapEmoji {
  id: string;
  name: string;
  aliases?: string[];
  category?: string | null;
  host?: string | null;
  originalUrl: string;
  publicUrl?: string;
  license?: string | null;
  isSensitive?: boolean;
  localOnly?: boolean;
  roleIdsThatCanBeUsedThisEmojiAsReaction?: string[];
}

export type PackedEmojiSimple = {
  aliases: string[];
  name: string;
  category: string | null;
  url: string;
  localOnly?: true;
  isSensitive?: true;
  roleIdsThatCanBeUsedThisEmojiAsReaction?: string[];
};

export type PackedEmojiDetailed = {
  id: string;
  aliases: string[];
  name: string;
  category: string | null;
  host: string | null;
  url: string;
  license: string | null;
  isSensitive: boolean;
  localOnly: boolean;
  roleIdsThatCanBeUsedThisEmojiAsReaction: string[];
};

export function packEmojiSimple(e: BootstrapEmoji): PackedEmojiSimple {
  const out: PackedEmojiSimple = {
    aliases: e.aliases ?? [],
    name: e.name,
    category: e.category ?? null,
    url: e.publicUrl || e.originalUrl,
  };
  if (e.localOnly) out.localOnly = true;
  if (e.isSensitive) out.isSensitive = true;
  if (e.roleIdsThatCanBeUsedThisEmojiAsReaction?.length) {
    out.roleIdsThatCanBeUsedThisEmojiAsReaction = e.roleIdsThatCanBeUsedThisEmojiAsReaction;
  }
  return out;
}

export function packEmojiDetailed(e: BootstrapEmoji): PackedEmojiDetailed {
  return {
    id: e.id,
    aliases: e.aliases ?? [],
    name: e.name,
    category: e.category ?? null,
    host: e.host ?? null,
    url: e.publicUrl || e.originalUrl,
    license: e.license ?? null,
    isSensitive: e.isSensitive ?? false,
    localOnly: e.localOnly ?? false,
    roleIdsThatCanBeUsedThisEmojiAsReaction: e.roleIdsThatCanBeUsedThisEmojiAsReaction ?? [],
  };
}

export async function listEmojisSimple(
  env: ApiEnv,
  store?: CacheStore | null,
): Promise<PackedEmojiSimple[]> {
  const cache = store ?? resolveCacheStore(env);
  if (cache) {
    const hit = await cacheGetJson<PackedEmojiSimple[]>(cache, CACHE_KEYS.emojisSimple);
    if (hit) return hit;
  }
  const source = await loadLocalEmojisPg(env);
  const packed = source
    .filter((e) => e.host == null || e.host === "")
    .map(packEmojiSimple);
  if (cache) {
    await cachePutJson(cache, CACHE_KEYS.emojisSimple, packed, DEFAULT_EMOJI_TTL_SEC);
  }
  return packed;
}
