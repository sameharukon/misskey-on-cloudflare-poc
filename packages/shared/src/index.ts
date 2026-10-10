/** Default number of StreamHub shards (env STREAM_SHARD_COUNT can override). */
export const DEFAULT_STREAM_SHARD_COUNT = 16;

/** Default secondary shard count for hot timelines. */
export const DEFAULT_TIMELINE_HOT_SHARD_COUNT = 4;

/** FNV-1a 32-bit for stable shard routing. */
export function hash32(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * StreamPresence DO id: `stream:{userIdHash % N}` (NoteWatch uses the same hash as `notes:{n}`).
 * StreamHub itself is one DO per user (`user:{userId}`), not sharded by this helper.
 * N defaults to 16; pass shardCount from env when available.
 */
export function streamShardId(
  userId: string,
  shardCount: number = DEFAULT_STREAM_SHARD_COUNT,
): string {
  const n = Math.max(1, shardCount | 0);
  const shard = hash32(userId) % n;
  return `stream:${shard}`;
}

/**
 * Timeline DO id: `tl:{timelineKey}` or `tl:{key}:{shard % M}` when hot.
 */
export function timelineDoId(
  timelineKey: string,
  opts?: { hot?: boolean; hotShardCount?: number; hotKey?: string },
): string {
  if (opts?.hot) {
    const m = Math.max(1, (opts.hotShardCount ?? DEFAULT_TIMELINE_HOT_SHARD_COUNT) | 0);
    const seed = opts.hotKey ?? timelineKey;
    const shard = hash32(seed) % m;
    return `tl:${timelineKey}:${shard}`;
  }
  return `tl:${timelineKey}`;
}

export type FanoutReason = "create" | "delete" | "renote" | "unrenote" | "visibility";

/** Payload for mk-timeline-fanout queue */
export interface TimelineFanoutMessage {
  noteId: string;
  /**
   * Timelines the note belongs to (home:{author} / local / hybrid / global). Not written to
   * TimelineShard (timelines are read from PG): streaming uses `local` / `global` to pick the
   * localTimeline / hybridTimeline / globalTimeline subscribers.
   */
  timelineKeys: string[];
  reason: FanoutReason;
  /** When set, the consumer streams to the author's online local followers (homeTimeline / hybridTimeline) */
  authorId?: string;
  visibility?: string;
  /** For specified visibility: also stream to these users */
  visibleUserIds?: string[];
  /** Packed note for streaming pushes (omitted when too large) */
  packed?: unknown;
  /** Pure renote only: original author id. Recipients renote-muting `authorId` are skipped. */
  renoteOf?: string | null;
  /** Author ids of reply/renote targets (block/mute filtering) */
  relatedUserIds?: string[];
  /** Channel note: the consumer fans out to the channel's followers instead of the author's */
  channelId?: string;
}
export * from "./ops.js";
export * from "./queue-jobs.js";

/**
 * KV (`META_CACHE`) key of the packed MetaDetailed written by the API Worker's `meta` endpoint.
 */
export const META_PACKED_DETAILED_KEY = "meta:packed:detailed";
