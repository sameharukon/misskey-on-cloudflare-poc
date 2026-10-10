/**
 * Cache-related behaviour around the API: a cache store refusing writes / deletes (KV's 429 for a
 * key written within the second) does not fail `meta` or `admin/update-meta`; AP / WebFinger /
 * well-known responses carry upstream's Cache-Control, Vary and CORS headers; media proxy error
 * responses keep shared caches out (CDN-Cache-Control: no-store).
 */
import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeFixture, type Fixture } from "./pglite-fixture.js";
import type { CacheStore } from "./cache.js";
import { setFederationPolicy } from "./ap/federation.js";
import { handleApRoutes } from "./ap/routes.js";
import { handleMediaProxy } from "./media-proxy.js";
import { setUserKeypairForTest } from "./ap/keys.js";
import { exportPkcs8Pem, exportSpkiPem, generateRsaKeyPair } from "../../ap/src/index.js";

/** Reads miss; every write and delete throws, as KV does under contention. */
const refusing: CacheStore = {
  async get() {
    return null;
  },
  async put() {
    throw new Error("KV PUT failed: 429 Too Many Requests");
  },
  async delete() {
    throw new Error("KV DELETE failed: 429 Too Many Requests");
  },
};

let f: Fixture;
const BASE = "https://misskey.example.com";

describe("cache store failures", () => {
  before(async () => {
    f = await makeFixture("CacheHeaders", { __cacheStore: refusing });
    setFederationPolicy(f.env, { mode: "all", hosts: [], blockedHosts: [] });
    const kp = await generateRsaKeyPair();
    setUserKeypairForTest(f.env, f.ids.b, { publicKey: await exportSpkiPem(kp.publicKey), privateKey: await exportPkcs8Pem(kp.privateKey) });
  });

  it("meta still answers when the cache write fails", async () => {
    const r = await f.call("meta", {});
    assert.equal(r.status, 200);
    assert.equal(typeof r.data.name, "string");
  });

  it("admin/update-meta succeeds when the cache delete fails", async () => {
    const r = await f.call("admin/update-meta", { name: "Renamed" }, "a");
    assert.ok(r.status === 200 || r.status === 204, `status ${r.status}`);
    assert.equal((await f.db.query<{ name: string }>(`SELECT name FROM meta`)).rows[0]!.name, "Renamed");
  });
});

describe("AP / well-known headers (upstream)", () => {
  const ap = (path: string, accept = "application/activity+json") => handleApRoutes(new Request(`${BASE}${path}`, { headers: { Accept: accept } }), f.env);
  const cors = (r: Response) => [r.headers.get("access-control-allow-origin"), r.headers.get("access-control-allow-methods"), r.headers.get("access-control-allow-headers"), r.headers.get("access-control-expose-headers")];
  const CORS = ["*", "GET, OPTIONS", "Accept", "Vary"];

  it("Person and Note: public, max-age=180, Vary: Accept, CORS", async () => {
    const person = (await ap(`/users/${f.ids.b}`))!;
    assert.equal(person.status, 200);
    assert.equal(person.headers.get("cache-control"), "public, max-age=180");
    assert.equal(person.headers.get("vary"), "Accept");
    assert.deepEqual(cors(person), CORS);
    const noteId = await f.note(f.ids.b, { text: "hello" });
    for (const path of [`/notes/${noteId}`, `/notes/${noteId}/activity`]) {
      const r = (await ap(path))!;
      assert.equal(r.status, 200, path);
      assert.equal(r.headers.get("cache-control"), "public, max-age=180", path);
      assert.deepEqual(cors(r), CORS, path);
    }
  });

  it("WebFinger: public, max-age=180, Vary: Accept, CORS; nodeinfo links and host-meta: CORS", async () => {
    const wf = (await ap(`/.well-known/webfinger?resource=acct:user_b@misskey.example.com`, "application/jrd+json"))!;
    assert.equal(wf.status, 200);
    assert.equal(wf.headers.get("cache-control"), "public, max-age=180");
    assert.equal(wf.headers.get("vary"), "Accept");
    assert.deepEqual(cors(wf), CORS);
    assert.deepEqual(cors((await ap("/.well-known/nodeinfo", "application/json"))!), CORS);
    assert.deepEqual(cors((await ap("/.well-known/host-meta", "application/xrd+xml"))!), CORS);
  });
});

describe("media proxy errors", () => {
  it("keep upstream's Cache-Control for the client and stay out of shared caches", async () => {
    // no User-Agent → 400, or the dummy image with ?fallback
    for (const q of ["", "&fallback=1"]) {
      const r = await handleMediaProxy(f.env, new Request(`${BASE}/proxy/a.webp?url=${encodeURIComponent("https://remote.example/a.png")}${q}`));
      assert.equal(r.status, q ? 200 : 400);
      assert.equal(r.headers.get("cache-control"), "max-age=300");
      assert.equal(r.headers.get("cdn-cache-control"), "no-store");
    }
  });
});
