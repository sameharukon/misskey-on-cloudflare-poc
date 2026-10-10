/** Pure DriveFile packer (upstream DriveFileEntityService.pack for local files). */
import { parseAidxTime } from "../../../id/src/index.js";
import { isMimeImage } from "./media.js";

type Row = Record<string, unknown>;

export function publicProperties(p: Record<string, unknown>): Record<string, unknown> {
  if (p.orientation == null) return p;
  const out = { ...p };
  if (Number(p.orientation) >= 5) [out.width, out.height] = [p.height, p.width];
  delete out.orientation;
  return out;
}

/** DriveFileEntityService.getThumbnailUrl (local files, no external video thumbnailer). */
export function thumbnailUrlOf(row: Row): string | null {
  const type = String(row.type ?? "");
  const thumb = (row.thumbnailUrl as string | null) ?? null;
  if (type.startsWith("video")) return thumb;
  const url = (row.webpublicUrl as string | null) ?? String(row.url);
  return thumb ?? (isMimeImage(type, "sharp-convertible-image") ? url : null);
}

/** Packed DriveFile (upstream DriveFileEntityService.pack). */
export function packDriveFile(
  row: Row,
  opts: { self?: boolean; withUser?: boolean } = {},
  extra: { folder?: unknown; user?: unknown } = {},
): Record<string, unknown> {
  const props = row.properties && typeof row.properties === "object" && !Array.isArray(row.properties) ? (row.properties as Record<string, unknown>) : {};
  return {
    id: String(row.id),
    createdAt: (parseAidxTime(String(row.id)) ?? new Date(0)).toISOString(),
    name: String(row.name),
    type: String(row.type),
    md5: String(row.md5),
    size: Number(row.size),
    isSensitive: Boolean(row.isSensitive),
    blurhash: (row.blurhash as string | null) ?? null,
    properties: opts.self ? props : publicProperties(props),
    url: opts.self ? String(row.url) : ((row.webpublicUrl as string | null) ?? String(row.url)),
    thumbnailUrl: thumbnailUrlOf(row),
    comment: (row.comment as string | null) ?? null,
    folderId: (row.folderId as string | null) ?? null,
    folder: extra.folder ?? null,
    userId: opts.withUser ? ((row.userId as string | null) ?? null) : null,
    user: opts.withUser ? (extra.user ?? null) : null,
  };
}

