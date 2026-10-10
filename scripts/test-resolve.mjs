// Resolve / load hooks for scripts/test-hooks.mjs.
import { readFile } from "node:fs/promises";

const CF_WORKERS = new URL("../packages/shared/src/testing/cloudflare-workers.ts", import.meta.url).href;

export async function resolve(specifier, context, next) {
  if (specifier === "cloudflare:workers") return { url: CF_WORKERS, shortCircuit: true };
  return next(specifier, context);
}

// `.txt` imports are Text modules in the Workers (wrangler's default rule): the file as a string
export async function load(url, context, next) {
  if (url.startsWith("file:") && url.endsWith(".txt")) {
    const text = await readFile(new URL(url), "utf8");
    return { format: "module", source: `export default ${JSON.stringify(text)};`, shortCircuit: true };
  }
  return next(url, context);
}
