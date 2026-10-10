/**
 * `GET /url?url=&lang=` (upstream UrlPreviewService.handle): meta.urlPreviewEnabled, the summary
 * from summaly (summaly.ts) or from meta.urlPreviewSummaryProxyUrl, an isolate cache of 1 hour /
 * 100 entries, icon / thumbnail through the media proxy (config.mediaProxy: MEDIA_PROXY or the
 * built-in `${url}/proxy`, media-proxy.ts), urlPreviewSensitiveList, 422 on failure.
 */

import type { ApiEnv } from "../env.js";
import { buildPackConfig } from "../meta-source.js";
import { withHyperdriveClient } from "../pg.js";
import { metaRowPg } from "../user-lite-pg.js";
import { isKeyWordIncluded } from "../search-pg.js";
import { SUMMALY_VERSION, summaly, type SummalyResult } from "./summaly.js";

type Row = Record<string, unknown>;

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

/** MemoryKVCache(1h, 100) */
const cache = new Map<string, { at: number; value: SummalyResult }>();
const CACHE_TTL = 60 * 60 * 1000;
const CACHE_MAX = 100;
/** Summaries being fetched, by cache key (requests for the same key share the fetch). */
const inflight = new Map<string, ReturnType<typeof fetchSummary>>();

export function resetUrlPreviewCache(): void {
  cache.clear();
}

function apiError(message: string, code: string, id: string) {
  return { error: { message, code, id, kind: "client" } };
}

/** upstream misc/prelude/url `query`: undefined values dropped. */
function query(o: Record<string, unknown>): string {
  return Object.entries(o)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join("&");
}

async function fetchSummary(env: ApiEnv, meta: Row, url: string, lang: string | undefined, userAgent: string): Promise<SummalyResult> {
  const proxy = meta.urlPreviewSummaryProxyUrl as string | null | undefined;
  const common = {
    followRedirects: meta.urlPreviewAllowRedirect !== false,
    userAgent: (meta.urlPreviewUserAgent as string | null | undefined) ?? userAgent,
    operationTimeout: Number(meta.urlPreviewTimeout ?? 10000),
    contentLengthLimit: Number(meta.urlPreviewMaximumContentLength ?? 1024 * 1024 * 10),
    contentLengthRequired: meta.urlPreviewRequireContentLength === true,
  };
  if (proxy) {
    // fetchSummaryFromProxy: HttpRequestService.getJson(`${proxy}?${query}`, 'application/json, */*', undefined, true)
    const res = await (env.AP_FETCH ?? fetch)(`${proxy}?${query({ url, lang: lang ?? "ja-JP", ...common })}`, {
      headers: { Accept: "application/json, */*", "User-Agent": common.userAgent },
      signal: AbortSignal.timeout(common.operationTimeout),
    });
    if (!res.ok) throw new Error(`proxy ${res.status}`);
    return (await res.json()) as SummalyResult;
  }
  return summaly(url, { ...common, lang: lang ?? "ja-JP", fetch: env.AP_FETCH });
}

export async function handleUrlPreview(env: ApiEnv, request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const urls = params.getAll("url");
  const langs = params.getAll("lang");
  if (urls.length !== 1) return new Response(null, { status: 400 });
  if (langs.length > 1) return new Response(null, { status: 400 });
  const url = urls[0]!;
  const lang = langs[0];
  const meta = env.HYPERDRIVE?.connectionString ? await withHyperdriveClient(env.HYPERDRIVE, (c) => metaRowPg(c)) : {};
  if (meta.urlPreviewEnabled === false || !env.HYPERDRIVE?.connectionString) {
    return new Response(JSON.stringify(apiError("URL preview is disabled", "URL_PREVIEW_DISABLED", "58b36e13-d2f5-0323-b0c6-76aa9dabefb8")), { status: 403, headers: JSON_HEADERS });
  }
  const config = buildPackConfig(env);
  const userAgent = `SummalyBot/${SUMMALY_VERSION} (${config.url}; +https://github.com/misskey-dev/summaly/blob/master/README.md)`;
  const cacheHeaders = { ...JSON_HEADERS, "cache-control": "max-age=86400, immutable" };
  try {
    const key = `${url}@${lang ?? "_DEFAULT_"}`;
    let summary: SummalyResult | undefined;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL) {
      summary = hit.value;
    } else {
      // clients receiving the same note over streaming ask at once: one fetch per key in this isolate
      let pending = inflight.get(key);
      if (!pending) {
        pending = fetchSummary(env, meta, url, lang, userAgent).finally(() => inflight.delete(key));
        inflight.set(key, pending);
      }
      const result = await pending;
      const valid =
        (result.url.startsWith("http://") || result.url.startsWith("https://")) &&
        !(result.player?.url && !result.player.url.startsWith("http://") && !result.player.url.startsWith("https://"));
      // fetchMaybe: undefined is not cached
      if (valid) {
        summary = result;
        cache.delete(key);
        cache.set(key, { at: Date.now(), value: result });
        while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
      }
    }
    if (summary == null) throw new Error("Invalid summary");
    const out = structuredClone(summary);
    const proxy = config.mediaProxy.replace(/\/$/, "");
    const wrap = (u: string | null | undefined) => (u != null ? `${proxy}/preview.webp?${query({ url: u, preview: "1" })}` : null);
    out.icon = wrap(out.icon);
    out.thumbnail = wrap(out.thumbnail);
    if (out.sensitive !== true) {
      out.sensitive = isKeyWordIncluded(out.url, Array.isArray(meta.urlPreviewSensitiveList) ? (meta.urlPreviewSensitiveList as string[]) : []);
    }
    return new Response(JSON.stringify(out), { status: 200, headers: cacheHeaders });
  } catch (e) {
    console.warn(`Failed to get preview of ${url}: ${e instanceof Error ? e.message : String(e)}`);
    // the client keeps upstream's headers; a shared cache must not hold a (possibly transient) failure for a day
    return new Response(JSON.stringify(apiError("Failed to get preview", "URL_PREVIEW_FAILED", "09d01cb5-53b9-4856-82e5-38a50c290a3b")), { status: 422, headers: { ...cacheHeaders, "cdn-cache-control": "no-store" } });
  }
}
