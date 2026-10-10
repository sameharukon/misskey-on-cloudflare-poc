/**
 * `/url` (upstream UrlPreviewService) with the summaly port (url-preview/), remote pages mocked.
 */
import { before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import worker from "./index.js";
import { makeFixture, type Fixture } from "./pglite-fixture.js";
import { resetUrlPreviewCache } from "./url-preview/handler.js";
import { summaly, isPrivateHost } from "./url-preview/summaly.js";
import { attrOf, parseHtml, textAll } from "./url-preview/html.js";

let f: Fixture;
const ctx = { waitUntil() {}, passThroughOnException() {} };
const pages = new Map<string, (req: { method: string; headers: Record<string, string> }) => Response>();
const requests: { url: string; method: string; headers: Record<string, string> }[] = [];
const html = (body: string | Uint8Array, headers: Record<string, string> = {}) => () =>
  new Response(body as BodyInit, { headers: { "content-type": "text/html; charset=utf-8", ...headers } });
const fetchMock = (async (input: string, init?: RequestInit) => {
  const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
  const method = init?.method ?? "GET";
  requests.push({ url: input, method, headers });
  const h = pages.get(input);
  if (!h) return new Response("nope", { status: 404 });
  const res = h({ method, headers });
  return method === "HEAD" ? new Response(null, { status: res.status, headers: res.headers }) : res;
}) as unknown as typeof fetch;
const get = async (q: string) => {
  const res = await worker.fetch(new Request(`https://misskey.example.com/url?${q}`), f.env, ctx);
  return { status: res.status, headers: res.headers, body: (await res.json()) as any };
};

const PAGE = `<!DOCTYPE html><html><head>
  <title>ignored title</title>
  <meta property="og:title" content="Hello &amp;amp; world - Example Site">
  <meta property="og:site_name" content="Example Site">
  <meta name="description" content="A page">
  <meta property="og:image" content="/img/og.png">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:player" content="https://player.example/ignored">
  <meta property="og:video" content="https://player.example/v">
  <meta property="og:video:width" content="640"><meta property="og:video:height" content="360">
  <link rel="icon" href="/fav.png">
  <link rel="alternate" type="application/activity+json" href="https://example.com/notes/1">
  <meta name='fediverse:creator' content='@a@example.com'>
  <script>var x = "<meta property='og:title' content='no'>";</script>
</head><body><svg><title>svg</title></svg></body></html>`;

before(async () => {
  f = await makeFixture("UrlPreviewTest", { AP_FETCH: fetchMock });
  pages.set("https://example.com/page", html(PAGE));
  pages.set("https://example.com/fav.png", () => new Response("png", { headers: { "content-type": "image/png" } }));
});
beforeEach(() => {
  resetUrlPreviewCache();
  requests.length = 0;
});

describe("html helper", () => {
  it("finds attributes / text like cheerio for summaly's selectors", () => {
    const $ = parseHtml(`<head><meta name=a content="x &amp; y"><meta name="a" content="second"><title>t &lt;1&gt;</title><style>.a{content:"<title>no</title>"}</style></head><body><p>a<b>b</b></p><title>2</title><!-- <title>c</title> --></body>`);
    assert.equal(attrOf($, "meta", { name: "a" }, "content"), "x & y");
    assert.equal(textAll($, "title"), "t <1>2");
    assert.equal(attrOf($, "meta", { name: "missing" }, "content"), undefined);
  });
});

describe("summaly port", () => {
  it("general: og / twitter / oEmbed-less player, icon by HEAD, title cleanup, double-decoded entities", async () => {
    const s = await summaly("https://example.com/page", { fetch: fetchMock, lang: "ja-JP" });
    assert.deepEqual(s, {
      title: "Hello & world",
      icon: "https://example.com/fav.png",
      description: "A page",
      thumbnail: "https://example.com/img/og.png",
      thumbnailStyle: "summary_large_image",
      player: { url: "https://player.example/v", width: 640, height: 360, allow: ["autoplay", "encrypted-media", "fullscreen"] },
      sitename: "Example Site",
      sensitive: false,
      activityPub: "https://example.com/notes/1",
      fediverseCreator: "@a@example.com",
      url: "https://example.com/page",
    });
    const scrape = requests.find((r) => r.method === "GET" && r.url === "https://example.com/page")!;
    assert.equal(scrape.headers.accept, "text/html,application/xhtml+xml");
    assert.equal(scrape.headers["accept-language"], "ja-JP");
    assert.match(scrape.headers["user-agent"]!, /^SummalyBot\/5\.5\.1/);
  });

  it("oEmbed iframe player, <title> fallback, missing favicon, sensitive rating, Shift_JIS pages", async () => {
    pages.set("https://o.example/", html(`<html><head><title>Only title</title><meta name="rating" content="adult"><link type="application/json+oembed" href="/oembed"></head></html>`));
    pages.set("https://o.example/oembed", () => Response.json({ version: "1.0", type: "video", width: 500, height: 2000, html: '<iframe src="https://embed.o.example/1" allow="autoplay; gyroscope" allowfullscreen></iframe>' }));
    const s = await summaly("https://o.example/", { fetch: fetchMock });
    assert.equal(s.title, "Only title");
    assert.equal(s.icon, null);
    assert.equal(s.sensitive, true);
    assert.deepEqual(s.player, { url: "https://embed.o.example/1", width: 500, height: 1024, allow: ["autoplay", "fullscreen"] });

    pages.set("https://o.example/bad-oembed", html(`<html><head><title>x</title><link type="application/json+oembed" href="/oembed2"></head></html>`));
    pages.set("https://o.example/oembed2", () => Response.json({ version: "1.0", type: "rich", html: '<iframe src="https://e.example" allow="camera"></iframe>' }));
    assert.equal((await summaly("https://o.example/bad-oembed", { fetch: fetchMock })).player.url, null);

    // a Shift_JIS page decoded through chardet
    // (chardet guesses from statistics, so the sample has to be long enough, as with summaly)
    const sentence = [0x82, 0xb1, 0x82, 0xf1, 0x82, 0xc9, 0x82, 0xbf, 0x82, 0xcd, 0x81, 0x41, 0x90, 0xa2, 0x8a, 0x45, 0x81, 0x42]; // こんにちは、世界。
    const sjis = new Uint8Array([...new TextEncoder().encode('<html><head><meta charset="shift_jis"><title>'), ...Array(20).fill(sentence).flat(), ...new TextEncoder().encode("</title></head></html>")]);
    pages.set("https://sjis.example/", html(sjis, { "content-type": "text/html" }));
    assert.equal((await summaly("https://sjis.example/", { fetch: fetchMock })).title, `${"こんにちは、世界。".repeat(11)}こ...`);
  });

  it("plugins (wikipedia), type filter, size limits, private hosts", async () => {
    pages.set("https://ja.wikipedia.org/wiki/Misskey", html("<html></html>"));
    pages.set("https://ja.wikipedia.org/w/api.php?format=json&action=query&prop=extracts&exintro=&explaintext=&titles=Misskey", () =>
      Response.json({ query: { pages: { "1": { title: "Misskey", extract: "x".repeat(400) } } } }));
    const w = await summaly("https://ja.wikipedia.org/wiki/Misskey", { fetch: fetchMock });
    assert.deepEqual([w.title, w.sitename, w.description!.length, w.thumbnail], ["Misskey", "Wikipedia", 303, "https://wikipedia.org/static/images/project-logos/jawiki.png"]);

    pages.set("https://img.example/x", () => new Response("png", { headers: { "content-type": "image/png" } }));
    await assert.rejects(summaly("https://img.example/x", { fetch: fetchMock }), /Rejected by type filter/);
    pages.set("https://big.example/", html("<title>x</title>", { "content-length": "100" }));
    await assert.rejects(summaly("https://big.example/", { fetch: fetchMock, contentLengthLimit: 10 }), /maxSize exceeded/);
    pages.set("https://nolen.example/", html("<title>x</title>"));
    await assert.rejects(summaly("https://nolen.example/", { fetch: fetchMock, contentLengthRequired: true }), /content-length required/);
    for (const h of ["localhost", "127.0.0.1", "10.1.2.3", "192.168.0.1", "172.20.0.1", "[::1]", "x.internal"]) assert.equal(isPrivateHost(h), true, h);
    assert.equal(isPrivateHost("93.184.216.34"), false);
    await assert.rejects(summaly("http://127.0.0.1/", { fetch: fetchMock }), /Private IP rejected/);
  });
});

describe("GET /url", () => {
  it("returns the summary with a day of cache, caches it for an hour, applies the sensitive list", async () => {
    const r = await get("url=https%3A%2F%2Fexample.com%2Fpage");
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("cache-control"), "max-age=86400, immutable");
    assert.equal(r.body.title, "Hello & world");
    assert.equal(r.body.thumbnail, "https://misskey.example.com/proxy/preview.webp?url=https%3A%2F%2Fexample.com%2Fimg%2Fog.png&preview=1"); // the built-in proxy
    assert.equal(r.body.sensitive, false);
    const ua = requests.find((x) => x.method === "GET")!.headers["user-agent"];
    assert.equal(ua, "SummalyBot/5.5.1 (https://misskey.example.com; +https://github.com/misskey-dev/summaly/blob/master/README.md)");
    const n = requests.length;
    await get("url=https%3A%2F%2Fexample.com%2Fpage");
    assert.equal(requests.length, n); // cached
    await f.db.query(`UPDATE meta SET "urlPreviewSensitiveList" = '{example.com/page}'`);
    resetUrlPreviewCache();
    assert.equal((await get("url=https%3A%2F%2Fexample.com%2Fpage")).body.sensitive, true);
    await f.db.query(`UPDATE meta SET "urlPreviewSensitiveList" = '{}'`);
  });

  it("wraps icon / thumbnail with an external MEDIA_PROXY when configured", async () => {
    f.env.MEDIA_PROXY = "https://media.example/proxy";
    try {
      const r = await get("url=https%3A%2F%2Fexample.com%2Fpage&lang=en");
      assert.equal(r.body.thumbnail, "https://media.example/proxy/preview.webp?url=https%3A%2F%2Fexample.com%2Fimg%2Fog.png&preview=1");
      assert.equal(r.body.icon, "https://media.example/proxy/preview.webp?url=https%3A%2F%2Fexample.com%2Ffav.png&preview=1");
    } finally {
      delete f.env.MEDIA_PROXY;
    }
  });

  it("400 / 403 / 422 and the summary proxy", async () => {
    assert.equal((await worker.fetch(new Request("https://misskey.example.com/url"), f.env, ctx)).status, 400);
    assert.equal((await worker.fetch(new Request("https://misskey.example.com/url?url=a&lang=x&lang=y"), f.env, ctx)).status, 400);
    const failed = await get("url=https%3A%2F%2Fmissing.example%2F");
    assert.equal(failed.status, 422);
    assert.equal(failed.body.error.id, "09d01cb5-53b9-4856-82e5-38a50c290a3b");
    assert.equal(failed.headers.get("cache-control"), "max-age=86400, immutable");

    await f.db.query(`UPDATE meta SET "urlPreviewSummaryProxyUrl" = 'https://summaly.example/'`);
    pages.set("https://summaly.example/?url=https%3A%2F%2Fp.example%2F&lang=ja-JP&followRedirects=true&userAgent=SummalyBot%2F5.5.1%20(https%3A%2F%2Fmisskey.example.com%3B%20%2Bhttps%3A%2F%2Fgithub.com%2Fmisskey-dev%2Fsummaly%2Fblob%2Fmaster%2FREADME.md)&operationTimeout=10000&contentLengthLimit=10485760&contentLengthRequired=false", () =>
      Response.json({ title: "via proxy", icon: null, thumbnail: null, description: null, player: { url: null, width: null, height: null, allow: [] }, sitename: "p", url: "https://p.example/" }));
    const p = await get("url=https%3A%2F%2Fp.example%2F");
    assert.equal(p.status, 200);
    assert.equal(p.body.title, "via proxy");
    // a non-http(s) result is refused
    pages.set("https://summaly.example/?url=https%3A%2F%2Fq.example%2F&lang=ja-JP&followRedirects=true&userAgent=SummalyBot%2F5.5.1%20(https%3A%2F%2Fmisskey.example.com%3B%20%2Bhttps%3A%2F%2Fgithub.com%2Fmisskey-dev%2Fsummaly%2Fblob%2Fmaster%2FREADME.md)&operationTimeout=10000&contentLengthLimit=10485760&contentLengthRequired=false", () =>
      Response.json({ title: "x", player: { url: "javascript:alert(1)" }, url: "https://q.example/" }));
    assert.equal((await get("url=https%3A%2F%2Fq.example%2F")).status, 422);
    await f.db.query(`UPDATE meta SET "urlPreviewSummaryProxyUrl" = NULL, "urlPreviewEnabled" = FALSE`);
    const off = await get("url=https%3A%2F%2Fexample.com%2Fpage");
    assert.equal(off.status, 403);
    assert.equal(off.body.error.code, "URL_PREVIEW_DISABLED");
    await f.db.query(`UPDATE meta SET "urlPreviewEnabled" = TRUE`);
  });
});
