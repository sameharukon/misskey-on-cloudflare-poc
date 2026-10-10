/**
 * Public sign-up on PG (PGlite): POST /api/signup and /api/signup-pending (upstream
 * SignupApiService) — open registration, username checks, invitation codes while registration is
 * disabled, captcha providers (siteverify mocked through AP_FETCH) and e-mail verified sign-up
 * through user_pending with a fake Email Service binding.
 */
import { before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";
import { genAidx } from "../../id/src/index.js";
import { makeFixture, withDohMx, type Fixture } from "./pglite-fixture.js";
import { handlers } from "./endpoints/index.js";
import { IMPLEMENTED_ENDPOINTS } from "./registry.js";
import type { ApiEnv } from "./env.js";

type Mail = { to: string | string[]; subject: string; text?: string };
const mails: Mail[] = [];
const EMAIL = { send: async (m: Mail) => (mails.push(m), { messageId: "m" }) };
const fetched: { url: string; body: string }[] = [];
let verdict: (url: string) => Response = () => Response.json({ success: true });
const apFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  fetched.push({ url: String(input), body: String(init?.body ?? "") });
  return verdict(String(input));
}) as typeof fetch;

let f: Fixture;
before(async () => {
  f = await makeFixture("SignupTest", { EMAIL: EMAIL as unknown as ApiEnv["EMAIL"], AP_FETCH: withDohMx(apFetch) });
  await f.db.query(`UPDATE meta SET "enableEmail" = TRUE, email = 'noreply@misskey.example.com'`);
});
beforeEach(async () => {
  mails.length = 0;
  await f.db.query(`UPDATE meta SET "disableRegistration" = FALSE, "emailRequiredForSignup" = FALSE, "enableTestcaptcha" = FALSE, "enableTurnstile" = FALSE`);
});

async function post(route: "signup" | "signup-pending", body: Record<string, unknown>, env: ApiEnv = f.env) {
  const r = await handlers[route]!(env, body, { hasCredential: false, request: new Request(`https://api.test/api/${route}`, { method: "POST", headers: { "cf-connecting-ip": "198.51.100.7" } }) });
  if (r instanceof Response) {
    const text = await r.text();
    return { status: r.status, data: text ? JSON.parse(text) : null };
  }
  return { status: 200, data: r as any };
}
const one = async (sql: string, p: unknown[] = []) => (await f.db.query(sql, p)).rows[0] as any;
let seq = 0;
async function ticket(fields: Record<string, unknown> = {}): Promise<string> {
  const code = `CODE${seq++}`;
  const row = { id: genAidx(Date.now() + seq), code, ...fields };
  const cols = Object.keys(row);
  await f.db.query(`INSERT INTO registration_ticket (${cols.map((c) => `"${c}"`).join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")})`, Object.values(row));
  return code;
}

describe("POST /api/signup", () => {
  it("is a special route, not an endpoint", () => {
    assert.ok(handlers.signup && handlers["signup-pending"]);
    assert.ok(!(IMPLEMENTED_ENDPOINTS as readonly string[]).includes("signup"));
  });

  it("creates the account and answers MeDetailed with the token", async () => {
    const r = await post("signup", { username: "Alice", password: "secret" });
    assert.equal(r.status, 200);
    assert.equal(r.data.username, "Alice");
    assert.match(r.data.token, /^[0-9A-Za-z]{16}$/);
    assert.equal(r.data.email, null);
    assert.ok("emailNotificationTypes" in r.data);
    const u = await one(`SELECT id, token FROM "user" WHERE "usernameLower" = 'alice'`);
    assert.equal(u.id, r.data.id);
    assert.equal(u.token, r.data.token);
    assert.ok(await bcrypt.compare("secret", (await one(`SELECT password FROM user_profile WHERE "userId" = $1`, [u.id])).password));
    assert.ok(await one(`SELECT 1 AS ok FROM user_keypair WHERE "userId" = $1`, [u.id]));
    assert.ok(await one(`SELECT 1 AS ok FROM used_username WHERE username = 'alice'`));
    // the new token works
    const me = await handlers.i!(f.env, { i: r.data.token }, { hasCredential: true, request: new Request("https://api.test/api/i", { method: "POST" }) });
    assert.equal((me as any).id, r.data.id);
  });

  it("username errors (Fastify error shape)", async () => {
    const dup = await post("signup", { username: "alice", password: "x" });
    assert.equal(dup.status, 400);
    assert.deepEqual(dup.data, { statusCode: 400, error: "Bad Request", message: "Error: DUPLICATED_USERNAME" });
    assert.equal((await post("signup", { username: "bad name", password: "x" })).data.message, "Error: INVALID_USERNAME");
    assert.equal((await post("signup", { username: "nopw", password: "" })).data.message, "Error: INVALID_PASSWORD");
    await f.db.query(`UPDATE meta SET "preservedUsernames" = '{Admin}', "prohibitedWordsForNameOfUser" = '{evil}'`);
    assert.equal((await post("signup", { username: "admin", password: "x" })).data.message, "Error: USED_USERNAME");
    assert.equal((await post("signup", { username: "evilbob", password: "x" })).data.message, "Error: USED_USERNAME");
    await f.db.query(`INSERT INTO used_username (username, "createdAt") VALUES ('gone', now())`);
    assert.equal((await post("signup", { username: "Gone", password: "x" })).data.message, "Error: USED_USERNAME");
    // no password: upstream SignupService stores a null hash
    const nopw = await post("signup", { username: "nopass" });
    assert.equal(nopw.status, 200);
    assert.equal((await one(`SELECT password FROM user_profile WHERE "userId" = $1`, [nopw.data.id])).password, null);
    assert.equal((await post("signup", { password: "x" })).data.message, "Error: INVALID_USERNAME");
  });

  it("disableRegistration: an unused, unexpired invitation code is required and consumed", async () => {
    await f.db.query(`UPDATE meta SET "disableRegistration" = TRUE`);
    assert.deepEqual(await post("signup", { username: "inv1", password: "x" }), { status: 400, data: null });
    assert.deepEqual(await post("signup", { username: "inv1", password: "x", invitationCode: "nope" }), { status: 400, data: null });
    const expired = await ticket({ expiresAt: new Date(Date.now() - 1000) });
    assert.equal((await post("signup", { username: "inv1", password: "x", invitationCode: expired })).status, 400);
    const code = await ticket({ createdById: f.ids.a });
    const r = await post("signup", { username: "inv1", password: "x", invitationCode: code });
    assert.equal(r.status, 200);
    const t = await one(`SELECT "usedById", "usedAt" FROM registration_ticket WHERE code = $1`, [code]);
    assert.equal(t.usedById, r.data.id);
    assert.ok(t.usedAt);
    assert.equal((await post("signup", { username: "inv2", password: "x", invitationCode: code })).status, 400);
    // a failed sign-up gives the code back
    const code2 = await ticket();
    assert.equal((await post("signup", { username: "inv1", password: "x", invitationCode: code2 })).data.message, "Error: DUPLICATED_USERNAME");
    const t2 = await one(`SELECT "usedById", "usedAt" FROM registration_ticket WHERE code = $1`, [code2]);
    assert.equal(t2.usedById, null);
    assert.equal(t2.usedAt, null);
  });

  it("captcha providers", async () => {
    await f.db.query(`UPDATE meta SET "enableTestcaptcha" = TRUE`);
    const none = await post("signup", { username: "cap1", password: "x" });
    assert.equal(none.status, 400);
    assert.equal(none.data.message, "CaptchaError: testcaptcha-failed: no response provided");
    assert.equal((await post("signup", { username: "cap1", password: "x", "testcaptcha-response": "wrong" })).data.message, "CaptchaError: testcaptcha-failed");
    assert.equal((await post("signup", { username: "cap1", password: "x", "testcaptcha-response": "testcaptcha-passed" })).status, 200);

    await f.db.query(`UPDATE meta SET "enableTestcaptcha" = FALSE, "enableTurnstile" = TRUE, "turnstileSecretKey" = 'ts-secret'`);
    verdict = () => Response.json({ success: false, "error-codes": ["invalid-input-response"] });
    const bad = await post("signup", { username: "cap2", password: "x", "turnstile-response": "tok" });
    assert.equal(bad.status, 400);
    assert.equal(bad.data.message, "CaptchaError: turnstile-failed: invalid-input-response");
    assert.equal(fetched.at(-1)!.url, "https://challenges.cloudflare.com/turnstile/v0/siteverify");
    assert.equal(fetched.at(-1)!.body, "secret=ts-secret&response=tok");
    verdict = () => Response.json({ success: true });
    assert.equal((await post("signup", { username: "cap2", password: "x", "turnstile-response": "tok" })).status, 200);
  });
});

describe("e-mail verified sign-up", () => {
  it("parks the account in user_pending, mails the link, signup-pending completes and signs in", async () => {
    await f.db.query(`UPDATE meta SET "emailRequiredForSignup" = TRUE`);
    assert.deepEqual(await post("signup", { username: "pend1", password: "pw" }), { status: 400, data: null });
    assert.deepEqual(await post("signup", { username: "pend1", password: "pw", emailAddress: "bad" }), { status: 400, data: null });
    assert.equal((await post("signup", { username: "alice", password: "pw", emailAddress: "p@example.org" })).data.message, "DUPLICATED_USERNAME");
    await f.db.query(`UPDATE meta SET "preservedUsernames" = '{reserved}'`);
    assert.equal((await post("signup", { username: "Reserved", password: "pw", emailAddress: "p@example.org" })).data.message, "DENIED_USERNAME");

    const r = await post("signup", { username: "pend1", password: "pw", emailAddress: "p@example.org" });
    assert.deepEqual(r, { status: 204, data: null });
    assert.equal(await one(`SELECT 1 AS ok FROM "user" WHERE "usernameLower" = 'pend1'`), undefined);
    const p = await one(`SELECT * FROM user_pending WHERE username = 'pend1'`);
    assert.match(p.code, /^[0-9a-z]{16}$/);
    assert.ok(await bcrypt.compare("pw", p.password));
    assert.equal(mails.length, 1);
    assert.equal(mails[0]!.to, "p@example.org");
    assert.equal(mails[0]!.subject, "Signup");
    assert.equal(mails[0]!.text, `To complete signup, please click this link: https://misskey.example.com/signup-complete/${p.code}`);

    assert.equal((await post("signup-pending", { code: "nope" })).status, 400);
    mails.length = 0;
    const done = await post("signup-pending", { code: p.code });
    assert.equal(done.status, 200);
    assert.equal(done.data.finished, true);
    const u = await one(`SELECT id, token FROM "user" WHERE "usernameLower" = 'pend1'`);
    assert.deepEqual(done.data, { finished: true, id: u.id, i: u.token });
    const prof = await one(`SELECT email, "emailVerified", password FROM user_profile WHERE "userId" = $1`, [u.id]);
    assert.equal(prof.email, "p@example.org");
    assert.equal(prof.emailVerified, true);
    assert.equal(prof.password, p.password);
    assert.equal(await one(`SELECT 1 AS ok FROM user_pending WHERE id = $1`, [p.id]), undefined);
    assert.equal((await one(`SELECT ip FROM signin WHERE "userId" = $1`, [u.id])).ip, "198.51.100.7");
    assert.deepEqual(mails.map((m) => m.subject), ["New login / ログインがありました"]);

    await f.db.query(`INSERT INTO user_pending (id, code, email, username, password) VALUES ($1, 'oldcode', 'o@example.org', 'late', 'x')`, [genAidx(Date.now() - 31 * 60_000)]);
    assert.deepEqual((await post("signup-pending", { code: "oldcode" })).data, { statusCode: 400, error: "Bad Request", message: "Error: EXPIRED" });
  });

  it("invitation codes with e-mail verification: tied to the pending user, consumed on completion", async () => {
    await f.db.query(`UPDATE meta SET "emailRequiredForSignup" = TRUE, "disableRegistration" = TRUE`);
    const code = await ticket();
    assert.equal((await post("signup", { username: "pend2", password: "pw", emailAddress: "p2@example.org", invitationCode: code })).status, 204);
    const p = await one(`SELECT id, code FROM user_pending WHERE username = 'pend2'`);
    let t = await one(`SELECT * FROM registration_ticket WHERE code = $1`, [code]);
    assert.equal(t.pendingUserId, p.id);
    assert.ok(t.usedAt);
    // within 30 minutes of the mail the code cannot be used again
    assert.equal((await post("signup", { username: "pend3", password: "pw", emailAddress: "p3@example.org", invitationCode: code })).status, 400);
    assert.equal((await post("signup-pending", { code: p.code })).status, 200);
    t = await one(`SELECT * FROM registration_ticket WHERE code = $1`, [code]);
    assert.equal(t.pendingUserId, null);
    assert.equal(t.usedById, (await one(`SELECT id FROM "user" WHERE "usernameLower" = 'pend2'`)).id);

    // a code tied to an expired pending user is detached and reused
    const code2 = await ticket();
    const oldPending = genAidx(Date.now() - 40 * 60_000);
    await f.db.query(`INSERT INTO user_pending (id, code, email, username, password) VALUES ($1, 'stale', 's@example.org', 'stale', 'x')`, [oldPending]);
    await f.db.query(`UPDATE registration_ticket SET "pendingUserId" = $2, "usedAt" = $3 WHERE code = $1`, [code2, oldPending, new Date(Date.now() - 40 * 60_000)]);
    assert.equal((await post("signup", { username: "pend4", password: "pw", emailAddress: "p4@example.org", invitationCode: code2 })).status, 204);
    assert.equal(await one(`SELECT 1 AS ok FROM user_pending WHERE id = $1`, [oldPending]), undefined);
    assert.equal((await one(`SELECT "pendingUserId" FROM registration_ticket WHERE code = $1`, [code2])).pendingUserId, (await one(`SELECT id FROM user_pending WHERE username = 'pend4'`)).id);
  });

  it("without the EMAIL binding the e-mail requirement is off", async () => {
    await f.db.query(`UPDATE meta SET "emailRequiredForSignup" = TRUE`);
    const r = await post("signup", { username: "nomail", password: "pw" }, { ...f.env, EMAIL: undefined });
    assert.equal(r.status, 200);
    assert.equal(r.data.username, "nomail");
  });
});
