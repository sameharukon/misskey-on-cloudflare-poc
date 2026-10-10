import type { ApiEnv } from "../env.js";
import { ENDPOINT_PARAM_DEFS } from "../endpoint-params.gen.js";

export const name = "endpoint";

/** upstream `endpoint`: the top-level paramDef properties of an upstream endpoint, or null. */
export async function handle(_env: ApiEnv, body: Record<string, unknown>): Promise<unknown> {
  const ep = typeof body.endpoint === "string" && Object.hasOwn(ENDPOINT_PARAM_DEFS, body.endpoint) ? ENDPOINT_PARAM_DEFS[body.endpoint] : null;
  if (ep == null) return null;
  return {
    params: Object.entries(ep.properties ?? {}).map(([k, v]) => ({
      name: k,
      type: typeof v.type === "string" && v.type ? v.type.charAt(0).toUpperCase() + v.type.slice(1) : "string",
    })),
  };
}
