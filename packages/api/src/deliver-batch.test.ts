/**
 * mk-deliver batches: deliveries to different inboxes run in parallel (a slow server does not hold
 * the others), deliveries to one inbox keep their order, and every POST carries the 5 s limit.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { handleApQueueBatch } from "./index.js";
import { DELIVER_CONCURRENCY } from "./ap/deliver.js";
import type { ApiEnv } from "./env.js";
import { fixtureMeta } from "../../packers/src/fixtures.js";
import { exportPkcs8Pem, exportSpkiPem, generateRsaKeyPair } from "../../ap/src/index.js";
import { setFederationPolicy } from "./ap/federation.js";
import { setUserKeypairForTest } from "./ap/keys.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function deliverEnv(): Promise<ApiEnv> {
  const e: ApiEnv = {
    INSTANCE_URL: "https://local.example",
    VERSION: "0.0.0-test",
    BOOTSTRAP_META_JSON: JSON.stringify(fixtureMeta({ name: "AP" })),
  };
  setFederationPolicy(e, { mode: "all", hosts: [], blockedHosts: [] });
  const kp = await generateRsaKeyPair();
  setUserKeypairForTest(e, "u1", { publicKey: await exportSpkiPem(kp.publicKey), privateKey: await exportPkcs8Pem(kp.privateKey) });
  return e;
}

const message = (inbox: string, n: number) => {
  const m = {
    body: { kind: "deliver", signerId: "u1", inbox, activity: { type: "Create", id: `https://local.example/a/${n}` } },
    acked: false,
    ack() {
      m.acked = true;
    },
    retry() {},
  };
  return m;
};

describe("mk-deliver batch", () => {
  it("runs different inboxes in parallel and one inbox in order", async () => {
    const e = await deliverEnv();
    const log: string[] = [];
    let running = 0;
    let maxRunning = 0;
    e.AP_FETCH = (async (url: string, init: RequestInit) => {
      const id = (JSON.parse(String(init.body)) as { id: string }).id.split("/").pop();
      running++;
      maxRunning = Math.max(maxRunning, running);
      log.push(`start ${id}`);
      await sleep(url.includes("slow") ? 200 : 20);
      log.push(`end ${id}`);
      running--;
      return new Response(null, { status: 202 });
    }) as unknown as typeof fetch;
    const msgs = [
      message("https://slow.example/inbox", 1),
      message("https://slow.example/inbox", 2),
      ...Array.from({ length: 8 }, (_, i) => message(`https://r${i}.example/inbox`, 3 + i)),
    ];
    const t0 = Date.now();
    const out = await handleApQueueBatch({ queue: "mk-deliver", messages: msgs }, e);
    const took = Date.now() - t0;
    assert.deepEqual(out.results, msgs.map(() => "delivered"));
    assert.ok(msgs.every((m) => m.acked));
    // one inbox: the second starts after the first ended
    assert.ok(log.indexOf("start 2") > log.indexOf("end 1"));
    // the others did not wait for the slow server
    assert.ok(log.indexOf("end 3") < log.indexOf("end 1"));
    assert.equal(maxRunning, DELIVER_CONCURRENCY);
    assert.ok(took < 600, `took ${took}ms`);
  });

  it("passes a time limit to the POST", async () => {
    const e = await deliverEnv();
    let signal: AbortSignal | null | undefined;
    e.AP_FETCH = (async (_url: string, init: RequestInit) => {
      signal = init.signal;
      return new Response("ok", { status: 202 });
    }) as unknown as typeof fetch;
    const out = await handleApQueueBatch({ queue: "mk-deliver", messages: [message("https://r.example/inbox", 1)] }, e);
    assert.deepEqual(out.results, ["delivered"]);
    assert.ok(signal instanceof AbortSignal);
    assert.equal(signal.aborted, false);
  });

  it("a POST that fails on the time limit is retried", async () => {
    const e = await deliverEnv();
    e.AP_FETCH = (async () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    }) as unknown as typeof fetch;
    const out = await handleApQueueBatch({ queue: "mk-deliver", messages: [message("https://r.example/inbox", 1)] }, e);
    assert.deepEqual(out.results, ["retry"]);
  });
});
