/**
 * Image conversions of upstream FileServerProxyHandler (`/proxy/*`), on sharp. The API worker
 * downloads / resolves the file and sends its bytes here:
 *   POST /proxy?mode=emoji|avatar|static|preview|badge|svg&mime=<type>&static=0|1   body: bytes
 *   → the converted image (Content-Type set), or 404 when upstream answers 404 (a badge without
 *     enough contrast)
 */

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

/** upstream ImageProcessingService webpDefault */
export const webpDefault = { quality: 77, alphaQuality: 95, lossless: false, nearLossless: false, smartSubsample: true, mixed: true, effort: 2, loop: 0 };

const BMP_TYPES = ["image/x-icon", "image/vnd.microsoft.icon", "image/bmp", "image/x-bmp", "image/x-ms-bmp"];

/** @misskey-dev/sharp-read-bmp sharpBmp(buffer, type, options) */
async function sharpBmp(sharp: SharpFn, buf: Buffer, type: string, options: Record<string, unknown> = {}): Promise<any> {
  if (BMP_TYPES.includes(type)) {
    const { sharpBmp: read } = (await import("@misskey-dev/sharp-read-bmp")) as { sharpBmp(s: Buffer, t: string, o?: object): Promise<any> };
    return read(buf, type, options);
  }
  return sharp(buf, options);
}

export type ProxyMode = "emoji" | "avatar" | "static" | "preview" | "badge" | "svg";
export type ProxyOutput = { status: 200; type: string; ext: string; data: Buffer } | { status: 404 };

/** convertSharpToWebpStream(img, w, h) */
const toWebp = (img: any, w: number, h: number) => img.resize(w, h, { fit: "inside", withoutEnlargement: true }).rotate().webp(webpDefault).toBuffer();

export async function convertProxyImage(buf: Buffer, mime: string, mode: ProxyMode, isStatic: boolean): Promise<ProxyOutput> {
  const sharp = await loadSharp();
  if (!sharp) throw new Error("sharp unavailable");
  switch (mode) {
    case "emoji":
    case "avatar": {
      // processEmojiOrAvatar (the API worker passes non-animation-convertible files through itself)
      const data = await (await sharpBmp(sharp, buf, mime, { animated: !isStatic }))
        .resize({ height: mode === "emoji" ? 128 : 320, withoutEnlargement: true })
        .webp(webpDefault)
        .toBuffer();
      return { status: 200, type: "image/webp", ext: "webp", data };
    }
    case "static":
      return { status: 200, type: "image/webp", ext: "webp", data: await toWebp(await sharpBmp(sharp, buf, mime), 498, 422) };
    case "preview":
      return { status: 200, type: "image/webp", ext: "webp", data: await toWebp(await sharpBmp(sharp, buf, mime), 200, 200) };
    case "badge": {
      const mask = (await sharpBmp(sharp, buf, mime))
        .resize(96, 96, { fit: "contain", position: "centre", withoutEnlargement: false })
        .greyscale()
        .normalise()
        .linear(1.75, -(128 * 1.75) + 128) // 1.75x contrast
        .flatten({ background: "#000" })
        .toColorspace("b-w");
      const stats = await mask.clone().stats();
      if (stats.entropy < 0.1) return { status: 404 }; // 'Skip to provide badge'
      const data = await sharp({ create: { width: 96, height: 96, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
        .pipelineColorspace("b-w")
        .boolean(await mask.png().toBuffer(), "eor")
        .png()
        .toBuffer();
      return { status: 200, type: "image/png", ext: "png", data };
    }
    case "svg":
      return { status: 200, type: "image/webp", ext: "webp", data: await toWebp(sharp(buf), 2048, 2048) };
  }
}
