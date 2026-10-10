/**
 * Router call gate (upstream ApiCallService): paramDef validation with ajv semantics (defaults,
 * `misskey:id`, nullable, anyOf), INVALID_PARAM shape, GET only for `allowGet`, null → 204.
 * Offline (no Hyperdrive): only the parameter checks of the gate run.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import worker from "./index.js";
import type { ApiEnv } from "./env.js";
import { fixtureMeta } from "../../packers/src/fixtures.js";
import { ENDPOINT_PARAM_DEFS } from "./endpoint-params.gen.js";
import { validateParams, type ParamSchema } from "./param-validate.js";

const env: ApiEnv = {
  INSTANCE_URL: "https://misskey.example.com",
  VERSION: "2026.10.0-cf-test",
  BOOTSTRAP_META_JSON: JSON.stringify(fixtureMeta({ name: "Gate Test" })),
};
const ctx = () => ({ waitUntil() {}, passThroughOnException() {} });

async function call(path: string, body: unknown, method = "POST"): Promise<{ status: number; data: any }> {
  const r = await worker.fetch(
    new Request(`https://api.test${path}`, method === "GET" ? { method } : { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    env,
    ctx(),
  );
  return { status: r.status, data: r.status === 204 || r.status === 405 ? null : await r.json().catch(() => null) };
}

describe("call gate: paramDef validation", () => {
  it("`test` returns the validated params with upstream defaults (and keeps unknown keys)", async () => {
    const r = await call("/api/test", { required: true, extra: 1 });
    assert.equal(r.status, 200);
    assert.deepEqual(r.data, { required: true, extra: 1, default: "hello", nullableDefault: "hello" });
    assert.deepEqual((await call("/api/test", { required: false, nullableDefault: null })).data.nullableDefault, null);
  });

  it("INVALID_PARAM carries upstream's id and { param, reason }", async () => {
    const missing = await call("/api/test", {});
    assert.equal(missing.status, 400);
    assert.equal(missing.data.error.code, "INVALID_PARAM");
    assert.equal(missing.data.error.id, "3d81ceae-475f-4600-b2a8-2bc116157532");
    assert.equal(typeof missing.data.error.info.param, "string");
    assert.match(missing.data.error.info.reason, /required/);
    const wrongType = await call("/api/test", { required: "yes" });
    assert.equal(wrongType.status, 400);
    assert.match(wrongType.data.error.info.reason, /boolean/);
  });

  it("misskey:id is /^[a-zA-Z0-9]+$/", () => {
    const schema = ENDPOINT_PARAM_DEFS["test"] as ParamSchema;
    assert.equal(validateParams(schema, { required: true, id: "abc123" }), null);
    assert.ok(validateParams(schema, { required: true, id: "a_b" }));
    assert.ok(validateParams(schema, { required: true, id: "" }));
  });

  it("anyOf schemas (users/show: userId | userIds | username) and nested defaults", () => {
    const show = ENDPOINT_PARAM_DEFS["users/show"] as ParamSchema;
    assert.equal(validateParams(show, { userId: "a1" }), null);
    assert.equal(validateParams(show, { username: "alice", host: null }), null);
    assert.ok(validateParams(show, {}));
    const tl = ENDPOINT_PARAM_DEFS["notes/timeline"] as ParamSchema;
    const body: Record<string, unknown> = {};
    assert.equal(validateParams(tl, body), null);
    assert.equal(body.limit, 10);
    assert.ok(validateParams(tl, { limit: 101 }));
    assert.ok(validateParams(tl, { limit: 0 }));
  });

  it("unknown endpoint names are 404 as upstream ApiServerService", async () => {
    const get = await call("/api/no/such/endpoint", null, "GET");
    assert.equal(get.status, 404);
    assert.equal(get.data.error.id, "2ca3b769-540a-4f08-9dd5-b5a825b6d0f1");
    const post = await call("/api/no-such-endpoint", {});
    assert.equal(post.status, 404);
    assert.equal(post.data.statusCode, 404);
  });

  it("GET only for allowGet endpoints; query string parameters", async () => {
    assert.equal((await call("/api/test?required=true", null, "GET")).status, 405);
    const ping = await call("/api/ping", null, "POST");
    assert.equal(ping.status, 200);
    assert.equal(typeof ping.data.pong, "number");
  });
});
