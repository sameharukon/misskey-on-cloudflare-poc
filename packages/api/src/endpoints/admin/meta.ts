import type { ApiEnv } from "../../env.js";
import { adminGate } from "../../admin-gate.js";
import { hyperdriveUnbound } from "../../handler-kit.js";
import { packInstanceMeta } from "../../meta-source.js";
import { withHyperdriveClient } from "../../pg.js";
import { DEFAULT_POLICIES } from "../../../../packers/src/index.js";

export const name = "admin/meta";

/** upstream admin/meta keys read straight from the meta row (response key → column). */
const FIELDS: [string, string][] = [
  ["maintainerName", "maintainerName"], ["maintainerEmail", "maintainerEmail"], ["name", "name"], ["shortName", "shortName"],
  ["description", "description"], ["langs", "langs"], ["tosUrl", "termsOfServiceUrl"], ["repositoryUrl", "repositoryUrl"],
  ["feedbackUrl", "feedbackUrl"], ["impressumUrl", "impressumUrl"], ["privacyPolicyUrl", "privacyPolicyUrl"], ["inquiryUrl", "inquiryUrl"],
  ["disableRegistration", "disableRegistration"], ["emailRequiredForSignup", "emailRequiredForSignup"], ["enableHcaptcha", "enableHcaptcha"],
  ["hcaptchaSiteKey", "hcaptchaSiteKey"], ["enableMcaptcha", "enableMcaptcha"], ["mcaptchaSiteKey", "mcaptchaSitekey"],
  ["mcaptchaInstanceUrl", "mcaptchaInstanceUrl"], ["enableRecaptcha", "enableRecaptcha"], ["recaptchaSiteKey", "recaptchaSiteKey"],
  ["enableTurnstile", "enableTurnstile"], ["turnstileSiteKey", "turnstileSiteKey"], ["enableTestcaptcha", "enableTestcaptcha"],
  ["googleAnalyticsMeasurementId", "googleAnalyticsMeasurementId"], ["swPublickey", "swPublicKey"], ["themeColor", "themeColor"],
  ["mascotImageUrl", "mascotImageUrl"], ["bannerUrl", "bannerUrl"], ["serverErrorImageUrl", "serverErrorImageUrl"],
  ["notFoundImageUrl", "notFoundImageUrl"], ["infoImageUrl", "infoImageUrl"], ["iconUrl", "iconUrl"], ["app192IconUrl", "app192IconUrl"],
  ["app512IconUrl", "app512IconUrl"], ["backgroundImageUrl", "backgroundImageUrl"], ["logoImageUrl", "logoImageUrl"],
  ["defaultLightTheme", "defaultLightTheme"], ["defaultDarkTheme", "defaultDarkTheme"], ["clientOptions", "clientOptions"],
  ["enableEmail", "enableEmail"], ["enableServiceWorker", "enableServiceWorker"], ["cacheRemoteFiles", "cacheRemoteFiles"],
  ["cacheRemoteSensitiveFiles", "cacheRemoteSensitiveFiles"], ["pinnedUsers", "pinnedUsers"], ["hiddenTags", "hiddenTags"],
  ["blockedHosts", "blockedHosts"], ["silencedHosts", "silencedHosts"], ["mediaSilencedHosts", "mediaSilencedHosts"],
  ["sensitiveWords", "sensitiveWords"], ["prohibitedWords", "prohibitedWords"], ["prohibitedWordsForNameOfUser", "prohibitedWordsForNameOfUser"],
  ["preservedUsernames", "preservedUsernames"], ["hcaptchaSecretKey", "hcaptchaSecretKey"], ["mcaptchaSecretKey", "mcaptchaSecretKey"],
  ["recaptchaSecretKey", "recaptchaSecretKey"], ["turnstileSecretKey", "turnstileSecretKey"], ["sensitiveMediaDetection", "sensitiveMediaDetection"],
  ["sensitiveMediaDetectionSensitivity", "sensitiveMediaDetectionSensitivity"], ["setSensitiveFlagAutomatically", "setSensitiveFlagAutomatically"],
  ["enableSensitiveMediaDetectionForVideos", "enableSensitiveMediaDetectionForVideos"], ["sensitiveMediaDetectionApiUrl", "sensitiveMediaDetectionApiUrl"],
  ["sensitiveMediaDetectionApiKey", "sensitiveMediaDetectionApiKey"], ["sensitiveMediaDetectionTimeout", "sensitiveMediaDetectionTimeout"],
  ["sensitiveMediaDetectionMaxImagesPerRequest", "sensitiveMediaDetectionMaxImagesPerRequest"],
  ["email", "email"], ["smtpSecure", "smtpSecure"], ["smtpHost", "smtpHost"], ["smtpPort", "smtpPort"], ["smtpUser", "smtpUser"], ["smtpPass", "smtpPass"],
  ["swPrivateKey", "swPrivateKey"], ["useObjectStorage", "useObjectStorage"], ["objectStorageBaseUrl", "objectStorageBaseUrl"],
  ["objectStorageBucket", "objectStorageBucket"], ["objectStoragePrefix", "objectStoragePrefix"], ["objectStorageEndpoint", "objectStorageEndpoint"],
  ["objectStorageRegion", "objectStorageRegion"], ["objectStoragePort", "objectStoragePort"], ["objectStorageAccessKey", "objectStorageAccessKey"],
  ["objectStorageSecretKey", "objectStorageSecretKey"], ["objectStorageUseSSL", "objectStorageUseSSL"], ["objectStorageUseProxy", "objectStorageUseProxy"],
  ["objectStorageSetPublicRead", "objectStorageSetPublicRead"], ["objectStorageS3ForcePathStyle", "objectStorageS3ForcePathStyle"],
  ["deeplAuthKey", "deeplAuthKey"], ["deeplIsPro", "deeplIsPro"], ["enableIpLogging", "enableIpLogging"],
  ["enableActiveEmailValidation", "enableActiveEmailValidation"], ["enableVerifymailApi", "enableVerifymailApi"], ["verifymailAuthKey", "verifymailAuthKey"],
  ["enableTruemailApi", "enableTruemailApi"], ["truemailInstance", "truemailInstance"], ["truemailAuthKey", "truemailAuthKey"],
  ["enableChartsForRemoteUser", "enableChartsForRemoteUser"], ["enableChartsForFederatedInstances", "enableChartsForFederatedInstances"],
  ["enableStatsForFederatedInstances", "enableStatsForFederatedInstances"], ["enableServerMachineStats", "enableServerMachineStats"],
  ["enableIdenticonGeneration", "enableIdenticonGeneration"], ["bannedEmailDomains", "bannedEmailDomains"],
];
const FIELDS_AFTER_POLICIES: [string, string][] = [
  ["manifestJsonOverride", "manifestJsonOverride"], ["enableFanoutTimeline", "enableFanoutTimeline"],
  ["enableFanoutTimelineDbFallback", "enableFanoutTimelineDbFallback"], ["perLocalUserUserTimelineCacheMax", "perLocalUserUserTimelineCacheMax"],
  ["perRemoteUserUserTimelineCacheMax", "perRemoteUserUserTimelineCacheMax"], ["perUserHomeTimelineCacheMax", "perUserHomeTimelineCacheMax"],
  ["perUserListTimelineCacheMax", "perUserListTimelineCacheMax"], ["enableReactionsBuffering", "enableReactionsBuffering"],
  ["notesPerOneAd", "notesPerOneAd"], ["summalyProxy", "urlPreviewSummaryProxyUrl"], ["urlPreviewEnabled", "urlPreviewEnabled"],
  ["urlPreviewAllowRedirect", "urlPreviewAllowRedirect"], ["urlPreviewTimeout", "urlPreviewTimeout"],
  ["urlPreviewMaximumContentLength", "urlPreviewMaximumContentLength"], ["urlPreviewRequireContentLength", "urlPreviewRequireContentLength"],
  ["urlPreviewUserAgent", "urlPreviewUserAgent"], ["urlPreviewSummaryProxyUrl", "urlPreviewSummaryProxyUrl"],
  ["urlPreviewSensitiveList", "urlPreviewSensitiveList"], ["federation", "federation"], ["federationHosts", "federationHosts"],
  ["deliverSuspendedSoftware", "deliverSuspendedSoftware"], ["singleUserMode", "singleUserMode"], ["ugcVisibilityForVisitor", "ugcVisibilityForVisitor"],
  ["proxyRemoteFiles", "proxyRemoteFiles"], ["signToActivityPubGet", "signToActivityPubGet"], ["allowExternalApRedirect", "allowExternalApRedirect"],
  ["enableRemoteNotesCleaning", "enableRemoteNotesCleaning"], ["remoteNotesCleaningExpiryDaysForEachNotes", "remoteNotesCleaningExpiryDaysForEachNotes"],
  ["remoteNotesCleaningMaxProcessingDurationInMinutes", "remoteNotesCleaningMaxProcessingDurationInMinutes"],
  ["showRoleBadgesOfRemoteUsers", "showRoleBadgesOfRemoteUsers"],
];

/** upstream admin/meta: the meta row's admin view (secrets included) + proxyAccountId, version, uri. */
export async function adminMetaPg(env: ApiEnv): Promise<Record<string, unknown> | null> {
  return withHyperdriveClient(env.HYPERDRIVE!, async (c) => {
    // uncached, as upstream (metaService.fetch(true)): saves from other isolates show at once
    const m = (await c.query(`SELECT to_jsonb(m) AS j FROM meta m ORDER BY id DESC LIMIT 1`)).rows[0]?.j as Record<string, unknown> | undefined;
    if (!m) return null;
    const { fetchSystemAccountC } = await import("../../ap/relay.js");
    const proxyId = await fetchSystemAccountC(c, "proxy");
    const v = (col: string) => (m[col] === undefined ? null : m[col]);
    const out: Record<string, unknown> = {};
    for (const [k, col] of FIELDS.slice(0, 2)) out[k] = v(col);
    out.version = env.VERSION ?? "0.0.0-cf";
    for (const [k, col] of FIELDS.slice(2, 4)) out[k] = v(col);
    out.uri = (env.INSTANCE_URL ?? "").replace(/\/$/, "");
    for (const [k, col] of FIELDS.slice(4)) {
      out[k] = v(col);
      if (k === "enableServiceWorker") out.translatorAvailable = m.deeplAuthKey != null;
      if (k === "sensitiveMediaDetectionMaxImagesPerRequest") out.proxyAccountId = proxyId;
    }
    out.policies = { ...DEFAULT_POLICIES, ...((m.policies as Record<string, unknown> | null) ?? {}) };
    for (const [k, col] of FIELDS_AFTER_POLICIES) out[k] = v(col);
    return out;
  });
}

export async function handle(
  env: ApiEnv,
  body: Record<string, unknown>,
  ctx: { request: Request },
): Promise<Response | unknown> {
  // upstream admin/meta: requireAdmin
  const denied = await adminGate(ctx.request, env as never, body, "admin");
  if (denied) return denied;
  if (!env.HYPERDRIVE?.connectionString) return hyperdriveUnbound();
  // no meta row yet: the packed meta from the Worker's settings
  return (await adminMetaPg(env)) ?? packInstanceMeta(env, true);
}
