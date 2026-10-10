import { createHash } from "node:crypto";
import { withHyperdriveClient } from "../pg.js";
import type { ApiEnv } from "../env.js";

export interface DriveFileRow {
  id: string;
  userId: string;
  name: string;
  type: string;
  md5: string;
  size: number;
  comment: string | null;
  folderId: string | null;
  isSensitive: boolean;
  blurhash: string | null;
  properties: Record<string, unknown>;
  url: string;
  thumbnailUrl: string | null;
  accessKey: string | null;
  createdAt: string;
}

/** Decode base64 content body (optional data: URL prefix). */
export function decodeBase64Content(raw: string): Uint8Array {
  const b64 = raw.includes(",") ? raw.slice(raw.indexOf(",") + 1) : raw;
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function md5Hex(bytes: Uint8Array): string {
  return createHash("md5").update(bytes).digest("hex");
}

function rowFromPg(row: Record<string, unknown>): DriveFileRow {
  const props = row.properties;
  return {
    id: String(row.id),
    userId: String(row.userId ?? ""),
    name: String(row.name),
    type: String(row.type),
    md5: String(row.md5),
    size: Number(row.size),
    comment: (row.comment as string | null) ?? null,
    folderId: (row.folderId as string | null) ?? null,
    isSensitive: Boolean(row.isSensitive),
    blurhash: (row.blurhash as string | null) ?? null,
    properties:
      props && typeof props === "object" && !Array.isArray(props)
        ? (props as Record<string, unknown>)
        : {},
    url: String(row.url),
    thumbnailUrl: (row.thumbnailUrl as string | null) ?? null,
    accessKey: (row.accessKey as string | null) ?? null,
    createdAt: new Date().toISOString(),
  };
}

/** Resolve file metadata by public access key (or id fallback). */
export async function findDriveFileByAccessKey(
  env: ApiEnv,
  accessKey: string,
): Promise<DriveFileRow | null> {
  if (!env.HYPERDRIVE?.connectionString) return null;
  return withHyperdriveClient(env.HYPERDRIVE, async (c) => {
    const r = await c.query(
      `SELECT id, "userId", md5, name, type, size, comment, blurhash, properties,
              url, "thumbnailUrl", "accessKey", "isSensitive", "folderId"
       FROM drive_file
       WHERE "accessKey" = $1 OR id = $1
       LIMIT 1`,
      [accessKey],
    );
    const row = r.rows[0];
    return row ? rowFromPg(row) : null;
  });
}

export async function readDriveBytes(
  env: ApiEnv,
  row: DriveFileRow,
): Promise<{ bytes: Uint8Array; type: string } | null> {
  if (!env.MEDIA_BUCKET || !row.accessKey) return null;
  const obj = (await env.MEDIA_BUCKET.get(`drive/${row.accessKey}`)) as {
    arrayBuffer(): Promise<ArrayBuffer>;
    httpMetadata?: { contentType?: string };
  } | null;
  if (!obj) return null;
  const buf = new Uint8Array(await obj.arrayBuffer());
  return {
    bytes: buf,
    type: obj.httpMetadata?.contentType ?? row.type,
  };
}
