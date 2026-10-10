import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { withEdgeCache } from "./edge-cache.js";

function fakeCache() {
  const store = new Map<string, Response>();
  return {
    store,
    async match(req: Request) {
      return store.get(req.url)?.clone();
    },
    async put(req: Request, res: Response) {
      store.set(req.url, res);
    },
  };
}

const ok = (cc = "max-age=31536000, immutable") => async () => new Response("body", { headers: { "cache-control": cc } });

describe("withEdgeCache", () => {
  it("stores a cacheable 200 and serves the next GET from the cache", async () => {
    const cache = fakeCache();
    let calls = 0;
    const produce = async () => {
      calls++;
      return ok()();
    };
    const pending: Promise<unknown>[] = [];
    const r1 = await withEdgeCache(new Request("https://x/files/k"), (p) => pending.push(p), produce, { cache });
    assert.equal(await r1.text(), "body");
    await Promise.all(pending);
    const r2 = await withEdgeCache(new Request("https://x/files/k"), undefined, produce, { cache });
    assert.equal(await r2.text(), "body");
    assert.equal(calls, 1);
  });

  it("bypasses the cache for HEAD and uncacheable responses, and stores no Range response", async () => {
    const cache = fakeCache();
    await withEdgeCache(new Request("https://x/a", { method: "HEAD" }), undefined, ok(), { cache });
    await withEdgeCache(new Request("https://x/b", { headers: { range: "bytes=0-1" } }), undefined, ok(), { cache });
    await withEdgeCache(new Request("https://x/c"), undefined, ok("private, max-age=0"), { cache });
    await withEdgeCache(new Request("https://x/d"), undefined, async () => new Response("nf", { status: 404, headers: { "cache-control": "max-age=86400" } }), { cache });
    assert.equal(cache.store.size, 0);
  });

  it("answers a Range request from a stored response, and does not store one on a miss", async () => {
    const cache = fakeCache();
    let calls = 0;
    const produce = async () => (calls++, new Response("full", { headers: { "cache-control": "max-age=60" } }));
    await withEdgeCache(new Request("https://x/files/v"), undefined, produce, { cache });
    const r = await withEdgeCache(new Request("https://x/files/v", { headers: { range: "bytes=0-1" } }), undefined, produce, { cache });
    assert.equal(await r.text(), "full"); // the fake has no slicing; Cache API answers 206 from it
    assert.equal(calls, 1);
    await withEdgeCache(new Request("https://x/files/w", { headers: { range: "bytes=0-1" } }), undefined, produce, { cache });
    assert.equal(calls, 2);
    assert.equal(cache.store.has("https://x/files/w"), false);
  });

  it("does not store what CDN-Cache-Control keeps out of shared caches", async () => {
    const cache = fakeCache();
    const failed = async () => new Response("dummy", { headers: { "cache-control": "max-age=300", "cdn-cache-control": "no-store" } });
    await withEdgeCache(new Request("https://x/proxy/a?fallback=1"), undefined, failed, { cache });
    assert.equal(cache.store.size, 0);
  });

  it("caches other statuses when asked (the /emoji redirect)", async () => {
    const cache = fakeCache();
    const redirect = async () => new Response(null, { status: 301, headers: { location: "https://cdn/e.png", "cache-control": "public, max-age=86400" } });
    await withEdgeCache(new Request("https://x/emoji/a.webp"), undefined, redirect, { cache, statuses: [301] });
    assert.equal(cache.store.size, 1);
  });

  it("serves directly without a cache (workers.dev, Node)", async () => {
    const r = await withEdgeCache(new Request("https://x/files/k"), undefined, ok(), { cache: null });
    assert.equal(r.status, 200);
  });
});
