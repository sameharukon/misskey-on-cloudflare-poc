import type { ApiEnv } from "../env.js";
import { CREDENTIAL_REQUIRED, apiErrorResponse } from "../errors.js";
import { authenticatePg, extractToken } from "../auth-pg.js";
import { packMe } from "../client-endpoints-pg.js";
import { withHyperdriveClient } from "../pg.js";

export const name = "i";

const USER_IS_DELETED = { message: "User is deleted.", code: "USER_IS_DELETED", id: "e5b3b9f0-2b8f-4b9f-9c1f-8c5c1b2e1b1a", kind: "permission" as const };

/**
 * upstream `i`: records today in loggedInDates, then MeDetailed (`includeSecrets` for the
 * native token only).
 */
export async function handle(
  env: ApiEnv,
  body: Record<string, unknown>,
  ctx: { hasCredential: boolean; request: Request },
): Promise<Response | unknown> {
  const token = extractToken(ctx.request, body);
  if (!ctx.hasCredential || !token) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  if (!env.HYPERDRIVE?.connectionString) {
    return apiErrorResponse({ message: "Authentication requires Hyperdrive / Postgres.", code: "AUTH_PG_REQUIRED", id: "00000000-0000-4000-8000-0000000000a2", kind: "server" }, 501);
  }
  const auth = await authenticatePg(env, token);
  if (!auth) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  const now = new Date();
  const today = `${now.getFullYear()}/${now.getMonth() + 1}/${now.getDate()}`;
  const ok = await withHyperdriveClient(env.HYPERDRIVE, async (c) => {
    const r = (await c.query(`SELECT "loggedInDates" FROM user_profile WHERE "userId" = $1`, [auth.user.id])).rows[0];
    if (!r) return false;
    const dates = (r.loggedInDates as string[] | null) ?? [];
    if (!dates.includes(today)) await c.query(`UPDATE user_profile SET "loggedInDates" = $1::varchar[] WHERE "userId" = $2`, [[...dates, today], auth.user.id]);
    return true;
  });
  if (!ok) return apiErrorResponse(USER_IS_DELETED, 403);
  return packMe(env, auth.user.id, { includeSecrets: auth.accessTokenId == null });
}
