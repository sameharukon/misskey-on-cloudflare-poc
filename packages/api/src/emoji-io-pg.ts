/**
 * Custom emoji import / export / copy and the v2 admin list:
 * - `export-custom-emojis`: `exportCustomEmojis` job on `mk-jobs` (ExportCustomEmojisProcessorService):
 *   zip of the local emoji images + meta.json (metaVersion 2) in the caller's drive, `exportCompleted`
 *   notification with exportedEntity 'customEmoji'.
 * - `admin/emoji/import-zip`: `importCustomEmojis` job (ImportCustomEmojisProcessorService): reads
 *   meta.json, replaces same-name local emojis like upstream, in bounded steps of IMPORT_BATCH entries.
 * - `admin/emoji/copy`: download a (remote) emoji image into a user-less drive file and add it locally.
 * - `v2/admin/emoji/list`: CustomEmojiService.fetchEmojis filters / sort keys / page + packDetailedAdmin.
 *
 * Images under our own `/files/` URLs are read from R2 in-process (a Worker's fetch to its own
 * hostname bypasses the Worker); other URLs are fetched with a size cap.
 */

import { fetchChecked } from "./safe-fetch.js";
import { genAidx } from "../../id/src/index.js";
import type { ApiEnv } from "./env.js";
import { apiErrorResponse, CREDENTIAL_REQUIRED, INTERNAL_ERROR, type ApiErrorBody } from "./errors.js";
import { authenticatePg, extractToken } from "./auth-pg.js";
import { withHyperdriveClient, type PgQueryable } from "./pg.js";
import { buildPackConfig } from "./meta-source.js";
import { addFilePg, applyAlts, ALTS_SYNC_TIMEOUT_MS, requestAlts, serverMaxFileSize } from "./drive-pg.js";
import { correctFilename, detectType, probeImage, PROBED_IMAGE_TYPES, validateFileName } from "./drive/media.js";
import { md5Hex } from "./drive/files.js";
import { createNotification } from "./notifications-do.js";
import { addEmojiPg, gated } from "./emojis-pg.js";
import { likeEscape } from "./clips-pg.js";
import { buildZip, readZip } from "./zip.js";
import { adminGate } from "./admin-gate.js";
import { clientError as err, hd, invalidParam as bad } from "./handler-kit.js";
import { enqueueJob } from "./queues/jobs-queue.js";

type Ctx = { hasCredential: boolean; request: Request; waitUntil?: (p: Promise<unknown>) => void };
type Body = Record<string, unknown>;
type Handler = (env: ApiEnv, body: Body, ctx: Ctx) => Promise<Response | unknown>;
type Row = Record<string, unknown>;

export type ExportCustomEmojisJob = { kind: "exportCustomEmojis"; userId: string };
export type ImportCustomEmojisJob = { kind: "importCustomEmojis"; userId: string; fileId: string; cursor?: number };

const noContent = () => new Response(null, { status: 204 });
const HD_UNBOUND: ApiErrorBody = { message: "Hyperdrive required.", code: "HYPERDRIVE_UNBOUND", id: "00000000-0000-4000-8000-0000000000b1", kind: "server" };

const COPY_E = {
  noSuchEmoji: err("NO_SUCH_EMOJI", "e2785b66-dca3-4087-9cac-b93c541cc425", "No such emoji."),
  duplicateName: err("DUPLICATE_NAME", "f7a3462c-4e6e-4069-8421-b9bd4f4c3975", "Duplicate name."),
};

// ImportCustomEmojisProcessorService limits
const MAX_META_JSON_SIZE = 64 * 1024 * 1024;
const MAX_EMOJI_FILE_SIZE = 32 * 1024 * 1024;
const MAX_NAME_LENGTH = 255;
const FILE_NAME_PATTERN = /^[a-zA-Z0-9_]+(\.[a-zA-Z0-9]+)*$/;
const EMOJI_NAME_PATTERN = /^[a-zA-Z0-9_]+$/;
/** zip entries imported per mk-jobs message */
export let IMPORT_BATCH = 20;
export function setImportBatchForTest(n: number): void {
  IMPORT_BATCH = n;
}

/** mime.extension() of the image types an emoji can have (mime-types' first extension). */
const MIME_EXT: Record<string, string> = {
  "image/png": "png", "image/gif": "gif", "image/jpeg": "jpeg", "image/webp": "webp", "image/avif": "avif", "image/apng": "apng",
  "image/bmp": "bmp", "image/tiff": "tif", "image/x-icon": "ico", "image/vnd.microsoft.icon": "ico", "image/svg+xml": "svg",
};

function baseUrl(env: ApiEnv): string {
  return (env.INSTANCE_URL ?? "https://misskey.local").replace(/\/$/, "");
}

/** dateFormat(new Date(), 'yyyy-MM-dd-HH-mm-ss') */
function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

// ---------------------------------------------------------------- download / store

/** DownloadService.downloadUrl into memory: own `/files/<key>` from R2, anything else over HTTP(S). */
export async function downloadBytes(env: ApiEnv, url: string, max = serverMaxFileSize(env)): Promise<Uint8Array> {
  const target = new URL(url);
  if (target.protocol !== "https:" && target.protocol !== "http:") throw new Error("unsupported protocol");
  const own = target.origin === new URL(baseUrl(env)).origin ? /^\/files\/([^/]+)$/.exec(target.pathname) : null;
  if (own) {
    const obj = await env.MEDIA_BUCKET?.get(`drive/${decodeURIComponent(own[1]!)}`);
    if (!obj) throw new Error("no such file");
    const bytes = new Uint8Array(await obj.arrayBuffer());
    if (bytes.byteLength > max) throw new Error("too large");
    return bytes;
  }
  const { res } = await fetchChecked(env.AP_FETCH ?? fetch, url, { headers: { "user-agent": "misskey-cf (custom emoji)" } }); // hops checked
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
  const out = new Uint8Array(total);
  let off = 0;
  for (const ch of chunks) {
    out.set(ch, off);
    off += ch.byteLength;
  }
  return out;
}

/**
 * DriveService.addFile({ user: null, force: true }): a user-less (system) drive file, so no drive
 * policies / capacity apply. Thumbnail / webpublic come from the media container when bound
 * (bounded wait with `waitUntil`, otherwise awaited).
 */
export async function addSystemFilePg(env: ApiEnv, bytes: Uint8Array, name: string | null, waitUntil?: (p: Promise<unknown>) => void): Promise<Row> {
  if (bytes.byteLength > serverMaxFileSize(env)) throw new Error("too large");
  const info = detectType(bytes);
  const fileName = correctFilename(name && validateFileName(name) ? name : "untitled", info.ext);
  const properties: Record<string, unknown> = {};
  if (PROBED_IMAGE_TYPES.includes(info.mime)) {
    const p = probeImage(bytes, info.mime);
    if (p && p.width && p.height) {
      properties.width = p.width;
      properties.height = p.height;
      if (p.orientation != null) properties.orientation = p.orientation;
    }
  }
  const id = genAidx(Date.now());
  const accessKey = crypto.randomUUID();
  const url = `${baseUrl(env)}/files/${accessKey}`;
  await env.MEDIA_BUCKET!.put(`drive/${accessKey}`, bytes, { httpMetadata: { contentType: info.mime }, customMetadata: { fileId: id, role: "original" } });
  let row = await withHyperdriveClient(hd(env), async (c) =>
    (await c.query(
      `INSERT INTO drive_file (
         id, "userId", "userHost", md5, name, type, size, comment, blurhash, properties,
         "storedInternal", url, "thumbnailUrl", "webpublicUrl", "accessKey", "thumbnailAccessKey",
         "webpublicAccessKey", uri, "isSensitive", "folderId", "isLink"
       ) VALUES ($1, NULL, NULL, $2, $3, $4, $5, NULL, NULL, $6::jsonb, FALSE, $7, NULL, NULL, $8, NULL, NULL, NULL, FALSE, NULL, FALSE)
       RETURNING *`,
      [id, md5Hex(bytes), fileName, info.mime, bytes.byteLength, JSON.stringify(properties), url, accessKey],
    )).rows[0]!,
  );
  const work = requestAlts(env, bytes, info.mime, true)
    .then((alts) => (alts ? applyAlts(env, id, alts) : null))
    .catch((e) => {
      console.warn(`drive alts failed for ${id}: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    });
  if (!waitUntil) {
    row = (await work) ?? row;
    return row;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((r) => {
    timer = setTimeout(() => r("timeout"), ALTS_SYNC_TIMEOUT_MS);
  });
  const done = await Promise.race([work, timeout]);
  if (timer) clearTimeout(timer);
  if (done === "timeout") waitUntil(work);
  else if (done) row = done;
  return row;
}

// ---------------------------------------------------------------- export

/** MiEmoji as TypeORM serializes it (meta.json `emoji`). */
function rawEmoji(e: Row): Row {
  return {
    id: e.id,
    updatedAt: e.updatedAt ? new Date(String(e.updatedAt)).toISOString() : null,
    name: e.name,
    host: e.host ?? null,
    category: e.category ?? null,
    originalUrl: e.originalUrl,
    publicUrl: e.publicUrl,
    uri: e.uri ?? null,
    type: e.type ?? null,
    aliases: e.aliases ?? [],
    license: e.license ?? null,
    localOnly: Boolean(e.localOnly),
    isSensitive: Boolean(e.isSensitive),
    roleIdsThatCanBeUsedThisEmojiAsReaction: e.roleIdsThatCanBeUsedThisEmojiAsReaction ?? [],
  };
}

/** ExportCustomEmojisProcessorService.process. Returns the drive file id (null when the user is gone). */
export async function runExportCustomEmojis(env: ApiEnv, job: ExportCustomEmojisJob): Promise<string | null> {
  const emojis = await withHyperdriveClient(hd(env), async (c) => {
    if (!(await c.query(`SELECT 1 AS ok FROM "user" WHERE id = $1`, [job.userId])).rows.length) return null;
    return (await c.query(`SELECT * FROM emoji WHERE host IS NULL ORDER BY id ASC`)).rows;
  });
  if (!emojis) return null;
  const files: { name: string; data: Uint8Array }[] = [];
  const records: string[] = [];
  for (const emoji of emojis) {
    const name = String(emoji.name);
    if (!EMOJI_NAME_PATTERN.test(name)) {
      console.warn(`export-custom-emojis: invalid emoji name: ${name}`);
      continue;
    }
    const ext = MIME_EXT[String(emoji.type ?? "image/png")];
    const fileName = name + (ext ? `.${ext}` : "");
    let downloaded = false;
    try {
      files.push({ name: fileName, data: await downloadBytes(env, String(emoji.originalUrl)) });
      downloaded = true;
    } catch (e) {
      console.warn(`export-custom-emojis: ${fileName}: ${e instanceof Error ? e.message : String(e)}`);
    }
    records.push(JSON.stringify({ fileName, downloaded, emoji: rawEmoji(emoji) }));
  }
  const meta = `{"metaVersion":2,"host":"${buildPackConfig(env).host}","exportedAt":"${new Date().toString()}","emojis":[${records.join(",\n")}]}`;
  const zip = buildZip([{ name: "meta.json", data: new TextEncoder().encode(meta) }, ...files]);
  let row: Row;
  try {
    row = await addFilePg(env, {
      userId: job.userId,
      bytes: zip,
      name: `custom-emojis-${stamp()}.zip`,
      force: true,
      typeHint: { mime: "application/zip", ext: "zip" },
    });
  } catch (e) {
    // drive policy refusals (DriveError with an API error body; upstream's job fails the same way)
    // are not worth a queue retry; anything else is rethrown
    if (!(e instanceof Error && "body" in e)) throw e;
    console.warn(`export-custom-emojis: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
  const fileId = String(row.id);
  await createNotification(env, job.userId, { type: "exportCompleted", notifierId: null, exportedEntity: "customEmoji", fileId });
  return fileId;
}

// ---------------------------------------------------------------- import

type EmojiRecord = {
  fileName: string;
  downloaded: boolean;
  emoji: { name: string; category: string | null; aliases: string[]; license: string | null; isSensitive: boolean; localOnly: boolean };
};

const isValidName = (v: unknown, re: RegExp): v is string => typeof v === "string" && v.length <= MAX_NAME_LENGTH && re.test(v);
const truncate = (v: unknown) => {
  const t = typeof v === "string" ? v : (JSON.stringify(v) ?? String(v));
  return t.length > MAX_NAME_LENGTH ? `${t.slice(0, MAX_NAME_LENGTH)}...` : t;
};

/**
 * ImportCustomEmojisProcessorService.process, one bounded step: entries referenced by meta.json are
 * taken in zip order, IMPORT_BATCH of them per step; the follow-up job carries the cursor.
 */
export async function runImportCustomEmojis(env: ApiEnv, job: ImportCustomEmojisJob): Promise<ImportCustomEmojisJob | null> {
  const file = await withHyperdriveClient(hd(env), async (c) =>
    (await c.query(`SELECT id, url FROM drive_file WHERE id = $1`, [job.fileId])).rows[0],
  );
  if (!file) return null;
  const entries = readZip(await downloadBytes(env, String(file.url)));
  const metaEntry = entries.find((e) => e.name === "meta.json");
  if (!metaEntry) {
    console.warn("import-custom-emojis: meta.json not found in the archive");
    return null;
  }
  if (metaEntry.size > MAX_META_JSON_SIZE) throw new Error("import-custom-emojis: meta.json too large");
  const meta = JSON.parse(new TextDecoder().decode(await metaEntry.read())) as { emojis?: EmojiRecord[] };

  const wanted = new Map<string, EmojiRecord[]>();
  for (const record of meta.emojis ?? []) {
    if (!record?.downloaded) continue;
    if (!isValidName(record.fileName, FILE_NAME_PATTERN)) {
      if (!job.cursor) console.warn(`import-custom-emojis: invalid filename: ${truncate(record.fileName)}`);
      continue;
    }
    if (!isValidName(record.emoji?.name, EMOJI_NAME_PATTERN)) {
      if (!job.cursor) console.warn(`import-custom-emojis: invalid emojiname: ${truncate(record.emoji?.name)}`);
      continue;
    }
    const list = wanted.get(record.fileName);
    if (list) list.push(record);
    else wanted.set(record.fileName, [record]);
  }
  // referenced entries in zip order (first occurrence of a name only, as upstream)
  const ordered: { entry: (typeof entries)[number]; records: EmojiRecord[] }[] = [];
  for (const entry of entries) {
    const records = wanted.get(entry.name);
    if (!records) continue;
    wanted.delete(entry.name);
    ordered.push({ entry, records });
  }
  const start = job.cursor ?? 0;
  const end = Math.min(ordered.length, start + IMPORT_BATCH);
  const pending: Promise<unknown>[] = [];
  const waitUntil = (p: Promise<unknown>) => void pending.push(p);
  for (const { entry, records } of ordered.slice(start, end)) {
    let bytes: Uint8Array;
    try {
      if (entry.size > MAX_EMOJI_FILE_SIZE) throw new Error("too large");
      bytes = await entry.read();
      if (bytes.byteLength > MAX_EMOJI_FILE_SIZE) throw new Error("too large");
    } catch (e) {
      console.warn(`import-custom-emojis: couldn't extract ${entry.name}: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    for (const record of records) {
      const info = record.emoji;
      try {
        await withHyperdriveClient(hd(env), (c) => c.query(`DELETE FROM emoji WHERE name = $1 AND host IS NULL`, [info.name]));
        const drive = await addSystemFilePg(env, bytes, record.fileName);
        await withHyperdriveClient(hd(env), (c) =>
          addEmojiPg(env, c, {
            name: info.name,
            category: info.category ?? null,
            aliases: Array.isArray(info.aliases) ? info.aliases.map(String) : [],
            originalUrl: String(drive.url),
            publicUrl: String(drive.webpublicUrl ?? drive.url),
            fileType: String(drive.webpublicType ?? drive.type),
            license: info.license ?? null,
            isSensitive: Boolean(info.isSensitive),
            localOnly: Boolean(info.localOnly),
            roleIdsThatCanBeUsedThisEmojiAsReaction: [],
          }, null, waitUntil),
        );
      } catch (e) {
        console.warn(`import-custom-emojis: couldn't import ${record.fileName} for ${info.name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
  await Promise.all(pending);
  if (end < ordered.length) return { ...job, cursor: end };
  for (const name of wanted.keys()) console.warn(`import-custom-emojis: file not found in the archive: ${name}`);
  return null;
}

// ---------------------------------------------------------------- endpoints

async function enqueue(env: ApiEnv, job: ExportCustomEmojisJob | ImportCustomEmojisJob): Promise<void> {
  if (env.Q_JOBS) {
    await enqueueJob(env, job);
    return;
  }
  if (job.kind === "exportCustomEmojis") await runExportCustomEmojis(env, job);
  else {
    let next: ImportCustomEmojisJob | null = job;
    while (next) next = await runImportCustomEmojis(env, next);
  }
}

const exportCustomEmojis: Handler = async (env, body, ctx) => {
  if (!env.HYPERDRIVE?.connectionString) return apiErrorResponse(HD_UNBOUND, 501);
  if (!ctx.hasCredential) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  const token = extractToken(ctx.request, body);
  const me = token ? ((await authenticatePg(env, token))?.user.id ?? null) : null;
  if (!me) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  await enqueue(env, { kind: "exportCustomEmojis", userId: me });
  return noContent();
};

const importZip: Handler = async (env, body, ctx) => {
  if (!env.HYPERDRIVE?.connectionString) return apiErrorResponse(HD_UNBOUND, 501);
  const denied = await adminGate(ctx.request, env as never, body, "admin");
  if (denied) return denied;
  if (typeof body.fileId !== "string") return bad();
  const token = extractToken(ctx.request, body);
  const me = token ? ((await authenticatePg(env, token))?.user.id ?? null) : null;
  if (!me) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  await enqueue(env, { kind: "importCustomEmojis", userId: me, fileId: body.fileId });
  return noContent();
};

const copy = gated(async (env, body, ctx, me, c) => {
  if (typeof body.emojiId !== "string") return bad();
  const emoji = (await c.query(`SELECT * FROM emoji WHERE id = $1`, [body.emojiId])).rows[0];
  if (!emoji) return apiErrorResponse(COPY_E.noSuchEmoji, 400);
  let drive: Row;
  try {
    const url = String(emoji.originalUrl);
    let name: string | null = null;
    try {
      name = decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "") || null;
    } catch {
      name = null;
    }
    drive = await addSystemFilePg(env, await downloadBytes(env, url), name, ctx.waitUntil);
  } catch (e) {
    console.warn(`admin/emoji/copy: ${e instanceof Error ? e.message : String(e)}`);
    return apiErrorResponse(INTERNAL_ERROR, 500);
  }
  if ((await c.query(`SELECT 1 AS ok FROM emoji WHERE name = $1 AND host IS NULL`, [emoji.name])).rows.length) {
    return apiErrorResponse(COPY_E.duplicateName, 400);
  }
  return addEmojiPg(env, c, {
    name: String(emoji.name),
    category: (emoji.category as string | null) ?? null,
    aliases: (emoji.aliases as string[] | null) ?? [],
    originalUrl: String(drive.url),
    publicUrl: String(drive.webpublicUrl ?? drive.url),
    fileType: String(drive.webpublicType ?? drive.type),
    license: (emoji.license as string | null) ?? null,
    isSensitive: Boolean(emoji.isSensitive),
    localOnly: Boolean(emoji.localOnly),
    roleIdsThatCanBeUsedThisEmojiAsReaction: (emoji.roleIdsThatCanBeUsedThisEmojiAsReaction as string[] | null) ?? [],
  }, me, ctx.waitUntil);
});

// ---------------------------------------------------------------- v2/admin/emoji/list

export const FETCH_EMOJIS_HOST_TYPES = ["local", "remote", "all"] as const;
const SORT_COLUMNS = ["id", "updatedAt", "name", "host", "uri", "publicUrl", "type", "aliases", "category", "license", "isSensitive", "localOnly", "roleIdsThatCanBeUsedThisEmojiAsReaction"];
export const FETCH_EMOJIS_SORT_KEYS = SORT_COLUMNS.flatMap((k) => [`+${k}`, `-${k}`]);

const QUERY_STR = ["updatedAtFrom", "updatedAtTo", "name", "host", "uri", "publicUrl", "originalUrl", "type", "aliases", "category", "license"];
const isInt = (v: unknown) => typeof v === "number" && Number.isInteger(v);

/** EmojiEntityService.packDetailedAdminMany */
async function packDetailedAdminMany(c: PgQueryable, rows: Row[]): Promise<Row[]> {
  const roleIds = [...new Set(rows.flatMap((r) => (r.roleIdsThatCanBeUsedThisEmojiAsReaction as string[] | null) ?? []))];
  const roles = roleIds.length
    ? new Map((await c.query(`SELECT id, name, "displayOrder" FROM role WHERE id = ANY($1::varchar[])`, [roleIds])).rows.map((r) => [String(r.id), r]))
    : new Map<string, Row>();
  return rows.map((e) => ({
    id: e.id,
    updatedAt: e.updatedAt ? new Date(String(e.updatedAt)).toISOString() : null,
    name: e.name,
    host: e.host ?? null,
    uri: e.uri ?? null,
    type: e.type ?? null,
    aliases: e.aliases ?? [],
    category: e.category ?? null,
    publicUrl: e.publicUrl,
    originalUrl: e.originalUrl,
    license: e.license ?? null,
    localOnly: Boolean(e.localOnly),
    isSensitive: Boolean(e.isSensitive),
    roleIdsThatCanBeUsedThisEmojiAsReaction: ((e.roleIdsThatCanBeUsedThisEmojiAsReaction as string[] | null) ?? [])
      .filter((id) => roles.has(id))
      .map((id) => roles.get(id)!)
      .sort((a, b) => (Number(a.displayOrder) !== Number(b.displayOrder) ? Number(b.displayOrder) - Number(a.displayOrder) : String(a.id).localeCompare(String(b.id))))
      .map((r) => ({ id: r.id, name: r.name })),
  }));
}

const v2List = gated(async (_env, body, _ctx, _me, c) => {
  const q = body.query;
  if (q !== undefined && q !== null && (typeof q !== "object" || Array.isArray(q))) return bad();
  const query = (q ?? null) as Body | null;
  if (query) {
    for (const k of QUERY_STR) if (query[k] !== undefined && typeof query[k] !== "string") return bad();
    for (const k of ["isSensitive", "localOnly"]) if (query[k] !== undefined && typeof query[k] !== "boolean") return bad();
    if (query.hostType !== undefined && !(FETCH_EMOJIS_HOST_TYPES as readonly unknown[]).includes(query.hostType)) return bad();
    if (query.roleIds !== undefined && !(Array.isArray(query.roleIds) && query.roleIds.every((x) => typeof x === "string"))) return bad();
  }
  for (const k of ["sinceId", "untilId"]) if (body[k] !== undefined && typeof body[k] !== "string") return bad();
  for (const k of ["sinceDate", "untilDate", "page"]) if (body[k] !== undefined && !isInt(body[k])) return bad();
  if (body.limit !== undefined && (!isInt(body.limit) || (body.limit as number) < 1 || (body.limit as number) > 100)) return bad();
  if (body.sortKeys !== undefined && !(Array.isArray(body.sortKeys) && body.sortKeys.every((k) => FETCH_EMOJIS_SORT_KEYS.includes(k as string)))) return bad();
  const limit = (body.limit as number | undefined) ?? 10;
  const sortKeys = (body.sortKeys as string[] | undefined) ?? ["-id"];
  const untilId = (body.untilId as string | undefined) ?? (body.untilDate ? genAidx(body.untilDate as number) : undefined);
  const sinceId = (body.sinceId as string | undefined) ?? (body.sinceDate ? genAidx(body.sinceDate as number) : undefined);

  const params: unknown[] = [];
  const where: string[] = [];
  const add = (v: unknown) => (params.push(v), `$${params.length}`);
  /** multipleWordsToQuery */
  const words = (s: string) => s.split(/\s/).filter((x) => x.length > 0).map((x) => `%${likeEscape(x)}%`);
  const anyLike = (col: string, s: string) => where.push(`${col} ~~ ANY(${add(words(s))}::varchar[])`);
  if (query) {
    if (query.updatedAtFrom) where.push(`CAST(e."updatedAt" AS DATE) >= ${add(query.updatedAtFrom)}::date`);
    if (query.updatedAtTo) where.push(`CAST(e."updatedAt" AS DATE) <= ${add(query.updatedAtTo)}::date`);
    if (query.name) anyLike("e.name", query.name as string);
    const hostType = (query.hostType as string | undefined) ?? "all";
    if (hostType === "local") where.push("e.host IS NULL");
    else if (hostType === "remote") {
      if (query.host) anyLike("e.host", query.host as string);
      else where.push("e.host IS NOT NULL");
    }
    if (query.uri) anyLike("e.uri", query.uri as string);
    if (query.publicUrl) anyLike(`e."publicUrl"`, query.publicUrl as string);
    if (query.type) anyLike("e.type", query.type as string);
    if (query.aliases) where.push(`(SELECT COUNT(0) FROM unnest(e.aliases) AS a(alias) WHERE a.alias ~~ ANY(${add(words(query.aliases as string))}::varchar[])) > 0`);
    if (query.category) anyLike("e.category", query.category as string);
    if (query.license) anyLike("e.license", query.license as string);
    if (query.isSensitive != null) where.push(`e."isSensitive" = ${add(query.isSensitive)}`);
    if (query.localOnly != null) where.push(`e."localOnly" = ${add(query.localOnly)}`);
    const roleIds = query.roleIds as string[] | undefined;
    if (roleIds && roleIds.length > 0) where.push(`e."roleIdsThatCanBeUsedThisEmojiAsReaction" && ${add(roleIds)}::varchar[]`);
  }
  if (sinceId) where.push(`e.id > ${add(sinceId)}`);
  if (untilId) where.push(`e.id < ${add(untilId)}`);
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const order = sortKeys.length
    ? sortKeys.map((k) => `e."${k.slice(1)}" ${k.startsWith("-") ? "DESC" : "ASC"}`).join(", ")
    : `e.id DESC`;
  // as upstream: only the requested keys (no id tiebreak)
  const page = body.page as number | undefined;
  const offset = page ? Math.max(0, (page - 1) * limit) : 0;
  const allCount = Number((await c.query(`SELECT count(*)::int AS n FROM emoji e ${whereSql}`, params)).rows[0]?.n ?? 0);
  const rows = (await c.query(`SELECT e.* FROM emoji e ${whereSql} ORDER BY ${order} LIMIT ${limit} OFFSET ${offset}`, params)).rows;
  return {
    emojis: await packDetailedAdminMany(c, rows),
    count: allCount > limit ? rows.length : allCount,
    allCount,
    allPages: Math.ceil(allCount / limit),
  };
});

export const emojiIoHandlers: Record<string, Handler> = {
  "export-custom-emojis": exportCustomEmojis,
  "admin/emoji/import-zip": importZip,
  "admin/emoji/copy": copy,
  "v2/admin/emoji/list": v2List,
};

