import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { twemojiBadge } from "./twemoji-badge.js";

describe("twemoji-badge", () => {
  // upstream's pipeline ends with .resize(96, 96) after .boolean(); sharp applies the resize before
  // the boolean operation, so the result keeps the 512×512 canvas (upstream sends the same)
  it("renders the SVG as a square monochrome PNG badge (transparent outside the shape)", async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 36"><circle fill="#FFCC4D" cx="18" cy="18" r="12"/></svg>');
    const png = await twemojiBadge(svg);
    const sharp = (await import("sharp")).default as any;
    const meta = await sharp(png).metadata();
    assert.deepEqual([meta.format, meta.width, meta.height], ["png", 512, 512]);
    const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const alpha = (x: number, y: number) => data[(y * info.width + x) * info.channels + info.channels - 1];
    assert.equal(alpha(10, 10), 0); // corner: outside the circle
    assert.ok(alpha(256, 256)! > 0); // centre: inside
  });
});
