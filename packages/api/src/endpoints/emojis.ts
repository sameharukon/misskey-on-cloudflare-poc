import type { ApiEnv } from "../env.js";
import { listEmojisSimple } from "../emoji-store.js";
import { hyperdriveUnbound } from "../handler-kit.js";

export const name = "emojis";

export async function handle(env: ApiEnv, _body: Record<string, unknown>): Promise<unknown> {
  if (!env.HYPERDRIVE?.connectionString) return hyperdriveUnbound();
  const emojis = await listEmojisSimple(env);
  return { emojis };
}
