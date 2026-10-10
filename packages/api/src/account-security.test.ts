/**
 * Account security on PG (PGlite): the access-token gate (secure / kind), change-password,
 * regenerate-token, revoke-token, apps / authorized-apps, signin-history, TOTP 2FA
 * (register → done → signin with TOTP / backup code, replay blocked by the real OnceGuard
 * class, unregister), password-less, and the TOTP primitives (RFC 6238 vector).
 */
import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";
import { IMPLEMENTED_ENDPOINTS } from "./registry.js";
import { makeFixture, TOK, type Fixture } from "./pglite-fixture.js";
import { callGate } from "./router.js";
import { OnceGuard } from "./once-guard.js";
import { base32Decode, base32Encode, hotp, otpauthUrl, totpCounter, validateTotp } from "./totp.js";
import { handlers } from "./endpoints/index.js";
import type { ApiEnv } from "./env.js";
import { ENDPOINT_PARAM_DEFS } from "./endpoint-params.gen.js";
import { rpcStub } from "../../shared/src/testing/do-namespace.js";

const guards = new Map<string, OnceGuard>();
const onceGuard = {
  idFromName: (n: string) => ({ toString: () => n }),
  get(id: { toString(): string }) {
    const name = id.toString();
    if (!guards.has(name)) {
      const m = new Map<string, unknown>();
      guards.set(name, new OnceGuard({ storage: { get: async (k: string) => m.get(k) as any, put: async (k: string, v: unknown) => void m.set(k, structuredClone(v)) } }));
    }
    return rpcStub(guards.get(name)!);
  },
};

let f: Fixture;
before(async () => {
  f = await makeFixture("AccountTest", { ONCE_GUARD: onceGuard as unknown as ApiEnv["ONCE_GUARD"] });
  const hash = await bcrypt.hash("pw", 4);
  await f.db.query(`UPDATE user_profile SET password = $1`, [hash]);
});

const E = (r: { data: any }) => r.data?.error?.id;
const APP_TOKEN = "apptoken_1234567890abcdef"; // not 16 chars → access token
const totpNow = async (secret: string, offsetSteps = 0) => hotp(base32Decode(secret), totpCounter(Date.now()) + offsetSteps);

async function signin(body: Record<string, unknown>) {
  const r = await handlers["signin-flow"]!(f.env, body, {
    hasCredential: false,
    request: new Request("https://api.test/api/signin-flow", { method: "POST", headers: { "cf-connecting-ip": "203.0.113.9", "user-agent": "test", cookie: "secret" } }),
  });
  if (r instanceof Response) return { status: r.status, data: await r.json() as any };
  return { status: 200, data: r as any };
}

describe("TOTP primitives", () => {
  it("RFC 6238 SHA-1 vector, base32 round trip, otpauth URL", async () => {
    const secret = new TextEncoder().encode("12345678901234567890");
    assert.equal(await hotp(secret, Math.floor(59 / 30)), "287082");
    assert.equal(await hotp(secret, Math.floor(1111111109 / 30)), "081804");
    assert.deepEqual(base32Decode(base32Encode(secret)), secret);
    const b32 = base32Encode(secret);
    assert.equal(await validateTotp(b32, "287082", 59_000), 0);
    assert.equal(await validateTotp(b32, "287082", 59_000 + 30_000), -1);
    assert.equal(await validateTotp(b32, "287082", 59_000 + 90_000), null);
    assert.equal(otpauthUrl("ABC", "alice", "example.com"), "otpauth://totp/example.com:alice?issuer=example.com&secret=ABC&algorithm=SHA1&digits=6&period=30");
  });
});

describe("account security", () => {
  it("registers endpoints", () => {
    for (const e of ["i/change-password", "i/regenerate-token", "i/revoke-token", "i/apps", "i/authorized-apps", "i/signin-history", "i/2fa/register", "i/2fa/done", "i/2fa/unregister", "i/2fa/password-less"]) {
      assert.ok((IMPLEMENTED_ENDPOINTS as readonly string[]).includes(e), e);
      assert.ok(ENDPOINT_PARAM_DEFS[e], e);
    }
  });

  it("access-token gate: secure endpoints need the native token, kind must be granted", async () => {
    await f.db.query(`INSERT INTO access_token (id, "userId", token, hash, permission) VALUES ('at1', $1, $2, $3, '{read:account}')`, [f.ids.b, APP_TOKEN, APP_TOKEN.toLowerCase()]);
    const req = (token: string) => new Request("https://api.test/api/x", { method: "POST", headers: { authorization: `Bearer ${token}` } });
    // (valid params, so the paramDef validation that runs last does not answer first)
    const gate = async (name: string, token = APP_TOKEN, body: Record<string, unknown> = {}) => {
      const r = await callGate(f.env, name, req(token), body);
      return r ? { status: r.status, id: ((await r.json()) as any).error.id } : null;
    };
    assert.equal(await gate("i"), null); // read:account granted
    assert.equal(await gate("meta"), null); // no credential needed
    assert.equal(await gate("users/show", APP_TOKEN, { userId: f.ids.a }), null);
    assert.deepEqual(await gate("i/update"), { status: 403, id: "1370e5b7-d4eb-4566-bb1d-7748ee6a1838" }); // write:account missing
    assert.deepEqual(await gate("i/change-password"), { status: 400, id: "56f35758-7dd5-468b-8439-5d6fb8ec9b8e" }); // secure
    // upstream checks the role before the token's kind: user b is not a moderator
    assert.deepEqual(await gate("admin/roles/list"), { status: 403, id: "d33d5333-db36-423d-a8f9-1a2b9549da41" });
    assert.equal(await gate("i/revoke-token", APP_TOKEN, { tokenId: "at1" }), null); // no requireCredential upstream
    assert.equal(await gate("i/update", TOK.b), null); // native token
    assert.deepEqual(await gate("i/update", "unknown_token_xxxxxxxx"), { status: 401, id: "b0a7f5f8-dc2f-4171-b91f-de88ad238e14" }); // AUTHENTICATION_FAILED
  });

  it("change-password (+ 2FA token when enabled)", async () => {
    assert.equal((await f.call("i/change-password", { currentPassword: "wrong", newPassword: "x" }, "c")).status, 500);
    assert.equal((await f.call("i/change-password", { currentPassword: "pw", newPassword: "" }, "c")).status, 400);
    assert.equal((await f.call("i/change-password", { currentPassword: "pw", newPassword: "pw2" }, "c")).status, 204);
    assert.equal((await signin({ username: "user_c", password: "pw" })).status, 403);
    assert.equal((await signin({ username: "user_c", password: "pw2" })).data.finished, true);
  });

  it("regenerate-token", async () => {
    assert.equal((await f.call("i/regenerate-token", { password: "nope" }, "a")).status, 500);
    assert.equal((await f.call("i/regenerate-token", { password: "pw" }, "a")).status, 204);
    const tok = ((await f.db.query(`SELECT token FROM "user" WHERE id = $1`, [f.ids.a])).rows[0] as any).token;
    assert.equal(tok.length, 16);
    assert.notEqual(tok, TOK.a);
    assert.equal((await f.call("i", {}, "a")).status, 401); // the old token no longer works
    await f.db.query(`UPDATE "user" SET token = $2 WHERE id = $1`, [f.ids.a, TOK.a]);
  });

  it("apps / authorized-apps / revoke-token", async () => {
    await f.db.query(`INSERT INTO app (id, name, description, permission, "callbackUrl", secret) VALUES ('app1', 'Client', 'desc', '{read:account,write:notes}', 'https://cb', 's')`);
    await f.db.query(`INSERT INTO access_token (id, "userId", token, hash, permission, "appId") VALUES ('at2', $1, 'tok2_xxxxxxxxxxxxxxxx', 'tok2', '{}', 'app1')`, [f.ids.b]);
    const list = (await f.call("i/apps", {}, "b")).data;
    assert.deepEqual(list.map((x: any) => [x.id, x.name ?? null, x.permission]), [["at1", null, ["read:account"]], ["at2", "Client", ["read:account", "write:notes"]]]);
    assert.equal(list[1].description, "desc");
    assert.deepEqual((await f.call("i/apps", { sort: "+createdAt" }, "b")).data.map((x: any) => x.id), ["at2", "at1"]);
    assert.equal((await f.call("i/apps", { sort: "bogus" }, "b")).status, 400);
    assert.deepEqual((await f.call("i/authorized-apps", {}, "b")).data, [{ id: "app1", name: "Client", callbackUrl: "https://cb", permission: ["read:account", "write:notes"], isAuthorized: true }]);
    // an app token may only revoke itself
    const asApp = async (body: Record<string, unknown>) => {
      const r = await handlers["i/revoke-token"]!(f.env, { ...body, i: APP_TOKEN }, { hasCredential: true, request: new Request("https://api.test/api/i/revoke-token", { method: "POST" }) });
      return r instanceof Response ? { status: r.status, data: r.status === 204 ? null : await r.json() as any } : { status: 200, data: r };
    };
    assert.equal(E(await asApp({ tokenId: "at2" })), "fc20d118-5705-4462-b6c5-2b5b43092cf3");
    assert.equal((await asApp({ tokenId: "at1" })).status, 204);
    assert.equal((await f.call("i/revoke-token", { tokenId: "at2" }, "b")).status, 204);
    assert.equal((await f.call("i/revoke-token", { tokenId: "nope" }, "b")).status, 204);
    assert.deepEqual((await f.call("i/apps", {}, "b")).data, []);
    assert.equal(E(await f.call("i/revoke-token", { tokenId: "x" })), "6f1f0d3a-3d5b-4b1f-9c3e-2a6d1e5b8c47");
  });

  it("TOTP 2FA: register → done → signin needs the code (replay blocked, backup code once) → unregister", async () => {
    assert.equal(E(await f.call("i/2fa/register", { password: "nope" }, "b")), "78d6c839-20c9-4c66-b90a-fc0542168b48");
    const reg = (await f.call("i/2fa/register", { password: "pw" }, "b")).data;
    assert.match(reg.qr, /^data:image\/gif;base64,/);
    assert.equal(reg.label, "user_b");
    assert.equal(reg.issuer, "misskey.example.com");
    assert.equal(reg.url, otpauthUrl(reg.secret, "user_b", "misskey.example.com"));
    assert.equal((await f.call("i/2fa/done", { token: "000000" }, "b")).status, 500);
    const done = await f.call("i/2fa/done", { token: await totpNow(reg.secret) }, "b");
    assert.equal(done.status, 200, JSON.stringify(done.data));
    assert.equal(done.data.backupCodes.length, 5);
    const me = (await f.call("i", {}, "b")).data;
    assert.equal(me.twoFactorEnabled, true);
    assert.equal(me.twoFactorBackupCodesStock, "full");

    assert.deepEqual((await signin({ username: "user_b" })).data, { finished: false, next: "password" });
    assert.deepEqual((await signin({ username: "user_b", password: "pw" })).data, { finished: false, next: "totp" });
    assert.equal((await signin({ username: "user_b", password: "pw", token: "123456" })).data.error.id, "cdf1235b-ac71-46d4-a3a6-84ccce48df6f");
    // the code that finished the setup was already used in this step
    assert.equal((await signin({ username: "user_b", password: "pw", token: await totpNow(reg.secret) })).status, 403);
    const prev = await totpNow(reg.secret, -1);
    const ok = await signin({ username: "user_b", password: "pw", token: prev });
    assert.deepEqual(ok.data, { finished: true, id: f.ids.b, i: TOK.b });
    assert.equal((await signin({ username: "user_b", password: "pw", token: prev })).status, 403); // replay
    assert.equal((await signin({ username: "user_b", password: "bad", token: done.data.backupCodes[0] })).status, 403);
    assert.equal((await signin({ username: "user_b", password: "pw", token: done.data.backupCodes[0] })).data.finished, true);
    assert.equal((await signin({ username: "user_b", password: "pw", token: done.data.backupCodes[0] })).status, 403); // consumed
    assert.equal((await f.call("i", {}, "b")).data.twoFactorBackupCodesStock, "partial");

    // change-password / unregister need a second factor now
    assert.equal((await f.call("i/change-password", { currentPassword: "pw", newPassword: "pw" }, "b")).status, 500);
    assert.equal((await f.call("i/change-password", { currentPassword: "pw", newPassword: "pw", token: done.data.backupCodes[1] }, "b")).status, 204);
    assert.equal((await f.call("i/2fa/unregister", { password: "pw" }, "b")).status, 500);
    assert.equal(E(await f.call("i/2fa/unregister", { password: "nope", token: done.data.backupCodes[2] }, "b")), "7add0395-9901-4098-82f9-4f67af65f775");
    assert.equal((await f.call("i/2fa/unregister", { password: "pw", token: done.data.backupCodes[3] }, "b")).status, 204);
    assert.equal((await f.call("i", {}, "b")).data.twoFactorEnabled, false);
    assert.equal((await signin({ username: "user_b", password: "pw" })).data.finished, true);
  });

  it("password-less needs a security key", async () => {
    assert.equal(E(await f.call("i/2fa/password-less", { value: true }, "b")), "f9c54d7f-d4c2-4d3c-9a8g-a70daac86512");
    assert.equal((await f.call("i/2fa/password-less", { value: false }, "b")).status, 204);
  });

  it("signin-history: successes and password / second-factor failures, newest first", async () => {
    const h = (await f.call("i/signin-history", { limit: 100 }, "b")).data;
    assert.ok(h.length >= 5);
    assert.deepEqual(Object.keys(h[0]).sort(), ["createdAt", "headers", "id", "ip", "success"]);
    assert.equal(h[0].ip, "203.0.113.9");
    assert.equal(h[0].headers["user-agent"], "test");
    assert.ok(!("cookie" in h[0].headers));
    assert.ok(h.some((x: any) => x.success === false) && h.some((x: any) => x.success === true));
    assert.ok(h.every((x: any, i: number) => i === 0 || h[i - 1].id > x.id));
    // `next: …` steps are not recorded
    const n = h.length;
    await signin({ username: "user_b" });
    assert.equal((await f.call("i/signin-history", { limit: 100 }, "b")).data.length, n);
    assert.equal((await f.call("i/signin-history", { limit: 101 }, "b")).status, 400);
    assert.deepEqual((await f.call("i/signin-history", {}, "a")).data, []);
  });
});
