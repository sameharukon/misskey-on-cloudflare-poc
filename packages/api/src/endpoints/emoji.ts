import type { ApiEnv } from "../env.js";
import { apiErrorResponse, INVALID_PARAM } from "../errors.js";
import { packEmojiDetailed } from "../emoji-store.js";
import { getLocalEmojiPg } from "../emojis-pg.js";
import { withHyperdriveClient } from "../pg.js";
import { hyperdriveUnbound } from "../handler-kit.js";

export const name = "emoji";

export async function handle(
  env: ApiEnv,
  body: Record<string, unknown>,
): Promise<Response | unknown> {
  const nameParam = body.name;
  if (typeof nameParam !== "string" || !nameParam) {
    return apiErrorResponse(INVALID_PARAM, 400);
  }
  if (!env.HYPERDRIVE?.connectionString) return hyperdriveUnbound();
  const found = await withHyperdriveClient(env.HYPERDRIVE, (c) => getLocalEmojiPg(c, nameParam));
  // upstream: findOneOrFail → EntityNotFoundError → INTERNAL_ERROR (the endpoint declares no errors)
  if (!found) throw new Error(`EntityNotFoundError: Could not find any entity of type "MiEmoji" matching name ${nameParam}`);
  return packEmojiDetailed(found);
}
