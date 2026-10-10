/**
 * Per-IP Workers Rate Limiting in front of work that reaches out: inbox POSTs before they
 * are queued, `/proxy` misses and `/url`. A fake binding allows `n` calls per key.
 */
import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import worker from "./index.js";
import { makeFixture, type Fixture } from "./pglite-fixture.js";
import { setFederationPolicy } from "./ap/federation.js";
import { InMemoryQueueProducer, setQueueProducer } from "./queues/fanout.js";
import { ipOverLimit, getIpHash } from "./rate-limit.js";
import type { WorkersRateLimit } from "./env.js";
import { signedInboxHeaders } from "./test-inbox.js";

let f: Fixture;
const ctx = { waitUntil() {}, passThroughOnException() {} };
const BASE = "https://misskey.example.com";

function limiter(n: number): WorkersRateLimit & { keys: string[] } {
  const seen = new Map<string, number>();
  const keys: string[] = [];
  return {
    keys,
    async limit({ key }) {
      keys.push(key);
      seen.set(key, (seen.get(key) ?? 0) + 1);
      return { success: seen.get(key)! <= n };
    },
  };
}

before(async () => {
  f = await makeFixture("IpRateLimit", {
    AP_FETCH: (async () => new Response("no", { status: 404 })) as unknown as typeof fetch,
  });
  setFederationPolicy(f.env, { mode: "all", hosts: [], blockedHosts: [] });
  setQueueProducer(f.env, new InMemoryQueueProducer());
});

describe("ipOverLimit", () => {
  it("keys by the IP hash; unbound, without an IP or failing: not limited", async () => {
    const l = limiter(1);
    const req = new Request(BASE, { headers: { "cf-connecting-ip": "203.0.113.5" } });
    assert.equal(await ipOverLimit(l, req), false);
    assert.equal(await ipOverLimit(l, req), true);
    assert.deepEqual(l.keys, [getIpHash("203.0.113.5"), getIpHash("203.0.113.5")]);
    assert.equal(await ipOverLimit(undefined, req), false);
    assert.equal(await ipOverLimit(l, new Request(BASE)), false);
    const broken: WorkersRateLimit = { limit: async () => { throw new Error("down"); } };
    assert.equal(await ipOverLimit(broken, req), false);
  });
});

describe("routes", () => {
  const post = async (ip: string) =>
    worker.fetch(new Request(`${BASE}/inbox`, { method: "POST", headers: { ...(await signedInboxHeaders(`${BASE}/inbox`, "{}")), "cf-connecting-ip": ip }, body: "{}" }), f.env, ctx);

  it("inbox: 429 past the limit, before the message is queued", async () => {
    f.env.INBOX_RATE_LIMIT = limiter(1);
    try {
      assert.equal((await post("198.51.100.1")).status, 202);
      const r = await post("198.51.100.1");
      assert.deepEqual([r.status, r.headers.get("retry-after")], [429, "60"]);
      assert.equal((await post("198.51.100.2")).status, 202); // another IP
    } finally {
      delete f.env.INBOX_RATE_LIMIT;
    }
  });

  it("/proxy and /url: 429 past the limit, kept out of shared caches", async () => {
    f.env.FETCH_RATE_LIMIT = limiter(0);
    try {
      const headers = { "cf-connecting-ip": "198.51.100.3", "user-agent": "x" };
      const p = await worker.fetch(new Request(`${BASE}/proxy/a.webp?url=${encodeURIComponent("https://remote.example/a.png")}`, { headers }), f.env, ctx);
      assert.deepEqual([p.status, p.headers.get("cache-control")], [429, "no-store"]);
      const u = await worker.fetch(new Request(`${BASE}/url?url=${encodeURIComponent("https://remote.example/")}`, { headers }), f.env, ctx);
      assert.equal(u.status, 429);
    } finally {
      delete f.env.FETCH_RATE_LIMIT;
    }
  });
});
