/** Prints IMPLEMENTED_ENDPOINTS (derived from the API's handler table) as JSON, for the .mjs scripts. */
import { IMPLEMENTED_ENDPOINTS } from "../packages/api/src/registry.js";

process.stdout.write(`${JSON.stringify(IMPLEMENTED_ENDPOINTS)}\n`);
process.exit(0);
