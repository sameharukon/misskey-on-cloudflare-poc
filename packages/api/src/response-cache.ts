/**
 * Cache-Control for API responses, as upstream: ApiCallService sets
 * `Cache-Control: public, max-age=<cacheSec>` on anonymous GET calls of `cacheSec` endpoints, and
 * ApiServerService marks every other API response `private, max-age=0, must-revalidate`.
 * There is no server-side response cache (upstream has none either).
 */

export const NO_CACHE = "private, max-age=0, must-revalidate";

/** Set a header, copying the response when its headers are immutable (e.g. a fetched one). */
export function withHeader(res: Response, name: string, value: string): Response {
  try {
    res.headers.set(name, value);
    return res;
  } catch {
    const copy = new Response(res.body, res);
    copy.headers.set(name, value);
    return copy;
  }
}
