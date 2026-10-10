/**
 * upstream UserEntityService.pack / packMany for the detailed schemas (UserDetailedNotMe,
 * UserDetailed = MeDetailed fields when the viewer is the user, MeDetailed), with
 * `includeSecrets`. The UserLite part comes from user-lite-pg. Newer columns are read through
 * to_jsonb so older / test schemas still work.
 */

import { packUserLite } from "../../packers/src/index.js";
import { parseAidxTime } from "../../id/src/index.js";
import type { ApiEnv } from "./env.js";
import { buildPackConfig } from "./meta-source.js";
import { withHyperdriveClient, type PgQueryable } from "./pg.js";
import { enrichUserSourcesPg, metaRowPg, rowToUserSource, USER_LITE_COLS } from "./user-lite-pg.js";
import { getUsersRolesAndPoliciesPg, isModeratorPg } from "./policies-pg.js";
import { getRootUserId } from "./users-pg.js";
import { fromSimpleArray } from "../../db/src/simple-array.js";

export type DetailedSchema = "UserDetailedNotMe" | "UserDetailed" | "MeDetailed";

type Row = Record<string, unknown>;

const iso = (v: unknown): string | null => (v == null ? null : (v instanceof Date ? v : new Date(String(v))).toISOString());

/** UserEntityService.getRelations, in one query (it was eight in a row). */
export async function getRelationsPg(c: PgQueryable, meId: string, ids: string[]): Promise<Map<string, Record<string, unknown>>> {
  const out = new Map<string, Record<string, unknown>>();
  if (!ids.length) return out;
  const rows = (await c.query(
    `SELECT t.id,
       (SELECT to_jsonb(f) FROM following f WHERE f."followerId" = $1 AND f."followeeId" = t.id LIMIT 1) AS following,
       EXISTS (SELECT 1 FROM following WHERE "followeeId" = $1 AND "followerId" = t.id) AS "isFollowed",
       EXISTS (SELECT 1 FROM follow_request WHERE "followerId" = $1 AND "followeeId" = t.id) AS "reqFromYou",
       EXISTS (SELECT 1 FROM follow_request WHERE "followeeId" = $1 AND "followerId" = t.id) AS "reqToYou",
       EXISTS (SELECT 1 FROM blocking WHERE "blockerId" = $1 AND "blockeeId" = t.id) AS "isBlocking",
       EXISTS (SELECT 1 FROM blocking WHERE "blockeeId" = $1 AND "blockerId" = t.id) AS "isBlocked",
       EXISTS (SELECT 1 FROM muting WHERE "muterId" = $1 AND "muteeId" = t.id AND ("expiresAt" IS NULL OR "expiresAt" > now())) AS "isMuted",
       EXISTS (SELECT 1 FROM renote_muting WHERE "muterId" = $1 AND "muteeId" = t.id) AS "isRenoteMuted"
     FROM unnest($2::varchar[]) AS t(id)`,
    [meId, [...new Set(ids)]],
  )).rows;
  for (const r of rows) {
    const id = String(r.id);
    out.set(id, {
      id,
      following: (r.following as Row | null) ?? null,
      isFollowing: r.following != null,
      isFollowed: Boolean(r.isFollowed),
      hasPendingFollowRequestFromYou: Boolean(r.reqFromYou),
      hasPendingFollowRequestToYou: Boolean(r.reqToYou),
      isBlocking: Boolean(r.isBlocking),
      isBlocked: Boolean(r.isBlocked),
      isMuted: Boolean(r.isMuted),
      isRenoteMuted: Boolean(r.isRenoteMuted),
    });
  }
  return out;
}

/** AnnouncementService.getUnreadAnnouncements as MeDetailed embeds them (`{ createdAt, ...entity }`). */
export async function unreadAnnouncementEntitiesPg(c: PgQueryable, userId: string): Promise<Row[]> {
  const r = await c.query(
    `SELECT to_jsonb(a) AS j, a."updatedAt" FROM announcement a
     WHERE a."isActive" = TRUE AND a.silence = FALSE
       AND (a."userId" = $1 OR a."userId" IS NULL)
       AND (a."forExistingUsers" = FALSE OR a.id > $1)
       AND a.id NOT IN (SELECT "announcementId" FROM announcement_read WHERE "userId" = $1)`,
    [userId],
  );
  return r.rows.map((row) => {
    const j = { ...(row.j as Row) };
    j.updatedAt = iso(row.updatedAt);
    return { createdAt: (parseAidxTime(String(j.id)) ?? new Date(0)).toISOString(), ...j };
  });
}

/** user uri → local id (ApPersonService.fetchPerson: database only). */
async function idsByUri(env: ApiEnv, c: PgQueryable, uris: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const base = env.INSTANCE_URL?.replace(/\/$/, "");
  const remote: string[] = [];
  for (const u of uris) {
    const m = base && u.startsWith(`${base}/users/`) ? /^([^/?#]+)$/.exec(u.slice(base.length + 7)) : null;
    if (m) out.set(u, m[1]!);
    else remote.push(u);
  }
  if (remote.length) {
    for (const r of (await c.query(`SELECT id, uri FROM "user" WHERE uri = ANY($1::varchar[])`, [remote])).rows) out.set(String(r.uri), String(r.id));
  }
  return out;
}

/**
 * Pack users with a detailed schema. `many` reproduces packMany (pinned notes only with a
 * viewer); single pack queries the pins itself. Missing users are left out.
 */
export async function packUsersDetailedPg(
  env: ApiEnv,
  ids: string[],
  meId: string | null,
  opts: { schema: DetailedSchema; includeSecrets?: boolean; many?: boolean },
): Promise<Record<string, unknown>[]> {
  const uniq = [...new Set(ids.filter(Boolean))];
  if (!uniq.length) return [];
  const config = buildPackConfig(env);
  const rootId = await getRootUserId(env);
  const packed = await withHyperdriveClient(env.HYPERDRIVE!, async (c) => {
    const meta = await metaRowPg(c);
    const urows = (await c.query(`SELECT ${USER_LITE_COLS} FROM "user" u WHERE u.id = ANY($1::varchar[])`, [uniq])).rows;
    const byId = new Map(urows.map((r) => [String(r.id), r]));
    const sources = uniq.filter((id) => byId.has(id)).map((id) => rowToUserSource(byId.get(id)!));
    await enrichUserSourcesPg(env, c, sources, meId, meta);
    const profiles = new Map<string, Row>();
    for (const r of (await c.query(`SELECT "userId", to_jsonb(p) AS p FROM user_profile p WHERE "userId" = ANY($1::varchar[])`, [uniq])).rows) profiles.set(String(r.userId), r.p as Row);
    const iAmModerator = meId ? await isModeratorPg(env, c, meId) : false;
    const relations = meId ? await getRelationsPg(c, meId, uniq.filter((id) => id !== meId)) : new Map();
    const memos = new Map<string, string>();
    if (meId) {
      try {
        for (const r of (await c.query(`SELECT "targetUserId", memo FROM user_memo WHERE "userId" = $1 AND "targetUserId" = ANY($2::varchar[])`, [meId, uniq])).rows) memos.set(String(r.targetUserId), String(r.memo));
      } catch {
        /* no user_memo table */
      }
    }
    const pins = new Map<string, string[]>();
    if (!opts.many || meId) {
      for (const r of (await c.query(
        `SELECT pin."userId", pin."noteId" FROM user_note_pining pin JOIN note ON note.id = pin."noteId" WHERE pin."userId" = ANY($1::varchar[]) ORDER BY pin.id DESC`,
        [uniq],
      )).rows) pins.set(String(r.userId), [...(pins.get(String(r.userId)) ?? []), String(r.noteId)]);
    }
    const uris = new Set<string>();
    for (const s of sources) {
      const ux = byId.get(s.id)!._u as Row;
      if (typeof ux.movedToUri === "string") uris.add(ux.movedToUri);
      for (const a of fromSimpleArray(ux.alsoKnownAs) ?? []) uris.add(a);
    }
    const uriIds = await idsByUri(env, c, [...uris]);
    const rolesAndPolicies = await getUsersRolesAndPoliciesPg(env, c, sources.map((s) => s.id));

    const out: { id: string; data: Record<string, unknown>; pinIds: string[]; pinnedPageId: string | null }[] = [];
    for (const s of sources) {
      const row = byId.get(s.id)!;
      const ux = row._u as Row;
      const p = profiles.get(s.id) ?? {};
      const isMe = meId === s.id;
      const relation = meId && !isMe ? relations.get(s.id) : null;
      const { policies, roles } = rolesAndPolicies.get(s.id)!;
      const visible = (vis: unknown) =>
        vis === "public" || isMe || iAmModerator ? true : vis === "followers" && relation && relation.isFollowing ? true : false;
      const aka = fromSimpleArray(ux.alsoKnownAs);
      const alsoKnownAs = aka?.length ? aka.map((u) => uriIds.get(u)).filter((x): x is string => x != null) : null;
      const pinIds = pins.get(s.id) ?? [];
      const data: Record<string, unknown> = {
        ...packUserLite(s, config, { iconUrl: (meta.iconUrl as string | null) ?? null }),
        url: (p.url as string | null) ?? null,
        uri: (ux.uri as string | null) ?? null,
        movedTo: typeof ux.movedToUri === "string" ? (uriIds.get(ux.movedToUri) ?? null) : null,
        alsoKnownAs,
        createdAt: (parseAidxTime(s.id) ?? new Date(0)).toISOString(),
        updatedAt: iso(ux.updatedAt),
        lastFetchedAt: iso(ux.lastFetchedAt),
        bannerUrl: ux.bannerId == null ? null : ((ux.bannerUrl as string | null) ?? null),
        bannerBlurhash: ux.bannerId == null ? null : ((ux.bannerBlurhash as string | null) ?? null),
        isLocked: Boolean(ux.isLocked),
        isSilenced: !policies.canPublicNote,
        isSuspended: Boolean(ux.isSuspended),
        description: (p.description as string | null) ?? null,
        location: (p.location as string | null) ?? null,
        birthday: (p.birthday as string | null) ?? null,
        lang: (p.lang as string | null) ?? null,
        fields: Array.isArray(p.fields) ? p.fields : [],
        verifiedLinks: Array.isArray(p.verifiedLinks) ? p.verifiedLinks : [],
        followersCount: visible(p.followersVisibility ?? "public") ? Number(ux.followersCount ?? 0) : 0,
        followingCount: visible(p.followingVisibility ?? "public") ? Number(ux.followingCount ?? 0) : 0,
        notesCount: Number(ux.notesCount ?? 0),
        pinnedNoteIds: pinIds,
        pinnedNotes: [],
        pinnedPageId: (p.pinnedPageId as string | null) ?? null,
        pinnedPage: null,
        publicReactions: s.host == null ? (p.publicReactions ?? true) : false,
        followersVisibility: p.followersVisibility ?? "public",
        followingVisibility: p.followingVisibility ?? "public",
        chatScope: typeof ux.chatScope === "string" ? ux.chatScope : "mutual",
        canChat: policies.chatAvailability === "available",
        roles: roles.filter((r) => r.isPublic).sort((a, b) => b.displayOrder - a.displayOrder).map((r) => ({
          id: r.id, name: r.name, color: r.color, iconUrl: r.iconUrl, description: r.description,
          isModerator: r.isModerator, isAdministrator: r.isAdministrator, displayOrder: r.displayOrder,
        })),
        memo: meId ? (memos.get(s.id) ?? null) : null,
        ...(iAmModerator ? { moderationNote: (p.moderationNote as string | null) ?? "" } : {}),
      };
      if (isMe || iAmModerator) {
        let securityKeys = false;
        if (p.twoFactorEnabled) {
          try {
            securityKeys = (await c.query(`SELECT 1 AS x FROM user_security_key WHERE "userId" = $1 LIMIT 1`, [s.id])).rows.length >= 1;
          } catch {
            securityKeys = false;
          }
        }
        Object.assign(data, { twoFactorEnabled: Boolean(p.twoFactorEnabled), usePasswordLessLogin: Boolean(p.usePasswordLessLogin), securityKeys });
      }
      if (isMe) {
        const unread = await unreadAnnouncementEntitiesPg(c, s.id);
        const { notificationUnreadInfo } = await import("./notifications-do.js");
        const notif = await notificationUnreadInfo(env, s.id);
        const { hasUnreadChatMessagesPg } = await import("./chat-pg.js");
        const backup = Array.isArray(p.twoFactorBackupSecret) ? p.twoFactorBackupSecret.length : 0;
        const pending = (await c.query(`SELECT 1 AS x FROM follow_request WHERE "followeeId" = $1 LIMIT 1`, [s.id])).rows.length > 0;
        Object.assign(data, {
          avatarId: (ux.avatarId as string | null) ?? null,
          bannerId: (ux.bannerId as string | null) ?? null,
          followedMessage: (p.followedMessage as string | null) ?? null,
          isModerator: rootId === s.id || roles.some((r) => r.isModerator || r.isAdministrator),
          isAdmin: rootId === s.id || roles.some((r) => r.isAdministrator),
          injectFeaturedNote: p.injectFeaturedNote ?? true,
          receiveAnnouncementEmail: p.receiveAnnouncementEmail ?? true,
          alwaysMarkNsfw: Boolean(p.alwaysMarkNsfw),
          autoSensitive: Boolean(p.autoSensitive),
          carefulBot: Boolean(p.carefulBot),
          autoAcceptFollowed: p.autoAcceptFollowed ?? true,
          noCrawle: Boolean(p.noCrawle),
          preventAiLearning: p.preventAiLearning ?? true,
          isExplorable: ux.isExplorable ?? true,
          isDeleted: Boolean(ux.isDeleted),
          twoFactorBackupCodesStock: backup === 5 ? "full" : backup > 0 ? "partial" : "none",
          hideOnlineStatus: Boolean(ux.hideOnlineStatus),
          hasUnreadSpecifiedNotes: false,
          hasUnreadMentions: false,
          hasUnreadChatMessages: await hasUnreadChatMessagesPg(c, s.id),
          hasUnreadAnnouncement: unread.length > 0,
          unreadAnnouncements: unread,
          hasUnreadAntenna: false,
          hasUnreadChannel: false,
          hasUnreadNotification: notif.unreadCount > 0,
          hasPendingReceivedFollowRequest: pending,
          unreadNotificationsCount: notif.unreadCount,
          mutedWords: p.mutedWords ?? [],
          hardMutedWords: p.hardMutedWords ?? [],
          mutedInstances: p.mutedInstances ?? [],
          mutingNotificationTypes: [],
          notificationRecieveConfig: p.notificationRecieveConfig ?? {},
          emailNotificationTypes: p.emailNotificationTypes ?? [],
          achievements: p.achievements ?? [],
          loggedInDays: Array.isArray(p.loggedInDates) ? p.loggedInDates.length : 0,
          policies,
        });
      }
      if (opts.includeSecrets) {
        let keys: Row[] = [];
        if (p.twoFactorEnabled) {
          try {
            keys = (await c.query(`SELECT id, name, "lastUsed" FROM user_security_key WHERE "userId" = $1`, [s.id])).rows;
          } catch {
            keys = [];
          }
        }
        Object.assign(data, {
          email: (p.email as string | null) ?? null,
          emailVerified: Boolean(p.emailVerified),
          securityKeysList: keys.map((k) => ({ id: String(k.id), name: String(k.name), lastUsed: iso(k.lastUsed) })),
        });
      }
      if (relation) {
        const f = relation.following as Row | null;
        Object.assign(data, {
          isFollowing: relation.isFollowing,
          isFollowed: relation.isFollowed,
          hasPendingFollowRequestFromYou: relation.hasPendingFollowRequestFromYou,
          hasPendingFollowRequestToYou: relation.hasPendingFollowRequestToYou,
          isBlocking: relation.isBlocking,
          isBlocked: relation.isBlocked,
          isMuted: relation.isMuted,
          isRenoteMuted: relation.isRenoteMuted,
          notify: (f?.notify as string | null | undefined) ?? "none",
          withReplies: Boolean(f?.withReplies ?? false),
          ...(relation.isFollowing ? { followedMessage: (p.followedMessage as string | null) ?? null } : {}),
        });
      }
      out.push({ id: s.id, data, pinIds, pinnedPageId: (p.pinnedPageId as string | null) ?? null });
    }
    // pinned page (PageEntityService.pack)
    for (const o of out) {
      if (o.pinnedPageId) {
        try {
          const { packPageById } = await import("./pages-pg.js");
          o.data.pinnedPage = await packPageById(env, c, o.pinnedPageId, meId);
        } catch {
          o.data.pinnedPage = null;
        }
      }
    }
    return out;
  });
  // pinned notes (NoteEntityService.packMany, detail)
  const allPins = [...new Set(packed.flatMap((o) => o.pinIds))];
  if (allPins.length) {
    const { getNotesByIdsPg, packNotesFromPg } = await import("./notes-pg.js");
    const notes = await packNotesFromPg(env, await getNotesByIdsPg(env, allPins), config, meId);
    const byId = new Map(notes.map((n) => [n.id, n]));
    for (const o of packed) o.data.pinnedNotes = o.pinIds.map((id) => byId.get(id)).filter(Boolean);
  }
  return packed.map((o) => o.data);
}

/** Single detailed pack (UserEntityService.pack); null when the user is missing. */
export async function packUserDetailedPg(env: ApiEnv, id: string, meId: string | null, opts: { schema: DetailedSchema; includeSecrets?: boolean }): Promise<Record<string, unknown> | null> {
  return (await packUsersDetailedPg(env, [id], meId, { ...opts, many: false }))[0] ?? null;
}
