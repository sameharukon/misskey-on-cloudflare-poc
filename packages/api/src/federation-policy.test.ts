/**
 * Federation policy cache (ap/federation.ts): a meta update through the admin API applies to this
 * isolate at once instead of after the policy's 30 s cache.
 */
import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeFixture, type Fixture } from "./pglite-fixture.js";
import { getFederationPolicy, hostAllowed, resetFederationCache } from "./ap/federation.js";
import { apGet } from "./ap/remote.js";

let f: Fixture;

before(async () => {
  f = await makeFixture("federation-policy");
  await f.db.query(`UPDATE meta SET federation = 'all'`);
  resetFederationCache();
});

describe("federation policy cache", () => {
  it("admin/update-meta resets the cached policy (federation, blockedHosts)", async () => {
    assert.equal((await getFederationPolicy(f.env)).mode, "all");

    assert.equal((await f.call("admin/update-meta", { federation: "none" }, "a")).status, 204);
    assert.equal((await getFederationPolicy(f.env)).mode, "none");

    assert.equal((await f.call("admin/update-meta", { federation: "all", blockedHosts: ["bad.example"] }, "a")).status, 204);
    const p = await getFederationPolicy(f.env);
    assert.equal(p.mode, "all");
    assert.equal(hostAllowed(p, "sub.bad.example"), false);
    assert.equal(hostAllowed(p, "good.example"), true);
  });

  it("admin/update-meta applies signToActivityPubGet at once (instance actor cache)", async () => {
    const seen: (string | null)[] = [];
    f.env.AP_FETCH = (async (_url: string, init?: RequestInit) => {
      seen.push(new Headers(init?.headers).get("signature"));
      return new Response(JSON.stringify({ id: "https://remote.example/x", type: "Note" }), { headers: { "content-type": "application/activity+json" } });
    }) as unknown as typeof fetch;
    await apGet(f.env, "https://remote.example/x");
    assert.equal((await f.call("admin/update-meta", { signToActivityPubGet: false }, "a")).status, 204);
    await apGet(f.env, "https://remote.example/x");
    assert.equal((await f.call("admin/update-meta", { signToActivityPubGet: true }, "a")).status, 204);
    await apGet(f.env, "https://remote.example/x");
    assert.deepEqual(seen.map((x) => x != null), [true, false, true]);
  });
});
