/**
 * System webhooks and abuse-report notification recipients on PG (PGlite):
 * admin/system-webhook/* and admin/abuse-report/notification-recipient/* (moderator gate,
 * validation, pack shapes, errors, moderation_log), test sends, and dispatch of abuseReport /
 * abuseReportResolved / userCreated through mk-webhook-deliver (inline without the binding, so
 * AP_FETCH captures the requests).
 */
import { before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { IMPLEMENTED_ENDPOINTS } from "./registry.js";
import { makeFixture, type Fixture } from "./pglite-fixture.js";
import { notifyUserCreatedSystemWebhook } from "./system-webhooks-pg.js";
import { processWebhookDeliver } from "./webhooks-pg.js";
import type { ApiEnv } from "./env.js";
import { ENDPOINT_PARAM_DEFS } from "./endpoint-params.gen.js";

type Sent = { url: string; headers: Record<string, string>; body: any };
const sent: Sent[] = [];
let status = 200;
const fakeFetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
  const headers: Record<string, string> = {};
  new Headers(init?.headers).forEach((v, k) => void (headers[k] = v));
  sent.push({ url: String(url), headers, body: JSON.parse(String(init?.body)) });
  return new Response("ok", { status });
}) as typeof fetch;

let f: Fixture;
before(async () => {
  f = await makeFixture("SystemWebhookTest", { AP_FETCH: fakeFetch } as Partial<ApiEnv>);
});
beforeEach(() => {
  sent.length = 0;
  status = 200;
});

const E = (r: { data: any }) => r.data?.error?.id;
const rows = async (sql: string, p: unknown[] = []) => (await f.db.query(sql, p)).rows as any[];
const SW = "admin/system-webhook/";
const RC = "admin/abuse-report/notification-recipient/";

describe("system webhooks", () => {
  let hook = "";
  let hook2 = "";

  it("registers endpoints", () => {
    for (const e of ["create", "delete", "list", "show", "test", "update"].map((x) => SW + x).concat(["create", "delete", "list", "show", "update"].map((x) => RC + x))) {
      assert.ok((IMPLEMENTED_ENDPOINTS as readonly string[]).includes(e), e);
      assert.ok(ENDPOINT_PARAM_DEFS[e], e);
    }
  });

  it("create / list / show / update / delete", async () => {
    assert.equal((await f.call(SW + "list", {}, "b")).status, 403);
    // `secure`: anonymous → ACCESS_DENIED before the credential check (upstream isSecure)
    assert.equal((await f.call(SW + "list", {})).data.error.id, "56f35758-7dd5-468b-8439-5d6fb8ec9b8e");
    const r = await f.call(SW + "create", { isActive: true, name: "mod hook", on: ["abuseReport", "abuseReportResolved", "userCreated"], url: "https://hooks.example/sys", secret: "s3" }, "a");
    assert.equal(r.status, 200, JSON.stringify(r.data));
    hook = r.data.id;
    assert.deepEqual(Object.keys(r.data).sort(), ["id", "isActive", "latestSentAt", "latestStatus", "name", "on", "secret", "updatedAt", "url"]);
    assert.equal(r.data.latestSentAt, null);
    assert.equal(r.data.secret, "s3");
    for (const bad of [{ name: "x", on: [], url: "https://x" }, { isActive: true, name: "", on: [], url: "https://x" }, { isActive: true, name: "x", on: ["note"], url: "https://x" }, { isActive: true, name: "x", on: [] }]) {
      assert.equal((await f.call(SW + "create", bad, "a")).status, 400, JSON.stringify(bad));
    }
    const r2 = await f.call(SW + "create", { isActive: false, name: "other", on: ["userCreated"], url: "https://hooks.example/other" }, "a");
    hook2 = r2.data.id;
    assert.equal(r2.data.secret, "");
    assert.deepEqual((await f.call(SW + "list", {}, "a")).data.map((x: any) => x.id), [hook, hook2]);
    assert.deepEqual((await f.call(SW + "list", { isActive: false }, "a")).data.map((x: any) => x.id), [hook2]);
    assert.deepEqual((await f.call(SW + "list", { on: ["abuseReport", "userCreated"] }, "a")).data.map((x: any) => x.id), [hook]);
    assert.equal((await f.call(SW + "show", { id: hook }, "a")).data.name, "mod hook");
    const nf = await f.call(SW + "show", { id: "nope" }, "a");
    assert.equal(nf.status, 404);
    assert.equal(E(nf), "38dd1ffe-04b4-6ff5-d8ba-4e6a6ae22c9d");
    // update: secret defaults to ''
    const u = await f.call(SW + "update", { id: hook2, isActive: true, name: "other2", on: ["userCreated"], url: "https://hooks.example/other" }, "a");
    assert.equal(u.status, 200);
    assert.equal(u.data.name, "other2");
    assert.equal(u.data.isActive, true);
    assert.equal((await f.call(SW + "update", { id: "nope", isActive: true, name: "x", on: [], url: "https://x" }, "a")).status, 500);
    assert.equal((await f.call(SW + "delete", { id: hook2 }, "a")).status, 204);
    assert.equal((await f.call(SW + "delete", { id: hook2 }, "a")).status, 500);
    const types = (await rows(`SELECT type, info FROM moderation_log ORDER BY id`)).map((x) => x.type);
    assert.deepEqual(types, ["createSystemWebhook", "createSystemWebhook", "updateSystemWebhook", "deleteSystemWebhook"]);
    const upd = (await rows(`SELECT info FROM moderation_log WHERE type = 'updateSystemWebhook'`))[0].info;
    assert.equal(upd.before.name, "other");
    assert.equal(upd.after.name, "other2");
  });

  it("test sends a dummy payload once, with overrides", async () => {
    const nf = await f.call(SW + "test", { webhookId: "nope", type: "abuseReport" }, "a");
    assert.equal(nf.status, 400);
    assert.equal(E(nf), "0c52149c-e913-18f8-5dc7-74870bfe0cf9");
    assert.equal((await f.call(SW + "test", { webhookId: hook, type: "note" }, "a")).status, 400);
    assert.equal((await f.call(SW + "test", { webhookId: hook, type: "abuseReportResolved" }, "a")).status, 204);
    assert.equal(sent.length, 1);
    const s = sent[0]!;
    assert.equal(s.url, "https://hooks.example/sys");
    assert.equal(s.headers["x-misskey-hook-id"], hook);
    assert.equal(s.headers["x-misskey-hook-secret"], "s3");
    assert.equal(s.headers["user-agent"], "Misskey-Hooks");
    assert.deepEqual(Object.keys(s.body).sort(), ["body", "createdAt", "eventId", "hookId", "server", "type"]);
    assert.equal(s.body.type, "abuseReportResolved");
    assert.equal(s.body.body.assignee.id, "dummy-user-3");
    assert.equal(s.body.body.resolved, true);
    await f.call(SW + "test", { webhookId: hook, type: "inactiveModeratorsWarning", override: { url: "https://hooks.example/o", secret: "x" } }, "a");
    assert.equal(sent[1]!.url, "https://hooks.example/o");
    assert.equal(sent[1]!.headers["x-misskey-hook-secret"], "x");
    assert.deepEqual(sent[1]!.body.body, { remainingTime: { time: 100000, asDays: 1, asHours: 24 } });
    const w = (await f.call(SW + "show", { id: hook }, "a")).data;
    assert.equal(w.latestStatus, 200);
    assert.ok(w.latestSentAt);
  });

  it("notification recipients", async () => {
    assert.equal((await f.call(RC + "list", {}, "b")).status, 403);
    const noHook = await f.call(RC + "create", { isActive: true, name: "r", method: "webhook" }, "a");
    assert.equal(E(noHook), "b0c15051-de2d-29ef-260c-9585cddd701a");
    const noUser = await f.call(RC + "create", { isActive: true, name: "r", method: "email" }, "a");
    assert.equal(E(noUser), "348bb8ae-575a-6fe9-4327-5811999def8f");
    const noMail = await f.call(RC + "create", { isActive: true, name: "r", method: "email", userId: f.ids.a }, "a");
    assert.equal(E(noMail), "7cc1d85e-2f58-fc31-b644-3de8d0d3421f");
    assert.equal((await f.call(RC + "create", { isActive: true, name: "r", method: "sms" }, "a")).status, 400);
    assert.equal((await f.call(RC + "create", { isActive: true, name: "r", method: "webhook", systemWebhookId: "nope" }, "a")).status, 500);

    const r = await f.call(RC + "create", { isActive: true, name: "hook r", method: "webhook", systemWebhookId: hook, userId: f.ids.b }, "a");
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.deepEqual(Object.keys(JSON.parse(JSON.stringify(r.data))).sort(), ["id", "isActive", "method", "name", "systemWebhook", "systemWebhookId", "updatedAt"]);
    assert.equal(r.data.systemWebhook.id, hook);
    const rid = r.data.id;

    await f.db.query(`UPDATE user_profile SET email = 'a@example.com', "emailVerified" = TRUE WHERE "userId" IN ($1, $2)`, [f.ids.a, f.ids.b]);
    const m = await f.call(RC + "create", { isActive: true, name: "mail a", method: "email", userId: f.ids.a, systemWebhookId: hook }, "a");
    assert.equal(m.status, 200);
    assert.equal(m.data.user.id, f.ids.a);
    assert.equal(m.data.user.username, "user_a");
    assert.equal(m.data.systemWebhookId, undefined);
    // b is not a moderator: listed recipients drop (and delete) it, as upstream
    const mb = await f.call(RC + "create", { isActive: true, name: "mail b", method: "email", userId: f.ids.b }, "a");
    assert.equal(mb.status, 200);
    assert.deepEqual((await f.call(RC + "list", {}, "a")).data.map((x: any) => x.id), [rid, m.data.id]);
    assert.equal((await rows(`SELECT 1 FROM abuse_report_notification_recipient WHERE id = $1`, [mb.data.id])).length, 0);
    assert.deepEqual((await f.call(RC + "list", { method: ["webhook"] }, "a")).data.map((x: any) => x.id), [rid]);
    assert.deepEqual((await f.call(RC + "list", { method: ["email"] }, "a")).data.map((x: any) => x.id), [m.data.id]);

    assert.equal((await f.call(RC + "show", { id: rid }, "a")).data.name, "hook r");
    const nf = await f.call(RC + "show", { id: "nope" }, "a");
    assert.equal(nf.status, 404);
    assert.equal(E(nf), "013de6a8-f757-04cb-4d73-cc2a7e3368e4");

    const u = await f.call(RC + "update", { id: m.data.id, isActive: false, name: "mail a2", method: "webhook", systemWebhookId: hook }, "a");
    assert.equal(u.status, 200);
    assert.equal(u.data.method, "webhook");
    assert.equal(u.data.userId, undefined);
    assert.equal(u.data.systemWebhookId, hook);
    assert.equal((await f.call(RC + "update", { id: "nope", isActive: false, name: "x", method: "webhook", systemWebhookId: hook }, "a")).status, 500);
    assert.equal((await f.call(RC + "delete", { id: m.data.id }, "a")).status, 204);
    assert.equal((await f.call(RC + "delete", { id: "nope" }, "a")).status, 204);
    const types = (await rows(`SELECT type FROM moderation_log WHERE type LIKE '%Recipient' ORDER BY id`)).map((x) => x.type);
    assert.deepEqual(types, [
      "createAbuseReportNotificationRecipient", "createAbuseReportNotificationRecipient", "createAbuseReportNotificationRecipient",
      "updateAbuseReportNotificationRecipient", "deleteAbuseReportNotificationRecipient", "deleteAbuseReportNotificationRecipient",
    ]);
  });

  it("abuseReport / abuseReportResolved dispatch", async () => {
    assert.equal((await f.call("users/report-abuse", { userId: f.ids.c, comment: "spam" }, "b")).status, 204);
    const ev = sent.filter((s) => s.body.type === "abuseReport");
    assert.equal(ev.length, 1);
    const p = ev[0]!.body.body;
    assert.equal(ev[0]!.url, "https://hooks.example/sys");
    assert.equal(p.comment, "spam");
    assert.equal(p.reporter.id, f.ids.b);
    assert.equal(p.targetUser.id, f.ids.c);
    assert.equal(p.assignee, null);
    assert.equal(p.resolved, false);
    assert.equal(p.targetUserHost, null);
    sent.length = 0;
    await f.call("admin/resolve-abuse-user-report", { reportId: p.id, resolvedAs: "accept" }, "a");
    const res = sent.filter((s) => s.body.type === "abuseReportResolved");
    assert.equal(res.length, 1);
    assert.equal(res[0]!.body.body.assignee.id, f.ids.a);
    assert.equal(res[0]!.body.body.resolvedAs, "accept");

    // a webhook linked to an inactive recipient is excluded
    sent.length = 0;
    await f.call(RC + "create", { isActive: false, name: "off", method: "webhook", systemWebhookId: hook }, "a");
    await f.call("users/report-abuse", { userId: f.ids.c, comment: "again" }, "b");
    assert.equal(sent.length, 0);
  });

  it("userCreated dispatch and system delivery recording", async () => {
    await notifyUserCreatedSystemWebhook(f.env, f.ids.c);
    const ev = sent.filter((s) => s.body.type === "userCreated");
    assert.equal(ev.length, 1);
    assert.equal(ev[0]!.body.body.id, f.ids.c);
    assert.equal(ev[0]!.body.body.username, "user_c");
    // inactive webhooks receive nothing
    await f.call(SW + "update", { id: hook, isActive: false, name: "mod hook", on: ["userCreated"], url: "https://hooks.example/sys", secret: "s3" }, "a");
    sent.length = 0;
    await notifyUserCreatedSystemWebhook(f.env, f.ids.c);
    assert.equal(sent.length, 0);
    status = 404;
    const out = await processWebhookDeliver(f.env, { kind: "systemWebhook", webhookId: hook, to: "https://hooks.example/sys", secret: "", type: "userCreated", content: {}, createdAt: 0, eventId: "e" });
    assert.equal(out, "dropped");
    assert.equal((await f.call(SW + "show", { id: hook }, "a")).data.latestStatus, 404);
    // deleting the webhook removes its recipients
    await f.call(SW + "delete", { id: hook }, "a");
    assert.equal((await rows(`SELECT 1 FROM abuse_report_notification_recipient`)).length, 0);
  });
});
