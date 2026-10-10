/**
 * Drive on PG (`drive_file`, `drive_folder`) + R2 (`MEDIA_BUCKET`), matching
 * upstream DriveService / DriveFileEntityService / DriveFolderEntityService
 * and the drive/* endpoints (request/response shapes + error ids).
 *
 * Media processing (thumbnail / webpublic / blurhash) is delegated to the
 * `MEDIA` service binding (misskey-cf-media → Container with sharp + ffmpeg).
 * Without it (or on failure/timeout) the original is served and
 * `thumbnailUrl` follows upstream's fallback (image → url, otherwise null).
 */

import { fetchChecked } from "./safe-fetch.js";
import { serverMaxFileSize } from "./file-size.js";
import { genAidx, parseAidxTime } from "../../id/src/index.js";
import { packUserLite } from "../../packers/src/index.js";
import type { ApiEnv } from "./env.js";
import { apiErrorResponse, CREDENTIAL_REQUIRED, INTERNAL_ERROR, INVALID_PARAM, type ApiErrorBody } from "./errors.js";
import { authenticatePg, extractToken } from "./auth-pg.js";
import { buildPackConfig } from "./meta-source.js";
import { withHyperdriveClient, type PgQueryable } from "./pg.js";
import { getUsersByIdsPg, packNotesFromPg, rowToPackNote } from "./notes-pg.js";
import { pagination } from "./client-endpoints-pg.js";
import { publishToUserStream } from "./stream-publish.js";
import { getUserPoliciesPg, isModeratorPg } from "./policies-pg.js";
import { md5Hex, decodeBase64Content, findDriveFileByAccessKey, readDriveBytes } from "./drive/files.js";
import {
  contentDisposition,
  correctFilename,
  detectType,
  isAllowedType,
  isMimeImage,
  probeImage,
  PROBED_IMAGE_TYPES,
  safeContentType,
  validateFileName,
} from "./drive/media.js";
import { packDriveFile } from "./drive/pack.js";
export { packDriveFile, thumbnailUrlOf } from "./drive/pack.js";
import { clientError as err, hd } from "./handler-kit.js";
import { enqueueJob } from "./queues/jobs-queue.js";

export interface UploadedFile {
  name: string | null;
  type: string | null;
  bytes: Uint8Array;
}

export type DriveCtx = {
  hasCredential: boolean;
  request: Request;
  file?: UploadedFile;
  waitUntil?: (p: Promise<unknown>) => void;
};
type Body = Record<string, unknown>;
export type DriveHandler = (env: ApiEnv, body: Body, ctx: DriveCtx) => Promise<Response | unknown>;
type Row = Record<string, unknown>;

const noContent = () => new Response(null, { status: 204 });
const str = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : undefined);
/** JSON boolean, or the string form multipart sends (upstream casts with JSON.parse). */
const bool = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : v === "true" ? true : v === "false" ? false : undefined);
function limitOf(body: Body, def: number, max = 100): number {
  const raw = typeof body.limit === "string" ? Number(body.limit) : body.limit;
  const n = typeof raw === "number" && Number.isFinite(raw) ? raw : def;
  return Math.max(1, Math.min(max, Math.floor(n)));
}

async function authUser(env: ApiEnv, body: Body, ctx: DriveCtx): Promise<string | null> {
  if (!ctx.hasCredential) return null;
  const token = extractToken(ctx.request, body);
  if (!token) return null;
  const a = await authenticatePg(env, token);
  return a?.user.id ?? null;
}

export { serverMaxFileSize };

function baseUrl(env: ApiEnv): string {
  return (env.INSTANCE_URL ?? "https://misskey.local").replace(/\/$/, "");
}

// ---------------------------------------------------------------- packers

/** Packed DriveFolder (upstream DriveFolderEntityService.pack). */
export async function packFolder(c: PgQueryable, row: Row, detail: boolean, depth = 0): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {
    id: String(row.id),
    createdAt: (parseAidxTime(String(row.id)) ?? new Date(0)).toISOString(),
    name: String(row.name),
    parentId: (row.parentId as string | null) ?? null,
  };
  if (!detail) return out;
  const counts = await c.query(
    `SELECT (SELECT count(*) FROM drive_folder WHERE "parentId" = $1)::int AS folders,
            (SELECT count(*) FROM drive_file WHERE "folderId" = $1)::int AS files`,
    [row.id],
  );
  out.foldersCount = Number(counts.rows[0]?.folders ?? 0);
  out.filesCount = Number(counts.rows[0]?.files ?? 0);
  if (row.parentId && depth < 16) {
    const p = await c.query(`SELECT * FROM drive_folder WHERE id = $1`, [row.parentId]);
    if (p.rows[0]) out.parent = await packFolder(c, p.rows[0], true, depth + 1);
  }
  return out;
}

export async function packFileDetail(env: ApiEnv, c: PgQueryable, row: Row, withUser: boolean): Promise<Record<string, unknown>> {
  let folder: unknown = null;
  if (row.folderId) {
    const f = await c.query(`SELECT * FROM drive_folder WHERE id = $1`, [row.folderId]);
    if (f.rows[0]) folder = await packFolder(c, f.rows[0], true);
  }
  let user: unknown = null;
  if (withUser && row.userId) {
    const u = (await getUsersByIdsPg(env, [String(row.userId)])).get(String(row.userId));
    if (u) user = packUserLite(u, buildPackConfig(env));
  }
  return packDriveFile(row, { self: true, withUser }, { folder, user });
}

// ---------------------------------------------------------------- media processing

export interface AltsImage {
  type: string;
  /** base64 */
  data: string;
}
export interface AltsResult {
  properties?: { width?: number; height?: number; orientation?: number };
  blurhash?: string | null;
  thumbnail?: AltsImage | null;
  webpublic?: AltsImage | null;
}

/** Ask the media container for thumbnail / webpublic / blurhash. null = unavailable. */
export async function requestAlts(env: ApiEnv, bytes: Uint8Array, type: string, generateWeb: boolean): Promise<AltsResult | null> {
  const media = env.MEDIA;
  if (!media) return null;
  if (!type.startsWith("video/") && !isMimeImage(type, "sharp-convertible-image-with-bmp")) return null;
  const res = await media.fetch(`https://media.internal/alts?type=${encodeURIComponent(type)}&web=${generateWeb ? 1 : 0}`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    // the bytes themselves (a request body is copied out of a view, no copy needed here)
    body: bytes as unknown as BodyInit,
  });
  if (!res.ok) throw new Error(`media container ${res.status}`);
  return (await res.json()) as AltsResult;
}

function b64ToBytes(s: string): Uint8Array {
  return decodeBase64Content(s);
}

const extOfMime = (m: string) => (m === "image/webp" ? "webp" : m === "image/png" ? "png" : m === "image/jpeg" ? "jpg" : "bin");

/** Store generated alts in R2 and record them on the row. Returns the updated row. */
export async function applyAlts(env: ApiEnv, fileId: string, alts: AltsResult): Promise<Row | null> {
  const bucket = env.MEDIA_BUCKET!;
  const base = baseUrl(env);
  let thumbKey: string | null = null;
  let webKey: string | null = null;
  if (alts.thumbnail?.data) {
    thumbKey = `thumbnail-${crypto.randomUUID()}`;
    await bucket.put(`drive/${thumbKey}`, b64ToBytes(alts.thumbnail.data), { httpMetadata: { contentType: alts.thumbnail.type }, customMetadata: { fileId, role: "thumbnail" } });
  }
  if (alts.webpublic?.data) {
    webKey = `webpublic-${crypto.randomUUID()}`;
    await bucket.put(`drive/${webKey}`, b64ToBytes(alts.webpublic.data), { httpMetadata: { contentType: alts.webpublic.type }, customMetadata: { fileId, role: "webpublic" } });
  }
  const props: Record<string, unknown> = {};
  if (alts.properties?.width && alts.properties?.height) {
    props.width = alts.properties.width;
    props.height = alts.properties.height;
  }
  if (alts.properties?.orientation != null) props.orientation = alts.properties.orientation;
  return withHyperdriveClient(hd(env), async (c) => {
    const r = await c.query(
      `UPDATE drive_file SET
         "thumbnailUrl" = COALESCE($2, "thumbnailUrl"), "thumbnailAccessKey" = COALESCE($3, "thumbnailAccessKey"),
         "webpublicUrl" = COALESCE($4, "webpublicUrl"), "webpublicAccessKey" = COALESCE($5, "webpublicAccessKey"),
         "webpublicType" = COALESCE($6, "webpublicType"),
         blurhash = COALESCE($7, blurhash),
         properties = properties || $8::jsonb
       WHERE id = $1 RETURNING *`,
      [
        fileId,
        thumbKey ? `${base}/files/${thumbKey}` : null,
        thumbKey,
        webKey ? `${base}/files/${webKey}` : null,
        webKey,
        webKey ? alts.webpublic!.type : null,
        alts.blurhash ?? null,
        JSON.stringify(props),
      ],
    );
    return r.rows[0] ?? null;
  });
}

export type DriveAltsJob = { kind: "driveAlts"; fileId: string };

/** Seconds before the `driveAlts` safety-net job looks at a file whose alternates timed out. */
export const DRIVE_ALTS_RETRY_DELAY_SEC = 120;

/**
 * `driveAlts` job: alternates for a local file that still has none (the upload's own attempt timed
 * out and its `waitUntil` was cut off, or the container failed). Reads the original back from R2.
 */
export async function runDriveAltsJob(env: ApiEnv, job: DriveAltsJob): Promise<void> {
  if (!env.MEDIA || !env.MEDIA_BUCKET || !env.HYPERDRIVE?.connectionString) return;
  const row = await withHyperdriveClient(hd(env), async (c) =>
    (await c.query(`SELECT id, type, "accessKey", "thumbnailAccessKey", "storedInternal", "isLink" FROM drive_file WHERE id = $1`, [job.fileId])).rows[0],
  );
  if (!row || row.thumbnailAccessKey || row.isLink || !row.accessKey) return;
  const obj = await env.MEDIA_BUCKET.get(`drive/${String(row.accessKey)}`);
  if (!obj) return;
  const bytes = new Uint8Array(await obj.arrayBuffer());
  const alts = await requestAlts(env, bytes, String(row.type), true);
  if (alts) await applyAlts(env, job.fileId, alts);
}

/** How long create waits for the container before finishing in the background. */
export let ALTS_SYNC_TIMEOUT_MS = 10_000;
export function setAltsTimeoutForTest(ms: number): void {
  ALTS_SYNC_TIMEOUT_MS = ms;
}

// ---------------------------------------------------------------- addFile

const CREATE_ERRORS = {
  invalidFileName: err("INVALID_FILE_NAME", "f449b209-0c60-4e51-84d5-29486263bfd4", "Invalid file name."),
  noFreeSpace: err("NO_FREE_SPACE", "d08dbc37-a6a9-463a-8c47-96c32ab5f064", "Cannot upload the file because you have no free space of drive."),
  maxFileSizeExceeded: err("MAX_FILE_SIZE_EXCEEDED", "b9d8c348-33f0-4673-b9a9-5d4da058977a", "Cannot upload the file because it exceeds the maximum file size."),
  unallowedFileType: err("UNALLOWED_FILE_TYPE", "4becd248-7f2c-48c4-a9f0-75edc4f9a1ea", "Cannot upload the file because it is an unallowed file type."),
};
const FILE_REQUIRED = err("FILE_REQUIRED", "4267801e-70d1-416a-b011-4ee502885d8b", "File required.");

class DriveError extends Error {
  constructor(public body: ApiErrorBody, public status = 400) {
    super(body.code);
  }
}

export interface AddFileArgs {
  userId: string;
  bytes: Uint8Array;
  name: string | null;
  comment?: string | null;
  folderId?: string | null;
  force?: boolean;
  sensitive?: boolean;
  waitUntil?: (p: Promise<unknown>) => void;
  /** type for content magic bytes cannot identify (exports: csv / json) */
  typeHint?: { mime: string; ext: string };
}

/** Usage = SUM(size) of the user's non-link files (calcDriveUsageOf). */
async function driveUsage(c: PgQueryable, userId: string): Promise<number> {
  const r = await c.query(`SELECT COALESCE(SUM(size), 0)::bigint AS sum FROM drive_file WHERE "userId" = $1 AND "isLink" = FALSE`, [userId]);
  return Number(r.rows[0]?.sum ?? 0);
}

/** DriveService.addFile for a local user (throws DriveError with upstream ids). */
export async function addFilePg(env: ApiEnv, a: AddFileArgs): Promise<Row> {
  const bytes = a.bytes;
  const detected = detectType(bytes);
  const info = detected.mime === "application/octet-stream" && a.typeHint ? a.typeHint : detected;
  const md5 = md5Hex(bytes);
  const detectedName = correctFilename(a.name && validateFileName(a.name) ? a.name : "untitled", info.ext);
  const properties: Record<string, unknown> = {};
  if (PROBED_IMAGE_TYPES.includes(info.mime)) {
    const p = probeImage(bytes, info.mime);
    if (p && p.width && p.height) {
      properties.width = p.width;
      properties.height = p.height;
      if (p.orientation != null) properties.orientation = p.orientation;
    }
  }

  const prepared = await withHyperdriveClient(hd(env), async (c) => {
    const policies = await getUserPoliciesPg(env, c, a.userId);
    if (!a.force) {
      const m = await c.query(`SELECT * FROM drive_file WHERE md5 = $1 AND "userId" = $2 ORDER BY id LIMIT 1`, [md5, a.userId]);
      const matched = m.rows[0];
      if (matched) {
        if (a.sensitive && !matched.isSensitive) {
          await c.query(`UPDATE drive_file SET "isSensitive" = TRUE WHERE id = $1`, [matched.id]);
          matched.isSensitive = true;
        }
        return { matched } as const;
      }
    }
    if (!(await isModeratorPg(env, c, a.userId))) {
      const allowed = Array.isArray(policies.uploadableFileTypes) ? (policies.uploadableFileTypes as string[]) : [];
      if (!isAllowedType(allowed, info.mime)) throw new DriveError(CREATE_ERRORS.unallowedFileType);
      const maxFileSize = Math.min(serverMaxFileSize(env), 1024 * 1024 * Number(policies.maxFileSizeMb ?? 30));
      if (maxFileSize < bytes.byteLength) throw new DriveError(CREATE_ERRORS.maxFileSizeExceeded, 413);
      const capacity = 1024 * 1024 * Number(policies.driveCapacityMb ?? 100);
      if (capacity < (await driveUsage(c, a.userId)) + bytes.byteLength) throw new DriveError(CREATE_ERRORS.noFreeSpace);
    } else if (serverMaxFileSize(env) < bytes.byteLength) {
      throw new DriveError(CREATE_ERRORS.maxFileSizeExceeded, 413);
    }
    let folderId: string | null = null;
    if (a.folderId) {
      const f = await c.query(`SELECT id FROM drive_folder WHERE id = $1 AND "userId" = $2`, [a.folderId, a.userId]);
      if (!f.rows[0]) throw new DriveError(INTERNAL_ERROR, 500); // upstream: Error('folder-not-found') → generic ApiError
      folderId = a.folderId;
    }
    const prof = await c.query(`SELECT "alwaysMarkNsfw" FROM user_profile WHERE "userId" = $1`, [a.userId]);
    const isSensitive = Boolean(prof.rows[0]?.alwaysMarkNsfw) || policies.alwaysMarkNsfw === true || a.sensitive === true;
    return { folderId, isSensitive } as const;
  });
  if ("matched" in prepared) return prepared.matched as Row;

  const id = genAidx(Date.now());
  const accessKey = crypto.randomUUID();
  const url = `${baseUrl(env)}/files/${accessKey}`;
  await env.MEDIA_BUCKET!.put(`drive/${accessKey}`, bytes, {
    httpMetadata: { contentType: info.mime },
    customMetadata: { fileId: id, userId: a.userId, role: "original" },
  });
  let row = await withHyperdriveClient(hd(env), async (c) => {
    const r = await c.query(
      `INSERT INTO drive_file (
         id, "userId", "userHost", md5, name, type, size, comment, blurhash, properties,
         "storedInternal", url, "thumbnailUrl", "webpublicUrl", "accessKey", "thumbnailAccessKey",
         "webpublicAccessKey", uri, "isSensitive", "folderId", "isLink"
       ) VALUES ($1, $2, NULL, $3, $4, $5, $6, $7, NULL, $8::jsonb, FALSE, $9, NULL, NULL, $10, NULL, NULL, NULL, $11, $12, FALSE)
       RETURNING *`,
      [id, a.userId, md5, detectedName, info.mime, bytes.byteLength, a.comment ?? null, JSON.stringify(properties), url, accessKey, prepared.isSensitive, prepared.folderId],
    );
    return r.rows[0]!;
  });

  // thumbnail / webpublic: wait a bounded time, then finish in the background
  const work = requestAlts(env, bytes, info.mime, true)
    .then((alts) => (alts ? applyAlts(env, id, alts) : null))
    .catch((e) => {
      console.warn(`drive alts failed for ${id}: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((r) => {
    timer = setTimeout(() => r("timeout"), ALTS_SYNC_TIMEOUT_MS);
  });
  const done = await Promise.race([work, timeout]);
  if (timer) clearTimeout(timer);
  if (done === "timeout") {
    a.waitUntil?.(work);
    // waitUntil may be cut off (large videos, a cold container): a delayed job finishes the file if not
    if (env.Q_JOBS) {
      const job: DriveAltsJob = { kind: "driveAlts", fileId: id };
      await enqueueJob(env, job, { delaySeconds: DRIVE_ALTS_RETRY_DELAY_SEC }).catch(() => undefined);
    }
  }
  else if (done) row = done;

  const packed = packDriveFile(row, { self: true });
  await publishToUserStream(env, a.userId, "main", "driveFileCreated", packed);
  await publishToUserStream(env, a.userId, "drive", "fileCreated", packed);
  return row;
}

// ---------------------------------------------------------------- serving

/** GET/HEAD /files/:key — original, thumbnail-* or webpublic-* object from R2. */
export async function serveDriveFile(env: ApiEnv, request: Request, key: string): Promise<Response> {
  const secHeaders = {
    "content-security-policy": "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'",
    "access-control-allow-origin": "*",
    "x-content-type-options": "nosniff",
  };
  if (!env.HYPERDRIVE?.connectionString || !env.MEDIA_BUCKET) {
    // offline in-memory store
    const row = await findDriveFileByAccessKey(env, key);
    if (!row) return new Response("Not Found", { status: 404 });
    const body = await readDriveBytes(env, row);
    if (!body) return new Response("Not Found", { status: 404 });
    const copy = new Uint8Array(body.bytes.byteLength);
    copy.set(body.bytes);
    return new Response(copy, {
      headers: { ...secHeaders, "content-type": safeContentType(body.type), "cache-control": "max-age=31536000, immutable" },
    });
  }
  const row = await withHyperdriveClient(hd(env), async (c) => {
    const r = await c.query(
      `SELECT id, name, type, "webpublicType", "accessKey", "thumbnailAccessKey", "webpublicAccessKey"
       FROM drive_file WHERE "accessKey" = $1 OR "thumbnailAccessKey" = $1 OR "webpublicAccessKey" = $1 LIMIT 1`,
      [key],
    );
    return r.rows[0] ?? null;
  });
  if (!row) return new Response("Not Found", { status: 404, headers: { "cache-control": "max-age=86400" } });
  const role = row.accessKey === key ? "original" : row.thumbnailAccessKey === key ? "thumbnail" : "webpublic";
  const baseName = String(row.name).replace(/\.[^.]+$/, "");
  const r2Key = `drive/${key}`;
  const bucket = env.MEDIA_BUCKET as unknown as R2Like;

  const rangeHeader = request.headers.get("range");
  const range = parseR2Range(rangeHeader);
  const inm = request.headers.get("if-none-match");
  let obj: R2ObjLike | null;
  try {
    // with If-None-Match, R2 compares the etag itself and answers a match without the body
    const opts = { ...(range ? { range } : {}), ...(inm ? { onlyIf: new Headers({ "if-none-match": inm }) } : {}) };
    obj = request.method === "HEAD" ? await bucket.head(r2Key) : await bucket.get(r2Key, Object.keys(opts).length ? opts : undefined);
  } catch (e) {
    // an unsatisfiable range is 416; anything else is a storage error
    if (rangeHeader) return new Response(null, { status: 416, headers: secHeaders });
    console.warn(`drive file ${r2Key}: ${e instanceof Error ? e.message : String(e)}`);
    return new Response(null, { status: 500, headers: secHeaders });
  }
  if (!obj) return new Response("Not Found", { status: 404, headers: { "cache-control": "max-age=86400" } });
  const stored = obj.httpMetadata?.contentType;
  const mime = role === "original" ? String(row.type) : stored ?? (role === "webpublic" ? String(row.webpublicType ?? row.type) : "image/webp");
  const filename = role === "original" ? String(row.name) : `${baseName}${role === "thumbnail" ? "-thumb" : "-web"}.${extOfMime(mime)}`;
  const headers: Record<string, string> = {
    ...secHeaders,
    "content-type": safeContentType(mime),
    "cache-control": "max-age=31536000, immutable",
    "content-disposition": contentDisposition("inline", filename),
    "accept-ranges": "bytes",
  };
  if (obj.httpEtag) headers.etag = obj.httpEtag;
  // a failed onlyIf returns the object without a body
  if (inm && obj.httpEtag && (inm === obj.httpEtag || (request.method === "GET" && !obj.body))) {
    await obj.body?.cancel?.();
    return new Response(null, { status: 304, headers });
  }
  if (request.method === "HEAD") {
    headers["content-length"] = String(obj.size);
    return new Response(null, { status: 200, headers });
  }
  if (range && obj.range) {
    const offset = "suffix" in obj.range && obj.range.suffix != null ? obj.size - obj.range.suffix : (obj.range.offset ?? 0);
    const length = "suffix" in obj.range && obj.range.suffix != null ? obj.range.suffix : (obj.range.length ?? obj.size - offset);
    headers["content-range"] = `bytes ${offset}-${offset + length - 1}/${obj.size}`;
    headers["content-length"] = String(length);
    return new Response(obj.body ?? null, { status: 206, headers });
  }
  headers["content-length"] = String(obj.size);
  return new Response(obj.body ?? null, { status: 200, headers });
}

type R2Range = { offset?: number; length?: number; suffix?: number };
type R2ObjLike = {
  size: number;
  httpEtag?: string;
  httpMetadata?: { contentType?: string };
  range?: R2Range;
  body?: ReadableStream & { cancel?: () => Promise<void> };
};
type R2Like = {
  get(key: string, opts?: { range?: R2Range; onlyIf?: Headers }): Promise<R2ObjLike | null>;
  head(key: string): Promise<R2ObjLike | null>;
};

/** `bytes=a-b` / `bytes=a-` / `bytes=-n` → R2 range (multi-range unsupported → full body). */
export function parseR2Range(h: string | null): R2Range | undefined {
  if (!h) return undefined;
  const m = /^bytes=(\d*)-(\d*)$/.exec(h.trim());
  if (!m || (m[1] === "" && m[2] === "")) return undefined;
  if (m[1] === "") return { suffix: Number(m[2]) };
  const offset = Number(m[1]);
  if (m[2] === "") return { offset };
  const end = Number(m[2]);
  if (end < offset) return undefined;
  return { offset, length: end - offset + 1 };
}

/** Remove a drive file's R2 objects (original, thumbnail, webpublic). Best-effort. */
export async function deleteObjects(env: ApiEnv, row: Row): Promise<void> {
  const keys = [row.accessKey, row.thumbnailAccessKey, row.webpublicAccessKey].filter((k): k is string => typeof k === "string" && k.length > 0).map((k) => `drive/${k}`);
  if (keys.length && env.MEDIA_BUCKET) {
    try {
      await env.MEDIA_BUCKET.delete(keys);
    } catch (e) {
      console.warn(`R2 delete failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

// ---------------------------------------------------------------- endpoints

function typeFilter(type: unknown, params: unknown[]): string | null {
  const t = str(type);
  if (!t) return null;
  if (!/^[a-zA-Z/\-*]+$/.test(t)) return "FALSE";
  if (t.endsWith("/*")) {
    params.push(t.replace("/*", "/") + "%");
    return `f.type LIKE $${params.length}`;
  }
  params.push(t);
  return `f.type = $${params.length}`;
}

const drive: DriveHandler = async (env, body, ctx) => {
  const me = await authUser(env, body, ctx);
  if (!me) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  return withHyperdriveClient(hd(env), async (c) => {
    const policies = await getUserPoliciesPg(env, c, me);
    return { capacity: 1024 * 1024 * Number(policies.driveCapacityMb ?? 100), usage: await driveUsage(c, me) };
  });
};

const SORTS: Record<string, string> = {
  "+createdAt": "f.id DESC",
  "-createdAt": "f.id ASC",
  "+name": "f.name DESC",
  "-name": "f.name ASC",
  "+size": "f.size DESC",
  "-size": "f.size ASC",
};

async function listFiles(env: ApiEnv, me: string, body: Body, withFolder: boolean): Promise<unknown[]> {
  const params: unknown[] = [me];
  const where = [`f."userId" = $1`];
  if (withFolder) {
    const folderId = str(body.folderId);
    if (folderId) {
      params.push(folderId);
      where.push(`f."folderId" = $${params.length}`);
    } else where.push(`f."folderId" IS NULL`);
  }
  const tf = typeFilter(body.type, params);
  if (tf) where.push(tf);
  const pg = pagination(body, params, "f.id");
  where.push(...pg.where);
  const sort = withFolder && typeof body.sort === "string" ? SORTS[body.sort] : undefined;
  params.push(limitOf(body, 10));
  const rows = await withHyperdriveClient(hd(env), async (c) =>
    (await c.query(`SELECT f.* FROM drive_file f WHERE ${where.join(" AND ")} ORDER BY ${sort ?? `f.id ${pg.order}`} LIMIT $${params.length}`, params)).rows,
  );
  return rows.map((r) => packDriveFile(r, { self: true }));
}

const driveFiles: DriveHandler = async (env, body, ctx) => {
  const me = await authUser(env, body, ctx);
  if (!me) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  return listFiles(env, me, body, true);
};

const driveStream: DriveHandler = async (env, body, ctx) => {
  const me = await authUser(env, body, ctx);
  if (!me) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  return listFiles(env, me, body, false);
};

const filesCreate: DriveHandler = async (env, body, ctx) => {
  const me = await authUser(env, body, ctx);
  if (!me) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  let file = ctx.file;
  if (!file && typeof body.content === "string" && body.content) {
    // misskey-cf extension kept for older scripts: JSON base64 `content`
    try {
      file = { name: str(body.name) ?? null, type: str(body.type) ?? null, bytes: decodeBase64Content(body.content) };
    } catch {
      return apiErrorResponse(INVALID_PARAM, 400);
    }
  }
  if (!file) return apiErrorResponse(FILE_REQUIRED, 400);
  let name: string | null = (typeof body.name === "string" ? body.name : null) ?? file.name ?? null;
  if (name != null) {
    name = name.trim();
    if (name.length === 0 || name === "blob") name = null;
    else if (!validateFileName(name)) return apiErrorResponse(CREATE_ERRORS.invalidFileName, 400);
  }
  const comment = typeof body.comment === "string" ? body.comment : null;
  if (comment != null && comment.length > 512) return apiErrorResponse(INVALID_PARAM, 400);
  try {
    const row = await addFilePg(env, {
      userId: me,
      bytes: file.bytes,
      name,
      comment,
      folderId: str(body.folderId) ?? null,
      force: bool(body.force) ?? false,
      sensitive: bool(body.isSensitive) ?? false,
      waitUntil: ctx.waitUntil,
    });
    return packDriveFile(row, { self: true });
  } catch (e) {
    if (e instanceof DriveError) return apiErrorResponse(e.body, e.status);
    console.warn(`drive/files/create failed: ${e instanceof Error ? e.message : String(e)}`);
    return apiErrorResponse(INTERNAL_ERROR, 500);
  }
};

const SHOW_ERR = {
  noSuchFile: err("NO_SUCH_FILE", "067bc436-2718-4795-b0fb-ecbe43949e31", "No such file."),
  accessDenied: err("ACCESS_DENIED", "25b73c73-68b1-41d0-bad1-381cfdf6579f", "Access denied."),
};

const filesShow: DriveHandler = async (env, body, ctx) => {
  const me = await authUser(env, body, ctx);
  if (!me) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  const fileId = str(body.fileId);
  const url = str(body.url);
  if (!fileId && !url) return apiErrorResponse(INVALID_PARAM, 400);
  return withHyperdriveClient(hd(env), async (c) => {
    const r = fileId
      ? await c.query(`SELECT * FROM drive_file WHERE id = $1`, [fileId])
      : await c.query(`SELECT * FROM drive_file WHERE url = $1 OR "webpublicUrl" = $1 OR "thumbnailUrl" = $1 LIMIT 1`, [url]);
    const row = r.rows[0];
    if (!row) return apiErrorResponse(SHOW_ERR.noSuchFile, 400);
    if (row.userId !== me && !(await isModeratorPg(env, c, me))) return apiErrorResponse(SHOW_ERR.accessDenied, 400);
    return packFileDetail(env, c, row, true);
  });
};

const UPDATE_ERR = {
  invalidFileName: err("INVALID_FILE_NAME", "395e7156-f9f0-475e-af89-53c3c23080c2", "Invalid file name."),
  noSuchFile: err("NO_SUCH_FILE", "e7778c7e-3af9-49cd-9690-6dbc3e6c972d", "No such file."),
  accessDenied: err("ACCESS_DENIED", "01a53b27-82fc-445b-a0c1-b558465a8ed2", "Access denied."),
  noSuchFolder: err("NO_SUCH_FOLDER", "ea8fb7a5-af77-4a08-b608-c0218176cd73", "No such folder."),
  restrictedByRole: err("RESTRICTED_BY_ROLE", "7f59dccb-f465-75ab-5cf4-3ce44e3282f7", "This feature is restricted by your role."),
};

const filesUpdate: DriveHandler = async (env, body, ctx) => {
  const me = await authUser(env, body, ctx);
  if (!me) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  const fileId = str(body.fileId);
  if (!fileId) return apiErrorResponse(INVALID_PARAM, 400);
  if (body.comment != null && (typeof body.comment !== "string" || body.comment.length > 512)) return apiErrorResponse(INVALID_PARAM, 400);
  const result = await withHyperdriveClient(hd(env), async (c) => {
    const row = (await c.query(`SELECT * FROM drive_file WHERE id = $1`, [fileId])).rows[0];
    if (!row) return apiErrorResponse(UPDATE_ERR.noSuchFile, 400);
    if (row.userId !== me && !(await isModeratorPg(env, c, me))) return apiErrorResponse(UPDATE_ERR.accessDenied, 400);
    const sets: string[] = [];
    const params: unknown[] = [fileId];
    if (typeof body.name === "string") {
      if (!validateFileName(body.name)) return apiErrorResponse(UPDATE_ERR.invalidFileName, 400);
      params.push(body.name);
      sets.push(`name = $${params.length}`);
    }
    if (typeof body.isSensitive === "boolean") {
      if (body.isSensitive !== row.isSensitive && !body.isSensitive && row.userId) {
        const policies = await getUserPoliciesPg(env, c, String(row.userId));
        if (policies.alwaysMarkNsfw === true) return apiErrorResponse(UPDATE_ERR.restrictedByRole, 400);
      }
      params.push(body.isSensitive);
      sets.push(`"isSensitive" = $${params.length}`);
    }
    if (body.comment !== undefined) {
      params.push(body.comment);
      sets.push(`comment = $${params.length}`);
    }
    if (body.folderId !== undefined) {
      if (body.folderId !== null) {
        const f = await c.query(`SELECT id FROM drive_folder WHERE id = $1 AND "userId" = $2`, [body.folderId, row.userId]);
        if (!f.rows[0]) return apiErrorResponse(UPDATE_ERR.noSuchFolder, 400);
      }
      params.push(body.folderId);
      sets.push(`"folderId" = $${params.length}`);
    }
    const updated = sets.length ? (await c.query(`UPDATE drive_file SET ${sets.join(", ")} WHERE id = $1 RETURNING *`, params)).rows[0]! : row;
    return { packed: packDriveFile(updated, { self: true }), owner: (row.userId as string | null) ?? null };
  });
  if (result instanceof Response) return result;
  if (result.owner) await publishToUserStream(env, result.owner, "drive", "fileUpdated", result.packed);
  return result.packed;
};

const DELETE_ERR = {
  noSuchFile: err("NO_SUCH_FILE", "908939ec-e52b-4458-b395-1025195cea58", "No such file."),
  accessDenied: err("ACCESS_DENIED", "5eb8d909-2540-4970-90b8-dd6f86088121", "Access denied."),
};

const filesDelete: DriveHandler = async (env, body, ctx) => {
  const me = await authUser(env, body, ctx);
  if (!me) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  const fileId = str(body.fileId);
  if (!fileId) return apiErrorResponse(INVALID_PARAM, 400);
  const res = await withHyperdriveClient(hd(env), async (c) => {
    const row = (await c.query(`SELECT * FROM drive_file WHERE id = $1`, [fileId])).rows[0];
    if (!row) return apiErrorResponse(DELETE_ERR.noSuchFile, 400);
    if (row.userId !== me && !(await isModeratorPg(env, c, me))) return apiErrorResponse(DELETE_ERR.accessDenied, 400);
    await c.query(`DELETE FROM drive_file WHERE id = $1`, [fileId]);
    return row;
  });
  if (res instanceof Response) return res;
  await deleteObjects(env, res);
  if (res.userId) await publishToUserStream(env, String(res.userId), "drive", "fileDeleted", fileId);
  return noContent();
};

const filesFind: DriveHandler = async (env, body, ctx) => {
  const me = await authUser(env, body, ctx);
  if (!me) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  if (typeof body.name !== "string") return apiErrorResponse(INVALID_PARAM, 400);
  const folderId = str(body.folderId) ?? null;
  const rows = await withHyperdriveClient(hd(env), async (c) =>
    (await c.query(
      `SELECT * FROM drive_file WHERE name = $1 AND "userId" = $2 AND ${folderId ? `"folderId" = $3` : `"folderId" IS NULL`} ORDER BY id DESC`,
      folderId ? [body.name, me, folderId] : [body.name, me],
    )).rows,
  );
  return rows.map((r) => packDriveFile(r, { self: true }));
};

const filesFindByHash: DriveHandler = async (env, body, ctx) => {
  const me = await authUser(env, body, ctx);
  if (!me) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  if (typeof body.md5 !== "string") return apiErrorResponse(INVALID_PARAM, 400);
  const rows = await withHyperdriveClient(hd(env), async (c) =>
    (await c.query(`SELECT * FROM drive_file WHERE md5 = $1 AND "userId" = $2 ORDER BY id DESC`, [body.md5, me])).rows,
  );
  return rows.map((r) => packDriveFile(r, { self: true }));
};

const filesCheckExistence: DriveHandler = async (env, body, ctx) => {
  const me = await authUser(env, body, ctx);
  if (!me) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  if (typeof body.md5 !== "string") return apiErrorResponse(INVALID_PARAM, 400);
  return withHyperdriveClient(hd(env), async (c) =>
    (await c.query(`SELECT 1 AS x FROM drive_file WHERE md5 = $1 AND "userId" = $2 LIMIT 1`, [body.md5, me])).rows.length > 0,
  );
};

const ATTACHED_NO_SUCH_FILE = err("NO_SUCH_FILE", "c118ece3-2e4b-4296-99d1-51756e32d232", "No such file.");

const filesAttachedNotes: DriveHandler = async (env, body, ctx) => {
  const me = await authUser(env, body, ctx);
  if (!me) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  const fileId = str(body.fileId);
  if (!fileId) return apiErrorResponse(INVALID_PARAM, 400);
  const rows = await withHyperdriveClient(hd(env), async (c) => {
    const f = (await c.query(`SELECT id, "userId" FROM drive_file WHERE id = $1`, [fileId])).rows[0];
    if (!f || (f.userId !== me && !(await isModeratorPg(env, c, me)))) return null;
    const params: unknown[] = [fileId];
    const pg = pagination(body, params);
    params.push(limitOf(body, 10));
    return (await c.query(
      // `@>` (not `= ANY`) so the GIN index on fileIds (IDX_NOTE_FILE_IDS) serves it, as upstream's `<@`
      `SELECT n.* FROM note n WHERE n."fileIds" @> ARRAY[$1]::varchar[] ${pg.where.map((w) => `AND ${w}`).join(" ")} ORDER BY n.id ${pg.order} LIMIT $${params.length}`,
      params,
    )).rows;
  });
  if (!rows) return apiErrorResponse(ATTACHED_NO_SUCH_FILE, 400);
  return packNotesFromPg(env, rows.map(rowToPackNote), buildPackConfig(env), me);
};

const filesMoveBulk: DriveHandler = async (env, body, ctx) => {
  const me = await authUser(env, body, ctx);
  if (!me) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  const ids = body.fileIds;
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 100 || !ids.every((x) => typeof x === "string")) return apiErrorResponse(INVALID_PARAM, 400);
  const folderId = str(body.folderId) ?? null;
  return withHyperdriveClient(hd(env), async (c) => {
    if (folderId) {
      const f = await c.query(`SELECT id FROM drive_folder WHERE id = $1 AND "userId" = $2`, [folderId, me]);
      if (!f.rows[0]) return apiErrorResponse(INTERNAL_ERROR, 500); // upstream: findOneByOrFail → generic error
    }
    await c.query(`UPDATE drive_file SET "folderId" = $1 WHERE id = ANY($2::varchar[]) AND "userId" = $3`, [folderId, ids, me]);
    return noContent();
  });
};

/** upload-from-url: answer 204 now; download + addFile in the background, then main `urlUploadFinished`. */
const filesUploadFromUrl: DriveHandler = async (env, body, ctx) => {
  const me = await authUser(env, body, ctx);
  if (!me) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  const url = str(body.url);
  if (!url || !/^https?:\/\//i.test(url)) return apiErrorResponse(INVALID_PARAM, 400);
  if (body.comment != null && (typeof body.comment !== "string" || body.comment.length > 512)) return apiErrorResponse(INVALID_PARAM, 400);
  const job = uploadFromUrl(env, me, {
    url,
    folderId: str(body.folderId) ?? null,
    sensitive: body.isSensitive === true,
    force: body.force === true,
    comment: typeof body.comment === "string" ? body.comment : null,
    marker: typeof body.marker === "string" ? body.marker : null,
  }).catch((e) => console.warn(`upload-from-url failed: ${e instanceof Error ? e.message : String(e)}`));
  if (ctx.waitUntil) ctx.waitUntil(job);
  else await job;
  return noContent();
};

export async function uploadFromUrl(
  env: ApiEnv,
  userId: string,
  o: { url: string; folderId: string | null; sensitive: boolean; force: boolean; comment: string | null; marker: string | null },
): Promise<Row> {
  const max = serverMaxFileSize(env);
  // A Worker's fetch to its own hostname bypasses the Worker, so serve our own /files/ in-process.
  const target = new URL(o.url);
  const own = target.origin === new URL(baseUrl(env)).origin ? /^\/files\/([^/]+)$/.exec(target.pathname) : null;
  const res = own
    ? await serveDriveFile(env, new Request(o.url), decodeURIComponent(own[1]!))
    : (await fetchChecked(env.AP_FETCH ?? fetch, o.url, { headers: { "user-agent": "misskey-cf (drive upload-from-url)" } })).res; // hops checked
  if (!res.ok || !res.body) throw new Error(`fetch ${res.status}`);
  if (Number(res.headers.get("content-length") ?? 0) > max) throw new Error("too large");
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      throw new Error("too large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let off = 0;
  for (const ch of chunks) {
    bytes.set(ch, off);
    off += ch.byteLength;
  }
  let name: string | null = null;
  try {
    name = decodeURIComponent(new URL(o.url).pathname.split("/").pop() ?? "") || null;
  } catch {
    name = null;
  }
  const row = await addFilePg(env, { userId, bytes, name, comment: o.comment, folderId: o.folderId, force: o.force, sensitive: o.sensitive });
  await publishToUserStream(env, userId, "main", "urlUploadFinished", { marker: o.marker, file: packDriveFile(row, { self: true }) });
  return row;
}

// ---------------------------------------------------------------- folders

const FOLDER_ERR = {
  createNoSuchFolder: err("NO_SUCH_FOLDER", "53326628-a00d-40a6-a3cd-8975105c0f95", "No such folder."),
  deleteNoSuchFolder: err("NO_SUCH_FOLDER", "1069098f-c281-440f-b085-f9932edbe091", "No such folder."),
  hasChild: err("HAS_CHILD_FILES_OR_FOLDERS", "b0fc8a17-963c-405d-bfbc-859a487295e1", "This folder has child files or folders."),
  showNoSuchFolder: err("NO_SUCH_FOLDER", "d74ab9eb-bb09-4bba-bf24-fb58f761e1e9", "No such folder."),
  updateNoSuchFolder: err("NO_SUCH_FOLDER", "f7974dac-2c0d-4a27-926e-23583b28e98e", "No such folder."),
  noSuchParent: err("NO_SUCH_PARENT_FOLDER", "ce104e3a-faaf-49d5-b459-10ff0cbbcaa1", "No such parent folder."),
  recursive: err("RECURSIVE_NESTING", "dbeb024837894013aed44279f9199740", "It can not be structured like nesting folders recursively."),
};

const driveFolders: DriveHandler = async (env, body, ctx) => {
  const me = await authUser(env, body, ctx);
  if (!me) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  const params: unknown[] = [me];
  const where = [`f."userId" = $1`];
  const folderId = str(body.folderId);
  if (folderId) {
    params.push(folderId);
    where.push(`f."parentId" = $${params.length}`);
  } else where.push(`f."parentId" IS NULL`);
  const pg = pagination(body, params, "f.id");
  where.push(...pg.where);
  params.push(limitOf(body, 10));
  return withHyperdriveClient(hd(env), async (c) => {
    const rows = (await c.query(`SELECT f.* FROM drive_folder f WHERE ${where.join(" AND ")} ORDER BY f.id ${pg.order} LIMIT $${params.length}`, params)).rows;
    return Promise.all(rows.map((r) => packFolder(c, r, false)));
  });
};

const foldersCreate: DriveHandler = async (env, body, ctx) => {
  const me = await authUser(env, body, ctx);
  if (!me) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  const name = typeof body.name === "string" ? body.name : "Untitled";
  if (name.length > 200) return apiErrorResponse(INVALID_PARAM, 400);
  const parentId = str(body.parentId) ?? null;
  const res = await withHyperdriveClient(hd(env), async (c) => {
    if (parentId) {
      const p = await c.query(`SELECT id FROM drive_folder WHERE id = $1 AND "userId" = $2`, [parentId, me]);
      if (!p.rows[0]) return apiErrorResponse(FOLDER_ERR.createNoSuchFolder, 400);
    }
    const row = (await c.query(`INSERT INTO drive_folder (id, name, "userId", "parentId") VALUES ($1, $2, $3, $4) RETURNING *`, [genAidx(Date.now()), name, me, parentId])).rows[0]!;
    return packFolder(c, row, false);
  });
  if (!(res instanceof Response)) await publishToUserStream(env, me, "drive", "folderCreated", res);
  return res;
};

const foldersShow: DriveHandler = async (env, body, ctx) => {
  const me = await authUser(env, body, ctx);
  if (!me) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  const folderId = str(body.folderId);
  if (!folderId) return apiErrorResponse(INVALID_PARAM, 400);
  return withHyperdriveClient(hd(env), async (c) => {
    const row = (await c.query(`SELECT * FROM drive_folder WHERE id = $1 AND "userId" = $2`, [folderId, me])).rows[0];
    if (!row) return apiErrorResponse(FOLDER_ERR.showNoSuchFolder, 400);
    return packFolder(c, row, true);
  });
};

const foldersUpdate: DriveHandler = async (env, body, ctx) => {
  const me = await authUser(env, body, ctx);
  if (!me) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  const folderId = str(body.folderId);
  if (!folderId) return apiErrorResponse(INVALID_PARAM, 400);
  if (body.name !== undefined && (typeof body.name !== "string" || body.name.length > 200)) return apiErrorResponse(INVALID_PARAM, 400);
  const res = await withHyperdriveClient(hd(env), async (c) => {
    const row = (await c.query(`SELECT * FROM drive_folder WHERE id = $1 AND "userId" = $2`, [folderId, me])).rows[0];
    if (!row) return apiErrorResponse(FOLDER_ERR.updateNoSuchFolder, 400);
    let name = String(row.name);
    if (typeof body.name === "string" && body.name) name = body.name;
    let parentId = (row.parentId as string | null) ?? null;
    if (body.parentId !== undefined) {
      if (body.parentId === folderId) return apiErrorResponse(FOLDER_ERR.recursive, 400);
      if (body.parentId === null) parentId = null;
      else {
        const parent = (await c.query(`SELECT * FROM drive_folder WHERE id = $1 AND "userId" = $2`, [body.parentId, me])).rows[0];
        if (!parent) return apiErrorResponse(FOLDER_ERR.noSuchParent, 400);
        // walk up from the new parent; reaching this folder means a cycle
        let cur = (parent.parentId as string | null) ?? null;
        for (let i = 0; cur && i < 64; i++) {
          if (cur === folderId) return apiErrorResponse(FOLDER_ERR.recursive, 400);
          cur = ((await c.query(`SELECT "parentId" FROM drive_folder WHERE id = $1`, [cur])).rows[0]?.parentId as string | null) ?? null;
        }
        parentId = String(parent.id);
      }
    }
    const updated = (await c.query(`UPDATE drive_folder SET name = $2, "parentId" = $3 WHERE id = $1 RETURNING *`, [folderId, name, parentId])).rows[0]!;
    return packFolder(c, updated, false);
  });
  if (!(res instanceof Response)) await publishToUserStream(env, me, "drive", "folderUpdated", res);
  return res;
};

const foldersDelete: DriveHandler = async (env, body, ctx) => {
  const me = await authUser(env, body, ctx);
  if (!me) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  const folderId = str(body.folderId);
  if (!folderId) return apiErrorResponse(INVALID_PARAM, 400);
  const res = await withHyperdriveClient(hd(env), async (c) => {
    const row = (await c.query(`SELECT id FROM drive_folder WHERE id = $1 AND "userId" = $2`, [folderId, me])).rows[0];
    if (!row) return apiErrorResponse(FOLDER_ERR.deleteNoSuchFolder, 400);
    const n = await c.query(
      `SELECT (SELECT count(*) FROM drive_folder WHERE "parentId" = $1)::int AS folders, (SELECT count(*) FROM drive_file WHERE "folderId" = $1)::int AS files`,
      [folderId],
    );
    if (Number(n.rows[0]?.folders) !== 0 || Number(n.rows[0]?.files) !== 0) return apiErrorResponse(FOLDER_ERR.hasChild, 400);
    await c.query(`DELETE FROM drive_folder WHERE id = $1`, [folderId]);
    return null;
  });
  if (res instanceof Response) return res;
  await publishToUserStream(env, me, "drive", "folderDeleted", folderId);
  return noContent();
};

const foldersFind: DriveHandler = async (env, body, ctx) => {
  const me = await authUser(env, body, ctx);
  if (!me) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  if (typeof body.name !== "string") return apiErrorResponse(INVALID_PARAM, 400);
  const parentId = str(body.parentId) ?? null;
  return withHyperdriveClient(hd(env), async (c) => {
    const rows = (await c.query(
      `SELECT * FROM drive_folder WHERE name = $1 AND "userId" = $2 AND ${parentId ? `"parentId" = $3` : `"parentId" IS NULL`} ORDER BY id DESC`,
      parentId ? [body.name, me, parentId] : [body.name, me],
    )).rows;
    return Promise.all(rows.map((r) => packFolder(c, r, false)));
  });
};

// ---------------------------------------------------------------- registry

export const DRIVE_ENDPOINTS: Record<string, DriveHandler> = {
  drive,
  "drive/files": driveFiles,
  "drive/stream": driveStream,
  "drive/files/create": filesCreate,
  "drive/files/show": filesShow,
  "drive/files/update": filesUpdate,
  "drive/files/delete": filesDelete,
  "drive/files/find": filesFind,
  "drive/files/find-by-hash": filesFindByHash,
  "drive/files/check-existence": filesCheckExistence,
  "drive/files/attached-notes": filesAttachedNotes,
  "drive/files/move-bulk": filesMoveBulk,
  "drive/files/upload-from-url": filesUploadFromUrl,
  "drive/folders": driveFolders,
  "drive/folders/create": foldersCreate,
  "drive/folders/show": foldersShow,
  "drive/folders/update": foldersUpdate,
  "drive/folders/delete": foldersDelete,
  "drive/folders/find": foldersFind,
};

export const driveHandlers: Record<string, DriveHandler> = Object.fromEntries(
  Object.entries(DRIVE_ENDPOINTS).map(([k, h]) => [
    k,
    (async (env, body, ctx) => {
      if (env.HYPERDRIVE?.connectionString && env.MEDIA_BUCKET) return h(env, body, ctx);
      return apiErrorResponse({ message: "Hyperdrive + R2 required.", code: "HYPERDRIVE_UNBOUND", id: "00000000-0000-4000-8000-0000000000b1", kind: "server" }, 501);
    }) satisfies DriveHandler,
  ]),
);
