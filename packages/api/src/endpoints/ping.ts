import type { ApiEnv } from "../env.js";

export const name = "ping";

export async function handle(_env: ApiEnv, _body: Record<string, unknown>): Promise<unknown> {
  return { pong: Date.now() };
}
