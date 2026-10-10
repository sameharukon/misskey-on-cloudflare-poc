/**
 * A Worker's entry module may only export handlers (functions, classes, handler objects):
 * workerd refuses to start on any other export ("Incorrect type for map entry …"), which no
 * offline test of the handlers notices (`cloudflare:workers` resolves to a stand-in under Node, see
 * scripts/test-hooks.mjs). media's entry needs the Containers runtime and exports only the class
 * and handler.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const ENTRIES = {
  api: "../../api/src/worker.js",
  gateway: "../../gateway/src/index.js",
  stream: "../../stream/src/index.js",
  timeline: "../../timeline/src/index.js",
};

describe("Worker entry modules", () => {
  for (const [name, path] of Object.entries(ENTRIES)) {
    it(`${name} exports only functions, classes and objects`, async () => {
      const mod = (await import(path)) as Record<string, unknown>;
      const bad = Object.entries(mod).filter(([, v]) => v === null || (typeof v !== "function" && typeof v !== "object"));
      assert.deepEqual(bad.map(([k]) => k), []);
    });
  }
});
