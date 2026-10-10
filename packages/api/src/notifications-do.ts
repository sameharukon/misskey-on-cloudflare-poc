/**
 * Notifications backed by the NotificationBox DO (`notif:{userId}`) on
 * misskey-cf-timeline. Upstream keeps these in a Redis stream
 * (`notificationTimeline:{userId}`, NotificationService.xadd); the PG
 * `notification` table was dropped upstream (1680582195041-cleanup), and we
 * never run DDL, so a per-user DO is the no-Redis equivalent.
 *
 * Without the NOTIFICATION_BOX binding nothing is stored.
 */

import { withHyperdriveClient } from "./pg.js";
import { genAidx } from "../../id/src/index.js";
import { packUserLite, type PackConfig } from "../../packers/src/index.js";
import type { ApiEnv } from "./env.js";
import { isMutingC } from "./graph-pg.js";
import { buildPackConfig } from "./meta-source.js";
import { publishToUserStream } from "./stream-publish.js";
import { getNotesByIdsPg, getUsersByIdsPg, packNotesFromPg } from "./notes-pg.js";

export type NotificationItem = {
  id: string;
  createdAt: string;
  type: NotificationType;
  notifierId: string | null;
  noteId?: string | null;
  reaction?: string | null;
  isRead?: boolean;
  /** app notifications (notifications/create) */
  customBody?: string | null;
  customHeader?: string | null;
  customIcon?: string | null;
  appAccessTokenId?: string | null;
  /** achievementEarned */
  achievement?: string | null;
  /** roleAssigned */
  roleId?: string | null;
  /** exportCompleted */
  exportedEntity?: string | null;
  fileId?: string | null;
  /** scheduledNotePostFailed */
  noteDraftId?: string | null;
  /** chatRoomInvitationReceived */
  invitationId?: string | null;
  /** followRequestAccepted: the followee's followedMessage */
  message?: string | null;
  /** renote: the renoted note (upstream MiNotification.targetNoteId, used for grouping) */
  targetNoteId?: string | null;
};

export type NotificationType =
  | "note"
  | "follow"
  | "followRequestAccepted"
  | "receiveFollowRequest"
  | "reaction"
  | "mention"
  | "reply"
  | "renote"
  | "quote"
  | "app"
  | "test"
  | "achievementEarned"
  | "pollEnded"
  | "roleAssigned"
  | "login"
  | "createToken"
  | "exportCompleted"
  | "scheduledNotePosted"
  | "scheduledNotePostFailed"
  | "chatRoomInvitationReceived";

function box(env: ApiEnv, userId: string) {
  const ns = env.NOTIFICATION_BOX;
  if (!ns) return null;
  return ns.get(ns.idFromName(`notif:${userId}`));
}

/**
 * upstream NotificationService.createNotification's filters: the notifiee's
 * notificationRecieveConfig for the type (never / following / follower / mutualFollow /
 * followingOrFollower / list), self, and notifiers the notifiee mutes.
 */
async function shouldNotify(env: ApiEnv, notifieeId: string, type: string, notifierId: string | null): Promise<boolean> {
  if (!env.HYPERDRIVE?.connectionString) return !(notifierId && notifierId === notifieeId);
  return withHyperdriveClient(env.HYPERDRIVE, async (c) => {
    const cfgAll = (await c.query(`SELECT to_jsonb(p) -> 'notificationRecieveConfig' AS cfg FROM user_profile p WHERE "userId" = $1`, [notifieeId])).rows[0]?.cfg as Record<string, { type?: string; userListId?: string }> | null | undefined;
    const cfg = (cfgAll ?? {})[type];
    if (cfg?.type === "never") return false;
    if (!notifierId) return true;
    if (notifieeId === notifierId) return false;
    if (await isMutingC(c, notifieeId, notifierId)) return false;
    const follows = async (a: string, b: string) => (await c.query(`SELECT 1 AS x FROM following WHERE "followerId" = $1 AND "followeeId" = $2 LIMIT 1`, [a, b])).rows.length > 0;
    switch (cfg?.type) {
      case "following": return follows(notifieeId, notifierId);
      case "follower": return follows(notifierId, notifieeId);
      case "mutualFollow": return (await follows(notifieeId, notifierId)) && (await follows(notifierId, notifieeId));
      case "followingOrFollower": return (await follows(notifieeId, notifierId)) || (await follows(notifierId, notifieeId));
      case "list":
        return (await c.query(`SELECT 1 AS x FROM user_list_membership WHERE "userListId" = $1 AND "userId" = $2 LIMIT 1`, [cfg.userListId ?? null, notifierId])).rows.length > 0;
      default: return true;
    }
  });
}

/** Create a notification for `notifieeId` (upstream NotificationService.createNotification). */
export async function createNotification(
  env: ApiEnv,
  notifieeId: string,
  data: {
    type: NotificationType;
    notifierId: string | null;
    noteId?: string | null;
    reaction?: string | null;
    customBody?: string | null;
    customHeader?: string | null;
    customIcon?: string | null;
    appAccessTokenId?: string | null;
    achievement?: string | null;
    roleId?: string | null;
    exportedEntity?: string | null;
    fileId?: string | null;
    noteDraftId?: string | null;
    invitationId?: string | null;
    message?: string | null;
    targetNoteId?: string | null;
  },
): Promise<NotificationItem | null> {
  try {
    if (!(await shouldNotify(env, notifieeId, data.type, data.notifierId))) return null;
  } catch {
    /* PG trouble must not break the main action */
  }
  const item: NotificationItem = {
    id: genAidx(Date.now()),
    createdAt: new Date().toISOString(),
    type: data.type,
    notifierId: data.notifierId,
    noteId: data.noteId ?? null,
    reaction: data.reaction ?? null,
    ...(data.type === "app"
      ? { customBody: data.customBody ?? null, customHeader: data.customHeader ?? null, customIcon: data.customIcon ?? null, appAccessTokenId: data.appAccessTokenId ?? null }
      : {}),
    ...(data.type === "achievementEarned" ? { achievement: data.achievement ?? null } : {}),
    ...(data.type === "roleAssigned" ? { roleId: data.roleId ?? null } : {}),
    ...(data.type === "exportCompleted" ? { exportedEntity: data.exportedEntity ?? null, fileId: data.fileId ?? null } : {}),
    ...(data.type === "scheduledNotePostFailed" ? { noteDraftId: data.noteDraftId ?? null } : {}),
    ...(data.type === "chatRoomInvitationReceived" ? { invitationId: data.invitationId ?? null } : {}),
    ...(data.type === "renote" && data.targetNoteId ? { targetNoteId: data.targetNoteId } : {}),
    ...(data.type === "followRequestAccepted" ? { message: data.message ?? null } : {}),
  };
  const stub = box(env, notifieeId);
  if (!stub) return null;
  try {
    await stub.push(item);
  } catch {
    return null;
  }
  // Streaming: packed notification on the user's `main` channel
  if (env.STREAM_HUB && env.HYPERDRIVE?.connectionString) {
    try {
      const [packed] = await packNotificationsPg(env, [item], buildPackConfig(env), notifieeId);
      if (packed) await publishToUserStream(env, notifieeId, "main", "notification", packed);
    } catch {
      /* streaming is best-effort */
    }
  }
  // `unreadNotification` + Web Push (upstream: 2 s later, if still unread; test notifications at once)
  if (env.HYPERDRIVE?.connectionString) {
    const { schedulePush } = await import("./sw-pg.js");
    await schedulePush(env, notifieeId, item.id, data.type === "test");
  }
  return item;
}

export async function listNotifications(
  env: ApiEnv,
  userId: string,
  opts: { limit: number; untilId?: string; sinceId?: string; unreadOnly?: boolean; includeTypes?: string[]; excludeTypes?: string[] },
): Promise<NotificationItem[]> {
  const stub = box(env, userId);
  if (!stub) return [];
  // unread-only listing (internal: unread counts / push checks)
  if (opts.unreadOnly) {
    return (await stub.list({ limit: opts.limit, unreadOnly: true }).catch(() => ({ items: [] }))).items as NotificationItem[];
  }
  // upstream NotificationService.getNotifications: read `limit` entries, filter by type, and
  // move on to the next page only while a page filters down to nothing
  let sinceId = opts.sinceId;
  let untilId = opts.untilId;
  const ascending = Boolean(opts.sinceId && !opts.untilId);
  for (;;) {
    const raw = (await stub.list({ limit: opts.limit, untilId, sinceId }).catch(() => ({ items: [] }))).items as NotificationItem[];
    if (raw.length === 0) return [];
    let items = raw;
    if (opts.includeTypes && opts.includeTypes.length > 0) items = items.filter((n) => opts.includeTypes!.includes(n.type));
    else if (opts.excludeTypes && opts.excludeTypes.length > 0) items = items.filter((n) => !opts.excludeTypes!.includes(n.type));
    if (items.length !== 0) return items;
    if (ascending) sinceId = raw[raw.length - 1]!.id;
    else untilId = raw[raw.length - 1]!.id;
  }
}

/** upstream NotificationService.readAllNotification(userId, force). */
export async function markAllNotificationsRead(env: ApiEnv, userId: string, force = false): Promise<void> {
  const stub = box(env, userId);
  if (!stub) return;
  const j: { hadUnread?: boolean; hasAny?: boolean } = await stub.markAllRead().catch(() => ({}));
  // no notification at all → nothing; otherwise publish when forced or when the cursor moved
  if (!j.hasAny) return;
  const publish = force || Boolean(j.hadUnread);
  if (publish) await publishToUserStream(env, userId, "main", "readAllNotifications", undefined);
  if (publish && env.HYPERDRIVE?.connectionString) {
    try {
      const { pushNotification } = await import("./sw-pg.js");
      await pushNotification(env, userId, "readAllNotifications", undefined);
    } catch {
      /* best-effort */
    }
  }
}

/** Delete all notifications (notifications/flush). */
export async function flushNotifications(env: ApiEnv, userId: string): Promise<void> {
  const stub = box(env, userId);
  if (!stub) return;
  await stub.flush();
  await publishToUserStream(env, userId, "main", "notificationFlushed", undefined);
}

/** Unread count (capped at 100) for MeDetailed. */
/** UserEntityService.getNotificationsInfo */
export async function notificationUnreadInfo(env: ApiEnv, userId: string): Promise<{ unreadCount: number }> {
  try {
    const stub = box(env, userId);
    if (!stub) return { unreadCount: 0 };
    return { unreadCount: await stub.unreadCount() };
  } catch {
    return { unreadCount: 0 };
  }
}

const NOTE_REQUIRED_NOTIFICATION_TYPES = new Set(["note", "mention", "reply", "renote", "renote:grouped", "quote", "reaction", "reaction:grouped", "pollEnded", "scheduledNotePosted"]);

/**
 * upstream NotificationEntityService.packMany: notifiers the viewer mutes (or on a muted
 * instance), suspended or missing notifiers, deleted notes and already-resolved follow
 * requests drop the notification.
 */
export async function packNotificationsPg(
  env: ApiEnv,
  items: NotificationItem[],
  config: PackConfig,
  viewerId: string,
): Promise<Record<string, unknown>[]> {
  if (!items.length) return [];
  // #filterValidNotifier
  const notifierIds = [...new Set(items.map((n) => n.notifierId).filter((x): x is string => Boolean(x)))];
  // the notifiers are read once, for the filter and the pack
  const users = await getUsersByIdsPg(env, notifierIds, viewerId);
  const valid = await withHyperdriveClient(env.HYPERDRIVE!, async (c) => {
    // the viewer's mutings only matter when there are notifiers
    const muting = notifierIds.length
      ? new Set((await c.query(`SELECT "muteeId" FROM muting WHERE "muterId" = $1 AND "muteeId" = ANY($2::varchar[]) AND ("expiresAt" IS NULL OR "expiresAt" > now())`, [viewerId, notifierIds])).rows.map((r) => String(r.muteeId)))
      : new Set<string>();
    const inst = notifierIds.length ? (await c.query(`SELECT to_jsonb(p) -> 'mutedInstances' AS m FROM user_profile p WHERE "userId" = $1`, [viewerId])).rows[0]?.m : null;
    const mutedInstances = new Set(Array.isArray(inst) ? (inst as string[]) : []);
    const notifiers = users;
    const ok = (n: NotificationItem) => {
      if (!n.notifierId) return true;
      if (muting.has(n.notifierId)) return false;
      const u = notifiers.get(n.notifierId);
      if (!u) return false;
      if (u.host && mutedInstances.has(String(u.host))) return false;
      return !u.isSuspended;
    };
    let list = items.filter(ok);
    // already-resolved follow requests
    const reqFrom = list.filter((n) => n.type === "receiveFollowRequest").map((n) => n.notifierId!);
    if (reqFrom.length) {
      const pending = new Set((await c.query(`SELECT "followerId" FROM follow_request WHERE "followerId" = ANY($1::varchar[])`, [reqFrom])).rows.map((r) => String(r.followerId)));
      list = list.filter((n) => n.type !== "receiveFollowRequest" || pending.has(n.notifierId!));
    }
    return list;
  });
  const noteIds = [...new Set(valid.filter((n) => NOTE_REQUIRED_NOTIFICATION_TYPES.has(n.type)).map((n) => n.noteId).filter((x): x is string => Boolean(x)))];
  const notes = await getNotesByIdsPg(env, noteIds);
  const packedNotes = new Map<string, unknown>();
  if (notes.length) {
    const packed = await packNotesFromPg(env, notes, config, viewerId);
    for (const p of packed) packedNotes.set(p.id, p);
  }
  // roleAssigned → packed Role (dropped when the role is gone, as upstream)
  const roles = new Map<string, unknown>();
  const roleIds = [...new Set(valid.filter((n) => n.type === "roleAssigned" && n.roleId).map((n) => n.roleId!))];
  if (roleIds.length && env.HYPERDRIVE?.connectionString) {
    const { packRoles } = await import("./roles-pg.js");
    await withHyperdriveClient(env.HYPERDRIVE, async (c) => {
      const r = await c.query(`SELECT * FROM role WHERE id = ANY($1::varchar[])`, [roleIds]);
      for (const p of await packRoles(c, r.rows as never)) roles.set(String(p.id), p);
    });
  }
  // chatRoomInvitationReceived → packed ChatRoomInvitation (dropped when it is gone, as upstream)
  const invIds = [...new Set(valid.filter((n) => n.type === "chatRoomInvitationReceived" && n.invitationId).map((n) => n.invitationId!))];
  const invitations = invIds.length ? await (await import("./chat-pg.js")).packChatRoomInvitationsPg(env, invIds, viewerId) : new Map<string, unknown>();
  const out: Record<string, unknown>[] = [];
  for (const n of valid) {
    const u = n.notifierId ? users.get(n.notifierId) : undefined;
    if (n.notifierId && !u) continue;
    const needsNote = NOTE_REQUIRED_NOTIFICATION_TYPES.has(n.type) && n.noteId != null;
    const note = needsNote ? packedNotes.get(n.noteId!) : undefined;
    if (needsNote && !note) continue;
    const base: Record<string, unknown> = {
      id: n.id,
      createdAt: n.createdAt,
      type: n.type,
      ...(n.notifierId ? { userId: n.notifierId } : {}),
      ...(u ? { user: packUserLite(u, config) } : {}),
      ...(note != null ? { note } : {}),
    };
    if (n.type === "reaction") base.reaction = n.reaction ?? null;
    if (n.type === "roleAssigned") {
      const role = n.roleId ? roles.get(n.roleId) : undefined;
      if (!role) continue;
      base.role = role;
    }
    if (n.type === "chatRoomInvitationReceived") {
      const invitation = n.invitationId ? invitations.get(n.invitationId) : undefined;
      if (!invitation) continue;
      base.invitation = invitation;
    }
    if (n.type === "followRequestAccepted") base.message = n.message ?? null;
    if (n.type === "achievementEarned") base.achievement = n.achievement ?? null;
    if (n.type === "exportCompleted") {
      base.exportedEntity = n.exportedEntity ?? null;
      base.fileId = n.fileId ?? null;
    }
    if (n.type === "app") {
      base.body = n.customBody ?? null;
      base.header = n.customHeader ?? null;
      base.icon = n.customIcon ?? null;
    }
    // scheduledNotePostFailed: upstream's pack does not embed the draft (only the schema lists `noteDraft`)
    out.push(base);
  }
  return out;
}

/** Extract local mention usernames from note text (`@name` or `@name@localhost`). */
export function extractLocalMentions(text: string | null | undefined, localHost: string | null): string[] {
  if (!text) return [];
  const re = /(?<![\w@/])@([A-Za-z0-9_]{1,128})(?:@([A-Za-z0-9.-]+))?/g;
  const out = new Set<string>();
  for (const m of text.matchAll(re)) {
    const host = m[2]?.toLowerCase() ?? null;
    if (host && host !== (localHost ?? "").toLowerCase()) continue;
    out.add(m[1]!.toLowerCase());
  }
  return [...out];
}
