/**
 * Fast path of mk-inbox / mk-deliver (ap/fast-path.ts): handled at once in waitUntil with a delayed
 * copy queued as a backup; the consumer skips the copy when the immediate run left its KV mark.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import worker, { handleApQueueBatch } from "./index.js";
import type { ApiEnv } from "./env.js";
import { fixtureMeta } from "../../packers/src/fixtures.js";
import { exportPkcs8Pem, exportSpkiPem, generateRsaKeyPair } from "../../ap/src/index.js";
import { setFederationPolicy } from "./ap/federation.js";
import { setUserKeypairForTest } from "./ap/keys.js";
import { enqueueDeliver, type DeliverMessage } from "./ap/deliver.js";
import { FAST_DELIVER_MAX, FAST_PATH_BACKUP_DELAY_S } from "./ap/fast-path.js";
import type { InboxMessage } from "./ap/inbox.js";
import { InMemoryQueueProducer, MK_DELIVER, MK_INBOX, setQueueProducer } from "./queues/fanout.js";
import { runWithOpsBackground } from "../../shared/src/ops.js";
import { signedInboxHeaders } from "./test-inbox.js";

function memoryKv() {
  const m = new Map<string, string>();
  return {
    map: m,
    async get(k: string) {
      return m.get(k) ?? null;
    },
    async put(k: string, v: string) {
      m.set(k, v);
    },
  };
}

async function fastEnv() {
  const kv = memoryKv();
  const e: ApiEnv = {
    INSTANCE_URL: "https://local.example",
    VERSION: "0.0.0-test",
    BOOTSTRAP_META_JSON: JSON.stringify(fixtureMeta({ name: "AP" })),
    META_CACHE: kv,
  };
  setFederationPolicy(e, { mode: "all", hosts: [], blockedHosts: [] });
  const kp = await generateRsaKeyPair();
  setUserKeypairForTest(e, "u1", { publicKey: await exportSpkiPem(kp.publicKey), privateKey: await exportPkcs8Pem(kp.privateKey) });
  const q = new InMemoryQueueProducer();
  setQueueProducer(e, q);
  const posts: string[] = [];
  let status = 202;
  e.AP_FETCH = (async (url: string) => {
    posts.push(url);
    return new Response(null, { status });
  }) as unknown as typeof fetch;
  return { e, kv, q, posts, setStatus: (s: number) => (status = s) };
}

const batchMsg = (body: unknown) => ({ body, ack() {}, retry() {} });

describe("fast path", () => {
  it("delivers at once, queues a delayed backup, and the consumer skips the backup", async () => {
    const { e, kv, q, posts } = await fastEnv();
    const pending: Promise<unknown>[] = [];
    await runWithOpsBackground((p) => pending.push(p), () => enqueueDeliver(e, "u1", ["https://r.example/inbox"], { type: "Follow" }));
    const [queued] = q.messages;
    assert.equal(queued!.queue, MK_DELIVER);
    assert.equal(queued!.delaySeconds, FAST_PATH_BACKUP_DELAY_S);
    const body = queued!.body as DeliverMessage;
    assert.equal(typeof body.fast, "string");
    await Promise.all(pending);
    assert.deepEqual(posts, ["https://r.example/inbox"]);
    assert.equal(kv.map.size, 1);
    const out = await handleApQueueBatch({ queue: "mk-deliver", messages: [batchMsg(body)] }, e);
    assert.deepEqual(out.results, ["fast_done"]);
    assert.equal(posts.length, 1);
  });

  it("a delivery to retry leaves no mark: the backup is delivered by the consumer", async () => {
    const { e, kv, q, posts, setStatus } = await fastEnv();
    setStatus(503);
    const pending: Promise<unknown>[] = [];
    await runWithOpsBackground((p) => pending.push(p), () => enqueueDeliver(e, "u1", ["https://r.example/inbox"], { type: "Follow" }));
    await Promise.all(pending);
    assert.equal(kv.map.size, 0);
    setStatus(202);
    const out = await handleApQueueBatch({ queue: "mk-deliver", messages: [batchMsg(q.messages[0]!.body)] }, e);
    assert.deepEqual(out.results, ["delivered"]);
    assert.equal(posts.length, 2);
  });

  it("many inboxes, no KV or no waitUntil scope: queue only", async () => {
    const { e, q, posts } = await fastEnv();
    const pending: Promise<unknown>[] = [];
    const many = Array.from({ length: FAST_DELIVER_MAX + 1 }, (_, i) => `https://r${i}.example/inbox`);
    await runWithOpsBackground((p) => pending.push(p), () => enqueueDeliver(e, "u1", many, { type: "Create" }));
    await enqueueDeliver(e, "u1", ["https://r.example/inbox"], { type: "Follow" });
    delete e.META_CACHE;
    await runWithOpsBackground((p) => pending.push(p), () => enqueueDeliver(e, "u1", ["https://r.example/inbox"], { type: "Follow" }));
    await Promise.all(pending);
    assert.equal(posts.length, 0);
    assert.ok(q.messages.every((m) => m.delaySeconds === undefined && (m.body as DeliverMessage).fast === undefined));
  });

  it("an inbox POST is processed at once and its delayed copy is skipped", async () => {
    const { e, kv, q } = await fastEnv();
    const pending: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException() {} };
    const post = async (path: string, activity: unknown) => {
      const body = JSON.stringify(activity);
      return worker.fetch(
        new Request(`https://local.example${path}`, { method: "POST", headers: await signedInboxHeaders(`https://local.example${path}`, body), body }),
        e,
        ctx as never,
      );
    };
    // no actor: rejected before the signer is looked up
    const res = await post("/users/u1/inbox", { id: "https://r.example/f/1", type: "Follow", object: "https://local.example/users/u1" });
    assert.equal(res.status, 202);
    const [queued] = q.ofQueue<InboxMessage>(MK_INBOX);
    assert.equal(q.messages[0]!.delaySeconds, FAST_PATH_BACKUP_DELAY_S);
    assert.equal(typeof queued!.fast, "string");
    await Promise.all(pending);
    // rejected is final: marked, the copy is skipped
    assert.equal(kv.map.size, 1);
    const out = await handleApQueueBatch({ queue: "mk-inbox", messages: [batchMsg(queued)] }, e);
    assert.deepEqual(out.results, ["fast_done"]);

    // posts arriving at the shared inbox stay on the queue
    q.clear();
    await post("/inbox", { id: "https://r.example/n/1", type: "Create", actor: "https://r.example/users/x", object: {} });
    assert.equal(q.messages[0]!.delaySeconds, undefined);
    assert.equal((q.messages[0]!.body as InboxMessage).fast, undefined);
  });
});
