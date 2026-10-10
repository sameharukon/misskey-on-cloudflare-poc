import type { ApiEnv } from "../env.js";
import { ENDPOINT_PARAM_DEFS } from "../endpoint-params.gen.js";

export const name = "endpoints";

/** upstream `endpoints`: every upstream endpoint name, in endpoint-list order. */
export async function handle(_env: ApiEnv, _body: Record<string, unknown>): Promise<unknown> {
  return Object.keys(ENDPOINT_PARAM_DEFS);
}
