/**
 * Sending to mk-jobs / mk-webhook-deliver: one place that also counts the message as enqueued in
 * OpsStats (admin/queue/*), as CfQueueProducer does for the AP queues. The direct sends did not
 * count, which threw off the backlog estimate. Without the binding nothing is sent (false).
 */
import type { ApiEnv } from "../env.js";
import { recordOps } from "../../../shared/src/ops.js";

export async function enqueueJob(env: ApiEnv, body: unknown, opts?: { delaySeconds?: number }): Promise<boolean> {
  if (!env.Q_JOBS) return false;
  await env.Q_JOBS.send(body, opts?.delaySeconds ? { delaySeconds: opts.delaySeconds } : undefined);
  await recordOps(env.OPS_STATS, { queue: "mk-jobs", enqueued: 1 });
  return true;
}

export async function enqueueWebhook(env: ApiEnv, body: unknown): Promise<boolean> {
  if (!env.Q_WEBHOOK_DELIVER) return false;
  await env.Q_WEBHOOK_DELIVER.send(body);
  await recordOps(env.OPS_STATS, { queue: "mk-webhook-deliver", enqueued: 1 });
  return true;
}
