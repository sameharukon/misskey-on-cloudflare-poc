import { describe, it } from "node:test";
import assert from "node:assert/strict";
import worker from "./index.js";
import { endpointNameFromPath, hasCredential } from "./router.js";
import { ENDPOINT_PARAM_DEFS } from "./endpoint-params.gen.js";
import { IMPLEMENTED_ENDPOINTS } from "./registry.js";
import type { ApiEnv } from "./env.js";
import { fixtureMeta } from "../../packers/src/fixtures.js";

function ctx() {
  return { waitUntil() {}, passThroughOnException() {} };
}

const env: ApiEnv = {
  INSTANCE_URL: "https://misskey.example.com",
  VERSION: "2026.10.0-cf-test",
  BOOTSTRAP_META_JSON: JSON.stringify(
    fixtureMeta({
      name: "API Test",
      disableRegistration: true,
      policies: { ltlAvailable: true, gtlAvailable: false },
    }),
  ),
};

async function post(path: string, body: unknown = {}, e: ApiEnv = env): Promise<Response> {
  return worker.fetch(
    new Request(`https://api.test${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    e,
    ctx(),
  );
}

describe("endpointNameFromPath", () => {
  it("parses nested names", () => {
    assert.equal(endpointNameFromPath("/api/ping"), "ping");
    assert.equal(endpointNameFromPath("/api/notes/show"), "notes/show");
    assert.equal(endpointNameFromPath("/api"), null);
  });
});

describe("hasCredential", () => {
  it("detects i and Bearer", () => {
    assert.equal(hasCredential(new Request("https://x"), {}), false);
    assert.equal(hasCredential(new Request("https://x"), { i: "token" }), true);
    assert.equal(
      hasCredential(new Request("https://x", { headers: { Authorization: "Bearer abc" } }), {}),
      true,
    );
  });
});

describe("POST /api/ping", () => {
  it("returns pong number", async () => {
    const res = await post("/api/ping");
    assert.equal(res.status, 200);
    const j = (await res.json()) as { pong: number };
    assert.equal(typeof j.pong, "number");
    assert.ok(j.pong > 0);
  });
});

describe("POST /api/meta", () => {
  it("returns MetaDetailed by default", async () => {
    const res = await post("/api/meta", {});
    assert.equal(res.status, 200);
    const j = (await res.json()) as {
      name: string;
      uri: string;
      version: string;
      features?: { registration: boolean; miauth: boolean };
      policies: { ltlAvailable: boolean };
    };
    assert.equal(j.name, "API Test");
    assert.equal(j.uri, "https://misskey.example.com");
    assert.equal(j.version, "2026.10.0-cf-test");
    assert.ok(j.features);
    assert.equal(j.features!.registration, false);
    assert.equal(j.features!.miauth, true);
    assert.equal(j.policies.ltlAvailable, true);
  });

  it("maxFileSize is the server limit (MAX_FILE_SIZE, 100 MB by default)", async () => {
    const lite = async (e: ApiEnv) => ((await (await post("/api/meta", { detail: false }, e)).json()) as { maxFileSize: number }).maxFileSize;
    assert.equal(await lite(env), 100 * 1024 * 1024);
    assert.equal(await lite({ ...env, MAX_FILE_SIZE: "209715200" }), 209715200);
  });

  it("detail=false returns lite without features", async () => {
    const res = await post("/api/meta", { detail: false });
    assert.equal(res.status, 200);
    const j = (await res.json()) as Record<string, unknown>;
    assert.equal(j.name, "API Test");
    assert.equal("features" in j, false);
  });
});

describe("POST /api/emojis", () => {
  it("501 when Hyperdrive is unbound", async () => {
    const res = await post("/api/emojis");
    assert.equal(res.status, 501);
    assert.equal(((await res.json()) as { error: { code: string } }).error.code, "HYPERDRIVE_UNBOUND");
  });
});

describe("POST /api/endpoints + /api/endpoint", () => {
  it("lists the upstream endpoint names (endpoint-list order)", async () => {
    const res = await post("/api/endpoints");
    assert.equal(res.status, 200);
    const list = (await res.json()) as string[];
    assert.deepEqual(list, Object.keys(ENDPOINT_PARAM_DEFS));
    assert.ok(list.includes("notes/create"));
    assert.ok(!list.some((x) => x.startsWith("admin/cf-debug/")));
  });

  it("describes meta params", async () => {
    const res = await post("/api/endpoint", { endpoint: "meta" });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      params: [{ name: "detail", type: "Boolean" }],
    });
  });

  it("returns null (204, upstream ApiCallService.send) for unknown endpoint name", async () => {
    const res = await post("/api/endpoint", { endpoint: "nope" });
    assert.equal(res.status, 204);
  });
});

describe("POST /api/i", () => {
  it("401 without credential", async () => {
    const res = await post("/api/i");
    assert.equal(res.status, 401);
    const j = (await res.json()) as { error: { code: string } };
    assert.equal(j.error.code, "CREDENTIAL_REQUIRED");
  });

  it("501 with token when Hyperdrive unbound", async () => {
    const res = await post("/api/i", { i: "fake-token" });
    assert.equal(res.status, 501);
    const j = (await res.json()) as { error: { code: string } };
    assert.equal(j.error.code, "AUTH_PG_REQUIRED");
  });
});

describe("unknown / healthz", () => {
  it("501 for unimplemented endpoint", async () => {
    const res = await post("/api/clips/create", { name: "x" });
    assert.equal(res.status, 501);
  });

  it("healthz", async () => {
    const res = await worker.fetch(new Request("https://api.test/healthz"), env, ctx());
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, service: "api" });
  });

  it("healthz/db without Hyperdrive → 503", async () => {
    const res = await worker.fetch(new Request("https://api.test/healthz/db"), env, ctx());
    assert.equal(res.status, 503);
    // a coarse state only (no meta name, root id or PG error text)
    assert.deepEqual(await res.json(), { service: "api", hyperdrive: false, state: "unbound" });
  });
});
