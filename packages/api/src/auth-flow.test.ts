/**
 * signin-flow (password / 2FA steps), app/create + app/show, auth/session/{generate,show,userkey}
 * + auth/accept, and miauth/gen-token + /api/miauth/:session/check on PG (PGlite).
 */
import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";
import worker from "./index.js";
import { normalizeAppPermission } from "./app-pg.js";
import { makeFixture, TOK, type Fixture } from "./pglite-fixture.js";

function ctx() {
  return { waitUntil() {}, passThroughOnException() {} };
}

let f: Fixture;
before(async () => {
  f = await makeFixture("AuthFlow");
  const hash = await bcrypt.hash("correct-horse", 4);
  await f.db.query(`UPDATE user_profile SET password = $1`, [hash]);
  await f.db.query(`UPDATE user_profile SET "twoFactorEnabled" = TRUE WHERE "userId" = $1`, [f.ids.c]);
});

async function post(path: string, body: unknown): Promise<Response> {
  return worker.fetch(
    new Request(`https://api.test${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    f.env,
    ctx(),
  );
}

describe("POST /api/signin-flow", () => {
  it("asks for captcha when the password is omitted (no 2FA)", async () => {
    const res = await post("/api/signin-flow", { username: "user_b" });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { finished: false, next: "captcha" });
  });

  it("returns the native token on a password match", async () => {
    const res = await post("/api/signin-flow", { username: "user_b", password: "correct-horse" });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { finished: true, id: f.ids.b, i: TOK.b });
  });

  it("403 on a bad password, 404 for an unknown user", async () => {
    const bad = await post("/api/signin-flow", { username: "user_b", password: "wrong" });
    assert.equal(bad.status, 403);
    assert.equal(((await bad.json()) as { error: { id: string } }).error.id, "932c904e-9460-45b7-9ce6-7ed33be7eb2c");
    assert.equal((await post("/api/signin-flow", { username: "nobody" })).status, 404);
  });

  it("2FA user: password next, then totp next", async () => {
    assert.deepEqual(await (await post("/api/signin-flow", { username: "user_c" })).json(), { finished: false, next: "password" });
    assert.deepEqual(await (await post("/api/signin-flow", { username: "user_c", password: "correct-horse" })).json(), { finished: false, next: "totp" });
  });
});

describe("normalizeAppPermission", () => {
  it("maps legacy slash/dash forms", () => {
    assert.deepEqual(normalizeAppPermission(["notes-write", "account/read"]), ["write:notes", "read:account"]);
  });
});

describe("app + auth/session + auth/accept + userkey", () => {
  it("app/create → app/show → generate → show → accept → userkey", async () => {
    const created = await f.call("app/create", { name: "cli", description: "test", permission: ["read:account", "notes-write"], callbackUrl: null }, "a");
    assert.equal(created.status, 200, JSON.stringify(created.data));
    const app = created.data as { id: string; secret: string; name: string; permission: string[] };
    assert.ok(app.secret.length >= 16);
    assert.equal(app.name, "cli");
    assert.ok(app.permission.includes("write:notes"));

    // the secret only for its owner on a native token
    assert.equal((await f.call("app/show", { appId: app.id })).data.secret, undefined);
    assert.equal((await f.call("app/show", { appId: app.id }, "b")).data.secret, undefined);
    assert.equal((await f.call("app/show", { appId: app.id }, "a")).data.secret, app.secret);

    const gen = await f.call("auth/session/generate", { appSecret: app.secret });
    assert.equal(gen.status, 200);
    const token = gen.data.token as string;
    assert.equal(gen.data.url, `https://misskey.example.com/auth/${token}`);
    const shown = await f.call("auth/session/show", { token });
    assert.equal(shown.data.app.id, app.id);

    // not accepted yet
    const pending = await f.call("auth/session/userkey", { appSecret: app.secret, token });
    assert.equal(pending.data.error.code, "PENDING_SESSION");

    assert.equal((await f.call("auth/accept", { token }, "b")).status, 200);
    assert.equal((await f.call("app/show", { appId: app.id }, "b")).data.isAuthorized, true);

    const uk = await f.call("auth/session/userkey", { appSecret: app.secret, token });
    assert.equal(uk.status, 200, JSON.stringify(uk.data));
    assert.ok((uk.data.accessToken as string).length >= 16);
    // upstream: UserDetailedNotMe of the user who accepted
    assert.equal(uk.data.user.id, f.ids.b);
    assert.equal(uk.data.user.username, "user_b");
    // the session is used up
    assert.equal((await f.call("auth/session/userkey", { appSecret: app.secret, token })).data.error.code, "NO_SUCH_SESSION");
  });

  it("NO_SUCH_APP on a bad secret / a missing app", async () => {
    assert.equal((await f.call("auth/session/generate", { appSecret: "nope" })).data.error.code, "NO_SUCH_APP");
    assert.equal((await f.call("app/show", { appId: "missing000000001" })).data.error.code, "NO_SUCH_APP");
  });
});

describe("miauth gen-token + check", () => {
  it("issues a token and check returns it once, with the user", async () => {
    const session = "miauth-sess-1";
    const gen = await f.call("miauth/gen-token", { session, permission: ["read:account"], name: "TestApp" }, "b");
    assert.equal(gen.status, 200, JSON.stringify(gen.data));
    const token = gen.data.token as string;
    assert.ok(token.length >= 16);

    const c1 = (await (await post(`/api/miauth/${session}/check`, {})).json()) as { ok: boolean; token?: string; user?: { id: string; username: string } };
    assert.equal(c1.ok, true);
    assert.equal(c1.token, token);
    assert.deepEqual([c1.user?.id, c1.user?.username], [f.ids.b, "user_b"]);
    assert.deepEqual(await (await post(`/api/miauth/${session}/check`, {})).json(), { ok: false });

    // upstream: a createToken notification for the user
    const notifs = (await f.call("i/notifications", { limit: 10 }, "b")).data as { type: string }[];
    assert.ok(notifs.some((n) => n.type === "createToken"));
  });
});
