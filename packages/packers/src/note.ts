import { parseAidx } from "../../id/src/index.js";
import type { DriveFile, Note, UserLite } from "../../misskey-js-types/src/index.js";
import type { PackNoteSource } from "./context.js";

export interface PackNoteOptions {
  detail?: boolean;
  /** Pre-packed author (required for Nest-free pack — no DB loaders). */
  user: UserLite;
  files?: DriveFile[];
  myReaction?: string | null;
  reply?: Note | null;
  renote?: Note | null;
  /** NoteEntityService.populatePoll result (detail only) */
  poll?: Note["poll"];
  /** Channel summary for channel notes (NoteEntityService.pack `channel`) */
  channel?: NoteChannel | null;
  /** CustomEmojiService.populateEmojis of the remote reaction emojis */
  reactionEmojis?: Record<string, string>;
  /** CustomEmojiService.populateEmojis(note.emojis, host) (remote notes) */
  emojis?: Record<string, string>;
  /** pack option withReactionAndUserPairCache */
  reactionAndUserPairCache?: string[];
}

/** The `channel` object upstream embeds in channel notes. */
export type NoteChannel = { id: string; name: string; color: string; isSensitive: boolean; allowRenoteToExternal: boolean; userId: string | null };

/** ReactionService.decodeReaction(...).reaction: `:name:` → `:name@.:`, `:name@host:` kept. */
export function decodeReactionKey(r: string): string {
  const m = /^:([\w+-]+)(?:@([\w.-]+))?:$/.exec(r);
  return m ? `:${m[1]}@${m[2] ?? "."}:` : r;
}

const LEGACY_REACTIONS: Record<string, string> = {
  like: "👍",
  love: "\u2764",
  laugh: "😆",
  hmm: "🤔",
  surprise: "😮",
  congrats: "🎉",
  angry: "💢",
  confused: "😥",
  rip: "😇",
  pudding: "🍮",
  star: "⭐",
};

/** ReactionService.convertLegacyReaction */
export function convertLegacyReaction(r: string): string {
  const d = decodeReactionKey(r);
  return Object.hasOwn(LEGACY_REACTIONS, d) ? LEGACY_REACTIONS[d]! : d;
}

/** ReactionService.convertLegacyReactions: drop zero counts, decode keys, merge duplicates. */
export function convertLegacyReactions(reactions: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(reactions)) {
    if (!(v > 0)) continue;
    const key = convertLegacyReaction(k);
    out[key] = (out[key] ?? 0) + v;
  }
  return out;
}

/**
 * Nest-free Note packer (NoteEntityService.pack fields). The database-backed parts (author,
 * files, reply / renote, poll, emojis, myReaction) come in `opts`; treatVisibility / hideNote
 * are applied by the api's packNotesFromPg.
 */
export function packNote(note: PackNoteSource, opts: PackNoteOptions): Note {
  const detail = opts.detail ?? true;
  const reactions = convertLegacyReactions(note.reactions);
  const reactionCount = Object.values(reactions).reduce((a, b) => a + b, 0);

  let text = note.text;
  if (note.name && (note.url ?? note.uri)) {
    text = `【${note.name}】\n${(note.text ?? "").trim()}\n\n${note.url ?? note.uri}`;
  }

  const createdAt = parseAidx(note.id).date.toISOString();

  const packed: Note = {
    id: note.id,
    createdAt,
    userId: note.userId,
    user: opts.user,
    text,
    cw: note.cw,
    visibility: note.visibility,
    localOnly: note.localOnly,
    reactionAcceptance: note.reactionAcceptance as Note["reactionAcceptance"],
    renoteCount: note.renoteCount,
    repliesCount: note.repliesCount,
    reactionCount,
    reactions,
    reactionEmojis: opts.reactionEmojis ?? {},
    fileIds: note.fileIds,
    files: opts.files ?? [],
    replyId: note.replyId,
    renoteId: note.renoteId,
  };

  if (note.visibility === "specified") {
    packed.visibleUserIds = note.visibleUserIds;
  }
  if (note.tags.length > 0) packed.tags = note.tags;
  if (note.mentions.length > 0) packed.mentions = note.mentions;
  if (note.hasPoll) packed.hasPoll = true;
  if (note.uri) packed.uri = note.uri;
  if (note.url) packed.url = note.url;
  if (note.channelId) packed.channelId = note.channelId;
  if (note.channelId && opts.channel) (packed as Record<string, unknown>).channel = opts.channel;
  if (note.userHost != null) packed.emojis = opts.emojis ?? {};
  if (opts.reactionAndUserPairCache) (packed as Record<string, unknown>).reactionAndUserPairCache = opts.reactionAndUserPairCache;

  if (detail) {
    packed.clippedCount = note.clippedCount ?? 0;
    if (note.replyId) packed.reply = opts.reply === undefined ? null : opts.reply;
    if (note.renoteId) packed.renote = opts.renote === undefined ? null : opts.renote;
    if (note.hasPoll && opts.poll) packed.poll = opts.poll;
    if (opts.myReaction) packed.myReaction = convertLegacyReaction(opts.myReaction);
  }

  return packed;
}

export function packNotes(notes: PackNoteSource[], opts: Omit<PackNoteOptions, "user"> & { users: Map<string, UserLite> }): Note[] {
  return notes.map((n) => {
    const user = opts.users.get(n.userId);
    if (!user) throw new Error(`packNotes: missing packed user for ${n.userId}`);
    return packNote(n, { ...opts, user });
  });
}
