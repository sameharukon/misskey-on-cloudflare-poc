import { describe, it } from "node:test";
import assert from "node:assert/strict";
import worker, { handleApQueueBatch } from "./index.js";
import type { ApiEnv } from "./env.js";
import { fixtureMeta } from "../../packers/src/fixtures.js";
import {
  exportPkcs8Pem,
  exportSpkiPem,
  generateRsaKeyPair,
  importSpkiPem,
  verifyRequest,
} from "../../ap/src/index.js";
import { hostAllowed, setFederationPolicy } from "./ap/federation.js";
import { enqueueDeliver, processDeliver } from "./ap/deliver.js";
import { processInbox } from "./ap/inbox.js";
import { setUserKeypairForTest } from "./ap/keys.js";
import { InMemoryQueueProducer, setQueueProducer, MK_DELIVER, MK_INBOX } from "./queues/fanout.js";
import { defaultTimelineKeysForCreate } from "./notes/row.js";
import { publishToUserStream, handleStreamingUpgrade } from "./stream-publish.js";
import { StreamHub, applyClientFrame, framesFor } from "../../stream/src/index.js";
import { signedInboxHeaders } from "./test-inbox.js";

function env(): ApiEnv {
  return {
    INSTANCE_URL: "https://local.example",
    VERSION: "0.0.0-test",
    BOOTSTRAP_META_JSON: JSON.stringify(fixtureMeta({ name: "AP" })),
  };
}
const ALL = { mode: "all" as const, hosts: [], blockedHosts: ["bad.example"] };
const ctx = { waitUntil() {}, passThroughOnException() {} };

describe("federation policy", () => {
  it("none/specified/blocked", () => {
    assert.equal(hostAllowed({ mode: "none", hosts: [], blockedHosts: [] }, "r.example"), false);
    assert.equal(hostAllowed({ mode: "specified", hosts: ["ok.example"], blockedHosts: [] }, "sub.ok.example"), true);
    assert.equal(hostAllowed({ mode: "specified", hosts: ["ok.example"], blockedHosts: [] }, "r.example"), false);
    assert.equal(hostAllowed(ALL, "x.bad.example"), false);
    assert.equal(hostAllowed(ALL, "r.example"), true);
  });
});

describe("mk-deliver", () => {
  it("federation=none refuses enqueue and drops queued messages", async () => {
    const e = env(); // no PG → policy none
    const q = new InMemoryQueueProducer();
    setQueueProducer(e, q);
    const r = await enqueueDeliver(e, "u1", ["https://r.example/inbox"], { type: "Create" });
    assert.deepEqual(r, { refused: true, queued: 0 });
    assert.equal(q.messages.length, 0);
    const out = await handleApQueueBatch(
      { queue: "mk-deliver", messages: [{ body: { kind: "deliver", signerId: "u1", inbox: "https://r.example/inbox", activity: {} }, ack() {}, retry() {} }] },
      e,
    );
    assert.deepEqual(out.results, ["dropped"]);
  });

  it("enqueue filters blocked/unsafe and dedups; consumer signs a verifiable POST", async () => {
    const e = env();
    setFederationPolicy(e, ALL);
    const q = new InMemoryQueueProducer();
    setQueueProducer(e, q);
    const r = await enqueueDeliver(e, "u1", ["https://r.example/inbox", "https://r.example/inbox", "https://bad.example/inbox", "http://r.example/i", null], { type: "Create", actor: "https://local.example/users/u1" });
    assert.deepEqual(r, { refused: false, queued: 1 });
    assert.equal(q.messages[0]!.queue, MK_DELIVER);

    const kp = await generateRsaKeyPair();
    setUserKeypairForTest(e, "u1", { publicKey: await exportSpkiPem(kp.publicKey), privateKey: await exportPkcs8Pem(kp.privateKey) });
    let captured: { url: string; init: RequestInit } | null = null;
    let status = 202;
    e.AP_FETCH = (async (url: string, init: RequestInit) => {
      captured = { url, init };
      return new Response(null, { status });
    }) as unknown as typeof fetch;
    const msg = q.messages[0]!.body as Parameters<typeof processDeliver>[1];
    assert.equal(await processDeliver(e, msg), "delivered");
    const h = captured!.init.headers as Record<string, string>;
    const lower = Object.fromEntries(Object.entries(h).map(([a, b]) => [a.toLowerCase(), b]));
    assert.match(lower.signature!, /keyId="https:\/\/local\.example\/users\/u1#main-key"/);
    const ok = await verifyRequest({ publicKey: await importSpkiPem(await exportSpkiPem(kp.publicKey)), method: "POST", pathWithQuery: "/inbox", headers: lower, signatureHeader: lower.signature! });
    assert.equal(ok, true);
    assert.equal(JSON.parse(String(captured!.init.body))["@context"] !== undefined, true);
    status = 410;
    assert.equal(await processDeliver(e, msg), "dropped");
    status = 503;
    assert.equal(await processDeliver(e, msg), "retry");
    status = 429;
    assert.equal(await processDeliver(e, msg), "retry");
  });
});

describe("inbox HTTP + consumer gating", () => {
  const post = (e: ApiEnv, path: string, headers: Record<string, string> = {}) =>
    worker.fetch(new Request(`https://local.example${path}`, { method: "POST", headers: { "content-type": "application/activity+json", ...headers }, body: JSON.stringify({ type: "Follow", actor: "https://r.example/users/1", object: "https://local.example/users/u1" }) }), e, ctx);

  it("federation=none → 403 inbox, 403 webfinger, nodeinfo still served", async () => {
    const e = env();
    assert.equal((await post(e, "/inbox")).status, 403);
    assert.equal((await post(e, "/users/abc/inbox")).status, 403);
    assert.equal((await worker.fetch(new Request("https://local.example/.well-known/webfinger?resource=acct:a@local.example"), e, ctx)).status, 403);
    const ni = await worker.fetch(new Request("https://local.example/nodeinfo/2.0"), e, ctx);
    assert.equal(ni.status, 200);
    assert.equal(((await ni.json()) as { metadata: { federation: string } }).metadata.federation, "none");
    const r = await processInbox(e, { kind: "inbox", method: "POST", path: "/inbox", headers: {}, body: "{}", receivedAt: Date.now() });
    assert.deepEqual(r, { ok: false, reason: "federation_none" });
  });

  it("federation=all → unsigned 401, signed → 202 queued; consumer rejects bad digest before key fetch", async () => {
    const e = env();
    setFederationPolicy(e, ALL);
    const q = new InMemoryQueueProducer();
    setQueueProducer(e, q);
    assert.equal((await post(e, "/inbox")).status, 401);
    const sig = 'keyId="https://r.example/users/1#main-key",algorithm="rsa-sha256",headers="(request-target) host date digest",signature="AAAA"';
    // the route checks the digest (and date / host) before queueing
    const bad = await post(e, "/inbox", { signature: sig, date: new Date().toUTCString(), digest: "SHA-256=bogus" });
    assert.equal(bad.status, 401);
    assert.equal(q.messages.length, 0);
    const body = JSON.stringify({ type: "Follow", actor: "https://r.example/users/1", object: "https://local.example/users/u1" });
    const res = await post(e, "/inbox", await signedInboxHeaders("https://local.example/inbox", body, "https://r.example/users/1#main-key"));
    assert.equal(res.status, 202);
    assert.equal(q.messages[0]!.queue, MK_INBOX);
    // and the consumer repeats them (for messages queued before)
    const m = { ...(q.messages[0]!.body as Parameters<typeof processInbox>[1]) };
    m.headers = { ...m.headers, signature: sig, digest: "SHA-256=bogus" };
    const r = await processInbox(e, m);
    assert.deepEqual(r, { ok: false, reason: "digest_mismatch" });
    // blocked host short-circuits
    const blocked = await processInbox(e, { ...m, body: JSON.stringify({ type: "Like", actor: "https://bad.example/u/1", object: "x" }) });
    assert.deepEqual(blocked, { ok: false, reason: "host_blocked" });
    // a signer on a blocked host (or its subdomain) is dropped at the route, not queued
    q.clear();
    const fromBlocked = await post(e, "/inbox", await signedInboxHeaders("https://local.example/inbox", body, "https://sub.bad.example/users/1#main-key"));
    assert.equal(fromBlocked.status, 202);
    assert.equal(q.messages.length, 0);
  });
});

describe("global timeline keys", () => {
  const n = (o: Record<string, unknown>) => ({ id: "n", userId: "u", text: "x", cw: null, visibility: "public", localOnly: false, reactionAcceptance: null, visibleUserIds: [], renoteCount: 0, repliesCount: 0, reactions: {}, fileIds: [], replyId: null, renoteId: null, channelId: null, mentions: [], hasPoll: false, uri: null, url: null, tags: [], emojis: [], userHost: null, ...o }) as Parameters<typeof defaultTimelineKeysForCreate>[0];
  it("public local → home/local/hybrid/global; remote public → global only; followers → no global", () => {
    assert.deepEqual(defaultTimelineKeysForCreate(n({})), ["home:u", "local", "hybrid", "global"]);
    assert.deepEqual(defaultTimelineKeysForCreate(n({ userHost: "r.example" })), ["global"]);
    assert.deepEqual(defaultTimelineKeysForCreate(n({ visibility: "followers" })), ["home:u"]);
  });

  it("notes/global-timeline is registered (501 without Hyperdrive, not 404)", async () => {
    const res = await worker.fetch(new Request("https://local.example/api/notes/global-timeline", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }), env(), ctx);
    assert.equal(res.status, 501);
    assert.equal(((await res.json()) as { error: { code: string } }).error.code, "HYPERDRIVE_UNBOUND");
  });
});

describe("streaming", () => {
  it("protocol helpers: connect/disconnect/heartbeat + frames", () => {
    let r = applyClientFrame({}, JSON.stringify({ type: "connect", body: { channel: "main", id: "m1" } }));
    assert.deepEqual(r.subs, { m1: "main" });
    r = applyClientFrame(r.subs, JSON.stringify({ type: "connect", body: { channel: "bogus", id: "b" } }));
    assert.equal(r.error, "unsupported_channel:bogus");
    assert.equal(applyClientFrame(r.subs, "h").changed, false);
    assert.deepEqual(framesFor(r.subs, "main", "notification", { id: "x" }).map((f) => JSON.parse(f)), [{ type: "channel", body: { id: "m1", type: "notification", body: { id: "x" } } }]);
    assert.deepEqual(framesFor(r.subs, "homeTimeline", "note", {}), []);
    assert.deepEqual(applyClientFrame(r.subs, JSON.stringify({ type: "disconnect", body: { id: "m1" } })).subs, {});
  });

  it("StreamHub DO: socket subscribes, publish delivers to main only", async () => {
    const sent: string[] = [];
    let att: unknown = { userId: "u1", subs: {} };
    const sock = { send: (d: string) => sent.push(d), close() {}, serializeAttachment: (v: unknown) => { att = v; }, deserializeAttachment: () => att };
    const hub = new StreamHub({ id: { toString: () => "h" }, acceptWebSocket() {}, getWebSockets: () => [sock] });
    await hub.webSocketMessage(sock, JSON.stringify({ type: "connect", body: { channel: "main", id: "c1" } }));
    const res = await hub.publish([{ channel: "main", type: "notification", body: { id: "n1" } }]);
    assert.equal(res.delivered, 1);
    assert.equal(JSON.parse(sent[0]!).body.id, "c1");
    await hub.publish([{ channel: "homeTimeline", type: "note", body: {} }]);
    assert.equal(sent.length, 1);
  });

  it("publishToUserStream targets user:{id}; /streaming requires upgrade + binding", async () => {
    const e = env();
    const calls: string[] = [];
    e.STREAM_HUB = {
      idFromName: (n: string) => ({ toString: () => n }),
      get: (id: { toString(): string }) => ({
        fetch: async () => new Response(null),
        publish: async (events) => {
          calls.push(`${id.toString()} ${JSON.stringify(events)}`);
          return { delivered: 2, sockets: 1 };
        },
        noteUpdated: async () => 0,
        broadcast: async () => 0,
      }),
    };
    assert.equal(await publishToUserStream(e, "u9", "main", "notification", { a: 1 }), 2);
    assert.match(calls[0]!, /^user:u9 .*"channel":"main"/);
    assert.equal((await handleStreamingUpgrade(new Request("https://local.example/streaming"), e)).status, 426);
    const noBinding = env();
    assert.equal((await handleStreamingUpgrade(new Request("https://local.example/streaming?i=x", { headers: { Upgrade: "websocket" } }), noBinding)).status, 503);
  });
});
