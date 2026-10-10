import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CfQueueProducer, chunkForSendBatch, MK_DELIVER } from "./queues/fanout.js";
import { enqueueDeliver } from "./ap/deliver.js";
import { setFederationPolicy } from "./ap/federation.js";
import type { ApiEnv } from "./env.js";

describe("Queues sendBatch", () => {
  it("chunks by 100 messages and by size", () => {
    assert.deepEqual(chunkForSendBatch(Array.from({ length: 250 }, (_, i) => i)).map((c) => c.length), [100, 100, 50]);
    const big = "x".repeat(90 * 1024);
    assert.deepEqual(chunkForSendBatch([big, big, big]).map((c) => c.length), [2, 1]);
  });

  it("delivers to every inbox with sendBatch and one OpsStats update", async () => {
    const batches: unknown[][] = [];
    const ops: unknown[] = [];
    const env = {
      Q_DELIVER: { send: async () => assert.fail("send"), sendBatch: async (m: { body: unknown }[]) => void batches.push(m.map((x) => x.body)) },
      OPS_STATS: {
        idFromName: (n: string) => ({ toString: () => n }),
        get: () => ({ record: async (ev: unknown) => void ops.push(structuredClone(ev)) }),
      },
    } as unknown as ApiEnv;
    setFederationPolicy(env, { mode: "all", hosts: [], blockedHosts: [] });
    const inboxes = Array.from({ length: 150 }, (_, i) => `https://r${i}.example/inbox`);
    const r = await enqueueDeliver(env, "u1", inboxes, { type: "Create" });
    assert.deepEqual(r, { refused: false, queued: 150 });
    assert.deepEqual(batches.map((b) => b.length), [100, 50]);
    assert.equal((batches[0]![0] as { inbox: string }).inbox, inboxes[0]);
    assert.equal(ops.length, 1);
    assert.equal((ops[0] as { enqueued: number }).enqueued, 150);
  });

  it("falls back to send when the binding has no sendBatch", async () => {
    const sent: unknown[] = [];
    const p = new CfQueueProducer({ Q_DELIVER: { send: async (b: unknown) => void sent.push(b) } } as unknown as ApiEnv);
    await p.sendBatch(MK_DELIVER, [1, 2, 3]);
    assert.deepEqual(sent, [1, 2, 3]);
  });
});
