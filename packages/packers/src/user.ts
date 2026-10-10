import type { UserLite } from "../../misskey-js-types/src/index.js";
import type { PackConfig, PackMetaSource, PackUserSource } from "./context.js";
import { USER_ACTIVE_THRESHOLD, USER_ONLINE_THRESHOLD } from "./policies.js";

export function getIdenticonUrl(
  user: Pick<PackUserSource, "username" | "host">,
  config: PackConfig,
  metaIconUrl?: string | null,
): string {
  if (
    (user.host == null || user.host === config.host) &&
    user.username.includes(".") &&
    metaIconUrl
  ) {
    return metaIconUrl;
  }
  return `${config.url}/identicon/${user.username.toLowerCase()}@${user.host ?? config.host}`;
}

export function getOnlineStatus(
  user: Pick<PackUserSource, "hideOnlineStatus" | "lastActiveDate">,
  now = Date.now(),
): UserLite["onlineStatus"] {
  if (user.hideOnlineStatus) return "unknown";
  if (user.lastActiveDate == null) return "unknown";
  const elapsed = now - user.lastActiveDate.getTime();
  if (elapsed < USER_ONLINE_THRESHOLD) return "online";
  if (elapsed < USER_ACTIVE_THRESHOLD) return "active";
  return "offline";
}

/**
 * Nest-free UserLite packer (UserEntityService.pack schema=UserLite).
 * Gaps vs upstream: remote `instance`, custom emoji map, badgeRoles,
 * avatarDecoration URL resolution from decoration catalog.
 */
export function packUserLite(
  user: PackUserSource,
  config: PackConfig,
  meta?: Pick<PackMetaSource, "iconUrl"> | null,
): UserLite {
  const avatarUrl =
    (user.avatarId == null ? null : user.avatarUrl) ??
    getIdenticonUrl(user, config, meta?.iconUrl ?? null);

  const packed: UserLite = {
    id: user.id,
    name: user.name,
    username: user.username,
    host: user.host,
    avatarUrl,
    avatarBlurhash: user.avatarId == null ? null : user.avatarBlurhash,
    avatarDecorations: [],
    isBot: user.isBot,
    isCat: user.isCat,
    emojis: {},
    onlineStatus: getOnlineStatus(user),
    // upstream: false → omit; otherwise true (including default unset)
    ...(user.requireSigninToViewContents === false
      ? {}
      : { requireSigninToViewContents: true as const }),
  };

  if (user.lite) {
    const l = user.lite;
    Object.assign(packed, {
      avatarDecorations: l.avatarDecorations,
      emojis: l.emojis,
      ...(l.makeNotesFollowersOnlyBefore !== undefined ? { makeNotesFollowersOnlyBefore: l.makeNotesFollowersOnlyBefore } : {}),
      ...(l.makeNotesHiddenBefore !== undefined ? { makeNotesHiddenBefore: l.makeNotesHiddenBefore } : {}),
      ...(l.instance !== undefined ? { instance: l.instance } : {}),
      ...(l.badgeRoles !== undefined ? { badgeRoles: l.badgeRoles } : {}),
    });
  }

  return packed;
}
