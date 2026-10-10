/**
 * upstream ClientServerService `/twemoji-badge/:path` on sharp: the twemoji SVG as a monochrome
 * notification badge (PNG; upstream's trailing resize(96, 96) is applied by sharp before the
 * boolean step, so the output stays 512×512 there as here). The gateway sends the SVG bytes (the container has no
 * internet):  POST /twemoji-badge  body: SVG  →  image/png
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

/** The same sharp pipeline as upstream (mask from the SVG, then XOR onto a transparent canvas). */
export async function twemojiBadge(svg: Buffer): Promise<Buffer> {
  const sharp = await loadSharp();
  if (!sharp) throw new Error("sharp unavailable");
  const mask = await sharp(svg, { density: 1000 })
    .resize(488, 488)
    .greyscale()
    .normalise()
    .linear(1.75, -(128 * 1.75) + 128) // 1.75x contrast
    .flatten({ background: "#000" })
    .extend({ top: 12, bottom: 12, left: 12, right: 12, background: "#000" })
    .toColorspace("b-w")
    .png()
    .toBuffer();
  return sharp({ create: { width: 512, height: 512, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .pipelineColorspace("b-w")
    .boolean(mask, "eor")
    .resize(96, 96)
    .png()
    .toBuffer();
}
