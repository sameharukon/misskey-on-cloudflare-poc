/**
 * Upstream DriveService.generateAlts + FileInfoService.getBlurhash on sharp /
 * ffmpeg, as one HTTP call from the API Worker:
 *   POST /alts?type=<mime>&web=0|1   body: original bytes
 *   → { properties, blurhash, thumbnail: {type,data(base64)}|null, webpublic: …|null }
 */
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface AltsImage {
  type: string;
  data: string;
}
export interface AltsResult {
  properties: { width?: number; height?: number; orientation?: number };
  blurhash: string | null;
  thumbnail: AltsImage | null;
  webpublic: AltsImage | null;
  error?: string;
}

/** upstream isMimeImage 'sharp-convertible-image-with-bmp' */
const SHARP_CONVERTIBLE = ["image/jpeg", "image/tiff", "image/png", "image/gif", "image/apng", "image/vnd.mozilla.apng", "image/webp", "image/avif", "image/svg+xml", "image/x-icon", "image/bmp"];

/** upstream's @misskey-dev/sharp-read-bmp: BMP / ICO decoded to raw pixels for sharp, other types as is. */
async function openImage(sharp: SharpFn, buf: Buffer, type: string): Promise<any> {
  if (["image/x-icon", "image/vnd.microsoft.icon", "image/bmp", "image/x-bmp", "image/x-ms-bmp"].includes(type)) {
    const { sharpBmp } = (await import("@misskey-dev/sharp-read-bmp")) as { sharpBmp(source: Buffer, type: string): Promise<any> };
    return sharpBmp(buf, type);
  }
  return sharp(buf);
}

type SharpFn = any;
let sharpMod: SharpFn | null | undefined;
async function loadSharp(): Promise<SharpFn | null> {
  if (sharpMod !== undefined) return sharpMod;
  try {
    const m: any = await import("sharp");
    sharpMod = m.default ?? m;
  } catch {
    sharpMod = null;
  }
  return sharpMod;
}

async function loadBlurhash(): Promise<((px: Uint8ClampedArray, w: number, h: number, cx: number, cy: number) => string) | null> {
  try {
    const m: any = await import("blurhash");
    return (m.encode ?? m.default?.encode) as never;
  } catch {
    return null;
  }
}

function ffmpegPath(): string {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  return "ffmpeg";
}

async function webp(img: any, w: number, h: number, extra: Record<string, unknown> = {}): Promise<AltsImage> {
  const data: Buffer = await img
    .clone()
    .resize(w, h, { fit: "inside", withoutEnlargement: true })
    .rotate()
    .webp({ quality: 85, ...extra })
    .toBuffer();
  return { type: "image/webp", data: data.toString("base64") };
}

async function png(img: any, w: number, h: number): Promise<AltsImage> {
  const data: Buffer = await img.clone().resize(w, h, { fit: "inside", withoutEnlargement: true }).rotate().png().toBuffer();
  return { type: "image/png", data: data.toString("base64") };
}

async function blurhashOf(sharp: SharpFn, buf: Buffer, type?: string): Promise<string | null> {
  const encode = await loadBlurhash();
  if (!encode) return null;
  try {
    const { data, info } = await (type ? await openImage(sharp, buf, type) : sharp(buf)).rotate().raw().ensureAlpha().resize(64, 64, { fit: "inside" }).toBuffer({ resolveWithObject: true });
    return encode(new Uint8ClampedArray(data), info.width, info.height, 5, 5);
  } catch {
    return null;
  }
}

/** First representative frame (ffmpeg `thumbnail` filter) as PNG. */
export async function videoFrame(buf: Buffer): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), "mkcf-"));
  try {
    const input = join(dir, "in");
    const out = join(dir, "out.png");
    await writeFile(input, buf);
    await new Promise<void>((resolve, reject) => {
      const p = spawn(ffmpegPath(), ["-hide_banner", "-loglevel", "error", "-i", input, "-vf", "thumbnail", "-frames:v", "1", "-f", "image2", out]);
      let errOut = "";
      p.stderr.on("data", (d) => (errOut += String(d)));
      p.on("error", reject);
      p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}: ${errOut.slice(0, 300)}`))));
    });
    return await readFile(out);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function generateAlts(buf: Buffer, type: string, generateWeb: boolean): Promise<AltsResult> {
  const empty: AltsResult = { properties: {}, blurhash: null, thumbnail: null, webpublic: null };
  const sharp = await loadSharp();
  if (!sharp) return { ...empty, error: "sharp unavailable" };

  if (type.startsWith("video/")) {
    try {
      const frame = await videoFrame(buf);
      const img = sharp(frame);
      return { ...empty, thumbnail: await webp(img, 498, 422), blurhash: await blurhashOf(sharp, frame) };
    } catch (e) {
      return { ...empty, error: e instanceof Error ? e.message : String(e) };
    }
  }

  if (!SHARP_CONVERTIBLE.includes(type)) return empty;

  let img: any;
  let meta: any;
  try {
    img = await openImage(sharp, buf, type);
    meta = await img.metadata();
  } catch (e) {
    return { ...empty, error: e instanceof Error ? e.message : String(e) };
  }
  const isAnimated = Boolean(meta.pages && meta.pages > 1);
  const properties: AltsResult["properties"] = {};
  if (meta.width && meta.height) {
    properties.width = meta.width;
    properties.height = meta.height;
  }
  if (meta.orientation != null) properties.orientation = meta.orientation;
  const satisfyWebpublic = Boolean(
    type !== "image/svg+xml" &&
      type !== "image/avif" &&
      !(meta.exif ?? meta.iptc ?? meta.xmp ?? meta.tifftagPhotoshop) &&
      meta.width && meta.width <= 2048 &&
      meta.height && meta.height <= 2048,
  );

  let webpublic: AltsImage | null = null;
  if (generateWeb && !satisfyWebpublic && !isAnimated) {
    try {
      if (["image/jpeg", "image/webp", "image/avif"].includes(type)) webpublic = await webp(img, 2048, 2048);
      else if (["image/png", "image/bmp", "image/svg+xml"].includes(type)) webpublic = await png(img, 2048, 2048);
    } catch {
      webpublic = null;
    }
  }

  let thumbnail: AltsImage | null = null;
  try {
    thumbnail = isAnimated ? await webp(sharp(buf, { animated: true }), 374, 317, { alphaQuality: 70 }) : await webp(img, 498, 422);
  } catch {
    thumbnail = null;
  }

  return { properties, blurhash: await blurhashOf(sharp, buf, type), thumbnail, webpublic };
}
