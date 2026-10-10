import type { ApiEnv } from "../../../env.js";
import { adminGate } from "../../../admin-gate.js";
import { enqueueBackfillInstances } from "../../../maintenance-pg.js";

export const name = "admin/cf-debug/backfill-instances";

/**
 * misskey-cf only (not upstream): moderators. Recompute the federated `instance` counters
 * (usersCount / notesCount / followingCount / followersCount) from PG and create the missing
 * `instance` rows for remote hosts seen in "user" — the live hooks only count from their
 * deployment onward. Runs as bounded `backfillInstances` steps on `mk-jobs`
 * (`{ queued: true }`), or inline when the queue is unbound (`{ queued: false, steps }`).
 */
export async function handle(
  env: ApiEnv,
  body: Record<string, unknown>,
  ctx: { hasCredential: boolean; request: Request },
): Promise<Response | unknown> {
  const denied = await adminGate(ctx.request, env as never, body, "moderator");
  if (denied) return denied;
  if (!env.HYPERDRIVE?.connectionString) {
    return Response.json(
      { error: { message: "Hyperdrive required.", code: "HYPERDRIVE_UNBOUND", id: "00000000-0000-4000-8000-0000000000b1", kind: "server" } },
      { status: 501 },
    );
  }
  return enqueueBackfillInstances(env);
}
