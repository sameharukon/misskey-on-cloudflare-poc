/**
 * upstream NoteCreateService.fetchAndCreate / create / insertNote / postNoteCreated for a local
 * user, on PG. Timeline fanout, antennas and stream delivery go through `mk-timeline-fanout`
 * (pushToTl / publishNotesStream / addNoteToAntennas); notifications through NotificationBox.
 */

import * as mfm from "mfm-js";
import { genAidx } from "../../id/src/index.js";
import type { PackNoteSource } from "../../packers/src/index.js";
import type { ApiEnv } from "./env.js";
import { buildPackConfig } from "./meta-source.js";
import { withHyperdriveClient, type PgQueryable } from "./pg.js";
import { afterResponse } from "./handler-kit.js";
import { isPureRenote, packNoteFromPg, packNotesFromPg, rowToPackNote } from "./notes-pg.js";
import { canViewNote } from "./visibility.js";
import { metaRowPg } from "./user-lite-pg.js";
import { getUserPoliciesPg } from "./policies-pg.js";
import { isKeyWordIncluded, normalizeForSearch, updateHashtagsPg } from "./search-pg.js";
import { insertPollPg } from "./polls/pack.js";
import { createNotification, type NotificationItem } from "./notifications-do.js";
import { publishEventsToUserStream, publishToUserStream } from "./stream-publish.js";
import { enqueueUserWebhook } from "./webhooks-pg.js";
import { defaultTimelineKeysForCreate } from "./notes/row.js";
import { MK_TIMELINE_FANOUT, buildFanoutMessage, getQueueProducer, streamExtras } from "./queues/fanout.js";

export type NoteCreateError =
  | "NO_SUCH_FILE"
  | "NO_SUCH_RENOTE_TARGET"
  | "CANNOT_RENOTE_TO_A_PURE_RENOTE"
  | "YOU_HAVE_BEEN_BLOCKED"
  | "CANNOT_RENOTE_DUE_TO_VISIBILITY"
  | "NO_SUCH_CHANNEL"
  | "CANNOT_RENOTE_OUTSIDE_OF_CHANNEL"
  | "NO_SUCH_REPLY_TARGET"
  | "CANNOT_REPLY_TO_A_PURE_RENOTE"
  | "CANNOT_REPLY_TO_AN_INVISIBLE_NOTE"
  | "CANNOT_REPLY_TO_SPECIFIED_VISIBILITY_NOTE_WITH_EXTENDED_VISIBILITY"
  | "CANNOT_CREATE_ALREADY_EXPIRED_POLL"
  | "CONTAINS_PROHIBITED_WORDS"
  | "CONTAINS_TOO_MANY_MENTIONS";

export type NoteCreateInput = {
  text: string | null;
  cw: string | null;
  replyId: string | null;
  renoteId: string | null;
  fileIds: string[];
  visibility: string;
  visibleUserIds: string[];
  channelId: string | null;
  localOnly: boolean;
  reactionAcceptance: string | null;
  poll: { choices: string[]; multiple: boolean; expiresAt: Date | null } | null;
  noExtractMentions?: boolean;
  noExtractHashtags?: boolean;
  noExtractEmojis?: boolean;
};

type Row = Record<string, unknown>;
type UserRow = { id: string; username: string; host: string | null; isBot: boolean; uri: string | null };
type Channel = { id: string; allowRenoteToExternal: boolean };

const DB_MAX_NOTE_TEXT_LENGTH = 8192;

const toUserRow = (r: Row): UserRow => ({ id: String(r.id), username: String(r.username), host: (r.host as string | null) ?? null, isBot: Boolean(r.isBot), uri: (r.uri as string | null) ?? null });

async function userRowC(c: PgQueryable, id: string): Promise<UserRow | null> {
  const r = (await c.query(`SELECT id, username, host, "isBot", uri FROM "user" WHERE id = $1`, [id])).rows[0];
  return r ? toUserRow(r) : null;
}

/** Users by id in one query, in the order of `ids` (missing ones dropped). */
async function userRowsC(c: PgQueryable, ids: string[]): Promise<UserRow[]> {
  if (!ids.length) return [];
  const rows = (await c.query(`SELECT id, username, host, "isBot", uri FROM "user" WHERE id = ANY($1::varchar[])`, [ids])).rows;
  const byId = new Map(rows.map((r) => [String(r.id), toUserRow(r)]));
  return ids.map((id) => byId.get(id)).filter((u): u is UserRow => u != null);
}

const unique = <T>(xs: T[]) => [...new Set(xs)];

/** NoteCreateService.fetchAndCreate + create for a local user. */
export async function createNotePg(
  env: ApiEnv,
  userId: string,
  data: NoteCreateInput,
  /** the request's waitUntil: postNoteCreated runs after the response, as upstream's setImmediate */
  waitUntil?: (p: Promise<unknown>) => void,
): Promise<{ note: PackNoteSource; mentioned: UserRow[] } | NoteCreateError> {
  const pre = await withHyperdriveClient(env.HYPERDRIVE!, async (c) => {
    const user = (await userRowC(c, userId))!;
    const visibleUsers = data.visibleUserIds.length
      ? (await c.query(`SELECT id, username, host, "isBot", uri FROM "user" WHERE id = ANY($1::varchar[])`, [data.visibleUserIds])).rows.map(toUserRow)
      : [];
    let files: Row[] = [];
    if (data.fileIds.length > 0) {
      files = (await c.query(
        `SELECT id, type FROM drive_file WHERE "userId" = $1 AND id = ANY($2::varchar[]) ORDER BY array_position($2::varchar[], id::varchar)`,
        [userId, data.fileIds],
      )).rows;
      if (files.length !== data.fileIds.length) return "NO_SUCH_FILE" as const;
    }
    let renote: PackNoteSource | null = null;
    if (data.renoteId != null) {
      const r = (await c.query(`SELECT * FROM note WHERE id = $1`, [data.renoteId])).rows[0];
      if (!r) return "NO_SUCH_RENOTE_TARGET" as const;
      renote = rowToPackNote(r);
      if (isPureRenote(renote)) return "CANNOT_RENOTE_TO_A_PURE_RENOTE" as const;
      if (renote.userId !== userId) {
        const blocked = (await c.query(`SELECT 1 AS x FROM blocking WHERE "blockerId" = $1 AND "blockeeId" = $2`, [renote.userId, userId])).rows.length > 0;
        if (blocked) return "YOU_HAVE_BEEN_BLOCKED" as const;
      }
      if (renote.visibility === "followers" && renote.userId !== userId) return "CANNOT_RENOTE_DUE_TO_VISIBILITY" as const;
      if (renote.visibility === "specified") return "CANNOT_RENOTE_DUE_TO_VISIBILITY" as const;
      if (renote.channelId && renote.channelId !== data.channelId) {
        const ch = (await c.query(`SELECT "allowRenoteToExternal" FROM channel WHERE id = $1`, [renote.channelId])).rows[0];
        if (!ch) return "NO_SUCH_CHANNEL" as const;
        if (!ch.allowRenoteToExternal) return "CANNOT_RENOTE_OUTSIDE_OF_CHANNEL" as const;
      }
    }
    let reply: (PackNoteSource & { threadId: string | null }) | null = null;
    if (data.replyId != null) {
      const r = (await c.query(`SELECT * FROM note WHERE id = $1`, [data.replyId])).rows[0];
      if (!r) return "NO_SUCH_REPLY_TARGET" as const;
      reply = { ...rowToPackNote(r), threadId: (r.threadId as string | null) ?? null };
      if (isPureRenote(reply)) return "CANNOT_REPLY_TO_A_PURE_RENOTE" as const;
      if (!(await canViewNote(env, reply, userId))) return "CANNOT_REPLY_TO_AN_INVISIBLE_NOTE" as const;
      if (reply.visibility === "specified" && data.visibility !== "specified") return "CANNOT_REPLY_TO_SPECIFIED_VISIBILITY_NOTE_WITH_EXTENDED_VISIBILITY" as const;
      if (reply.userId !== userId) {
        const blocked = (await c.query(`SELECT 1 AS x FROM blocking WHERE "blockerId" = $1 AND "blockeeId" = $2`, [reply.userId, userId])).rows.length > 0;
        if (blocked) return "YOU_HAVE_BEEN_BLOCKED" as const;
      }
    }
    if (data.poll?.expiresAt && data.poll.expiresAt.getTime() < Date.now()) return "CANNOT_CREATE_ALREADY_EXPIRED_POLL" as const;
    let channel: Channel | null = null;
    if (data.channelId != null) {
      const ch = (await c.query(`SELECT id, "allowRenoteToExternal" FROM channel WHERE id = $1 AND "isArchived" = FALSE`, [data.channelId])).rows[0];
      if (!ch) return "NO_SUCH_CHANNEL" as const;
      channel = { id: String(ch.id), allowRenoteToExternal: Boolean(ch.allowRenoteToExternal) };
    }
    const meta = await metaRowPg(c);
    const policies = await getUserPoliciesPg(env, c, userId);
    return { user, visibleUsers, files, renote, reply, channel, meta, policies };
  });
  if (typeof pre === "string") return pre;
  const { user, files, renote, reply, meta, policies } = pre;
  let { visibleUsers, channel } = pre;

  // ---- create()
  const findChannel = (id: string) => withHyperdriveClient(env.HYPERDRIVE!, async (c) => {
    const ch = (await c.query(`SELECT id, "allowRenoteToExternal" FROM channel WHERE id = $1`, [id])).rows[0];
    return ch ? { id: String(ch.id), allowRenoteToExternal: Boolean(ch.allowRenoteToExternal) } : null;
  });
  if (reply && channel && reply.channelId !== channel.id) channel = reply.channelId ? await findChannel(reply.channelId) : null;
  if (reply && channel == null && reply.channelId) channel = await findChannel(reply.channelId);
  let visibility = data.visibility ?? "public";
  let localOnly = data.localOnly ?? false;
  if (channel != null) {
    visibility = "public";
    visibleUsers = [];
    localOnly = true;
  }
  const sensitiveWords = Array.isArray(meta.sensitiveWords) ? (meta.sensitiveWords as string[]) : [];
  if (visibility === "public" && channel == null) {
    if (isKeyWordIncluded(data.cw ?? data.text ?? "", sensitiveWords)) visibility = "home";
    else if (policies.canPublicNote === false) visibility = "home";
  }
  const prohibitedWords = Array.isArray(meta.prohibitedWords) ? (meta.prohibitedWords as string[]) : [];
  const concat = `${data.cw ?? ""}${data.text ?? ""}\n${(data.poll?.choices ?? []).join("\n")}\n${[].join("\n")}`;
  if (isKeyWordIncluded(concat, prohibitedWords)) return "CONTAINS_PROHIBITED_WORDS";
  if (renote) {
    if (renote.visibility === "home" && visibility === "public") visibility = "home";
    if (renote.visibility === "followers" && (visibility === "public" || visibility === "home")) visibility = "followers";
    if (renote.localOnly && channel == null) localOnly = true;
  }
  if (reply) {
    if (reply.visibility === "home" && visibility === "public") visibility = "home";
    if (reply.visibility === "followers" && (visibility === "public" || visibility === "home")) visibility = "followers";
    if (reply.visibility === "specified" && visibility !== "specified") visibility = "specified";
    if (reply.localOnly && channel == null) localOnly = true;
  }
  let text = data.text;
  if (text) {
    if (text.length > DB_MAX_NOTE_TEXT_LENGTH) text = text.slice(0, DB_MAX_NOTE_TEXT_LENGTH);
    text = text.trim();
    if (text === "") text = null;
  } else {
    text = null;
  }
  const tokens = [
    ...(text ? mfm.parse(text) : []),
    ...(data.cw ? mfm.parse(data.cw) : []),
    ...(data.poll ? data.poll.choices.flatMap((ch) => mfm.parse(ch)) : []),
  ];
  let tags = data.noExtractHashtags ? [] : unique((mfm.extract(tokens, (n) => n.type === "hashtag") as mfm.MfmHashtag[]).map((x) => x.props.hashtag));
  const emojis = data.noExtractEmojis ? [] : unique((mfm.extract(tokens, (n) => n.type === "emojiCode" && n.props.name.length <= 100) as mfm.MfmEmojiCode[]).map((x) => x.props.name));
  let mentionedUsers: UserRow[] = [];
  if (!data.noExtractMentions) {
    const { resolveUserIdByAcct } = await import("./remote-user-resolve.js");
    const ids: string[] = [];
    for (const m of (mfm.extract(tokens, (n) => n.type === "mention") as mfm.MfmMention[]).map((x) => x.props)) {
      const id = await resolveUserIdByAcct(env, m.username, m.host ?? user.host).catch(() => null);
      if (id) ids.push(id);
    }
    const uniq = unique(ids);
    mentionedUsers = await withHyperdriveClient(env.HYPERDRIVE!, (c) => userRowsC(c, uniq));
  }
  tags = tags.filter((t) => Array.from(t).length <= 128).splice(0, 32);
  if (reply && user.id !== reply.userId && !mentionedUsers.some((u) => u.id === reply.userId)) {
    const u = await withHyperdriveClient(env.HYPERDRIVE!, (c) => userRowC(c, reply.userId));
    if (u) mentionedUsers.push(u);
  }
  if (visibility === "specified") {
    for (const u of visibleUsers) if (!mentionedUsers.some((x) => x.id === u.id)) mentionedUsers.push(u);
    if (reply && !visibleUsers.some((x) => x.id === reply.userId)) {
      const u = await withHyperdriveClient(env.HYPERDRIVE!, (c) => userRowC(c, reply.userId));
      if (u) visibleUsers = [...visibleUsers, u];
    }
  }
  if (mentionedUsers.length > 0 && mentionedUsers.length > Number(policies.mentionLimit)) return "CONTAINS_TOO_MANY_MENTIONS";

  // ---- insertNote()
  const note: PackNoteSource & { threadId: string | null } = {
    id: genAidx(Date.now()),
    userId: user.id,
    text,
    cw: data.cw ?? null,
    name: null,
    visibility: visibility as PackNoteSource["visibility"],
    localOnly,
    reactionAcceptance: data.reactionAcceptance ?? null,
    visibleUserIds: visibility === "specified" ? visibleUsers.map((u) => u.id) : [],
    renoteCount: 0,
    repliesCount: 0,
    reactions: {},
    fileIds: files.map((f) => String(f.id)),
    replyId: reply ? reply.id : null,
    renoteId: renote ? renote.id : null,
    channelId: channel ? channel.id : null,
    threadId: reply ? (reply.threadId ?? reply.id) : null,
    mentions: mentionedUsers.map((u) => u.id),
    hasPoll: data.poll != null,
    uri: null,
    url: null,
    tags: tags.map(normalizeForSearch),
    emojis,
    userHost: user.host,
    replyUserId: reply ? reply.userId : null,
    replyUserHost: reply ? reply.userHost : null,
    renoteUserId: renote ? renote.userId : null,
    renoteUserHost: renote ? renote.userHost : null,
    renoteChannelId: renote ? renote.channelId : null,
    clippedCount: 0,
    reactionAndUserPairCache: [],
  };
  await withHyperdriveClient(env.HYPERDRIVE!, async (c) => {
    let mentionedRemoteUsers = "[]";
    if (mentionedUsers.length > 0) {
      const remotes = mentionedUsers.filter((u) => u.host != null);
      const urls = new Map<string, string | null>();
      if (remotes.length) {
        for (const r of (await c.query(`SELECT "userId", url FROM user_profile WHERE "userId" = ANY($1::varchar[])`, [remotes.map((u) => u.id)])).rows) urls.set(String(r.userId), (r.url as string | null) ?? null);
      }
      mentionedRemoteUsers = JSON.stringify(remotes.map((u) => ({ uri: u.uri, ...(urls.get(u.id) ? { url: urls.get(u.id) } : {}), username: u.username, host: u.host })));
    }
    // NoteCreateService: a note with a poll is inserted together with it in one transaction
    if (data.poll) await c.query("BEGIN");
    try {
      await c.query(
        `INSERT INTO note (id, "replyId", "renoteId", "threadId", text, name, cw, "userId", "localOnly", "reactionAcceptance",
           visibility, "fileIds", "attachedFileTypes", "visibleUserIds", mentions, "mentionedRemoteUsers", emojis, tags, "hasPoll",
           "channelId", "userHost", "replyUserId", "replyUserHost", "renoteUserId", "renoteUserHost", "renoteChannelId")
         VALUES ($1,$2,$3,$4,$5,NULL,$6,$7,$8,$9,$10::note_visibility_enum,$11::varchar[],$12::varchar[],$13::varchar[],$14::varchar[],$15,$16::varchar[],$17::varchar[],$18,$19,$20,$21,$22,$23,$24,$25)`,
        [
          note.id, note.replyId, note.renoteId, note.threadId, note.text, note.cw, note.userId, note.localOnly, note.reactionAcceptance,
          note.visibility, note.fileIds, files.map((f) => String(f.type)), note.visibleUserIds, note.mentions, mentionedRemoteUsers, note.emojis, note.tags, note.hasPoll,
          note.channelId, note.userHost, note.replyUserId, note.replyUserHost, note.renoteUserId, note.renoteUserHost, note.renoteChannelId,
        ],
      );
      if (data.poll) {
        await insertPollPg(c, note, data.poll);
        await c.query("COMMIT");
      }
    } catch (e) {
      if (data.poll) await c.query("ROLLBACK").catch(() => {});
      throw e;
    }
  });
  await afterResponse(waitUntil, "postNoteCreated", () => postNoteCreated(env, note, user, { reply, renote, channel, tags, mentionedUsers, poll: data.poll, visibility }));
  return { note, mentioned: mentionedUsers };
}

/**
 * The author's own timeline connections, straight from here rather than through the fanout queue
 * (which leaves the author out of these channels), as upstream's {Home,Hybrid,Local,Global}
 * TimelineChannel see their own notes: home / hybrid always (channel notes when the author follows
 * the channel), local / global for public notes outside channels. The hub applies each
 * connection's withFiles / withRenotes / withReplies.
 */
async function publishToAuthor(env: ApiEnv, userId: string, note: PackNoteSource, noteObj: unknown): Promise<void> {
  const inChannel = note.channelId != null;
  const followsChannel = inChannel && await withHyperdriveClient(env.HYPERDRIVE!, async (c) =>
    (await c.query(`SELECT 1 AS x FROM channel_following WHERE "followerId" = $1 AND "followeeId" = $2`, [userId, note.channelId])).rows.length > 0);
  const channels: string[] = [];
  if (!inChannel || followsChannel) channels.push("homeTimeline", "hybridTimeline");
  if (!inChannel && note.visibility === "public") channels.push("localTimeline", "globalTimeline");
  await publishEventsToUserStream(env, userId, channels.map((channel) => ({ channel, type: "note", body: noteObj })));
}

/** NoteCreateService.postNoteCreated (non-silent, local user). */
async function postNoteCreated(
  env: ApiEnv,
  note: PackNoteSource & { threadId: string | null },
  user: UserRow,
  data: {
    reply: (PackNoteSource & { threadId: string | null }) | null;
    renote: PackNoteSource | null;
    channel: Channel | null;
    tags: string[];
    mentionedUsers: UserRow[];
    poll: NoteCreateInput["poll"];
    visibility: string;
  },
): Promise<void> {
  const pureRenote = data.renote != null && isPureRenote(note);
  await withHyperdriveClient(env.HYPERDRIVE!, async (c) => {
    // incNotesCountOfUser
    await c.query(`UPDATE "user" SET "updatedAt" = now(), "notesCount" = "notesCount" + 1 WHERE id = $1`, [user.id]);
    // saveReply
    if (data.reply) await c.query(`UPDATE note SET "repliesCount" = "repliesCount" + 1 WHERE id = $1`, [data.reply.id]);
    // incRenoteCount
    if (data.renote && data.renote.userId !== user.id && !user.isBot) await c.query(`UPDATE note SET "renoteCount" = "renoteCount" + 1 WHERE id = $1`, [data.renote.id]);
    if (data.channel) {
      await c.query(`UPDATE channel SET "notesCount" = "notesCount" + 1, "lastNotedAt" = now() WHERE id = $1`, [data.channel.id]);
      const n = Number((await c.query(`SELECT count(*)::int AS n FROM note WHERE "userId" = $1 AND "channelId" = $2`, [user.id, data.channel.id])).rows[0]?.n ?? 0);
      if (n === 1) await c.query(`UPDATE channel SET "usersCount" = "usersCount" + 1 WHERE id = $1`, [data.channel.id]);
    }
  });

  // what makes the note appear comes first: the pack, the author's own timeline streams and
  // the fanout to everyone else; notifications, hashtags and webhooks follow.
  // pack(note, null, { skipHide, withReactionAndUserPairCache }) → notes stream / role & antenna timelines (fanout), `note` webhook
  const [noteObj] = await packNotesFromPg(env, [note], buildPackConfig(env), null, { skipHide: true, withReactionAndUserPairCache: true, single: true });
  await publishToAuthor(env, user.id, note, noteObj);
  await getQueueProducer(env).send(
    MK_TIMELINE_FANOUT,
    buildFanoutMessage(note.id, defaultTimelineKeysForCreate(note), "create", {
      authorId: note.userId,
      visibility: note.visibility,
      visibleUserIds: note.visibleUserIds,
      packed: noteObj,
      ...streamExtras(note),
      channelId: note.channelId,
    }),
  );

  if (data.visibility === "public" || data.visibility === "home") {
    try {
      await updateHashtagsPg(env, user, data.tags);
    } catch (e) {
      console.warn(`hashtag update failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // `note` notifications to followers that turned notifications on (not for replies / specified)
  if (data.reply == null && note.visibility !== "specified") {
    // f."notify" (the column, which its index serves; not to_jsonb(f), which converts every row);
    // renote mutings of all of them in one query
    const followers = await withHyperdriveClient(env.HYPERDRIVE!, async (c) => {
      const ids = (await c.query(`SELECT "followerId" FROM following f WHERE "followeeId" = $1 AND f."notify" = 'normal'`, [user.id])).rows.map((r) => String(r.followerId));
      if (!pureRenote || ids.length === 0) return ids;
      const muting = new Set((await c.query(`SELECT "muterId" FROM renote_muting WHERE "muterId" = ANY($1::varchar[]) AND "muteeId" = $2`, [ids, user.id])).rows.map((r) => String(r.muterId)));
      return ids.filter((f) => !muting.has(f));
    });
    for (const f of followers) {
      await createNotification(env, f, { type: "note", notifierId: user.id, noteId: note.id });
    }
  }

  if (data.poll?.expiresAt) {
    try {
      const { schedulePollEnd } = await import("./polls-pg.js");
      await schedulePollEnd(env, note.id, data.poll.expiresAt);
    } catch (e) {
      console.warn(`poll timer schedule failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  await enqueueUserWebhook(env, user.id, "note", { note: noteObj });

  // NotificationManager
  const queue = new Map<string, NotificationItem["type"]>();
  const push = (target: string, reason: NotificationItem["type"]) => {
    if (target === user.id) return;
    const exist = queue.get(target);
    if (exist) {
      if (reason !== "mention") queue.set(target, reason);
    } else queue.set(target, reason);
  };
  const threadMuted = (uid: string, threadId: string) =>
    withHyperdriveClient(env.HYPERDRIVE!, async (c) => (await c.query(`SELECT 1 AS x FROM note_thread_muting WHERE "userId" = $1 AND "threadId" = $2`, [uid, threadId])).rows.length > 0);

  // createMentionedEvents
  for (const u of data.mentionedUsers.filter((x) => x.host == null)) {
    if (await threadMuted(u.id, note.threadId ?? note.id)) continue;
    const detail = await packNoteFromPg(env, note, buildPackConfig(env), u.id);
    await publishToUserStream(env, u.id, "main", "mention", detail);
    await enqueueUserWebhook(env, u.id, "mention", { note: detail });
    push(u.id, "mention");
  }
  if (data.reply && data.reply.userHost == null) {
    if (!(await threadMuted(data.reply.userId, data.reply.threadId ?? data.reply.id))) {
      push(data.reply.userId, "reply");
      await publishToUserStream(env, data.reply.userId, "main", "reply", noteObj);
      await enqueueUserWebhook(env, data.reply.userId, "reply", { note: noteObj });
    }
  }
  if (data.renote) {
    const type = pureRenote ? "renote" : "quote";
    if (data.renote.userHost == null) push(data.renote.userId, type);
    if (user.id !== data.renote.userId && data.renote.userHost == null) {
      await publishToUserStream(env, data.renote.userId, "main", "renote", noteObj);
      await enqueueUserWebhook(env, data.renote.userId, "renote", { note: noteObj });
    }
  }
  const visibleTo = note.visibility === "specified" ? new Set(note.visibleUserIds) : null;
  for (const [target, reason] of queue) {
    if (visibleTo && !visibleTo.has(target)) continue;
    await createNotification(env, target, reason === "renote"
      ? { type: reason, notifierId: user.id, noteId: note.id, targetNoteId: note.renoteId }
      : { type: reason, notifierId: user.id, noteId: note.id });
  }

  // AP deliver
  if (!note.localOnly) {
    const { deliverNoteCreate } = await import("./ap/outbound.js");
    await deliverNoteCreate(env, note);
  }
}

