/**
 * Fast path of mk-inbox / mk-deliver. Cloudflare Queues take 1.5–6 s to start a consumer,
 * and a follow waits for that twice (our Follow out, their Accept in). So an inbox activity, and a
 * delivery to a few inboxes, is run at once in waitUntil, and a copy is queued
 * FAST_PATH_BACKUP_DELAY_S later as a backup:
 * - the immediate run finished (or failed for good): it leaves a KV mark, and the consumer acks
 *   the copy without running it;
 * - it failed in a way worth retrying, or the isolate went away first: no mark, the copy runs
 *   and is retried as before.
 * Used only with KV (META_CACHE) and a waitUntil scope; otherwise everything goes through the queue.
 */
import type { ApiEnv } from "../env.js";
import { runWithPgScope } from "../pg.js";
import { hasBackground, opsInBackground } from "../../../shared/src/ops.js";
import { getQueueControl } from "../queues/ops-jobs.js";
import { ApPermanentError } from "./remote.js";

/** Longer than the waitUntil limit (30 s) and KV's propagation (up to 60 s). */
export const FAST_PATH_BACKUP_DELAY_S = 120;
/** Deliveries of one activity run at once up to this many inboxes (follow, accept, undo, …). */
export const FAST_DELIVER_MAX = 5;

const MARK_PREFIX = "apq-done:";
const MARK_TTL_S = 24 * 60 * 60;

export function fastPathAvailable(env: ApiEnv): boolean {
  return typeof env.META_CACHE?.put === "function" && hasBackground();
}

/** Whether the immediate run of the message carrying `token` is done (the queued copy is not needed). */
export async function fastPathDone(env: ApiEnv, token: string | undefined): Promise<boolean> {
  if (!token || !env.META_CACHE) return false;
  try {
    return (await env.META_CACHE.get(MARK_PREFIX + token)) != null;
  } catch {
    return false;
  }
}

async function markDone(env: ApiEnv, token: string): Promise<void> {
  try {
    await env.META_CACHE?.put?.(MARK_PREFIX + token, "1", { expirationTtl: MARK_TTL_S });
  } catch (e) {
    console.warn(`fast path mark failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * Runs `work` in waitUntil on its own Postgres connection. `work` resolves true when the message
 * is done (the copy is not needed) and false to leave it to the copy; a thrown error counts as
 * done only when it is permanent (as in the consumer). Skipped while the queue type is paused.
 */
export function runFastPath(env: ApiEnv, token: string, type: "inbox" | "deliver", work: () => Promise<boolean>): void {
  const task = runWithPgScope(async () => {
    const control = await getQueueControl(env);
    if (control?.paused.has(type)) return;
    let done: boolean;
    try {
      done = await work();
    } catch (e) {
      done = e instanceof ApPermanentError || e instanceof SyntaxError;
      console.warn(`${type}(fast) error: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (done) await markDone(env, token);
  }).catch(() => {});
  opsInBackground(task);
}
