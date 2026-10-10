/**
 * Web client routes — port of upstream ClientServerService (packages/backend/src/server/web).
 * Static files come from the Static Assets binding (`pnpm build-frontend` → packages/gateway/public).
 */
import type { GatewayEnv } from "./env.js";
import type { BasePageProps } from "./html.js";
import type { ClientBundle } from "./client-build.js";
import {
  buildWebManifest,
  renderBaseHtml,
  renderEmbedHtml,
  renderBiosHtml,
  renderInfoCardHtml,
  renderCliHtml,
  renderFlushHtml,
  renderOpenSearchXml,
  renderRobotsTxt,
} from "./html.js";
import { DEFAULT_LANGS, loadClientBuildInfo } from "./client-build.js";
import { staticCacheControl } from "./router.js";
import { embedTarget, entityCacheControl, entityPageProps, notePageProps, ssrTarget, userPageProps } from "./ssr.js";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
const HTML_HEADERS = { "content-type": "text/html; charset=utf-8" };
/** @misskey-dev/emoji-assets version of the pinned upstream (fallback for the CDN redirect). */
const DEFAULT_EMOJI_ASSETS_VERSION = "17.0.3";

export function instanceUrlOf(request: Request, env: GatewayEnv): string {
  const url = new URL(request.url);
  return (env.INSTANCE_URL ?? `${url.protocol}//${url.host}`).replace(/\/$/, "");
}

/** Responses from fetch() may have immutable headers; copy before editing. */
function withHeaders(res: Response, headers: Record<string, string>): Response {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(headers)) out.headers.set(k, v);
  return out;
}

/** Static Assets (`/vite/*`, `/static-assets/*`, `/sw.js`, …) with upstream cache lifetimes. */
export async function handleStatic(request: Request, env: GatewayEnv): Promise<Response> {
  const url = new URL(request.url);
  const pathname = url.pathname;
  if (env.ASSETS) {
    const res = await env.ASSETS.fetch(request);
    if (res.status !== 404) {
      if (res.status >= 400) return res;
      const headers: Record<string, string> = { "cache-control": staticCacheControl(pathname) };
      if (pathname.startsWith("/twemoji/") || pathname.startsWith("/fluent-emoji/")) {
        headers["content-security-policy"] = "default-src 'none'; style-src 'unsafe-inline'";
      }
      return withHeaders(res, headers);
    }
  }

  // Emoji images not uploaded (MISSKEY_CF_SKIP_EMOJI=1, Workers Free file limit) → same files on jsDelivr.
  const emoji = /^\/(twemoji|fluent-emoji)\/([0-9a-f-]+\.(?:svg|png))$/.exec(pathname);
  if (emoji) {
    const build = await loadClientBuildInfo(env, request.url);
    const version = build?.emojiAssetsVersion ?? DEFAULT_EMOJI_ASSETS_VERSION;
    return new Response(null, {
      status: 302,
      headers: {
        location: `https://cdn.jsdelivr.net/npm/@misskey-dev/emoji-assets@${version}/built/${emoji[1]}/${emoji[2]}`,
        "cache-control": "public, max-age=86400",
      },
    });
  }

  return new Response(
    JSON.stringify({
      error: "static_not_configured",
      message:
        "No Static Assets binding (ASSETS) or file for this path. Build the upstream frontend with `pnpm build-frontend` (README.md).",
      path: pathname,
    }),
    { status: 404, headers: JSON_HEADERS },
  );
}

/** `/files/*`, `/emoji/*` → API Worker (drive files in R2, custom emoji redirect). */
export async function handleMedia(request: Request, env: GatewayEnv): Promise<Response> {
  return env.API.fetch(request);
}

const META_TTL_MS = 30_000;
let metaCache: { meta: Record<string, unknown>; at: number; api: unknown } | null = null;

/** Reset the per-isolate meta cache (tests). */
export function resetMetaCache(): void {
  metaCache = null;
}

export interface LoadedMeta {
  meta: Record<string, unknown>;
  /** `data-generated-at`; 0 for the placeholder so the client still fetches `meta` itself */
  generatedAt: number;
  source: "bootstrap" | "api" | "placeholder";
}

/**
 * MetaDetailed for `#misskey_meta` (upstream packs it from the DB on every render).
 * Sources: BOOTSTRAP_META_JSON → `API_INTERNAL.getMeta()` RPC, else the API binding's
 * `POST /api/meta {detail:true}` (30 s isolate cache) → placeholder (generatedAt 0: the client's
 * cached / fetched meta wins).
 */
export async function loadMeta(request: Request, env: GatewayEnv): Promise<LoadedMeta> {
  if (env.BOOTSTRAP_META_JSON) {
    try {
      const meta = JSON.parse(env.BOOTSTRAP_META_JSON) as unknown;
      if (meta && typeof meta === "object") {
        return { meta: meta as Record<string, unknown>, generatedAt: Date.now(), source: "bootstrap" };
      }
    } catch {
      /* fall through */
    }
  }
  if (env.API_INTERNAL?.getMeta) {
    if (metaCache && metaCache.api === env.API_INTERNAL && Date.now() - metaCache.at < META_TTL_MS) {
      return { meta: metaCache.meta, generatedAt: metaCache.at, source: "api" };
    }
    try {
      const meta = await env.API_INTERNAL.getMeta();
      if (meta && typeof meta === "object" && !Array.isArray(meta)) {
        metaCache = { meta, at: Date.now(), api: env.API_INTERNAL };
        return { meta, generatedAt: metaCache.at, source: "api" };
      }
    } catch {
      /* fall through */
    }
  }
  if (metaCache && metaCache.api === env.API && Date.now() - metaCache.at < META_TTL_MS) {
    return { meta: metaCache.meta, generatedAt: metaCache.at, source: "api" };
  }
  try {
    const res = await env.API.fetch(
      new Request(new URL("/api/meta", request.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ detail: true }),
      }),
    );
    if (res.ok) {
      const meta = (await res.json()) as unknown;
      if (meta && typeof meta === "object" && !Array.isArray(meta)) {
        metaCache = { meta: meta as Record<string, unknown>, at: Date.now(), api: env.API };
        return { meta: metaCache.meta, generatedAt: metaCache.at, source: "api" };
      }
    }
  } catch {
    /* fall through */
  }
  return {
    meta: {
      name: "misskey-cf",
      uri: instanceUrlOf(request, env),
      version: "0.0.0-cf",
      providesTarball: false,
      maintainerName: null,
      maintainerEmail: null,
    },
    generatedAt: 0,
    source: "placeholder",
  };
}

function metaStr(meta: Record<string, unknown>, key: string): string | null {
  const v = meta[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** upstream HtmlTemplateService.getCommonData + renderBase defaults. */
async function basePageProps(
  request: Request,
  env: GatewayEnv,
): Promise<{ props: BasePageProps; embedClient: ClientBundle | null }> {
  const [{ meta, generatedAt }, build] = await Promise.all([
    loadMeta(request, env),
    loadClientBuildInfo(env, request.url),
  ]);
  const props: BasePageProps = {
    version: build?.version ?? metaStr(meta, "version") ?? "0.0.0",
    langs: build?.langs ?? DEFAULT_LANGS,
    instanceUrl: instanceUrlOf(request, env),
    instanceName: metaStr(meta, "name") ?? "Misskey",
    icon: metaStr(meta, "iconUrl"),
    appleTouchIcon: metaStr(meta, "app512IconUrl"),
    themeColor: metaStr(meta, "themeColor"),
    serverErrorImageUrl: metaStr(meta, "serverErrorImageUrl") ?? "https://xn--931a.moe/assets/error.jpg",
    infoImageUrl: metaStr(meta, "infoImageUrl") ?? "https://xn--931a.moe/assets/info.jpg",
    notFoundImageUrl: metaStr(meta, "notFoundImageUrl") ?? "https://xn--931a.moe/assets/not-found.jpg",
    title: metaStr(meta, "name") ?? "Misskey",
    desc: metaStr(meta, "description"),
    img: metaStr(meta, "bannerUrl"),
    meta,
    metaGeneratedAt: generatedAt,
    client: build?.frontend ?? null,
  };
  return { props, embedClient: build?.embed ?? null };
}

/** Paths upstream renders with `noindex` (tag pages). */
function isNoindexPath(pathname: string): boolean {
  return pathname.startsWith("/tags/") || pathname.startsWith("/user-tags/");
}

/**
 * Client routes (`*` in upstream): base HTML with the inlined boot loader, VERSION /
 * CLIENT_ENTRY / LANGS, instance theme / icon / name / description, `#misskey_meta`.
 * `/@user[/sub]` and `/notes/:id` are server-rendered with the entity (ssr.ts) when the
 * `API_INTERNAL` binding has it; otherwise (and for every other path) the base HTML.
 */
export async function handleSpa(request: Request, env: GatewayEnv): Promise<Response> {
  const pathname = new URL(request.url).pathname;
  const { props } = await basePageProps(request, env);
  const headers: Record<string, string> = { ...HTML_HEADERS, "cache-control": "public, max-age=30", "x-frame-options": "DENY" };
  let page: Partial<BasePageProps> = { noindex: isNoindexPath(pathname) };
  const target = env.API_INTERNAL ? ssrTarget(pathname) : null;
  if (target) {
    if (target.kind === "user" || target.kind === "note") headers.vary = "Accept";
    try {
      if (target.kind === "user" || target.kind === "note") {
        const data = target.kind === "user" ? await env.API_INTERNAL!.ssrUser(target.acct) : await env.API_INTERNAL!.ssrNote(target.id);
        if (data) {
          page = "user" in data ? userPageProps(props, data, target.kind === "user" ? target.sub : null) : notePageProps(props, data);
          headers["cache-control"] = "public, max-age=15";
          // upstream sets X-Robots-Tag twice with reply.header(), so the last value (noai) is sent
          if (data.profile.preventAiLearning) headers["x-robots-tag"] = "noai";
        }
      } else {
        const data = await env.API_INTERNAL!.ssrEntity(target.kind, target.key, target.sub);
        if (data) {
          page = entityPageProps(props, target.kind, data);
          headers["cache-control"] = entityCacheControl(target.kind, data);
          if (data.profile?.preventAiLearning) headers["x-robots-tag"] = "noai";
        }
      }
    } catch (e) {
      console.warn(`ssr failed for ${pathname}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const html = renderBaseHtml({ ...props, ...page });
  return new Response(request.method === "HEAD" ? null : html, { status: 200, headers });
}

/**
 * `/embed/*` — upstream BaseEmbed. `/embed/user-timeline/:user`, `/embed/notes/:note` and
 * `/embed/clips/:clip` carry `#misskey_embedCtx` (local user / public-or-home local note / clip)
 * when the `API_INTERNAL` binding has it; otherwise (and for unknown ones, where upstream sends
 * nothing) the plain embed shell, whose client fetches through the API.
 */
export async function handleEmbed(request: Request, env: GatewayEnv): Promise<Response> {
  const { props, embedClient } = await basePageProps(request, env);
  let embedCtx: unknown;
  const target = env.API_INTERNAL ? embedTarget(new URL(request.url).pathname) : null;
  if (target) {
    try {
      const data = await env.API_INTERNAL!.ssrEntity(target.kind, target.key);
      if (data) embedCtx = { [target.ctxKey]: data.entity };
    } catch (e) {
      console.warn(`embed ctx failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const html = renderEmbedHtml({ ...props, client: embedClient, embedCtx });
  return new Response(request.method === "HEAD" ? null : html, {
    status: 200,
    headers: { ...HTML_HEADERS, "cache-control": "public, max-age=3600" },
  });
}

/** `/_info_card_` — upstream views/info-card.tsx (meta.description is inserted as HTML, as upstream). */
export async function handleInfoCard(request: Request, env: GatewayEnv): Promise<Response> {
  const { meta } = await loadMeta(request, env);
  const html = renderInfoCardHtml({
    url: instanceUrlOf(request, env),
    name: metaStr(meta, "name"),
    description: metaStr(meta, "description"),
    bannerUrl: metaStr(meta, "bannerUrl"),
  });
  return new Response(request.method === "HEAD" ? null : html, { status: 200, headers: HTML_HEADERS });
}

/** `/manifest.json` — upstream manifestHandler (from meta; `manifestJsonOverride` honoured if present). */
export async function handleManifest(request: Request, env: GatewayEnv): Promise<Response> {
  const { meta } = await loadMeta(request, env);
  const host = new URL(instanceUrlOf(request, env)).host;
  return new Response(JSON.stringify(buildWebManifest(meta, host)), {
    status: 200,
    headers: {
      "content-type": "application/manifest+json; charset=utf-8",
      "cache-control": "max-age=300",
    },
  });
}

export async function handleRobots(request: Request, env: GatewayEnv): Promise<Response> {
  const { meta } = await loadMeta(request, env);
  return new Response(renderRobotsTxt(meta), {
    status: 200,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

export async function handleOpenSearch(request: Request, env: GatewayEnv): Promise<Response> {
  const { meta } = await loadMeta(request, env);
  return new Response(renderOpenSearchXml(meta, instanceUrlOf(request, env)), {
    status: 200,
    headers: { "content-type": "application/opensearchdescription+xml" },
  });
}

/** `/flush` — upstream: Clear-Site-Data for a same-origin https request, then static-assets/misc/flush.js. */
export function handleFlush(request: Request, env: GatewayEnv): Response {
  const headers = new Headers({
    ...HTML_HEADERS,
    "set-cookie": "http-flush-failed=1; Path=/flush; Max-Age=60",
  });
  let sendHeader = true;
  const origin = request.headers.get("origin");
  if (origin) {
    try {
      const o = new URL(origin);
      if (o.protocol !== "https:") sendHeader = false;
      if (o.host !== new URL(instanceUrlOf(request, env)).host) sendHeader = false;
    } catch {
      sendHeader = false;
    }
  }
  if (sendHeader) headers.set("clear-site-data", '"*"');
  return new Response(renderFlushHtml(), { status: 200, headers });
}

type EdgeCache = { match(req: Request): Promise<Response | undefined>; put(req: Request, res: Response): Promise<void> };
const edgeCache = (): EdgeCache | null => (globalThis as { caches?: { default?: EdgeCache } }).caches?.default ?? null;

/**
 * `/twemoji-badge/:name.png` — upstream renders the twemoji SVG into a monochrome notification
 * badge with sharp (service worker notifications). Here the SVG (Static Assets, else jsDelivr) is
 * sent to the media Container (`MEDIA`, POST /twemoji-badge) and the PNG kept in the edge cache.
 */
export async function handleTwemojiBadge(
  request: Request,
  env: GatewayEnv,
  pathname: string,
  waitUntil?: (p: Promise<unknown>) => void,
): Promise<Response> {
  const name = pathname.slice("/twemoji-badge/".length);
  if (!/^[0-9a-f-]+\.png$/.test(name)) return new Response(null, { status: 404 });
  const cache = edgeCache();
  const hit = cache ? await cache.match(request) : undefined;
  if (hit) return hit;
  if (!env.MEDIA) {
    return new Response(JSON.stringify({ error: "twemoji_badge_unavailable", message: "No MEDIA binding." }), { status: 503, headers: JSON_HEADERS });
  }
  const svgPath = `/twemoji/${name.replace(".png", "")}.svg`;
  let svg: ArrayBuffer | null = null;
  if (env.ASSETS) {
    const res = await env.ASSETS.fetch(new Request(new URL(svgPath, request.url)));
    if (res.ok) svg = await res.arrayBuffer();
  }
  if (!svg) {
    const build = await loadClientBuildInfo(env, request.url);
    const version = build?.emojiAssetsVersion ?? DEFAULT_EMOJI_ASSETS_VERSION;
    const res = await fetch(`https://cdn.jsdelivr.net/npm/@misskey-dev/emoji-assets@${version}/built${svgPath}`);
    if (res.ok) svg = await res.arrayBuffer();
  }
  // upstream: sharp fails on a missing file → 500
  if (!svg) return new Response(null, { status: 500 });
  const out = await env.MEDIA.fetch("https://media.internal/twemoji-badge", { method: "POST", headers: { "content-type": "image/svg+xml" }, body: svg });
  if (!out.ok) return new Response(null, { status: 500 });
  const res = new Response(await out.arrayBuffer(), {
    status: 200,
    headers: {
      "content-type": "image/png",
      "cache-control": "max-age=2592000",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
    },
  });
  if (cache) {
    const put = cache.put(request, res.clone()).catch(() => undefined);
    if (waitUntil) waitUntil(put);
    else await put;
  }
  return res;
}

/** `/bios` and `/cli` — upstream BiosPage / CliPage with config.version (meta.version here). */
export async function handleToolPage(request: Request, env: GatewayEnv, kind: "bios" | "cli"): Promise<Response> {
  const { meta } = await loadMeta(request, env);
  const version = metaStr(meta, "version") ?? "";
  return new Response(kind === "bios" ? renderBiosHtml(version) : renderCliHtml(version), { status: 200, headers: HTML_HEADERS });
}

/** `/@user.atom|rss|json` — upstream FeedService, generated by the API Worker (it has the data). */
export async function handleFeed(request: Request, env: GatewayEnv): Promise<Response> {
  return env.API.fetch(request);
}

/**
 * HTML `GET /users/:id` — upstream redirects to `/@username[@host]`.
 * Asks the API (`users/show`); returns null when it has no such user (caller renders the SPA).
 */
export async function redirectUserIdToAcct(
  request: Request,
  env: GatewayEnv,
  userId: string,
): Promise<Response | null> {
  try {
    const res = await env.API.fetch(
      new Request(new URL("/api/users/show", request.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId }),
      }),
    );
    if (!res.ok) return null;
    const user = (await res.json()) as { username?: unknown; host?: unknown };
    if (typeof user.username !== "string") return null;
    const host = typeof user.host === "string" && user.host ? `@${user.host}` : "";
    return new Response(null, {
      status: 302,
      headers: { location: `/@${encodeURIComponent(user.username)}${host}` },
    });
  } catch {
    return null;
  }
}
