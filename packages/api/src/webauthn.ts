/**
 * WebAuthn (passkeys / security keys) for Workers, replacing upstream's use of
 * `@simplewebauthn/server` 13 in core/WebAuthnService.ts with WebCrypto only:
 *
 * - options in the shape `generateRegistrationOptions` / `generateAuthenticationOptions` emit
 *   (32-byte base64url challenge, timeout 60000, pubKeyCredParams [-8, -7, -257], credProps, …)
 * - registration: clientDataJSON (type / challenge / origin), attestationObject (CBOR),
 *   authenticatorData (rpIdHash, UP / UV flags, attested credential data, COSE key) and the
 *   attestation statement for `none`, `packed` (self attestation, or x5c whose leaf certificate
 *   key must verify the signature; the chain is not checked, as upstream ships no roots) and
 *   `fido-u2f`. Other formats are refused (browsers send `none` for attestation conveyance `none`).
 * - authentication: the same client data / authenticator data checks, the signature counter rule,
 *   and ES256/384/512, RS256/384/512, PS256/384/512, RS1 and EdDSA (Ed25519) signatures.
 *
 * Credential public keys are kept as upstream does: the COSE_Key bytes, base64url.
 */

// ---------------------------------------------------------------- base64url

export function b64uEncode(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function isB64u(s: unknown): s is string {
  return typeof s === "string" && /^[A-Za-z0-9_-]*={0,2}$/.test(s);
}

export function b64uDecode(s: string): Uint8Array {
  if (!isB64u(s)) throw new Error("not base64url");
  const t = s.replace(/=+$/, "").replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(t + "===".slice((t.length + 3) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const utf8 = new TextEncoder();
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};
const equal = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);
/** typed-array → BufferSource (TS 5.7 ArrayBufferLike vs ArrayBuffer) */
const bs = (b: Uint8Array) => b as unknown as BufferSource;
const sha256 = async (b: Uint8Array) => new Uint8Array(await crypto.subtle.digest("SHA-256", bs(b)));

// ---------------------------------------------------------------- CBOR (RFC 8949, the subset WebAuthn uses)

export type CborValue = number | bigint | string | boolean | null | undefined | Uint8Array | CborValue[] | Map<CborValue, CborValue>;

/** Decode the first CBOR item of `buf` at `offset`; returns the value and the offset after it. */
export function cborDecodeFirst(buf: Uint8Array, offset = 0, depth = 0): { value: CborValue; end: number } {
  if (depth > 32) throw new Error("CBOR nesting too deep");
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let p = offset;
  const need = (n: number) => {
    if (p + n > buf.length) throw new Error("CBOR truncated");
  };
  need(1);
  const ib = buf[p++]!;
  const major = ib >> 5;
  const ai = ib & 0x1f;
  const readArg = (): number | bigint => {
    if (ai < 24) return ai;
    if (ai === 24) return need(1), buf[p++]!;
    if (ai === 25) return need(2), (p += 2), dv.getUint16(p - 2);
    if (ai === 26) return need(4), (p += 4), dv.getUint32(p - 4);
    if (ai === 27) {
      need(8);
      const v = dv.getBigUint64(p);
      p += 8;
      return v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v;
    }
    throw new Error("CBOR indefinite lengths are not supported");
  };
  if (major === 7) {
    if (ai === 20) return { value: false, end: p };
    if (ai === 21) return { value: true, end: p };
    if (ai === 22) return { value: null, end: p };
    if (ai === 23) return { value: undefined, end: p };
    if (ai === 25) {
      need(2);
      const h = dv.getUint16(p);
      const e = (h >> 10) & 0x1f;
      const m = h & 0x3ff;
      const v = e === 0 ? m * 2 ** -24 : e === 31 ? (m ? NaN : Infinity) : (1 + m / 1024) * 2 ** (e - 15);
      return { value: h & 0x8000 ? -v : v, end: p + 2 };
    }
    if (ai === 26) return need(4), { value: dv.getFloat32(p), end: p + 4 };
    if (ai === 27) return need(8), { value: dv.getFloat64(p), end: p + 8 };
    throw new Error("CBOR simple value not supported");
  }
  const arg = readArg();
  const len = (): number => {
    if (typeof arg !== "number") throw new Error("CBOR length too large");
    return arg;
  };
  switch (major) {
    case 0:
      return { value: arg, end: p };
    case 1:
      return { value: typeof arg === "number" ? -1 - arg : -1n - arg, end: p };
    case 2: {
      const n = len();
      need(n);
      return { value: buf.slice(p, p + n), end: p + n };
    }
    case 3: {
      const n = len();
      need(n);
      return { value: new TextDecoder("utf-8", { fatal: true }).decode(buf.subarray(p, p + n)), end: p + n };
    }
    case 4: {
      const out: CborValue[] = [];
      for (let i = 0, n = len(); i < n; i++) {
        const r = cborDecodeFirst(buf, p, depth + 1);
        out.push(r.value);
        p = r.end;
      }
      return { value: out, end: p };
    }
    case 5: {
      const out = new Map<CborValue, CborValue>();
      for (let i = 0, n = len(); i < n; i++) {
        const k = cborDecodeFirst(buf, p, depth + 1);
        const v = cborDecodeFirst(buf, k.end, depth + 1);
        out.set(k.value, v.value);
        p = v.end;
      }
      return { value: out, end: p };
    }
    case 6: // tag: the tagged item
      return cborDecodeFirst(buf, p, depth + 1);
  }
  throw new Error("CBOR major type not supported");
}

export function cborDecode(buf: Uint8Array): CborValue {
  const r = cborDecodeFirst(buf);
  if (r.end !== buf.length) throw new Error("CBOR trailing bytes");
  return r.value;
}

/** Minimal canonical-ish CBOR encoder (ints, byte / text strings, arrays, maps, bools, null). */
export function cborEncode(v: CborValue): Uint8Array {
  const head = (major: number, n: number): Uint8Array => {
    if (n < 24) return Uint8Array.of((major << 5) | n);
    if (n < 0x100) return Uint8Array.of((major << 5) | 24, n);
    if (n < 0x10000) return Uint8Array.of((major << 5) | 25, n >> 8, n & 0xff);
    if (n < 0x100000000) return Uint8Array.of((major << 5) | 26, n >>> 24, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff);
    throw new Error("CBOR: value too large");
  };
  if (typeof v === "number") {
    if (!Number.isInteger(v)) throw new Error("CBOR: floats are not supported");
    return v >= 0 ? head(0, v) : head(1, -1 - v);
  }
  if (typeof v === "string") {
    const b = utf8.encode(v);
    return concat(head(3, b.length), b);
  }
  if (v instanceof Uint8Array) return concat(head(2, v.length), v);
  if (Array.isArray(v)) return concat(head(4, v.length), ...v.map(cborEncode));
  if (v instanceof Map) return concat(head(5, v.size), ...[...v].flatMap(([k, x]) => [cborEncode(k), cborEncode(x)]));
  if (v === false) return Uint8Array.of(0xf4);
  if (v === true) return Uint8Array.of(0xf5);
  if (v === null) return Uint8Array.of(0xf6);
  throw new Error("CBOR: unsupported value");
}

// ---------------------------------------------------------------- authenticator data

export type AuthenticatorFlags = { up: boolean; uv: boolean; be: boolean; bs: boolean; at: boolean; ed: boolean };

export type ParsedAuthData = {
  rpIdHash: Uint8Array;
  flags: AuthenticatorFlags;
  counter: number;
  aaguid?: Uint8Array;
  credentialId?: Uint8Array;
  /** the COSE_Key bytes as found in the authenticator data */
  credentialPublicKey?: Uint8Array;
};

export function parseAuthenticatorData(authData: Uint8Array): ParsedAuthData {
  if (authData.length < 37) throw new Error(`Authenticator data was ${authData.length} bytes, expected at least 37 bytes`);
  const dv = new DataView(authData.buffer, authData.byteOffset, authData.byteLength);
  const f = authData[32]!;
  const flags = { up: !!(f & 1), uv: !!(f & 4), be: !!(f & 8), bs: !!(f & 16), at: !!(f & 64), ed: !!(f & 128) };
  const out: ParsedAuthData = { rpIdHash: authData.slice(0, 32), flags, counter: dv.getUint32(33) };
  let p = 37;
  if (flags.at) {
    if (authData.length < p + 18) throw new Error("Attested credential data truncated");
    out.aaguid = authData.slice(p, p + 16);
    const idLen = dv.getUint16(p + 16);
    p += 18;
    if (authData.length < p + idLen) throw new Error("Credential ID truncated");
    out.credentialId = authData.slice(p, p + idLen);
    p += idLen;
    const k = cborDecodeFirst(authData, p);
    if (!(k.value instanceof Map)) throw new Error("Credential public key is not a map");
    out.credentialPublicKey = authData.slice(p, k.end);
    p = k.end;
  }
  if (flags.ed) p = cborDecodeFirst(authData, p).end;
  if (p !== authData.length) throw new Error("Leftover bytes detected while parsing authenticator data");
  return out;
}

/** simplewebauthn parseBackupFlags */
export function backupFlags(flags: AuthenticatorFlags): { credentialDeviceType: "singleDevice" | "multiDevice"; credentialBackedUp: boolean } {
  if (!flags.be && flags.bs) throw new Error("Single-device credential indicated that it was backed up, which should be impossible.");
  return { credentialDeviceType: flags.be ? "multiDevice" : "singleDevice", credentialBackedUp: flags.bs };
}

// ---------------------------------------------------------------- COSE keys and signatures

/** COSE algorithm ids simplewebauthn verifies (supportedCOSEAlgorithmIdentifiers). */
export const SUPPORTED_ALGS = [-8, -7, -36, -37, -38, -39, -257, -258, -259, -65535, -35];

type SigAlg = { import: Record<string, unknown>; verify: Record<string, unknown>; ec?: number };

function sigAlg(alg: number): SigAlg {
  const ec = (crv: string, hash: string, size: number): SigAlg => ({ import: { name: "ECDSA", namedCurve: crv }, verify: { name: "ECDSA", hash }, ec: size });
  const rsa = (hash: string): SigAlg => ({ import: { name: "RSASSA-PKCS1-v1_5", hash }, verify: { name: "RSASSA-PKCS1-v1_5" } });
  const pss = (hash: string, salt: number): SigAlg => ({ import: { name: "RSA-PSS", hash }, verify: { name: "RSA-PSS", saltLength: salt } });
  switch (alg) {
    case -7: return ec("P-256", "SHA-256", 32);
    case -35: return ec("P-384", "SHA-384", 48);
    case -36: return ec("P-521", "SHA-512", 66);
    case -257: return rsa("SHA-256");
    case -258: return rsa("SHA-384");
    case -259: return rsa("SHA-512");
    case -65535: return rsa("SHA-1");
    case -37: return pss("SHA-256", 32);
    case -38: return pss("SHA-384", 48);
    case -39: return pss("SHA-512", 64);
    case -8: return { import: { name: "Ed25519" }, verify: { name: "Ed25519" } };
  }
  throw new Error(`Unsupported COSE alg ${alg}`);
}

export function decodeCoseKey(bytes: Uint8Array): Map<CborValue, CborValue> {
  const m = cborDecode(bytes);
  if (!(m instanceof Map)) throw new Error("COSE key is not a map");
  return m;
}

const EC_CRV: Record<number, string> = { 1: "P-256", 2: "P-384", 3: "P-521" };

async function importCoseKey(cose: Map<CborValue, CborValue>): Promise<{ key: CryptoKey; alg: SigAlg }> {
  const kty = cose.get(1);
  const algId = cose.get(3);
  if (typeof algId !== "number") throw new Error("Credential public key was missing numeric alg");
  const alg = sigAlg(algId);
  const bytes = (k: number) => {
    const v = cose.get(k);
    if (!(v instanceof Uint8Array)) throw new Error(`COSE key parameter ${k} missing`);
    return v;
  };
  let jwk: JsonWebKey;
  if (kty === 2) {
    const crv = EC_CRV[cose.get(-1) as number];
    if (!crv || crv !== (alg.import.namedCurve as string)) throw new Error("COSE EC2 curve does not match alg");
    jwk = { kty: "EC", crv, x: b64uEncode(bytes(-2)), y: b64uEncode(bytes(-3)) };
  } else if (kty === 3) {
    if (alg.ec || algId === -8) throw new Error("COSE RSA key with a non-RSA alg");
    jwk = { kty: "RSA", n: b64uEncode(bytes(-1)), e: b64uEncode(bytes(-2)) };
  } else if (kty === 1) {
    if (algId !== -8 || cose.get(-1) !== 6) throw new Error("Only Ed25519 OKP keys are supported");
    jwk = { kty: "OKP", crv: "Ed25519", x: b64uEncode(bytes(-2)) };
  } else {
    throw new Error(`Unsupported COSE kty ${String(kty)}`);
  }
  const key = await crypto.subtle.importKey("jwk", jwk, alg.import as unknown as Algorithm, false, ["verify"]);
  return { key, alg };
}

/** ASN.1 DER ECDSA signature → IEEE P1363 r || s (what WebCrypto verifies). */
export function derToRawEcdsa(der: Uint8Array, size: number): Uint8Array {
  const fail = () => {
    throw new Error("Malformed ECDSA signature");
  };
  let p = 0;
  const readLen = () => {
    let n = der[p++] ?? fail();
    if (n & 0x80) {
      const c = n & 0x7f;
      n = 0;
      for (let i = 0; i < c; i++) n = (n << 8) | (der[p++] ?? fail());
    }
    return n;
  };
  if (der[p++] !== 0x30) fail();
  const seqLen = readLen();
  if (p + seqLen !== der.length) fail();
  const out = new Uint8Array(size * 2);
  for (let i = 0; i < 2; i++) {
    if (der[p++] !== 0x02) fail();
    const n = readLen();
    let v = der.subarray(p, p + n);
    p += n;
    while (v.length > 0 && v[0] === 0) v = v.subarray(1);
    if (v.length > size) fail();
    out.set(v, size * (i + 1) - v.length);
  }
  if (p !== der.length) fail();
  return out;
}

async function verifyWith(key: CryptoKey, alg: SigAlg, signature: Uint8Array, data: Uint8Array): Promise<boolean> {
  let sig = signature;
  if (alg.ec) {
    try {
      sig = derToRawEcdsa(signature, alg.ec);
    } catch {
      return false;
    }
  }
  return crypto.subtle.verify(alg.verify as unknown as Algorithm, key, bs(sig), bs(data));
}

/** Verify `signature` over `data` with a COSE_Key (simplewebauthn verifySignature). */
export async function verifyCoseSignature(coseKey: Uint8Array, signature: Uint8Array, data: Uint8Array): Promise<boolean> {
  const { key, alg } = await importCoseKey(decodeCoseKey(coseKey));
  return verifyWith(key, alg, signature, data);
}

// ---------------------------------------------------------------- X.509 (just enough to take the leaf key)

function derTlv(buf: Uint8Array, p: number): { tag: number; start: number; end: number; next: number } {
  const tag = buf[p];
  if (tag === undefined) throw new Error("DER truncated");
  let q = p + 1;
  let len = buf[q++];
  if (len === undefined) throw new Error("DER truncated");
  if (len & 0x80) {
    const c = len & 0x7f;
    if (c === 0 || c > 4) throw new Error("DER length not supported");
    len = 0;
    for (let i = 0; i < c; i++) len = len * 256 + (buf[q++] ?? 0);
  }
  if (q + len > buf.length) throw new Error("DER truncated");
  return { tag, start: q, end: q + len, next: q + len };
}

/** SubjectPublicKeyInfo DER of an X.509 certificate. */
export function certificateSpki(cert: Uint8Array): Uint8Array {
  const c = derTlv(cert, 0);
  const tbs = derTlv(cert, c.start);
  let p = tbs.start;
  const fields: { start: number; next: number; tag: number }[] = [];
  while (p < tbs.end && fields.length < 8) {
    const t = derTlv(cert, p);
    fields.push({ start: p, next: t.next, tag: t.tag });
    p = t.next;
  }
  const i = fields[0]?.tag === 0xa0 ? 6 : 5; // [version], serial, signature, issuer, validity, subject, spki
  const f = fields[i];
  if (!f || f.tag !== 0x30) throw new Error("Certificate has no subjectPublicKeyInfo");
  return cert.slice(f.start, f.next);
}

async function verifyWithCertificate(cert: Uint8Array, algId: number, signature: Uint8Array, data: Uint8Array): Promise<boolean> {
  const alg = sigAlg(algId);
  const key = await crypto.subtle.importKey("spki", bs(certificateSpki(cert)), alg.import as unknown as Algorithm, false, ["verify"]);
  return verifyWith(key, alg, signature, data);
}

// ---------------------------------------------------------------- options

export type RelyingParty = { origin: string; rpId: string; rpName: string };

export function relyingParty(instanceUrl: string, name: string | null | undefined): RelyingParty {
  const u = new URL(instanceUrl);
  return { origin: u.origin, rpId: u.hostname, rpName: name ?? u.host };
}

export function generateChallenge(): string {
  return b64uEncode(crypto.getRandomValues(new Uint8Array(32)));
}

type CredDescriptor = { id: string; transports?: string[] | null };
const descriptor = (k: CredDescriptor) => ({
  id: k.id.replace(/=+$/, ""),
  ...(k.transports ? { transports: k.transports } : { transports: undefined }),
  type: "public-key" as const,
});

/** generateRegistrationOptions as WebAuthnService.initiateRegistration calls it. */
export function registrationOptions(rp: RelyingParty, user: { id: string; name: string; displayName?: string }, exclude: CredDescriptor[], challenge = generateChallenge()) {
  return {
    challenge,
    rp: { name: rp.rpName, id: rp.rpId },
    user: { id: b64uEncode(utf8.encode(user.id)), name: user.name, displayName: user.displayName ?? "" },
    pubKeyCredParams: [-8, -7, -257].map((alg) => ({ alg, type: "public-key" as const })),
    timeout: 60000,
    attestation: "none" as const,
    excludeCredentials: exclude.map(descriptor),
    authenticatorSelection: { residentKey: "required" as const, userVerification: "preferred" as const, requireResidentKey: true },
    extensions: { credProps: true },
    hints: [] as string[],
  };
}

/** generateAuthenticationOptions (allowCredentials omitted for usernameless passkey sign-in). */
export function authenticationOptions(rp: RelyingParty, allow: CredDescriptor[] | undefined, challenge = generateChallenge()) {
  return {
    rpId: rp.rpId,
    challenge,
    allowCredentials: allow?.map(descriptor),
    timeout: 60000,
    userVerification: "preferred" as const,
    extensions: undefined,
  };
}

// ---------------------------------------------------------------- verification

type ClientData = { type?: unknown; challenge?: unknown; origin?: unknown; tokenBinding?: unknown };

function checkClientData(clientDataJSON: unknown, type: string, challenge: string, origin: string): Uint8Array {
  if (typeof clientDataJSON !== "string") throw new Error("Credential response clientDataJSON was not a string");
  const raw = b64uDecode(clientDataJSON);
  let cd: ClientData;
  try {
    cd = JSON.parse(new TextDecoder().decode(raw)) as ClientData;
  } catch {
    throw new Error("clientDataJSON is not JSON");
  }
  if (cd.type !== type) throw new Error(`Unexpected response type: ${String(cd.type)}`);
  if (cd.challenge !== challenge) throw new Error(`Unexpected response challenge "${String(cd.challenge)}", expected "${challenge}"`);
  if (cd.origin !== origin) throw new Error(`Unexpected response origin "${String(cd.origin)}", expected "${origin}"`);
  if (cd.tokenBinding != null) {
    const st = (cd.tokenBinding as { status?: unknown }).status;
    if (typeof cd.tokenBinding !== "object" || !["present", "supported", "not-supported", "notSupported"].includes(String(st))) {
      throw new Error("Unexpected tokenBinding");
    }
  }
  return raw;
}

function checkEnvelope(response: unknown): { id: string; inner: Record<string, unknown> } {
  const r = response as Record<string, unknown> | null;
  if (!r || typeof r !== "object") throw new Error("Credential missing");
  if (typeof r.id !== "string" || !r.id) throw new Error("Missing credential ID");
  if (r.id !== r.rawId) throw new Error("Credential ID was not base64url-encoded");
  if (!isB64u(r.id)) throw new Error("Credential ID was not base64url-encoded");
  if (r.type !== "public-key") throw new Error(`Unexpected credential type ${String(r.type)}, expected "public-key"`);
  const inner = r.response as Record<string, unknown> | null;
  if (!inner || typeof inner !== "object") throw new Error("Credential missing response");
  return { id: r.id, inner };
}

export type RegistrationInfo = {
  credentialId: string;
  credentialPublicKey: Uint8Array;
  fmt: string;
  counter: number;
  userVerified: boolean;
  credentialDeviceType: "singleDevice" | "multiDevice";
  credentialBackedUp: boolean;
  transports: string[] | null;
};

/** verifyRegistrationResponse with requireUserVerification: true. Throws on any failure. */
export async function verifyRegistrationResponse(response: unknown, expected: { challenge: string; origin: string; rpId: string }): Promise<RegistrationInfo> {
  const { inner } = checkEnvelope(response);
  const clientData = checkClientData(inner.clientDataJSON, "webauthn.create", expected.challenge, expected.origin);
  if (!isB64u(inner.attestationObject)) throw new Error("attestationObject was not base64url");
  const att = cborDecode(b64uDecode(inner.attestationObject));
  if (!(att instanceof Map)) throw new Error("attestationObject is not a map");
  const fmt = att.get("fmt");
  const authData = att.get("authData");
  const attStmt = att.get("attStmt");
  if (typeof fmt !== "string" || !(authData instanceof Uint8Array) || !(attStmt instanceof Map)) throw new Error("Malformed attestationObject");
  const parsed = parseAuthenticatorData(authData);
  if (!equal(parsed.rpIdHash, await sha256(utf8.encode(expected.rpId)))) throw new Error("Unexpected RP ID hash");
  if (!parsed.flags.up) throw new Error("User presence was required, but user was not present");
  if (!parsed.flags.uv) throw new Error("User verification was required, but user could not be verified");
  const { credentialId, credentialPublicKey, aaguid } = parsed;
  if (!credentialId || !credentialPublicKey || !aaguid) throw new Error("No attested credential data");
  const cose = decodeCoseKey(credentialPublicKey);
  const alg = cose.get(3);
  if (typeof alg !== "number") throw new Error("Credential public key was missing numeric alg");
  if (!SUPPORTED_ALGS.includes(alg)) throw new Error(`Unexpected public key alg "${alg}"`);
  await importCoseKey(cose); // the key must be usable
  const clientDataHash = await sha256(clientData);

  let verified = false;
  if (fmt === "none") {
    if (attStmt.size > 0) throw new Error("None attestation had unexpected attestation statement");
    verified = true;
  } else if (fmt === "packed") {
    const sig = attStmt.get("sig");
    const stmtAlg = attStmt.get("alg");
    const x5c = attStmt.get("x5c");
    if (!(sig instanceof Uint8Array) || typeof stmtAlg !== "number") throw new Error("Packed attestation statement malformed");
    const data = concat(authData, clientDataHash);
    if (Array.isArray(x5c) && x5c.length > 0) {
      if (!(x5c[0] instanceof Uint8Array)) throw new Error("x5c malformed");
      verified = await verifyWithCertificate(x5c[0], stmtAlg, sig, data);
    } else {
      if (stmtAlg !== alg) throw new Error("Attestation statement alg does not match the credential key alg");
      verified = await verifyCoseSignature(credentialPublicKey, sig, data);
    }
  } else if (fmt === "fido-u2f") {
    const sig = attStmt.get("sig");
    const x5c = attStmt.get("x5c");
    if (!(sig instanceof Uint8Array) || !Array.isArray(x5c) || x5c.length !== 1 || !(x5c[0] instanceof Uint8Array)) throw new Error("FIDO U2F attestation statement malformed");
    if (aaguid.some((b) => b !== 0)) throw new Error("AAGUID was not expected value");
    const x = cose.get(-2);
    const y = cose.get(-3);
    if (cose.get(1) !== 2 || alg !== -7 || !(x instanceof Uint8Array) || !(y instanceof Uint8Array)) throw new Error("FIDO U2F needs an ES256 key");
    const data = concat(Uint8Array.of(0), parsed.rpIdHash, clientDataHash, credentialId, Uint8Array.of(4), x, y);
    verified = await verifyWithCertificate(x5c[0], -7, sig, data);
  } else {
    throw new Error(`Unsupported Attestation Format: ${fmt}`);
  }
  if (!verified) throw new Error("Attestation signature verification failed");
  const transports = Array.isArray(inner.transports) && inner.transports.every((t) => typeof t === "string") ? (inner.transports as string[]) : null;
  return {
    credentialId: b64uEncode(credentialId),
    credentialPublicKey,
    fmt,
    counter: parsed.counter,
    userVerified: parsed.flags.uv,
    ...backupFlags(parsed.flags),
    transports,
  };
}

export type AuthenticationInfo = {
  verified: boolean;
  newCounter: number;
  credentialDeviceType: "singleDevice" | "multiDevice";
  credentialBackedUp: boolean;
};

/**
 * verifyAuthenticationResponse with requireUserVerification: true. Throws on malformed input,
 * a mismatched challenge / origin / RP ID, missing UP / UV, or a counter that did not advance;
 * `verified` is the signature check.
 */
export async function verifyAuthenticationResponse(
  response: unknown,
  expected: { challenge: string; origin: string; rpId: string },
  credential: { publicKey: Uint8Array; counter: number },
): Promise<AuthenticationInfo> {
  const { inner } = checkEnvelope(response);
  const clientData = checkClientData(inner.clientDataJSON, "webauthn.get", expected.challenge, expected.origin);
  if (!isB64u(inner.authenticatorData)) throw new Error("Credential response authenticatorData was not a base64url string");
  if (!isB64u(inner.signature)) throw new Error("Credential response signature was not a base64url string");
  if (inner.userHandle != null && typeof inner.userHandle !== "string") throw new Error("Credential response userHandle was not a string");
  const authData = b64uDecode(inner.authenticatorData);
  const parsed = parseAuthenticatorData(authData);
  if (!equal(parsed.rpIdHash, await sha256(utf8.encode(expected.rpId)))) throw new Error("Unexpected RP ID hash");
  if (!parsed.flags.up) throw new Error("User not present during authentication");
  if (!parsed.flags.uv) throw new Error("User verification required, but user could not be verified");
  if ((parsed.counter > 0 || credential.counter > 0) && parsed.counter <= credential.counter) {
    throw new Error(`Response counter value ${parsed.counter} was lower than expected ${credential.counter}`);
  }
  const flags = backupFlags(parsed.flags);
  const verified = await verifyCoseSignature(credential.publicKey, b64uDecode(inner.signature), concat(authData, await sha256(clientData)));
  return { verified, newCounter: parsed.counter, ...flags };
}

/**
 * WebAuthnService.verifyAuthentication's migration of keys stored by the pre-13 implementation
 * (an uncompressed P-256 point, 65 bytes → 87 base64url chars) into a COSE_Key.
 */
export function migrateLegacyPublicKey(publicKey: string, counter: number): string | null {
  if (counter !== 0 || publicKey.length !== 87) return null;
  const cert = b64uDecode(publicKey);
  if (cert[0] !== 0x04) return null;
  const half = (cert.length - 1) / 2;
  const m = new Map<CborValue, CborValue>([
    [1, 2],
    [3, -7],
    [-1, 1],
    [-2, cert.slice(1, half + 1)],
    [-3, cert.slice(half + 1)],
  ]);
  return b64uEncode(cborEncode(m));
}
