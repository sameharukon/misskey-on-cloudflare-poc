import { invalidateIsolateCache } from "./pg.js";
import { resetFederationCache } from "./ap/federation.js";
import { resetInstanceActorCache } from "./ap/remote.js";
import type { PackMetaSource } from "../../packers/src/index.js";
import { upstreamMetaDefaults } from "./meta-defaults.js";
import type { ApiEnv } from "./env.js";
import { resolveCacheStore } from "./cache-resolve.js";
import { CACHE_KEYS } from "./cache.js";

type EnvWithOverlay = ApiEnv & { __metaOverlay?: PackMetaSource };

export function getMetaOverlay(env: ApiEnv): PackMetaSource | null {
  return (env as EnvWithOverlay).__metaOverlay ?? null;
}

export function setMetaOverlay(env: ApiEnv, source: PackMetaSource): void {
  (env as EnvWithOverlay).__metaOverlay = source;
}

/** Is the meta read from PostgreSQL (Hyperdrive bound and no BOOTSTRAP_META_JSON)? */
export function metaFromPg(env: ApiEnv): boolean {
  return Boolean(env.HYPERDRIVE?.connectionString) && !env.BOOTSTRAP_META_JSON;
}

/**
 * The overlay: the last meta read from PostgreSQL in this isolate, or (offline / BOOTSTRAP_META_JSON)
 * the upstream defaults with BOOTSTRAP_META_JSON on top. Never seeded when meta comes from
 * PostgreSQL, so a failed read does not serve made-up values (null until the first read).
 */
export function seedMetaOverlayFromEnv(env: ApiEnv): PackMetaSource | null {
  const existing = getMetaOverlay(env);
  if (existing) return existing;
  if (metaFromPg(env)) return null;

  let base = upstreamMetaDefaults();

  if (env.BOOTSTRAP_META_JSON) {
    try {
      const parsed = JSON.parse(env.BOOTSTRAP_META_JSON) as Record<string, unknown>;
      if (parsed._packed !== true) {
        base = { ...base, ...(parsed as Partial<PackMetaSource>) };
        if ("tosUrl" in parsed && !("termsOfServiceUrl" in parsed)) {
          base.termsOfServiceUrl = (parsed.tosUrl as string | null) ?? null;
        }
        if ("objectStorageEnable" in parsed && !("useObjectStorage" in parsed)) {
          base.useObjectStorage = Boolean(parsed.objectStorageEnable);
        }
      }
    } catch {
      /* ignore */
    }
  }

  setMetaOverlay(env, base);
  return base;
}

export async function invalidateMetaCache(env: ApiEnv): Promise<void> {
  // this isolate's cached meta rows, federation policy and signToActivityPubGet (other isolates
  // catch up within META_ISOLATE_TTL_MS / the policy's 30 s / the instance actor's 5 minutes)
  invalidateIsolateCache(null, "meta:");
  resetFederationCache();
  resetInstanceActorCache();
  const store = resolveCacheStore(env);
  if (!store?.delete) return;
  // after the update is committed: a failed delete (e.g. KV's 429 for a key written within the
  // second) must not turn a saved change into an error; the entries expire within their 60 s TTL
  for (const key of [CACHE_KEYS.metaPackedLite, CACHE_KEYS.metaPackedDetailed]) {
    await store.delete(key).catch((e: unknown) => console.warn(`meta cache delete failed: ${e instanceof Error ? e.message : String(e)}`));
  }
}

export const UPDATE_META_KEYS = [
  "name",
  "shortName",
  "description",
  "maintainerName",
  "maintainerEmail",
  "themeColor",
  "disableRegistration",
  "emailRequiredForSignup",
  "serverRules",
  "tosUrl",
  "termsOfServiceUrl",
  "impressumUrl",
  "privacyPolicyUrl",
  "inquiryUrl",
  "mascotImageUrl",
  "bannerUrl",
  "iconUrl",
  "backgroundImageUrl",
  "logoImageUrl",
  "enableServiceWorker",
  "swPublicKey",
  "swPrivateKey",
  "deeplAuthKey",
  "deeplIsPro",
  // mail (src/email.ts); smtp* are stored for compatibility but unused
  "enableEmail",
  "email",
  "smtpSecure",
  "smtpHost",
  "smtpPort",
  "smtpUser",
  "smtpPass",
  "enableActiveEmailValidation",
  "enableVerifymailApi",
  "verifymailAuthKey",
  "enableTruemailApi",
  "truemailInstance",
  "truemailAuthKey",
  "bannedEmailDomains",
  "preservedUsernames",
] as const;

export function applyMetaPatch(source: PackMetaSource, patch: Record<string, unknown>): PackMetaSource {
  const next: PackMetaSource = { ...source };
  for (const key of UPDATE_META_KEYS) {
    if (!(key in patch)) continue;
    let v = patch[key];
    if (key === "deeplAuthKey" && v === "") v = null; // upstream: '' clears the key
    if (key === "tosUrl") {
      next.termsOfServiceUrl = v as string | null;
      continue;
    }
    (next as unknown as Record<string, unknown>)[key] = v;
  }
  return next;
}
