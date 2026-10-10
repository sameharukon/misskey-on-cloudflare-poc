/**
 * /identicon/:x (upstream ServerService + misc/gen-identicon.ts). The expected PRNG values and
 * layout were taken from random-seed 0.3.0 itself; the pixels were compared once against
 * upstream's genIdenticon on @napi-rs/canvas (every channel within ±2).
 */
import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import worker from "./index.js";
import { genIdenticon, identiconLayout, renderIdenticon, seededRandom } from "./identicon.js";
import { makeFixture, type Fixture } from "./pglite-fixture.js";

const ctx = { waitUntil() {}, passThroughOnException() {} };

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([new Uint8Array(data)]).stream().pipeThrough(new DecompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

describe("identicon", () => {
  it("seededRandom follows random-seed 0.3.0", () => {
    const r = seededRandom("syuilo@misskey.io");
    assert.deepEqual([r(20), r(3), r(3), r(1000), r(2 ** 40)], [11, 1, 0, 541, 212251934692]);
    // cleanString: surrounding whitespace and control characters are dropped before hashing
    const r2 = seededRandom(" a\n b ");
    assert.deepEqual([r2(20), r2(3), r2(1000)], [15, 0, 986]);
  });

  it("layout: color pair, then the mirrored 5×5 cells", () => {
    const { colors, cells } = identiconLayout("syuilo@misskey.io");
    assert.deepEqual(colors, ["#5761B2", "#1FC5A8"]);
    assert.deepEqual(cells.map((c) => c.map(Number).join("")), ["01010", "00101", "10010", "00101", "01010"]);
  });

  it("pixels: gradient corners, white cell, anti-aliased cell edge", () => {
    const px = renderIdenticon("syuilo@misskey.io");
    const at = (x: number, y: number) => [...px.subarray((y * 128 + x) * 3, (y * 128 + x) * 3 + 3)];
    assert.deepEqual(at(0, 0), [87, 97, 178]); // ≈ #5761B2 (t = 1/256)
    assert.deepEqual(at(127, 127), [31, 197, 168]); // ≈ #1FC5A8
    // cells[0][1] is white: x 32..44.8, y 44.8..57.6
    assert.deepEqual(at(38, 50), [255, 255, 255]);
    // pixel 44 in x is 80% covered by that cell, so it is mostly but not fully white
    const edge = at(44, 50);
    assert.ok(edge.every((v) => v > 200 && v < 255), String(edge));
  });

  it("PNG: 128×128 RGB whose IDAT inflates to the rendered rows", async () => {
    const png = await genIdenticon("syuilo@misskey.io");
    assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const v = new DataView(png.buffer, png.byteOffset);
    assert.equal(String.fromCharCode(...png.subarray(12, 16)), "IHDR");
    assert.deepEqual([v.getUint32(16), v.getUint32(20), png[24], png[25]], [128, 128, 8, 2]);
    const idatLen = v.getUint32(33);
    assert.equal(String.fromCharCode(...png.subarray(37, 41)), "IDAT");
    const raw = await inflate(png.subarray(41, 41 + idatLen));
    const px = renderIdenticon("syuilo@misskey.io");
    assert.equal(raw.length, 128 * (128 * 3 + 1));
    for (let y = 0; y < 128; y++) {
      assert.equal(raw[y * 385], 0);
      assert.deepEqual(raw.subarray(y * 385 + 1, (y + 1) * 385), px.subarray(y * 384, (y + 1) * 384));
    }
    assert.equal(String.fromCharCode(...png.subarray(png.length - 8, png.length - 4)), "IEND");
  });

  describe("GET /identicon/:x", () => {
    let f: Fixture;
    before(async () => {
      f = await makeFixture("IdenticonTest");
    });

    it("PNG with upstream's headers; the seed is the decoded path segment", async () => {
      const res = await worker.fetch(new Request("https://misskey.example.com/identicon/syuilo%40misskey.io"), f.env, ctx);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("content-type"), "image/png");
      assert.equal(res.headers.get("cache-control"), "public, max-age=86400");
      assert.deepEqual(new Uint8Array(await res.arrayBuffer()), await genIdenticon("syuilo@misskey.io"));
    });

    it("enableIdenticonGeneration = false → /static-assets/avatar.png", async () => {
      await f.db.query(`UPDATE meta SET "enableIdenticonGeneration" = FALSE`);
      const res = await worker.fetch(new Request("https://misskey.example.com/identicon/a@b"), f.env, ctx);
      assert.equal(res.status, 302);
      assert.equal(res.headers.get("location"), "/static-assets/avatar.png");
      await f.db.query(`UPDATE meta SET "enableIdenticonGeneration" = TRUE`);
    });
  });
});
