/**
 * `/proxy/*` (upstream FileServerService + FileServerProxyHandler): the media proxy the web
 * client uses for remote avatars, emojis, previews and badges (`meta.mediaProxy`, by default
 * `${url}/proxy`). The file is a local drive file (`${url}/files/<key>`: R2, or the remote
 * original of a link file) or a remote URL downloaded here; conversions (emoji / avatar / static
 * / preview / badge / SVG) run on sharp in the media Container (`MEDIA`, POST /proxy).
 *
 * Without the MEDIA binding, emoji / avatar / static / preview fall back to the original when it
 * is a browser-safe image, and badge / SVG answer 500. Downloads are capped by MAX_FILE_SIZE
 * (100 MB default) and refuse private hosts by name, as summaly.ts. Only a conversion holds the
 * whole file in memory; the original streams through (from R2, or from the remote as it arrives).
 */

import { fetchChecked, UnsafeUrlError } from "./safe-fetch.js";
import { serverMaxFileSize } from "./file-size.js";
import type { ApiEnv } from "./env.js";
import { buildPackConfig } from "./meta-source.js";
import { withHyperdriveClient } from "./pg.js";
import { contentDisposition, correctFilename, detectType, FILE_TYPE_BROWSERSAFE, isMimeImage, parseRange } from "./drive/media.js";
import { decodeBase64Content } from "./drive/files.js";
import { DUMMY_PNG_BASE64 } from "./media-proxy-dummy.js";

type Row = Record<string, unknown>;

const CSP = "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'";

class StatusError extends Error {
  constructor(message: string, public statusCode: number) {
    super(message);
  }
  get isClientError(): boolean {
    return this.statusCode >= 400 && this.statusCode < 500;
  }
}

/**
 * The file being proxied. Its body is read only as far as needed: whole for a conversion
 * (`bytes`), streamed through for the original (`stream`), so a large original is never held in
 * memory whole.
 */
type FileSource = {
  kind: "file";
  mime: string;
  ext: string | null;
  filename: string;
  /** the whole body (at most MAX_FILE_SIZE) */
  bytes(): Promise<Uint8Array>;
  /** the whole body as a stream */
  stream(): Promise<BodyInit>;
  /** bytes `start`..`end` (inclusive) for a Range request; the size is needed first, so `size()` */
  size(): Promise<number>;
  slice(start: number, end: number): Promise<BodyInit>;
};
type Source = { kind: "not-found" } | { kind: "unavailable" } | FileSource;

const dummy = () => decodeBase64Content(DUMMY_PNG_BASE64) as unknown as BodyInit;
const body = (u: Uint8Array) => u as unknown as BodyInit;

const maxSize = serverMaxFileSize;

/** Bytes read from a download before deciding on the type (detectType looks at the first 4 KiB). */
const HEAD_BYTES = 64 * 1024;

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  if (chunks.length === 1) return chunks[0]!;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

/** A source whose body is already in memory. */
function bufferedSource(bytes: Uint8Array, mime: string, ext: string | null, filename: string): FileSource {
  return {
    kind: "file",
    mime,
    ext,
    filename,
    bytes: async () => bytes,
    stream: async () => body(bytes),
    size: async () => bytes.byteLength,
    slice: async (start, end) => body(bytes.slice(start, end + 1)),
  };
}

/** Workers' FixedLengthStream (missing under Node): keeps Content-Length on a streamed body. */
const FixedLength = (globalThis as { FixedLengthStream?: new (n: number) => TransformStream<Uint8Array, Uint8Array> }).FixedLengthStream;

/** DownloadService.downloadUrl + FileInfoService.detectType. */
async function download(env: ApiEnv, url: string): Promise<Source> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new StatusError("Invalid URL", 400);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new StatusError("Invalid URL", 400);
  const config = buildPackConfig(env);
  // every redirect hop is checked too
  const res = await fetchChecked(env.AP_FETCH ?? fetch, url, {
    headers: { "User-Agent": `Misskey/${config.version} (${config.url})` },
    signal: AbortSignal.timeout(60_000),
  }).then(
    (r) => r.res,
    (e) => {
      throw e instanceof UnsafeUrlError ? new StatusError("Private IP rejected", 400) : e;
    },
  );
  if (res.status >= 400) throw new StatusError(`${res.status} ${res.statusText}`, res.status);
  const max = maxSize(env);
  const declared = res.headers.get("content-length");
  if (Number(declared ?? 0) > max) {
    await res.body?.cancel().catch(() => {});
    throw new StatusError("too large", 413);
  }
  const disp = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(res.headers.get("content-disposition") ?? "");
  let filename = "untitled";
  try {
    filename = disp ? decodeURIComponent(disp[1]!) : decodeURIComponent(new URL(res.url || url).pathname.split("/").pop() || "") || "untitled";
  } catch {
    /* keep untitled */
  }

  const reader = res.body?.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let done = !reader;
  /** read until `limit` bytes are in `chunks` or the body ends */
  const readUntil = async (limit: number) => {
    while (!done && total < limit) {
      const r = await reader!.read();
      if (r.done) {
        done = true;
        break;
      }
      total += r.value.byteLength;
      if (total > max) {
        await reader!.cancel().catch(() => {});
        throw new StatusError("too large", 413);
      }
      chunks.push(r.value);
    }
  };
  await readUntil(HEAD_BYTES);
  let t = detectType(concat(chunks, total));
  // the whole body is needed for an SVG (converted) and to tell one apart by size (detectType)
  if (!done && t.mime === "image/svg+xml") {
    await readUntil(Infinity);
    t = detectType(concat(chunks, total));
  }
  if (done) return bufferedSource(concat(chunks, total), t.mime, t.ext, filename);

  // the rest of the body is still unread
  let all: Promise<Uint8Array> | null = null;
  const bytes = () => (all ??= readUntil(Infinity).then(() => concat(chunks, total)));
  // Content-Length counts the bytes as sent; with a Content-Encoding the runtime decodes them
  const length = declared != null && /^\d+$/.test(declared) && !res.headers.get("content-encoding") ? Number(declared) : null;
  const stream = async (): Promise<BodyInit> => {
    const head = chunks.splice(0);
    let sent = total;
    const rs = new ReadableStream<Uint8Array>({
      start(c) {
        for (const h of head) c.enqueue(h);
      },
      async pull(c) {
        const r = await reader!.read();
        if (r.done) return c.close();
        sent += r.value.byteLength;
        if (sent > max) {
          await reader!.cancel().catch(() => {});
          return c.error(new StatusError("too large", 413));
        }
        c.enqueue(r.value);
      },
      cancel: (reason) => reader!.cancel(reason),
    });
    return (length != null && FixedLength ? rs.pipeThrough(new FixedLength(length)) : rs) as unknown as BodyInit;
  };
  return {
    kind: "file",
    mime: t.mime,
    ext: t.ext,
    filename,
    bytes,
    stream,
    size: async () => (await bytes()).byteLength,
    slice: async (start, end) => body((await bytes()).slice(start, end + 1)),
  };
}

/** FileServerFileResolver.resolveFileByAccessKey: R2 objects (any role) or a link file's remote original. */
async function resolveByAccessKey(env: ApiEnv, key: string): Promise<Source> {
  if (!env.HYPERDRIVE?.connectionString) return { kind: "not-found" };
  const file = await withHyperdriveClient(env.HYPERDRIVE, async (c) =>
    (await c.query(
      `SELECT id, name, type, uri, "isLink", "accessKey", "thumbnailAccessKey", "webpublicAccessKey" FROM drive_file
       WHERE "accessKey" = $1 OR "thumbnailAccessKey" = $1 OR "webpublicAccessKey" = $1 LIMIT 1`,
      [key],
    )).rows[0] as Row | undefined,
  );
  if (!file) return { kind: "not-found" };
  if (file.isLink) {
    if (typeof file.uri !== "string") return { kind: "unavailable" };
    const d = await download(env, file.uri);
    return d.kind === "file" ? { ...d, filename: String(file.name) } : d;
  }
  if (!/^[a-zA-Z0-9._-]+$/.test(key) || key === "." || key === "..") return { kind: "not-found" };
  const bucket = env.MEDIA_BUCKET;
  const obj = bucket ? await bucket.get(`drive/${key}`) : null;
  if (!obj) return { kind: "unavailable" };
  if (file.accessKey !== key) {
    // a thumbnail / webpublic (small): its type comes from its content
    const bytes = new Uint8Array(await obj.arrayBuffer());
    const t = detectType(bytes);
    return bufferedSource(bytes, t.mime, t.ext, String(file.name));
  }
  // the original: the type is the row's, the body streams from R2 (a Range is R2's own)
  let all: Promise<Uint8Array> | null = null;
  const bytes = () => (all ??= obj.arrayBuffer().then((b) => new Uint8Array(b)));
  return {
    kind: "file",
    mime: String(file.type),
    ext: null,
    filename: String(file.name),
    bytes,
    stream: async () => (obj.body ? (obj.body as unknown as BodyInit) : body(await bytes())),
    size: async () => obj.size ?? (await bytes()).byteLength,
    slice: async (start, end) => {
      if (!obj.body) return body((await bytes()).slice(start, end + 1));
      await obj.body.cancel().catch(() => {});
      const part = await bucket!.get(`drive/${key}`, { range: { offset: start, length: end - start + 1 } });
      if (!part?.body) throw new StatusError("Gone", 404);
      return part.body as unknown as BodyInit;
    },
  };
}

type Converted = { data: Uint8Array; type: string; ext: string | null };

async function container(env: ApiEnv, file: FileSource, mode: string, isStatic: boolean, key: string): Promise<Converted> {
  const res = await env.MEDIA!.fetch(
    `https://media.internal/proxy?mode=${mode}&mime=${encodeURIComponent(file.mime)}&static=${isStatic ? 1 : 0}&key=${encodeURIComponent(key)}`,
    { method: "POST", headers: { "content-type": "application/octet-stream" }, body: body(await file.bytes()) },
  );
  if (res.status === 404) throw new StatusError("Skip to provide badge", 404);
  if (!res.ok) throw new Error(`media container ${res.status}`);
  return { data: new Uint8Array(await res.arrayBuffer()), type: res.headers.get("content-type") ?? "image/webp", ext: res.headers.get("x-ext") };
}

/**
 * FileServerProxyHandler.processImage: a conversion, "original" (the file as is, without Range),
 * or null (the original through createDefaultStream, Range included).
 */
async function processImage(env: ApiEnv, file: FileSource, q: URLSearchParams, key: string): Promise<Converted | "original" | null> {
  const has = (k: string) => q.has(k);
  const requiresImageConversion = has("emoji") || has("avatar") || has("static") || has("preview") || has("badge");
  if (requiresImageConversion && !isMimeImage(file.mime, "sharp-convertible-image-with-bmp")) throw new StatusError("Unexpected mime", 404);
  const browserSafeImage = file.mime.startsWith("image/") && FILE_TYPE_BROWSERSAFE.includes(file.mime);
  if (has("emoji") || has("avatar")) {
    if (!isMimeImage(file.mime, "sharp-animation-convertible-image-with-bmp") && !has("static")) return "original";
    if (!env.MEDIA) {
      if (browserSafeImage) return "original";
      throw new Error("no media container");
    }
    return container(env, file, has("emoji") ? "emoji" : "avatar", has("static"), key);
  }
  for (const mode of ["static", "preview", "badge"] as const) {
    if (!has(mode)) continue;
    if (!env.MEDIA) {
      if (mode !== "badge" && browserSafeImage) return "original";
      throw new Error("no media container");
    }
    return container(env, file, mode, false, key);
  }
  if (file.mime === "image/svg+xml") {
    if (!env.MEDIA) throw new Error("no media container");
    return container(env, file, "svg", false, key);
  }
  if (!browserSafeImage) throw new StatusError("Rejected type", 403);
  return null;
}

/** GET /proxy/:url* */
export async function handleMediaProxy(env: ApiEnv, request: Request): Promise<Response> {
  const reqUrl = new URL(request.url);
  const q = reqUrl.searchParams;
  const pathUrl = decodeURIComponent(reqUrl.pathname.slice("/proxy/".length));
  const errorResponse = (e: unknown) => {
    console.warn(`media proxy: ${e instanceof Error ? e.message : String(e)}`);
    // upstream's headers for the client; CDN-Cache-Control keeps a shared cache from handing one
    // client's failure (or the fallback dummy) to everyone for 5 minutes
    const headers = { "cache-control": "max-age=300", "cdn-cache-control": "no-store", "content-security-policy": CSP };
    if (q.has("fallback")) return new Response(dummy(), { status: 200, headers: { ...headers, "content-type": "image/png" } });
    if (e instanceof StatusError && (e.statusCode === 302 || e.isClientError)) return new Response(null, { status: e.statusCode, headers });
    return new Response(null, { status: 500, headers });
  };
  try {
    const urls = q.getAll("url");
    if (urls.length > 1) return new Response(null, { status: 400, headers: { "content-security-policy": CSP } });
    const url = q.has("url") ? urls[0]! : `https://${pathUrl}`;
    const mustOrigin = q.has("origin");
    const config = buildPackConfig(env);
    const base = config.url.replace(/\/$/, "");
    const external = env.MEDIA_PROXY?.replace(/\/$/, "");
    if (external && external !== `${base}/proxy` && !mustOrigin) {
      // redirectToExternalProxy
      const to = new URL(`${external}/${pathUrl}`);
      for (const [k, v] of q) to.searchParams.append(k, v);
      return new Response(null, { status: 301, headers: { location: to.toString(), "cache-control": "public, max-age=259200", "content-security-policy": CSP } });
    }
    const ua = request.headers.get("user-agent");
    if (!ua) throw new StatusError("User-Agent is required", 400);
    if (ua.toLowerCase().includes("misskey/")) throw new StatusError("Refusing to proxy a request from another proxy", 403);

    let file: Source;
    if (url.startsWith(`${base}/files/`)) {
      const key = url.slice(`${base}/files/`.length).split("/").shift();
      if (!key) throw new StatusError("Invalid File Key", 400);
      file = await resolveByAccessKey(env, key);
    } else {
      file = await download(env, url);
    }
    if (file.kind === "not-found") {
      return new Response(dummy(), { status: 404, headers: { "content-type": "image/png", "cache-control": "max-age=86400", "content-security-policy": CSP } });
    }
    if (file.kind === "unavailable") return new Response(null, { status: 204, headers: { "cache-control": "max-age=86400", "content-security-policy": CSP } });

    const image = await processImage(env, file, q, url);
    const converted = image != null && image !== "original" ? image : null;
    const headers: Record<string, string> = {
      "content-type": converted?.type ?? file.mime,
      "cache-control": "max-age=31536000, immutable",
      "content-disposition": contentDisposition("inline", correctFilename(file.filename, converted ? converted.ext : file.ext)),
      "content-security-policy": CSP,
    };
    if (converted) return new Response(body(converted.data), { status: 200, headers });
    // createDefaultStream: Range on the original
    const rangeHeader = image == null ? request.headers.get("range") : null;
    if (rangeHeader) {
      const size = await file.size();
      const range = size > 0 ? parseRange(rangeHeader, size) : null;
      if (range && range !== "invalid") {
        return new Response(await file.slice(range.start, range.end), {
          status: 206,
          headers: { ...headers, "content-range": `bytes ${range.start}-${range.end}/${size}`, "accept-ranges": "bytes", "content-length": String(range.end - range.start + 1) },
        });
      }
    }
    return new Response(await file.stream(), { status: 200, headers });
  } catch (e) {
    return errorResponse(e);
  }
}
