/**
 * Inventory of `note` table key columns (upstream MiNote).
 * Types only — schema authority remains upstream migrations.
 */

export type NoteVisibility = "public" | "home" | "followers" | "specified";

export type NoteReactionAcceptance =
  | null
  | "likeOnly"
  | "likeOnlyForRemote"
  | "nonSensitiveOnly"
  | "nonSensitiveOnlyForLocalLikeOnlyForRemote";

/** Row shape for `note` (subset used by Tier A + packers). */
export interface NoteRow {
  id: string;
  replyId: string | null;
  renoteId: string | null;
  threadId: string | null;
  text: string | null;
  name: string | null;
  cw: string | null;
  userId: string;
  localOnly: boolean;
  reactionAcceptance: NoteReactionAcceptance;
  renoteCount: number;
  repliesCount: number;
  clippedCount: number;
  pageCount: number;
  /** jsonb map emoji -> count */
  reactions: Record<string, number>;
  visibility: NoteVisibility;
  uri: string | null;
  url: string | null;
  fileIds: string[];
  attachedFileTypes: string[];
  visibleUserIds: string[];
  mentions: string[];
  /** JSON text of remote mention descriptors */
  mentionedRemoteUsers: string;
  reactionAndUserPairCache: string[];
  emojis: string[];
  tags: string[];
  hasPoll: boolean;
  channelId: string | null;
  /** Denormalized */
  userHost: string | null;
  replyUserId: string | null;
  replyUserHost: string | null;
  renoteUserId: string | null;
  renoteUserHost: string | null;
  renoteChannelId: string | null;
}
