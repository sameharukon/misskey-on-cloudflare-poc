import type { RolePolicies } from "../../misskey-js-types/src/index.js";

/** Mirrors upstream RoleService.DEFAULT_POLICIES */
export const DEFAULT_POLICIES: RolePolicies = {
  gtlAvailable: true,
  ltlAvailable: true,
  canPublicNote: true,
  mentionLimit: 20,
  canInvite: false,
  inviteLimit: 0,
  inviteLimitCycle: 60 * 24 * 7,
  inviteExpirationTime: 0,
  canManageCustomEmojis: false,
  canManageAvatarDecorations: false,
  canSearchNotes: false,
  canSearchUsers: true,
  canUseTranslator: true,
  canHideAds: false,
  canCreateChannel: true,
  driveCapacityMb: 100,
  maxFileSizeMb: 30,
  alwaysMarkNsfw: false,
  canUpdateBioMedia: true,
  pinLimit: 5,
  antennaLimit: 5,
  wordMuteLimit: 200,
  webhookLimit: 3,
  clipLimit: 10,
  noteEachClipsLimit: 200,
  userListLimit: 10,
  userEachUserListsLimit: 50,
  rateLimitFactor: 1,
  avatarDecorationLimit: 1,
  canImportAntennas: false,
  canImportBlocking: false,
  canImportFollowing: false,
  canImportMuting: false,
  canImportUserLists: false,
  chatAvailability: "available",
  uploadableFileTypes: [
    "text/*",
    "application/json",
    "image/*",
    "video/*",
    "audio/*",
  ],
  noteDraftLimit: 10,
  scheduledNoteLimit: 1,
  watermarkAvailable: true,
};

export const MAX_NOTE_TEXT_LENGTH = 3000;
export const USER_ONLINE_THRESHOLD = 1000 * 60 * 10;
export const USER_ACTIVE_THRESHOLD = 1000 * 60 * 60 * 24 * 3;
