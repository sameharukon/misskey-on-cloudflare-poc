import JSON5 from "json5";
import type { MetaDetailed, MetaLite, RolePolicies } from "../../misskey-js-types/src/index.js";
import type { PackAd, PackConfig, PackMetaSource } from "./context.js";
import { DEFAULT_POLICIES, MAX_NOTE_TEXT_LENGTH } from "./policies.js";

/** MetaEntityService.pack: the stored theme (JSON5) as a JSON string, null when it does not parse. */
function parseTheme(raw: string | null): string | null {
  if (!raw) return null;
  try {
    return JSON.stringify(JSON5.parse(raw));
  } catch {
    return null;
  }
}

function noteSearchableScope(config: PackConfig): "local" | "global" {
  if (config.fulltextSearchProvider === "meilisearch" && config.meilisearchScope === "local") {
    return "local";
  }
  // misskey-cf uses SQL LIKE only — treat as global searchable scope for clients
  return "global";
}

/**
 * Nest-free MetaLite packer (MetaEntityService.pack).
 * Ads must be pre-filtered by the caller (active window / dayOfWeek).
 */
export function packMetaLite(
  meta: PackMetaSource,
  config: PackConfig,
  ads: PackAd[] = [],
): MetaLite {
  const policies = { ...DEFAULT_POLICIES, ...meta.policies } as RolePolicies;

  return {
    maintainerName: meta.maintainerName,
    maintainerEmail: meta.maintainerEmail,
    version: config.version,
    providesTarball: config.providesTarball ?? false,
    name: meta.name,
    shortName: meta.shortName,
    uri: config.url,
    description: meta.description,
    langs: meta.langs,
    tosUrl: meta.termsOfServiceUrl,
    repositoryUrl: meta.repositoryUrl,
    feedbackUrl: meta.feedbackUrl,
    impressumUrl: meta.impressumUrl,
    privacyPolicyUrl: meta.privacyPolicyUrl,
    inquiryUrl: meta.inquiryUrl,
    disableRegistration: meta.disableRegistration,
    emailRequiredForSignup: meta.emailRequiredForSignup,
    enableHcaptcha: meta.enableHcaptcha,
    hcaptchaSiteKey: meta.hcaptchaSiteKey,
    enableMcaptcha: meta.enableMcaptcha,
    mcaptchaSiteKey: meta.mcaptchaSitekey,
    mcaptchaInstanceUrl: meta.mcaptchaInstanceUrl,
    enableRecaptcha: meta.enableRecaptcha,
    recaptchaSiteKey: meta.recaptchaSiteKey,
    enableTurnstile: meta.enableTurnstile,
    turnstileSiteKey: meta.turnstileSiteKey,
    enableTestcaptcha: meta.enableTestcaptcha,
    googleAnalyticsMeasurementId: meta.googleAnalyticsMeasurementId,
    swPublickey: meta.swPublicKey,
    themeColor: meta.themeColor,
    mascotImageUrl: meta.mascotImageUrl ?? "/assets/ai.png",
    bannerUrl: meta.bannerUrl,
    infoImageUrl: meta.infoImageUrl,
    serverErrorImageUrl: meta.serverErrorImageUrl,
    notFoundImageUrl: meta.notFoundImageUrl,
    iconUrl: meta.iconUrl,
    backgroundImageUrl: meta.backgroundImageUrl,
    logoImageUrl: meta.logoImageUrl,
    maxNoteTextLength: MAX_NOTE_TEXT_LENGTH,
    defaultLightTheme: parseTheme(meta.defaultLightTheme),
    defaultDarkTheme: parseTheme(meta.defaultDarkTheme),
    clientOptions: meta.clientOptions as MetaLite["clientOptions"],
    ads: ads.map((ad) => ({
      id: ad.id,
      url: ad.url,
      place: ad.place,
      ratio: ad.ratio,
      imageUrl: ad.imageUrl,
      dayOfWeek: ad.dayOfWeek,
      ...(ad.isSensitive ? { isSensitive: true as const } : {}),
    })),
    notesPerOneAd: meta.notesPerOneAd,
    enableEmail: meta.enableEmail,
    enableServiceWorker: meta.enableServiceWorker,
    translatorAvailable: meta.deeplAuthKey != null,
    serverRules: meta.serverRules,
    policies,
    sentryForFrontend: config.sentryForFrontend ?? null,
    mediaProxy: config.mediaProxy,
    enableUrlPreview: meta.urlPreviewEnabled,
    noteSearchableScope: noteSearchableScope(config),
    maxFileSize: config.maxFileSize,
    federation: meta.federation,
  };
}

/**
 * Nest-free MetaDetailed packer (MetaEntityService.packDetailed).
 * proxyAccountName is injected (SystemAccountService.fetch('proxy') equivalent).
 */
export function packMetaDetailed(
  meta: PackMetaSource,
  config: PackConfig,
  opts: { ads?: PackAd[]; proxyAccountName: string | null } = { proxyAccountName: null },
): MetaDetailed {
  const packed = packMetaLite(meta, config, opts.ads ?? []);
  const policies = packed.policies;

  return {
    ...packed,
    cacheRemoteFiles: meta.cacheRemoteFiles,
    cacheRemoteSensitiveFiles: meta.cacheRemoteSensitiveFiles,
    requireSetup: meta.rootUserId == null,
    proxyAccountName: opts.proxyAccountName,
    features: {
      localTimeline: policies.ltlAvailable,
      globalTimeline: policies.gtlAvailable,
      registration: !meta.disableRegistration,
      emailRequiredForSignup: meta.emailRequiredForSignup,
      hcaptcha: meta.enableHcaptcha,
      recaptcha: meta.enableRecaptcha,
      turnstile: meta.enableTurnstile,
      objectStorage: meta.useObjectStorage,
      serviceWorker: meta.enableServiceWorker,
      miauth: true,
    },
  };
}
