/**
 * Job-level view of CF Queues for upstream admin/queue/* (BullMQ in upstream). CF Queues offer
 * no listing / lookup of messages, so the api consumer reports, per batch, the messages that
 * failed or were retried (body, error, attempts, timestamps) to the OpsStats DO, which keeps a
 * bounded ring per upstream queue type plus per-type counters, per-minute metrics, the paused
 * flags and a set of "cancelled" message ids (removed / promoted delayed jobs). See packages/timeline/src/ops-jobs.ts.
 */

/** upstream QueueService QUEUE_TYPES (same order). */
export const QUEUE_TYPES = [
  "system",
  "endedPollNotification",
  "postScheduledNote",
  "deliver",
  "inbox",
  "db",
  "relationship",
  "objectStorage",
  "userWebhookDeliver",
  "systemWebhookDeliver",
] as const;
export type QueueType = (typeof QUEUE_TYPES)[number];

export const isQueueType = (v: unknown): v is QueueType => typeof v === "string" && (QUEUE_TYPES as readonly string[]).includes(v);

/** CF queue carrying an upstream queue type (null: no queue here — cron / DO alarms / not implemented). */
export function cfQueueOf(type: QueueType): string | null {
  switch (type) {
    case "deliver":
      return "mk-deliver";
    case "inbox":
      return "mk-inbox";
    case "db":
    case "postScheduledNote":
      return "mk-jobs";
    case "userWebhookDeliver":
    case "systemWebhookDeliver":
      return "mk-webhook-deliver";
    default:
      return null;
  }
}

/** Upstream queue type of one CF message (null for queues without an upstream counterpart). */
export function queueTypeOf(cfQueue: string, body: unknown): QueueType | null {
  const kind = body && typeof body === "object" ? (body as { kind?: unknown }).kind : undefined;
  switch (cfQueue) {
    case "mk-deliver":
      return "deliver";
    case "mk-inbox":
      return "inbox";
    case "mk-webhook-deliver":
      return kind === "systemWebhook" ? "systemWebhookDeliver" : "userWebhookDeliver";
    case "mk-jobs":
      return kind === "postScheduledNote" ? "postScheduledNote" : "db";
    default:
      return null;
  }
}

/** `max_retries` of each consumer (packages/api/wrangler.toml): CF drops a message retried past it. */
export const CF_MAX_RETRIES: Record<string, number> = { "mk-inbox": 5, "mk-deliver": 11, "mk-webhook-deliver": 3, "mk-jobs": 5 };

/** Remote host a deliver / inbox job is about (deliver-delayed / inbox-delayed grouping). */
export function jobHostOf(type: QueueType, body: unknown): string | null {
  try {
    const b = body as Record<string, unknown>;
    if (type === "deliver" && typeof b.inbox === "string") return new URL(b.inbox).host;
    if (type === "inbox") {
      const h = (b.headers ?? {}) as Record<string, string>;
      const sig = h.signature ?? h.Signature ?? "";
      const m = /keyId="([^"]+)"/.exec(sig);
      if (m) return new URL(m[1]!).host;
    }
  } catch {
    /* unparsable */
  }
  return null;
}

/** Per-message outcome the consumer reports (only failures / retries / recovered retries). */
export type QueueJobEvent = {
  /** CF message id (stable across retries) */
  id: string;
  type: QueueType;
  state: "failed" | "delayed" | "completed";
  /** job name (message `kind`) */
  name: string;
  /** message body; omitted when too large to keep (retry-job then cannot re-enqueue it) */
  data?: unknown;
  /** enqueue time (ms) */
  timestamp: number;
  attempts: number;
  maxAttempts?: number;
  delayMs?: number;
  reason?: string;
  host?: string | null;
};

/** Ring entry (OpsStats storage `job:{type}:{id}`). */
export type QueueJobEntry = {
  id: string;
  type: QueueType;
  state: "failed" | "delayed";
  name: string;
  data: unknown;
  dataOmitted: boolean;
  timestamp: number;
  processedOn: number;
  finishedOn: number | null;
  attempts: number;
  maxAttempts: number | null;
  delay: number;
  failedReason: string;
  host: string | null;
  logs: string[];
};

/** Max body size kept for a job (DO storage values are capped at 128 KiB). */
export const JOB_DATA_MAX = 64 * 1024;
/** Ring size per queue type (upstream jobs returns at most 100). */
export const JOB_RING = 100;
/** Per-minute metric points kept per type. */
export const METRIC_POINTS = 60;

export type QueueTypeMetric = { meta: { count: number; prevTS: number; prevCount: number }; data: number[]; count: number };
export type QueueTypeStats = {
  completed: number;
  failed: number;
  delayed: number;
  /** minute (epoch ms / 60000) of data[0] */
  minute: number;
  completedData: number[];
  failedData: number[];
};

export type QueueTypeCounts = Partial<Record<QueueType, { completed?: number; failed?: number; delayed?: number }>>;

/** Pure: fold a batch's per-type outcome counts into stats, shifting the per-minute buckets. */
export function applyTypeCounts(prev: QueueTypeStats | undefined, c: { completed?: number; failed?: number; delayed?: number }, now: number): QueueTypeStats {
  const minute = Math.floor(now / 60000);
  const s: QueueTypeStats = prev
    ? { ...prev, completedData: [...prev.completedData], failedData: [...prev.failedData] }
    : { completed: 0, failed: 0, delayed: 0, minute, completedData: [], failedData: [] };
  const shift = Math.max(0, minute - s.minute);
  if (shift > 0) {
    const pad = new Array(Math.min(shift, METRIC_POINTS)).fill(0);
    s.completedData = [...pad, ...s.completedData].slice(0, METRIC_POINTS);
    s.failedData = [...pad, ...s.failedData].slice(0, METRIC_POINTS);
    s.minute = minute;
  }
  if (s.completedData.length === 0) s.completedData = [0];
  if (s.failedData.length === 0) s.failedData = [0];
  const add = (n?: number) => Math.max(0, n ?? 0);
  s.completed += add(c.completed);
  s.failed += add(c.failed);
  s.delayed += add(c.delayed);
  s.completedData[0]! += add(c.completed);
  s.failedData[0]! += add(c.failed);
  return s;
}

/** Bull.Metrics-shaped view (data newest first, one point per minute). */
export function toMetric(s: QueueTypeStats | undefined, which: "completed" | "failed", now: number): QueueTypeMetric {
  if (!s) return { meta: { count: 0, prevTS: 0, prevCount: 0 }, data: [], count: 0 };
  const shift = Math.max(0, Math.floor(now / 60000) - s.minute);
  const raw = which === "completed" ? s.completedData : s.failedData;
  const data = [...new Array(Math.min(shift, METRIC_POINTS)).fill(0), ...raw].slice(0, METRIC_POINTS);
  const total = which === "completed" ? s.completed : s.failed;
  return { meta: { count: total, prevTS: s.minute * 60000, prevCount: data[0] ?? 0 }, data, count: data.length };
}

/** Pure: apply one job event to an existing ring entry (or create it). Returns null to delete. */
export function applyJobEvent(prev: QueueJobEntry | undefined, ev: QueueJobEvent, now: number): QueueJobEntry | null {
  if (ev.state === "completed") return null;
  let data: unknown = ev.data ?? prev?.data ?? null;
  let dataOmitted = ev.data === undefined ? (prev?.dataOmitted ?? true) : false;
  if (data != null && JSON.stringify(data).length > JOB_DATA_MAX) {
    data = null;
    dataOmitted = true;
  }
  const reason = (ev.reason ?? "").slice(0, 500);
  const at = new Date(now).toISOString();
  const line = ev.state === "failed" ? `${at} attempt ${ev.attempts} failed: ${reason}` : `${at} attempt ${ev.attempts} failed, retrying in ${Math.round((ev.delayMs ?? 0) / 1000)}s: ${reason}`;
  return {
    id: ev.id,
    type: ev.type,
    state: ev.state,
    name: ev.name,
    data,
    dataOmitted,
    timestamp: ev.timestamp,
    processedOn: now,
    finishedOn: ev.state === "failed" ? now : null,
    attempts: ev.attempts,
    maxAttempts: ev.maxAttempts ?? prev?.maxAttempts ?? null,
    delay: ev.state === "delayed" ? (ev.delayMs ?? 0) : 0,
    failedReason: reason,
    host: ev.host ?? prev?.host ?? null,
    logs: [...(prev?.logs ?? []), line].slice(-20),
  };
}

/** Upstream redactJobData: webhook secrets are never shown. */
export function redactJobData(type: QueueType, data: unknown): unknown {
  if ((type === "userWebhookDeliver" || type === "systemWebhookDeliver") && data && typeof data === "object" && "secret" in data) {
    return { ...(data as object), secret: "(redacted)" };
  }
  return data;
}

/** Packed QueueJob (upstream QueueService.packJobData). */
export function packQueueJob(e: QueueJobEntry) {
  return {
    id: e.id,
    name: e.name,
    data: (redactJobData(e.type, e.data) ?? {}) as Record<string, unknown>,
    opts: { ...(e.maxAttempts != null ? { attempts: e.maxAttempts } : {}), ...(e.delay ? { delay: e.delay } : {}) },
    timestamp: e.timestamp,
    processedOn: e.processedOn,
    ...(e.finishedOn != null ? { finishedOn: e.finishedOn } : {}),
    progress: 0,
    attempts: e.attempts,
    delay: e.delay,
    failedReason: e.failedReason,
    stacktrace: [] as string[],
    returnValue: null,
    isFailed: true,
  };
}

/** Queues limits per `sendBatch` call: 100 messages, 256 KB in total (kept below). */
const BATCH_MAX_MESSAGES = 100;
const BATCH_MAX_BYTES = 200 * 1024;

/** Splits messages into `sendBatch`-sized chunks. */
export function chunkForSendBatch<T>(messages: T[]): T[][] {
  const out: T[][] = [];
  let cur: T[] = [];
  let bytes = 0;
  for (const m of messages) {
    const size = JSON.stringify(m).length;
    if (cur.length && (cur.length >= BATCH_MAX_MESSAGES || bytes + size > BATCH_MAX_BYTES)) {
      out.push(cur);
      cur = [];
      bytes = 0;
    }
    cur.push(m);
    bytes += size;
  }
  if (cur.length) out.push(cur);
  return out;
}
