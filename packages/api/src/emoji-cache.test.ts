/**
 * emoji / emojis on PG (PGlite) and the read-through cache; meta cache; the admin gate through
 * the API Worker without credentials.
 */
import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import worker from "./index.js";
import { MemoryCacheStore } from "./cache.js";
import type { ApiEnv } from "./env.js";
import { makeFixture, type Fixture } from "./pglite-fixture.js";

function ctx() {
  return { waitUntil() {}, passThroughOnException() {} };
}

let f: Fixture;
before(async () => {
  f = await makeFixture("CacheTest");
  await f.db.query(
    `INSERT INTO emoji (id, name, aliases, category, "originalUrl", "publicUrl") VALUES ('emoji00000000001', 'blobcat', '{blobby}', 'cats', 'https://cdn.example/blobcat.png', 'https://cdn.example/blobcat.png')`,
  );
});

function baseEnv(over: Partial<ApiEnv> = {}): ApiEnv {
  return { ...f.env, VERSION: "0.0.0-test", ...over };
}

async function post(path: string, body: unknown = {}, env: ApiEnv = baseEnv(), headers: Record<string, string> = {}) {
  return worker.fetch(
    new Request(`https://api.test${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
    env,
    ctx(),
  );
}

describe("POST /api/emoji", () => {
  it("returns detailed emoji by name", async () => {
    const res = await post("/api/emoji", { name: "blobcat" });
    assert.equal(res.status, 200);
    const j = (await res.json()) as { name: string; id: string; url: string };
    assert.equal(j.name, "blobcat");
    assert.equal(j.id, "emoji00000000001");
    assert.equal(j.url, "https://cdn.example/blobcat.png");
  });

  it("missing emoji: INTERNAL_ERROR as upstream (findOneOrFail, no declared errors)", async () => {
    const res = await post("/api/emoji", { name: "nope" });
    assert.equal(res.status, 500);
    const j = (await res.json()) as { error: { code: string } };
    assert.equal(j.error.code, "INTERNAL_ERROR");
  });
});

describe("POST /api/emojis + cache", () => {
  it("lists local emojis", async () => {
    const res = await post("/api/emojis");
    assert.equal(res.status, 200);
    const j = (await res.json()) as { emojis: { name: string }[] };
    assert.equal(j.emojis.length, 1);
    assert.equal(j.emojis[0]!.name, "blobcat");
  });

  it("read-through MemoryCacheStore for emojis", async () => {
    const mem = new MemoryCacheStore();
    const env = baseEnv({ __cacheStore: mem });
    const r1 = await post("/api/emojis", {}, env);
    assert.equal(r1.status, 200);
    const cached = await mem.get("emojis:simple");
    assert.ok(cached);
    assert.ok(cached!.includes("blobcat"));
    // the second call is served from the cache even after the row is gone
    await f.db.query(`UPDATE emoji SET name = 'renamed' WHERE id = 'emoji00000000001'`);
    const r2 = await post("/api/emojis", {}, env);
    const j = (await r2.json()) as { emojis: { name: string }[] };
    assert.equal(j.emojis[0]!.name, "blobcat");
    await f.db.query(`UPDATE emoji SET name = 'blobcat' WHERE id = 'emoji00000000001'`);
  });

  it("caches packed meta", async () => {
    const mem = new MemoryCacheStore();
    const env = baseEnv({ __cacheStore: mem });
    await post("/api/meta", { detail: true }, env);
    assert.ok(await mem.get("meta:packed:detailed"));
    await post("/api/meta", { detail: false }, env);
    assert.ok(await mem.get("meta:packed:lite"));
  });
});

describe("admin via API worker", () => {
  it("401 without a credential (the old X-Misskey-Admin-Test header bypasses nothing)", async () => {
    assert.equal((await post("/api/admin/meta", {}, baseEnv())).status, 401);
    assert.equal((await post("/api/admin/meta", {}, baseEnv(), { "X-Misskey-Admin-Test": "1" })).status, 401);
  });
});
