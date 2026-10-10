import type { ApiEnv } from "../../../env.js";
import { ACCESS_DENIED, apiErrorResponse, CREDENTIAL_REQUIRED, INVALID_PARAM } from "../../../errors.js";
import { authUserId } from "../../../handler-kit.js";
import { listTimelineIdsFromDo } from "../../../notes-pg.js";
import { getRootUserId } from "../../../users-pg.js";
import { timelineDoId } from "../../../../../shared/src/index.js";

export const name = "admin/cf-debug/timeline";

/**
 * misskey-cf only (not upstream): root-only view of raw TimelineShard DO ids for a timeline key.
 * Only `antenna:{id}` and `role:{id}` lists are written (home / local / hybrid / global are read
 * from PG); used to check that the fanout landed in the DO.
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
  const key = typeof body.timelineKey === "string" ? body.timelineKey : null;
  if (!key || !/^(antenna|role):[0-9a-z]+$/.test(key)) return apiErrorResponse(INVALID_PARAM, 400);
  const limit = typeof body.limit === "number" ? Math.max(1, Math.min(100, body.limit)) : 20;
  const ids = await listTimelineIdsFromDo(env, key, { limit });
  return { timelineKey: key, doName: timelineDoId(key), bound: ids !== null, ids: ids ?? [] };
}
