import type { TimelineFanoutMessage } from "../../../shared/src/index.js";
import type { ApiEnv } from "../env.js";
import { recordOps } from "../../../shared/src/ops.js";
import { chunkForSendBatch } from "../../../shared/src/queue-jobs.js";

export type { TimelineFanoutMessage };

export const MK_TIMELINE_FANOUT = "mk-timeline-fanout" as const;
export const MK_DELIVER = "mk-deliver" as const;
export const MK_INBOX = "mk-inbox" as const;

export type SendOptions = { delaySeconds?: number };

export interface QueueProducer<T = unknown> {
  send(queue: string, message: T, opts?: SendOptions): Promise<void>;
  /** Several messages to one queue (Queues `sendBatch`); defaults to one `send` each. */
  sendBatch?(queue: string, messages: T[], opts?: SendOptions): Promise<void>;
}

export { chunkForSendBatch };

/** `producer.sendBatch` when it has one, else one `send` per message. */
export async function sendAll<T>(producer: QueueProducer<T>, queue: string, messages: T[], opts?: SendOptions): Promise<void> {
  if (!messages.length) return;
  if (producer.sendBatch) return producer.sendBatch(queue, messages, opts);
  for (const m of messages) await producer.send(queue, m, opts);
}

/** Test double: records every send. */
export class InMemoryQueueProducer implements QueueProducer {
  readonly messages: { queue: string; body: unknown; delaySeconds?: number }[] = [];

  async send(queue: string, message: unknown, opts?: SendOptions): Promise<void> {
    this.messages.push({ queue, body: message, ...(opts?.delaySeconds ? { delaySeconds: opts.delaySeconds } : {}) });
  }

  ofQueue<T = unknown>(queue: string): T[] {
    return this.messages.filter((m) => m.queue === queue).map((m) => m.body as T);
  }

  clear(): void {
    this.messages.length = 0;
  }
}

/** Cloudflare Queues producer adapter (Q_* bindings). */
export class CfQueueProducer implements QueueProducer {
  constructor(private readonly env: ApiEnv) {}

  private binding(queue: string) {
    const binding =
      queue === MK_TIMELINE_FANOUT
        ? this.env.Q_TIMELINE_FANOUT
        : queue === MK_DELIVER
          ? this.env.Q_DELIVER
          : queue === MK_INBOX
            ? this.env.Q_INBOX
            : undefined;
    if (!binding) {
      throw new Error(`QUEUE_UNBOUND:${queue}`);
    }
    return binding;
  }

  async send(queue: string, message: unknown, opts?: SendOptions): Promise<void> {
    await this.binding(queue).send(message, opts?.delaySeconds ? { delaySeconds: opts.delaySeconds } : undefined);
    await recordOps(this.env.OPS_STATS, { queue, enqueued: 1 });
  }

  async sendBatch(queue: string, messages: unknown[], opts?: SendOptions): Promise<void> {
    const binding = this.binding(queue);
    const delay = opts?.delaySeconds ? { delaySeconds: opts.delaySeconds } : undefined;
    for (const chunk of chunkForSendBatch(messages)) {
      if (binding.sendBatch) await binding.sendBatch(chunk.map((body) => ({ body })), delay);
      else for (const body of chunk) await binding.send(body, delay);
    }
    // one counter update for the whole batch (OpsStats is a single DO)
    await recordOps(this.env.OPS_STATS, { queue, enqueued: messages.length });
  }
}

const producers = new WeakMap<object, QueueProducer>();

export function getQueueProducer(env: object): QueueProducer {
  let p = producers.get(env);
  if (!p) {
    const e = env as ApiEnv;
    p =
      e.Q_TIMELINE_FANOUT || e.Q_DELIVER || e.Q_INBOX
        ? new CfQueueProducer(e)
        : new InMemoryQueueProducer();
    producers.set(env, p);
  }
  return p;
}

export function setQueueProducer(env: object, producer: QueueProducer): void {
  producers.set(env, producer);
}

/**
 * In-memory TimelineShard: map timelineKey → note id list (newest first).
 */
export type TimelineShardMap = Map<string, string[]>;

export interface ConsumeFanoutOptions {
  /** Max ids retained per timeline key (default 1000). */
  maxLen?: number;
}

/**
 * Pure fanout consumer: append noteId to each timelineKeys list, trim maxlen.
 * Does not touch Postgres — mirrors TimelineShard DO behavior for offline tests.
 */
export function consumeTimelineFanout(
  shards: TimelineShardMap,
  message: TimelineFanoutMessage,
  opts: ConsumeFanoutOptions = {},
): TimelineShardMap {
  const maxLen = opts.maxLen ?? 1000;
  if (message.reason === "delete") {
    for (const key of message.timelineKeys) {
      const list = shards.get(key);
      if (!list) continue;
      shards.set(
        key,
        list.filter((id) => id !== message.noteId),
      );
    }
    return shards;
  }

  for (const key of message.timelineKeys) {
    const prev = shards.get(key) ?? [];
    const next = [message.noteId, ...prev.filter((id) => id !== message.noteId)];
    shards.set(key, next.slice(0, maxLen));
  }
  return shards;
}

export function buildFanoutMessage(
  noteId: string,
  timelineKeys: string[],
  reason: TimelineFanoutMessage["reason"] = "create",
  extra: {
    authorId?: string;
    visibility?: string;
    visibleUserIds?: string[];
    packed?: unknown;
    renoteOf?: string | null;
    relatedUserIds?: string[];
    channelId?: string | null;
  } = {},
): TimelineFanoutMessage {
  // Queue messages are capped at 128KB; drop the packed note if it is large.
  const packed =
    extra.packed !== undefined && JSON.stringify(extra.packed).length <= 64 * 1024 ? extra.packed : undefined;
  return {
    noteId,
    timelineKeys,
    reason,
    authorId: extra.authorId,
    visibility: extra.visibility,
    visibleUserIds: extra.visibleUserIds,
    ...(packed !== undefined ? { packed } : {}),
    ...(extra.renoteOf ? { renoteOf: extra.renoteOf } : {}),
    ...(extra.relatedUserIds?.length ? { relatedUserIds: extra.relatedUserIds } : {}),
    ...(extra.channelId ? { channelId: extra.channelId } : {}),
  };
}

/** Streaming-related fanout extras for a note (renote-mute + block/mute targets). */
export function streamExtras(note: {
  renoteId: string | null;
  text: string | null;
  cw?: string | null;
  hasPoll?: boolean;
  fileIds: string[];
  renoteUserId?: string | null;
  replyUserId?: string | null;
}): { renoteOf: string | null; relatedUserIds: string[] } {
  const pure = Boolean(note.renoteId && !note.text && !note.cw && note.fileIds.length === 0 && !note.hasPoll);
  return {
    renoteOf: pure ? (note.renoteUserId ?? null) : null,
    relatedUserIds: [note.renoteUserId, note.replyUserId].filter((x): x is string => Boolean(x)),
  };
}
