import type { ApiEnv } from "../../env.js";
import { adminGate } from "../../admin-gate.js";
import { handleAdminServerInfo } from "../../server-info.js";

export const name = "admin/server-info";

export async function handle(
  env: ApiEnv,
  body: Record<string, unknown>,
  ctx: { request: Request },
): Promise<Response | unknown> {
  // upstream admin/server-info: requireModerator
  const denied = await adminGate(ctx.request, env, body, "moderator");
  if (denied) return denied;
  return handleAdminServerInfo(env);
}
