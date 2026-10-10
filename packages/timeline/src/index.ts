/// <reference path="../../shared/src/cloudflare-workers.d.ts" />
import { DurableObject } from "cloudflare:workers";
import { timelineDoId, type TimelineFanoutMessage } from "@misskey-cf/shared";
import type { DoNs, NotificationBoxRpc, NotificationItem, NotificationListQuery, TimelineListQuery, TimelineShardRpc } from "../../shared/src/do-rpc.js";
import { runWithPgScope, withHyperdriveClient } from "../../db/src/hyperdrive.js";
import { streamFanout, type StreamFanoutEnv } from "./stream-fanout.js";
import { chunkForSendBatch, recordOps, runWithOpsBackground, type OpsNs } from "@misskey-cf/shared";
import { ANTENNA_TIMELINE_MAX, matchAntennas, type AntennaHit } from "./antenna.js";
import { matchRoles, ROLE_TIMELINE_MAX } from "./role-timeline.js";
import { fanoutRetryDelay, FANOUT_MAX_RETRIES } from "./fanout-retry.js";
export { OpsStats } from "./ops-stats.js";
export { checkHitAntenna, matchAntennas } from "./antenna.js";
export { planRecipients, streamFanout } from "./stream-fanout.js";

export { timelineDoId };

type SqlCursor = { toArray(): Record<string, unknown>[] };

type DurableObjectState = {
  id: { toString(): string };
  storage: {
    get<T = unknown>(key: string): Promise<T | undefined>;
    put(key: string, value: unknown): Promise<void>;
    delete(key: string): Promise<boolean | number>;
    /** SQLite-backed DO storage (`new_sqlite_classes`) */
    sql: { exec(query: string, ...bindings: unknown[]): SqlCursor };
  };
};

export type TimelineEnv = {
  TIMELINE_SHARD: DoNs<TimelineShardRpc>;
  HYPERDRIVE?: { connectionString: string };
  /** Followers streamed per fanout message (default 1000) */
  FANOUT_PAGE_SIZE?: string;
  /** Parallel antenna / role timeline appends */
  FANOUT_CONCURRENCY?: string;
  /** Queue the remaining follower pages (large accounts) */
  Q_TIMELINE_FANOUT?: { send(body: unknown): Promise<void>; sendBatch?(messages: { body: unknown }[]): Promise<void> };
  /** Queue counters for the root-only admin view */
  OPS_STATS?: OpsNs;
  /** Local host for antenna `users` accts (`@alice` = `@alice@<host>`) */
  INSTANCE_URL?: string;
} & StreamFanoutEnv;

const MAX_LEN = 1000;

/**
 * Share of appends / pushes that trim the list to its maximum (upstream FanoutTimelineService
 * trims on 10 % of pushes). A trim reads maxLen+1 rows to find the cut, so trimming every time
 * reads the whole list on every append; the list may run up to about 10 % over in between.
 */
const TRIM_PROBABILITY = 0.1;

/**
 * TimelineShard Durable Object — per-timeline (or hot-sharded) lists.
 * Class name: TimelineShard
 * Fanout: consume mk-timeline-fanout from day one (no sync fanout in request path).
 *
 * Ids live in a SQLite table (`tl`, newest `maxLen` by id), so an append or a page read touches
 * a few rows instead of rewriting the whole list. The JSON `ids` list of older deployments is
 * moved into the table on first access. Called over RPC (TimelineShardRpc).
 */
export class TimelineShard extends DurableObject implements TimelineShardRpc {
  private readonly state: DurableObjectState;
  private ready = false;
  /** Chance of trimming on an append (tests set 1). */
  trimProbability = TRIM_PROBABILITY;
  constructor(ctx: DurableObjectState, env?: unknown) {
    super(ctx, env);
    this.state = ctx;
  }

  private sql(query: string, ...bindings: unknown[]): Record<string, unknown>[] {
    return this.state.storage.sql.exec(query, ...bindings).toArray();
  }

  private async init(): Promise<void> {
    if (this.ready) return;
    this.sql(`CREATE TABLE IF NOT EXISTS tl (id TEXT PRIMARY KEY) WITHOUT ROWID`);
    const legacy = await this.state.storage.get<string[]>("ids");
    if (legacy) {
      for (const id of legacy) this.sql(`INSERT OR IGNORE INTO tl (id) VALUES (?)`, id);
      await this.state.storage.delete("ids");
    }
    this.ready = true;
  }

  async list(q: TimelineListQuery): Promise<string[]> {
    await this.init();
    const limit = Math.max(1, Math.min(100, Number(q.limit) || 10));
    // only the given cursors in the WHERE, so they are range scans on the primary key
    const where: string[] = [];
    const params: unknown[] = [];
    if (q.untilId) where.push("id < ?"), params.push(q.untilId);
    if (q.sinceId) where.push("id > ?"), params.push(q.sinceId);
    return this.sql(`SELECT id FROM tl ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ?`, ...params, limit).map((r) => String(r.id));
  }

  async append(noteId: string, maxLen: number = MAX_LEN): Promise<void> {
    await this.init();
    this.sql(`INSERT OR IGNORE INTO tl (id) VALUES (?)`, noteId);
    if (Math.random() >= this.trimProbability) return;
    const cut = this.sql(`SELECT id FROM tl ORDER BY id DESC LIMIT 1 OFFSET ?`, Math.max(1, maxLen))[0];
    if (cut) this.sql(`DELETE FROM tl WHERE id <= ?`, cut.id);
  }

  async remove(noteId: string): Promise<void> {
    await this.init();
    this.sql(`DELETE FROM tl WHERE id = ?`, noteId);
  }
}

const NOTIF_MAX = 500;

/**
 * NotificationBox Durable Object — per-user notification stream.
 * Replaces upstream's Redis stream `notificationTimeline:{userId}` (no-Redis
 * policy; upstream dropped its PG `notification` table in 1680582195041-cleanup).
 * Name: `notif:{userId}`. Newest `NOTIF_MAX` by id in a SQLite table, plus a read cursor
 * (`latestReadId`), mirroring upstream's latestReadNotification marker. The JSON `items` list of
 * older deployments is moved into the table on first access. Called over RPC (NotificationBoxRpc).
 */
export class NotificationBox extends DurableObject implements NotificationBoxRpc {
  private readonly state: DurableObjectState;
  private ready = false;
  /** Chance of trimming on a push (tests set 1). */
  trimProbability = TRIM_PROBABILITY;
  constructor(ctx: DurableObjectState, env?: unknown) {
    super(ctx, env);
    this.state = ctx;
  }

  private sql(query: string, ...bindings: unknown[]): Record<string, unknown>[] {
    return this.state.storage.sql.exec(query, ...bindings).toArray();
  }

  private insert(item: NotificationItem): void {
    this.sql(`INSERT OR REPLACE INTO notif (id, type, item) VALUES (?, ?, ?)`, item.id, item.type, JSON.stringify(item));
  }

  private async init(): Promise<void> {
    if (this.ready) return;
    this.sql(`CREATE TABLE IF NOT EXISTS notif (id TEXT PRIMARY KEY, type TEXT NOT NULL, item TEXT NOT NULL) WITHOUT ROWID`);
    const legacy = await this.state.storage.get<NotificationItem[]>("items");
    if (legacy) {
      for (const item of legacy) if (typeof item?.id === "string") this.insert(item);
      await this.state.storage.delete("items");
    }
    this.ready = true;
  }

  private count(where = "", ...bindings: unknown[]): number {
    return Number(this.sql(`SELECT count(*) AS n FROM notif ${where}`, ...bindings)[0]?.n ?? 0);
  }

  private async latestReadId(): Promise<string> {
    return (await this.state.storage.get<string>("latestReadId")) ?? "";
  }

  async list(q: NotificationListQuery): Promise<{ items: (NotificationItem & { isRead: boolean })[]; latestReadId: string }> {
    await this.init();
    const latestReadId = await this.latestReadId();
    const limit = Math.max(1, Math.min(100, Number(q.limit) || 10));
    const where: string[] = [];
    const params: unknown[] = [];
    if (q.untilId) where.push("id < ?"), params.push(q.untilId);
    if (q.sinceId) where.push("id > ?"), params.push(q.sinceId);
    if (q.types?.length) {
      const set = [...new Set(q.types)];
      where.push(`type IN (${set.map(() => "?").join(", ")})`);
      params.push(...set);
    }
    if (q.unreadOnly) where.push("id > ?"), params.push(latestReadId);
    // upstream xrange (oldest first) for sinceId only, xrevrange (newest first) otherwise
    const order = q.sinceId && !q.untilId ? "ASC" : "DESC";
    const rows = this.sql(`SELECT item FROM notif ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id ${order} LIMIT ?`, ...params, limit);
    const items = rows.map((r) => {
      const n = JSON.parse(String(r.item)) as NotificationItem;
      return { ...n, isRead: n.id <= latestReadId };
    });
    return { items, latestReadId };
  }

  /** UserEntityService.getNotificationsInfo: entries newer than the read cursor. */
  async unreadCount(): Promise<number> {
    await this.init();
    const latestReadId = await this.latestReadId();
    return latestReadId ? this.count("WHERE id > ?", latestReadId) : this.count();
  }

  async push(item: NotificationItem): Promise<void> {
    await this.init();
    this.insert(item);
    // upstream: XADD MAXLEN ~ (approximate)
    if (Math.random() >= this.trimProbability) return;
    const cut = this.sql(`SELECT id FROM notif ORDER BY id DESC LIMIT 1 OFFSET ?`, NOTIF_MAX)[0];
    if (cut) this.sql(`DELETE FROM notif WHERE id <= ?`, cut.id);
  }

  async markAllRead(): Promise<{ latestReadId: string; hadUnread: boolean; hasAny: boolean }> {
    await this.init();
    const latestReadId = await this.latestReadId();
    const newest = this.sql(`SELECT max(id) AS id FROM notif`)[0]?.id as string | null | undefined;
    const top = newest ?? latestReadId;
    // hadUnread: upstream readAllNotification only publishes when the cursor moves
    const hadUnread = top != null && (latestReadId == null || top > latestReadId);
    // skip the row write when the cursor does not move (i/notifications marks read on every call)
    if (top !== latestReadId) await this.state.storage.put("latestReadId", top);
    return { latestReadId: top, hadUnread, hasAny: newest != null };
  }

  async flush(): Promise<void> {
    await this.init();
    this.sql(`DELETE FROM notif`);
    await this.state.storage.put("latestReadId", "");
  }
}

type FanoutMsg = TimelineFanoutMessage & {
  /** Continuation: the followers of one later page (streaming only) */
  followerIds?: string[];
  /** Set on continuation messages: antennas, role timelines and public channels ran on the first */
  continuation?: boolean;
  /** Continuation of an earlier deployment: follower page cursor */
  followerCursor?: string;
};

/** Whether this message is the note's first (not a follower-page continuation). */
const isFirstMessage = (m: FanoutMsg) => !m.continuation && !m.followerCursor && !m.followerIds;

function isFanoutMessage(v: unknown): v is FanoutMsg {
  if (!v || typeof v !== "object") return false;
  const m = v as Record<string, unknown>;
  return (
    typeof m.noteId === "string" &&
    Array.isArray(m.timelineKeys) &&
    typeof m.reason === "string"
  );
}

async function appendKeysConcurrent(env: TimelineEnv, keys: string[], noteId: string, maxLen: number): Promise<void> {
  const conc = Math.max(1, Math.min(64, Number(env.FANOUT_CONCURRENCY) || 16));
  for (let i = 0; i < keys.length; i += conc) {
    await Promise.all(keys.slice(i, i + conc).map((k) => env.TIMELINE_SHARD.get(env.TIMELINE_SHARD.idFromName(timelineDoId(k))).append(noteId, maxLen)));
  }
}

function localHost(env: TimelineEnv): string {
  try {
    return env.INSTANCE_URL ? new URL(env.INSTANCE_URL).host : "";
  } catch {
    return "";
  }
}

/**
 * Antennas (first page of a created note): match, append to `antenna:{id}` (200 like upstream).
 * Best-effort like streaming: an antenna failure must not retry the home fanout.
 */
async function applyAntennas(env: TimelineEnv, message: FanoutMsg): Promise<AntennaHit[]> {
  if (message.reason !== "create" || !isFirstMessage(message) || !env.HYPERDRIVE?.connectionString) return [];
  try {
    const hits = await matchAntennas(env.HYPERDRIVE, message.noteId, message.packed, localHost(env));
    await appendKeysConcurrent(env, hits.map((h) => `antenna:${h.antennaId}`), message.noteId, ANTENNA_TIMELINE_MAX);
    return hits;
  } catch (e) {
    console.warn("antenna fanout failed", e instanceof Error ? e.message : String(e));
    return [];
  }
}

/**
 * Role timelines (first page of a created public note): append to `role:{id}` for the author's
 * public roles (1000 like upstream) and return the explorable ones for `roleTimeline` streaming.
 * Best-effort like antennas.
 */
async function applyRoleTimelines(env: TimelineEnv, message: FanoutMsg): Promise<string[]> {
  if (message.reason !== "create" || !isFirstMessage(message) || message.visibility !== "public" || !message.authorId) return [];
  if (!env.HYPERDRIVE?.connectionString) return [];
  try {
    const hits = await matchRoles(env.HYPERDRIVE, message.authorId);
    await appendKeysConcurrent(env, hits.map((h) => `role:${h.roleId}`), message.noteId, ROLE_TIMELINE_MAX);
    return hits.filter((h) => h.isExplorable).map((h) => h.roleId);
  } catch (e) {
    console.warn("role timeline fanout failed", e instanceof Error ? e.message : String(e));
    return [];
  }
}

/** Visibility → which follower homes receive the note. */
export function followerFanoutAllowed(visibility: string | undefined): boolean {
  // public / home / followers reach follower homes; specified handled separately
  return visibility == null || visibility === "public" || visibility === "home" || visibility === "followers";
}

const followersFrom = (channelId?: string) =>
  channelId ? `channel_following WHERE "followeeId" = $1` : `following WHERE "followeeId" = $1 AND "followerHost" IS NULL`;

/**
 * Local followers of authorId (followerHost IS NULL), or the followers of `channelId`, in one
 * unordered query (upstream pushToTl: one find). An ordered keyset page scans the followee's
 * rows (or the primary key backwards) on every page, which grows with the square of the count.
 */
export async function fetchLocalFollowers(env: TimelineEnv, authorId: string, channelId?: string): Promise<string[]> {
  if (!env.HYPERDRIVE?.connectionString) return [];
  return withHyperdriveClient(env.HYPERDRIVE, async (client) =>
    (await client.query(`SELECT "followerId" FROM ${followersFrom(channelId)}`, [channelId ?? authorId])).rows.map((r) => String((r as { followerId: unknown }).followerId)),
  );
}

/** Keyset page of local followers: continuations queued by an earlier deployment. */
export async function pageLocalFollowers(
  env: TimelineEnv,
  authorId: string,
  cursor: string | null,
  pageSize: number,
  channelId?: string,
): Promise<{ followerIds: string[]; next: string | null }> {
  if (!env.HYPERDRIVE?.connectionString) return { followerIds: [], next: null };
  return withHyperdriveClient(env.HYPERDRIVE, async (client) => {
    const r = cursor
      ? await client.query(`SELECT id, "followerId" FROM ${followersFrom(channelId)} AND id < $2 ORDER BY id DESC LIMIT $3`, [channelId ?? authorId, cursor, pageSize])
      : await client.query(`SELECT id, "followerId" FROM ${followersFrom(channelId)} ORDER BY id DESC LIMIT $2`, [channelId ?? authorId, pageSize]);
    const rows = r.rows as { id: string; followerId: string }[];
    const next = rows.length === pageSize ? String(rows[rows.length - 1]!.id) : null;
    return { followerIds: rows.map((x) => String(x.followerId)), next };
  });
}

/** Streaming would send nothing: no packed note, or no streaming bindings. */
function streamingOff(env: TimelineEnv, message: FanoutMsg): boolean {
  return message.packed == null || !env.STREAM_HUB || !env.STREAM_PRESENCE;
}

/** Queue continuation messages (sendBatch when available, in chunks under its size limits). */
async function enqueueContinuations(env: TimelineEnv, messages: FanoutMsg[]): Promise<void> {
  const q = env.Q_TIMELINE_FANOUT!;
  if (q.sendBatch) {
    for (const chunk of chunkForSendBatch(messages)) await q.sendBatch(chunk.map((body) => ({ body })));
  } else {
    for (const m of messages) await q.send(m);
  }
  await recordOps(env.OPS_STATS, { queue: "mk-timeline-fanout", enqueued: messages.length });
}

/**
 * Handle one fanout message. TimelineShard keeps only `antenna:` / `role:` lists (read by
 * antennas/notes and roles/notes); the timelines themselves are read from PG, so nothing is
 * written for home / local / hybrid / global. The rest is streaming: the first message streams
 * to public channel subscribers and the first page of followers, and queues the remaining
 * follower pages as continuations (`followerIds`), which only stream. Deletes need nothing here.
 */
export async function applyFanoutToShards(env: TimelineEnv, message: FanoutMsg): Promise<void> {
  if (message.reason === "delete") return;
  const pageSize = Math.max(10, Math.min(1000, Number(env.FANOUT_PAGE_SIZE) || 1000));

  if (message.followerIds) {
    await safeStream(env, message, message.followerIds, [], [], false);
    return;
  }
  if (message.followerCursor) {
    // continuation of an earlier deployment
    const legacy = message.authorId && !streamingOff(env, message)
      ? await pageLocalFollowers(env, message.authorId, message.followerCursor, pageSize, message.channelId)
      : { followerIds: [], next: null };
    await safeStream(env, message, legacy.followerIds, [], [], false);
    if (legacy.next) {
      if (env.Q_TIMELINE_FANOUT) await enqueueContinuations(env, [{ ...message, followerCursor: legacy.next }]);
      else await applyFanoutToShards(env, { ...message, followerCursor: legacy.next });
    }
    return;
  }

  const antennaHits = await applyAntennas(env, message);
  const roleIds = await applyRoleTimelines(env, message);

  if (!message.authorId || !followerFanoutAllowed(message.visibility) || streamingOff(env, message)) {
    await safeStream(env, message, [], antennaHits, roleIds, true);
    return;
  }
  const followers = await fetchLocalFollowers(env, message.authorId, message.channelId);
  const pages: string[][] = [];
  for (let i = 0; i < followers.length; i += pageSize) pages.push(followers.slice(i, i + pageSize));
  const [first = [], ...rest] = pages;
  const continuations = rest.map((followerIds): FanoutMsg => ({ ...message, followerIds, continuation: true }));
  // queue the rest before streaming, so a failed send does not stream the first page twice
  if (continuations.length && env.Q_TIMELINE_FANOUT) await enqueueContinuations(env, continuations);
  await safeStream(env, message, first, antennaHits, roleIds, true);
  if (continuations.length && !env.Q_TIMELINE_FANOUT) {
    for (const c of continuations) await applyFanoutToShards(env, c);
  }
}

/** Streaming is best-effort: never fail (and retry) the fanout because of it. */
async function safeStream(env: TimelineEnv, message: FanoutMsg, followerIds: string[], antennaHits: AntennaHit[], roleIds: string[], firstPage: boolean): Promise<void> {
  try {
    await streamFanout(env, { ...message, antennaHits, roleIds }, followerIds, firstPage);
  } catch (e) {
    console.warn("stream fanout failed", e instanceof Error ? e.message : String(e));
  }
}

type FanoutQueueMessage = { body: unknown; attempts?: number; ack(): void; retry(opts?: { delaySeconds?: number }): void };


export async function handleTimelineFanoutBatch(
  batch: { messages: FanoutQueueMessage[] },
  env: TimelineEnv,
): Promise<void> {
  let acked = 0;
  let retried = 0;
  let dropped = 0;
  let error: string | undefined;
  for (const msg of batch.messages) {
    try {
      const body = msg.body;
      if (!isFanoutMessage(body)) {
        msg.ack();
        dropped++;
        continue;
      }
      await applyFanoutToShards(env, body);
      msg.ack();
      acked++;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      const attempts = msg.attempts ?? 1;
      if (attempts > FANOUT_MAX_RETRIES) {
        // CF would drop it silently past max_retries: drop it here, visibly
        const noteId = (msg.body as { noteId?: unknown } | null)?.noteId;
        console.error(`timeline fanout dropped after ${attempts} attempts (note ${String(noteId)}): ${error}`);
        msg.ack();
        dropped++;
      } else {
        msg.retry({ delaySeconds: fanoutRetryDelay(attempts) });
        retried++;
      }
    }
  }
  await recordOps(env.OPS_STATS, { queue: "mk-timeline-fanout", acked, retried, dropped, error });
}

type QueueBatch = {
  queue: string;
  messages: FanoutQueueMessage[];
};

export default {
  async fetch(): Promise<Response> {
    return Response.json({ service: "timeline", note: "use TimelineShard DO + queue consumers" });
  },

  async queue(batch: QueueBatch, env: TimelineEnv, ctx?: { waitUntil(p: Promise<unknown>): void }): Promise<void> {
    if (batch.queue === "mk-timeline-fanout") {
      // one Postgres connection for the whole batch (follower pages, antennas, roles, stream rules);
      // OpsStats bookkeeping runs in waitUntil so it never delays the batch
      const waitUntil = ctx ? (p: Promise<unknown>) => ctx.waitUntil(p) : undefined;
      await runWithOpsBackground(waitUntil, () => runWithPgScope(() => handleTimelineFanoutBatch(batch, env)));
      return;
    }
    // This Worker consumes only mk-timeline-fanout; anything else is a binding mistake.
    throw new Error(`unexpected queue: ${batch.queue}`);
  },
};
