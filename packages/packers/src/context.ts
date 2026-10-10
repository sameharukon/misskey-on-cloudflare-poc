import type { RolePolicies } from "../../misskey-js-types/src/index.js";

/** Runtime config injected into packers (replaces Nest Config + Meta DI). */
export interface PackConfig {
  version: string;
  url: string;
  host: string;
  mediaProxy: string;
  maxFileSize: number;
  providesTarball?: boolean;
  fulltextSearchProvider?: string | null;
  meilisearchScope?: "local" | "global" | null;
  sentryForFrontend?: MetaLiteSentry | null;
}

export type MetaLiteSentry = {
  options: { dsn: string } & Record<string, unknown>;
  vueIntegration?: Record<string, unknown> | null;
  browserTracingIntegration?: Record<string, unknown> | null;
  replayIntegration?: Record<string, unknown> | null;
};

export interface PackAd {
  id: string;
  url: string;
  place: string;
  ratio: number;
  imageUrl: string;
  dayOfWeek: number;
  isSensitive?: boolean;
}

/** Meta row fields needed for packing (superset of packages/db MetaRow). */
export interface PackMetaSource {
  maintainerName: string | null;
  maintainerEmail: string | null;
  name: string | null;
  shortName: string | null;
  description: string | null;
  langs: string[];
  termsOfServiceUrl: string | null;
  repositoryUrl: string | null;
  feedbackUrl: string | null;
  impressumUrl: string | null;
  privacyPolicyUrl: string | null;
  inquiryUrl: string | null;
  disableRegistration: boolean;
  emailRequiredForSignup: boolean;
  enableHcaptcha: boolean;
  hcaptchaSiteKey: string | null;
  enableMcaptcha: boolean;
  mcaptchaSitekey: string | null;
  mcaptchaInstanceUrl: string | null;
  enableRecaptcha: boolean;
  recaptchaSiteKey: string | null;
  enableTurnstile: boolean;
  turnstileSiteKey: string | null;
  enableTestcaptcha: boolean;
  googleAnalyticsMeasurementId: string | null;
  swPublicKey: string | null;
  themeColor: string | null;
  mascotImageUrl: string | null;
  bannerUrl: string | null;
  infoImageUrl: string | null;
  serverErrorImageUrl: string | null;
  notFoundImageUrl: string | null;
  iconUrl: string | null;
  backgroundImageUrl: string | null;
  logoImageUrl: string | null;
  defaultLightTheme: string | null;
  defaultDarkTheme: string | null;
  clientOptions: Record<string, unknown>;
  notesPerOneAd: number;
  enableEmail: boolean;
  enableServiceWorker: boolean;
  deeplAuthKey: string | null;
  serverRules: string[];
  policies: Partial<RolePolicies>;
  urlPreviewEnabled: boolean;
  federation: "all" | "specified" | "none";
  cacheRemoteFiles: boolean;
  cacheRemoteSensitiveFiles: boolean;
  rootUserId: string | null;
  useObjectStorage: boolean;
}

export interface PackUserSource {
  id: string;
  name: string | null;
  username: string;
  host: string | null;
  avatarId: string | null;
  avatarUrl: string | null;
  avatarBlurhash: string | null;
  avatarDecorations?: { id: string; angle?: number; flipH?: boolean; offsetX?: number; offsetY?: number; url?: string }[];
  isBot: boolean;
  isCat: boolean;
  hideOnlineStatus?: boolean;
  lastActiveDate?: Date | null;
  requireSigninToViewContents?: boolean;
  emojis?: string[];
  isSuspended?: boolean;
  makeNotesFollowersOnlyBefore?: number | null;
  makeNotesHiddenBefore?: number | null;
  /** Database-backed UserLite fields (api `enrichUserSourcesPg`); packUserLite emits them when set. */
  lite?: {
    avatarDecorations: { id: string; angle?: number; flipH?: boolean; offsetX?: number; offsetY?: number; url: string }[];
    makeNotesFollowersOnlyBefore?: number;
    makeNotesHiddenBefore?: number;
    instance?: Record<string, unknown>;
    emojis: Record<string, string>;
    badgeRoles?: { name: string; iconUrl: string | null; displayOrder: number }[];
  };
}

export interface PackNoteSource {
  id: string;
  userId: string;
  text: string | null;
  cw: string | null;
  name?: string | null;
  visibility: "public" | "home" | "followers" | "specified";
  localOnly: boolean;
  reactionAcceptance: string | null;
  visibleUserIds: string[];
  renoteCount: number;
  repliesCount: number;
  reactions: Record<string, number>;
  fileIds: string[];
  replyId: string | null;
  renoteId: string | null;
  channelId: string | null;
  mentions: string[];
  hasPoll: boolean;
  uri: string | null;
  url: string | null;
  tags: string[];
  emojis: string[];
  userHost: string | null;
  /** Denormalized reply/renote author (PG columns); optional for fixtures */
  replyUserId?: string | null;
  replyUserHost?: string | null;
  renoteUserId?: string | null;
  renoteUserHost?: string | null;
  renoteChannelId?: string | null;
  clippedCount?: number;
  reactionAndUserPairCache?: string[];
}
