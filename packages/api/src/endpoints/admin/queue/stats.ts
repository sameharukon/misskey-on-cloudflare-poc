import type { ApiEnv } from "../../../env.js";
import { OPS_DO_NAME, estimateBacklog, type OpsQueueStats } from "../../../../../shared/src/ops.js";
import { adminGate } from "../../../admin-gate.js";

export const name = "admin/queue/stats";

type QueueCount = { waiting: number; active: number; completed: number; failed: number; delayed: number };

/**
 * upstream admin/queue/stats ({ deliver, inbox, db, objectStorage } of BullMQ job counts), from
 * the OpsStats counters CF Queues consumers keep (CF exposes no per-queue counts to a Worker):
 * waiting = estimated backlog, completed = acked, failed = dropped, delayed = retries so far,
 * active = 0. `db` sums mk-jobs and mk-webhook-deliver; objectStorage is always empty.
 * Counters are cumulative since the last reset (admin/cf-debug/queues { reset: true }).
 */
export function toQueueCount(...stats: (OpsQueueStats | undefined)[]): QueueCount {
  const out: QueueCount = { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 };
  for (const s of stats) {
    if (!s) continue;
    out.waiting += Math.max(0, estimateBacklog(s));
    out.completed += s.acked;
    out.failed += s.dropped;
    out.delayed += s.retried;
  }
  return out;
}

export async function handle(
  env: ApiEnv,
  body: Record<string, unknown>,
  ctx: { hasCredential: boolean; request: Request },
): Promise<Response | unknown> {
  const denied = await adminGate(ctx.request, env as never, body, "moderator");
  if (denied) return denied;
  const ns = env.OPS_STATS;
  const queues: Record<string, OpsQueueStats> = ns ? (await ns.get(ns.idFromName(OPS_DO_NAME)).stats()).queues : {};
  return {
    deliver: toQueueCount(queues["mk-deliver"]),
    inbox: toQueueCount(queues["mk-inbox"]),
    db: toQueueCount(queues["mk-jobs"], queues["mk-webhook-deliver"]),
    objectStorage: toQueueCount(),
  };
}
