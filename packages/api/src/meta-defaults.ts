/**
 * The `meta` values used when a column is NULL, and the offline (no Hyperdrive) meta.
 *
 * Nullable columns stay null, as upstream MetaEntityService returns them; the others follow the
 * column defaults of upstream models/Meta.ts. The one intended difference is `repositoryUrl`: a
 * NULL column falls back to FORK_REPOSITORY_URL, so the source of this modified AGPL deployment is
 * still offered (AGPL §13; `providesTarball` is false).
 */
import type { PackMetaSource } from "../../packers/src/index.js";

/**
 * The source repository of this deployment: a placeholder to replace with your fork's URL (or set
 * the repository URL in the admin settings), as AGPL §13 requires offering the modified source.
 */
export const FORK_REPOSITORY_URL = "https://github.com/your-account/misskey-cf";

/** A fresh object on every call (callers mutate the meta they hold). */
export function upstreamMetaDefaults(over: Partial<PackMetaSource> = {}): PackMetaSource {
  return {
    maintainerName: null,
    maintainerEmail: null,
    name: null,
    shortName: null,
    description: null,
    langs: [],
    termsOfServiceUrl: null,
    repositoryUrl: FORK_REPOSITORY_URL,
    feedbackUrl: null,
    impressumUrl: null,
    privacyPolicyUrl: null,
    inquiryUrl: null,
    disableRegistration: true,
    emailRequiredForSignup: false,
    enableHcaptcha: false,
    hcaptchaSiteKey: null,
    enableMcaptcha: false,
    mcaptchaSitekey: null,
    mcaptchaInstanceUrl: null,
    enableRecaptcha: false,
    recaptchaSiteKey: null,
    enableTurnstile: false,
    turnstileSiteKey: null,
    enableTestcaptcha: false,
    googleAnalyticsMeasurementId: null,
    swPublicKey: null,
    themeColor: null,
    mascotImageUrl: null,
    bannerUrl: null,
    infoImageUrl: null,
    serverErrorImageUrl: null,
    notFoundImageUrl: null,
    iconUrl: null,
    backgroundImageUrl: null,
    logoImageUrl: null,
    defaultLightTheme: null,
    defaultDarkTheme: null,
    clientOptions: {},
    notesPerOneAd: 0,
    enableEmail: false,
    enableServiceWorker: false,
    deeplAuthKey: null,
    serverRules: [],
    policies: {},
    urlPreviewEnabled: true,
    federation: "none",
    cacheRemoteFiles: false,
    cacheRemoteSensitiveFiles: true,
    rootUserId: null,
    useObjectStorage: false,
    ...over,
  };
}
