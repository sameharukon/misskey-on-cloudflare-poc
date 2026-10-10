/**
 * Note CRUD + timeline id resolution via Hyperdrive / TimelineShard DO.
 */

import type { NoteChannel, PackNoteSource, PackUserSource } from "../../packers/src/index.js";
import { packDriveFile } from "./drive/pack.js";
import { fetchPollsForPack, insertPollPg, type PollInput } from "./polls/pack.js";
import { packNote, packUserLite } from "../../packers/src/index.js";
import { convertLegacyReactions, decodeReactionKey } from "../../packers/src/note.js";
import { genAidx } from "../../id/src/index.js";
import { getUserSourcesPg, metaRowPg, populateEmojisPg } from "./user-lite-pg.js";
import type { PackConfig } from "../../packers/src/context.js";
import type { DriveFile, Note } from "../../misskey-js-types/src/index.js";
import type { ApiEnv } from "./env.js";
import { withHyperdriveClient } from "./pg.js";
import { createNoteRow, defaultTimelineKeysForCreate } from "./notes/row.js";
import { timelineDoId } from "../../shared/src/index.js";

const NOTE_COLS = `
  id, "replyId", "renoteId", "threadId", text, name, cw, "userId",
  "localOnly", "reactionAcceptance", "renoteCount", "repliesCount", "clippedCount",
  "pageCount", reactions, visibility, uri, url, "fileIds", "attachedFileTypes",
  "visibleUserIds", mentions, "mentionedRemoteUsers", "reactionAndUserPairCache",
  emojis, tags, "hasPoll", "channelId", "userHost", "replyUserId", "replyUserHost",
  "renoteUserId", "renoteUserHost", "renoteChannelId"
`;

const USER_COLS = `
  id, username, name, host, "avatarId", "avatarUrl", "avatarBlurhash",
  "isBot", "isCat", "requireSigninToViewContents"
`;

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map(String);
}

function asReactions(v: unknown): Record<string, number> {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const out: Record<string, number> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      const n = Number(val);
      if (Number.isFinite(n)) out[k] = n;
    }
    return out;
  }
  return {};
}

export function rowToPackNote(row: Record<string, unknown>): PackNoteSource {
  const vis = String(row.visibility ?? "public");
  const visibility =
    vis === "home" || vis === "followers" || vis === "specified" || vis === "public"
      ? vis
      : "public";
  return {
    id: String(row.id),
    userId: String(row.userId),
    text: (row.text as string | null) ?? null,
    cw: (row.cw as string | null) ?? null,
    name: (row.name as string | null) ?? null,
    visibility,
    localOnly: Boolean(row.localOnly),
    reactionAcceptance: (row.reactionAcceptance as string | null) ?? null,
    visibleUserIds: asStringArray(row.visibleUserIds),
    renoteCount: Number(row.renoteCount ?? 0),
    repliesCount: Number(row.repliesCount ?? 0),
    reactions: asReactions(row.reactions),
    fileIds: asStringArray(row.fileIds),
    replyId: (row.replyId as string | null) ?? null,
    renoteId: (row.renoteId as string | null) ?? null,
    channelId: (row.channelId as string | null) ?? null,
    mentions: asStringArray(row.mentions),
    hasPoll: Boolean(row.hasPoll),
    uri: (row.uri as string | null) ?? null,
    url: (row.url as string | null) ?? null,
    tags: asStringArray(row.tags),
    emojis: asStringArray(row.emojis),
    userHost: (row.userHost as string | null) ?? null,
    replyUserId: (row.replyUserId as string | null) ?? null,
    renoteChannelId: (row.renoteChannelId as string | null) ?? null,
    replyUserHost: (row.replyUserHost as string | null) ?? null,
    renoteUserId: (row.renoteUserId as string | null) ?? null,
    renoteUserHost: (row.renoteUserHost as string | null) ?? null,
    clippedCount: Number(row.clippedCount ?? 0),
    reactionAndUserPairCache: asStringArray(row.reactionAndUserPairCache),
  };
}

export function rowToPackUser(row: Record<string, unknown>): PackUserSource {
  return {
    id: String(row.id),
    username: String(row.username),
    name: (row.name as string | null) ?? null,
    host: (row.host as string | null) ?? null,
    avatarId: (row.avatarId as string | null) ?? null,
    avatarUrl: (row.avatarUrl as string | null) ?? null,
    avatarBlurhash: (row.avatarBlurhash as string | null) ?? null,
    isBot: Boolean(row.isBot),
    isCat: Boolean(row.isCat),
    requireSigninToViewContents: Boolean(row.requireSigninToViewContents),
  };
}

export function usePgNotes(env: ApiEnv): boolean {
  return Boolean(env.HYPERDRIVE?.connectionString);
}

export async function insertNotePg(
  env: ApiEnv,
  note: PackNoteSource,
  opts: { attachedFileTypes?: string[]; poll?: PollInput | null } = {},
): Promise<PackNoteSource | null> {
  // One transaction, counters after the INSERT (NoteCreateService: insert, then postNoteCreated's
  // incNotesCountOfUser / saveReply / incRenoteCount): a failed INSERT changes no counter, and a
  // note whose uri is already stored (a concurrent copy of the same activity) is not inserted again.
  return withHyperdriveClient(env.HYPERDRIVE!, async (c) => {
    await c.query("BEGIN");
    try {
      if (note.replyId) {
        const rr = await c.query(`SELECT "userId", "userHost" FROM note WHERE id = $1`, [note.replyId]);
        if (rr.rows[0]) {
          note.replyUserId = String(rr.rows[0].userId);
          note.replyUserHost = (rr.rows[0].userHost as string | null) ?? null;
        }
      }
      if (note.renoteId) {
        const rn = await c.query(`SELECT "userId", "userHost", "channelId" FROM note WHERE id = $1`, [note.renoteId]);
        if (rn.rows[0]) {
          note.renoteUserId = String(rn.rows[0].userId);
          note.renoteUserHost = (rn.rows[0].userHost as string | null) ?? null;
          note.renoteChannelId = (rn.rows[0].channelId as string | null) ?? null;
        }
      }
      const inserted = await c.query(
        `INSERT INTO note (
          id, "replyId", "renoteId", "threadId", text, name, cw, "userId",
          "localOnly", "reactionAcceptance", "renoteCount", "repliesCount", "clippedCount",
          "pageCount", reactions, visibility, uri, url, "fileIds", "attachedFileTypes",
          "visibleUserIds", mentions, "mentionedRemoteUsers", "reactionAndUserPairCache",
          emojis, tags, "hasPoll", "channelId", "userHost", "replyUserId", "replyUserHost",
          "renoteUserId", "renoteUserHost", "renoteChannelId"
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8,
          $9, $10, 0, 0, 0,
          0, $11::jsonb, $12::note_visibility_enum, $13, $14, $15::varchar[], $16::varchar[],
          $17::varchar[], $18::varchar[], $19, $20::varchar[],
          $21::varchar[], $22::varchar[], $23, $24, $25, $26, $27,
          $28, $29, $30
        ) ON CONFLICT (uri) DO NOTHING RETURNING id`,
        [
          note.id,
          note.replyId,
          note.renoteId,
          note.replyId, // simplified threadId (= reply root when reply)
          note.text,
          note.name ?? null,
          note.cw,
          note.userId,
          note.localOnly,
          note.reactionAcceptance,
          JSON.stringify(note.reactions ?? {}),
          note.visibility,
          note.uri,
          note.url,
          note.fileIds,
          opts.attachedFileTypes ?? [],
          note.visibleUserIds,
          note.mentions,
          "[]",
          [],
          note.emojis,
          note.tags,
          note.hasPoll,
          note.channelId,
          note.userHost,
          note.replyUserId ?? null,
          note.replyUserHost ?? null,
          note.renoteUserId ?? null,
          note.renoteUserHost ?? null,
          note.renoteChannelId ?? null,
        ],
      );
      if (!inserted.rows[0]) {
        await c.query("ROLLBACK");
        return null;
      }
      if (opts.poll) await insertPollPg(c, note, opts.poll);
      // incNotesCountOfUser
      await c.query(`UPDATE "user" SET "updatedAt" = now(), "notesCount" = "notesCount" + 1 WHERE id = $1`, [note.userId]);
      // saveReply
      if (note.replyId) await c.query(`UPDATE note SET "repliesCount" = "repliesCount" + 1 WHERE id = $1`, [note.replyId]);
      // incRenoteCount: not for a renote of one's own note, nor by a bot
      if (note.renoteId && note.renoteUserId != null && note.renoteUserId !== note.userId) {
        await c.query(
          `UPDATE note SET "renoteCount" = "renoteCount" + 1 WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM "user" WHERE id = $2 AND "isBot")`,
          [note.renoteId, note.userId],
        );
      }
      await c.query("COMMIT");
      return note;
    } catch (e) {
      await c.query("ROLLBACK").catch(() => {});
      throw e;
    }
  });
}

export async function getNotePg(env: ApiEnv, noteId: string): Promise<PackNoteSource | null> {
  return withHyperdriveClient(env.HYPERDRIVE!, async (c) => {
    const r = await c.query(
      `SELECT ${NOTE_COLS} FROM note WHERE id = $1 LIMIT 1`,
      [noteId],
    );
    const row = r.rows[0];
    return row ? rowToPackNote(row) : null;
  });
}

/**
 * upstream NoteDeleteService.delete (not quiet): repliesCount -1 on the replied note, `deleted`
 * note stream, AP Delete / Undo(Announce), the row (renotes / replies cascade in the schema),
 * a `deleteNote` moderation log when someone else deletes it; plus the timeline fanout's
 * delete step. Counters upstream does not touch (renoteCount, the author's notesCount) stay.
 */
export async function deleteNotePg(env: ApiEnv, note: PackNoteSource, deleterId?: string): Promise<void> {
  const deletedAt = new Date();
  await withHyperdriveClient(env.HYPERDRIVE!, async (c) => {
    if (note.replyId) await c.query(`UPDATE note SET "repliesCount" = "repliesCount" - 1 WHERE id = $1`, [note.replyId]);
  });
  const { publishNoteUpdated } = await import("./note-stream.js");
  await publishNoteUpdated(env, { id: note.id, userId: note.userId, visibility: note.visibility, visibleUserIds: note.visibleUserIds }, "deleted", { deletedAt: deletedAt.toISOString() });
  if (note.userHost == null && !note.localOnly) {
    const { deliverNoteDelete } = await import("./ap/outbound.js");
    await deliverNoteDelete(env, note);
  }
  const author = await withHyperdriveClient(env.HYPERDRIVE!, async (c) => {
    const u = (await c.query(`SELECT username, host FROM "user" WHERE id = $1`, [note.userId])).rows[0];
    await c.query(`DELETE FROM note WHERE id = $1 AND "userId" = $2`, [note.id, note.userId]);
    return u;
  });
  if (deleterId && note.userId !== deleterId) {
    const { moderationLogPg } = await import("./policies-pg.js");
    await withHyperdriveClient(env.HYPERDRIVE!, (c) =>
      moderationLogPg(c, deleterId, "deleteNote", { noteId: note.id, noteUserId: note.userId, noteUserUsername: author?.username ?? null, noteUserHost: author?.host ?? null, note }, genAidx(Date.now())),
    );
  }
  // no timeline fanout: timelines are read from PG (the row is gone), and the deletion is streamed
  // as noteUpdated above
}

export async function getNotesByIdsPg(
  env: ApiEnv,
  ids: string[],
): Promise<PackNoteSource[]> {
  if (ids.length === 0) return [];
  return withHyperdriveClient(env.HYPERDRIVE!, async (c) => {
    const r = await c.query(
      `SELECT ${NOTE_COLS} FROM note WHERE id = ANY($1::varchar[])`,
      [ids],
    );
    const map = new Map(r.rows.map((row) => [String(row.id), rowToPackNote(row)]));
    // Preserve DO order
    return ids.map((id) => map.get(id)).filter((n): n is PackNoteSource => Boolean(n));
  });
}

/** Users by id as UserLite sources (with the database-backed UserLite fields, see user-lite-pg). */
export async function getUsersByIdsPg(
  env: ApiEnv,
  ids: string[],
  meId: string | null = null,
): Promise<Map<string, PackUserSource>> {
  const uniq = [...new Set(ids.filter(Boolean))];
  if (uniq.length === 0) return new Map();
  return withHyperdriveClient(env.HYPERDRIVE!, (c) => getUserSourcesPg(env, c, uniq, meId));
}

/** upstream NoteEntityService's isPureRenote (renote loaded, no reply / text / cw / files / poll). */
function isPureRenoteForPack(n: PackNoteSource, byId: Map<string, PackNoteSource>): boolean {
  return Boolean(n.renoteId && byId.has(n.renoteId)) && !(n.replyId && byId.has(n.replyId)) && n.text == null && n.cw == null && n.fileIds.length === 0 && !n.hasPoll;
}

/** misc/should-hide-note-by-time */
export function shouldHideNoteByTime(hiddenBefore: number | null | undefined, createdAt: string): boolean {
  if (hiddenBefore == null) return false;
  const t = new Date(createdAt).getTime();
  if (hiddenBefore <= 0) return (Date.now() - t) / 1000 >= Math.abs(hiddenBefore);
  return t / 1000 <= hiddenBefore;
}

/**
 * Pack notes like upstream NoteEntityService.packMany / pack: author (UserLite with the
 * viewer), files, `reply` (detail:false) and `renote` (detail:true, recursively), poll,
 * channel, remote `emojis` / `reactionEmojis`, `myReaction` (packMany's hint rules), then
 * treatVisibility (makeNotesFollowersOnlyBefore) and shouldHideNote / hideNote unless
 * `skipHide`. Notes whose author row is missing are dropped.
 */
export async function packNotesFromPg(
  env: ApiEnv,
  notes: PackNoteSource[],
  config: PackConfig,
  viewerId?: string | null,
  options: { detail?: boolean; skipHide?: boolean; withReactionAndUserPairCache?: boolean; single?: boolean } = {},
): Promise<Note[]> {
  if (notes.length === 0) return [];
  const meId = viewerId ?? null;
  const detail = options.detail ?? true;
  return withHyperdriveClient(env.HYPERDRIVE!, async (c) => {
    const byId = new Map<string, PackNoteSource>(notes.map((n) => [n.id, n]));
    // reply / renote targets (renotes are packed with detail, so follow the whole chain)
    for (let depth = 0; depth < 32; depth++) {
      const want = new Set<string>();
      for (const n of byId.values()) {
        for (const id of [n.replyId, n.renoteId]) if (id && !byId.has(id)) want.add(id);
      }
      if (want.size === 0) break;
      const r = await c.query(`SELECT ${NOTE_COLS} FROM note WHERE id = ANY($1::varchar[])`, [[...want]]);
      if (r.rows.length === 0) break;
      for (const row of r.rows) byId.set(String(row.id), rowToPackNote(row));
    }
    const all = [...byId.values()];
    const meta = await metaRowPg(c);
    // the lookups below depend only on the notes: started together, so with pg's pipeline mode
    // (PG_PIPELINE) they share a round trip; without it they run one after another as before
    const selfHost = config.host?.toLowerCase() ?? null;
    const reactionsOf = new Map(all.map((n) => [n.id, convertLegacyReactions(n.reactions)]));

    const loadUsers = async () => {
      const userSources = await getUserSourcesPg(env, c, all.map((n) => n.userId), meId);
      const users = new Map<string, ReturnType<typeof packUserLite>>();
      for (const [id, u] of userSources) users.set(id, packUserLite(u, config, { iconUrl: (meta.iconUrl as string | null) ?? null }));
      return users;
    };
    const loadFiles = async () => {
      const fileIds = [...new Set(all.flatMap((n) => n.fileIds))];
      const files = new Map<string, DriveFile>();
      if (fileIds.length) {
        const fr = await c.query(`SELECT * FROM drive_file WHERE id = ANY($1::varchar[])`, [fileIds]);
        for (const row of fr.rows) files.set(String(row.id), packDriveFileRow(row));
      }
      return files;
    };
    const loadChannels = async () => {
      const channelIds = [...new Set(all.map((n) => n.channelId).filter((x): x is string => Boolean(x)))];
      const channels = new Map<string, NoteChannel>();
      if (channelIds.length) {
        const cr = await c.query(
          `SELECT id, name, color, "isSensitive", "allowRenoteToExternal", "userId" FROM channel WHERE id = ANY($1::varchar[])`,
          [channelIds],
        );
        for (const row of cr.rows) {
          channels.set(String(row.id), {
            id: String(row.id),
            name: String(row.name),
            color: String(row.color),
            isSensitive: Boolean(row.isSensitive),
            allowRenoteToExternal: Boolean(row.allowRenoteToExternal),
            userId: (row.userId as string | null) ?? null,
          });
        }
      }
      return channels;
    };
    // packMany's myReactions hint: top-level notes older than 2s, or the renote of a pure renote.
    // A single pack (no hint) resolves every note: pair cache when it covers all reactions,
    // nothing for notes younger than 2s, else the note_reaction row.
    const loadMyReactions = async () => {
      const myReactions = new Map<string, string | null>();
      if (meId && options.single) {
        const oldId = genAidx(Date.now() - 2000);
        const need: string[] = [];
        for (const n of all) {
          const count = Object.values(convertLegacyReactions(n.reactions)).reduce((a, b) => a + b, 0);
          if (count === 0) continue;
          const cache = n.reactionAndUserPairCache ?? [];
          if (count <= cache.length) {
            const pair = cache.find((p) => p.startsWith(meId));
            myReactions.set(n.id, pair ? pair.split("/")[1]! : null);
          } else if (n.id >= oldId) {
            myReactions.set(n.id, null);
          } else need.push(n.id);
        }
        if (need.length) {
          const rr = await c.query(`SELECT "noteId", reaction FROM note_reaction WHERE "userId" = $1 AND "noteId" = ANY($2::varchar[])`, [meId, need]);
          for (const row of rr.rows) myReactions.set(String(row.noteId), String(row.reaction));
        }
      } else if (meId) {
        const oldId = genAidx(Date.now() - 2000);
        const need = new Set<string>();
        for (const n of notes) {
          if (isPureRenoteForPack(n, byId)) need.add(n.renoteId!);
          else if (n.id < oldId) need.add(n.id);
          else myReactions.set(n.id, null);
        }
        if (need.size) {
          const rr = await c.query(
            `SELECT "noteId", reaction FROM note_reaction WHERE "userId" = $1 AND "noteId" = ANY($2::varchar[])`,
            [meId, [...need]],
          );
          for (const id of need) myReactions.set(id, null);
          for (const row of rr.rows) myReactions.set(String(row.noteId), String(row.reaction));
        }
      }
      return myReactions;
    };
    // remote custom emojis (note.emojis of remote notes, remote reaction emojis)
    const loadEmojis = async () => {
      const emojiReqs = all.flatMap((n) => [
        { names: n.userHost != null ? n.emojis : [], host: n.userHost },
        {
          names: Object.keys(reactionsOf.get(n.id)!)
            .filter((x) => x.startsWith(":") && x.includes("@") && !x.includes("@."))
            .map((x) => decodeReactionKey(x).replaceAll(":", "")),
          host: n.userHost,
        },
      ]);
      const emojiMaps = await populateEmojisPg(c, emojiReqs, selfHost);
      return new Map(all.map((n, i) => [n.id, { emojis: Object.fromEntries(emojiMaps[i * 2]!), reactionEmojis: Object.fromEntries(emojiMaps[i * 2 + 1]!) }]));
    };
    const [users, files, polls, channels, myReactions, emojisOf] = await Promise.all([
      loadUsers(),
      loadFiles(),
      fetchPollsForPack(c, all.filter((n) => n.hasPoll).map((n) => n.id), meId),
      loadChannels(),
      loadMyReactions(),
      loadEmojis(),
    ]);

    // the viewer's followees (shouldHideNote, followers visibility)
    let followees: Set<string> | null = null;
    const followeesOf = async (): Promise<Set<string>> => {
      if (followees) return followees;
      // only the authors of these notes matter (the viewer may follow thousands)
      const authors = [...new Set(all.map((n) => n.userId))];
      followees = new Set((await c.query(`SELECT "followeeId" FROM following WHERE "followerId" = $1 AND "followeeId" = ANY($2::varchar[])`, [meId, authors])).rows.map((r) => String(r.followeeId)));
      return followees;
    };
    const ugcForVisitor = String(meta.ugcVisibilityForVisitor ?? "all");

    const hide = async (p: Note): Promise<void> => {
      // treatVisibility
      const u = p.user as unknown as { makeNotesFollowersOnlyBefore?: number; makeNotesHiddenBefore?: number; requireSigninToViewContents?: boolean };
      if ((p.visibility === "public" || p.visibility === "home") && shouldHideNoteByTime(u.makeNotesFollowersOnlyBefore, p.createdAt)) p.visibility = "followers";
      if (options.skipHide) return;
      // shouldHideNote
      let hidden = false;
      if (meId === p.userId) hidden = false;
      else if (meId == null && ugcForVisitor === "none") hidden = true;
      else if (u.requireSigninToViewContents && meId == null) hidden = true;
      else if (shouldHideNoteByTime(u.makeNotesHiddenBefore, p.createdAt)) hidden = true;
      else if (p.visibility === "specified" && (meId == null || !(p.visibleUserIds ?? []).includes(meId))) hidden = true;
      else if (p.visibility === "followers") {
        if (meId == null) hidden = true;
        else if (p.reply && meId === p.reply.userId) hidden = false;
        else if (p.mentions && p.mentions.includes(meId)) hidden = false;
        else hidden = !(await followeesOf()).has(p.userId);
      }
      if (hidden) {
        // hideNote
        p.visibleUserIds = undefined;
        p.fileIds = [];
        p.files = [];
        p.text = null;
        p.poll = undefined;
        p.cw = null;
        (p as Record<string, unknown>).isHidden = true;
      }
    };

    const pack = async (n: PackNoteSource, asDetail: boolean): Promise<Note | null> => {
      const user = users.get(n.userId);
      if (!user) return null;
      const reply = asDetail && n.replyId ? (byId.has(n.replyId) ? await pack(byId.get(n.replyId)!, false) : null) : undefined;
      const renote = asDetail && n.renoteId ? (byId.has(n.renoteId) ? await pack(byId.get(n.renoteId)!, true) : null) : undefined;
      const reactions = reactionsOf.get(n.id)!;
      const mine = myReactions.get(n.id);
      const packed = packNote(n, {
        user,
        detail: asDetail,
        files: n.fileIds.map((id) => files.get(id)).filter((f): f is DriveFile => Boolean(f)),
        myReaction: meId && Object.keys(reactions).length > 0 && mine ? mine : null,
        poll: polls.get(n.id) as Note["poll"] | undefined,
        channel: n.channelId ? channels.get(n.channelId) ?? null : null,
        reply,
        renote,
        reactionEmojis: emojisOf.get(n.id)!.reactionEmojis,
        emojis: emojisOf.get(n.id)!.emojis,
        reactionAndUserPairCache: options.withReactionAndUserPairCache ? (n.reactionAndUserPairCache ?? []) : undefined,
      });
      await hide(packed);
      return packed;
    };
    const out: Note[] = [];
    for (const n of notes) {
      const p = await pack(n, detail);
      if (p) out.push(p);
    }
    return out;
  });
}

/** drive_file row → packed DriveFile (subset used by note.files). */
export function packDriveFileRow(row: Record<string, unknown>): DriveFile {
  return packDriveFile(row) as unknown as DriveFile;
}

export async function packNoteFromPg(
  env: ApiEnv,
  note: PackNoteSource,
  config: PackConfig,
  viewerId?: string | null,
): Promise<Note> {
  const [packed] = await packNotesFromPg(env, [note], config, viewerId, { single: true });
  if (!packed) throw new Error(`missing user ${note.userId}`);
  return packed;
}

/** Read note ids from TimelineShard DO (optional binding). */
export async function listTimelineIdsFromDo(
  env: ApiEnv,
  timelineKey: string,
  opts: { limit: number; untilId?: string; sinceId?: string },
): Promise<string[] | null> {
  const ns = env.TIMELINE_SHARD;
  if (!ns) return null;
  try {
    const id = ns.idFromName(timelineDoId(timelineKey));
    return await ns.get(id).list({ limit: opts.limit, untilId: opts.untilId ?? null, sinceId: opts.sinceId ?? null });
  } catch {
    return null;
  }
}

/** misc/is-renote: isRenote && !isQuote (text / cw / reply / poll / files make it a quote). */
export function isPureRenote(n: { renoteId: string | null; text: string | null; fileIds: string[]; hasPoll?: boolean; cw?: string | null; replyId?: string | null }): boolean {
  return n.renoteId != null && n.text == null && n.cw == null && (n.replyId ?? null) == null && n.fileIds.length === 0 && !n.hasPoll;
}

export { createNoteRow, defaultTimelineKeysForCreate };
