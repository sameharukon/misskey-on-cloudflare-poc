import type { ApiEnv } from "../../env.js";
import { adminGate } from "../../admin-gate.js";
import { hyperdriveUnbound } from "../../handler-kit.js";
import { apiErrorResponse, INVALID_PARAM } from "../../errors.js";
import { applyMetaPatch, invalidateMetaCache, seedMetaOverlayFromEnv, setMetaOverlay } from "../../meta-runtime.js";
import { authenticatePg, extractToken } from "../../auth-pg.js";
import { withHyperdriveClient } from "../../pg.js";
import { fetchMetaFromPg } from "../../meta-pg.js";
import { moderationLogPg } from "../../policies-pg.js";
import { genAidx } from "../../../../id/src/index.js";

export const name = "admin/update-meta";

/**
 * upstream paramDef of admin/update-meta: `b` boolean, `bN` nullable boolean, `s` string,
 * `sN` nullable string, `i` integer, `iN` nullable integer, `i1` integer ≥ 1, `n` number,
 * `aN` nullable string array, `a` string array, or an enum list.
 */
type Spec = "b" | "bN" | "s" | "sN" | "i" | "iN" | "i1" | "n" | "a" | "aN" | "clientOptions" | "deliverSuspendedSoftware" | readonly string[];
const PARAMS: Record<string, Spec> = {
  disableRegistration: "bN",
  pinnedUsers: "aN", hiddenTags: "aN", blockedHosts: "aN", sensitiveWords: "aN", prohibitedWords: "aN", prohibitedWordsForNameOfUser: "aN",
  themeColor: "sN", mascotImageUrl: "sN", bannerUrl: "sN", serverErrorImageUrl: "sN", infoImageUrl: "sN", notFoundImageUrl: "sN", iconUrl: "sN",
  app192IconUrl: "sN", app512IconUrl: "sN", backgroundImageUrl: "sN", logoImageUrl: "sN", name: "sN", shortName: "sN", description: "sN",
  defaultLightTheme: "sN", defaultDarkTheme: "sN", clientOptions: "clientOptions",
  cacheRemoteFiles: "b", cacheRemoteSensitiveFiles: "b", emailRequiredForSignup: "b",
  enableHcaptcha: "b", hcaptchaSiteKey: "sN", hcaptchaSecretKey: "sN", enableMcaptcha: "b", mcaptchaSiteKey: "sN", mcaptchaInstanceUrl: "sN",
  mcaptchaSecretKey: "sN", enableRecaptcha: "b", recaptchaSiteKey: "sN", recaptchaSecretKey: "sN", enableTurnstile: "b", turnstileSiteKey: "sN",
  turnstileSecretKey: "sN", enableTestcaptcha: "b", googleAnalyticsMeasurementId: "sN",
  sensitiveMediaDetection: ["none", "all", "local", "remote"], sensitiveMediaDetectionSensitivity: ["medium", "low", "high", "veryLow", "veryHigh"],
  setSensitiveFlagAutomatically: "b", enableSensitiveMediaDetectionForVideos: "b", sensitiveMediaDetectionApiUrl: "sN", sensitiveMediaDetectionApiKey: "sN",
  sensitiveMediaDetectionTimeout: "i1", sensitiveMediaDetectionMaxImagesPerRequest: "i1",
  maintainerName: "sN", maintainerEmail: "sN", langs: "a", deeplAuthKey: "sN", deeplIsPro: "b",
  enableEmail: "b", email: "sN", smtpSecure: "b", smtpHost: "sN", smtpPort: "iN", smtpUser: "sN", smtpPass: "sN",
  enableServiceWorker: "b", swPublicKey: "sN", swPrivateKey: "sN",
  tosUrl: "sN", repositoryUrl: "sN", feedbackUrl: "sN", impressumUrl: "sN", privacyPolicyUrl: "sN", inquiryUrl: "sN",
  useObjectStorage: "b", objectStorageBaseUrl: "sN", objectStorageBucket: "sN", objectStoragePrefix: "sN", objectStorageEndpoint: "sN",
  objectStorageRegion: "sN", objectStoragePort: "iN", objectStorageAccessKey: "sN", objectStorageSecretKey: "sN", objectStorageUseSSL: "b",
  objectStorageUseProxy: "b", objectStorageSetPublicRead: "b", objectStorageS3ForcePathStyle: "b",
  enableIpLogging: "b", enableActiveEmailValidation: "b", enableVerifymailApi: "b", verifymailAuthKey: "sN", enableTruemailApi: "b",
  truemailInstance: "sN", truemailAuthKey: "sN", enableChartsForRemoteUser: "b", enableChartsForFederatedInstances: "b",
  enableStatsForFederatedInstances: "b", enableServerMachineStats: "b", enableIdenticonGeneration: "b",
  serverRules: "a", bannedEmailDomains: "a", preservedUsernames: "a", manifestJsonOverride: "s",
  enableFanoutTimeline: "b", enableFanoutTimelineDbFallback: "b", perLocalUserUserTimelineCacheMax: "i", perRemoteUserUserTimelineCacheMax: "i",
  perUserHomeTimelineCacheMax: "i", perUserListTimelineCacheMax: "i", enableReactionsBuffering: "b", notesPerOneAd: "i",
  silencedHosts: "aN", mediaSilencedHosts: "aN", summalyProxy: "sN",
  urlPreviewEnabled: "b", urlPreviewAllowRedirect: "b", urlPreviewTimeout: "i", urlPreviewMaximumContentLength: "i",
  urlPreviewRequireContentLength: "b", urlPreviewUserAgent: "sN", urlPreviewSummaryProxyUrl: "sN", urlPreviewSensitiveList: "aN",
  federation: ["all", "none", "specified"], federationHosts: "a", deliverSuspendedSoftware: "deliverSuspendedSoftware",
  singleUserMode: "b", ugcVisibilityForVisitor: ["all", "local", "none"], proxyRemoteFiles: "b", signToActivityPubGet: "b",
  allowExternalApRedirect: "b", enableRemoteNotesCleaning: "b", remoteNotesCleaningExpiryDaysForEachNotes: "n",
  remoteNotesCleaningMaxProcessingDurationInMinutes: "n", showRoleBadgesOfRemoteUsers: "b",
};

const isStrArr = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

function valid(spec: Spec, v: unknown): boolean {
  if (Array.isArray(spec)) return typeof v === "string" && spec.includes(v);
  switch (spec) {
    case "b": return typeof v === "boolean";
    case "bN": return v === null || typeof v === "boolean";
    case "s": return typeof v === "string";
    case "sN": return v === null || typeof v === "string";
    case "i": return Number.isInteger(v);
    case "iN": return v === null || Number.isInteger(v);
    case "i1": return Number.isInteger(v) && (v as number) >= 1;
    case "n": return typeof v === "number" && Number.isFinite(v);
    case "a": return isStrArr(v);
    case "aN": return v === null || isStrArr(v);
    case "clientOptions": {
      if (!v || typeof v !== "object" || Array.isArray(v)) return false;
      const o = v as Record<string, unknown>;
      if (o.entrancePageStyle !== undefined && !(o.entrancePageStyle === "classic" || o.entrancePageStyle === "simple")) return false;
      return ["showTimelineForVisitor", "showActivitiesForVisitor"].every((k) => o[k] === undefined || typeof o[k] === "boolean");
    }
    case "deliverSuspendedSoftware":
      return Array.isArray(v) && v.every((x) => x && typeof x === "object" && typeof x.software === "string" && typeof x.versionRange === "string");
  }
  return false;
}

/** paramDef patterns (themeColor, objectStoragePrefix) */
function patternOk(body: Record<string, unknown>): boolean {
  if (typeof body.themeColor === "string" && !/^#[0-9a-fA-F]{6}$/.test(body.themeColor)) return false;
  if (typeof body.objectStoragePrefix === "string" && !/^[a-zA-Z0-9-._]*$/.test(body.objectStoragePrefix)) return false;
  return true;
}

const canParseUrl = (s: string) => {
  try {
    new URL(s);
    return true;
  } catch {
    return false;
  }
};

/** The endpoint body: the `set` object upstream builds from `ps` (column name → value). */
export function buildMetaSet(ps: Record<string, unknown>, current: Record<string, unknown>): Record<string, unknown> {
  const set: Record<string, unknown> = {};
  const has = (k: string) => ps[k] !== undefined;
  const filled = (a: string[]) => a.filter(Boolean);
  if (typeof ps.disableRegistration === "boolean") set.disableRegistration = ps.disableRegistration;
  for (const k of ["pinnedUsers", "hiddenTags", "sensitiveWords", "prohibitedWords", "prohibitedWordsForNameOfUser"]) {
    if (Array.isArray(ps[k])) set[k] = filled(ps[k] as string[]);
  }
  if (Array.isArray(ps.blockedHosts)) set.blockedHosts = filled(ps.blockedHosts as string[]).map((x) => x.toLowerCase());
  for (const k of ["silencedHosts", "mediaSilencedHosts"]) {
    if (!Array.isArray(ps[k])) continue;
    let lastValue = "";
    set[k] = [...(ps[k] as string[])].sort().filter((h) => {
      const lv = lastValue;
      lastValue = h;
      return h !== "" && h !== lv && !(set.blockedHosts as string[] | undefined)?.includes(h);
    });
  }
  const plain = [
    "themeColor", "mascotImageUrl", "bannerUrl", "iconUrl", "app192IconUrl", "app512IconUrl", "serverErrorImageUrl", "infoImageUrl", "notFoundImageUrl",
    "backgroundImageUrl", "logoImageUrl", "name", "shortName", "description", "defaultLightTheme", "defaultDarkTheme",
    "cacheRemoteFiles", "cacheRemoteSensitiveFiles", "emailRequiredForSignup", "enableHcaptcha", "hcaptchaSiteKey", "hcaptchaSecretKey",
    "enableMcaptcha", "mcaptchaInstanceUrl", "mcaptchaSecretKey", "enableRecaptcha", "recaptchaSiteKey", "recaptchaSecretKey", "enableTurnstile",
    "turnstileSiteKey", "turnstileSecretKey", "enableTestcaptcha", "sensitiveMediaDetection", "sensitiveMediaDetectionSensitivity",
    "setSensitiveFlagAutomatically", "enableSensitiveMediaDetectionForVideos", "sensitiveMediaDetectionTimeout", "sensitiveMediaDetectionMaxImagesPerRequest",
    "maintainerName", "maintainerEmail", "enableEmail", "email", "smtpSecure", "smtpHost", "smtpPort", "smtpUser", "smtpPass",
    "enableServiceWorker", "swPublicKey", "swPrivateKey", "feedbackUrl", "impressumUrl", "privacyPolicyUrl", "inquiryUrl",
    "useObjectStorage", "objectStorageBaseUrl", "objectStorageBucket", "objectStoragePrefix", "objectStorageEndpoint", "objectStorageRegion",
    "objectStoragePort", "objectStorageAccessKey", "objectStorageSecretKey", "objectStorageUseSSL", "objectStorageUseProxy", "objectStorageSetPublicRead",
    "objectStorageS3ForcePathStyle", "deeplIsPro", "enableIpLogging", "enableActiveEmailValidation", "enableVerifymailApi", "enableTruemailApi",
    "enableChartsForRemoteUser", "enableChartsForFederatedInstances", "enableStatsForFederatedInstances", "enableServerMachineStats",
    "enableIdenticonGeneration", "serverRules", "preservedUsernames", "manifestJsonOverride", "enableFanoutTimeline", "enableFanoutTimelineDbFallback",
    "perLocalUserUserTimelineCacheMax", "perRemoteUserUserTimelineCacheMax", "perUserHomeTimelineCacheMax", "perUserListTimelineCacheMax",
    "enableReactionsBuffering", "notesPerOneAd", "bannedEmailDomains", "urlPreviewEnabled", "urlPreviewAllowRedirect", "urlPreviewTimeout",
    "urlPreviewMaximumContentLength", "urlPreviewRequireContentLength", "federation", "deliverSuspendedSoftware", "singleUserMode",
    "ugcVisibilityForVisitor", "proxyRemoteFiles", "signToActivityPubGet", "allowExternalApRedirect", "enableRemoteNotesCleaning",
    "remoteNotesCleaningExpiryDaysForEachNotes", "remoteNotesCleaningMaxProcessingDurationInMinutes", "showRoleBadgesOfRemoteUsers",
  ];
  for (const k of plain) if (has(k)) set[k] = ps[k];
  if (has("clientOptions")) set.clientOptions = { ...((current.clientOptions as Record<string, unknown> | null) ?? {}), ...(ps.clientOptions as Record<string, unknown>) };
  if (has("mcaptchaSiteKey")) set.mcaptchaSitekey = ps.mcaptchaSiteKey;
  // '' → null
  if (has("googleAnalyticsMeasurementId")) set.googleAnalyticsMeasurementId = ps.googleAnalyticsMeasurementId || null;
  for (const k of ["sensitiveMediaDetectionApiUrl", "sensitiveMediaDetectionApiKey", "deeplAuthKey", "verifymailAuthKey", "truemailInstance", "truemailAuthKey"]) {
    if (has(k)) set[k] = ps[k] === "" ? null : ps[k];
  }
  if (Array.isArray(ps.langs)) set.langs = filled(ps.langs as string[]);
  if (has("tosUrl")) set.termsOfServiceUrl = ps.tosUrl;
  // URL.canParse(null) is false → null
  if (has("repositoryUrl")) set.repositoryUrl = typeof ps.repositoryUrl === "string" && canParseUrl(ps.repositoryUrl) ? ps.repositoryUrl : null;
  if (has("urlPreviewUserAgent")) {
    const value = String(ps.urlPreviewUserAgent ?? "").trim();
    set.urlPreviewUserAgent = value === "" ? null : ps.urlPreviewUserAgent;
  }
  if (has("summalyProxy") || has("urlPreviewSummaryProxyUrl")) {
    const value = String((ps.urlPreviewSummaryProxyUrl ?? ps.summalyProxy) ?? "").trim();
    set.urlPreviewSummaryProxyUrl = value === "" ? null : value;
  }
  if (Array.isArray(ps.urlPreviewSensitiveList)) set.urlPreviewSensitiveList = filled(ps.urlPreviewSensitiveList as string[]);
  if (Array.isArray(ps.federationHosts)) set.federationHosts = filled(ps.federationHosts as string[]).map((x) => x.toLowerCase());
  return set;
}

const JSONB_COLUMNS = new Set(["clientOptions", "deliverSuspendedSoftware"]);

export async function handle(
  env: ApiEnv,
  body: Record<string, unknown>,
  ctx: { request: Request },
): Promise<Response | unknown> {
  // upstream admin/update-meta: requireAdmin
  const denied = await adminGate(ctx.request, env as never, body, "admin");
  if (denied) return denied;
  for (const [k, spec] of Object.entries(PARAMS)) {
    if (body[k] !== undefined && !valid(spec, body[k])) return apiErrorResponse(INVALID_PARAM, 400);
  }
  if (!patternOk(body)) return apiErrorResponse(INVALID_PARAM, 400);
  if (!env.HYPERDRIVE?.connectionString) return hyperdriveUnbound();

  const token = extractToken(ctx.request, body);
  const me = token ? ((await authenticatePg(env, token))?.user.id ?? null) : null;
  const fresh = await withHyperdriveClient(env.HYPERDRIVE!, async (c) => {
    // MetaService.update: the newest row (a fresh `x` row when there is none)
    const before = (await c.query(`SELECT to_jsonb(m) AS j FROM meta m ORDER BY id DESC LIMIT 1`)).rows[0]?.j as Record<string, unknown> | undefined;
    const set = buildMetaSet(body, before ?? {});
    // columns of this schema only (the pinned upstream schema has them all)
    const keys = Object.keys(set).filter((k) => !before || k in before);
    if (!before) {
      await c.query(`INSERT INTO meta (id) VALUES ('x')`);
    }
    const id = before ? String(before.id) : "x";
    if (keys.length) {
      await c.query(
        `UPDATE meta SET ${keys.map((k, i) => `"${k}" = $${i + 2}${JSONB_COLUMNS.has(k) ? "::jsonb" : ""}`).join(", ")} WHERE id = $1`,
        [id, ...keys.map((k) => (JSONB_COLUMNS.has(k) ? JSON.stringify(set[k]) : set[k]))],
      );
    }
    const after = (await c.query(`SELECT to_jsonb(m) AS j FROM meta m ORDER BY id DESC LIMIT 1`)).rows[0]?.j ?? null;
    if (me) await moderationLogPg(c, me, "updateServerSettings", { before: before ?? null, after }, genAidx(Date.now()));
    try {
      return await fetchMetaFromPg(c);
    } catch {
      return null; // partial schema (tests)
    }
  });
  // the packed-meta overlay follows the row (patched in place when the row cannot be re-read)
  const seeded = fresh ? null : seedMetaOverlayFromEnv(env);
  const next = fresh ?? (seeded && applyMetaPatch(seeded, body));
  if (next) setMetaOverlay(env, next);
  await invalidateMetaCache(env);
  return new Response(null, { status: 204 });
}
