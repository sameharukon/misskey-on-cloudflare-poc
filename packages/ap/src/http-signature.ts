/**
 * HTTP Signatures (draft-cavage-http-signatures-12) — RSA-SHA256 via Web Crypto. Used by the api
 * Worker's federation: inbox verification (ap/inbox.ts) and signed deliveries / GETs.
 */

export type HttpSignatureParams = {
  keyId: string;
  algorithm: string;
  headers: string[];
  signature: string; // base64
};

const textEncoder = new TextEncoder();

export function parseSignatureHeader(header: string): HttpSignatureParams | null {
  const map = new Map<string, string>();
  for (const part of header.split(",")) {
    const m = /^\s*([a-zA-Z]+)\s*=\s*"([^"]*)"\s*$/.exec(part);
    if (m) map.set(m[1]!.toLowerCase(), m[2]!);
  }
  const keyId = map.get("keyid");
  const algorithm = map.get("algorithm");
  const headers = map.get("headers");
  const signature = map.get("signature");
  if (!keyId || !algorithm || !headers || !signature) return null;
  return {
    keyId,
    algorithm,
    headers: headers.split(/\s+/).filter(Boolean),
    signature,
  };
}

export function formatSignatureHeader(p: HttpSignatureParams): string {
  return [
    `keyId="${p.keyId}"`,
    `algorithm="${p.algorithm}"`,
    `headers="${p.headers.join(" ")}"`,
    `signature="${p.signature}"`,
  ].join(",");
}

/**
 * Build signing string per draft-cavage.
 * Special: `(request-target)` = `${method.lower} ${pathWithQuery}`
 */
export function buildSigningString(
  method: string,
  pathWithQuery: string,
  headers: Headers | Record<string, string>,
  headerNames: string[],
): string {
  const get = (name: string): string => {
    if (name === "(request-target)") {
      return `${method.toLowerCase()} ${pathWithQuery}`;
    }
    if (headers instanceof Headers) {
      return headers.get(name) ?? "";
    }
    const found = Object.entries(headers).find(([k]) => k.toLowerCase() === name.toLowerCase());
    return found?.[1] ?? "";
  };
  return headerNames.map((h) => `${h.toLowerCase()}: ${get(h)}`).join("\n");
}

function b64encode(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function b64decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function generateRsaKeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
}

export async function exportSpkiPem(publicKey: CryptoKey): Promise<string> {
  const spki = await crypto.subtle.exportKey("spki", publicKey);
  const b64 = b64encode(spki);
  const lines = b64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN PUBLIC KEY-----\n${lines.join("\n")}\n-----END PUBLIC KEY-----\n`;
}

/** DER length octets. */
function derLength(n: number): number[] {
  if (n < 0x80) return [n];
  const bytes: number[] = [];
  for (let v = n; v > 0; v >>= 8) bytes.unshift(v & 0xff);
  return [0x80 | bytes.length, ...bytes];
}

/** A PKCS#1 RSAPublicKey wrapped as SubjectPublicKeyInfo (rsaEncryption, NULL parameters). */
function pkcs1ToSpki(pkcs1: Uint8Array): Uint8Array {
  // SEQUENCE { OID 1.2.840.113549.1.1.1, NULL }
  const algorithm = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
  const bitString = [0x03, ...derLength(pkcs1.length + 1), 0x00, ...pkcs1];
  const body = [...algorithm, ...bitString];
  return new Uint8Array([0x30, ...derLength(body.length), ...body]);
}

/**
 * An RSA public key from PEM: SubjectPublicKeyInfo (`BEGIN PUBLIC KEY`), or PKCS#1
 * (`BEGIN RSA PUBLIC KEY`, used by some servers and relays) — upstream reads both through Node's
 * crypto.createPublicKey.
 */
export function importSpkiPem(pem: string): Promise<CryptoKey> {
  return cachedKey(spkiKeys, pem, importSpkiPemUncached);
}

/**
 * Imported keys per isolate, by PEM: every inbox verification and every delivery would otherwise
 * parse and import the same keys again. Bounded; the oldest entry goes first.
 */
const KEY_CACHE_MAX = 1000;
const spkiKeys = new Map<string, Promise<CryptoKey>>();
const pkcs8Keys = new Map<string, Promise<CryptoKey>>();

function cachedKey(cache: Map<string, Promise<CryptoKey>>, pem: string, load: (pem: string) => Promise<CryptoKey>): Promise<CryptoKey> {
  const hit = cache.get(pem);
  if (hit) return hit;
  const p = load(pem);
  // a PEM that fails to import is not kept
  p.catch(() => cache.delete(pem));
  if (cache.size >= KEY_CACHE_MAX) cache.delete(cache.keys().next().value!);
  cache.set(pem, p);
  return p;
}

async function importSpkiPemUncached(pem: string): Promise<CryptoKey> {
  const pkcs1 = /-----BEGIN RSA PUBLIC KEY-----/.test(pem);
  const b64 = pem
    .replace(/-----(BEGIN|END) (RSA )?PUBLIC KEY-----/g, "")
    .replace(/\s+/g, "");
  const raw = b64decode(b64);
  const der = pkcs1 ? pkcs1ToSpki(raw) : raw;
  return crypto.subtle.importKey(
    "spki",
    der.buffer as ArrayBuffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    true,
    ["verify"],
  );
}

export async function signRequest(opts: {
  privateKey: CryptoKey;
  keyId: string;
  method: string;
  pathWithQuery: string;
  headers: Record<string, string>;
  /** Header names to sign (default: (request-target) host date) */
  headerNames?: string[];
}): Promise<{ signatureHeader: string; signingString: string }> {
  const headerNames = opts.headerNames ?? ["(request-target)", "host", "date"];
  const signingString = buildSigningString(
    opts.method,
    opts.pathWithQuery,
    opts.headers,
    headerNames,
  );
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    opts.privateKey,
    textEncoder.encode(signingString),
  );
  const params: HttpSignatureParams = {
    keyId: opts.keyId,
    algorithm: "rsa-sha256",
    headers: headerNames,
    signature: b64encode(sig),
  };
  return { signatureHeader: formatSignatureHeader(params), signingString };
}

export async function verifyRequest(opts: {
  publicKey: CryptoKey;
  method: string;
  pathWithQuery: string;
  headers: Headers | Record<string, string>;
  signatureHeader: string;
}): Promise<boolean> {
  const parsed = parseSignatureHeader(opts.signatureHeader);
  if (!parsed) return false;
  if (parsed.algorithm !== "rsa-sha256" && parsed.algorithm !== "hs2019") {
    // accept rsa-sha256 primarily
    if (parsed.algorithm !== "rsa-sha256") return false;
  }
  const signingString = buildSigningString(
    opts.method,
    opts.pathWithQuery,
    opts.headers,
    parsed.headers,
  );
  return crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    opts.publicKey,
    b64decode(parsed.signature).buffer as ArrayBuffer,
    textEncoder.encode(signingString),
  );
}

// ---------------------------------------------------------------------------
// Outbound signing (Misskey-compatible) + inbound verification helpers
// ---------------------------------------------------------------------------

export function importPkcs8Pem(pem: string): Promise<CryptoKey> {
  return cachedKey(pkcs8Keys, pem, importPkcs8PemUncached);
}

async function importPkcs8PemUncached(pem: string): Promise<CryptoKey> {
  const b64 = pem
    .replace(/-----BEGIN (?:RSA )?PRIVATE KEY-----/, "")
    .replace(/-----END (?:RSA )?PRIVATE KEY-----/, "")
    .replace(/\s+/g, "");
  return crypto.subtle.importKey(
    "pkcs8",
    b64decode(b64).buffer as ArrayBuffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

export async function exportPkcs8Pem(privateKey: CryptoKey): Promise<string> {
  const der = await crypto.subtle.exportKey("pkcs8", privateKey);
  const lines = b64encode(der).match(/.{1,64}/g) ?? [];
  return `-----BEGIN PRIVATE KEY-----\n${lines.join("\n")}\n-----END PRIVATE KEY-----\n`;
}

/** `SHA-256=<base64>` digest header value for a body. */
export async function digestHeader(body: string | Uint8Array): Promise<string> {
  const bytes = typeof body === "string" ? textEncoder.encode(body) : body;
  const h = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
  return `SHA-256=${b64encode(h)}`;
}

/**
 * Sign an outbound AP POST like upstream ApRequestService.createSignedPost:
 * headers (request-target) date host digest, rsa-sha256.
 */
export async function signedPostHeaders(opts: {
  privateKeyPem: string;
  keyId: string;
  url: string;
  body: string;
  date?: Date;
}): Promise<Record<string, string>> {
  const u = new URL(opts.url);
  const headers: Record<string, string> = {
    Date: (opts.date ?? new Date()).toUTCString(),
    Host: u.host,
    Digest: await digestHeader(opts.body),
    "Content-Type": "application/activity+json",
    Accept: "application/activity+json, application/ld+json",
  };
  const key = await importPkcs8Pem(opts.privateKeyPem);
  const { signatureHeader } = await signRequest({
    privateKey: key,
    keyId: opts.keyId,
    method: "POST",
    pathWithQuery: u.pathname + u.search,
    headers,
    headerNames: ["(request-target)", "date", "host", "digest"],
  });
  headers.Signature = signatureHeader;
  return headers;
}

/** Signed GET (authorized fetch) like upstream createSignedGet. */
export async function signedGetHeaders(opts: {
  privateKeyPem: string;
  keyId: string;
  url: string;
  date?: Date;
}): Promise<Record<string, string>> {
  const u = new URL(opts.url);
  const headers: Record<string, string> = {
    Accept: 'application/activity+json, application/ld+json; profile="https://www.w3.org/ns/activitystreams"',
    Date: (opts.date ?? new Date()).toUTCString(),
    Host: u.host,
  };
  const key = await importPkcs8Pem(opts.privateKeyPem);
  const { signatureHeader } = await signRequest({
    privateKey: key,
    keyId: opts.keyId,
    method: "GET",
    pathWithQuery: u.pathname + u.search,
    headers,
    headerNames: ["(request-target)", "date", "host", "accept"],
  });
  headers.Signature = signatureHeader;
  return headers;
}

export type IncomingCheck =
  | { ok: true; keyId: string }
  | { ok: false; reason: string };

/**
 * Structural checks before fetching the key (upstream inbox(): must sign
 * (request-target) host date [+ digest for bodies]; host must match; date
 * within skew; digest must match body).
 */
export async function precheckIncoming(opts: {
  method: string;
  headers: Record<string, string>;
  body: string;
  expectedHost: string;
  now?: Date;
  maxSkewMs?: number;
}): Promise<IncomingCheck> {
  const h = Object.fromEntries(Object.entries(opts.headers).map(([k, v]) => [k.toLowerCase(), v]));
  const sig = h["signature"];
  if (!sig) return { ok: false, reason: "no_signature" };
  const parsed = parseSignatureHeader(sig);
  if (!parsed) return { ok: false, reason: "bad_signature_header" };
  const signed = parsed.headers.map((x) => x.toLowerCase());
  for (const need of ["(request-target)", "host", "date"]) {
    if (!signed.includes(need)) return { ok: false, reason: `unsigned_${need}` };
  }
  if ((h["host"] ?? "").toLowerCase() !== opts.expectedHost.toLowerCase()) {
    return { ok: false, reason: "host_mismatch" };
  }
  const date = Date.parse(h["date"] ?? "");
  const now = (opts.now ?? new Date()).getTime();
  if (!Number.isFinite(date) || Math.abs(now - date) > (opts.maxSkewMs ?? 3600_000)) {
    return { ok: false, reason: "date_skew" };
  }
  if (opts.method.toUpperCase() === "POST") {
    if (!signed.includes("digest")) return { ok: false, reason: "unsigned_digest" };
    const dg = h["digest"] ?? "";
    const m = /^SHA-256=(.+)$/i.exec(dg.split(",").map((x) => x.trim()).find((x) => /^SHA-256=/i.test(x)) ?? "");
    if (!m) return { ok: false, reason: "no_sha256_digest" };
    const expected = await digestHeader(opts.body);
    if (expected.slice("SHA-256=".length) !== m[1]) return { ok: false, reason: "digest_mismatch" };
  }
  return { ok: true, keyId: parsed.keyId };
}
