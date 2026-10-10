import type { ApiEnv } from "../../env.js";
import { apiErrorResponse } from "../../errors.js";
import { iUpdatePg } from "../../i-update-pg.js";

export const name = "i/update";

/** i/update (upstream paramDef; see i-update-pg.ts). PG only. */
export async function handle(
  env: ApiEnv,
  body: Record<string, unknown>,
  ctx: { hasCredential: boolean; request: Request },
): Promise<Response | unknown> {
  if (env.HYPERDRIVE?.connectionString) return iUpdatePg(env, body, ctx);
  return apiErrorResponse(
    { message: "Hyperdrive required.", code: "HYPERDRIVE_UNBOUND", id: "00000000-0000-4000-8000-0000000000b1", kind: "server" },
    501,
  );
}
