/**
 * User webhooks on PG (PGlite): i/webhooks/* (validation, webhookLimit, ownership), test sends,
 * event hooks (note / reply / renote / mention / follow / followed / unfollow), the delivery
 * request shape, latestSentAt / latestStatus, URL guard, and the mk-webhook-deliver consumer
 * retry rules. Without the queue binding deliveries run inline, so AP_FETCH captures them.
 */
import { before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { IMPLEMENTED_ENDPOINTS } from "./registry.js";
import { makeFixture, type Fixture } from "./pglite-fixture.js";
import { handleApQueueBatch } from "./index.js";
import { isSafeWebhookUrl, processWebhookDeliver, type WebhookDeliverMessage } from "./webhooks-pg.js";
import type { ApiEnv } from "./env.js";
import { ENDPOINT_PARAM_DEFS } from "./endpoint-params.gen.js";

type Sent = { url: string; headers: Record<string, string>; body: any };
const sent: Sent[] = [];
let status = 200;
const fakeFetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
  const headers: Record<string, string> = {};
  new Headers(init?.headers).forEach((v, k) => void (headers[k] = v));
  sent.push({ url: String(url), headers, body: JSON.parse(String(init?.body)) });
  if (status === 0) throw new TypeError("network");
  return new Response("ok", { status });
}) as typeof fetch;

let f: Fixture;
before(async () => {
  f = await makeFixture("WebhookTest", { AP_FETCH: fakeFetch } as Partial<ApiEnv>);
});
beforeEach(() => {
  sent.length = 0;
  status = 200;
});

const E = (r: { data: any }) => r.data?.error?.id;
/** deliveries to b's hook (c owns `note` hooks of its own) */
const ofType = (t: string) => sent.filter((s) => s.body.type === t && s.url === "https://hooks.example/b");

describe("i/webhooks", () => {
  let hookB = "";

  it("registers endpoints", () => {
    for (const e of ["i/webhooks/create", "i/webhooks/update", "i/webhooks/delete", "i/webhooks/list", "i/webhooks/show", "i/webhooks/test"]) {
      assert.ok((IMPLEMENTED_ENDPOINTS as readonly string[]).includes(e), e);
      assert.ok(ENDPOINT_PARAM_DEFS[e], e);
    }
  });

  it("create / list / show / update / delete, validation, webhookLimit, ownership", async () => {
    const r = await f.call("i/webhooks/create", { name: "hook", url: "https://hooks.example/b", secret: "s3cret", on: ["note", "reply", "renote", "mention", "follow", "followed", "unfollow"] }, "b");
    assert.equal(r.status, 200, JSON.stringify(r.data));
    hookB = r.data.id;
    assert.deepEqual(Object.keys(r.data).sort(), ["active", "id", "latestSentAt", "latestStatus", "name", "on", "secret", "url", "userId"]);
    assert.equal(r.data.active, true);
    assert.equal(r.data.latestStatus, null);
    for (const bad of [{ name: "", url: "https://x", on: [] }, { name: "x", url: "https://x", on: ["nope"] }, { name: "x", url: "https://x" }, { name: "x".repeat(101), url: "https://x", on: [] }]) {
      assert.equal((await f.call("i/webhooks/create", bad, "b")).status, 400, JSON.stringify(bad));
    }
    assert.deepEqual((await f.call("i/webhooks/list", {}, "b")).data.map((x: any) => x.id), [hookB]);
    assert.deepEqual((await f.call("i/webhooks/list", {}, "c")).data, []);
    assert.equal((await f.call("i/webhooks/show", { webhookId: hookB }, "b")).data.secret, "s3cret");
    assert.equal(E(await f.call("i/webhooks/show", { webhookId: hookB }, "c")), "50f614d9-3047-4f7e-90d8-ad6b2d5fb098");
    assert.equal(E(await f.call("i/webhooks/update", { webhookId: hookB, name: "x" }, "c")), "fb0fea69-da18-45b1-828d-bd4fd1612518");
    assert.equal(E(await f.call("i/webhooks/delete", { webhookId: hookB }, "c")), "bae73e5a-5522-4965-ae19-3a8688e71d82");
    // webhookLimit (default 3)
    for (let i = 0; i < 2; i++) assert.equal((await f.call("i/webhooks/create", { name: `c${i}`, url: "https://hooks.example/c", on: ["note"] }, "c")).status, 200);
    const third = (await f.call("i/webhooks/create", { name: "c2", url: "https://hooks.example/c", on: ["note"] }, "c")).data.id;
    assert.equal(E(await f.call("i/webhooks/create", { name: "c3", url: "https://hooks.example/c", on: ["note"] }, "c")), "87a9bb19-111e-4e37-81d3-a3e7426453b0");
    assert.equal((await f.call("i/webhooks/delete", { webhookId: third }, "c")).status, 204);
    // update: secret null → ''
    assert.equal((await f.call("i/webhooks/update", { webhookId: hookB, secret: null, name: "renamed" }, "b")).status, 204);
    const s = (await f.call("i/webhooks/show", { webhookId: hookB }, "b")).data;
    assert.equal(s.secret, "");
    assert.equal(s.name, "renamed");
    await f.call("i/webhooks/update", { webhookId: hookB, secret: "s3cret" }, "b");
  });

  it("test: dummy payload once, override url/secret; reaction sends nothing", async () => {
    assert.equal((await f.call("i/webhooks/test", { webhookId: hookB, type: "note" }, "b")).status, 204);
    assert.equal(sent.length, 1);
    const s = sent[0]!;
    assert.equal(s.url, "https://hooks.example/b");
    assert.equal(s.headers["user-agent"], "Misskey-Hooks");
    assert.equal(s.headers["x-misskey-host"], "misskey.example.com");
    assert.equal(s.headers["x-misskey-hook-id"], hookB);
    assert.equal(s.headers["x-misskey-hook-secret"], "s3cret");
    assert.deepEqual(Object.keys(s.body).sort(), ["body", "createdAt", "eventId", "hookId", "server", "type", "userId"]);
    assert.equal(s.body.server, "https://misskey.example.com");
    assert.equal(s.body.userId, f.ids.b);
    assert.equal(s.body.body.note.id, "dummy-note-1");
    await f.call("i/webhooks/test", { webhookId: hookB, type: "follow", override: { url: "https://other.example/x", secret: "o" } }, "b");
    assert.equal(sent[1]!.url, "https://other.example/x");
    assert.equal(sent[1]!.headers["x-misskey-hook-secret"], "o");
    assert.equal(sent[1]!.body.body.user.id, "dummy-user-1");
    await f.call("i/webhooks/test", { webhookId: hookB, type: "reaction" }, "b");
    assert.equal(sent.length, 2);
    assert.equal(E(await f.call("i/webhooks/test", { webhookId: hookB, type: "note" }, "c")), "0c52149c-e913-18f8-5dc7-74870bfe0cf9");
    assert.equal((await f.call("i/webhooks/test", { webhookId: hookB, type: "bogus" }, "b")).status, 400);
    const w = (await f.call("i/webhooks/show", { webhookId: hookB }, "b")).data;
    assert.equal(w.latestStatus, 200);
    assert.ok(w.latestSentAt);
  });

  it("note / reply / renote / mention events", async () => {
    const own = await f.call("notes/create", { text: "mine" }, "b");
    assert.equal(own.status, 200);
    assert.deepEqual(ofType("note").map((s) => s.body.body.note.id), [own.data.createdNote.id]);
    sent.length = 0;
    const reply = (await f.call("notes/create", { text: "re", replyId: own.data.createdNote.id }, "c")).data.createdNote;
    assert.deepEqual(ofType("reply").map((s) => s.body.body.note.id), [reply.id]);
    const rn = (await f.call("notes/create", { renoteId: own.data.createdNote.id }, "c")).data.createdNote;
    assert.deepEqual(ofType("renote").map((s) => s.body.body.note.id), [rn.id]);
    const m = (await f.call("notes/create", { text: "hi @user_b" }, "c")).data.createdNote;
    // upstream: the reply target is added to the mentioned users, so the reply is a `mention` too
    assert.deepEqual(ofType("mention").map((s) => s.body.body.note.id), [reply.id, m.id]);
    assert.equal(ofType("note").length, 0); // c's notes go to c's hooks only
    assert.equal(sent.filter((x) => x.body.type === "note").length, 6); // c's 2 hooks × 3 notes
    // thread mute silences reply / mention
    await f.db.query(`INSERT INTO note_thread_muting (id, "userId", "threadId") VALUES ('tm1', $1, $2)`, [f.ids.b, own.data.createdNote.id]);
    sent.length = 0;
    await f.call("notes/create", { text: "again @user_b", replyId: own.data.createdNote.id }, "c");
    assert.equal(ofType("reply").length + ofType("mention").length, 0);
    // inactive hooks are skipped
    await f.call("i/webhooks/update", { webhookId: hookB, active: false }, "b");
    sent.length = 0;
    await f.call("notes/create", { text: "quiet" }, "b");
    assert.equal(ofType("note").length, 0);
    await f.call("i/webhooks/update", { webhookId: hookB, active: true }, "b");
  });

  it("follow / followed / unfollow (incl. block) events", async () => {
    await f.call("following/create", { userId: f.ids.c }, "b");
    assert.deepEqual(ofType("follow").map((s) => s.body.body.user.id), [f.ids.c]);
    assert.ok("followersCount" in ofType("follow")[0]!.body.body.user); // UserDetailed
    await f.call("following/create", { userId: f.ids.b }, "c");
    assert.deepEqual(ofType("followed").map((s) => s.body.body.user.id), [f.ids.c]);
    sent.length = 0;
    await f.call("following/delete", { userId: f.ids.c }, "b");
    assert.deepEqual(ofType("unfollow").map((s) => s.body.body.user.id), [f.ids.c]);
    sent.length = 0;
    // c still follows b; b blocks c → c's follow is removed (c has no unfollow hook), b followed nobody
    await f.call("following/create", { userId: f.ids.c }, "b");
    sent.length = 0;
    await f.call("blocking/create", { userId: f.ids.c }, "b");
    assert.deepEqual(ofType("unfollow").map((s) => s.body.body.user.id), [f.ids.c]);
  });
});

describe("webhook delivery", () => {
  const msg = (extra: Partial<WebhookDeliverMessage> = {}): WebhookDeliverMessage => ({
    kind: "userWebhook", webhookId: "nope", userId: "u", to: "https://hooks.example/q", secret: "", type: "note", content: {}, createdAt: 0, eventId: "e", ...extra,
  });

  it("URL guard and outcomes", async () => {
    assert.equal(isSafeWebhookUrl("http://hooks.example/x"), true);
    for (const u of ["https://localhost/x", "http://127.0.0.1/x", "https://[::1]/x", "ftp://x/y", "https://a.internal/x", "nope"]) assert.equal(isSafeWebhookUrl(u), false, u);
    assert.equal(await processWebhookDeliver(f.env, msg({ to: "http://10.0.0.1/" })), "dropped");
    assert.equal(sent.length, 0);
    status = 404;
    assert.equal(await processWebhookDeliver(f.env, msg()), "dropped");
    status = 429;
    assert.equal(await processWebhookDeliver(f.env, msg()), "retry");
    status = 503;
    assert.equal(await processWebhookDeliver(f.env, msg()), "retry");
    status = 0;
    assert.equal(await processWebhookDeliver(f.env, msg()), "retry");
  });

  it("consumer retries up to maxAttempts", async () => {
    status = 503;
    const run = async (attempts: number, maxAttempts: number) => {
      let acked = 0;
      let retried = 0;
      await handleApQueueBatch({ queue: "mk-webhook-deliver", messages: [{ body: msg({ maxAttempts }), attempts, ack: () => void acked++, retry: () => void retried++ }] }, f.env);
      return { acked, retried };
    };
    assert.deepEqual(await run(1, 4), { acked: 0, retried: 1 });
    assert.deepEqual(await run(4, 4), { acked: 1, retried: 0 });
    assert.deepEqual(await run(1, 1), { acked: 1, retried: 0 }); // test sends
  });
});
