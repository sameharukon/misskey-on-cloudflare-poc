/**
 * upstream ServerService `/identicon/:x` + misc/gen-identicon.ts: the default avatar of users
 * without one (packers `user.ts` points `avatarUrl` here). A 128×128 PNG: a diagonal gradient
 * from one of 20 color pairs and a white 5×5 horizontally mirrored cell pattern, both drawn from
 * random-seed 0.3.0 seeded with `:x` (`username@host`), so a user gets the same image as on
 * upstream. `meta.enableIdenticonGeneration = false` → redirect to `/static-assets/avatar.png`.
 *
 * upstream draws with @napi-rs/canvas (Skia); here the same drawing is computed per pixel:
 * the gradient is evaluated at pixel centers and the cells (12.8 px, so their edges fall inside
 * pixels) are composited with their exact area coverage, which is what Skia's anti-aliased
 * fillRect does. The PNG is RGB, deflated with CompressionStream.
 */
import type { ApiEnv } from "./env.js";
import { withHyperdriveClient } from "./pg.js";
import { crc32 } from "./zip.js";
import { metaRowPg } from "./user-lite-pg.js";

const SIZE = 128;
const N = 5;
const MARGIN = SIZE / 4;
const CELL = (SIZE - MARGIN * 2) / N;
const SIDE_N = Math.floor(N / 2);
const COLORS: [string, string][] = [
  ["#FF512F", "#DD2476"],
  ["#FF61D2", "#FE9090"],
  ["#72FFB6", "#10D164"],
  ["#FD8451", "#FFBD6F"],
  ["#305170", "#6DFC6B"],
  ["#00C0FF", "#4218B8"],
  ["#009245", "#FCEE21"],
  ["#0100EC", "#FB36F4"],
  ["#FDABDD", "#374A5A"],
  ["#38A2D7", "#561139"],
  ["#121C84", "#8278DA"],
  ["#5761B2", "#1FC5A8"],
  ["#FFDB01", "#0E197D"],
  ["#FF3E9D", "#0E1F40"],
  ["#766eff", "#00d4ff"],
  ["#9bff6e", "#00d4ff"],
  ["#ff6e94", "#00d4ff"],
  ["#ffa96e", "#00d4ff"],
  ["#ffa96e", "#ff009d"],
  ["#ffdd6e", "#ff009d"],
];

/** random-seed 0.3.0 (GRC UHEPRNG + Baagøe's Mash), string-seed path only: `gen.create(seed)` → `rand(range)`. */
export function seededRandom(seed: string): (range: number) => number {
  const o = 48;
  let n = 0xefc8249d;
  const mash = (data?: string | number): number => {
    if (!data) {
      n = 0xefc8249d;
      return 0;
    }
    const str = data.toString();
    for (let i = 0; i < str.length; i++) {
      n += str.charCodeAt(i);
      let h = 0.02519603282416938 * n;
      n = h >>> 0;
      h -= n;
      h *= n;
      n = h >>> 0;
      h -= n;
      n += h * 0x100000000;
    }
    return (n >>> 0) * 2.3283064365386963e-10;
  };
  // initState
  mash();
  const s = new Float64Array(o);
  for (let i = 0; i < o; i++) s[i] = mash(" ");
  let c = 1;
  let p = o;
  // hashString(cleanString(seed))
  const clean = seed
    .replace(/(^\s*)|(\s*$)/gi, "")
    .replace(/[\x00-\x1F]/gi, "")
    .replace(/\n /, "\n");
  mash(clean);
  for (let i = 0; i < clean.length; i++) {
    const k = clean.charCodeAt(i);
    for (let j = 0; j < o; j++) {
      s[j] -= mash(k);
      if (s[j]! < 0) s[j] += 1;
    }
  }
  const raw = (): number => {
    if (++p >= o) p = 0;
    const t = 1768863 * s[p]! + c * 2.3283064365386963e-10;
    return (s[p] = t - (c = t | 0));
  };
  return (range) => Math.floor(range * (raw() + ((raw() * 0x200000) | 0) * 1.1102230246251565e-16));
}

/** Which of the 5×5 cells are white, `cells[x][y]`, and the background pair: the draw order of gen-identicon.ts. */
export function identiconLayout(seed: string): { colors: [string, string]; cells: boolean[][] } {
  const rand = seededRandom(seed);
  const colors = COLORS[rand(COLORS.length)]!;
  const side: boolean[][] = [];
  for (let x = 0; x < SIDE_N; x++) {
    side.push([]);
    for (let y = 0; y < N; y++) side[x]!.push(rand(3) === 0);
  }
  const center: boolean[] = [];
  for (let i = 0; i < N; i++) center.push(rand(3) === 0);
  const cells: boolean[][] = [];
  for (let x = 0; x < N; x++) {
    cells.push([]);
    for (let y = 0; y < N; y++) {
      const mid = (N - 1) / 2;
      cells[x]!.push(x === mid ? center[y]! : x < mid ? side[x]![y]! : side[SIDE_N - (x - SIDE_N)]![y]!);
    }
  }
  return { colors, cells };
}

const rgb = (hex: string): [number, number, number] => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];

/** RGB pixels (SIZE × SIZE × 3) of the identicon for `seed`. */
export function renderIdenticon(seed: string): Uint8Array {
  const { colors, cells } = identiconLayout(seed);
  const [a, b] = [rgb(colors[0]), rgb(colors[1])];
  const px = new Float64Array(SIZE * SIZE * 3);
  // createLinearGradient(0, 0, SIZE, SIZE): t is the projection of the pixel center on the diagonal
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const t = Math.min(1, Math.max(0, (x + 0.5 + y + 0.5) / (2 * SIZE)));
      for (let ch = 0; ch < 3; ch++) px[(y * SIZE + x) * 3 + ch] = a[ch]! + (b[ch]! - a[ch]!) * t;
    }
  }
  // white cells, one fillRect each (anti-aliased: alpha = covered area of the pixel)
  for (let cx = 0; cx < N; cx++) {
    for (let cy = 0; cy < N; cy++) {
      if (!cells[cx]![cy]) continue;
      const x0 = MARGIN + CELL * cx;
      const y0 = MARGIN + CELL * cy;
      for (let y = Math.floor(y0); y < Math.ceil(y0 + CELL); y++) {
        const covY = Math.min(y + 1, y0 + CELL) - Math.max(y, y0);
        for (let x = Math.floor(x0); x < Math.ceil(x0 + CELL); x++) {
          const alpha = (Math.min(x + 1, x0 + CELL) - Math.max(x, x0)) * covY;
          const i = (y * SIZE + x) * 3;
          for (let ch = 0; ch < 3; ch++) px[i + ch] = px[i + ch]! * (1 - alpha) + 255 * alpha;
        }
      }
    }
  }
  const out = new Uint8Array(px.length);
  for (let i = 0; i < px.length; i++) out[i] = Math.round(px[i]!);
  return out;
}

async function deflate(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  const stream = new Blob([data]).stream().pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const v = new DataView(out.buffer);
  v.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  v.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** 8-bit RGB PNG of `pixels` (width × height × 3), filter type 0 on every row. */
export async function encodePngRgb(pixels: Uint8Array, width: number, height: number): Promise<Uint8Array<ArrayBuffer>> {
  const raw = new Uint8Array(height * (width * 3 + 1));
  for (let y = 0; y < height; y++) raw.set(pixels.subarray(y * width * 3, (y + 1) * width * 3), y * (width * 3 + 1) + 1);
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", await deflate(raw)),
    chunk("IEND", new Uint8Array(0)),
  ];
  const png = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    png.set(p, off);
    off += p.length;
  }
  return png;
}

export async function genIdenticon(seed: string): Promise<Uint8Array<ArrayBuffer>> {
  return encodePngRgb(renderIdenticon(seed), SIZE, SIZE);
}

/** meta.enableIdenticonGeneration (column default true; true without Postgres, as the offline tests run). */
async function identiconEnabled(env: ApiEnv): Promise<boolean> {
  if (!env.HYPERDRIVE?.connectionString) return true;
  const v = await withHyperdriveClient(env.HYPERDRIVE, async (c) => (await metaRowPg(c)).enableIdenticonGeneration as boolean | null | undefined);
  return v ?? true;
}

/** GET /identicon/:x — headers as upstream (also on the redirect). */
export async function serveIdenticon(env: ApiEnv, x: string): Promise<Response> {
  const headers = { "content-type": "image/png", "cache-control": "public, max-age=86400" };
  if (!(await identiconEnabled(env))) {
    return new Response(null, { status: 302, headers: { ...headers, location: "/static-assets/avatar.png" } });
  }
  return new Response(await genIdenticon(x), { headers });
}
