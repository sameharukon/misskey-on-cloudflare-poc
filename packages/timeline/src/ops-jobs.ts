/**
 * OpsStats job ring (upstream admin/queue/* on CF Queues):
 * per upstream queue type counters + per-minute metrics, a bounded ring of failed / delayed
 * messages, paused flags and cancelled message ids. Keys:
 *   `qtypes`            Record<QueueType, QueueTypeStats>
 *   `jobidx:{type}`     JobIndexItem[] (newest first, ≤ JOB_RING)
 *   `job:{type}:{id}`   QueueJobEntry
 *   `paused`            QueueType[]
 *   `cancelled`         string[] (message ids the consumer acks without running, ≤ CANCELLED_MAX)
 */
import {
  applyJobEvent,
  applyTypeCounts,
  isQueueType,
  JOB_RING,
  QUEUE_TYPES,
  type QueueJobEntry,
  type QueueJobEvent,
  type QueueType,
  type QueueTypeCounts,
  type QueueTypeStats,
} from "@misskey-cf/shared";
import type { OpsQueueControlView, OpsQueueJobIndexItem, OpsQueueOp, OpsQueueOpResult, OpsQueueTypesView } from "../../shared/src/do-rpc.js";

export type Storage = {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
};

export type JobIndexItem = OpsQueueJobIndexItem;

const CANCELLED_MAX = 500;
const idxKey = (t: QueueType) => `jobidx:${t}`;
const jobKey = (t: QueueType, id: string) => `job:${t}:${id}`;

export async function applyTypeCountsTo(st: Storage, counts: QueueTypeCounts, now: number): Promise<void> {
  const all = (await st.get<Partial<Record<QueueType, QueueTypeStats>>>("qtypes")) ?? {};
  for (const [t, c] of Object.entries(counts)) {
    if (!isQueueType(t) || !c) continue;
    all[t] = applyTypeCounts(all[t], c, now);
  }
  await st.put("qtypes", all);
}

export async function applyJobEvents(st: Storage, events: QueueJobEvent[], now: number): Promise<void> {
  const byType = new Map<QueueType, QueueJobEvent[]>();
  for (const ev of events) {
    if (!ev || typeof ev.id !== "string" || !isQueueType(ev.type)) continue;
    byType.set(ev.type, [...(byType.get(ev.type) ?? []), ev]);
  }
  for (const [type, evs] of byType) {
    let idx = (await st.get<JobIndexItem[]>(idxKey(type))) ?? [];
    for (const ev of evs) {
      const prev = await st.get<QueueJobEntry>(jobKey(type, ev.id));
      const next = applyJobEvent(prev, ev, now);
      idx = idx.filter((i) => i.id !== ev.id);
      if (!next) {
        if (prev) await st.delete(jobKey(type, ev.id));
        continue;
      }
      await st.put(jobKey(type, ev.id), next);
      idx.unshift({ id: ev.id, state: next.state, host: next.host, at: now });
    }
    for (const evicted of idx.slice(JOB_RING)) await st.delete(jobKey(type, evicted.id));
    await st.put(idxKey(type), idx.slice(0, JOB_RING));
  }
}

async function removeJobs(st: Storage, type: QueueType, pick: (i: JobIndexItem) => boolean): Promise<JobIndexItem[]> {
  const idx = (await st.get<JobIndexItem[]>(idxKey(type))) ?? [];
  const removed = idx.filter(pick);
  if (removed.length === 0) return [];
  for (const r of removed) await st.delete(jobKey(type, r.id));
  await st.put(idxKey(type), idx.filter((i) => !pick(i)));
  // delayed jobs are still pending in CF Queues: the consumer acks them without running them
  const cancel = removed.filter((r) => r.state === "delayed").map((r) => r.id);
  if (cancel.length) {
    const prev = (await st.get<string[]>("cancelled")) ?? [];
    await st.put("cancelled", [...cancel, ...prev.filter((id) => !cancel.includes(id))].slice(0, CANCELLED_MAX));
  }
  return removed;
}

export async function resetJobs(st: Storage): Promise<void> {
  for (const t of QUEUE_TYPES) await removeJobs(st, t, () => true);
  await st.delete("qtypes");
  await st.delete("cancelled");
  await st.delete("paused");
}

export async function queueControl(st: Storage): Promise<OpsQueueControlView> {
  return { paused: (await st.get<QueueType[]>("paused")) ?? [], cancelled: (await st.get<string[]>("cancelled")) ?? [] };
}

export async function queueTypes(st: Storage): Promise<OpsQueueTypesView> {
  const index: Partial<Record<QueueType, JobIndexItem[]>> = {};
  for (const t of QUEUE_TYPES) index[t] = (await st.get<JobIndexItem[]>(idxKey(t))) ?? [];
  return { types: (await st.get<Partial<Record<QueueType, QueueTypeStats>>>("qtypes")) ?? {}, paused: (await st.get<QueueType[]>("paused")) ?? [], index };
}

/** The ring's entries of `type`, newest first; [] for an unknown type. */
export async function queueJobs(st: Storage, type: string): Promise<QueueJobEntry[]> {
  if (!isQueueType(type)) return [];
  const idx = (await st.get<JobIndexItem[]>(idxKey(type))) ?? [];
  const jobs: QueueJobEntry[] = [];
  for (const i of idx) {
    const e = await st.get<QueueJobEntry>(jobKey(type, i.id));
    if (e) jobs.push(e);
  }
  return jobs;
}

/** null when the type is unknown or the job is not in the ring. */
export async function queueJob(st: Storage, type: string, id: string): Promise<QueueJobEntry | null> {
  if (!isQueueType(type)) return null;
  return (await st.get<QueueJobEntry>(jobKey(type, String(id ?? "")))) ?? null;
}

/** pause / resume / remove / clear; null for an invalid op. */
export async function queueOp(st: Storage, b: OpsQueueOp): Promise<OpsQueueOpResult | null> {
  if (!b || !isQueueType(b.type)) return null;
  const t = b.type;
  if (b.op === "pause" || b.op === "resume") {
    const prev = (await st.get<QueueType[]>("paused")) ?? [];
    const next = b.op === "pause" ? [...new Set([...prev, t])] : prev.filter((x) => x !== t);
    await st.put("paused", next);
    return { paused: next };
  }
  if (b.op === "remove") {
    const ids = Array.isArray(b.ids) ? b.ids.filter((x): x is string => typeof x === "string") : [];
    const removed = await removeJobs(st, t, (i) => ids.includes(i.id));
    return { removed };
  }
  if (b.op === "clear") {
    const state = b.state ?? "*";
    const removed = await removeJobs(st, t, (i) => state === "*" || i.state === state);
    if (state === "*" || state === "completed" || state === "failed") {
      const all = (await st.get<Partial<Record<QueueType, QueueTypeStats>>>("qtypes")) ?? {};
      const s = all[t];
      if (s) {
        if (state !== "failed") s.completed = 0;
        if (state !== "completed") s.failed = 0;
        await st.put("qtypes", all);
      }
    }
    return { removed };
  }
  return null;
}
