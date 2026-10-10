import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { convertProxyImage } from "./proxy.js";

const sharp = (await import("sharp").then((m: any) => m.default ?? m)) as any;

describe("media proxy conversions (FileServerProxyHandler)", () => {
  it("emoji / avatar / static / preview / svg sizes as upstream", async () => {
    const big = await sharp({ create: { width: 1000, height: 800, channels: 3, background: "#f00" } }).png().toBuffer();
    const size = async (b: Buffer) => {
      const m = await sharp(b).metadata();
      return [m.format, m.width, m.height];
    };
    const e = await convertProxyImage(big, "image/png", "emoji", false);
    assert.equal(e.status, 200);
    if (e.status === 200) assert.deepEqual(await size(e.data), ["webp", 160, 128]);
    const a = await convertProxyImage(big, "image/png", "avatar", true);
    if (a.status === 200) assert.deepEqual(await size(a.data), ["webp", 400, 320]);
    const s = await convertProxyImage(big, "image/png", "static", false);
    if (s.status === 200) assert.deepEqual(await size(s.data), ["webp", 498, 398]);
    const p = await convertProxyImage(big, "image/png", "preview", false);
    if (p.status === 200) assert.deepEqual(await size(p.data), ["webp", 200, 160]);
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50"><rect width="100" height="50" fill="#00f"/></svg>');
    const v = await convertProxyImage(svg, "image/svg+xml", "svg", false);
    if (v.status === 200) assert.deepEqual(await size(v.data), ["webp", 100, 50]);
    // small images are not enlarged
    const small = await sharp({ create: { width: 20, height: 10, channels: 3, background: "#0f0" } }).png().toBuffer();
    const se = await convertProxyImage(small, "image/png", "emoji", false);
    if (se.status === 200) assert.deepEqual(await size(se.data), ["webp", 20, 10]);
  });

  it("badge: 96×96 mask, 404 for a flat image", async () => {
    const shape = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#fff"/><circle cx="32" cy="32" r="20" fill="#000"/></svg>');
    const b = await convertProxyImage(shape, "image/svg+xml", "badge", false);
    assert.equal(b.status, 200);
    if (b.status === 200) assert.deepEqual([b.type, (await sharp(b.data).metadata()).width], ["image/png", 96]);
    const flat = await sharp({ create: { width: 64, height: 64, channels: 3, background: "#808080" } }).png().toBuffer();
    assert.deepEqual(await convertProxyImage(flat, "image/png", "badge", false), { status: 404 });
  });
});
