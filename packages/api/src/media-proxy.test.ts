/**
 * `/proxy/*` (upstream FileServerProxyHandler): remote downloads and local drive files, the
 * conversions through the media Container (mocked), fallbacks, errors and the external proxy.
 */
import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import worker from "./index.js";
import { makeFixture, type Fixture } from "./pglite-fixture.js";

let f: Fixture;
const ctx = { waitUntil() {}, passThroughOnException() {} };
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 4, 0, 0, 0, 4]);
const GIF = new TextEncoder().encode("GIF89a\x01\x00\x01\x00");
const remote = new Map<string, () => Response>();
const media: string[] = [];
const r2 = new Map<string, Uint8Array>();
const r2Gets: string[] = [];
const get = async (path: string, headers: Record<string, string> = { "user-agent": "Mozilla/5.0" }) => {
  const res = await worker.fetch(new Request(`https://misskey.example.com${path}`, { headers }), f.env, ctx);
  return { status: res.status, headers: res.headers, bytes: new Uint8Array(await res.arrayBuffer()) };
};
const q = (u: string) => encodeURIComponent(u);
/** a PNG past the bytes read before deciding (64 KiB) */
const BIG_PNG = new Uint8Array(200_000).map((_, i) => (i < PNG.length ? PNG[i]! : i % 251));
/** a body without Content-Length, in `size`-byte chunks */
const chunked = (b: Uint8Array, size: number) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      for (let i = 0; i < b.length; i += size) c.enqueue(b.slice(i, i + size));
      c.close();
    },
  });

before(async () => {
  f = await makeFixture("MediaProxyTest", {
    AP_FETCH: (async (url: string) => {
      const h = remote.get(url);
      return h ? h() : new Response("no", { status: 404 });
    }) as unknown as typeof fetch,
  });
  f.env.MEDIA = {
    fetch: async (input: RequestInfo | URL) => {
      const u = new URL(String(input));
      media.push(`${u.pathname}?${u.searchParams.toString()}`);
      if (u.searchParams.get("mode") === "badge") return new Response("{}", { status: 404 });
      return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": u.searchParams.get("mode") === "badge" ? "image/png" : "image/webp", "x-ext": "webp" } });
    },
  } as unknown as typeof f.env.MEDIA;
  f.env.MEDIA_BUCKET = {
    get: async (k: string, o?: { range?: { offset: number; length: number } }) => {
      const v = r2.get(k);
      if (!v) return null;
      r2Gets.push(o?.range ? `${k}@${o.range.offset}+${o.range.length}` : k);
      const part = o?.range ? v.slice(o.range.offset, o.range.offset + o.range.length) : v;
      return { size: v.byteLength, body: new Response(part as unknown as BodyInit).body, arrayBuffer: async () => part.slice().buffer };
    },
  } as unknown as typeof f.env.MEDIA_BUCKET;
  remote.set("https://remote.example/a.png", () => new Response(PNG, { headers: { "content-type": "image/png" } }));
  remote.set("https://remote.example/anim.gif", () => new Response(GIF));
  remote.set("https://remote.example/doc.pdf", () => new Response("%PDF-1.4 xxx"));
  remote.set("https://remote.example/x.svg", () => new Response('<svg xmlns="http://www.w3.org/2000/svg"/>'));
  remote.set("https://remote.example/big.png", () => new Response(chunked(BIG_PNG, 10_000)));
  remote.set("https://remote.example/huge.png", () => new Response(chunked(BIG_PNG, 10_000)));
});

describe("media proxy", () => {
  it("serves the original with upstream's headers, and Range on it", async () => {
    const r = await get(`/proxy/image.webp?url=${q("https://remote.example/a.png")}`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("content-type"), "image/png");
    assert.equal(r.headers.get("cache-control"), "max-age=31536000, immutable");
    assert.equal(r.headers.get("content-disposition"), 'inline; filename="a.png"');
    assert.equal(r.headers.get("content-security-policy"), "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'");
    assert.deepEqual([...r.bytes], [...PNG]);
    const part = await get(`/proxy/image.webp?url=${q("https://remote.example/a.png")}`, { "user-agent": "x", range: "bytes=0-3" });
    assert.equal(part.status, 206);
    assert.equal(part.headers.get("content-range"), `bytes 0-3/${PNG.length}`);
    assert.deepEqual([...part.bytes], [...PNG.slice(0, 4)]);
    // the path form (`/proxy/<host/path>` without `url`)
    assert.equal((await get("/proxy/remote.example/a.png")).status, 200);
  });

  it("converts emoji / avatar / static / preview / svg through the container; badge 404 passes through", async () => {
    media.length = 0;
    for (const [query, mode] of [["emoji=1", "emoji"], ["avatar=1&static=1", "avatar"], ["static=1", "static"], ["preview=1", "preview"]] as const) {
      const r = await get(`/proxy/image.webp?url=${q("https://remote.example/a.png")}&${query}`);
      assert.equal(r.status, 200, query);
      assert.equal(r.headers.get("content-type"), "image/webp");
      assert.equal(r.headers.get("content-disposition"), 'inline; filename="a.png.webp"'); // correctFilename appends, as upstream
      assert.ok(media.at(-1)!.includes(`mode=${mode}`), query);
    }
    assert.ok(media.some((m) => m.includes("mode=avatar") && m.includes("static=1")));
    assert.equal((await get(`/proxy/image.webp?url=${q("https://remote.example/x.svg")}`)).headers.get("content-type"), "image/webp");
    assert.equal((await get(`/proxy/image.webp?url=${q("https://remote.example/a.png")}&badge=1`)).status, 404);
    // non-image with a conversion → 404; non-image original → 403
    assert.equal((await get(`/proxy/image.webp?url=${q("https://remote.example/doc.pdf")}&emoji=1`)).status, 404);
    assert.equal((await get(`/proxy/image.webp?url=${q("https://remote.example/doc.pdf")}`)).status, 403);
  });

  it("without the container: originals for emoji / avatar / static / preview, 500 for badge / svg", async () => {
    const saved = f.env.MEDIA;
    delete f.env.MEDIA;
    try {
      const e = await get(`/proxy/image.webp?url=${q("https://remote.example/a.png")}&emoji=1`);
      assert.deepEqual([e.status, e.headers.get("content-type")], [200, "image/png"]);
      assert.equal((await get(`/proxy/image.webp?url=${q("https://remote.example/a.png")}&badge=1`)).status, 500);
      assert.equal((await get(`/proxy/image.webp?url=${q("https://remote.example/x.svg")}`)).status, 500);
    } finally {
      f.env.MEDIA = saved;
    }
  });

  it("local drive files by access key (R2 or the link's remote original); not-found dummy, unavailable 204", async () => {
    await f.db.query(`INSERT INTO drive_file (id, "userId", type, name, url, "accessKey", "isLink", md5, size, "storedInternal") VALUES ('df1', $1, 'image/png', 'local.png', 'x', 'k1', FALSE, '0', 0, FALSE), ('df2', $1, 'image/png', 'link.png', 'x', 'k2', TRUE, '0', 0, FALSE), ('df3', $1, 'image/png', 'gone.png', 'x', 'k3', FALSE, '0', 0, FALSE)`, [f.ids.b]);
    await f.db.query(`UPDATE drive_file SET uri = 'https://remote.example/a.png' WHERE id = 'df2'`);
    r2.set("drive/k1", PNG);
    const local = await get(`/proxy/image.webp?url=${q("https://misskey.example.com/files/k1")}`);
    assert.deepEqual([local.status, local.headers.get("content-disposition")], [200, 'inline; filename="local.png"']);
    assert.equal((await get(`/proxy/image.webp?url=${q("https://misskey.example.com/files/k2")}`)).headers.get("content-disposition"), 'inline; filename="link.png"');
    assert.equal((await get(`/proxy/image.webp?url=${q("https://misskey.example.com/files/k3")}`)).status, 204);
    const nf = await get(`/proxy/image.webp?url=${q("https://misskey.example.com/files/nope")}`);
    assert.deepEqual([nf.status, nf.headers.get("content-type"), nf.headers.get("cache-control")], [404, "image/png", "max-age=86400"]);
    assert.ok(nf.bytes.length > 1000); // upstream dummy.png
  });

  it("errors: user agent, remote status, private hosts, fallback image; external proxy redirect", async () => {
    assert.equal((await get(`/proxy/image.webp?url=${q("https://remote.example/a.png")}`, {})).status, 400);
    assert.equal((await get(`/proxy/image.webp?url=${q("https://remote.example/a.png")}`, { "user-agent": "Misskey/2026 (x)" })).status, 403);
    const missing = await get(`/proxy/image.webp?url=${q("https://remote.example/missing.png")}`);
    assert.deepEqual([missing.status, missing.headers.get("cache-control")], [404, "max-age=300"]);
    assert.equal((await get(`/proxy/image.webp?url=${q("http://127.0.0.1/a.png")}`)).status, 400);
    const fb = await get(`/proxy/image.webp?url=${q("https://remote.example/missing.png")}&fallback=1`);
    assert.deepEqual([fb.status, fb.headers.get("content-type")], [200, "image/png"]);

    f.env.MEDIA_PROXY = "https://mp.example";
    try {
      const r = await get(`/proxy/image.webp?url=${q("https://remote.example/a.png")}&emoji=1`);
      assert.equal(r.status, 301);
      assert.equal(r.headers.get("location"), "https://mp.example/image.webp?url=https%3A%2F%2Fremote.example%2Fa.png&emoji=1");
      assert.equal(r.headers.get("cache-control"), "public, max-age=259200");
      assert.equal((await get(`/proxy/image.webp?url=${q("https://remote.example/a.png")}&origin=1`)).status, 200); // must be served here
    } finally {
      delete f.env.MEDIA_PROXY;
    }
  });

  it("streams a large original through; converts it whole; MAX_FILE_SIZE stops the stream", async () => {
    const r = await get(`/proxy/image.webp?url=${q("https://remote.example/big.png")}`);
    assert.deepEqual([r.status, r.headers.get("content-type")], [200, "image/png"]);
    assert.deepEqual(r.bytes, BIG_PNG);
    const part = await get(`/proxy/image.webp?url=${q("https://remote.example/big.png")}`, { "user-agent": "x", range: "bytes=100000-100009" });
    assert.deepEqual([part.status, part.headers.get("content-range")], [206, `bytes 100000-100009/${BIG_PNG.length}`]);
    assert.deepEqual(part.bytes, BIG_PNG.slice(100000, 100010));
    media.length = 0;
    assert.equal((await get(`/proxy/image.webp?url=${q("https://remote.example/big.png")}&static=1`)).status, 200);
    assert.ok(media.at(-1)!.includes(`key=${q("https://remote.example/big.png")}`));

    const saved = f.env.MAX_FILE_SIZE;
    f.env.MAX_FILE_SIZE = "150000";
    try {
      // past the limit after the response started: the body errors instead of ending short
      const res = await worker.fetch(new Request(`https://misskey.example.com/proxy/image.webp?url=${q("https://remote.example/huge.png")}`, { headers: { "user-agent": "x" } }), f.env, ctx);
      assert.equal(res.status, 200);
      await assert.rejects(res.arrayBuffer());
      // within the bytes read first: 413
      f.env.MAX_FILE_SIZE = "1000";
      assert.equal((await get(`/proxy/image.webp?url=${q("https://remote.example/huge.png")}`)).status, 413);
    } finally {
      f.env.MAX_FILE_SIZE = saved;
    }
  });

  it("a local original streams from R2, and a Range on it is an R2 range read", async () => {
    await f.db.query(`INSERT INTO drive_file (id, "userId", type, name, url, "accessKey", "isLink", md5, size, "storedInternal") VALUES ('df4', $1, 'image/png', 'big.png', 'x', 'k4', FALSE, '0', 0, FALSE)`, [f.ids.b]);
    r2.set("drive/k4", BIG_PNG);
    r2Gets.length = 0;
    const r = await get(`/proxy/image.webp?url=${q("https://misskey.example.com/files/k4")}`);
    assert.deepEqual(r.bytes, BIG_PNG);
    const part = await get(`/proxy/image.webp?url=${q("https://misskey.example.com/files/k4")}`, { "user-agent": "x", range: "bytes=-5" });
    assert.deepEqual([part.status, part.headers.get("content-range")], [206, `bytes ${BIG_PNG.length - 5}-${BIG_PNG.length - 1}/${BIG_PNG.length}`]);
    assert.deepEqual(part.bytes, BIG_PNG.slice(-5));
    assert.deepEqual(r2Gets, ["drive/k4", "drive/k4", `drive/k4@${BIG_PNG.length - 5}+5`]);
  });
});
