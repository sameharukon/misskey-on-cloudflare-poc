/** Inventory of `meta` singleton key columns used by Tier A / admin-min. */

export interface MetaRow {
  id: string;
  name: string | null;
  shortName: string | null;
  description: string | null;
  maintainerName: string | null;
  maintainerEmail: string | null;
  tosUrl: string | null;
  impressumUrl: string | null;
  privacyPolicyUrl: string | null;
  inquiryUrl: string | null;
  disableRegistration: boolean;
  themeColor: string | null;
  mascotImageUrl: string | null;
  bannerUrl: string | null;
  backgroundImageUrl: string | null;
  logoImageUrl: string | null;
  iconUrl: string | null;
  serverRules: string[];
  pinnedUsers: string[];
  blockedHosts: string[];
  silencedHosts: string[];
  sensitiveWords: string[];
  prohibitedWords: string[];
  enableHcaptcha: boolean;
  enableRecaptcha: boolean;
  enableTurnstile: boolean;
  cacheRemoteFiles: boolean;
  cacheRemoteSensitiveFiles: boolean;
  emailRequiredForSignup: boolean;
  enableEmail: boolean;
  objectStorageEnable: boolean;
}
