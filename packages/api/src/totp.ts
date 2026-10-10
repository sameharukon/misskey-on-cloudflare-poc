/**
 * TOTP (RFC 6238, SHA-1, 6 digits, 30 s) on Web Crypto, compatible with the otpauth library
 * upstream uses: base32 secrets of 20 random bytes, `validate` with a ±1 step window returning
 * the step delta, and the same `otpauth://` URL shape.
 */

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Uint8Array {
  const clean = s.toUpperCase().replace(/=+$/, "").replace(/\s/g, "");
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error("invalid base32");
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

/** OTPAuth.Secret(): 20 random bytes, base32. */
export function generateSecret(): string {
  return base32Encode(crypto.getRandomValues(new Uint8Array(20)));
}

export async function hotp(secret: Uint8Array, counter: number): Promise<string> {
  const msg = new Uint8Array(8);
  let c = counter;
  for (let i = 7; i >= 0; i--) {
    msg[i] = c & 255;
    c = Math.floor(c / 256);
  }
  const key = await crypto.subtle.importKey("raw", secret as Uint8Array<ArrayBuffer>, { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const h = new Uint8Array(await crypto.subtle.sign("HMAC", key, msg));
  const o = h[h.length - 1]! & 15;
  const code = (((h[o]! & 127) << 24) | (h[o + 1]! << 16) | (h[o + 2]! << 8) | h[o + 3]!) % 1_000_000;
  return String(code).padStart(6, "0");
}

export const TOTP_PERIOD = 30;

export function totpCounter(now: number): number {
  return Math.floor(now / 1000 / TOTP_PERIOD);
}

/** TOTP.validate({ token, window }) → step delta, or null. */
export async function validateTotp(secretBase32: string, token: string, now = Date.now(), window = 1): Promise<number | null> {
  if (!/^\d{6}$/.test(token)) return null;
  const secret = base32Decode(secretBase32);
  const counter = totpCounter(now);
  for (let d = -window; d <= window; d++) {
    if ((await hotp(secret, counter + d)) === token) return d;
  }
  return null;
}

/** TOTP.toString() */
export function otpauthUrl(secretBase32: string, label: string, issuer: string): string {
  const e = encodeURIComponent;
  return `otpauth://totp/${e(issuer)}:${e(label)}?issuer=${e(issuer)}&secret=${secretBase32}&algorithm=SHA1&digits=6&period=${TOTP_PERIOD}`;
}

export async function sha256Base64Url(s: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  let bin = "";
  for (const b of d) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
