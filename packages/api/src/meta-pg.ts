/**
 * Read / seed Misskey `meta` singleton via Hyperdrive.
 * Column defaults come from upstream schema; we only set sensible overrides.
 */

import type { PackMetaSource } from "../../packers/src/index.js";
import type { HyperdriveBinding } from "./db-smoke.js";
import { upstreamMetaDefaults } from "./meta-defaults.js";
import { isolateCached, META_ISOLATE_TTL_MS, withHyperdriveClient, type PgQueryable } from "./pg.js";
import { FORK_REPOSITORY_URL } from "./meta-defaults.js";

export const META_SINGLETON_ID = "x";

/** Sensible staging defaults (upstream MetaService upserts id='x' only). */
export const DEFAULT_META_SEED = {
  id: META_SINGLETON_ID,
  name: "misskey-cf",
  shortName: "mk-cf",
  description: "Misskey on Cloudflare Workers (staging)",
  maintainerName: "misskey-cf",
  maintainerEmail: null as string | null,
  repositoryUrl: FORK_REPOSITORY_URL,
  feedbackUrl: `${FORK_REPOSITORY_URL}/issues`,
  /** Keep closed until root exists / federation is intentional. */
  federation: "none" as const,
  disableRegistration: true,
};

export type MetaSeedResult = {
  ok: boolean;
  inserted: boolean;
  alreadyPresent: boolean;
  id?: string;
  name?: string | null;
  rootUserId?: string | null;
  error?: string;
};

function mapRowToPackMeta(row: Record<string, unknown>): PackMetaSource {
  // NULL columns read as upstream returns them (meta-defaults.ts)
  const base = upstreamMetaDefaults();
  const federation = row.federation;
  const fed =
    federation === "all" || federation === "specified" || federation === "none"
      ? federation
      : base.federation;

  return {
    ...base,
    maintainerName: (row.maintainerName as string | null) ?? null,
    maintainerEmail: (row.maintainerEmail as string | null) ?? null,
    name: (row.name as string | null) ?? null,
    shortName: (row.shortName as string | null) ?? null,
    description: (row.description as string | null) ?? null,
    langs: Array.isArray(row.langs) ? (row.langs as string[]) : base.langs,
    termsOfServiceUrl: (row.termsOfServiceUrl as string | null) ?? null,
    repositoryUrl: (row.repositoryUrl as string | null) ?? base.repositoryUrl,
    feedbackUrl: (row.feedbackUrl as string | null) ?? null,
    impressumUrl: (row.impressumUrl as string | null) ?? null,
    privacyPolicyUrl: (row.privacyPolicyUrl as string | null) ?? null,
    inquiryUrl: (row.inquiryUrl as string | null) ?? null,
    disableRegistration: Boolean(row.disableRegistration ?? base.disableRegistration),
    emailRequiredForSignup: Boolean(row.emailRequiredForSignup ?? false),
    enableHcaptcha: Boolean(row.enableHcaptcha),
    hcaptchaSiteKey: (row.hcaptchaSiteKey as string | null) ?? null,
    enableMcaptcha: Boolean(row.enableMcaptcha),
    mcaptchaSitekey: (row.mcaptchaSitekey as string | null) ?? null,
    mcaptchaInstanceUrl: (row.mcaptchaInstanceUrl as string | null) ?? null,
    enableRecaptcha: Boolean(row.enableRecaptcha),
    recaptchaSiteKey: (row.recaptchaSiteKey as string | null) ?? null,
    enableTurnstile: Boolean(row.enableTurnstile),
    turnstileSiteKey: (row.turnstileSiteKey as string | null) ?? null,
    enableTestcaptcha: Boolean(row.enableTestcaptcha),
    googleAnalyticsMeasurementId:
      (row.googleAnalyticsMeasurementId as string | null) ?? null,
    swPublicKey: (row.swPublicKey as string | null) ?? null,
    themeColor: (row.themeColor as string | null) ?? null,
    mascotImageUrl: (row.mascotImageUrl as string | null) ?? null,
    bannerUrl: (row.bannerUrl as string | null) ?? null,
    infoImageUrl: (row.infoImageUrl as string | null) ?? null,
    serverErrorImageUrl: (row.serverErrorImageUrl as string | null) ?? null,
    notFoundImageUrl: (row.notFoundImageUrl as string | null) ?? null,
    iconUrl: (row.iconUrl as string | null) ?? null,
    backgroundImageUrl: (row.backgroundImageUrl as string | null) ?? null,
    logoImageUrl: (row.logoImageUrl as string | null) ?? null,
    defaultLightTheme: (row.defaultLightTheme as string | null) ?? null,
    defaultDarkTheme: (row.defaultDarkTheme as string | null) ?? null,
    clientOptions:
      row.clientOptions && typeof row.clientOptions === "object"
        ? (row.clientOptions as Record<string, unknown>)
        : {},
    notesPerOneAd: Number(row.notesPerOneAd ?? 0),
    enableEmail: Boolean(row.enableEmail),
    enableServiceWorker: Boolean(row.enableServiceWorker),
    deeplAuthKey: (row.deeplAuthKey as string | null) ?? null,
    serverRules: Array.isArray(row.serverRules) ? (row.serverRules as string[]) : [],
    policies:
      row.policies && typeof row.policies === "object"
        ? (row.policies as PackMetaSource["policies"])
        : base.policies,
    urlPreviewEnabled: row.urlPreviewEnabled !== false,
    federation: fed,
    cacheRemoteFiles: Boolean(row.cacheRemoteFiles),
    cacheRemoteSensitiveFiles: row.cacheRemoteSensitiveFiles !== false,
    rootUserId: (row.rootUserId as string | null) ?? null,
    useObjectStorage: Boolean(row.useObjectStorage),
  };
}

const META_SELECT = `
SELECT id, name, "shortName", description, "maintainerName", "maintainerEmail",
  "termsOfServiceUrl", "repositoryUrl", "feedbackUrl", "impressumUrl",
  "privacyPolicyUrl", "inquiryUrl", "disableRegistration", "emailRequiredForSignup",
  langs, "serverRules", policies, "themeColor",
  "mascotImageUrl", "bannerUrl", "backgroundImageUrl", "logoImageUrl", "iconUrl",
  "infoImageUrl", "serverErrorImageUrl", "notFoundImageUrl",
  "enableHcaptcha", "hcaptchaSiteKey", "enableMcaptcha", "mcaptchaSitekey", "mcaptchaInstanceUrl",
  "enableRecaptcha", "recaptchaSiteKey", "enableTurnstile", "turnstileSiteKey", "enableTestcaptcha",
  "googleAnalyticsMeasurementId", "swPublicKey", "defaultLightTheme", "defaultDarkTheme",
  "clientOptions", "notesPerOneAd", "enableEmail", "enableServiceWorker", "deeplAuthKey",
  "urlPreviewEnabled", federation, "cacheRemoteFiles", "cacheRemoteSensitiveFiles",
  "rootUserId", "useObjectStorage"
FROM meta
ORDER BY id DESC
LIMIT 1
`;

export async function fetchMetaFromPg(client: PgQueryable): Promise<PackMetaSource | null> {
  return isolateCached(
    client,
    "meta:source",
    META_ISOLATE_TTL_MS,
    async () => {
      const r = await client.query(META_SELECT);
      const row = r.rows[0];
      if (!row) return null;
      return mapRowToPackMeta(row);
    },
    { clone: true },
  );
}

export async function seedMetaIfEmpty(
  client: PgQueryable,
  over: Partial<typeof DEFAULT_META_SEED> = {},
): Promise<MetaSeedResult> {
  const s = { ...DEFAULT_META_SEED, ...over };
  const existing = await client.query(
    `SELECT id, name, "rootUserId" FROM meta ORDER BY id DESC LIMIT 1`,
  );
  if (existing.rows[0]) {
    return {
      ok: true,
      inserted: false,
      alreadyPresent: true,
      id: String(existing.rows[0].id),
      name: existing.rows[0].name as string | null,
      rootUserId: (existing.rows[0].rootUserId as string | null) ?? null,
    };
  }

  await client.query(
    `INSERT INTO meta (
      id, name, "shortName", description, "maintainerName", "maintainerEmail",
      "repositoryUrl", "feedbackUrl", federation, "disableRegistration"
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      s.id,
      s.name,
      s.shortName,
      s.description,
      s.maintainerName,
      s.maintainerEmail,
      s.repositoryUrl,
      s.feedbackUrl,
      s.federation,
      s.disableRegistration,
    ],
  );

  const after = await client.query(
    `SELECT id, name, "rootUserId" FROM meta WHERE id = $1`,
    [s.id],
  );
  const row = after.rows[0];
  return {
    ok: true,
    inserted: true,
    alreadyPresent: false,
    id: row ? String(row.id) : s.id,
    name: (row?.name as string | null) ?? s.name,
    rootUserId: (row?.rootUserId as string | null) ?? null,
  };
}

export async function seedMetaViaHyperdrive(
  hd: HyperdriveBinding | undefined,
  over: Partial<typeof DEFAULT_META_SEED> = {},
): Promise<MetaSeedResult> {
  try {
    return await withHyperdriveClient(hd, (c) => seedMetaIfEmpty(c, over));
  } catch (e) {
    return {
      ok: false,
      inserted: false,
      alreadyPresent: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

export async function loadMetaSourceFromPg(
  hd: HyperdriveBinding | undefined,
): Promise<PackMetaSource | null> {
  if (!hd?.connectionString) return null;
  try {
    return await withHyperdriveClient(hd, (c) => fetchMetaFromPg(c));
  } catch {
    return null;
  }
}
