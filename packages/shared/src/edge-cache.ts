/**
 * Cloudflare edge cache (Workers Cache API, per colo) in front of responses that are the same for
 * every viewer: `/files/*`, `/proxy/*`, `/emoji/*` (api) and the anonymous HTML shell / SSR pages
 * (gateway). A Worker response's own Cache-Control does not
 * put it in the edge cache; `cache.put` does, for the lifetime that Cache-Control declares.
 *
 * Only GETs are stored, only the statuses in `statuses`, and never a response whose
 * Cache-Control or CDN-Cache-Control (the shared-cache directive, which clients do not see) says
 * no-store or private. A Range request is answered from a stored full response (`cache.match`
 * slices a 200 with Content-Length into a 206); on a miss the origin answers it and nothing is
 * stored. `cache.match` answers conditional requests (If-None-Match) with 304.
 * `caches.default` is a no-op on workers.dev and missing under Node (offline tests).
 */

type EdgeCache = {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
};

function defaultCache(): EdgeCache | null {
  const c = (globalThis as { caches?: { default?: EdgeCache } }).caches;
  return c?.default ?? null;
}

export async function withEdgeCache(
  request: Request,
  waitUntil: ((p: Promise<unknown>) => void) | undefined,
  produce: () => Promise<Response>,
  opts: { statuses?: number[]; cache?: EdgeCache | null } = {},
): Promise<Response> {
  const cache = opts.cache === undefined ? defaultCache() : opts.cache;
  if (!cache || request.method !== "GET") return produce();
  try {
    const hit = await cache.match(request);
    if (hit) return hit;
  } catch {
    /* fall through to the origin */
  }
  const res = await produce();
  if (request.headers.has("range")) return res;
  const statuses = opts.statuses ?? [200];
  const cc = res.headers.get("cache-control") ?? "";
  const shared = res.headers.get("cdn-cache-control") ?? "";
  if (statuses.includes(res.status) && !/no-store|private/i.test(cc) && !/no-store|private/i.test(shared) && /max-age=\d/.test(cc)) {
    const put = cache.put(new Request(request.url, { method: "GET" }), res.clone()).catch(() => undefined);
    if (waitUntil) waitUntil(put);
    else await put;
  }
  return res;
}
