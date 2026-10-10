/**
 * Workers RPC interfaces of the Durable Objects on the hot paths (fanout, streaming, timelines,
 * notifications, queue counters, rate limits). Each class extends `DurableObject` from
 * `cloudflare:workers` and implements its interface, so callers invoke typed methods on the stub
 * instead of `stub.fetch` + JSON.
 */

import type { OpsEvent, OpsQueueStats } from "./ops.js";
import type { QueueJobEntry, QueueType, QueueTypeStats } from "./queue-jobs.js";

/** A Durable Object id as the namespaces hand it out. */
export type DoId = { toString(): string };

/** A namespace binding whose stubs expose `T`'s methods (and `fetch`). */
export type DoNs<T> = {
  idFromName(name: string): DoId;
  get(id: DoId): T & { fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> };
};

// ---------------------------------------------------------------- misskey-cf-timeline

export type OpsStatsSnapshot = {
  queues: Record<string, OpsQueueStats & { backlogEstimate: number }>;
  recentErrors: unknown[];
};

/** admin/queue/* job ring (packages/timeline/src/ops-jobs.ts). */
export type OpsQueueJobIndexItem = { id: string; state: "failed" | "delayed"; host: string | null; at: number };
export type OpsQueueControlView = { paused: QueueType[]; cancelled: string[] };
export type OpsQueueTypesView = {
  types: Partial<Record<QueueType, QueueTypeStats>>;
  paused: QueueType[];
  index: Partial<Record<QueueType, OpsQueueJobIndexItem[]>>;
};
export type OpsQueueOp =
  | { op: "pause" | "resume"; type: QueueType }
  | { op: "remove"; type: QueueType; ids: string[] }
  | { op: "clear"; type: QueueType; state?: string };
export type OpsQueueOpResult = { paused: QueueType[] } | { removed: OpsQueueJobIndexItem[] };

export interface OpsStatsRpc {
  record(ev: OpsEvent): Promise<void>;
  stats(): Promise<OpsStatsSnapshot>;
  reset(): Promise<void>;
  /** Paused types and the message ids the consumer acks without running. */
  queueControl(): Promise<OpsQueueControlView>;
  /** Per-type counters, paused types and the failed / delayed index of every type. */
  queueTypes(): Promise<OpsQueueTypesView>;
  /** The ring's jobs of a type, newest first ([] for an unknown type). */
  queueJobs(type: QueueType): Promise<QueueJobEntry[]>;
  /** One job of the ring; null when it is not there. */
  queueJob(type: QueueType, id: string): Promise<QueueJobEntry | null>;
  /** pause / resume / remove / clear; null for an invalid op. */
  queueOp(op: OpsQueueOp): Promise<OpsQueueOpResult | null>;
}

export type TimelineListQuery = { untilId?: string | null; sinceId?: string | null; limit?: number };

export interface TimelineShardRpc {
  /** Newest first, at most `limit` (1–100, default 10). */
  list(q: TimelineListQuery): Promise<string[]>;
  append(noteId: string, maxLen?: number): Promise<void>;
  remove(noteId: string): Promise<void>;
}

export type NotificationItem = {
  id: string;
  createdAt: string;
  type: string;
  notifierId?: string | null;
  noteId?: string | null;
  reaction?: string | null;
  [k: string]: unknown;
};

export type NotificationListQuery = {
  limit?: number;
  untilId?: string | null;
  sinceId?: string | null;
  types?: string[] | null;
  unreadOnly?: boolean;
};

export interface NotificationBoxRpc {
  list(q: NotificationListQuery): Promise<{ items: (NotificationItem & { isRead: boolean })[]; latestReadId: string }>;
  unreadCount(): Promise<number>;
  /** Stores the item (about the newest NOTIF_MAX kept). */
  push(item: NotificationItem): Promise<void>;
  markAllRead(): Promise<{ latestReadId: string; hadUnread: boolean; hasAny: boolean }>;
  flush(): Promise<void>;
}

// ---------------------------------------------------------------- misskey-cf-stream

export type NoteRelationRpc = { followsAuthorWithReplies?: boolean; follows?: string[] };
export type PublishEvent = { channel: string; type: string; body: unknown; rel?: NoteRelationRpc };

export interface StreamHubRpc {
  /** Frames for the sockets subscribed to each event's channel; `sockets` = open sockets (0: user offline). */
  publish(events: PublishEvent[]): Promise<{ delivered: number; sockets: number }>;
  /** Top-level `noteUpdated` to the sockets capturing the note. */
  noteUpdated(id: string, type: string, body: unknown): Promise<number>;
  /** Top-level `{ type, body }` to every socket. */
  broadcast(type: string, body: unknown): Promise<number>;
}

export interface StreamPresenceRpc {
  set(userId: string, channels: string[]): Promise<void>;
  remove(userIds: string[]): Promise<void>;
  /** Which of these users are online, with their channels. */
  lookup(userIds: string[]): Promise<Record<string, string[]>>;
  /** Every online user. */
  all(): Promise<string[]>;
  /** Online users subscribed to any of these channels, with their channels. */
  subscribers(channels: string[]): Promise<Record<string, string[]>>;
  online(): Promise<number>;
  /**
   * Publish a note to this shard's users (each target: the channels to receive it on), one
   * StreamHub call per user from here, so the caller makes one call per shard. Users whose hub
   * has no socket left are dropped, unless they registered again after the delivery started.
   */
  deliverNote(body: unknown, targets: NoteTarget[]): Promise<{ delivered: number; pruned: number }>;
  /** upstream publishBroadcastStream for this shard's online users: `{ type, body }` to every socket. */
  broadcast(type: string, body: unknown): Promise<number>;
}

export type NoteTarget = { userId: string; channels: string[]; rel?: NoteRelationRpc };

export interface NoteWatchRpc {
  set(userId: string, add: string[], remove: string[]): Promise<void>;
  lookup(noteId: string): Promise<string[]>;
}

// ---------------------------------------------------------------- misskey-cf-api

export type RateLimitWindow = { id: string; duration: number; max: number };
export type RateLimitInfo = { total: number; remaining: number; reset: number; resetMs: number };

export interface RateLimiterRpc {
  /** Checks the windows in order; the first full one wins. */
  limit(windows: RateLimitWindow[]): Promise<{ limited: false } | { limited: true; index: number; info: RateLimitInfo }>;
}
