/**
 * Remaining admin endpoints on PG (PGlite): accounts/delete / find-by-email, drive administration
 * (files / show-file / cleanup / clean-remote-files / delete-all-files-of-a-user, inline and as
 * mk-jobs steps), unset-mfa / unset-user-avatar / unset-user-banner, update-proxy-account,
 * get-index-stats / get-table-stats and captcha/current / captcha/save (provider siteverify mocked
 * through AP_FETCH).
 */
import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { genAidx } from "../../id/src/index.js";
import { IMPLEMENTED_ENDPOINTS } from "./registry.js";
import { ENDPOINT_META } from "./endpoint-meta.gen.js";
import { handlers } from "./endpoints/index.js";
import { makeFixture, type Fixture } from "./pglite-fixture.js";
import { runJobStep, type JobMessage } from "./jobs.js";
import { DRIVE_CLEANUP_BATCH } from "./admin-misc-pg.js";
import type { ApiEnv } from "./env.js";
import { ENDPOINT_PARAM_DEFS } from "./endpoint-params.gen.js";

const r2Deleted: string[] = [];
const bucket = { delete: async (keys: string | string[]) => void r2Deleted.push(...(Array.isArray(keys) ? keys : [keys])) };
const fetched: { url: string; body: string }[] = [];
let verdict: (url: string) => Response = () => Response.json({ success: true });
const apFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  fetched.push({ url, body: String(init?.body ?? "") });
  return verdict(url);
}) as typeof fetch;

let f: Fixture;
let modRole = "";
let seq = 0;
before(async () => {
  f = await makeFixture("AdminMiscTest", { MEDIA_BUCKET: bucket as unknown as ApiEnv["MEDIA_BUCKET"], AP_FETCH: apFetch });
  // b is a moderator through a role (a = root = administrator, c = plain user)
  modRole = (await f.call("admin/roles/create", {
    name: "Mods", description: "", color: null, iconUrl: null, target: "manual", condFormula: {}, isPublic: false,
    isModerator: true, isAdministrator: false, asBadge: false, canEditMembersByModerator: false, displayOrder: 0, policies: {},
  }, "a")).data.id;
  await f.call("admin/roles/assign", { roleId: modRole, userId: f.ids.b }, "a");
});

const E = (r: { data: any }) => r.data?.error?.id;

describe("ApiCallService gate on every requireModerator / requireAdmin endpoint", () => {
  // checked before the params (an empty body must not reach param validation first)
  const gated = Object.entries(ENDPOINT_META)
    .filter(([name, m]) => (m.requireModerator || m.requireAdmin) && handlers[name] && (IMPLEMENTED_ENDPOINTS as readonly string[]).includes(name))
    .map(([name, m]) => ({ name, mod: Boolean(m.requireModerator), admin: Boolean(m.requireAdmin), secure: Boolean(m.secure) }));
  it("anonymous → 401 CREDENTIAL_REQUIRED (`secure` ones: ACCESS_DENIED first, as upstream's isSecure needs a user)", async () => {
    for (const g of gated) {
      const r = await f.call(g.name, {});
      assert.deepEqual([r.status, E(r)], g.secure ? [400, "56f35758-7dd5-468b-8439-5d6fb8ec9b8e"] : [401, "1384574d-a912-4b81-8601-c7b1c4085df1"], g.name);
    }
  });
  it("plain user → ROLE_PERMISSION_DENIED (moderator id first, as upstream)", async () => {
    for (const g of gated) {
      const r = await f.call(g.name, {}, "c");
      assert.deepEqual([r.status, E(r)], [403, g.mod ? "d33d5333-db36-423d-a8f9-1a2b9549da41" : "c3d38592-54c0-429d-be96-5636b0431a61"], g.name);
    }
  });
  it("requiredRolePolicy admin endpoints → 7f86f06f before the params", async () => {
    const policy = ["admin/emoji/add", "admin/emoji/add-aliases-bulk", "admin/emoji/copy", "admin/emoji/list", "admin/emoji/delete", "admin/emoji/delete-bulk",
      "admin/emoji/update", "admin/emoji/set-license-bulk", "admin/emoji/set-aliases-bulk", "admin/emoji/set-category-bulk", "admin/emoji/list-remote",
      "admin/emoji/remove-aliases-bulk", "admin/avatar-decorations/list", "admin/avatar-decorations/delete", "admin/avatar-decorations/update",
      "admin/avatar-decorations/create", "v2/admin/emoji/list"];
    for (const name of policy) {
      const r = await f.call(name, {}, "c");
      assert.deepEqual([r.status, E(r)], [403, "7f86f06f-7e15-4057-8561-f4b6d4ac755a"], name);
      assert.equal((await f.call(name, {})).status, 401, name);
    }
  });
  it("moderator → requireAdmin endpoints refuse with the administrator id", async () => {
    for (const g of gated.filter((x) => x.admin)) {
      const r = await f.call(g.name, {}, "b");
      assert.deepEqual([r.status, E(r)], [403, "c3d38592-54c0-429d-be96-5636b0431a61"], g.name);
    }
  });
});
const count = async (sql: string, p: unknown[] = []) => Number(((await f.db.query(sql, p)).rows[0] as any).n);
const logs = async (type: string) => (await f.db.query(`SELECT info FROM moderation_log WHERE type = $1 ORDER BY id`, [type])).rows.map((r: any) => r.info);

async function file(fields: Record<string, unknown> = {}): Promise<string> {
  const id = genAidx(Date.now() + seq++);
  const row = { id, md5: "0", size: 0, storedInternal: false, type: "image/png", name: `f${seq}.png`, url: `https://misskey.example.com/files/${id}`, accessKey: `ak-${id}`, ...fields };
  const cols = Object.keys(row);
  await f.db.query(`INSERT INTO drive_file (${cols.map((c) => `"${c}"`).join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")})`, Object.values(row));
  return id;
}

describe("admin/meta and admin/update-meta", () => {
  it("update-meta validates upstream's paramDef, answers 204 and logs updateServerSettings", async () => {
    assert.equal((await f.call("admin/update-meta", { themeColor: "red" }, "a")).status, 400); // pattern
    assert.equal((await f.call("admin/update-meta", { federation: "some" }, "a")).status, 400); // enum
    assert.equal((await f.call("admin/update-meta", { blockedHosts: [1] }, "a")).status, 400);
    const r = await f.call("admin/update-meta", {
      themeColor: "#aabbcc", blockedHosts: ["A.example", ""], silencedHosts: ["z.example", "a.example", "a.example", "", "a.example"],
      clientOptions: { showTimelineForVisitor: true }, repositoryUrl: "not a url", enableServiceWorker: true,
    }, "a");
    assert.equal(r.status, 204);
    const m = (await f.db.query(`SELECT "blockedHosts", "silencedHosts", "themeColor", "clientOptions", "repositoryUrl", "enableServiceWorker" FROM meta`)).rows[0] as any;
    assert.deepEqual(m.blockedHosts, ["a.example"]);
    assert.deepEqual(m.silencedHosts, ["z.example"]); // sorted, deduplicated, "" and blocked hosts dropped
    assert.deepEqual([m.themeColor, m.clientOptions, m.repositoryUrl, m.enableServiceWorker], ["#aabbcc", { showTimelineForVisitor: true }, null, true]);
    const log = (await f.db.query(`SELECT info FROM moderation_log WHERE type = 'updateServerSettings' ORDER BY id DESC LIMIT 1`)).rows[0] as any;
    assert.deepEqual([log.info.before.themeColor, log.info.after.themeColor], [null, "#aabbcc"]);
  });

  it("admin/accounts/create after setup: administrators only, the endpoint's own ACCESS_DENIED (400)", async () => {
    const ad = "1fb7cb09-d46a-4fff-b8df-057708cce513";
    assert.deepEqual([(await f.call("admin/accounts/create", { username: "newbie", password: "x" })).status, E(await f.call("admin/accounts/create", { username: "newbie", password: "x" }))], [400, ad]);
    assert.equal(E(await f.call("admin/accounts/create", { username: "newbie", password: "x" }, "b")), ad); // moderator, not administrator
    assert.equal(E(await f.call("admin/accounts/create", { username: "bad name", password: "x" }, "a")), "3d81ceae-475f-4600-b2a8-2bc116157532");
    assert.equal(E(await f.call("admin/accounts/create", { username: "x".repeat(21), password: "x" }, "a")), "3d81ceae-475f-4600-b2a8-2bc116157532");
  });

  it("admin/meta answers upstream's admin view of the row", async () => {
    const r = await f.call("admin/meta", {}, "a");
    assert.equal(r.status, 200);
    assert.equal(r.data.themeColor, "#aabbcc");
    assert.deepEqual(r.data.blockedHosts, ["a.example"]);
    assert.equal(r.data.enableServiceWorker, true);
    assert.equal(r.data.uri, "https://misskey.example.com");
    assert.equal(typeof r.data.proxyAccountId, "string");
    assert.equal(r.data.policies.canPublicNote, true); // DEFAULT_POLICIES merged in
    assert.ok("hcaptchaSecretKey" in r.data && "swPrivateKey" in r.data && "summalyProxy" in r.data);
  });
});

describe("admin misc", () => {
  it("registers endpoints", () => {
    for (const e of [
      "admin/accounts/delete", "admin/accounts/find-by-email", "admin/delete-all-files-of-a-user", "admin/drive/clean-remote-files",
      "admin/drive/cleanup", "admin/drive/files", "admin/drive/show-file", "admin/unset-mfa", "admin/unset-user-avatar",
      "admin/unset-user-banner", "admin/update-proxy-account", "admin/get-index-stats", "admin/get-table-stats",
      "admin/captcha/current", "admin/captcha/save",
    ]) {
      assert.ok((IMPLEMENTED_ENDPOINTS as readonly string[]).includes(e), e);
      assert.ok(ENDPOINT_PARAM_DEFS[e], e);
    }
  });

  it("accounts/find-by-email (admin only)", async () => {
    await f.db.query(`UPDATE user_profile SET email = 'c@example.com' WHERE "userId" = $1`, [f.ids.c]);
    assert.equal((await f.call("admin/accounts/find-by-email", { email: "c@example.com" }, "b")).status, 403);
    const r = await f.call("admin/accounts/find-by-email", { email: "c@example.com" }, "a");
    assert.equal(r.status, 200);
    assert.equal(r.data.id, f.ids.c);
    assert.equal(r.data.username, "user_c");
    assert.equal(E(await f.call("admin/accounts/find-by-email", { email: "x@example.com" }, "a")), "cb865949-8af5-4062-a88c-ef55e8786d1d");
    assert.equal((await f.call("admin/accounts/find-by-email", {}, "a")).status, 400);
  });

  it("unset-user-avatar / unset-user-banner", async () => {
    await file({ id: "av1" });
    await file({ id: "bn1" });
    await f.db.query(`UPDATE "user" SET "avatarId" = 'av1', "avatarUrl" = 'https://x/a.png', "bannerId" = 'bn1', "bannerUrl" = 'https://x/b.png' WHERE id = $1`, [f.ids.c]);
    assert.equal((await f.call("admin/unset-user-avatar", { userId: f.ids.c }, "c")).status, 403);
    assert.equal((await f.call("admin/unset-user-avatar", { userId: "nope" }, "b")).status, 500);
    assert.equal((await f.call("admin/unset-user-avatar", { userId: f.ids.c }, "b")).status, 204);
    assert.equal((await f.call("admin/unset-user-banner", { userId: f.ids.c }, "b")).status, 204);
    const u = (await f.db.query(`SELECT "avatarId", "avatarUrl", "bannerId", "bannerUrl" FROM "user" WHERE id = $1`, [f.ids.c])).rows[0] as any;
    assert.deepEqual(u, { avatarId: null, avatarUrl: null, bannerId: null, bannerUrl: null });
    assert.deepEqual(await logs("unsetUserAvatar"), [{ userId: f.ids.c, userUsername: "user_c", userHost: null, fileId: "av1" }]);
    assert.equal((await logs("unsetUserBanner"))[0].fileId, "bn1");
    // nothing to unset: no further log
    assert.equal((await f.call("admin/unset-user-avatar", { userId: f.ids.c }, "b")).status, 204);
    assert.equal((await logs("unsetUserAvatar")).length, 1);
    await f.db.query(`DELETE FROM drive_file WHERE id IN ('av1', 'bn1')`);
  });

  it("unset-mfa", async () => {
    await f.db.query(`UPDATE user_profile SET "twoFactorEnabled" = TRUE, "twoFactorSecret" = 's', "twoFactorBackupSecret" = '{a}', "usePasswordLessLogin" = TRUE WHERE "userId" = ANY($1)`, [[f.ids.a, f.ids.c]]);
    await f.db.query(`INSERT INTO user_security_key (id, "userId", "publicKey", name) VALUES ('k1', $1, 'pk', 'key')`, [f.ids.c]);
    assert.equal(E(await f.call("admin/unset-mfa", { userId: "nope" }, "b")), "ccafc7fe-5074-4edd-9dc0-8ef9ef6a701d");
    // b (moderator) may not touch an administrator
    assert.equal(E(await f.call("admin/unset-mfa", { userId: f.ids.a }, "b")), "cda8f8ce-89a6-4f92-8055-33bbe0c1464d");
    assert.equal((await f.call("admin/unset-mfa", { userId: f.ids.c }, "b")).status, 204);
    const p = (await f.db.query(`SELECT "twoFactorEnabled", "twoFactorSecret", "twoFactorBackupSecret", "usePasswordLessLogin" FROM user_profile WHERE "userId" = $1`, [f.ids.c])).rows[0] as any;
    assert.deepEqual(p, { twoFactorEnabled: false, twoFactorSecret: null, twoFactorBackupSecret: null, usePasswordLessLogin: false });
    assert.equal(await count(`SELECT count(*) AS n FROM user_security_key WHERE "userId" = $1`, [f.ids.c]), 0);
    assert.equal((await logs("unsetMfa")).length, 1);
    // an administrator may unset their own
    assert.equal((await f.call("admin/unset-mfa", { userId: f.ids.a }, "a")).status, 204);
  });

  it("drive/files and drive/show-file", async () => {
    const local1 = await file({ userId: f.ids.c, type: "image/png", requestIp: "10.0.0.1", requestHeaders: JSON.stringify({ ua: "x" }) });
    const local2 = await file({ userId: f.ids.c, type: "video/mp4" });
    const remote = await file({ userId: f.ids.c, userHost: "remote.example", type: "image/jpeg", uri: "https://remote.example/f.jpg" });
    assert.equal((await f.call("admin/drive/files", {}, "c")).status, 403);
    const all = await f.call("admin/drive/files", { limit: 100 }, "b");
    assert.equal(all.status, 200);
    assert.deepEqual(all.data.map((x: any) => x.id), [local2, local1]); // origin defaults to local
    assert.equal(all.data[0].userId, f.ids.c);
    assert.equal(all.data[0].user.id, f.ids.c);
    assert.deepEqual((await f.call("admin/drive/files", { origin: "remote" }, "b")).data.map((x: any) => x.id), [remote]);
    assert.deepEqual((await f.call("admin/drive/files", { origin: "combined", hostname: "remote.example" }, "b")).data.map((x: any) => x.id), [remote]);
    assert.deepEqual((await f.call("admin/drive/files", { type: "image/*", origin: "combined" }, "b")).data.map((x: any) => x.id), [remote, local1]);
    assert.deepEqual((await f.call("admin/drive/files", { userId: f.ids.c, type: "video/mp4" }, "b")).data.map((x: any) => x.id), [local2]);
    assert.equal((await f.call("admin/drive/files", { type: "bad type" }, "b")).status, 400);
    assert.equal((await f.call("admin/drive/files", { limit: 101 }, "b")).status, 400);

    const s = await f.call("admin/drive/show-file", { fileId: local1 }, "b");
    assert.equal(s.status, 200);
    assert.equal(s.data.id, local1);
    assert.equal(s.data.requestIp, "10.0.0.1");
    assert.deepEqual(s.data.requestHeaders, { ua: "x" });
    assert.equal(s.data.isLink, false);
    assert.equal(s.data.webpublicType, null);
    assert.equal(typeof s.data.createdAt, "string");
    const byUrl = await f.call("admin/drive/show-file", { url: `https://misskey.example.com/files/${local2}` }, "b");
    assert.equal(byUrl.data.id, local2);
    assert.equal(E(await f.call("admin/drive/show-file", { fileId: "nope" }, "b")), "caf3ca38-c6e5-472e-a30c-b05377dcc240");
    // headers hidden when the owner is a moderator
    const modFile = await file({ userId: f.ids.b, requestHeaders: JSON.stringify({ ua: "y" }) });
    assert.equal((await f.call("admin/drive/show-file", { fileId: modFile }, "b")).data.requestHeaders, null);
    await f.db.query(`DELETE FROM drive_file`);
  });

  it("delete-all-files-of-a-user / drive/cleanup / drive/clean-remote-files (inline)", async () => {
    r2Deleted.length = 0;
    const cFiles = [];
    for (let i = 0; i < DRIVE_CLEANUP_BATCH + 3; i++) cFiles.push(await file({ userId: f.ids.c }));
    const bFile = await file({ userId: f.ids.b });
    assert.equal((await f.call("admin/delete-all-files-of-a-user", { userId: f.ids.c }, "b")).status, 403); // admin only
    assert.equal((await f.call("admin/delete-all-files-of-a-user", { userId: f.ids.c }, "a")).status, 204);
    assert.equal(await count(`SELECT count(*) AS n FROM drive_file WHERE "userId" = $1`, [f.ids.c]), 0);
    assert.equal(await count(`SELECT count(*) AS n FROM drive_file WHERE id = $1`, [bFile]), 1);
    assert.equal(r2Deleted.length, cFiles.length);

    const sys = await file({ userId: null });
    assert.equal((await f.call("admin/drive/cleanup", {}, "b")).status, 204);
    assert.equal(await count(`SELECT count(*) AS n FROM drive_file WHERE id = $1`, [sys]), 0);
    assert.equal(await count(`SELECT count(*) AS n FROM drive_file WHERE id = $1`, [bFile]), 1);

    r2Deleted.length = 0;
    const withUri = await file({ userId: f.ids.c, userHost: "remote.example", uri: "https://remote.example/a.png", thumbnailUrl: "https://t", thumbnailAccessKey: "tk" });
    const noUri = await file({ userId: f.ids.c, userHost: "remote.example" });
    const link = await file({ userId: f.ids.c, userHost: "remote.example", isLink: true, uri: "https://remote.example/b.png" });
    assert.equal((await f.call("admin/drive/clean-remote-files", {}, "b")).status, 204);
    const w = (await f.db.query(`SELECT * FROM drive_file WHERE id = $1`, [withUri])).rows[0] as any;
    assert.equal(w.isLink, true);
    assert.equal(w.url, "https://remote.example/a.png");
    assert.equal(w.thumbnailUrl, null);
    assert.equal(w.storedInternal, false);
    assert.notEqual(w.accessKey, `ak-${withUri}`);
    assert.match(w.thumbnailAccessKey, /^thumbnail-/);
    assert.equal(await count(`SELECT count(*) AS n FROM drive_file WHERE id = $1`, [noUri]), 0);
    assert.equal(await count(`SELECT count(*) AS n FROM drive_file WHERE id = $1`, [link]), 1);
    assert.deepEqual(r2Deleted.sort(), [`drive/ak-${noUri}`, `drive/ak-${withUri}`, "drive/tk"].sort());
    await f.db.query(`DELETE FROM drive_file`);
  });

  it("drive cleanup through mk-jobs in bounded steps", async () => {
    const sent: JobMessage[] = [];
    const env = { ...f.env, Q_JOBS: { send: async (b: unknown) => void sent.push(b as JobMessage) } } as ApiEnv;
    for (let i = 0; i < DRIVE_CLEANUP_BATCH + 1; i++) await file({ userId: f.ids.c, userHost: "remote.example", uri: `https://remote.example/${i}` });
    const { adminMiscHandlers } = await import("./admin-misc-pg.js");
    const res = (await adminMiscHandlers["admin/drive/clean-remote-files"]!(env, { i: "bbbbbbbbbbbbbbbb" }, {
      hasCredential: true, request: new Request("https://api.test/api/admin/drive/clean-remote-files", { method: "POST" }),
    })) as Response;
    assert.equal(res.status, 204);
    assert.equal(sent.length, 1);
    assert.equal(await count(`SELECT count(*) AS n FROM drive_file WHERE "isLink" = FALSE`), DRIVE_CLEANUP_BATCH + 1); // nothing yet
    const next = await runJobStep(env, sent[0]!);
    assert.ok(next && next.kind === "driveCleanup" && next.cursor);
    assert.equal(await count(`SELECT count(*) AS n FROM drive_file WHERE "isLink" = FALSE`), 1);
    assert.equal(await runJobStep(env, next!), null);
    assert.equal(await count(`SELECT count(*) AS n FROM drive_file WHERE "isLink" = FALSE`), 0);
    await f.db.query(`DELETE FROM drive_file`);
  });

  it("update-proxy-account", async () => {
    assert.equal((await f.call("admin/update-proxy-account", { description: "x" }, "c")).status, 403);
    assert.equal((await f.call("admin/update-proxy-account", { description: "" }, "b")).status, 400);
    const r = await f.call("admin/update-proxy-account", { description: "proxy here" }, "b");
    assert.equal(r.status, 200);
    assert.equal(r.data.username, "system.proxy");
    assert.equal(r.data.description, "proxy here");
    assert.deepEqual((await logs("updateProxyAccountDescription"))[0], { before: null, after: "proxy here" });
    // same account the next time; no description → no log
    const again = await f.call("admin/update-proxy-account", {}, "b");
    assert.equal(again.data.id, r.data.id);
    assert.equal((await logs("updateProxyAccountDescription")).length, 1);
  });

  it("concurrent first fetches of a system account create one user", async () => {
    const { runWithPgScope, withHyperdriveClient } = await import("./pg.js");
    const { fetchSystemAccountC } = await import("./ap/relay.js");
    // calls sharing one request connection interleave their queries like separate isolates would
    const ids = await runWithPgScope(() =>
      Promise.all([0, 1, 2].map(() => withHyperdriveClient(f.env.HYPERDRIVE!, (c) => fetchSystemAccountC(c, "relay")))),
    );
    assert.equal(new Set(ids).size, 1);
    const users = (await f.db.query(`SELECT id FROM "user" WHERE "usernameLower" = 'system.relay' AND host IS NULL`)).rows;
    assert.deepEqual(users.map((u) => (u as { id: string }).id), [ids[0]]);
  });

  it("get-index-stats / get-table-stats", async () => {
    assert.equal((await f.call("admin/get-index-stats", {}, "b")).status, 403);
    const idx = await f.call("admin/get-index-stats", {}, "a");
    assert.equal(idx.status, 200);
    assert.ok(Array.isArray(idx.data));
    assert.ok(idx.data.some((x: any) => x.tablename === "user" && typeof x.indexname === "string"));
    const t = await f.call("admin/get-table-stats", {}, "a");
    assert.equal(t.status, 200);
    assert.equal(typeof t.data.user.count, "number");
    assert.equal(typeof t.data.user.size, "number");
  });

  it("captcha/current / captcha/save", async () => {
    assert.equal((await f.call("admin/captcha/current", {}, "b")).status, 403);
    let cur = await f.call("admin/captcha/current", {}, "a");
    assert.equal(cur.data.provider, "none");
    assert.deepEqual(cur.data.mcaptcha, { siteKey: null, secretKey: null, instanceUrl: null });

    assert.equal((await f.call("admin/captcha/save", { provider: "bogus" }, "a")).status, 400);
    let r = await f.call("admin/captcha/save", { provider: "hcaptcha", secret: "sec" }, "a");
    assert.equal(E(r), "26654194-410e-44e2-b42e-460ff6f92476");
    assert.equal(r.data.error.message, "hcaptcha-failed: secret and captureResult are required");

    verdict = () => Response.json({ success: false, "error-codes": ["invalid-input-response"] });
    r = await f.call("admin/captcha/save", { provider: "hcaptcha", sitekey: "site", secret: "sec", captchaResult: "tok" }, "a");
    assert.equal(r.status, 400);
    assert.equal(E(r), "c41c067f-24f3-4150-84b2-b5a3ae8c2214");
    assert.equal(r.data.error.message, "hcaptcha-failed: invalid-input-response");
    assert.equal(fetched.at(-1)!.url, "https://hcaptcha.com/siteverify");
    assert.equal(fetched.at(-1)!.body, "secret=sec&response=tok");

    verdict = () => new Response("down", { status: 503 });
    r = await f.call("admin/captcha/save", { provider: "turnstile", sitekey: "site", secret: "sec", captchaResult: "tok" }, "a");
    assert.equal(r.status, 500);
    assert.equal(E(r), "0f4fe2f1-2c15-4d6e-b714-efbfcde231cd");
    assert.equal((await f.call("admin/captcha/current", {}, "a")).data.provider, "none");

    verdict = () => Response.json({ success: true });
    r = await f.call("admin/captcha/save", { provider: "turnstile", sitekey: "site", secret: "sec", captchaResult: "tok" }, "a");
    assert.equal(r.status, 204);
    assert.equal(fetched.at(-1)!.url, "https://challenges.cloudflare.com/turnstile/v0/siteverify");
    cur = await f.call("admin/captcha/current", {}, "a");
    assert.equal(cur.data.provider, "turnstile");
    assert.deepEqual(cur.data.turnstile, { siteKey: "site", secretKey: "sec" });

    // recaptcha
    r = await f.call("admin/captcha/save", { provider: "recaptcha", sitekey: "rs", secret: "rk", captchaResult: "tok" }, "a");
    assert.equal(r.status, 204);
    assert.equal(fetched.at(-1)!.url, "https://www.recaptcha.net/recaptcha/api/siteverify");
    assert.equal((await f.call("admin/captcha/current", {}, "a")).data.provider, "recaptcha");

    // mcaptcha: JSON body to <instance>/api/v1/pow/siteverify, `valid`
    verdict = () => Response.json({ valid: false });
    r = await f.call("admin/captcha/save", { provider: "mcaptcha", sitekey: "ms", secret: "mk", instanceUrl: "https://mc.example", captchaResult: "tok" }, "a");
    assert.equal(E(r), "c41c067f-24f3-4150-84b2-b5a3ae8c2214");
    assert.equal(fetched.at(-1)!.url, "https://mc.example/api/v1/pow/siteverify");
    assert.deepEqual(JSON.parse(fetched.at(-1)!.body), { key: "ms", secret: "mk", token: "tok" });
    verdict = () => Response.json({ valid: true });
    assert.equal((await f.call("admin/captcha/save", { provider: "mcaptcha", sitekey: "ms", secret: "mk", instanceUrl: "https://mc.example", captchaResult: "tok" }, "a")).status, 204);
    cur = await f.call("admin/captcha/current", {}, "a");
    assert.equal(cur.data.provider, "mcaptcha");
    assert.deepEqual(cur.data.mcaptcha, { siteKey: "ms", secretKey: "mk", instanceUrl: "https://mc.example" });
    assert.deepEqual(cur.data.turnstile, { siteKey: "site", secretKey: "sec" }); // other providers' keys kept

    // testcaptcha (no fetch)
    const before = fetched.length;
    assert.equal(E(await f.call("admin/captcha/save", { provider: "testcaptcha", captchaResult: "nope" }, "a")), "c41c067f-24f3-4150-84b2-b5a3ae8c2214");
    assert.equal((await f.call("admin/captcha/save", { provider: "testcaptcha", captchaResult: "testcaptcha-passed" }, "a")).status, 204);
    assert.equal(fetched.length, before);
    assert.equal((await f.call("admin/captcha/current", {}, "a")).data.provider, "testcaptcha");

    assert.equal((await f.call("admin/captcha/save", { provider: "none" }, "a")).status, 204);
    assert.equal((await f.call("admin/captcha/current", {}, "a")).data.provider, "none");
  });

  it("accounts/delete", async () => {
    assert.equal((await f.call("admin/accounts/delete", { userId: f.ids.c }, "b")).status, 403);
    assert.equal((await f.call("admin/accounts/delete", { userId: "nope" }, "a")).status, 500);
    assert.equal((await f.call("admin/accounts/delete", { userId: f.ids.a }, "a")).status, 500); // root
    await f.note(f.ids.c, { text: "bye" });
    assert.equal((await f.call("admin/accounts/delete", { userId: f.ids.c }, "a")).status, 204);
    assert.equal(await count(`SELECT count(*) AS n FROM "user" WHERE id = $1`, [f.ids.c]), 0);
    assert.equal(await count(`SELECT count(*) AS n FROM note WHERE "userId" = $1`, [f.ids.c]), 0);
    assert.equal((await logs("deleteAccount"))[0].userId, f.ids.c);
  });
});
