/**
 * Queue/delivery counters (root-only admin view). One OpsStats DO ("ops:global")
 * in misskey-cf-timeline; producers record `enqueued`, consumers record
 * per-batch acked/retried/dropped. Best-effort: recording never throws.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { QueueJobEvent, QueueTypeCounts } from "./queue-jobs.js";
import type { DoNs, OpsStatsRpc } from "./do-rpc.js";

export type OpsEvent = {
  queue: string;
  enqueued?: number;
  acked?: number;
  retried?: number;
  dropped?: number;
  /** Short error description (no payloads / secrets) */
  error?: string;
  /** Per upstream queue type outcome counts (admin/queue/queues metrics) */
  types?: QueueTypeCounts;
  /** Failed / retried / recovered messages for the admin/queue job ring */
  jobs?: QueueJobEvent[];
};

export type OpsQueueStats = {
  enqueued: number;
  acked: number;
  retried: number;
  dropped: number;
  lastError: string | null;
  lastErrorAt: string | null;
  lastActivityAt: string | null;
  since: string;
};

export type OpsNs = DoNs<OpsStatsRpc>;

export const OPS_DO_NAME = "ops:global";

const background = new AsyncLocalStorage<(p: Promise<unknown>) => void>();

/**
 * Runs `fn` with `waitUntil` as the place for OpsStats work. Inside, recordOps does not hold the
 * caller: the single OpsStats DO can take seconds to answer (its writes wait for durable commit),
 * which would otherwise delay inbox responses, deliveries and queue batches.
 */
export function runWithOpsBackground<T>(waitUntil: ((p: Promise<unknown>) => void) | undefined, fn: () => T): T {
  return waitUntil ? background.run(waitUntil, fn) : fn();
}

/** Whether work can be handed to a runWithOpsBackground scope's waitUntil. */
export function hasBackground(): boolean {
  return background.getStore() != null;
}

/** Hands `p` to the current runWithOpsBackground scope; false outside one (the caller awaits it). */
export function opsInBackground(p: Promise<unknown>): boolean {
  const waitUntil = background.getStore();
  if (!waitUntil) return false;
  waitUntil(p);
  return true;
}

/** Job events one merged write carries at most (the ring keeps JOB_RING per type). */
const MERGED_JOBS_MAX = 100;

/**
 * Background writes of one isolate: at most one round of writes in flight; events recorded
 * meanwhile are merged per queue and sent together in the next round. A busy isolate then makes a
 * few writes per OpsStats round trip instead of one per enqueue, so the single DO is not flooded.
 */
type Writer = { pending: Map<string, OpsEvent>; next: Promise<void> | null; running: Promise<void> | null };
const writers = new WeakMap<object, Writer>();

/** Pure: one event standing for `a` then `b` (same queue). The last error wins. */
export function mergeOpsEvents(a: OpsEvent, b: OpsEvent): OpsEvent {
  const sum = (x?: number, y?: number) => (x == null && y == null ? undefined : (x ?? 0) + (y ?? 0));
  const out: OpsEvent = { queue: a.queue };
  for (const k of ["enqueued", "acked", "retried", "dropped"] as const) {
    const v = sum(a[k], b[k]);
    if (v != null) out[k] = v;
  }
  const error = b.error ?? a.error;
  if (error) out.error = error;
  if (a.types || b.types) {
    const types: QueueTypeCounts = {};
    for (const src of [a.types, b.types]) {
      for (const [t, c] of Object.entries(src ?? {}) as [keyof QueueTypeCounts, QueueTypeCounts[keyof QueueTypeCounts]][]) {
        if (!c) continue;
        const d = (types[t] ??= {});
        for (const k of ["completed", "failed", "delayed"] as const) {
          if (c[k] != null) d[k] = (d[k] ?? 0) + c[k]!;
        }
      }
    }
    out.types = types;
  }
  if (a.jobs?.length || b.jobs?.length) out.jobs = [...(a.jobs ?? []), ...(b.jobs ?? [])].slice(-MERGED_JOBS_MAX);
  return out;
}

async function send(ns: OpsNs, ev: OpsEvent): Promise<void> {
  try {
    await ns.get(ns.idFromName(OPS_DO_NAME)).record({ ...ev, error: ev.error ? ev.error.slice(0, 300) : undefined });
  } catch {
    /* best-effort */
  }
}

/** Adds `ev` to the isolate's next round of writes; resolves when that round is done. */
function enqueueWrite(ns: OpsNs, ev: OpsEvent): Promise<void> {
  let w = writers.get(ns);
  if (!w) writers.set(ns, (w = { pending: new Map(), next: null, running: null }));
  const prev = w.pending.get(ev.queue);
  w.pending.set(ev.queue, prev ? mergeOpsEvents(prev, ev) : ev);
  if (w.next) return w.next;
  const writer = w;
  const round = (writer.running ?? Promise.resolve()).then(async () => {
    // events recorded from here on go to the round after this one
    writer.next = null;
    const evs = [...writer.pending.values()];
    writer.pending.clear();
    await Promise.all(evs.map((e) => send(ns, e)));
  });
  writer.next = round;
  writer.running = round;
  void round.finally(() => {
    if (writer.running === round) writer.running = null;
  });
  return round;
}

export async function recordOps(ns: OpsNs | undefined, ev: OpsEvent): Promise<void> {
  if (!ns) return;
  if (background.getStore()) {
    opsInBackground(enqueueWrite(ns, ev));
    return;
  }
  await send(ns, ev);
}

/** Pure: fold one event into stats. */
export function applyOpsEvent(prev: OpsQueueStats | undefined, ev: OpsEvent, now: Date): OpsQueueStats {
  const s: OpsQueueStats = prev
    ? { ...prev }
    : { enqueued: 0, acked: 0, retried: 0, dropped: 0, lastError: null, lastErrorAt: null, lastActivityAt: null, since: now.toISOString() };
  s.enqueued += Math.max(0, ev.enqueued ?? 0);
  s.acked += Math.max(0, ev.acked ?? 0);
  s.retried += Math.max(0, ev.retried ?? 0);
  s.dropped += Math.max(0, ev.dropped ?? 0);
  if (ev.error) {
    s.lastError = ev.error.slice(0, 300);
    s.lastErrorAt = now.toISOString();
  }
  s.lastActivityAt = now.toISOString();
  return s;
}

/** Estimated backlog: messages enqueued but not yet terminally handled. */
export function estimateBacklog(s: OpsQueueStats): number {
  return Math.max(0, s.enqueued - s.acked - s.dropped);
}
