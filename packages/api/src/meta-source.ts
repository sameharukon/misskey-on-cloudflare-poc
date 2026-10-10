import {
  packMetaDetailed,
  packMetaLite,
  type PackConfig,
  type PackMetaSource,
} from "../../packers/src/index.js";
import { serverMaxFileSize } from "./file-size.js";
import type { ApiEnv } from "./env.js";
import {
  CACHE_KEYS,
  DEFAULT_META_TTL_SEC,
  cacheGetJson,
  cachePutJson,
} from "./cache.js";
import { resolveCacheStore } from "./cache-resolve.js";
import { getMetaOverlay, metaFromPg, seedMetaOverlayFromEnv, setMetaOverlay } from "./meta-runtime.js";

/** Instance URL used offline (no Hyperdrive) when INSTANCE_URL is unset. */
const OFFLINE_INSTANCE_URL = "https://misskey.example.com";

type LoadedMeta = { source: PackMetaSource; fresh: boolean };

/**
 * Meta loading order (upstream MetaService.fetch):
 * - Hyperdrive bound: the `meta` row → the last row read in this isolate → error (500).
 * - Offline / BOOTSTRAP_META_JSON (tests): the overlay, i.e. upstream column defaults with
 *   BOOTSTRAP_META_JSON on top, changed in place by admin/update-meta.
 * `fresh` is false when a failed read fell back to the last row (not cached in META_CACHE).
 */
async function loadMeta(env: ApiEnv): Promise<LoadedMeta> {
  const seeded = seedMetaOverlayFromEnv(env);
  if (seeded && env.BOOTSTRAP_META_JSON) {
    try {
      const parsed = JSON.parse(env.BOOTSTRAP_META_JSON) as Record<string, unknown>;
      if (parsed._packed === true) {
        (seeded as PackMetaSource & { __packedOverride?: unknown }).__packedOverride = parsed;
      }
    } catch {
      /* ignore */
    }
  }
  if (metaFromPg(env)) {
    const { loadMetaSourceFromPg } = await import("./meta-pg.js");
    const fromPg = await loadMetaSourceFromPg(env.HYPERDRIVE);
    if (fromPg) {
      setMetaOverlay(env, fromPg);
      return { source: fromPg, fresh: true };
    }
    const last = getMetaOverlay(env);
    if (last) return { source: last, fresh: false };
    throw new Error("meta is unavailable (PostgreSQL read failed)");
  }
  return { source: seeded!, fresh: true };
}

export async function loadMetaSource(env: ApiEnv): Promise<PackMetaSource> {
  return (await loadMeta(env)).source;
}

export function buildPackConfig(env: ApiEnv): PackConfig {
  // deployments must set INSTANCE_URL (every URL the server emits is built from it)
  if (!env.INSTANCE_URL && env.HYPERDRIVE?.connectionString) throw new Error("INSTANCE_URL is not set");
  const url = env.INSTANCE_URL ?? OFFLINE_INSTANCE_URL;
  let host = new URL(OFFLINE_INSTANCE_URL).host;
  try {
    host = new URL(url).host;
  } catch {
    /* keep default */
  }
  return {
    version: env.VERSION ?? "0.0.0-cf",
    url,
    host,
    mediaProxy: env.MEDIA_PROXY ?? `${url.replace(/\/$/, "")}/proxy`,
    // what the server accepts (the client checks uploads against it)
    maxFileSize: serverMaxFileSize(env),
    providesTarball: false,
  };
}

export async function packInstanceMeta(env: ApiEnv, detail: boolean): Promise<unknown> {
  const store = resolveCacheStore(env);
  const cacheKey = detail ? CACHE_KEYS.metaPackedDetailed : CACHE_KEYS.metaPackedLite;
  if (store) {
    const hit = await cacheGetJson(store, cacheKey);
    if (hit) return hit;
  }

  const { source, fresh } = await loadMeta(env);
  const override = (source as PackMetaSource & { __packedOverride?: unknown }).__packedOverride;
  let packed: unknown;
  if (override && typeof override === "object") {
    const { _packed, ...rest } = override as Record<string, unknown>;
    void _packed;
    if (!detail) {
      const {
        features: _f,
        requireSetup: _r,
        proxyAccountName: _p,
        cacheRemoteFiles: _c,
        cacheRemoteSensitiveFiles: _s,
        ...lite
      } = rest;
      packed = lite;
    } else {
      packed = rest;
    }
  } else {
    const config = buildPackConfig(env);
    const { activeAdsPg } = await import("./ads-pg.js");
    const ads = await activeAdsPg(env);
    packed = detail
      ? packMetaDetailed(source, config, { proxyAccountName: "proxy", ads })
      : packMetaLite(source, config, ads);
  }

  // a fallback after a failed read is served but not shared through META_CACHE
  if (store && fresh) {
    await cachePutJson(store, cacheKey, packed, DEFAULT_META_TTL_SEC);
  }
  return packed;
}
