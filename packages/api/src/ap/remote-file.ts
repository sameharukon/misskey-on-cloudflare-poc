/**
 * Remote attachments, the download half of upstream ApImageService.createImage →
 * DriveService.uploadFromUrl / addFile. The inbox registers each attachment as a link row at
 * once (remote-note.ts) and enqueues a `remoteFile` job on `mk-jobs`; the job downloads the file
 * and fills md5, the detected type, the file name and the image properties. When
 * meta.cacheRemoteFiles is on (and the file is not sensitive, unless cacheRemoteSensitiveFiles),
 * the original goes to R2 with its thumbnail / webpublic like a local upload and the row stops
 * being a link; a remote user over its driveCapacityMb has its oldest cached files expired back
 * to links (DriveService.expireOldFile). A link only gets the blurhash from the media container.
 *
 * Differences: upstream downloads before the note is created (a failed download fails the note);
 * here the note keeps the link and the job retries transient errors. Upstream's md5 dedupe per
 * user is not applied (link rows are already reused per uri).
 */

import { serverMaxFileSize } from "../file-size.js";
import { BodyTooLargeError, fetchChecked, readCapped, REMOTE_DOWNLOAD_TIMEOUT_MS, UnsafeUrlError } from "../safe-fetch.js";
import { isSafeRemoteUrl } from "../../../ap/src/index.js";
import type { ApiEnv } from "../env.js";
import { withHyperdriveClient, type PgQueryable } from "../pg.js";
import { md5Hex } from "../drive/files.js";
import { correctFilename, detectType, isAllowedType, probeImage, PROBED_IMAGE_TYPES, validateFileName } from "../drive/media.js";
import { ApPermanentError } from "./remote.js";
import { metaRowPg } from "../user-lite-pg.js";
import { enqueueJob } from "../queues/jobs-queue.js";

type Row = Record<string, unknown>;

export type RemoteFileJob = { kind: "remoteFile"; fileId: string };

/** Queue the download (inline without the mk-jobs binding; failures are logged, never thrown). */
export async function enqueueRemoteFile(env: ApiEnv, fileId: string): Promise<void> {
  const job: RemoteFileJob = { kind: "remoteFile", fileId };
  if (env.Q_JOBS) {
    await enqueueJob(env, job);
    return;
  }
  try {
    await runRemoteFileJob(env, job);
  } catch (e) {
    console.warn(`remote file ${fileId}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** The server limit (MAX_FILE_SIZE, 100 MB by default): the file is held in memory. */
const maxSize = serverMaxFileSize;

async function download(env: ApiEnv, url: string): Promise<Uint8Array> {
  if (!isSafeRemoteUrl(url)) throw new ApPermanentError("unsafe url");
  const max = maxSize(env);
  const { res } = await fetchChecked(env.AP_FETCH ?? fetch, url, { headers: { "User-Agent": "misskey-cf" }, signal: AbortSignal.timeout(REMOTE_DOWNLOAD_TIMEOUT_MS) }, { check: (u) => isSafeRemoteUrl(u.href) }).catch((e) => {
    throw e instanceof UnsafeUrlError ? new ApPermanentError("unsafe url") : e;
  });
  if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) throw new ApPermanentError(`download ${res.status}`);
  if (!res.ok || !res.body) throw new Error(`download ${res.status}`);
  return readCapped(res, max).catch((e) => {
    throw e instanceof BodyTooLargeError ? new ApPermanentError("too large") : e;
  });
}

function baseUrl(env: ApiEnv): string {
  return (env.INSTANCE_URL ?? "https://misskey.local").replace(/\/$/, "");
}

/** DriveService.expireOldFile: cached files (newest kept) beyond `capacity` turn back into links. */
async function expireOldFiles(env: ApiEnv, c: PgQueryable, userId: string, capacity: number): Promise<void> {
  const u = (await c.query(`SELECT "avatarId", "bannerId" FROM "user" WHERE id = $1`, [userId])).rows[0] ?? {};
  const files = (await c.query(
    `SELECT f.*, SUM(f.size) OVER (ORDER BY f.id DESC ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS acc_usage
     FROM drive_file f WHERE f."userId" = $1 AND f."isLink" = FALSE AND f.id IS DISTINCT FROM $2 AND f.id IS DISTINCT FROM $3 ORDER BY f.id ASC`,
    [userId, u.avatarId ?? null, u.bannerId ?? null],
  )).rows;
  const { deleteObjects } = await import("../drive-pg.js");
  for (const f of files.filter((x) => Number(x.acc_usage) > capacity)) {
    await deleteObjects(env, f);
    // deletePostProcess(isExpired): a remote file with a uri becomes a direct link
    if (f.uri != null) {
      await c.query(
        `UPDATE drive_file SET "isLink" = TRUE, url = uri, "thumbnailUrl" = NULL, "webpublicUrl" = NULL, "storedInternal" = FALSE,
           "accessKey" = $2, "thumbnailAccessKey" = $3, "webpublicAccessKey" = $4 WHERE id = $1`,
        [f.id, crypto.randomUUID(), `thumbnail-${crypto.randomUUID()}`, `webpublic-${crypto.randomUUID()}`],
      );
    } else {
      await c.query(`DELETE FROM drive_file WHERE id = $1`, [f.id]);
    }
  }
}

/** The detected type differs from the federated mediaType: refresh the author's notes' attachedFileTypes. */
async function syncAttachedFileTypes(env: ApiEnv, row: Row, type: string): Promise<void> {
  if (type === row.type) return;
  await withHyperdriveClient(env.HYPERDRIVE!, (c) =>
    c.query(
      `UPDATE note n SET "attachedFileTypes" = ARRAY(
         SELECT COALESCE(f.type, '') FROM unnest(n."fileIds") WITH ORDINALITY AS x(id, ord) LEFT JOIN drive_file f ON f.id = x.id ORDER BY x.ord)
       WHERE n."userId" = $1 AND n."fileIds" @> ARRAY[$2]::varchar[]`,
      [row.userId, row.id],
    ),
  );
}

/** `remoteFile` job: download, then fill the link row or cache the file. */
export async function runRemoteFileJob(env: ApiEnv, job: RemoteFileJob): Promise<void> {
  const prep = await withHyperdriveClient(env.HYPERDRIVE!, async (c) => {
    const row = (await c.query(`SELECT * FROM drive_file WHERE id = $1`, [job.fileId])).rows[0] as Row | undefined;
    if (!row || !row.isLink || row.userHost == null || typeof row.uri !== "string" || row.md5 !== "") return null;
    const m = await metaRowPg(c);
    // Meta defaults: cacheRemoteFiles false, cacheRemoteSensitiveFiles true
    const cache = m.cacheRemoteFiles === true && (m.cacheRemoteSensitiveFiles !== false || !row.isSensitive);
    return { row, cache };
  });
  if (!prep) return;
  const { row } = prep;
  const bytes = await download(env, String(row.uri));

  const detected = detectType(bytes);
  const type = detected.mime === "application/octet-stream" ? String(row.type) : detected.mime;
  const md5 = md5Hex(bytes);
  const name = correctFilename(validateFileName(String(row.name)) ? String(row.name) : "untitled", detected.ext);
  const properties: Record<string, number> = {};
  if (PROBED_IMAGE_TYPES.includes(type)) {
    const p = probeImage(bytes, type);
    if (p?.width && p.height) {
      properties.width = p.width;
      properties.height = p.height;
      if (p.orientation != null) properties.orientation = p.orientation;
    }
  }

  const { requestAlts, applyAlts } = await import("../drive-pg.js");
  let cache = prep.cache && Boolean(env.MEDIA_BUCKET);
  if (cache) {
    // addFile's checks for a non-link file of a remote user: uploadableFileTypes (a refusal keeps the
    // link), then driveCapacityMb (over it, expire the oldest cached files)
    cache = await withHyperdriveClient(env.HYPERDRIVE!, async (c) => {
      const { getUserPoliciesPg } = await import("../policies-pg.js");
      const policies = await getUserPoliciesPg(env, c, String(row.userId));
      const allowed = Array.isArray(policies.uploadableFileTypes) ? (policies.uploadableFileTypes as string[]) : [];
      if (!isAllowedType(allowed, type)) return false;
      const capacity = 1024 * 1024 * Number(policies.driveCapacityMb ?? 100);
      const usage = Number((await c.query(`SELECT COALESCE(SUM(size), 0)::bigint AS s FROM drive_file WHERE "userId" = $1 AND "isLink" = FALSE`, [row.userId])).rows[0]?.s ?? 0);
      if (capacity < usage + bytes.byteLength) await expireOldFiles(env, c, String(row.userId), capacity - bytes.byteLength);
      return true;
    });
  }

  if (cache) {
    const accessKey = crypto.randomUUID();
    await env.MEDIA_BUCKET!.put(`drive/${accessKey}`, bytes, {
      httpMetadata: { contentType: type },
      customMetadata: { fileId: String(row.id), userId: String(row.userId), role: "original" },
    });
    await withHyperdriveClient(env.HYPERDRIVE!, (c) =>
      c.query(
        `UPDATE drive_file SET md5 = $2, type = $3, name = $4, size = $5, properties = properties || $6::jsonb, "isLink" = FALSE, "storedInternal" = FALSE,
           url = $7, "accessKey" = $8, "thumbnailUrl" = NULL, "thumbnailAccessKey" = NULL, "webpublicUrl" = NULL, "webpublicAccessKey" = NULL
         WHERE id = $1`,
        [row.id, md5, type, name, bytes.byteLength, JSON.stringify(properties), `${baseUrl(env)}/files/${accessKey}`, accessKey],
      ),
    );
    await syncAttachedFileTypes(env, row, type);
    try {
      const alts = await requestAlts(env, bytes, type, true);
      if (alts) await applyAlts(env, String(row.id), alts);
    } catch (e) {
      console.warn(`remote file alts ${row.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
    await syncUserImageBlurhash(env, String(row.id));
    return;
  }

  // a link: size stays 0 (upstream), the rest comes from the downloaded bytes
  let blurhash: string | null = null;
  try {
    blurhash = (await requestAlts(env, bytes, type, false))?.blurhash ?? null;
  } catch (e) {
    console.warn(`remote file blurhash ${row.id}: ${e instanceof Error ? e.message : String(e)}`);
  }
  await withHyperdriveClient(env.HYPERDRIVE!, (c) =>
    c.query(`UPDATE drive_file SET md5 = $2, type = $3, name = $4, properties = properties || $5::jsonb, blurhash = $6 WHERE id = $1`, [
      row.id, md5, type, name, JSON.stringify(properties), blurhash,
    ]),
  );
  await syncAttachedFileTypes(env, row, type);
  await syncUserImageBlurhash(env, String(row.id));
}

/** The file is a user's avatar or banner: copy its blurhash to the user (upstream sets both together). */
async function syncUserImageBlurhash(env: ApiEnv, fileId: string): Promise<void> {
  await withHyperdriveClient(env.HYPERDRIVE!, async (c) => {
    await c.query(`UPDATE "user" u SET "avatarBlurhash" = f.blurhash FROM drive_file f WHERE f.id = $1 AND u."avatarId" = f.id`, [fileId]);
    await c.query(`UPDATE "user" u SET "bannerBlurhash" = f.blurhash FROM drive_file f WHERE f.id = $1 AND u."bannerId" = f.id`, [fileId]);
  });
}
