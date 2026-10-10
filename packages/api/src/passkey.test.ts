/**
 * Passkeys / security keys (WebAuthn) on PGlite with a software authenticator built here from
 * WebCrypto (P-256 / Ed25519 / RSA keys, CBOR attestation objects, DER ECDSA signatures):
 * i/2fa/register-key → key-done (attestation `none` and `packed` self attestation), MeDetailed
 * securityKeys / securityKeysList, update-key, signin-flow `next: "passkey"` + `credential`,
 * password-less login, POST /api/signin-with-passkey, counter / challenge / origin checks,
 * legacy key migration, remove-key, and the OnceGuard value store.
 */
import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";
import { IMPLEMENTED_ENDPOINTS } from "./registry.js";
import { fakeDoNamespace, makeFixture, type Fixture } from "./pglite-fixture.js";
import { OnceGuard, putOnce, takeOnce } from "./once-guard.js";
import { handlers } from "./endpoints/index.js";
import type { ApiEnv } from "./env.js";
import { ENDPOINT_PARAM_DEFS } from "./endpoint-params.gen.js";
import {
  b64uDecode,
  b64uEncode,
  cborDecode,
  cborEncode,
  derToRawEcdsa,
  parseAuthenticatorData,
  verifyCoseSignature,
  type CborValue,
} from "./webauthn.js";

const ORIGIN = "https://misskey.example.com";
const RP_ID = "misskey.example.com";
const te = new TextEncoder();
const bs = (b: Uint8Array) => b as unknown as BufferSource;
const sha256 = async (b: Uint8Array) => new Uint8Array(await crypto.subtle.digest("SHA-256", bs(b)));
const cat = (...p: Uint8Array[]) => {
  const o = new Uint8Array(p.reduce((n, x) => n + x.length, 0));
  let i = 0;
  for (const x of p) o.set(x, i), (i += x.length);
  return o;
};
const u32 = (n: number) => Uint8Array.of(n >>> 24, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff);

/** IEEE P1363 r||s → ASN.1 DER (what authenticators send). */
function rawToDer(raw: Uint8Array): Uint8Array {
  const int = (b: Uint8Array) => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    let v = b.slice(i);
    if (v[0]! & 0x80) v = cat(Uint8Array.of(0), v);
    return cat(Uint8Array.of(2, v.length), v);
  };
  const h = raw.length / 2;
  const body = cat(int(raw.slice(0, h)), int(raw.slice(h)));
  return cat(Uint8Array.of(0x30, body.length), body);
}

/** A software authenticator holding one ES256 credential. */
class SoftKey {
  counter = 0;
  constructor(readonly id: Uint8Array, readonly pair: CryptoKeyPair, readonly cose: Uint8Array, readonly xy: Uint8Array) {}

  static async create(): Promise<SoftKey> {
    const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
    const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
    const x = b64uDecode(jwk.x!);
    const y = b64uDecode(jwk.y!);
    const cose = cborEncode(new Map<CborValue, CborValue>([[1, 2], [3, -7], [-1, 1], [-2, x], [-3, y]]));
    return new SoftKey(crypto.getRandomValues(new Uint8Array(16)), pair, cose, cat(Uint8Array.of(4), x, y));
  }

  get idB64() {
    return b64uEncode(this.id);
  }

  async sign(data: Uint8Array) {
    return rawToDer(new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, this.pair.privateKey, bs(data))));
  }

  /** navigator.credentials.create() → RegistrationResponseJSON */
  async attest(challenge: string, o: { origin?: string; fmt?: "none" | "packed"; flags?: number } = {}) {
    const clientData = te.encode(JSON.stringify({ type: "webauthn.create", challenge, origin: o.origin ?? ORIGIN, crossOrigin: false }));
    const authData = cat(await sha256(te.encode(RP_ID)), Uint8Array.of(o.flags ?? 0x45), u32(0), new Uint8Array(16), Uint8Array.of(0, this.id.length), this.id, this.cose);
    const attStmt = new Map<CborValue, CborValue>();
    if (o.fmt === "packed") {
      attStmt.set("alg", -7);
      attStmt.set("sig", await this.sign(cat(authData, await sha256(clientData))));
    }
    const attestationObject = cborEncode(new Map<CborValue, CborValue>([["fmt", o.fmt ?? "none"], ["attStmt", attStmt], ["authData", authData]]));
    return {
      id: this.idB64,
      rawId: this.idB64,
      type: "public-key",
      response: { clientDataJSON: b64uEncode(clientData), attestationObject: b64uEncode(attestationObject), transports: ["internal", "hybrid"] },
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
    };
  }

  /** navigator.credentials.get() → AuthenticationResponseJSON */
  async assert(challenge: string, o: { origin?: string; counter?: number; flags?: number; tamper?: boolean } = {}) {
    this.counter = o.counter ?? this.counter + 1;
    const clientData = te.encode(JSON.stringify({ type: "webauthn.get", challenge, origin: o.origin ?? ORIGIN }));
    const authData = cat(await sha256(te.encode(RP_ID)), Uint8Array.of(o.flags ?? 0x05), u32(this.counter));
    const sig = await this.sign(cat(authData, await sha256(clientData)));
    if (o.tamper) sig[sig.length - 1] ^= 1;
    return {
      id: this.idB64,
      rawId: this.idB64,
      type: "public-key",
      response: { clientDataJSON: b64uEncode(clientData), authenticatorData: b64uEncode(authData), signature: b64uEncode(sig), userHandle: null },
      clientExtensionResults: {},
    };
  }
}

let f: Fixture;
const BACKUP = Array.from({ length: 30 }, (_, i) => `backup${i}`);
let nextBackup = 0;
const backup = () => BACKUP[nextBackup++]!;

before(async () => {
  f = await makeFixture("PasskeyTest", { ONCE_GUARD: fakeDoNamespace((s) => new OnceGuard(s)) as unknown as ApiEnv["ONCE_GUARD"] });
  await f.db.query(`UPDATE user_profile SET password = $1`, [await bcrypt.hash("pw", 4)]);
  await f.db.query(`UPDATE user_profile SET "twoFactorEnabled" = TRUE, "twoFactorSecret" = 'JBSWY3DPEHPK3PXP', "twoFactorBackupSecret" = $2::varchar[] WHERE "userId" = $1`, [f.ids.b, BACKUP]);
});

const E = (r: { data: any }) => r.data?.error?.id;
const req = (path: string) => new Request(`https://api.test/api/${path}`, { method: "POST", headers: { "cf-connecting-ip": "203.0.113.7", "user-agent": "test" } });
async function special(name: string, body: Record<string, unknown>) {
  const r = await handlers[name]!(f.env, body, { hasCredential: false, request: req(name) });
  if (r instanceof Response) return { status: r.status, data: (await r.json()) as any };
  return { status: 200, data: r as any };
}
const signin = (body: Record<string, unknown>) => special("signin-flow", body);

describe("WebAuthn primitives", () => {
  it("CBOR decode / encode", () => {
    assert.deepEqual(cborDecode(Uint8Array.of(0x83, 0x01, 0x20, 0x41, 0xff)), [1, -1, Uint8Array.of(0xff)]);
    assert.equal(cborDecode(Uint8Array.of(0x19, 0x01, 0x00)), 256);
    assert.equal(cborDecode(Uint8Array.of(0x39, 0x01, 0x00)), -257);
    assert.equal(cborDecode(Uint8Array.of(0x63, 0x61, 0x62, 0x63)), "abc");
    assert.equal(cborDecode(Uint8Array.of(0xf9, 0x3c, 0x00)), 1); // half float
    const m = new Map<CborValue, CborValue>([[1, 2], [-1, "x"], ["k", [true, null]]]);
    assert.deepEqual(cborDecode(cborEncode(m)), m);
    assert.throws(() => cborDecode(Uint8Array.of(0x01, 0x02)), /trailing/);
    assert.throws(() => cborDecode(Uint8Array.of(0x42, 0x01)), /truncated/);
  });

  it("authenticator data flags / attested credential / leftover bytes", async () => {
    const k = await SoftKey.create();
    const ad = cat(new Uint8Array(32), Uint8Array.of(0x5d), u32(7), new Uint8Array(16), Uint8Array.of(0, 16), k.id, k.cose);
    const p = parseAuthenticatorData(ad);
    assert.deepEqual(p.flags, { up: true, uv: true, be: true, bs: true, at: true, ed: false });
    assert.equal(p.counter, 7);
    assert.deepEqual(p.credentialId, k.id);
    assert.deepEqual(p.credentialPublicKey, k.cose);
    assert.throws(() => parseAuthenticatorData(cat(ad, Uint8Array.of(0))), /Leftover/);
  });

  it("signatures: ES256 (DER), EdDSA, RS256", async () => {
    const data = te.encode("hello");
    const k = await SoftKey.create();
    const der = await k.sign(data);
    assert.equal(derToRawEcdsa(der, 32).length, 64);
    assert.equal(await verifyCoseSignature(k.cose, der, data), true);
    assert.equal(await verifyCoseSignature(k.cose, der, te.encode("hellO")), false);

    const ed = (await crypto.subtle.generateKey({ name: "Ed25519" } as Algorithm, true, ["sign", "verify"])) as CryptoKeyPair;
    const edX = b64uDecode((await crypto.subtle.exportKey("jwk", ed.publicKey)).x!);
    const edCose = cborEncode(new Map<CborValue, CborValue>([[1, 1], [3, -8], [-1, 6], [-2, edX]]));
    const edSig = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" } as Algorithm, ed.privateKey, bs(data)));
    assert.equal(await verifyCoseSignature(edCose, edSig, data), true);

    const rsa = (await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: Uint8Array.of(1, 0, 1), hash: "SHA-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
    const rj = await crypto.subtle.exportKey("jwk", rsa.publicKey);
    const rsaCose = cborEncode(new Map<CborValue, CborValue>([[1, 3], [3, -257], [-1, b64uDecode(rj.n!)], [-2, b64uDecode(rj.e!)]]));
    const rsaSig = new Uint8Array(await crypto.subtle.sign({ name: "RSASSA-PKCS1-v1_5" }, rsa.privateKey, bs(data)));
    assert.equal(await verifyCoseSignature(rsaCose, rsaSig, data), true);
  });

  it("OnceGuard value store: single use, TTL, overwrite", async () => {
    const env = { ONCE_GUARD: fakeDoNamespace((s) => new OnceGuard(s)) } as unknown as ApiEnv;
    await putOnce(env, "a", "1", 60);
    await putOnce(env, "a", "2", 60);
    assert.equal(await takeOnce(env, "a"), "2");
    assert.equal(await takeOnce(env, "a"), null);
    await putOnce(env, "b", "x", 0.001);
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(await takeOnce(env, "b"), null);
    // without the binding: isolate memory
    await putOnce({} as ApiEnv, "c", "y", 60);
    assert.equal(await takeOnce({} as ApiEnv, "c"), "y");
    assert.equal(await takeOnce({} as ApiEnv, "c"), null);
  });
});

describe("passkeys", () => {
  let key: SoftKey;

  it("registers endpoints", () => {
    for (const e of ["i/2fa/register-key", "i/2fa/key-done", "i/2fa/update-key", "i/2fa/remove-key", "signin-with-passkey"]) {
      assert.ok((IMPLEMENTED_ENDPOINTS as readonly string[]).includes(e), e);
      // signin-with-passkey is an ApiServerService route outside upstream's endpoint list (no paramDef)
      if (e !== "signin-with-passkey") assert.ok(ENDPOINT_PARAM_DEFS[e], e);
      assert.ok(handlers[e], e);
    }
  });

  it("register-key: password, 2FA token and 2FA required", async () => {
    assert.equal(E(await f.call("i/2fa/register-key", { password: "pw" }, "c")), "bf32b864-449b-47b8-974e-f9a5468546f1");
    assert.equal(E(await f.call("i/2fa/register-key", { password: "nope" }, "c")), "38769596-efe2-4faf-9bec-abbb3f2cd9ba");
    assert.equal((await f.call("i/2fa/register-key", { password: "pw" }, "b")).status, 500); // token missing
    assert.equal((await f.call("i/2fa/register-key", { password: "pw", token: "000000" }, "b")).status, 500);
    assert.equal((await f.call("i/2fa/register-key", {}, "b")).status, 400);
    // `secure`: anonymous → ACCESS_DENIED (upstream isSecure needs a user)
    assert.equal(E(await f.call("i/2fa/register-key", { password: "pw" })), "56f35758-7dd5-468b-8439-5d6fb8ec9b8e");
  });

  it("register-key → key-done (attestation none)", async () => {
    key = await SoftKey.create();
    const opt = (await f.call("i/2fa/register-key", { password: "pw", token: backup() }, "b")).data;
    assert.equal(opt.rp.id, RP_ID);
    assert.equal(opt.rp.name, "PasskeyTest");
    assert.equal(opt.user.id, b64uEncode(te.encode(f.ids.b)));
    assert.equal(opt.user.name, "user_b");
    assert.equal(opt.user.displayName, "");
    assert.equal(b64uDecode(opt.challenge).length, 32);
    assert.deepEqual(opt.pubKeyCredParams.map((p: any) => p.alg), [-8, -7, -257]);
    assert.deepEqual(opt.authenticatorSelection, { residentKey: "required", userVerification: "preferred", requireResidentKey: true });
    assert.equal(opt.attestation, "none");
    assert.deepEqual(opt.excludeCredentials, []);

    const cred = await key.attest(opt.challenge);
    assert.equal(E(await f.call("i/2fa/key-done", { password: "nope", token: backup(), name: "k", credential: cred }, "b")), "0d7ec6d2-e652-443e-a7bf-9ee9a0cd77b0");
    assert.equal((await f.call("i/2fa/key-done", { password: "pw", token: backup(), name: "", credential: cred }, "b")).status, 400);
    const done = await f.call("i/2fa/key-done", { password: "pw", token: backup(), name: "Phone", credential: cred }, "b");
    assert.equal(done.status, 200, JSON.stringify(done.data));
    assert.deepEqual(done.data, { id: key.idB64, name: "Phone" });
    const row = (await f.db.query(`SELECT * FROM user_security_key WHERE id = $1`, [key.idB64])).rows[0] as any;
    assert.equal(row.userId, f.ids.b);
    assert.equal(row.publicKey, b64uEncode(key.cose));
    assert.equal(Number(row.counter), 0);
    assert.equal(row.credentialDeviceType, "singleDevice");
    assert.equal(row.credentialBackedUp, false);
    assert.deepEqual(row.transports, ["internal", "hybrid"]);

    // the challenge was single-use
    const again = await f.call("i/2fa/key-done", { password: "pw", token: backup(), name: "Phone", credential: cred }, "b");
    assert.equal(again.status, 500);
    assert.equal(again.data.error.info.e.message, "challenge not found");
  });

  it("key-done refuses a wrong origin, missing UV and a bad packed signature; packed self attestation works", async () => {
    const other = await SoftKey.create();
    let opt = (await f.call("i/2fa/register-key", { password: "pw", token: backup() }, "b")).data;
    assert.deepEqual(opt.excludeCredentials, [{ id: key.idB64, transports: ["internal", "hybrid"], type: "public-key" }]);
    let r = await f.call("i/2fa/key-done", { password: "pw", token: backup(), name: "x", credential: await other.attest(opt.challenge, { origin: "https://evil.example" }) }, "b");
    assert.equal(r.data.error.info.e.message, "verification failed");

    opt = (await f.call("i/2fa/register-key", { password: "pw", token: backup() }, "b")).data;
    r = await f.call("i/2fa/key-done", { password: "pw", token: backup(), name: "x", credential: await other.attest(opt.challenge, { flags: 0x41 }) }, "b");
    assert.equal(r.status, 500); // no UV

    opt = (await f.call("i/2fa/register-key", { password: "pw", token: backup() }, "b")).data;
    const bad = await other.attest(opt.challenge, { fmt: "packed" });
    const att = cborDecode(b64uDecode(bad.response.attestationObject)) as Map<CborValue, CborValue>;
    ((att.get("attStmt") as Map<CborValue, CborValue>).get("sig") as Uint8Array)[10] ^= 1;
    bad.response.attestationObject = b64uEncode(cborEncode(att));
    r = await f.call("i/2fa/key-done", { password: "pw", token: backup(), name: "x", credential: bad }, "b");
    assert.equal(r.status, 500);

    opt = (await f.call("i/2fa/register-key", { password: "pw", token: backup() }, "b")).data;
    r = await f.call("i/2fa/key-done", { password: "pw", token: backup(), name: "Key 2", credential: await other.attest(opt.challenge, { fmt: "packed" }) }, "b");
    assert.equal(r.status, 200, JSON.stringify(r.data));
    await f.db.query(`DELETE FROM user_security_key WHERE id = $1`, [other.idB64]);
  });

  it("MeDetailed securityKeys / securityKeysList; update-key", async () => {
    const me = (await f.call("i", {}, "b")).data;
    assert.equal(me.securityKeys, true);
    assert.deepEqual(me.securityKeysList.map((k: any) => [k.id, k.name]), [[key.idB64, "Phone"]]);
    assert.ok(!Number.isNaN(Date.parse(me.securityKeysList[0].lastUsed)));
    const c = (await f.call("i", {}, "c")).data;
    assert.equal(c.securityKeys, false);
    assert.deepEqual(c.securityKeysList, []);

    assert.equal(E(await f.call("i/2fa/update-key", { credentialId: "nope", name: "x" }, "b")), "f9c5467f-d492-4d3c-9a8g-a70dacc86512");
    assert.equal(E(await f.call("i/2fa/update-key", { credentialId: key.idB64, name: "x" }, "c")), "1fb7cb09-d46a-4fff-b8df-057708cce513");
    assert.equal((await f.call("i/2fa/update-key", { credentialId: key.idB64, name: "a".repeat(31) }, "b")).status, 400);
    assert.deepEqual((await f.call("i/2fa/update-key", { credentialId: key.idB64, name: "Laptop" }, "b")).data, {});
    assert.equal(((await f.db.query(`SELECT name FROM user_security_key WHERE id = $1`, [key.idB64])).rows[0] as any).name, "Laptop");
  });

  it("signin-flow: next passkey, then the assertion signs in (counter, replay, bad signature)", async () => {
    assert.deepEqual((await signin({ username: "user_b" })).data, { finished: false, next: "password" });
    assert.equal(E(await signin({ username: "user_b", password: "nope" })), "932c904e-9460-45b7-9ce6-7ed33be7eb2c");
    const step = (await signin({ username: "user_b", password: "pw" })).data;
    assert.equal(step.next, "passkey");
    assert.equal(step.authRequest.rpId, RP_ID);
    assert.equal(step.authRequest.userVerification, "preferred");
    assert.deepEqual(step.authRequest.allowCredentials, [{ id: key.idB64, transports: ["internal", "hybrid"], type: "public-key" }]);

    const cred = await key.assert(step.authRequest.challenge);
    const ok = await signin({ username: "user_b", password: "pw", credential: cred });
    assert.deepEqual(ok.data, { finished: true, id: f.ids.b, i: "bbbbbbbbbbbbbbbb" });
    const row = (await f.db.query(`SELECT counter, "lastUsed" FROM user_security_key WHERE id = $1`, [key.idB64])).rows[0] as any;
    assert.equal(Number(row.counter), 1);
    const hist = (await f.db.query(`SELECT success FROM signin WHERE "userId" = $1 ORDER BY id DESC LIMIT 1`, [f.ids.b])).rows[0] as any;
    assert.equal(hist.success, true);

    // the challenge is gone
    const replay = await signin({ username: "user_b", password: "pw", credential: cred });
    assert.equal(replay.status, 500);
    assert.equal(E(replay), "2d16e51c-007b-4edd-afd2-f7dd02c947f6");

    // a bad signature
    let ch = (await signin({ username: "user_b", password: "pw" })).data.authRequest.challenge;
    assert.equal(E(await signin({ username: "user_b", password: "pw", credential: await key.assert(ch, { tamper: true }) })), "93b86c4b-72f9-40eb-9815-798928603d1e");
    // a counter that did not advance
    ch = (await signin({ username: "user_b", password: "pw" })).data.authRequest.challenge;
    assert.equal(E(await signin({ username: "user_b", password: "pw", credential: await key.assert(ch, { counter: 1 }) })), "b18c89a7-5b5e-4cec-bb5b-0419f332d430");
    // wrong origin / no UV
    ch = (await signin({ username: "user_b", password: "pw" })).data.authRequest.challenge;
    assert.equal(E(await signin({ username: "user_b", password: "pw", credential: await key.assert(ch, { origin: "https://evil.example", counter: 10 }) })), "b18c89a7-5b5e-4cec-bb5b-0419f332d430");
    ch = (await signin({ username: "user_b", password: "pw" })).data.authRequest.challenge;
    assert.equal(E(await signin({ username: "user_b", password: "pw", credential: await key.assert(ch, { flags: 0x01, counter: 11 }) })), "b18c89a7-5b5e-4cec-bb5b-0419f332d430");
    // TOTP / backup codes still work alongside
    assert.equal((await signin({ username: "user_b", password: "pw", token: backup() })).data.finished, true);
    // wrong password with a credential and password-less off
    assert.equal(E(await signin({ username: "user_b", password: "nope", credential: cred })), "932c904e-9460-45b7-9ce6-7ed33be7eb2c");
  });

  it("password-less: wrong password still reaches the passkey step", async () => {
    assert.equal((await f.call("i/2fa/password-less", { value: true }, "b")).status, 204);
    assert.equal((await f.call("i", {}, "b")).data.usePasswordLessLogin, true);
    const step = (await signin({ username: "user_b", password: "" })).data;
    assert.equal(step.next, "passkey");
    const ok = await signin({ username: "user_b", password: "", credential: await key.assert(step.authRequest.challenge, { counter: 20 }) });
    assert.equal(ok.data.finished, true, JSON.stringify(ok.data));
  });

  it("signin-with-passkey (usernameless)", async () => {
    const start = (await special("signin-with-passkey", {})).data;
    assert.match(start.context, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(start.option.rpId, RP_ID);
    assert.equal(start.option.allowCredentials, undefined);
    assert.equal(E(await special("signin-with-passkey", { credential: {}, context: "nope" })), "1658cc2e-4495-461f-aee4-d403cdf073c1");

    const cred = await key.assert(start.option.challenge, { counter: 30 });
    const ok = await special("signin-with-passkey", { credential: cred, context: start.context });
    assert.deepEqual(ok.data, { signinResponse: { finished: true, id: f.ids.b, i: "bbbbbbbbbbbbbbbb" } });
    // context consumed
    const again = await special("signin-with-passkey", { credential: cred, context: start.context });
    assert.equal(again.status, 403);
    assert.equal(E(again), "2d16e51c-007b-4edd-afd2-f7dd02c947f6");
    // unknown key
    const s2 = (await special("signin-with-passkey", {})).data;
    const stranger = await SoftKey.create();
    assert.equal(E(await special("signin-with-passkey", { credential: await stranger.assert(s2.option.challenge), context: s2.context })), "36b96a7d-b547-412d-aeed-2d611cdc8cdc");
    // password-less off
    await f.call("i/2fa/password-less", { value: false }, "b");
    const s3 = (await special("signin-with-passkey", {})).data;
    const off = await special("signin-with-passkey", { credential: await key.assert(s3.option.challenge, { counter: 40 }), context: s3.context });
    assert.equal(off.status, 403);
    assert.equal(E(off), "2d84773e-f7b7-4d0b-8f72-bb69b584c912");
  });

  it("legacy public keys (raw P-256 point) are migrated to COSE on use", async () => {
    const legacy = await SoftKey.create();
    await f.db.query(`INSERT INTO user_security_key (id, "userId", "publicKey", name) VALUES ($1, $2, $3, 'old')`, [legacy.idB64, f.ids.b, b64uEncode(legacy.xy)]);
    const step = (await signin({ username: "user_b", password: "pw" })).data;
    const ok = await signin({ username: "user_b", password: "pw", credential: await legacy.assert(step.authRequest.challenge) });
    assert.equal(ok.data.finished, true, JSON.stringify(ok.data));
    const row = (await f.db.query(`SELECT "publicKey" FROM user_security_key WHERE id = $1`, [legacy.idB64])).rows[0] as any;
    assert.equal(row.publicKey, b64uEncode(legacy.cose));
  });

  it("remove-key: password-less is turned off with the last key", async () => {
    await f.call("i/2fa/password-less", { value: true }, "b");
    assert.equal(E(await f.call("i/2fa/remove-key", { password: "nope", token: backup(), credentialId: key.idB64 }, "b")), "141c598d-a825-44c8-9173-cfb9d92be493");
    assert.deepEqual((await f.call("i/2fa/remove-key", { password: "pw", token: backup(), credentialId: key.idB64 }, "b")).data, {});
    assert.equal((await f.call("i", {}, "b")).data.usePasswordLessLogin, true); // the legacy key is left
    const legacyId = ((await f.db.query(`SELECT id FROM user_security_key WHERE "userId" = $1`, [f.ids.b])).rows[0] as any).id;
    assert.deepEqual((await f.call("i/2fa/remove-key", { password: "pw", token: backup(), credentialId: legacyId }, "b")).data, {});
    const me = (await f.call("i", {}, "b")).data;
    assert.equal(me.usePasswordLessLogin, false);
    assert.equal(me.securityKeys, false);
    assert.deepEqual((await signin({ username: "user_b", password: "pw" })).data, { finished: false, next: "totp" });
  });
});
