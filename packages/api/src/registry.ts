/**
 * Endpoints this API answers under upstream's names. Derived from the handler table: every
 * upstream endpoint (ENDPOINT_META, generated from the pinned upstream) that has a handler, plus
 * the sign-in routes upstream serves outside its endpoint list. Parameters come from the
 * generated ENDPOINT_PARAM_DEFS; there is no hand-maintained list to keep in sync.
 */
import { handlers } from "./endpoints/index.js";
import { ENDPOINT_META } from "./endpoint-meta.gen.js";

/** Served by upstream's ApiServerService routes rather than its endpoint list. */
const SIGNIN_ROUTES = ["signin-flow", "signin-with-passkey"];

export const IMPLEMENTED_ENDPOINTS: readonly string[] = Object.keys(handlers)
  .filter((name) => name in ENDPOINT_META || SIGNIN_ROUTES.includes(name))
  .sort();
