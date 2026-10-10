import type { ApiEnv } from "../env.js";
import { packInstanceMeta } from "../meta-source.js";

export const name = "meta";

export async function handle(env: ApiEnv, body: Record<string, unknown>): Promise<unknown> {
  const detail = body.detail === undefined ? true : Boolean(body.detail);
  return packInstanceMeta(env, detail);
}
