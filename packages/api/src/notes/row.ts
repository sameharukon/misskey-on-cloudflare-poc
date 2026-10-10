import { genAidx } from "../../../id/src/index.js";
import type { PackNoteSource } from "../../../packers/src/index.js";

/** The timeline keys a new local or remote note is fanned out to. */
export function defaultTimelineKeysForCreate(note: PackNoteSource): string[] {
  // Channel notes reach only the channel's followers (consumer, via message.channelId);
  // upstream pushes them to no local / hybrid / global timeline and not to the author's home.
  if (note.channelId) return [];
  const keys = note.userHost == null ? [`home:${note.userId}`] : [];
  if (note.visibility === "public" && !note.localOnly && note.userHost == null) {
    keys.push("local", "hybrid");
  } else if (note.userHost == null && (note.visibility === "home" || note.localOnly)) {
    keys.push("hybrid");
  }
  // Global TL: every public, non-channel note (local or remote)
  if (note.visibility === "public" && note.channelId == null) keys.push("global");
  return keys;
}

export function createNoteRow(
  actorUserId: string,
  body: Record<string, unknown>,
  id?: string,
): PackNoteSource {
  const text = typeof body.text === "string" ? body.text : null;
  const cw = typeof body.cw === "string" ? body.cw : null;
  const visibility =
    body.visibility === "home" ||
    body.visibility === "followers" ||
    body.visibility === "specified" ||
    body.visibility === "public"
      ? body.visibility
      : "public";
  const localOnly = Boolean(body.localOnly);
  const noteId = id ?? genAidx(Date.now());
  return {
    id: noteId,
    userId: actorUserId,
    text,
    cw,
    visibility,
    localOnly,
    reactionAcceptance: null,
    visibleUserIds: Array.isArray(body.visibleUserIds)
      ? (body.visibleUserIds as string[]).filter((x) => typeof x === "string")
      : [],
    renoteCount: 0,
    repliesCount: 0,
    reactions: {},
    fileIds: Array.isArray(body.fileIds)
      ? (body.fileIds as string[]).filter((x) => typeof x === "string")
      : [],
    replyId: typeof body.replyId === "string" ? body.replyId : null,
    renoteId: typeof body.renoteId === "string" ? body.renoteId : null,
    channelId: typeof body.channelId === "string" ? body.channelId : null,
    mentions: [],
    hasPoll: false,
    uri: null,
    url: null,
    tags: [],
    emojis: [],
    userHost: null,
    clippedCount: 0,
  };
}
