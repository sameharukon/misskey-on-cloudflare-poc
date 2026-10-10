/**
 * Mail delivery on PG (PGlite) with a fake Cloudflare Email Service binding: the `sendEmail` job
 * (meta.enableEmail / sender / template / retry on failure), i/update-email + verify-email,
 * admin/send-email, request-reset-password + reset-password, the active email validation, and the
 * mails upstream sends on its own (abuse reports to `email` recipients, new login, account deleted).
 */
import { before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";
import { genAidx } from "../../id/src/index.js";
import { IMPLEMENTED_ENDPOINTS } from "./registry.js";
import { makeFixture, withDohMx, type Fixture } from "./pglite-fixture.js";
import { runJobStep, type JobMessage } from "./jobs.js";
import { maskEmail, renderEmailHtml, sendEmail } from "./email.js";
import { handlers } from "./endpoints/index.js";
import { deleteAccount } from "./account-delete-pg.js";
import type { ApiEnv } from "./env.js";
import { ENDPOINT_PARAM_DEFS } from "./endpoint-params.gen.js";

type Mail = { from: string | { email: string; name?: string }; to: string | string[]; subject: string; html?: string; text?: string };
const mails: Mail[] = [];
let failSend = false;
const EMAIL = {
  async send(m: Mail) {
    if (failSend) throw new Error("E_SENDER_NOT_VERIFIED");
    mails.push(m);
    return { messageId: `m${mails.length}` };
  },
};
const fetched: string[] = [];
let verdict: (url: string) => Response = () => Response.json({});
const apFetch = (async (input: RequestInfo | URL) => {
  fetched.push(String(input));
  return verdict(String(input));
}) as typeof fetch;

let f: Fixture;
before(async () => {
  f = await makeFixture("MailTest", { EMAIL: EMAIL as unknown as ApiEnv["EMAIL"], AP_FETCH: withDohMx(apFetch) });
  await f.db.query(`UPDATE meta SET "enableEmail" = TRUE, email = 'noreply@misskey.example.com', name = 'Mail Test'`);
  await f.db.query(`UPDATE user_profile SET password = $1`, [await bcrypt.hash("pw", 4)]);
});
beforeEach(() => {
  mails.length = 0;
  failSend = false;
});

const E = (r: { data: any }) => r.data?.error?.id;
const profile = async (id: string) => (await f.db.query(`SELECT * FROM user_profile WHERE "userId" = $1`, [id])).rows[0] as any;

describe("mail transport (sendEmail job)", () => {
  it("registers endpoints", () => {
    for (const e of ["i/update-email", "verify-email", "admin/send-email", "request-reset-password", "reset-password"]) {
      assert.ok((IMPLEMENTED_ENDPOINTS as readonly string[]).includes(e), e);
      assert.ok(ENDPOINT_PARAM_DEFS[e], e);
    }
  });

  it("sends through EMAIL with meta.email / meta.name and upstream's template", async () => {
    await sendEmail(f.env, "to@example.org", "Hello <World>", "<b>hi</b>", "hi");
    assert.equal(mails.length, 1);
    const m = mails[0]!;
    assert.deepEqual(m.from, { email: "noreply@misskey.example.com", name: "Mail Test" });
    assert.equal(m.to, "to@example.org");
    assert.equal(m.subject, "Hello <World>");
    assert.equal(m.text, "hi");
    assert.match(m.html!, /<title>Hello &lt;World&gt;<\/title>/);
    assert.match(m.html!, /<div><b>hi<\/b><\/div>/);
    assert.match(m.html!, /https:\/\/misskey\.example\.com\/settings\/email/);
    assert.match(m.html!, /static-assets\/mi-white\.png/);
    assert.match(await renderEmailHtml(f.env, { logoImageUrl: "https://x.example/logo.png" }, "s", ""), /https:\/\/x\.example\/logo\.png/);
  });

  it("goes through mk-jobs when bound; enableEmail off / no binding drop the mail; failures throw for a retry", async () => {
    const queued: unknown[] = [];
    const env = { ...f.env, Q_JOBS: { send: async (b: unknown) => void queued.push(b) } } as ApiEnv;
    await sendEmail(env, "q@example.org", "Queued", "x", "x");
    assert.equal(mails.length, 0);
    assert.deepEqual(queued, [{ kind: "sendEmail", to: "q@example.org", subject: "Queued", html: "x", text: "x" }]);
    assert.equal(await runJobStep(f.env, queued[0] as JobMessage), null);
    assert.equal(mails.length, 1);

    failSend = true;
    await assert.rejects(runJobStep(f.env, queued[0] as JobMessage), /E_SENDER_NOT_VERIFIED/);
    await sendEmail(f.env, "q@example.org", "Inline failure is logged", "x", "x"); // does not throw
    failSend = false;

    await f.db.query(`UPDATE meta SET "enableEmail" = FALSE`);
    await runJobStep(f.env, queued[0] as JobMessage);
    await f.db.query(`UPDATE meta SET "enableEmail" = TRUE`);
    await sendEmail({ ...f.env, EMAIL: undefined }, "q@example.org", "No binding", "x", "x");
    assert.equal(mails.length, 1);
  });
});

describe("admin/update-meta mail settings", () => {
  it("persists enableEmail / email / bannedEmailDomains", async () => {
    await f.call("admin/update-meta", { enableEmail: false, email: "other@misskey.example.com", bannedEmailDomains: ["spam.example"] }, "a");
    const m = (await f.db.query(`SELECT "enableEmail", email, "bannedEmailDomains" FROM meta`)).rows[0] as any;
    assert.deepEqual([m.enableEmail, m.email, m.bannedEmailDomains], [false, "other@misskey.example.com", ["spam.example"]]);
    await f.db.query(`UPDATE meta SET "enableEmail" = TRUE, email = 'noreply@misskey.example.com', "bannedEmailDomains" = '{}'`);
  });
});

describe("i/update-email / verify-email", () => {
  it("checks the password, validates the address, mails a verification link", async () => {
    assert.equal(E(await f.call("i/update-email", { password: "nope", email: "b@example.org" }, "b")), "e54c1d7e-e7d6-4103-86b6-0a95069b4ad3");
    assert.equal((await f.call("i/update-email", { email: "b@example.org" }, "b")).status, 400);
    assert.equal(E(await f.call("i/update-email", { password: "pw", email: "not an address" }, "b")), "a2defefb-f220-8849-0af6-17f816099323");
    await f.db.query(`UPDATE meta SET "bannedEmailDomains" = '{banned.example}'`);
    assert.equal(E(await f.call("i/update-email", { password: "pw", email: "x@sub.banned.example" }, "b")), "a2defefb-f220-8849-0af6-17f816099323");
    await f.db.query(`UPDATE meta SET "bannedEmailDomains" = '{}'`);
    assert.equal(mails.length, 0);

    const r = await f.call("i/update-email", { password: "pw", email: "b@example.org" }, "b");
    assert.equal(r.status, 200);
    assert.equal(r.data.id, f.ids.b);
    assert.equal(r.data.email, "b@example.org");
    assert.equal(r.data.emailVerified, false);
    const p = await profile(f.ids.b);
    assert.match(p.emailVerifyCode, /^[0-9a-z]{16}$/);
    assert.equal(mails.length, 1);
    assert.equal(mails[0]!.to, "b@example.org");
    assert.equal(mails[0]!.subject, "Email verification");
    assert.equal(mails[0]!.text, `To verify email, please click this link: https://misskey.example.com/verify-email/${p.emailVerifyCode}`);

    assert.equal(E(await f.call("verify-email", { code: "wrong" })), "97c1f576-e4b8-4b8a-a6dc-9cb65e7f6f85");
    assert.equal((await f.call("verify-email", { code: p.emailVerifyCode })).status, 204);
    const v = await profile(f.ids.b);
    assert.equal(v.emailVerified, true);
    assert.equal(v.emailVerifyCode, null);

    // a verified address is taken
    assert.equal(E(await f.call("i/update-email", { password: "pw", email: "b@example.org" }, "c")), "a2defefb-f220-8849-0af6-17f816099323");
  });

  it("removing the address; EMAIL_REQUIRED when sign-up requires one; 2FA token", async () => {
    await f.db.query(`UPDATE meta SET "emailRequiredForSignup" = TRUE`);
    assert.equal(E(await f.call("i/update-email", { password: "pw", email: null }, "c")), "324c7a88-59f2-492f-903f-89134f93e47e");
    await f.db.query(`UPDATE meta SET "emailRequiredForSignup" = FALSE`);
    const r = await f.call("i/update-email", { password: "pw", email: null }, "c");
    assert.equal(r.status, 200);
    assert.equal(r.data.email, null);
    assert.equal(mails.length, 0);

    await f.db.query(`UPDATE user_profile SET "twoFactorEnabled" = TRUE, "twoFactorSecret" = 'JBSWY3DPEHPK3PXP', "twoFactorBackupSecret" = '{backup1}' WHERE "userId" = $1`, [f.ids.c]);
    assert.equal((await f.call("i/update-email", { password: "pw", email: "c@example.org" }, "c")).status, 500);
    assert.equal((await f.call("i/update-email", { password: "pw", email: "c@example.org", token: "000000" }, "c")).status, 500);
    assert.equal((await f.call("i/update-email", { password: "pw", email: "c@example.org", token: "backup1" }, "c")).status, 200);
    await f.db.query(`UPDATE user_profile SET "twoFactorEnabled" = FALSE, "twoFactorSecret" = NULL WHERE "userId" = $1`, [f.ids.c]);
  });
});

describe("admin/send-email", () => {
  it("moderators only; sent at once, the html part sanitized", async () => {
    assert.equal((await f.call("admin/send-email", { to: "x@example.org", subject: "s", text: "t" }, "c")).status, 403);
    assert.equal((await f.call("admin/send-email", { to: "x@example.org", subject: "s" }, "a")).status, 400);
    assert.equal((await f.call("admin/send-email", { to: "x@example.org", subject: "Notice", text: "<b>bold</b><script>1</script>" }, "a")).status, 204);
    assert.equal(mails.length, 1);
    assert.equal(mails[0]!.text, "<b>bold</b><script>1</script>");
    assert.match(mails[0]!.html!, /<b>bold<\/b>/);
    assert.ok(!mails[0]!.html!.includes("script"));
    // upstream awaits the send: a failure is the caller's error
    failSend = true;
    assert.equal((await f.call("admin/send-email", { to: "x@example.org", subject: "s", text: "t" }, "a")).status, 500);
  });
});

describe("password reset", () => {
  it("request-reset-password ignores unknown / unverified addresses; reset-password within 30 minutes", async () => {
    // b's address was verified above
    assert.equal((await f.call("request-reset-password", { username: "nobody", email: "b@example.org" })).status, 204);
    assert.equal((await f.call("request-reset-password", { username: "user_b", email: "other@example.org" })).status, 204);
    await f.db.query(`UPDATE user_profile SET email = 'c@example.org', "emailVerified" = FALSE WHERE "userId" = $1`, [f.ids.c]);
    assert.equal((await f.call("request-reset-password", { username: "user_c", email: "c@example.org" })).status, 204);
    assert.equal(mails.length, 0);

    assert.equal((await f.call("request-reset-password", { username: "USER_B", email: "b@example.org" })).status, 204);
    assert.equal(mails.length, 1);
    assert.equal(mails[0]!.subject, "Password reset requested");
    const token = (await f.db.query(`SELECT token FROM password_reset_request WHERE "userId" = $1`, [f.ids.b])).rows[0] as any;
    assert.match(token.token, /^[0-9a-z]{64}$/);
    assert.match(mails[0]!.text!, new RegExp(`/reset-password/${token.token}$`));

    assert.equal((await f.call("reset-password", { token: "nope", password: "new" })).status, 500);
    assert.equal((await f.call("reset-password", { token: token.token, password: "newpw" })).status, 204);
    assert.ok(await bcrypt.compare("newpw", (await profile(f.ids.b)).password));
    assert.equal((await f.call("reset-password", { token: token.token, password: "again" })).status, 500);

    await f.db.query(`INSERT INTO password_reset_request (id, token, "userId") VALUES ($1, 'old', $2)`, [genAidx(Date.now() - 31 * 60_000), f.ids.b]);
    assert.equal((await f.call("reset-password", { token: "old", password: "x" })).status, 500);
    await f.db.query(`UPDATE user_profile SET password = $1 WHERE "userId" = $2`, [await bcrypt.hash("pw", 4), f.ids.b]);
  });
});

describe("email-address/available active validation", () => {
  it("verifymail.io / truemail when configured", async () => {
    await f.db.query(`UPDATE meta SET "enableVerifymailApi" = TRUE, "verifymailAuthKey" = 'k'`);
    verdict = () => Response.json({ email_address: "x@temp.example", disposable: true });
    assert.deepEqual((await f.call("email-address/available", { emailAddress: "x@temp.example" })).data, { available: false, reason: "disposable" });
    assert.equal(fetched.at(-1), "https://verifymail.io/api/x@temp.example?key=k");
    verdict = () => Response.json({ email_address: "x@ok.example", deliverable_email: true, mx: true });
    assert.deepEqual((await f.call("email-address/available", { emailAddress: "x@ok.example" })).data, { available: true, reason: null });
    await f.db.query(`UPDATE meta SET "enableVerifymailApi" = FALSE, "enableTruemailApi" = TRUE, "truemailInstance" = 'https://truemail.example/', "truemailAuthKey" = 'tk'`);
    verdict = () => Response.json({ email: "x@ok.example", success: false, errors: { mx: "mx is null" } });
    assert.deepEqual((await f.call("email-address/available", { emailAddress: "x@ok.example" })).data, { available: false, reason: "mx" });
    verdict = () => { throw new Error("down"); };
    assert.deepEqual((await f.call("email-address/available", { emailAddress: "x@ok.example" })).data, { available: false, reason: "network" });
    await f.db.query(`UPDATE meta SET "enableActiveEmailValidation" = FALSE`);
    assert.deepEqual((await f.call("email-address/available", { emailAddress: "x@ok.example" })).data, { available: true, reason: null });
    await f.db.query(`UPDATE meta SET "enableTruemailApi" = FALSE, "enableActiveEmailValidation" = TRUE`);
  });
});

describe("mail notifications", () => {
  it("abuse reports go to active `email` recipients (moderators with a verified address) and meta.email", async () => {
    const role = (await f.call("admin/roles/create", {
      name: "Mods", description: "", color: null, iconUrl: null, target: "manual", condFormula: {}, isPublic: false,
      isModerator: true, isAdministrator: false, asBadge: false, canEditMembersByModerator: false, displayOrder: 0, policies: {},
    }, "a")).data.id;
    await f.call("admin/roles/assign", { roleId: role, userId: f.ids.b }, "a");
    const rc = await f.call("admin/abuse-report/notification-recipient/create", { isActive: true, name: "mail b", method: "email", userId: f.ids.b }, "a");
    assert.equal(rc.status, 200);
    assert.equal((await f.call("users/report-abuse", { userId: f.ids.c, comment: "<i>spam</i>" }, "b")).status, 204);
    assert.deepEqual(mails.map((m) => m.to).sort(), ["b@example.org", "noreply@misskey.example.com"]);
    assert.ok(mails.every((m) => m.subject === "New Abuse Report" && m.text === "<i>spam</i>" && m.html!.includes("<i>spam</i>")));

    mails.length = 0;
    await f.call("admin/abuse-report/notification-recipient/update", { id: rc.data.id, isActive: false, name: "mail b", method: "email", userId: f.ids.b }, "a");
    await f.call("users/report-abuse", { userId: f.ids.c, comment: "again" }, "b");
    assert.deepEqual(mails.map((m) => m.to), ["noreply@misskey.example.com"]);
  });

  it("new login mail to a verified address (signin-flow)", async () => {
    const signin = async (username: string) => {
      const r = await handlers["signin-flow"]!(f.env, { username, password: "pw" }, { hasCredential: false, request: new Request("https://api.test/api/signin-flow", { method: "POST" }) });
      return r instanceof Response ? r.status : 200;
    };
    assert.equal(await signin("user_c"), 200); // unverified
    assert.equal(mails.length, 0);
    assert.equal(await signin("user_b"), 200);
    assert.equal(mails.length, 1);
    assert.equal(mails[0]!.to, "b@example.org");
    assert.equal(mails[0]!.subject, "New login / ログインがありました");
  });

  it("account deleted mail", async () => {
    await f.db.query(`UPDATE user_profile SET email = 'c@example.org', "emailVerified" = TRUE WHERE "userId" = $1`, [f.ids.c]);
    assert.equal(await deleteAccount(f.env, f.ids.c), "ok");
    assert.deepEqual(mails.map((m) => [m.to, m.subject, m.text]), [["c@example.org", "Account deleted", "Your account has been deleted."]]);
  });
});

describe("maskEmail", () => {
  it("keeps the first letter and the domain for the logs", () => {
    assert.equal(maskEmail("alice@example.com"), "a***@example.com");
    assert.equal(maskEmail("not-an-address"), "***");
  });
});
