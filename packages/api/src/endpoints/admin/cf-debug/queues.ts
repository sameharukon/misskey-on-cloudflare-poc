import type { ApiEnv } from "../../../env.js";
import { ACCESS_DENIED, apiErrorResponse, CREDENTIAL_REQUIRED } from "../../../errors.js";
import { authUserId } from "../../../handler-kit.js";
import { getRootUserId } from "../../../users-pg.js";
import { OPS_DO_NAME } from "../../../../../shared/src/ops.js";

export const name = "admin/cf-debug/queues";

/**
 * misskey-cf only (not upstream): root-only queue/delivery backlog view.
 * Counters come from the OpsStats DO (producers count `enqueued`, consumers
 * count acked/retried/dropped per batch); `backlogEstimate` =
 * enqueued − acked − dropped since the counters started. No CF account token
 * is needed (the Queues metrics API would require one as a Worker secret).
 * `{ reset: true }` clears the counters.
 */
export async function handle(
  env: ApiEnv,
  body: Record<string, unknown>,
  ctx: { hasCredential: boolean; request: Request },
): Promise<Response | unknown> {
  const actorId = await authUserId(env, body, ctx);
  if (!actorId) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  const root = await getRootUserId(env);
  if (!root || actorId !== root) return apiErrorResponse(ACCESS_DENIED, 403);
  const ns = env.OPS_STATS;
  if (!ns) return { bound: false, queues: {}, recentErrors: [] };
  const stub = ns.get(ns.idFromName(OPS_DO_NAME));
  if (body.reset === true) await stub.reset();
  return { bound: true, ...(await stub.stats()) };
}
