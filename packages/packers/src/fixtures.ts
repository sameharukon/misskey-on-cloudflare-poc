import { genAidx, resetAidxCounter, setAidxNodeId } from "../../id/src/index.js";
import type { PackConfig, PackMetaSource, PackNoteSource, PackUserSource } from "./context.js";

export const testConfig: PackConfig = {
  version: "2026.10.0-cf",
  url: "https://misskey.example.com",
  host: "misskey.example.com",
  mediaProxy: "https://misskey.example.com/proxy",
  maxFileSize: 262144000,
  providesTarball: false,
};

export function fixtureMeta(over: Partial<PackMetaSource> = {}): PackMetaSource {
  return {
    maintainerName: "Admin",
    maintainerEmail: "admin@example.com",
    name: "Example",
    shortName: "Ex",
    description: "A test instance",
    langs: ["ja"],
    termsOfServiceUrl: "https://misskey.example.com/tos",
    repositoryUrl: "https://github.com/misskey-dev/misskey",
    feedbackUrl: "https://github.com/misskey-dev/misskey/issues/new",
    impressumUrl: null,
    privacyPolicyUrl: null,
    inquiryUrl: null,
    disableRegistration: false,
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
    themeColor: "#86b300",
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
    serverRules: ["Be nice"],
    policies: { ltlAvailable: true, gtlAvailable: false },
    urlPreviewEnabled: true,
    federation: "all",
    cacheRemoteFiles: false,
    cacheRemoteSensitiveFiles: true,
    rootUserId: "rootuser0000001",
    useObjectStorage: true,
    ...over,
  };
}

export function fixtureLocalUser(over: Partial<PackUserSource> = {}): PackUserSource {
  setAidxNodeId("user");
  resetAidxCounter(0);
  const id = over.id ?? genAidx(Date.UTC(2024, 0, 1, 0, 0, 0));
  return {
    id,
    name: "藍",
    username: "ai",
    host: null,
    avatarId: null,
    avatarUrl: null,
    avatarBlurhash: null,
    isBot: false,
    isCat: true,
    hideOnlineStatus: false,
    lastActiveDate: new Date(Date.now() - 60_000),
    requireSigninToViewContents: false,
    ...over,
  };
}

export function fixtureRemoteUser(over: Partial<PackUserSource> = {}): PackUserSource {
  return fixtureLocalUser({
    username: "bob",
    name: "Bob",
    host: "remote.example",
    isCat: false,
    requireSigninToViewContents: false,
    ...over,
  });
}

export function fixtureNote(
  userId: string,
  over: Partial<PackNoteSource> = {},
): PackNoteSource {
  setAidxNodeId("note");
  resetAidxCounter(0);
  const id = over.id ?? genAidx(Date.UTC(2024, 5, 15, 12, 0, 0));
  return {
    id,
    userId,
    text: "hello world",
    cw: null,
    visibility: "public",
    localOnly: false,
    reactionAcceptance: null,
    visibleUserIds: [],
    renoteCount: 0,
    repliesCount: 0,
    reactions: { "👍": 2 },
    fileIds: [],
    replyId: null,
    renoteId: null,
    channelId: null,
    mentions: [],
    hasPoll: false,
    uri: null,
    url: null,
    tags: [],
    emojis: [],
    userHost: null,
    clippedCount: 0,
    ...over,
  };
}
