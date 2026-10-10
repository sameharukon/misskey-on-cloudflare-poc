/**
 * Consumer / endpoint side of the admin/queue job ring kept by OpsStats (packages/timeline/src/ops-jobs.ts):
 * the paused / cancelled control (cached per isolate for CONTROL_TTL_MS), CF producer lookup
 * for re-enqueueing, and the OpsStats job ring client (RPC).
 */
import type { ApiEnv } from "../env.js";
import { OPS_DO_NAME, opsInBackground, recordOps, type OpsNs } from "../../../shared/src/ops.js";
import type { QueueJobEntry, QueueType } from "../../../shared/src/queue-jobs.js";
import type { OpsQueueJobIndexItem, OpsQueueOp, OpsQueueOpResult, OpsQueueTypesView } from "../../../shared/src/do-rpc.js";

export const CONTROL_TTL_MS = 10_000;
/**
 * How long a batch of an isolate with no control yet waits for OpsStats before going on without
 * one (nothing paused or cancelled). The call keeps running and fills the cache for later batches.
 */
export const CONTROL_WAIT_MS = 1_000;
/**
 * Delay a message of a paused queue is put back with: 60 s, doubled each time it comes back still
 * paused, up to 5 min. Each round costs queue operations, so a long pause with a large backlog
 * no longer re-sends everything every minute; a resumed queue picks up within 5 min.
 */
export const PAUSED_DELAY_SECONDS = 60;
export const PAUSED_DELAY_MAX_SECONDS = 300;
/** Body field counting the rounds a message came back paused (stripped before processing). */
const PAUSED_ROUNDS = "__pausedRounds";

export function pausedRoundsOf(body: unknown): number {
  const n = body && typeof body === "object" ? (body as Record<string, unknown>)[PAUSED_ROUNDS] : undefined;
  return typeof n === "number" && n >= 0 ? n : 0;
}

export function pausedDelaySeconds(rounds: number): number {
  return Math.min(PAUSED_DELAY_MAX_SECONDS, PAUSED_DELAY_SECONDS * 2 ** Math.min(rounds, 10));
}

/** The body re-sent for another paused round (objects only; anything else as is). */
export function withPausedRound(body: unknown, rounds: number): unknown {
  return body && typeof body === "object" && !Array.isArray(body) ? { ...(body as object), [PAUSED_ROUNDS]: rounds } : body;
}

/** The body without the paused-round counter. */
export function withoutPausedRounds(body: unknown): unknown {
  if (!body || typeof body !== "object" || !(PAUSED_ROUNDS in body)) return body;
  const { [PAUSED_ROUNDS]: _drop, ...rest } = body as Record<string, unknown>;
  return rest;
}

export type QueueControl = { paused: Set<string>; cancelled: Set<string> };

const controlCache = new WeakMap<object, { at: number; control: QueueControl }>();
const controlInflight = new WeakMap<object, Promise<QueueControl | null>>();

function stub(ns: OpsNs) {
  return ns.get(ns.idFromName(OPS_DO_NAME));
}

async function fetchQueueControl(ns: OpsNs): Promise<QueueControl | null> {
  try {
    const j = await stub(ns).queueControl();
    const control = { paused: new Set<string>(j.paused ?? []), cancelled: new Set(j.cancelled ?? []) };
    controlCache.set(ns, { at: Date.now(), control });
    return control;
  } catch {
    return null;
  }
}

/**
 * Paused types and cancelled message ids; null without OPS_STATS or when OpsStats is unreachable.
 * Past CONTROL_TTL_MS the last known control is used at once while a refresh runs in the
 * background; only an isolate with none waits, for at most CONTROL_WAIT_MS.
 */
export async function getQueueControl(env: ApiEnv): Promise<QueueControl | null> {
  const ns = env.OPS_STATS;
  if (!ns) return null;
  const hit = controlCache.get(ns);
  if (hit && Date.now() - hit.at < CONTROL_TTL_MS) return hit.control;
  const p = refreshQueueControl(ns);
  if (hit) return opsInBackground(p) ? hit.control : ((await p) ?? hit.control);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<"late">((r) => (timer = setTimeout(() => r("late"), CONTROL_WAIT_MS)));
  const r = await Promise.race([p, late]);
  clearTimeout(timer);
  if (r !== "late") return r;
  opsInBackground(p);
  return null;
}

/** The control read in flight for this isolate, or a new one. */
function refreshQueueControl(ns: OpsNs): Promise<QueueControl | null> {
  let p = controlInflight.get(ns);
  if (!p) {
    const fetching = fetchQueueControl(ns).finally(() => {
      if (controlInflight.get(ns) === fetching) controlInflight.delete(ns);
    });
    controlInflight.set(ns, fetching);
    p = fetching;
  }
  return p;
}

/** Drop this isolate's cached control (after pause / resume / remove in the same isolate). */
export function invalidateQueueControl(env: ApiEnv): void {
  if (!env.OPS_STATS) return;
  controlCache.delete(env.OPS_STATS);
  controlInflight.delete(env.OPS_STATS);
}

type Sender = { send(body: unknown, opts?: { delaySeconds?: number }): Promise<void> };

/** Producer binding of a CF queue consumed by this worker. */
export function cfProducer(env: ApiEnv, cfQueue: string): Sender | undefined {
  const b =
    cfQueue === "mk-deliver"
      ? env.Q_DELIVER
      : cfQueue === "mk-inbox"
        ? env.Q_INBOX
        : cfQueue === "mk-jobs"
          ? env.Q_JOBS
          : cfQueue === "mk-webhook-deliver"
            ? env.Q_WEBHOOK_DELIVER
            : undefined;
  return b as Sender | undefined;
}

/** Re-enqueue a body (counted as `enqueued` like CfQueueProducer). False when the queue is unbound. */
export async function reenqueue(env: ApiEnv, cfQueue: string, body: unknown, delaySeconds?: number): Promise<boolean> {
  const p = cfProducer(env, cfQueue);
  if (!p) return false;
  await p.send(body, delaySeconds ? { delaySeconds } : undefined);
  await recordOps(env.OPS_STATS, { queue: cfQueue, enqueued: 1 });
  return true;
}

// ---------------------------------------------------------------- OpsStats job ring client

export type JobIndexItem = OpsQueueJobIndexItem;
export type QueueTypesView = OpsQueueTypesView;

/** The ring's view; empty without OPS_STATS or when OpsStats fails. */
export async function opsQueueTypes(env: ApiEnv): Promise<QueueTypesView> {
  const empty: QueueTypesView = { types: {}, paused: [], index: {} };
  const ns = env.OPS_STATS;
  if (!ns) return empty;
  return stub(ns).queueTypes().catch(() => empty);
}

export async function opsQueueJobs(env: ApiEnv, type: QueueType): Promise<QueueJobEntry[]> {
  const ns = env.OPS_STATS;
  if (!ns) return [];
  return stub(ns).queueJobs(type).catch(() => []);
}

export async function opsQueueJob(env: ApiEnv, type: QueueType, id: string): Promise<QueueJobEntry | null> {
  const ns = env.OPS_STATS;
  if (!ns) return null;
  return stub(ns).queueJob(type, id).catch(() => null);
}

export async function opsQueueOp(env: ApiEnv, op: OpsQueueOp): Promise<OpsQueueOpResult | null> {
  const ns = env.OPS_STATS;
  if (!ns) return null;
  const r = await stub(ns).queueOp(op).catch(() => null);
  invalidateQueueControl(env);
  return r;
}
