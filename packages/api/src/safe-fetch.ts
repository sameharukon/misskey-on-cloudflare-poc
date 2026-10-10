/**
 * Outbound fetches of user- or remote-supplied URLs: redirects are followed by hand, and
 * every hop is checked (scheme, credentials, host) before it is requested, so a redirect cannot
 * lead past the check made on the first URL.
 *
 * Hosts are checked by name: IP literals in private, loopback, link-local, CGNAT, multicast and
 * reserved ranges (WHATWG URL parsing has already turned decimal / hex IPv4 forms into
 * dotted quads), and `localhost` / `.local` / `.internal`. Names that resolve to such addresses
 * are not caught here: Workers have no DNS API, and their egress cannot reach private networks
 * (upstream checks the resolved address in its HTTP agent instead).
 */

/** A host name that must not be fetched (see the module comment). */
export function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4) {
    const [a, b, c] = [Number(v4[1]), Number(v4[2]), Number(v4[3])];
    return (
      a === 0 || a === 10 || a === 127 ||
      (a === 100 && b >= 64 && b <= 127) || // CGNAT
      (a === 169 && b === 254) || // link-local, cloud metadata
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0 && (c === 0 || c === 2)) || // IETF protocol assignments, TEST-NET-1
      (a === 198 && (b === 18 || b === 19)) || // benchmarking
      (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113) || // TEST-NET-2/3
      a >= 224 // multicast, reserved, broadcast
    );
  }
  if (h.includes(":")) {
    return h === "::" || h === "::1" || /^f[cd]/.test(h) || /^fe[89a-f]/.test(h) || /^ff/.test(h) || /^::ffff:/.test(h) || /^64:ff9b:/.test(h) || /^2001:db8:/.test(h);
  }
  return false;
}

/** http(s), no userinfo, and not a private host. */
export function isPublicHttpUrl(u: URL): boolean {
  return (u.protocol === "http:" || u.protocol === "https:") && u.username === "" && u.password === "" && !isPrivateHost(u.hostname);
}

export class UnsafeUrlError extends Error {
  constructor(readonly url: string) {
    super(`unsafe url: ${url}`);
    this.name = "UnsafeUrlError";
  }
}

/**
 * Time limit of a federation request to a remote server (upstream HttpRequestService: 5 s). The
 * signal also covers redirects and reading the body. Without it a host that never answers holds
 * a queue batch until the platform gives up on the connection.
 */
export const REMOTE_FETCH_TIMEOUT_MS = 5_000;

/** Time limit of downloading a remote file (upstream DownloadService: 60 s). */
export const REMOTE_DOWNLOAD_TIMEOUT_MS = 60_000;

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export type CheckedFetchOptions = {
  /** Whether a URL may be requested (default: {@link isPublicHttpUrl}). Checked on every hop. */
  check?: (u: URL) => boolean;
  /** Redirects to follow (default 10). With 0 a redirect response is returned as is. */
  maxRedirects?: number;
};

/**
 * `fetch` with `redirect: "manual"`, following redirects itself after checking each target.
 * Returns the final response and its URL. Throws {@link UnsafeUrlError} for a refused URL
 * (the first one included) and a plain Error for too many redirects.
 */
export async function fetchChecked(
  fetcher: Fetcher,
  url: string,
  init: RequestInit = {},
  opts: CheckedFetchOptions = {},
): Promise<{ res: Response; url: string }> {
  const check = opts.check ?? isPublicHttpUrl;
  const maxRedirects = opts.maxRedirects ?? 10;
  let current: URL;
  try {
    current = new URL(url);
  } catch {
    throw new UnsafeUrlError(url);
  }
  let method = (init.method ?? "GET").toUpperCase();
  for (let hop = 0; ; hop++) {
    if (!check(current)) throw new UnsafeUrlError(current.href);
    const res = await fetcher(current.href, { ...init, method, body: method === "GET" || method === "HEAD" ? undefined : init.body, redirect: "manual" });
    const location = res.headers.get("location");
    if (!REDIRECT_STATUSES.has(res.status) || !location || maxRedirects === 0) return { res, url: current.href };
    if (hop >= maxRedirects) {
      await res.body?.cancel();
      throw new Error(`too many redirects: ${url}`);
    }
    await res.body?.cancel();
    let next: URL;
    try {
      next = new URL(location, current);
    } catch {
      throw new UnsafeUrlError(location);
    }
    // 303 (and 301 / 302 for a POST, as browsers do) continue as GET
    if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === "POST")) method = "GET";
    current = next;
  }
}

/** The body was over the limit given to {@link readCapped}. */
export class BodyTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`response body over ${maxBytes} bytes`);
    this.name = "BodyTooLargeError";
  }
}

/**
 * Read a response body, stopping as soon as it is over `maxBytes` (counted after the runtime has
 * decoded any content encoding, so a compressed body cannot expand past it in memory).
 */
export async function readCapped(res: Response, maxBytes: number): Promise<Uint8Array> {
  if (Number(res.headers.get("content-length") ?? 0) > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw new BodyTooLargeError(maxBytes);
  }
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new BodyTooLargeError(maxBytes);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let off = 0;
  for (const ch of chunks) {
    bytes.set(ch, off);
    off += ch.byteLength;
  }
  return bytes;
}

/** {@link readCapped} as UTF-8 text. */
export async function readCappedText(res: Response, maxBytes: number): Promise<string> {
  return new TextDecoder().decode(await readCapped(res, maxBytes));
}
