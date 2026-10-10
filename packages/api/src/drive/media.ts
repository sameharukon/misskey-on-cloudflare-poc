/**
 * Pure helpers for Drive uploads (no I/O): magic-byte type detection (subset of
 * upstream's `file-type`), image size / EXIF orientation probe, filename rules
 * (`validateFileName`, `correctFilename`), browser-safe types and
 * Content-Disposition. Mirrors upstream FileInfoService / misc helpers.
 */

export interface DetectedType {
  mime: string;
  ext: string | null;
}

/** upstream const.ts FILE_TYPE_BROWSERSAFE */
export const FILE_TYPE_BROWSERSAFE = [
  "image/png", "image/gif", "image/jpeg", "image/webp", "image/avif", "image/apng", "image/bmp", "image/tiff", "image/x-icon",
  "audio/opus", "video/ogg", "audio/ogg", "application/ogg",
  "video/quicktime", "video/mp4", "audio/mp4", "video/x-m4v", "audio/x-m4a", "video/3gpp", "video/3gpp2",
  "video/mpeg", "audio/mpeg",
  "video/webm", "audio/webm",
  "audio/aac",
  "audio/flac", "audio/wav",
  "audio/x-flac", "audio/vnd.wave",
];

const MIME_IMAGE = {
  "sharp-convertible-image": ["image/jpeg", "image/tiff", "image/png", "image/gif", "image/apng", "image/vnd.mozilla.apng", "image/webp", "image/avif", "image/svg+xml"],
  "sharp-convertible-image-with-bmp": ["image/jpeg", "image/tiff", "image/png", "image/gif", "image/apng", "image/vnd.mozilla.apng", "image/webp", "image/avif", "image/svg+xml", "image/x-icon", "image/bmp"],
  "sharp-animation-convertible-image-with-bmp": ["image/jpeg", "image/tiff", "image/png", "image/gif", "image/webp", "image/avif", "image/svg+xml", "image/x-icon", "image/bmp"],
} as const;

export function isMimeImage(mime: string, kind: keyof typeof MIME_IMAGE): boolean {
  return (MIME_IMAGE[kind] as readonly string[]).includes(mime);
}

export function safeContentType(mime: string): string {
  return FILE_TYPE_BROWSERSAFE.includes(mime) ? mime : "application/octet-stream";
}

const ascii = (b: Uint8Array, off: number, len: number) => {
  let s = "";
  for (let i = off; i < Math.min(b.length, off + len); i++) s += String.fromCharCode(b[i]!);
  return s;
};
const startsWith = (b: Uint8Array, sig: number[], off = 0) => sig.every((v, i) => b[off + i] === v);
const indexOfAscii = (b: Uint8Array, needle: string, from = 0, to = b.length) => {
  const n = [...needle].map((c) => c.charCodeAt(0));
  outer: for (let i = from; i <= Math.min(b.length, to) - n.length; i++) {
    for (let j = 0; j < n.length; j++) if (b[i + j] !== n[j]) continue outer;
    return i;
  }
  return -1;
};

function isSvg(b: Uint8Array): boolean {
  if (b.length > 1024 * 1024 * 2) return false;
  const head = new TextDecoder("utf-8", { fatal: false }).decode(b.subarray(0, 4096)).replace(/^\uFEFF/, "");
  const stripped = head
    .replace(/<\?xml[\s\S]*?\?>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<!DOCTYPE[\s\S]*?>/gi, "")
    .trimStart();
  return /^<svg[\s>]/i.test(stripped);
}

/** Detect type from content (upstream: file-type, then SVG check, else octet-stream). */
export function detectType(b: Uint8Array): DetectedType {
  if (b.length === 0) return { mime: "application/octet-stream", ext: null };
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    // APNG: acTL chunk before the first IDAT
    const actl = indexOfAscii(b, "acTL", 8, 4096);
    const idat = indexOfAscii(b, "IDAT", 8);
    if (actl !== -1 && (idat === -1 || actl < idat)) return { mime: "image/apng", ext: "apng" };
    return { mime: "image/png", ext: "png" };
  }
  if (startsWith(b, [0xff, 0xd8, 0xff])) return { mime: "image/jpeg", ext: "jpg" };
  if (ascii(b, 0, 4) === "GIF8") return { mime: "image/gif", ext: "gif" };
  if (ascii(b, 0, 4) === "RIFF") {
    const kind = ascii(b, 8, 4);
    if (kind === "WEBP") return { mime: "image/webp", ext: "webp" };
    if (kind === "WAVE") return { mime: "audio/wav", ext: "wav" };
    if (kind === "AVI ") return { mime: "video/vnd.avi", ext: "avi" };
  }
  if (startsWith(b, [0x42, 0x4d]) && b.length > 26 && (b[14] === 12 || b[14] === 40 || b[14] === 108 || b[14] === 124)) {
    return { mime: "image/bmp", ext: "bmp" };
  }
  if (startsWith(b, [0x00, 0x00, 0x01, 0x00])) return { mime: "image/x-icon", ext: "ico" };
  if (startsWith(b, [0x49, 0x49, 0x2a, 0x00]) || startsWith(b, [0x4d, 0x4d, 0x00, 0x2a])) return { mime: "image/tiff", ext: "tif" };
  if (ascii(b, 4, 4) === "ftyp") {
    const brand = ascii(b, 8, 4).replace(/\0/g, " ");
    const compat = ascii(b, 16, Math.min(64, Math.max(0, ((b[0]! << 24) | (b[1]! << 16) | (b[2]! << 8) | b[3]!) - 16)));
    if (brand === "avif" || brand === "avis") return { mime: "image/avif", ext: "avif" };
    if (brand === "heic" || brand === "heix") return { mime: "image/heic", ext: "heic" };
    if (brand === "hevc" || brand === "hevx") return { mime: "image/heic-sequence", ext: "heic" };
    if (brand === "mif1") return compat.includes("avif") ? { mime: "image/avif", ext: "avif" } : { mime: "image/heif", ext: "heic" };
    if (brand === "msf1") return { mime: "image/heif-sequence", ext: "heic" };
    if (brand === "qt  ") return { mime: "video/quicktime", ext: "mov" };
    if (brand === "M4A ") return { mime: "audio/x-m4a", ext: "m4a" };
    if (brand === "M4V " || brand === "M4VH" || brand === "M4VP") return { mime: "video/x-m4v", ext: "m4v" };
    if (brand.startsWith("3g2")) return { mime: "video/3gpp2", ext: "3g2" };
    if (brand.startsWith("3g")) return { mime: "video/3gpp", ext: "3gp" };
    return { mime: "video/mp4", ext: "mp4" };
  }
  if (startsWith(b, [0x1a, 0x45, 0xdf, 0xa3])) {
    return indexOfAscii(b, "webm", 0, 64) !== -1 ? { mime: "video/webm", ext: "webm" } : { mime: "video/x-matroska", ext: "mkv" };
  }
  if (ascii(b, 0, 4) === "OggS") {
    if (indexOfAscii(b, "OpusHead", 0, 64) !== -1) return { mime: "audio/opus", ext: "opus" };
    if (indexOfAscii(b, "theora", 0, 64) !== -1) return { mime: "video/ogg", ext: "ogv" };
    if (indexOfAscii(b, "vorbis", 0, 64) !== -1) return { mime: "audio/ogg", ext: "ogg" };
    return { mime: "application/ogg", ext: "ogx" };
  }
  if (ascii(b, 0, 4) === "fLaC") return { mime: "audio/flac", ext: "flac" }; // upstream fixMime
  if (ascii(b, 0, 3) === "ID3") return { mime: "audio/mpeg", ext: "mp3" };
  if (b[0] === 0xff && b.length > 1) {
    if ((b[1]! & 0xf6) === 0xf0) return { mime: "audio/aac", ext: "aac" };
    if ((b[1]! & 0xe0) === 0xe0) return { mime: "audio/mpeg", ext: "mp3" };
  }
  if (startsWith(b, [0x00, 0x00, 0x01, 0xba]) || startsWith(b, [0x00, 0x00, 0x01, 0xb3])) return { mime: "video/mpeg", ext: "mpg" };
  if (ascii(b, 0, 5) === "%PDF-") return { mime: "application/pdf", ext: "pdf" };
  if (startsWith(b, [0x50, 0x4b, 0x03, 0x04])) return { mime: "application/zip", ext: "zip" };
  if (startsWith(b, [0x1f, 0x8b, 0x08])) return { mime: "application/gzip", ext: "gz" };
  if (startsWith(b, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) return { mime: "application/x-7z-compressed", ext: "7z" };
  if (isSvg(b)) return { mime: "image/svg+xml", ext: "svg" };
  return { mime: "application/octet-stream", ext: null };
}

export interface ImageProbe {
  width: number;
  height: number;
  orientation?: number;
}

const u16be = (b: Uint8Array, o: number) => (b[o]! << 8) | b[o + 1]!;
const u16le = (b: Uint8Array, o: number) => b[o]! | (b[o + 1]! << 8);
const u32be = (b: Uint8Array, o: number) => ((b[o]! << 24) >>> 0) + ((b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!);
const u32le = (b: Uint8Array, o: number) => (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16)) + ((b[o + 3]! << 24) >>> 0);
const u24le = (b: Uint8Array, o: number) => b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16);

function exifOrientation(b: Uint8Array, start: number, len: number): number | undefined {
  // APP1: "Exif\0\0" + TIFF header
  if (ascii(b, start, 6) !== "Exif\0\0") return undefined;
  const t = start + 6;
  const le = ascii(b, t, 2) === "II";
  const r16 = (o: number) => (le ? u16le(b, o) : u16be(b, o));
  const r32 = (o: number) => (le ? u32le(b, o) : u32be(b, o));
  const ifd = t + r32(t + 4);
  if (ifd + 2 > start + len) return undefined;
  const n = r16(ifd);
  for (let i = 0; i < n; i++) {
    const e = ifd + 2 + i * 12;
    if (e + 12 > start + len) break;
    if (r16(e) === 0x0112) {
      const v = r16(e + 8);
      return v >= 1 && v <= 8 ? v : undefined;
    }
  }
  return undefined;
}

/** probe-image-size equivalent for the formats upstream records width/height for. */
export function probeImage(b: Uint8Array, mime: string): ImageProbe | null {
  try {
    switch (mime) {
      case "image/png":
      case "image/apng":
        return b.length >= 24 ? { width: u32be(b, 16), height: u32be(b, 20) } : null;
      case "image/gif":
        return b.length >= 10 ? { width: u16le(b, 6), height: u16le(b, 8) } : null;
      case "image/bmp":
        return b.length >= 26 ? { width: Math.abs(u32le(b, 18) | 0), height: Math.abs(u32le(b, 22) | 0) } : null;
      case "image/jpeg": {
        let o = 2;
        let orientation: number | undefined;
        while (o + 4 <= b.length) {
          if (b[o] !== 0xff) {
            o++;
            continue;
          }
          const marker = b[o + 1]!;
          if (marker === 0xff) {
            o++;
            continue;
          }
          const len = u16be(b, o + 2);
          if (marker === 0xe1 && orientation === undefined) orientation = exifOrientation(b, o + 4, len - 2);
          if ((marker >= 0xc0 && marker <= 0xcf) && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
            const p: ImageProbe = { height: u16be(b, o + 5), width: u16be(b, o + 7) };
            if (orientation !== undefined) p.orientation = orientation;
            return p;
          }
          o += 2 + len;
        }
        return null;
      }
      case "image/webp": {
        const chunk = ascii(b, 12, 4);
        if (chunk === "VP8 ") return { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
        if (chunk === "VP8L") {
          const bits = u32le(b, 21);
          return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
        }
        if (chunk === "VP8X") return { width: u24le(b, 24) + 1, height: u24le(b, 27) + 1 };
        return null;
      }
      case "image/avif":
      case "image/heic":
      case "image/heif": {
        const i = indexOfAscii(b, "ispe", 0, Math.min(b.length, 65536));
        return i !== -1 && i + 16 <= b.length ? { width: u32be(b, i + 8), height: u32be(b, i + 12) } : null;
      }
      case "image/x-icon":
        return b.length >= 8 ? { width: b[6] || 256, height: b[7] || 256 } : null;
      default:
        return null;
    }
  } catch {
    return null;
  }
}

/** upstream FileInfoService: width/height are recorded for these types. */
export const PROBED_IMAGE_TYPES = ["image/jpeg", "image/gif", "image/png", "image/apng", "image/webp", "image/bmp", "image/tiff", "image/svg+xml", "image/vnd.adobe.photoshop", "image/avif"];

/** DriveFileEntityService.validateFileName */
export function validateFileName(name: string): boolean {
  return name.trim().length > 0 && name.length <= 200 && !name.includes("\\") && !name.includes("/") && !name.includes("..");
}

const SKIP_EXTS = new Set([".gz", ".tar", ".tgz", ".bz2", ".xz", ".zip", ".7z"]);

/** upstream misc/correct-filename.ts */
export function correctFilename(filename: string, ext: string | null): string {
  const dotExt = ext ? (ext[0] === "." ? ext : `.${ext}`) : ".unknown";
  const m = /\.[0-9a-zA-Z]+$/i.exec(filename);
  if (!m || !m[0]) return `${filename}${dotExt}`;
  const fe = m[0].toLowerCase();
  if (
    ext === null ||
    fe === dotExt ||
    (dotExt === ".jpg" && fe === ".jpeg") ||
    (dotExt === ".tif" && fe === ".tiff") ||
    (dotExt === ".exe" && fe === ".dll") ||
    SKIP_EXTS.has(dotExt)
  ) {
    return filename;
  }
  return `${filename}${dotExt}`;
}

/** RFC 6266 Content-Disposition with ASCII fallback + RFC 5987 filename*. */
export function contentDisposition(type: "inline" | "attachment", filename: string): string {
  const fallback = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return fallback === filename ? `${type}; filename="${fallback}"` : `${type}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

/** uploadableFileTypes policy match (upstream DriveService.addFile). */
export function isAllowedType(allowed: readonly string[], mime: string): boolean {
  return allowed.some((t) => {
    if (t === "*" || t === "*/*") return true;
    if (t.endsWith("/*")) return mime.startsWith(t.slice(0, -1));
    return mime === t;
  });
}

/** Parse a single `Range: bytes=` header against `size`. null = ignore, "invalid" = 416. */
export function parseRange(header: string | null, size: number): { start: number; end: number } | null | "invalid" {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  let start: number;
  let end: number;
  if (m[1] === "" && m[2] === "") return "invalid";
  if (m[1] === "") {
    const suffix = Number(m[2]);
    if (suffix === 0) return "invalid";
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start >= size || start > end) return "invalid";
  return { start, end };
}
