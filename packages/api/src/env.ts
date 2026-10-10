import type { DoNs, NoteWatchRpc, NotificationBoxRpc, OpsStatsRpc, RateLimiterRpc, StreamHubRpc, StreamPresenceRpc, TimelineShardRpc } from "../../shared/src/do-rpc.js";

/** Cloudflare Queues producer binding. */
export type QueueBinding = {
  send(body: unknown, opts?: { delaySeconds?: number }): Promise<void>;
  sendBatch?(messages: { body: unknown }[], opts?: { delaySeconds?: number }): Promise<void>;
};

/** API Worker bindings / vars (offline-friendly). */
export interface ApiEnv {
  /** Same bootstrap JSON as gateway — used when Hyperdrive/PG unavailable. */
  BOOTSTRAP_META_JSON?: string;
  /**
   * JSON array of local custom emojis for offline `/api/emojis` + `/api/emoji`.
   * Shape: `{ id, name, originalUrl, publicUrl?, aliases?, category?, ... }[]`
   */
  /** Public instance URL for PackConfig.url / host */
  INSTANCE_URL?: string;
  /** Server version string exposed in meta.version */
  VERSION?: string;
  /** Media proxy base URL */
  MEDIA_PROXY?: string;
  /** Max upload bytes advertised in meta */
  MAX_FILE_SIZE?: string;
  /** "1": pg pipeline mode (independent queries started together share a round trip; db/hyperdrive.ts) */
  PG_PIPELINE?: string;
  /** upstream config.deactivateAntennaThreshold: ms without antennas/notes before an antenna stops (default 7 days, "0" = never) */
  DEACTIVATE_ANTENNA_THRESHOLD?: string;
  /** Optional KV (or MemoryCacheStore in tests) for meta/emojis */
  META_CACHE?: {
    get(key: string, type?: "text"): Promise<string | null>;
    put?(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
    delete?(key: string): Promise<void>;
  };
  /** Injected cache for tests — takes precedence over META_CACHE */
  __cacheStore?: import("./cache.js").CacheStore;
  /** Cloudflare Hyperdrive binding (connectionString). Unbound, the PG-backed endpoints answer 501. */
  HYPERDRIVE?: import("./db-smoke.js").HyperdriveBinding;
  /** Optional gate for first-root admin/accounts/create (upstream setupPassword). */
  SETUP_PASSWORD?: string;
  /** R2 media bucket */
  MEDIA_BUCKET?: R2Bucket;
  /** Service binding to misskey-cf-media (Container: sharp + ffmpeg) for thumbnails/webpublic */
  MEDIA?: { fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> };
  /** Queue producers (CF Queues) */
  Q_TIMELINE_FANOUT?: QueueBinding;
  Q_DELIVER?: QueueBinding;
  Q_INBOX?: QueueBinding;
  /** mk-webhook-deliver (user webhooks; consumed by this worker) */
  Q_WEBHOOK_DELIVER?: { send(body: unknown): Promise<void> };
  /** mk-jobs (background jobs such as account deletion; consumed by this worker) */
  Q_JOBS?: { send(body: unknown, opts?: { delaySeconds?: number }): Promise<void> };
  /** Test hook: replaces global fetch for ActivityPub GET/POST */
  AP_FETCH?: typeof fetch;
  /** Cross-script binding to StreamHub on misskey-cf-stream (per-user hubs) */
  STREAM_HUB?: DoNs<StreamHubRpc>;
  /** Cross-script binding to StreamPresence on misskey-cf-stream (get-online-users-count) */
  STREAM_PRESENCE?: DoNs<StreamPresenceRpc>;
  STREAM_SHARD_COUNT?: string;
  /** Cross-script binding to NoteWatch on misskey-cf-stream (note capture → noteUpdated) */
  NOTE_WATCH?: DoNs<NoteWatchRpc>;
  /** Cross-script binding to OpsStats on misskey-cf-timeline (queue counters) */
  OPS_STATS?: DoNs<OpsStatsRpc>;
  /** Cross-script binding to NotificationBox on misskey-cf-timeline */
  NOTIFICATION_BOX?: DoNs<NotificationBoxRpc>;
  /** RateLimiter DO (this worker): per-actor sliding-window logs (upstream RateLimiterService / Redis) */
  /**
   * Workers Rate Limiting (per colo, approximate): requests per client IP before work that
   * reaches out. INBOX_RATE_LIMIT: inbox POSTs before they are queued; FETCH_RATE_LIMIT:
   * `/proxy` and `/url` misses (edge cache hits are not counted). Unbound: no limit.
   */
  INBOX_RATE_LIMIT?: WorkersRateLimit;
  FETCH_RATE_LIMIT?: WorkersRateLimit;
  RATE_LIMITER?: DoNs<RateLimiterRpc>;
  /** "off" disables rate limiting (upstream: only enforced in production) */
  RATE_LIMIT?: string;
  /** "false" = do not limit anonymous calls by IP (upstream config.enableIpRateLimit, default true) */
  ENABLE_IP_RATE_LIMIT?: string;
  /** OnceGuard DO (this worker): one-time claims with a TTL (TOTP replay protection) */
  ONCE_GUARD?: {
    idFromName(name: string): { toString(): string };
    get(id: { toString(): string }): {
      fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
    };
  };
  /** PollTimer DO (this worker): alarm at poll expiresAt → pollEnded notifications */
  POLL_TIMER?: {
    idFromName(name: string): { toString(): string };
    get(id: { toString(): string }): {
      fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
    };
  };
  /** Reversi DO (this worker): matchmaking store (`match`) and per-game serializer + start alarm (`game:{id}`) */
  REVERSI?: {
    idFromName(name: string): { toString(): string };
    get(id: { toString(): string }): {
      fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
    };
  };
  /**
   * Cloudflare Email Service (Email Sending) binding (`[[send_email]] name = "EMAIL"`); used by
   * the `sendEmail` job (src/email.ts). Without it mail is logged and dropped.
   */
  EMAIL?: {
    send(m: {
      from: string | { email: string; name?: string };
      to: string | string[];
      subject: string;
      html?: string;
      text?: string;
      headers?: Record<string, string>;
    }): Promise<{ messageId: string }>;
  };
  /** Cross-script binding to TimelineShard on misskey-cf-timeline */
  TIMELINE_SHARD?: DoNs<TimelineShardRpc>;
}

/** Minimal R2 shape for typings (Workers runtime provides full API). */
type R2Bucket = {
  get(key: string, options?: { range?: { offset?: number; length?: number; suffix?: number } }): Promise<{
    arrayBuffer(): Promise<ArrayBuffer>;
    httpMetadata?: { contentType?: string };
    size?: number;
    httpEtag?: string;
    body?: ReadableStream;
  } | null>;
  head?(key: string): Promise<{ size: number; httpEtag?: string; httpMetadata?: { contentType?: string } } | null>;
  put(
    key: string,
    value: ArrayBuffer | ArrayBufferView | string | ReadableStream | Blob | null,
    options?: {
      httpMetadata?: { contentType?: string };
      customMetadata?: Record<string, string>;
    },
  ): Promise<unknown>;
  delete(keys: string | string[]): Promise<void>;
};

/** The `ratelimits` binding (Workers Rate Limiting). */
export type WorkersRateLimit = { limit(options: { key: string }): Promise<{ success: boolean }> };
