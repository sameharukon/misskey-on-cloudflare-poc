/**
 * admin/queue/stats (PGlite): moderators only; OpsStats counters (real class) mapped to
 * upstream's { deliver, inbox, db, objectStorage } job counts.
 */
import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { OpsStats } from "../../timeline/src/index.js";
import { recordOps } from "../../shared/src/ops.js";
import { fakeDoNamespace, makeFixture, type Fixture } from "./pglite-fixture.js";
import type { ApiEnv } from "./env.js";

let f: Fixture;
let ops: ReturnType<typeof fakeDoNamespace>;
before(async () => {
  ops = fakeDoNamespace((s) => new OpsStats(s as never));
  f = await makeFixture("QueueStatsTest", { OPS_STATS: ops as unknown as ApiEnv["OPS_STATS"] });
});

describe("admin/queue/stats", () => {
  it("moderators only; counts per upstream queue", async () => {
    assert.equal((await f.call("admin/queue/stats", {}, "b")).status, 403);
    const empty = { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 };
    assert.deepEqual((await f.call("admin/queue/stats", {}, "a")).data, { deliver: empty, inbox: empty, db: empty, objectStorage: empty });
    const o = ops as never;
    await recordOps(o, { queue: "mk-deliver", enqueued: 10 });
    await recordOps(o, { queue: "mk-deliver", acked: 6, retried: 2, dropped: 1 });
    await recordOps(o, { queue: "mk-jobs", enqueued: 3, acked: 3 });
    await recordOps(o, { queue: "mk-webhook-deliver", enqueued: 2, dropped: 1 });
    const r = (await f.call("admin/queue/stats", {}, "a")).data;
    assert.deepEqual(r.deliver, { waiting: 3, active: 0, completed: 6, failed: 1, delayed: 2 });
    assert.deepEqual(r.db, { waiting: 1, active: 0, completed: 3, failed: 1, delayed: 0 });
    assert.deepEqual(r.inbox, empty);
  });
});
