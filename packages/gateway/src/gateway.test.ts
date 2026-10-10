import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractMisskeyMeta,
  injectMisskeyMeta,
  renderShellHtml,
  safeJsonForScript,
} from "./html.js";
import { matchRoute, staticCacheControl } from "./router.js";
import worker from "./index.js";
import type { GatewayEnv } from "./env.js";
import { collectViteAssetFiles, resetClientBuildCache, type ClientBuildInfo } from "./client-build.js";
import { loadMeta, resetMetaCache } from "./client.js";

describe("matchRoute", () => {
  it("classifies healthz / api / streaming / discovery / static / spa", () => {
    assert.equal(matchRoute("/healthz").kind, "healthz");
    assert.equal(matchRoute("/api").kind, "api");
    assert.equal(matchRoute("/api/meta").kind, "api");
    assert.equal(matchRoute("/streaming").kind, "streaming");
    assert.equal(matchRoute("/.well-known/webfinger").kind, "wellknown");
    assert.equal(matchRoute("/nodeinfo/2.0").kind, "nodeinfo");
    assert.equal(matchRoute("/users/seed").kind, "ap");
    assert.equal(matchRoute("/users/seed/outbox").kind, "ap");
    assert.equal(matchRoute("/favicon.ico").kind, "static");
    assert.equal(matchRoute("/vite/assets/index.js").kind, "static");
    assert.equal(matchRoute("/").kind, "spa");
    assert.equal(matchRoute("/@ai").kind, "spa");
  });
});

describe("misskey_meta injection", () => {
  it("escapes script breakers in JSON", () => {
    const s = safeJsonForScript({ x: "</script><script>alert(1)" });
    assert.ok(!s.includes("</script>"));
    assert.ok(s.includes("\\u003c"));
  });

  it("injects #misskey_meta into shell and round-trips", () => {
    const meta = { name: "Example", uri: "https://misskey.example.com", isCat: true };
    const html = renderShellHtml({ meta, generatedAt: 1_700_000_000_000, instanceUrl: meta.uri });
    assert.match(html, /id="misskey_meta"/);
    assert.match(html, /data-generated-at="1700000000000"/);
    const extracted = extractMisskeyMeta(html);
    assert.ok(extracted);
    assert.deepEqual(extracted!.meta, meta);
    assert.equal(extracted!.generatedAt, 1_700_000_000_000);
  });

  it("replaces an existing misskey_meta tag", () => {
    const base = `<html><head><script type="application/json" id="misskey_meta" data-generated-at="1">{"a":1}</script></head></html>`;
    const next = injectMisskeyMeta(base, { b: 2 }, 99);
    const extracted = extractMisskeyMeta(next)!;
    assert.deepEqual(extracted.meta, { b: 2 });
    assert.equal(extracted.generatedAt, 99);
    assert.equal((next.match(/id="misskey_meta"/g) || []).length, 1);
  });
});

describe("gateway fetch", () => {
  const env: GatewayEnv = {
    API: echoApi(),
    INSTANCE_URL: "https://misskey.example.com",
    BOOTSTRAP_META_JSON: JSON.stringify({ name: "Boot", uri: "https://misskey.example.com" }),
  };

  it("GET /healthz → 200", async () => {
    const res = await worker.fetch(new Request("https://x/healthz"), env, fakeCtx());
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, service: "gateway" });
  });

  it("GET /api/meta with API binding → forwards", async () => {
    const envBound: GatewayEnv = {
      ...env,
      API: {
        fetch: async () => Response.json({ name: "from-api" }),
      },
    };
    const res = await worker.fetch(new Request("https://x/api/meta"), envBound, fakeCtx());
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { name: "from-api" });
  });

  it("GET /streaming → 426 placeholder with protocol docs", async () => {
    const res = await worker.fetch(new Request("https://x/streaming"), env, fakeCtx());
    assert.equal(res.status, 426);
    const body = (await res.json()) as { protocol: string[]; docs: string };
    assert.deepEqual(body.protocol, ["main", "homeTimeline"]);
    assert.match(body.docs, /stream\/README/);
  });

  it("well-known / nodeinfo / inbox go to the API Worker", async () => {
    for (const path of ["/.well-known/webfinger", "/.well-known/nodeinfo", "/.well-known/host-meta", "/nodeinfo/2.0", "/inbox"]) {
      const res = await worker.fetch(new Request(`https://x${path}`), env, fakeCtx());
      assert.equal(await res.text(), `api:${path}`);
    }
  });

  it("GET / → HTML with injected misskey_meta", async () => {
    const res = await worker.fetch(new Request("https://x/"), env, fakeCtx());
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") || "", /text\/html/);
    const html = await res.text();
    const extracted = extractMisskeyMeta(html)!;
    assert.equal((extracted.meta as { name: string }).name, "Boot");
  });

  it("GET /users/seed with activity+json, /users/seed/outbox and /inbox → API Worker", async () => {
    const actor = await worker.fetch(
      new Request("https://x/users/seed", { headers: { Accept: "application/activity+json" } }),
      env,
      fakeCtx(),
    );
    assert.equal(await actor.text(), "api:/users/seed");
    for (const path of ["/users/seed/outbox", "/users/seed/inbox"]) {
      const res = await worker.fetch(new Request(`https://x${path}`), env, fakeCtx());
      assert.equal(await res.text(), `api:${path}`);
    }
  });

  it("GET /favicon.ico without ASSETS → 404 JSON", async () => {
    const res = await worker.fetch(new Request("https://x/favicon.ico"), env, fakeCtx());
    assert.equal(res.status, 404);
  });
});

describe("web client routing (upstream ClientServerService)", () => {
  it("classifies client routes", () => {
    assert.equal(matchRoute("/manifest.json").kind, "manifest");
    assert.equal(matchRoute("/robots.txt").kind, "robots");
    assert.equal(matchRoute("/opensearch.xml").kind, "opensearch");
    assert.equal(matchRoute("/flush").kind, "flush");
    assert.equal(matchRoute("/sw.js").kind, "static");
    assert.equal(matchRoute("/embed.js").kind, "static");
    assert.equal(matchRoute("/embed_vite/ja-JP/x.js").kind, "static");
    assert.equal(matchRoute("/static-assets/splash.png").kind, "static");
    assert.equal(matchRoute("/client-assets/dummy.png").kind, "static");
    assert.equal(matchRoute("/assets/locales/ja-JP.2026.10.0.json").kind, "static");
    assert.equal(matchRoute("/twemoji/2764.svg").kind, "static");
    assert.equal(matchRoute("/fluent-emoji/1f4dd.png").kind, "static");
    assert.equal(matchRoute("/embed/notes/abc").kind, "embed");
    assert.equal(matchRoute("/@ai.rss").kind, "feed");
    assert.equal(matchRoute("/files/key").kind, "media");
    assert.equal(matchRoute("/identicon/a@b.example").kind, "media");
    assert.equal(matchRoute("/emoji/blob.webp").kind, "media");
    assert.equal(matchRoute("/inbox").kind, "inbox");
    assert.equal(matchRoute("/notes/abc").kind, "spa");
    assert.equal(matchRoute("/@ai/pages/x").kind, "spa");
  });

  it("cache lifetimes follow upstream", () => {
    assert.match(staticCacheControl("/vite/ja-JP/2H3-abc.js"), /immutable/);
    assert.doesNotMatch(staticCacheControl("/vite/loader/boot.js"), /immutable/);
    assert.doesNotMatch(staticCacheControl("/vite/manifest.json"), /immutable/);
    assert.equal(staticCacheControl("/static-assets/splash.png"), "public, max-age=604800");
    assert.equal(staticCacheControl("/sw.js"), "public, max-age=600");
  });

  it("collectViteAssetFiles (port of HtmlTemplateService)", () => {
    const files = collectViteAssetFiles({
      "src/_boot_.ts": { file: "scripts/h-entry.js", isEntry: true, imports: ["_vue.js", "_i18n.js"], css: ["assets/h-boot.css"] },
      "_vue.js": { file: "scripts/h-vue.js", css: ["assets/h-vue.css"], imports: ["_shared.js"] },
      "_i18n.js": { file: "scripts/h-i18n.js", imports: ["_shared.js"] },
      "_shared.js": { file: "scripts/h-shared.js", css: ["assets/h-shared.css"] },
      "src/pages/x.vue": { file: "scripts/h-x.js", css: ["assets/h-lazy.css"] },
    });
    assert.equal(files.entryJs, "scripts/h-entry.js");
    assert.deepEqual(files.css, ["assets/h-boot.css", "assets/h-vue.css", "assets/h-shared.css"]);
    assert.deepEqual(files.modulePreloads, ["scripts/h-vue.js", "scripts/h-i18n.js"]);
    assert.deepEqual(collectViteAssetFiles({}), { entryJs: null, css: [], modulePreloads: [] });
  });
});

describe("web client with Static Assets", () => {
  const buildInfo: ClientBuildInfo = {
    version: "2026.10.0",
    upstreamRev: "deadbeef",
    emojiAssetsVersion: "17.0.3",
    langs: ["en-US", "ja-JP"],
    frontend: {
      viteFiles: { entryJs: "scripts/h-entry.js", css: ["assets/h-boot.css"], modulePreloads: [] },
      bootJs: "/* boot */ console.log('boot</script>');",
      bootCss: "#splash { color: red; }",
    },
    embed: {
      viteFiles: { entryJs: "scripts/e-entry.js", css: ["assets/e.css"], modulePreloads: [] },
      bootJs: null,
      bootCss: null,
    },
  };

  function fakeAssets(files: Record<string, string>) {
    const requested: string[] = [];
    return {
      requested,
      fetch: async (req: Request) => {
        const p = new URL(req.url).pathname;
        requested.push(p);
        if (p in files) {
          return new Response(files[p], { status: 200, headers: { "cache-control": "public, max-age=0, must-revalidate" } });
        }
        return new Response("not found", { status: 404 });
      },
    };
  }

  function fakeApi(meta: Record<string, unknown>) {
    const calls: Array<{ path: string; body: string }> = [];
    return {
      calls,
      fetch: async (input: RequestInfo | URL) => {
        const req = input instanceof Request ? input : new Request(input);
        const path = new URL(req.url).pathname;
        const body = req.method === "POST" ? await req.text() : "";
        calls.push({ path, body });
        if (path === "/api/meta") return Response.json(meta);
        if (path === "/api/users/show") {
          const { userId } = JSON.parse(body) as { userId: string };
          if (userId === "9abc") return Response.json({ id: "9abc", username: "alice", host: null });
          return Response.json({ error: { code: "NO_SUCH_USER" } }, { status: 400 });
        }
        return new Response(`api:${path}`, { status: 200 });
      },
    };
  }

  const apiMeta = {
    name: "Cf <Town>",
    description: "hello & welcome",
    themeColor: "#ff0000",
    iconUrl: "https://cdn.example/icon.png",
    bannerUrl: "https://cdn.example/banner.png",
    version: "2026.10.0",
  };

  function setup(opts: { withBuild?: boolean; apiDown?: boolean } = {}) {
    resetClientBuildCache();
    resetMetaCache();
    const assets = fakeAssets({
      ...(opts.withBuild === false ? {} : { "/misskey-cf-client.json": JSON.stringify(buildInfo) }),
      "/sw.js": "self.addEventListener('fetch', () => {});",
      "/vite/ja-JP/h-entry.js": "export {}",
      "/static-assets/splash.png": "png",
    });
    const api = fakeApi(apiMeta);
    const env: GatewayEnv = {
      INSTANCE_URL: "https://cf.example",
      ASSETS: assets,
      API: opts.apiDown ? { fetch: async () => new Response("down", { status: 500 }) } : api,
    };
    return { env, assets, api };
  }

  it("GET / renders upstream base HTML: boot loader, CLIENT_ENTRY, LANGS, meta tags, #misskey_meta", async () => {
    const { env, api } = setup();
    const res = await worker.fetch(new Request("https://cf.example/"), env, fakeCtx());
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("x-frame-options"), "DENY");
    assert.equal(res.headers.get("cache-control"), "public, max-age=30");
    const html = await res.text();
    assert.match(html, /const VERSION = "2026\.10\.0";/);
    assert.match(html, /const CLIENT_ENTRY = "scripts\/h-entry\.js";/);
    assert.match(html, /const LANGS = \["en-US","ja-JP"\];/);
    assert.match(html, /<link rel="stylesheet" href="\/vite\/assets\/h-boot\.css">/);
    assert.match(html, /<style>#splash \{ color: red; \}<\/style>/);
    assert.match(html, /\/\* boot \*\//);
    assert.ok(!html.includes("boot</script>"), "inline boot.js must not close the script early");
    assert.match(html, /<meta name="theme-color" content="#ff0000">/);
    assert.match(html, /<meta name="theme-color-orig" content="#ff0000">/);
    assert.match(html, /<link rel="icon" href="https:\/\/cdn\.example\/icon\.png">/);
    assert.match(html, /<title>Cf &lt;Town&gt;<\/title>/);
    assert.match(html, /<meta name="description" content="hello &amp; welcome">/);
    assert.match(html, /<meta property="og:image" content="https:\/\/cdn\.example\/banner\.png">/);
    assert.match(html, /<meta property="instance_url" content="https:\/\/cf\.example">/);
    assert.match(html, /<link rel="manifest" href="\/manifest\.json">/);
    assert.match(html, /href="https:\/\/cf\.example\/opensearch\.xml"/);
    assert.match(html, /id="splash"/);
    assert.ok(!html.includes("frontend assets not mounted"));
    const extracted = extractMisskeyMeta(html)!;
    assert.equal((extracted.meta as { name: string }).name, "Cf <Town>");
    assert.ok(extracted.generatedAt! > 0);
    assert.deepEqual(api.calls[0], { path: "/api/meta", body: JSON.stringify({ detail: true }) });

    // meta + build info are cached per isolate
    await worker.fetch(new Request("https://cf.example/@alice"), env, fakeCtx());
    assert.equal(api.calls.filter((c) => c.path === "/api/meta").length, 1);
  });

  it("without a build: placeholder shell, LANGS fallback; placeholder meta is stale (generated-at 0)", async () => {
    const { env } = setup({ withBuild: false, apiDown: true });
    const res = await worker.fetch(new Request("https://cf.example/"), env, fakeCtx());
    const html = await res.text();
    assert.match(html, /frontend assets not mounted/);
    assert.match(html, /const CLIENT_ENTRY = null;/);
    assert.match(html, /"ja-JP"/);
    assert.equal(extractMisskeyMeta(html)!.generatedAt, 0);
  });

  it("tag pages are noindex", async () => {
    const { env } = setup();
    const html = await (await worker.fetch(new Request("https://cf.example/tags/misskey"), env, fakeCtx())).text();
    assert.match(html, /<meta name="robots" content="noindex">/);
  });

  it("/embed/* renders BaseEmbed with the embed bundle and no X-Frame-Options", async () => {
    const { env } = setup();
    const res = await worker.fetch(new Request("https://cf.example/embed/notes/abc"), env, fakeCtx());
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("x-frame-options"), null);
    const html = await res.text();
    assert.match(html, /const CLIENT_ENTRY = "scripts\/e-entry\.js";/);
    assert.match(html, /<link rel="stylesheet" href="\/embed_vite\/assets\/e\.css">/);
    assert.match(html, /<script src="\/embed_vite\/loader\/boot\.js"><\/script>/);
    assert.match(html, /<link rel="stylesheet" href="\/embed_vite\/loader\/style\.css">/);
    assert.match(html, /<meta name="robots" content="noindex">/);
  });

  it("/manifest.json from meta (upstream manifestHandler) incl. manifestJsonOverride", async () => {
    resetMetaCache();
    const env: GatewayEnv = {
      API: echoApi(),
      INSTANCE_URL: "https://cf.example",
      BOOTSTRAP_META_JSON: JSON.stringify({
        name: "Cf Town",
        shortName: "Cf",
        themeColor: "#123456",
        app192IconUrl: "https://cdn.example/192.png",
        manifestJsonOverride: JSON.stringify({ background_color: "#000000" }),
      }),
    };
    const res = await worker.fetch(new Request("https://cf.example/manifest.json"), env, fakeCtx());
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") || "", /manifest\+json/);
    assert.equal(res.headers.get("cache-control"), "max-age=300");
    const m = (await res.json()) as Record<string, any>;
    assert.equal(m.short_name, "Cf");
    assert.equal(m.name, "Cf Town");
    assert.equal(m.theme_color, "#123456");
    assert.equal(m.background_color, "#000000");
    assert.equal(m.icons[0].src, "https://cdn.example/192.png");
    assert.equal(m.icons[1].src, "/static-assets/icons/512.png");
    assert.equal(m.share_target.action, "/share/");

    const fallback = (await (
      await worker.fetch(new Request("https://cf.example/manifest.json"), { API: echoApi(), INSTANCE_URL: "https://cf.example", BOOTSTRAP_META_JSON: "{}" }, fakeCtx())
    ).json()) as Record<string, any>;
    assert.equal(fallback.name, "cf.example");
    assert.equal(fallback.theme_color, "#86b300");
  });

  it("/robots.txt and /opensearch.xml", async () => {
    const { env } = setup();
    const robots = await worker.fetch(new Request("https://cf.example/robots.txt"), env, fakeCtx());
    assert.match(robots.headers.get("content-type") || "", /text\/plain/);
    const txt = await robots.text();
    assert.match(txt, /^User-agent: \*\nDisallow: \/settings\n/);
    assert.match(txt, /Disallow: \/api\n/);
    assert.match(txt, /Allow: \/\n/);
    assert.doesNotMatch(txt, /Disallow: \/@/);

    const os = await worker.fetch(new Request("https://cf.example/opensearch.xml"), env, fakeCtx());
    assert.equal(os.headers.get("content-type"), "application/opensearchdescription+xml");
    const xml = await os.text();
    assert.match(xml, /<ShortName>Cf &lt;Town&gt;<\/ShortName>/);
    assert.match(xml, /template="https:\/\/cf\.example\/search\?q=\{searchTerms\}"/);

    resetMetaCache();
    const hidden = await (
      await worker.fetch(
        new Request("https://cf.example/robots.txt"),
        { API: echoApi(), BOOTSTRAP_META_JSON: JSON.stringify({ ugcVisibilityForVisitor: "none" }) },
        fakeCtx(),
      )
    ).text();
    assert.match(hidden, /Disallow: \/@\nDisallow: \/notes\n/);
  });

  it("static files come from ASSETS with upstream cache lifetimes", async () => {
    const { env } = setup();
    const sw = await worker.fetch(new Request("https://cf.example/sw.js"), env, fakeCtx());
    assert.equal(sw.status, 200);
    assert.equal(sw.headers.get("cache-control"), "public, max-age=600");
    const entry = await worker.fetch(new Request("https://cf.example/vite/ja-JP/h-entry.js"), env, fakeCtx());
    assert.equal(entry.headers.get("cache-control"), "public, max-age=2592000, immutable");
    const missing = await worker.fetch(new Request("https://cf.example/vite/ja-JP/nope.js"), env, fakeCtx());
    assert.equal(missing.status, 404);
  });

  it("missing emoji assets redirect to jsDelivr (MISSKEY_CF_SKIP_EMOJI)", async () => {
    const { env } = setup();
    const res = await worker.fetch(new Request("https://cf.example/twemoji/2764.svg"), env, fakeCtx());
    assert.equal(res.status, 302);
    assert.equal(
      res.headers.get("location"),
      "https://cdn.jsdelivr.net/npm/@misskey-dev/emoji-assets@17.0.3/built/twemoji/2764.svg",
    );
    const bad = await worker.fetch(new Request("https://cf.example/twemoji/..%2Fx.svg"), env, fakeCtx());
    assert.equal(bad.status, 404);
  });

  it("/flush sends Clear-Site-Data for same-origin https", async () => {
    const { env } = setup();
    const res = await worker.fetch(
      new Request("https://cf.example/flush", { headers: { origin: "https://cf.example" } }),
      env,
      fakeCtx(),
    );
    assert.equal(res.headers.get("clear-site-data"), '"*"');
    assert.match(await res.text(), /\/static-assets\/misc\/flush\.js/);
    const cross = await worker.fetch(
      new Request("https://cf.example/flush", { headers: { origin: "https://evil.example" } }),
      env,
      fakeCtx(),
    );
    assert.equal(cross.headers.get("clear-site-data"), null);
  });

  it("/bios and /cli render upstream's tool pages with the server version", async () => {
    const { env } = setup();
    assert.equal(matchRoute("/bios").kind, "bios");
    assert.equal(matchRoute("/cli").kind, "cli");
    const bios = await worker.fetch(new Request("https://cf.example/bios"), env, fakeCtx());
    assert.equal(bios.headers.get("content-type"), "text/html; charset=utf-8");
    const b = await bios.text();
    assert.match(b, /<title>Misskey Repair Tool<\/title>/);
    assert.match(b, /<h1>Misskey Repair Tool 2026\.10\.0<\/h1>/);
    assert.match(b, /\/static-assets\/misc\/bios\.js/);
    const cli = await (await worker.fetch(new Request("https://cf.example/cli"), env, fakeCtx())).text();
    assert.match(cli, /<h1>Misskey CLI 2026\.10\.0<\/h1>/);
    assert.match(cli, /\/static-assets\/misc\/cli\.css/);
  });

  it("with the API binding: /users/:id (HTML) redirects to /@username, AP / media / websocket go to the API Worker", async () => {
    const { env, api } = setup();
    const redirect = await worker.fetch(
      new Request("https://cf.example/users/9abc", { headers: { accept: "text/html" } }),
      env,
      fakeCtx(),
    );
    assert.equal(redirect.status, 302);
    assert.equal(redirect.headers.get("location"), "/@alice");

    const unknown = await worker.fetch(
      new Request("https://cf.example/users/zzz", { headers: { accept: "text/html" } }),
      env,
      fakeCtx(),
    );
    assert.equal(unknown.status, 200);
    assert.match(await unknown.text(), /misskey_meta/);

    const actor = await worker.fetch(
      new Request("https://cf.example/users/9abc", { headers: { accept: "application/activity+json" } }),
      env,
      fakeCtx(),
    );
    assert.equal(await actor.text(), "api:/users/9abc");

    const note = await worker.fetch(
      new Request("https://cf.example/notes/n1", { headers: { accept: "application/activity+json" } }),
      env,
      fakeCtx(),
    );
    assert.equal(await note.text(), "api:/notes/n1");

    assert.equal(await (await worker.fetch(new Request("https://cf.example/files/k1"), env, fakeCtx())).text(), "api:/files/k1");
    assert.equal(
      await (await worker.fetch(new Request("https://cf.example/.well-known/webfinger?resource=acct:a@cf.example"), env, fakeCtx())).text(),
      "api:/.well-known/webfinger",
    );
    const ws = await worker.fetch(
      new Request("https://cf.example/streaming?i=tok", { headers: { upgrade: "websocket" } }),
      env,
      fakeCtx(),
    );
    assert.equal(await ws.text(), "api:/streaming");
    assert.ok(api.calls.some((c) => c.path === "/streaming"));
  });

  it("SSR: /@user and /notes/:id with OGP, robots, alternates and #misskey_clientCtx from API_INTERNAL", async () => {
    const { env } = setup();
    const calls: string[] = [];
    const user = { id: "u1", username: "alice", host: null, name: "Alice <A>", description: "bio & more", avatarUrl: "https://cdn.example/a.png", uri: null };
    const profile = { noCrawle: false, preventAiLearning: true, fields: [{ name: "web", value: "https://alice.example" }, { name: "x", value: "text" }], url: null };
    const note = {
      id: "n1", userId: "u1", user, text: "hello <world>", cw: null, renoteId: null, replyId: null, uri: null,
      files: [{ type: "image/png", url: "https://cdn.example/i.png", properties: { width: 10, height: 20 } }, { type: "video/mp4", url: "https://cdn.example/v.mp4", thumbnailUrl: "https://cdn.example/t.webp", properties: {} }],
    };
    env.API_INTERNAL = {
      ssrUser: async (acct: string) => (calls.push(`user:${acct}`), acct === "alice" ? { user, profile, federationEnabled: true } : null),
      ssrNote: async (id: string) => (calls.push(`note:${id}`), id === "n1" ? { note, profile: { ...profile, preventAiLearning: false }, federationEnabled: false } : null),
      ssrEntity: async () => null,
    };
    const u = await worker.fetch(new Request("https://cf.example/@alice"), env, fakeCtx());
    assert.equal(u.headers.get("cache-control"), "public, max-age=15");
    assert.equal(u.headers.get("x-robots-tag"), "noai");
    assert.equal(u.headers.get("vary"), "Accept");
    const uh = await u.text();
    assert.match(uh, /<title>Alice &lt;A&gt; \(@alice\) \| Cf &lt;Town&gt;<\/title>/);
    assert.match(uh, /<meta name="description" content="bio &amp; more">/);
    assert.match(uh, /<meta property="og:type" content="blog">/);
    assert.match(uh, /<meta property="og:title" content="Alice &lt;A&gt; \(@alice\)">/);
    assert.match(uh, /<meta property="og:url" content="https:\/\/cf\.example\/@alice">/);
    assert.match(uh, /<meta property="og:image" content="https:\/\/cdn\.example\/a\.png">/);
    assert.match(uh, /<meta name="robots" content="noimageai">/);
    assert.doesNotMatch(uh, /content="noindex"/);
    assert.match(uh, /<meta name="misskey:user-id" content="u1">/);
    assert.match(uh, /<link rel="alternate" type="application\/activity\+json" href="https:\/\/cf\.example\/users\/u1">/);
    assert.match(uh, /<link rel="me" href="https:\/\/alice\.example">/);
    assert.equal((uh.match(/<link rel="me"/g) ?? []).length, 1);
    assert.equal((uh.match(/property="og:title"/g) ?? []).length, 1); // ogSlot replaces the default block
    const ctx = /<script type="application\/json" id="misskey_clientCtx" data-generated-at="\d+">(.*?)<\/script>/.exec(uh);
    assert.deepEqual(JSON.parse(ctx![1]!), { user });
    assert.match(uh, /id="misskey_meta"/);
    // sub pages keep the user tags but drop the alternates
    const sub = await (await worker.fetch(new Request("https://cf.example/@alice/following"), env, fakeCtx())).text();
    assert.match(sub, /misskey:user-id/);
    assert.doesNotMatch(sub, /application\/activity\+json/);

    const n = await worker.fetch(new Request("https://cf.example/notes/n1"), env, fakeCtx());
    assert.equal(n.headers.get("x-robots-tag"), null);
    const nh = await n.text();
    assert.match(nh, /<title>Alice &lt;A&gt; \(@alice\) \| Cf &lt;Town&gt;<\/title>/);
    assert.match(nh, /<meta name="description" content="hello &lt;world&gt; \(📎2\)">/);
    assert.match(nh, /<meta property="og:type" content="article">/);
    assert.match(nh, /<meta property="twitter:card" content="summary_large_image">/);
    assert.match(nh, /<meta property="og:image:height" content="20">/);
    assert.match(nh, /<meta property="og:video:image" content="https:\/\/cdn\.example\/t\.webp">/);
    assert.match(nh, /<meta name="misskey:note-id" content="n1">/);
    assert.doesNotMatch(nh, /application\/activity\+json/); // federation off
    assert.deepEqual(JSON.parse(/id="misskey_clientCtx"[^>]*>(.*?)<\/script>/.exec(nh)![1]!), { note });

    // unknown entities fall back to the base HTML
    const missing = await worker.fetch(new Request("https://cf.example/@nobody"), env, fakeCtx());
    assert.equal(missing.headers.get("cache-control"), "public, max-age=30");
    const mh = await missing.text();
    assert.doesNotMatch(mh, /misskey_clientCtx/);
    assert.match(mh, /<title>Cf &lt;Town&gt;<\/title>/);
    assert.deepEqual(calls, ["user:alice", "user:alice", "note:n1", "user:nobody"]);
    // other client routes never ask
    await worker.fetch(new Request("https://cf.example/settings"), env, fakeCtx());
    assert.equal(calls.length, 4);
  });

  it("SSR: pages / play / clips / gallery / channels / reversi / announcements (views/*.tsx)", async () => {
    const { env } = setup();
    const asked: string[] = [];
    const owner = { id: "u1", username: "alice", avatarUrl: "https://cdn.example/a.png" };
    const profile = { noCrawle: true, preventAiLearning: false, fields: [], url: null };
    const data: Record<string, unknown> = {
      "page:alice:hello": { entity: { id: "p1", title: "Hello", summary: null, user: owner, eyeCatchingImage: { url: "https://cdn.example/eye.png", thumbnailUrl: "https://cdn.example/eye.webp" } }, profile, visibility: "followers" },
      "flash:f1": { entity: { id: "f1", title: "Play", summary: "fun", user: owner }, profile: { ...profile, noCrawle: false, preventAiLearning: true } },
      "clip:c1": { entity: { id: "c1", name: "My clip", description: "clipped", user: owner }, profile },
      "galleryPost:g1": { entity: { id: "g1", title: "Pics", description: null, isSensitive: false, user: owner, files: [{ url: "https://cdn.example/1.png", thumbnailUrl: null }] }, profile },
      "channel:ch1": { entity: { id: "ch1", name: "Chan", description: null, bannerUrl: "https://cdn.example/b.png" } },
      "reversiGame:r1": { entity: { id: "r1", user1: { username: "a" }, user2: { username: "b" } } },
      "announcement:an1": { entity: { id: "an1", title: "News", text: "x".repeat(120), imageUrl: null } },
    };
    env.API_INTERNAL = {
      ssrUser: async () => null,
      ssrNote: async () => null,
      ssrEntity: async (kind: string, key: string, sub?: string) => {
        asked.push([kind, key, sub].filter(Boolean).join(":"));
        return (data[[kind, key, sub].filter(Boolean).join(":")] as never) ?? null;
      },
    };
    const page = async (path: string) => {
      const r = await worker.fetch(new Request(`https://cf.example${path}`), env, fakeCtx());
      return { headers: r.headers, html: await r.text() };
    };
    const p = await page("/@alice/pages/hello");
    assert.equal(p.headers.get("cache-control"), "private, max-age=0, must-revalidate");
    assert.equal(p.headers.get("vary"), null);
    assert.match(p.html, /<title>Hello \| Cf &lt;Town&gt;<\/title>/);
    assert.match(p.html, /<meta name="description" content="✨🌎✨/); // empty summary → default description
    assert.match(p.html, /<meta property="og:url" content="https:\/\/cf\.example\/pages\/p1">/);
    assert.match(p.html, /<meta property="og:image" content="https:\/\/cdn\.example\/eye\.webp">\n\t\t<meta property="twitter:card" content="summary_large_image">/);
    assert.match(p.html, /<meta name="robots" content="noindex">/);
    assert.match(p.html, /<meta name="misskey:page-id" content="p1">/);
    assert.doesNotMatch(p.html, /misskey_clientCtx/);

    const f = await page("/play/f1");
    assert.equal(f.headers.get("cache-control"), "public, max-age=15");
    assert.equal(f.headers.get("x-robots-tag"), "noai");
    assert.match(f.html, /<meta property="og:description" content="fun">/);
    assert.match(f.html, /<meta name="misskey:flash-id" content="f1">/);

    const c = await page("/clips/c1");
    assert.deepEqual(JSON.parse(/id="misskey_clientCtx"[^>]*>(.*?)<\/script>/.exec(c.html)![1]!), { clip: data["clip:c1"] && (data["clip:c1"] as { entity: unknown }).entity });
    assert.match(c.html, /<meta name="misskey:clip-id" content="c1">/);

    const g = await page("/gallery/g1");
    assert.match(g.html, /<meta property="og:image" content="https:\/\/cdn\.example\/1\.png">/);
    assert.match(g.html, /<meta name="misskey:gallery-post-id" content="g1">/);

    const ch = await page("/channels/ch1");
    assert.match(ch.html, /<meta property="og:type" content="website">/);
    assert.doesNotMatch(ch.html, /<meta name="description"/); // no description → none, as upstream
    assert.doesNotMatch(ch.html, /misskey:user-id/);

    const rv = await page("/reversi/g/r1");
    assert.equal(rv.headers.get("cache-control"), "public, max-age=3600");
    assert.match(rv.html, /<title>a vs b \| Cf &lt;Town&gt;<\/title>/);
    assert.match(rv.html, /<meta property="og:description" content="⚫⚪Misskey Reversi⚪⚫">/);

    const an = await page("/announcements/an1");
    assert.match(an.html, new RegExp(`<meta property="og:description" content="${"x".repeat(100)}…">`));

    // unknown → base HTML
    const none = await page("/clips/nope");
    assert.equal(none.headers.get("cache-control"), "public, max-age=30");
    assert.match(none.html, /<title>Cf &lt;Town&gt;<\/title>/);
    assert.deepEqual(asked, ["page:alice:hello", "flash:f1", "clip:c1", "galleryPost:g1", "channel:ch1", "reversiGame:r1", "announcement:an1", "clip:nope"]);
  });

  it("embeds carry #misskey_embedCtx; /_info_card_", async () => {
    const { env } = setup();
    const user = { id: "u1", username: "alice" };
    env.API_INTERNAL = {
      ssrUser: async () => null,
      ssrNote: async () => null,
      ssrEntity: async (kind: string, key: string) => (kind === "embedUser" && key === "u1" ? { entity: user } : kind === "embedNote" && key === "n1" ? { entity: { id: "n1" } } : null),
    };
    const ctxOf = async (path: string) => {
      const r = await worker.fetch(new Request(`https://cf.example${path}`), env, fakeCtx());
      assert.equal(r.headers.get("cache-control"), "public, max-age=3600");
      assert.equal(r.headers.get("x-frame-options"), null);
      const m = /id="misskey_embedCtx"[^>]*>(.*?)<\/script>/.exec(await r.text());
      return m ? JSON.parse(m[1]!) : null;
    };
    assert.deepEqual(await ctxOf("/embed/user-timeline/u1"), { user });
    assert.deepEqual(await ctxOf("/embed/notes/n1"), { note: { id: "n1" } });
    assert.equal(await ctxOf("/embed/clips/zz"), null);
    assert.equal(await ctxOf("/embed/notes/n1/other"), null);

    assert.equal(matchRoute("/_info_card_").kind, "infoCard");
    const card = await (await worker.fetch(new Request("https://cf.example/_info_card_"), env, fakeCtx())).text();
    assert.match(card, /<title>Cf &lt;Town&gt;<\/title>/);
    assert.match(card, /<header id="banner" style="background-image: url\(https:\/\/cdn\.example\/banner\.png\);">/);
    assert.match(card, /<div id="description">hello & welcome<\/div>/); // as upstream: not escaped
    assert.match(card, /\/static-assets\/misc\/info-card\.css/);
  });

  it("note summary (getNoteSummary) and renote / remote noindex", async () => {
    const { getNoteSummary, notePageProps } = await import("./ssr.js");
    assert.equal(getNoteSummary({ cw: "cw", text: "t", poll: {}, replyId: "r", reply: { text: "parent" }, renoteId: "q" }), "cw (📊)\n\nRE: parent\n\nRN: ...");
    assert.equal(getNoteSummary({ isHidden: true }), "(⛔)");
    const base = { version: "1", instanceUrl: "https://cf.example", instanceName: "X", client: null };
    const p = notePageProps(base, { note: { id: "n", renoteId: "x", user: { id: "u", username: "a", host: "r.example", avatarUrl: "https://a" }, files: [] }, profile: { noCrawle: false, preventAiLearning: false, fields: [], url: null }, federationEnabled: true });
    assert.match(p.metaSlot!, /<meta name="robots" content="noindex">/);
    assert.match(p.ogSlot!, /<meta property="twitter:card" content="summary">\n\t\t<meta property="og:image" content="https:\/\/a">/);
  });

  it("/@user.rss|atom|json feeds go to the API Worker", async () => {
    const { env, api } = setup();
    for (const ext of ["rss", "atom", "json"]) {
      const res = await worker.fetch(new Request(`https://cf.example/@alice.${ext}`), env, fakeCtx());
      assert.equal(await res.text(), `api:/@alice.${ext}`);
    }
    assert.ok(api.calls.some((c) => c.path === "/@alice.atom"));
  });

  it("/twemoji-badge/*.png: the twemoji SVG rendered by the media Container", async () => {
    const { env, assets } = setup();
    void assets;
    const svg = "<svg xmlns='http://www.w3.org/2000/svg'/>";
    env.ASSETS = fakeAssets({ "/misskey-cf-client.json": JSON.stringify(buildInfo), "/twemoji/1f600.svg": svg });
    const sent: string[] = [];
    env.MEDIA = {
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        sent.push(`${String(input)} ${String(init?.body instanceof ArrayBuffer ? new TextDecoder().decode(init.body) : init?.body)}`);
        return new Response(new Uint8Array([137, 80, 78, 71]), { headers: { "content-type": "image/png" } });
      },
    };
    assert.equal(matchRoute("/twemoji-badge/1f600.png").kind, "twemojiBadge");
    const res = await worker.fetch(new Request("https://cf.example/twemoji-badge/1f600.png"), env, fakeCtx());
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "image/png");
    assert.equal(res.headers.get("cache-control"), "max-age=2592000");
    assert.equal(res.headers.get("content-security-policy"), "default-src 'none'; style-src 'unsafe-inline'");
    assert.deepEqual([...new Uint8Array(await res.arrayBuffer())], [137, 80, 78, 71]);
    assert.deepEqual(sent, [`https://media.internal/twemoji-badge ${svg}`]);
    assert.equal((await worker.fetch(new Request("https://cf.example/twemoji-badge/1F600.png"), env, fakeCtx())).status, 404);
    assert.equal((await worker.fetch(new Request("https://cf.example/twemoji-badge/1f600.svg"), env, fakeCtx())).status, 404);
    delete env.MEDIA;
    assert.equal((await worker.fetch(new Request("https://cf.example/twemoji-badge/1f600.png"), env, fakeCtx())).status, 503);
  });

  it("/url (URL preview) goes to the API Worker", async () => {
    const { env } = setup();
    assert.equal(matchRoute("/url").kind, "urlPreview");
    assert.equal(await (await worker.fetch(new Request("https://cf.example/url?url=https%3A%2F%2Fa.example"), env, fakeCtx())).text(), "api:/url");
  });
});

/** API Worker stand-in: answers `api:<pathname>`. */
function echoApi() {
  return {
    fetch: async (input: RequestInfo | URL) => {
      const req = input instanceof Request ? input : new Request(input);
      return new Response(`api:${new URL(req.url).pathname}`, { status: 200 });
    },
  };
}

function fakeCtx() {
  return {
    waitUntil() {},
    passThroughOnException() {},
  };
}

describe("loadMeta via ApiInternal RPC", () => {
  it("prefers API_INTERNAL.getMeta over a synthetic POST /api/meta", async () => {
    resetMetaCache();
    let posts = 0;
    const env = {
      API_INTERNAL: { getMeta: async () => ({ name: "from-rpc" }) },
      API: { fetch: async () => (posts++, Response.json({ name: "from-api" })) },
    } as unknown as GatewayEnv;
    const loaded = await loadMeta(new Request("https://cf.example/"), env);
    assert.equal(loaded.meta.name, "from-rpc");
    assert.equal(posts, 0);
  });
});
