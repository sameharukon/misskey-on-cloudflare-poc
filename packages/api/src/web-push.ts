/**
 * Web Push on Web Crypto (what the `web-push` library does for upstream):
 * RFC 8291 message encryption (aes128gcm, single record) and RFC 8292 VAPID (ES256 JWT).
 * Keys use web-push's encoding: base64url uncompressed P-256 public key (65 bytes) and raw
 * private scalar (32 bytes), the format stored in meta.swPublicKey / swPrivateKey.
 */

const te = new TextEncoder();

export function b64urlEncode(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlDecode(s: string): Uint8Array {
  const p = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(p + "=".repeat((4 - (p.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

async function hmac(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", key as Uint8Array<ArrayBuffer>, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, data as Uint8Array<ArrayBuffer>));
}

/** HKDF-Expand for a single block (length ≤ 32). */
async function hkdfExpand1(prk: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  return (await hmac(prk, concat(info, new Uint8Array([1])))).slice(0, length);
}

/** web-push generateVAPIDKeys() equivalent. */
export async function generateVapidKeys(): Promise<{ publicKey: string; privateKey: string }> {
  const kp = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const pub = new Uint8Array((await crypto.subtle.exportKey("raw", kp.publicKey)) as ArrayBuffer);
  const jwk = (await crypto.subtle.exportKey("jwk", kp.privateKey)) as JsonWebKey;
  return { publicKey: b64urlEncode(pub), privateKey: jwk.d! };
}

/**
 * RFC 8291 aes128gcm body for one push message (salt ‖ rs ‖ idlen ‖ keyid ‖ ciphertext).
 * `asKeys` / `salt` are injectable for test vectors.
 */
export async function encryptPayload(
  payload: Uint8Array,
  uaPublicB64: string,
  authSecretB64: string,
  opts: { asKeys?: CryptoKeyPair; salt?: Uint8Array } = {},
): Promise<Uint8Array> {
  const uaPublic = b64urlDecode(uaPublicB64);
  const authSecret = b64urlDecode(authSecretB64);
  const asKeys = opts.asKeys ?? ((await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair);
  const asPublic = new Uint8Array((await crypto.subtle.exportKey("raw", asKeys.publicKey)) as ArrayBuffer);
  const uaKey = await crypto.subtle.importKey("raw", uaPublic as Uint8Array<ArrayBuffer>, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, asKeys.privateKey, 256));
  const salt = opts.salt ?? crypto.getRandomValues(new Uint8Array(16));

  const prkKey = await hmac(authSecret, ecdh);
  const ikm = await hkdfExpand1(prkKey, concat(te.encode("WebPush: info\0"), uaPublic, asPublic), 32);
  const prk = await hmac(salt, ikm);
  const cek = await hkdfExpand1(prk, te.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdfExpand1(prk, te.encode("Content-Encoding: nonce\0"), 12);

  const key = await crypto.subtle.importKey("raw", cek as Uint8Array<ArrayBuffer>, "AES-GCM", false, ["encrypt"]);
  const plaintext = concat(payload, new Uint8Array([2])); // last record, no padding
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce as Uint8Array<ArrayBuffer> }, key, plaintext));

  const header = new Uint8Array(16 + 4 + 1);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = asPublic.length;
  return concat(header, asPublic, ciphertext);
}

/** RFC 8292: `Authorization: vapid t=<jwt>, k=<public key>` for the endpoint's origin. */
export async function vapidAuthorization(endpoint: string, subject: string, publicKeyB64: string, privateKeyB64: string, now = Date.now()): Promise<string> {
  const pub = b64urlDecode(publicKeyB64);
  const jwk: JsonWebKey = {
    kty: "EC",
    crv: "P-256",
    x: b64urlEncode(pub.slice(1, 33)),
    y: b64urlEncode(pub.slice(33, 65)),
    d: privateKeyB64,
    ext: true,
  };
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const enc = (o: unknown) => b64urlEncode(te.encode(JSON.stringify(o)));
  const unsigned = `${enc({ typ: "JWT", alg: "ES256" })}.${enc({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject })}`;
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, te.encode(unsigned)));
  return `vapid t=${unsigned}.${b64urlEncode(sig)}, k=${publicKeyB64}`;
}

/** web-push default TTL (4 weeks). */
export const PUSH_TTL = 2419200;

export async function buildPushRequest(
  sub: { endpoint: string; auth: string; publickey: string },
  payload: string,
  vapid: { subject: string; publicKey: string; privateKey: string },
): Promise<RequestInit & { headers: Record<string, string> }> {
  return {
    method: "POST",
    headers: {
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: String(PUSH_TTL),
      Authorization: await vapidAuthorization(sub.endpoint, vapid.subject, vapid.publicKey, vapid.privateKey),
    },
    body: (await encryptPayload(te.encode(payload), sub.publickey, sub.auth)) as Uint8Array<ArrayBuffer>,
  };
}
