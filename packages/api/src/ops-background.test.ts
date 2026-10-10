/**
 * OpsStats off the critical path: recordOps inside runWithOpsBackground hands the DO call to
 * waitUntil instead of holding the caller and merges what is recorded while a write is in flight;
 * getQueueControl uses the last known control while refreshing it, and waits at most
 * CONTROL_WAIT_MS when there is none.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mergeOpsEvents, recordOps, runWithOpsBackground, type OpsEvent, type OpsNs } from "../../shared/src/ops.js";
import { CONTROL_TTL_MS, CONTROL_WAIT_MS, getQueueControl } from "./queues/ops-jobs.js";
import type { ApiEnv } from "./env.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** An OpsStats namespace whose calls take `delayMs`. */
function slowOps(delayMs: () => number, paused: string[] = []) {
  const recorded: OpsEvent[] = [];
  let controlFetches = 0;
  const ns = {
    idFromName: (n: string) => ({ toString: () => n }),
    get: () => ({
      record: async (ev: OpsEvent) => {
        await sleep(delayMs());
        recorded.push(ev);
      },
      queueControl: async () => {
        controlFetches++;
        await sleep(delayMs());
        return { paused, cancelled: [] };
      },
    }),
  };
  return { ns: ns as unknown as OpsNs, recorded, fetches: () => controlFetches };
}

describe("OpsStats off the critical path", () => {
  it("recordOps returns at once inside runWithOpsBackground and the write goes to waitUntil", async () => {
    const o = slowOps(() => 300);
    const pending: Promise<unknown>[] = [];
    const t0 = Date.now();
    await runWithOpsBackground((p) => pending.push(p), () => recordOps(o.ns, { queue: "mk-deliver", enqueued: 1 }));
    assert.ok(Date.now() - t0 < 100);
    assert.equal(pending.length, 1);
    assert.equal(o.recorded.length, 0);
    await Promise.all(pending);
    assert.deepEqual(o.recorded, [{ queue: "mk-deliver", enqueued: 1, error: undefined }]);
  });

  it("recordOps still awaits the write outside a scope (tests, Durable Objects)", async () => {
    const o = slowOps(() => 50);
    await recordOps(o.ns, { queue: "q", acked: 1 });
    assert.equal(o.recorded.length, 1);
  });

  it("events recorded while a write is in flight go out merged in one write per queue", async () => {
    const o = slowOps(() => 100);
    const pending: Promise<unknown>[] = [];
    await runWithOpsBackground((p) => pending.push(p), async () => {
      await recordOps(o.ns, { queue: "mk-deliver", enqueued: 1 });
      await sleep(10); // the first write is in flight
      for (let i = 0; i < 5; i++) await recordOps(o.ns, { queue: "mk-deliver", enqueued: 2 });
      await recordOps(o.ns, { queue: "mk-inbox", acked: 3, error: "x" });
    });
    await Promise.all(pending);
    assert.equal(o.recorded.length, 3);
    assert.deepEqual(o.recorded[0], { queue: "mk-deliver", enqueued: 1, error: undefined });
    assert.deepEqual(
      o.recorded.slice(1).sort((a, b) => a.queue.localeCompare(b.queue)),
      [
        { queue: "mk-deliver", enqueued: 10, error: undefined },
        { queue: "mk-inbox", acked: 3, error: "x" },
      ],
    );
  });

  it("mergeOpsEvents adds counts and per-type outcomes, keeps the last error and the jobs in order", () => {
    const job = (id: string) => ({ id, type: "deliver" as const, state: "failed" as const, name: "deliver", timestamp: 0, attempts: 1, maxAttempts: 9, reason: "", host: null });
    const m = mergeOpsEvents(
      { queue: "mk-deliver", acked: 1, retried: 1, error: "a", types: { deliver: { completed: 1, delayed: 1 } }, jobs: [job("1")] },
      { queue: "mk-deliver", acked: 2, dropped: 1, types: { deliver: { failed: 1 }, inbox: { completed: 2 } }, jobs: [job("2")] },
    );
    assert.deepEqual(m, {
      queue: "mk-deliver",
      acked: 3,
      retried: 1,
      dropped: 1,
      error: "a",
      types: { deliver: { completed: 1, delayed: 1, failed: 1 }, inbox: { completed: 2 } },
      jobs: [job("1"), job("2")],
    });
    assert.equal(mergeOpsEvents({ queue: "q", error: "a" }, { queue: "q", error: "b" }).error, "b");
  });

  it("getQueueControl serves the last control at once past the TTL and refreshes it in the background", async () => {
    let delay = 0;
    const paused = ["deliver"];
    const o = slowOps(() => delay, paused);
    const env = { OPS_STATS: o.ns } as unknown as ApiEnv;
    assert.deepEqual([...(await getQueueControl(env))!.paused], ["deliver"]);

    const realNow = Date.now;
    Date.now = () => realNow() + CONTROL_TTL_MS + 1;
    try {
      delay = CONTROL_WAIT_MS + 500;
      paused.splice(0, 1, "inbox");
      const pending: Promise<unknown>[] = [];
      const t0 = realNow();
      const control = await runWithOpsBackground((p) => pending.push(p), () => getQueueControl(env));
      assert.ok(realNow() - t0 < 100);
      assert.deepEqual([...control!.paused], ["deliver"]);
      assert.equal(pending.length, 1);
      assert.equal(o.fetches(), 2);
      await Promise.all(pending);
    } finally {
      Date.now = realNow;
    }
    // the refresh replaced the cached control
    assert.deepEqual([...(await getQueueControl(env))!.paused], ["inbox"]);
  });

  it("getQueueControl of an isolate without a control waits at most CONTROL_WAIT_MS", async () => {
    const o = slowOps(() => CONTROL_WAIT_MS + 500, ["deliver"]);
    const env = { OPS_STATS: o.ns } as unknown as ApiEnv;
    const pending: Promise<unknown>[] = [];
    const t0 = Date.now();
    const control = await runWithOpsBackground((p) => pending.push(p), () => getQueueControl(env));
    const waited = Date.now() - t0;
    assert.ok(waited >= CONTROL_WAIT_MS - 50 && waited < CONTROL_WAIT_MS + 400, `waited ${waited}ms`);
    assert.equal(control, null);
    // the late fetch keeps running in waitUntil and fills the cache
    assert.equal(pending.length, 1);
    await Promise.all(pending);
    assert.deepEqual([...(await getQueueControl(env))!.paused], ["deliver"]);
  });
});
