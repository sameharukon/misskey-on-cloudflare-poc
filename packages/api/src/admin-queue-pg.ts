/**
 * upstream admin/queue/* (BullMQ job management) on Cloudflare Queues. CF Queues have no
 * listing / lookup / purge for a Worker, so everything below works on what the api consumer
 * reports to the OpsStats DO (packages/timeline/src/ops-jobs.ts):
 *
 * - per upstream queue type: completed / failed / retried counters and per-minute metrics,
 * - a ring (≤ 100 per type) of failed and delayed (retrying) messages with body, error,
 *   attempts and timestamps — what `jobs` / `show-job` / `*-delayed` return,
 * - paused types (the consumer puts their messages back with a 60 s delay),
 * - cancelled message ids (removed / promoted delayed jobs; the consumer acks them unrun).
 *
 * admin/queue/stats stays in endpoints/admin/queue/stats.ts (CF queue counters).
 */

import { genAidx } from "../../id/src/index.js";
import type { ApiEnv } from "./env.js";
import { apiErrorResponse, INTERNAL_ERROR } from "./errors.js";
import { authenticatePg, extractToken } from "./auth-pg.js";
import { withHyperdriveClient } from "./pg.js";
import { moderationLogPg } from "./policies-pg.js";
import { adminGate } from "./admin-gate.js";
import { OPS_DO_NAME, estimateBacklog, type OpsQueueStats } from "../../shared/src/ops.js";
import { cfQueueOf, isQueueType, packQueueJob, QUEUE_TYPES, toMetric, type QueueType } from "../../shared/src/queue-jobs.js";
import { opsQueueJob, opsQueueJobs, opsQueueOp, opsQueueTypes, reenqueue, type QueueTypesView } from "./queues/ops-jobs.js";
import { invalidParam as bad } from "./handler-kit.js";

type Ctx = { hasCredential: boolean; request: Request };
type Body = Record<string, unknown>;
type Handler = (env: ApiEnv, body: Body, ctx: Ctx) => Promise<Response | unknown>;

const noContent = () => new Response(null, { status: 204 });

const CLEAR_STATES = ["*", "completed", "wait", "active", "paused", "prioritized", "delayed", "failed"];
const JOB_STATES = ["active", "wait", "delayed", "completed", "failed"];

/** Moderator gate (upstream requireModerator); passes the caller id for moderation logs. */
function moderator(h: (env: ApiEnv, body: Body, me: string | null) => Promise<Response | unknown>): Handler {
  return async (env, body, ctx) => {
    const denied = await adminGate(ctx.request, env as never, body, "moderator");
    if (denied) return denied;
    let me: string | null = null;
    if (env.HYPERDRIVE?.connectionString) {
      const token = extractToken(ctx.request, body);
      me = token ? ((await authenticatePg(env, token))?.user.id ?? null) : null;
    }
    return h(env, body, me);
  };
}

/** Handler taking `queue` (one of upstream QUEUE_TYPES). */
function withQueue(h: (env: ApiEnv, body: Body, type: QueueType, me: string | null) => Promise<Response | unknown>): Handler {
  return moderator(async (env, body, me) => (isQueueType(body.queue) ? h(env, body, body.queue, me) : bad()));
}

async function modLog(env: ApiEnv, me: string | null, type: string): Promise<void> {
  if (!me || !env.HYPERDRIVE?.connectionString) return;
  await withHyperdriveClient(env.HYPERDRIVE, (c) => moderationLogPg(c, me, type, {}, genAidx(Date.now())));
}

async function cfCounters(env: ApiEnv): Promise<Record<string, OpsQueueStats>> {
  const ns = env.OPS_STATS;
  if (!ns) return {};
  const snap = await ns.get(ns.idFromName(OPS_DO_NAME)).stats().catch(() => null);
  return snap?.queues ?? {};
}

/** BullMQ getJobCounts() shape. waiting = CF backlog estimate (deliver / inbox only: other producers do not count enqueues). */
function queueInfo(type: QueueType, view: QueueTypesView, cf: Record<string, OpsQueueStats>, now: number) {
  const s = view.types[type];
  const isPaused = view.paused.includes(type);
  const delayed = (view.index[type] ?? []).filter((i) => i.state === "delayed").length;
  const cfName = cfQueueOf(type);
  const backlog = (type === "deliver" || type === "inbox") && cfName && cf[cfName] ? Math.max(0, estimateBacklog(cf[cfName]!) - delayed) : 0;
  return {
    name: type,
    counts: {
      active: 0,
      completed: s?.completed ?? 0,
      delayed,
      failed: s?.failed ?? 0,
      paused: isPaused ? backlog : 0,
      prioritized: 0,
      waiting: isPaused ? 0 : backlog,
      "waiting-children": 0,
    },
    isPaused,
    metrics: { completed: toMetric(s, "completed", now), failed: toMetric(s, "failed", now) },
  };
}

// ---------------------------------------------------------------- read

const queues: Handler = moderator(async (env) => {
  const [view, cf] = await Promise.all([opsQueueTypes(env), cfCounters(env)]);
  const now = Date.now();
  return QUEUE_TYPES.map((t) => queueInfo(t, view, cf, now));
});

const queueStats: Handler = withQueue(async (env, _b, type) => {
  const [view, cf] = await Promise.all([opsQueueTypes(env), cfCounters(env)]);
  const now = Date.now();
  const info = queueInfo(type, view, cf, now);
  const cfName = cfQueueOf(type);
  const since = cfName && cf[cfName] ? Date.parse(cf[cfName]!.since) : now;
  return {
    name: info.name,
    // upstream: BullMQ `bull:<name>`; here the CF queue carrying it ("none" when there is none)
    qualifiedName: cfName ?? "none",
    counts: info.counts,
    isPaused: info.isPaused,
    metrics: info.metrics,
    // upstream: Redis INFO; there is no Redis behind CF Queues
    db: {
      version: "cloudflare-queues",
      mode: "standalone",
      runId: "",
      processId: "",
      port: 0,
      os: "cloudflare-workers",
      uptime: Math.max(0, Math.floor((now - since) / 1000)),
      memory: { total: 0, used: 0, fragmentationRatio: 0, peak: 0 },
      clients: { blocked: 0, connected: 0 },
    },
  };
});

const jobs: Handler = withQueue(async (env, body, type) => {
  const states = body.state;
  if (!Array.isArray(states) || !states.every((s) => typeof s === "string" && JOB_STATES.includes(s))) return bad();
  if (body.search !== undefined && typeof body.search !== "string") return bad();
  const wanted = new Set(states as string[]);
  // only failed / delayed jobs are kept; active / wait / completed are not observable on CF Queues
  const packed = (await opsQueueJobs(env, type)).filter((e) => wanted.has(e.state)).map(packQueueJob);
  const search = typeof body.search === "string" ? body.search : "";
  if (!search) return packed.slice(0, 100);
  // upstream: search the redacted pack, every space-separated term must match
  const terms = search.toLowerCase().split(" ");
  return packed.filter((j) => {
    const s = JSON.stringify(j).toLowerCase();
    return terms.every((t) => s.includes(t));
  }).slice(0, 100);
});

const jobIdOf = (body: Body) => (typeof body.jobId === "string" ? body.jobId : null);

const showJob: Handler = withQueue(async (env, body, type) => {
  const id = jobIdOf(body);
  if (id == null) return bad();
  const e = await opsQueueJob(env, type, id);
  // upstream throws a plain Error (`Job not found`) → INTERNAL_ERROR
  if (!e) return apiErrorResponse(INTERNAL_ERROR, 500);
  return packQueueJob(e);
});

const showJobLogs: Handler = withQueue(async (env, body, type) => {
  const id = jobIdOf(body);
  if (id == null) return bad();
  return (await opsQueueJob(env, type, id))?.logs ?? [];
});

/** upstream deliver-delayed / inbox-delayed: delayed jobs per remote host, most first. */
function delayedByHost(type: "deliver" | "inbox"): Handler {
  return moderator(async (env) => {
    const view = await opsQueueTypes(env);
    const counts = new Map<string, number>();
    for (const i of view.index[type] ?? []) {
      if (i.state !== "delayed" || !i.host) continue;
      counts.set(i.host, (counts.get(i.host) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  });
}

// ---------------------------------------------------------------- write

const pause: Handler = withQueue(async (env, _b, type, me) => {
  await opsQueueOp(env, { op: "pause", type });
  await modLog(env, me, "pauseQueue");
  return noContent();
});

const resume: Handler = withQueue(async (env, _b, type, me) => {
  await opsQueueOp(env, { op: "resume", type });
  await modLog(env, me, "resumeQueue");
  return noContent();
});

const clear: Handler = withQueue(async (env, body, type, me) => {
  if (typeof body.state !== "string" || !CLEAR_STATES.includes(body.state)) return bad();
  // ring entries (delayed ones are cancelled: the consumer acks them unrun); waiting / active
  // messages cannot be purged without the CF REST API
  await opsQueueOp(env, { op: "clear", type, state: body.state });
  await modLog(env, me, "clearQueue");
  return noContent();
});

/**
 * Re-enqueue stored jobs now and drop them from the ring. A delayed original is still pending in
 * CF Queues, so it is cancelled (acked unrun when it comes back).
 */
async function runNow(env: ApiEnv, type: QueueType, ids: string[]): Promise<void> {
  const cfName = cfQueueOf(type);
  if (!cfName || ids.length === 0) return;
  const sent: string[] = [];
  for (const id of ids) {
    const e = await opsQueueJob(env, type, id);
    if (!e || e.dataOmitted || e.data == null) continue;
    if (await reenqueue(env, cfName, e.data)) sent.push(id);
  }
  if (sent.length) await opsQueueOp(env, { op: "remove", type, ids: sent });
}

const retryJob: Handler = withQueue(async (env, body, type) => {
  const id = jobIdOf(body);
  if (id == null) return bad();
  // upstream: failed → retry, delayed → promote; unknown ids are ignored
  await runNow(env, type, [id]);
  return noContent();
});

const promoteJobs: Handler = withQueue(async (env, _b, type, me) => {
  const view = await opsQueueTypes(env);
  await runNow(env, type, (view.index[type] ?? []).filter((i) => i.state === "delayed").map((i) => i.id));
  await modLog(env, me, "promoteQueue");
  return noContent();
});

const removeJob: Handler = withQueue(async (env, body, type) => {
  const id = jobIdOf(body);
  if (id == null) return bad();
  await opsQueueOp(env, { op: "remove", type, ids: [id] });
  return noContent();
});

// ---------------------------------------------------------------- registry

export const adminQueueHandlers: Record<string, Handler> = {
  "admin/queue/clear": clear,
  "admin/queue/deliver-delayed": delayedByHost("deliver"),
  "admin/queue/inbox-delayed": delayedByHost("inbox"),
  "admin/queue/jobs": jobs,
  "admin/queue/pause": pause,
  "admin/queue/promote-jobs": promoteJobs,
  "admin/queue/queue-stats": queueStats,
  "admin/queue/queues": queues,
  "admin/queue/remove-job": removeJob,
  "admin/queue/resume": resume,
  "admin/queue/retry-job": retryJob,
  "admin/queue/show-job": showJob,
  "admin/queue/show-job-logs": showJobLogs,
};

