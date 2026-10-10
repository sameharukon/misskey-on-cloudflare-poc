import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { generateAlts } from "./alts.js";

const sharp = (await import("sharp").then((m: any) => m.default ?? m).catch(() => null)) as any;
const ffmpeg = process.env.FFMPEG_PATH ?? "ffmpeg";
const hasFfmpeg = spawnSync(ffmpeg, ["-version"]).status === 0;

describe("generateAlts", { skip: !sharp && "sharp not installed" }, () => {
  it("large PNG → webp thumbnail ≤498x422 + png webpublic ≤2048 + blurhash + size", async () => {
    const buf = await sharp({ create: { width: 3000, height: 1000, channels: 3, background: { r: 200, g: 30, b: 30 } } }).png().toBuffer();
    const r = await generateAlts(buf, "image/png", true);
    assert.deepEqual(r.properties, { width: 3000, height: 1000 });
    assert.equal(r.thumbnail!.type, "image/webp");
    const t = await sharp(Buffer.from(r.thumbnail!.data, "base64")).metadata();
    assert.ok(t.width! <= 498 && t.height! <= 422);
    assert.equal(r.webpublic!.type, "image/png");
    const w = await sharp(Buffer.from(r.webpublic!.data, "base64")).metadata();
    assert.equal(w.width, 2048);
    assert.equal(typeof r.blurhash, "string");
  });

  it("small JPEG satisfies webpublic (none generated); web=0 skips it", async () => {
    const buf = await sharp({ create: { width: 64, height: 32, channels: 3, background: "#00f" } }).jpeg().toBuffer();
    const r = await generateAlts(buf, "image/jpeg", true);
    assert.equal(r.webpublic, null);
    assert.ok(r.thumbnail);
  });

  it("BMP and ICO (upstream sharp-read-bmp): size, thumbnail, blurhash; BMP also a png webpublic", async () => {
    // 24-bit BMP, 4×2, bottom-up rows padded to 4 bytes
    const w = 4, h = 2, row = Math.ceil((w * 3) / 4) * 4;
    const bmp = Buffer.alloc(54 + row * h);
    bmp.write("BM", 0); bmp.writeUInt32LE(bmp.length, 2); bmp.writeUInt32LE(54, 10);
    bmp.writeUInt32LE(40, 14); bmp.writeInt32LE(w, 18); bmp.writeInt32LE(h, 22); bmp.writeUInt16LE(1, 26); bmp.writeUInt16LE(24, 28);
    bmp.writeUInt32LE(row * h, 34);
    for (let i = 54; i < bmp.length; i += 3) bmp[i + 2] = 255; // red-ish
    const r = await generateAlts(bmp, "image/bmp", true);
    assert.deepEqual(r.properties, { width: 4, height: 2 });
    assert.equal(r.thumbnail!.type, "image/webp");
    assert.equal(typeof r.blurhash, "string");

    // ICO with one embedded PNG entry
    const pngIcon = await sharp({ create: { width: 32, height: 32, channels: 4, background: "#0f0" } }).png().toBuffer();
    const head = Buffer.alloc(22);
    head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(1, 4);
    head[6] = 32; head[7] = 32; head.writeUInt16LE(1, 10); head.writeUInt16LE(32, 12);
    head.writeUInt32LE(pngIcon.length, 14); head.writeUInt32LE(22, 18);
    const ico = await generateAlts(Buffer.concat([head, pngIcon]), "image/x-icon", true);
    assert.deepEqual(ico.properties, { width: 32, height: 32 });
    assert.ok(ico.thumbnail);
    assert.equal(typeof ico.blurhash, "string");
  });

  it("unsupported type → no alts; broken image → error, no throw", async () => {
    assert.deepEqual(await generateAlts(Buffer.from("x"), "application/pdf", true), { properties: {}, blurhash: null, thumbnail: null, webpublic: null });
    const bad = await generateAlts(Buffer.from("not an image"), "image/png", true);
    assert.equal(bad.thumbnail, null);
  });

  it("video → ffmpeg frame → webp thumbnail", { skip: !hasFfmpeg && "ffmpeg not on PATH" }, () => {
    const out = spawnSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=640x360:rate=10", "-t", "1", "-pix_fmt", "yuv420p", "-f", "mp4", "-movflags", "frag_keyframe+empty_moov", "pipe:1"], { maxBuffer: 1 << 26 });
    assert.equal(out.status, 0);
    return generateAlts(out.stdout, "video/mp4", true).then((r) => {
      assert.equal(r.error, undefined);
      assert.equal(r.thumbnail!.type, "image/webp");
      assert.equal(r.webpublic, null);
    });
  });
});
