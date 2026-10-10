/// <reference path="../../shared/src/cloudflare-workers.d.ts" />
/** OpsStats DO: queue counters + recent error ring (root-only admin view) + admin/queue job ring (ops-jobs.ts). */
import { DurableObject } from "cloudflare:workers";
import { applyOpsEvent, estimateBacklog, type OpsEvent, type OpsQueueStats, type QueueJobEntry, type QueueType } from "@misskey-cf/shared";
import { applyJobEvents, applyTypeCountsTo, queueControl, queueJob, queueJobs, queueOp, queueTypes, resetJobs, type Storage } from "./ops-jobs.js";
import type { OpsQueueControlView, OpsQueueOp, OpsQueueOpResult, OpsQueueTypesView, OpsStatsRpc, OpsStatsSnapshot } from "../../shared/src/do-rpc.js";

const RING = 30;

export class OpsStats extends DurableObject implements OpsStatsRpc {
  private readonly state: { storage: Storage };
  constructor(ctx: { storage: Storage }, env?: unknown) {
    super(ctx, env);
    this.state = ctx;
  }

  async record(ev: OpsEvent): Promise<void> {
    if (!ev || typeof ev.queue !== "string" || ev.queue.length > 64) return;
    const st = this.state.storage;
    const queues = (await st.get<Record<string, OpsQueueStats>>("queues")) ?? {};
    const now = new Date();
    queues[ev.queue] = applyOpsEvent(queues[ev.queue], ev, now);
    await st.put("queues", queues);
    if (ev.error) {
      const ring = (await st.get<{ at: string; queue: string; error: string }[]>("errors")) ?? [];
      ring.unshift({ at: now.toISOString(), queue: ev.queue, error: ev.error.slice(0, 300) });
      await st.put("errors", ring.slice(0, RING));
    }
    if (ev.types) await applyTypeCountsTo(st, ev.types, now.getTime());
    if (Array.isArray(ev.jobs) && ev.jobs.length) await applyJobEvents(st, ev.jobs, now.getTime());
  }

  async stats(): Promise<OpsStatsSnapshot> {
    const st = this.state.storage;
    const queues = (await st.get<Record<string, OpsQueueStats>>("queues")) ?? {};
    const errors = (await st.get<unknown[]>("errors")) ?? [];
    return {
      queues: Object.fromEntries(Object.entries(queues).map(([k, v]) => [k, { ...v, backlogEstimate: estimateBacklog(v) }])),
      recentErrors: errors,
    };
  }

  async reset(): Promise<void> {
    const st = this.state.storage;
    await st.delete("queues");
    await st.delete("errors");
    await resetJobs(st);
  }

  queueControl(): Promise<OpsQueueControlView> {
    return queueControl(this.state.storage);
  }

  queueTypes(): Promise<OpsQueueTypesView> {
    return queueTypes(this.state.storage);
  }

  queueJobs(type: QueueType): Promise<QueueJobEntry[]> {
    return queueJobs(this.state.storage, type);
  }

  queueJob(type: QueueType, id: string): Promise<QueueJobEntry | null> {
    return queueJob(this.state.storage, type, id);
  }

  queueOp(op: OpsQueueOp): Promise<OpsQueueOpResult | null> {
    return queueOp(this.state.storage, op);
  }
}
