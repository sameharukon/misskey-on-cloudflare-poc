/**
 * admin/queue/* (except stats) on CF Queues (PGlite + the real OpsStats class): the consumer reports
 * failed / retried messages into the OpsStats job ring, which jobs / show-job / *-delayed read;
 * pause / resume, retry-job / promote-jobs (re-enqueue), remove-job / clear (cancel) act on it.
 */
import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { OpsStats } from "../../timeline/src/index.js";
import { recordOps } from "../../shared/src/ops.js";
import { makeFixture, type Fixture } from "./pglite-fixture.js";
import { handleApQueueBatch } from "./index.js";
import type { ApiEnv } from "./env.js";
import { setFederationPolicy } from "./ap/federation.js";
import { rpcStub } from "../../shared/src/testing/do-namespace.js";

/** Like pglite-fixture's fakeDoNamespace, with storage.delete (OpsStats evicts / removes job keys). */
function opsNamespace() {
  const m = new Map<string, unknown>();
  const storage = {
    get: async (k: string) => structuredClone(m.get(k)),
    put: async (k: string, v: unknown) => void m.set(k, structuredClone(v)),
    delete: async (k: string) => m.delete(k),
  };
  const inst = new OpsStats({ storage } as never);
  return {
    keys: () => [...m.keys()],
    idFromName: (n: string) => ({ toString: () => n }),
    get: () => rpcStub(inst),
  };
}

let f: Fixture;
let ops: ReturnType<typeof opsNamespace>;
let status = 503;
let fetched = 0;
const sent: { body: unknown; opts?: { delaySeconds?: number } }[] = [];

const hook = (extra: Record<string, unknown> = {}) => ({
  kind: "userWebhook", webhookId: "w1", userId: "u", to: "https://hooks.example/q", secret: "s3cret", type: "note", content: { n: 1 }, createdAt: 0, eventId: "e", maxAttempts: 4, ...extra,
});

async function consume(id: string, body: unknown, attempts = 1, queue = "mk-webhook-deliver") {
  const out = { acked: 0, retried: 0, delay: undefined as number | undefined };
  const r = await handleApQueueBatch(
    {
      queue,
      messages: [{ id, timestamp: new Date(1_700_000_000_000), body, attempts, ack: () => void out.acked++, retry: (o) => { out.retried++; out.delay = o?.delaySeconds; } }],
    },
    f.env,
  );
  return { ...out, results: r.results };
}

before(async () => {
  ops = opsNamespace();
  f = await makeFixture("QueueOpsTest", {
    OPS_STATS: ops as unknown as ApiEnv["OPS_STATS"],
    AP_FETCH: (async () => {
      fetched++;
      return new Response("", { status });
    }) as never,
  });
});

describe("admin/queue/* on CF Queues", () => {
  it("moderators only; params validated", async () => {
    for (const [ep, body] of [["admin/queue/queues", {}], ["admin/queue/jobs", { queue: "deliver", state: ["failed"] }], ["admin/queue/pause", { queue: "deliver" }], ["admin/queue/deliver-delayed", {}]] as const) {
      assert.equal((await f.call(ep, body, "b")).status, 403, ep);
    }
    assert.equal((await f.call("admin/queue/queue-stats", { queue: "nope" }, "a")).status, 400);
    assert.equal((await f.call("admin/queue/jobs", { queue: "deliver", state: ["bogus"] }, "a")).status, 400);
    assert.equal((await f.call("admin/queue/clear", { queue: "deliver", state: "x" }, "a")).status, 400);
    assert.equal((await f.call("admin/queue/show-job", { queue: "deliver" }, "a")).status, 400);
  });

  it("queues / queue-stats: every upstream type, empty", async () => {
    const r = await f.call("admin/queue/queues", {}, "a");
    assert.equal(r.status, 200);
    assert.deepEqual(r.data.map((q: { name: string }) => q.name), ["system", "endedPollNotification", "postScheduledNote", "deliver", "inbox", "db", "relationship", "objectStorage", "userWebhookDeliver", "systemWebhookDeliver"]);
    const d = r.data.find((q: { name: string }) => q.name === "deliver");
    assert.deepEqual(d.counts, { active: 0, completed: 0, delayed: 0, failed: 0, paused: 0, prioritized: 0, waiting: 0, "waiting-children": 0 });
    assert.equal(d.isPaused, false);
    assert.deepEqual(d.metrics.completed, { meta: { count: 0, prevTS: 0, prevCount: 0 }, data: [], count: 0 });
    const s = (await f.call("admin/queue/queue-stats", { queue: "inbox" }, "a")).data;
    assert.equal(s.name, "inbox");
    assert.equal(s.qualifiedName, "mk-inbox");
    assert.equal(s.db.mode, "standalone");
    assert.equal((await f.call("admin/queue/queue-stats", { queue: "system" }, "a")).data.qualifiedName, "none");
  });

  it("consumer records delayed / failed / recovered jobs", async () => {
    status = 503;
    const d = await consume("m-delayed", hook());
    assert.deepEqual([d.acked, d.retried], [0, 1]);
    status = 404;
    const x = await consume("m-failed", hook({ webhookId: "w2" }));
    assert.deepEqual([x.acked, x.retried], [1, 0]);
    status = 200;
    await consume("m-ok", hook());
    // a retried message that later succeeds leaves the ring
    status = 503;
    await consume("m-recover", hook());
    status = 200;
    await consume("m-recover", hook(), 2);

    const all = (await f.call("admin/queue/jobs", { queue: "userWebhookDeliver", state: ["active", "wait", "delayed", "completed", "failed"] }, "a")).data;
    assert.deepEqual(all.map((j: { id: string }) => j.id).sort(), ["m-delayed", "m-failed"]);
    const delayed = all.find((j: { id: string }) => j.id === "m-delayed");
    assert.equal(delayed.name, "userWebhook");
    assert.equal(delayed.data.secret, "(redacted)");
    assert.equal(delayed.timestamp, 1_700_000_000_000);
    assert.equal(delayed.attempts, 1);
    assert.equal(delayed.opts.attempts, 4);
    assert.ok(delayed.delay > 0);
    assert.equal(delayed.finishedOn, undefined);
    assert.equal(delayed.failedReason, "retry");
    const failed = all.find((j: { id: string }) => j.id === "m-failed");
    assert.equal(failed.failedReason, "dropped");
    assert.equal(typeof failed.finishedOn, "number");
    assert.equal(failed.isFailed, true);
    assert.deepEqual((await f.call("admin/queue/jobs", { queue: "userWebhookDeliver", state: ["failed"] }, "a")).data.map((j: { id: string }) => j.id), ["m-failed"]);
    assert.deepEqual((await f.call("admin/queue/jobs", { queue: "userWebhookDeliver", state: ["completed"] }, "a")).data, []);
    // search runs on the redacted pack
    assert.deepEqual((await f.call("admin/queue/jobs", { queue: "userWebhookDeliver", state: ["failed", "delayed"], search: "w2 dropped" }, "a")).data.map((j: { id: string }) => j.id), ["m-failed"]);
    assert.deepEqual((await f.call("admin/queue/jobs", { queue: "userWebhookDeliver", state: ["failed", "delayed"], search: "s3cret" }, "a")).data, []);

    const shown = await f.call("admin/queue/show-job", { queue: "userWebhookDeliver", jobId: "m-failed" }, "a");
    assert.equal(shown.data.id, "m-failed");
    assert.equal((await f.call("admin/queue/show-job", { queue: "userWebhookDeliver", jobId: "zzz" }, "a")).status, 500);
    const logs = (await f.call("admin/queue/show-job-logs", { queue: "userWebhookDeliver", jobId: "m-delayed" }, "a")).data;
    assert.equal(logs.length, 1);
    assert.match(logs[0], /attempt 1 failed, retrying/);
    assert.deepEqual((await f.call("admin/queue/show-job-logs", { queue: "userWebhookDeliver", jobId: "zzz" }, "a")).data, []);

    const q = (await f.call("admin/queue/queue-stats", { queue: "userWebhookDeliver" }, "a")).data;
    assert.equal(q.counts.completed, 2); // m-ok, m-recover (2nd attempt)
    assert.equal(q.counts.failed, 1);
    assert.equal(q.counts.delayed, 1); // currently in the ring
    assert.equal(q.metrics.completed.data[0], 2);
    assert.equal(q.metrics.failed.data[0], 1);
    // system webhooks are a separate upstream queue
    assert.equal((await f.call("admin/queue/queue-stats", { queue: "systemWebhookDeliver" }, "a")).data.counts.completed, 0);
  });

  it("past CF max_retries a retry is recorded as failed (acked)", async () => {
    status = 503;
    const r = await consume("m-max", hook({ maxAttempts: 10 }), 4);
    assert.deepEqual([r.acked, r.retried], [1, 0]);
    const j = (await f.call("admin/queue/show-job", { queue: "userWebhookDeliver", jobId: "m-max" }, "a")).data;
    assert.match(j.failedReason, /^max retries exceeded/);
    assert.equal(typeof j.finishedOn, "number");
  });

  it("deliver-delayed / inbox-delayed group delayed jobs by host", async () => {
    const o = ops as never;
    const ev = (id: string, type: "deliver" | "inbox", data: unknown) => ({ id, type, state: "delayed" as const, name: type, data, timestamp: 1, attempts: 1, delayMs: 30_000, reason: "retry" });
    await recordOps(o, {
      queue: "mk-deliver",
      jobs: [
        ev("d1", "deliver", { kind: "deliver", inbox: "https://a.example/inbox" }),
        ev("d2", "deliver", { kind: "deliver", inbox: "https://b.example/inbox" }),
        ev("d3", "deliver", { kind: "deliver", inbox: "https://b.example/users/x/inbox" }),
      ].map((e) => ({ ...e, host: new URL((e.data as { inbox: string }).inbox).host })),
    });
    assert.deepEqual((await f.call("admin/queue/deliver-delayed", {}, "a")).data, [["b.example", 2], ["a.example", 1]]);
    assert.deepEqual((await f.call("admin/queue/inbox-delayed", {}, "a")).data, []);
    // inbox: the consumer takes the host from the signature keyId (federation is off here → dropped = failed)
    setFederationPolicy(f.env, { mode: "none", hosts: [], blockedHosts: [] });
    const r = await consume("i1", { kind: "inbox", method: "POST", path: "/inbox", headers: { signature: 'keyId="https://c.example/users/1#main-key",headers="(request-target)"' }, body: "{}", receivedAt: 0 }, 1, "mk-inbox");
    assert.deepEqual(r.results, ["federation_none"]);
    const inbox = (await f.call("admin/queue/jobs", { queue: "inbox", state: ["failed"] }, "a")).data;
    assert.equal(inbox[0].id, "i1");
    assert.equal(inbox[0].failedReason, "federation_none");
  });

  it("pause / resume: the consumer puts messages of a paused type back", async () => {
    assert.equal((await f.call("admin/queue/pause", { queue: "userWebhookDeliver" }, "a")).status, 204);
    const qs = (await f.call("admin/queue/queues", {}, "a")).data;
    assert.equal(qs.find((q: { name: string }) => q.name === "userWebhookDeliver").isPaused, true);
    assert.equal(qs.find((q: { name: string }) => q.name === "systemWebhookDeliver").isPaused, false);
    fetched = 0;
    // without the producer binding: retry with a delay
    const r = await consume("p1", hook());
    assert.deepEqual([r.acked, r.retried, r.delay, r.results], [0, 1, 60, ["paused"]]);
    // with it: re-sent (attempts untouched) and acked
    f.env.Q_WEBHOOK_DELIVER = { send: async (body: unknown, opts?: { delaySeconds?: number }) => void sent.push({ body, opts }) } as never;
    const r2 = await consume("p2", hook());
    assert.deepEqual([r2.acked, r2.retried], [1, 0]);
    const back = sent.pop()!;
    assert.deepEqual(back, { body: { ...hook(), __pausedRounds: 1 }, opts: { delaySeconds: 60 } });
    // still paused when it comes back: the delay doubles, up to 5 min
    await consume("p2b", back.body);
    assert.deepEqual(sent.pop(), { body: { ...hook(), __pausedRounds: 2 }, opts: { delaySeconds: 120 } });
    await consume("p2c", { ...hook(), __pausedRounds: 9 });
    assert.equal(sent.pop()!.opts!.delaySeconds, 300);
    // other types keep running
    status = 200;
    await consume("p3", hook({ kind: "systemWebhook" }));
    assert.equal(fetched, 1);
    assert.equal((await f.call("admin/queue/resume", { queue: "userWebhookDeliver" }, "a")).status, 204);
    await consume("p4", hook());
    assert.equal(fetched, 2);
    // a message re-sent while paused runs as the original once resumed
    await consume("p5", { ...hook(), __pausedRounds: 3 });
    assert.equal(fetched, 3);
    const logs = await f.db.query(`SELECT type FROM moderation_log WHERE type IN ('pauseQueue', 'resumeQueue') ORDER BY id`);
    assert.deepEqual(logs.rows.map((x) => (x as { type: string }).type), ["pauseQueue", "resumeQueue"]);
  });

  it("retry-job re-enqueues a failed job; remove-job cancels a delayed one", async () => {
    sent.length = 0;
    assert.equal((await f.call("admin/queue/retry-job", { queue: "userWebhookDeliver", jobId: "m-failed" }, "a")).status, 204);
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0]!.body, hook({ webhookId: "w2" })); // original body, secret included
    assert.deepEqual((await f.call("admin/queue/jobs", { queue: "userWebhookDeliver", state: ["failed"] }, "a")).data.map((j: { id: string }) => j.id), ["m-max"]);
    // unknown ids are ignored like upstream
    assert.equal((await f.call("admin/queue/retry-job", { queue: "userWebhookDeliver", jobId: "zzz" }, "a")).status, 204);

    assert.equal((await f.call("admin/queue/remove-job", { queue: "userWebhookDeliver", jobId: "m-delayed" }, "a")).status, 204);
    assert.deepEqual((await f.call("admin/queue/jobs", { queue: "userWebhookDeliver", state: ["delayed"] }, "a")).data, []);
    assert.ok(!ops.keys().includes("job:userWebhookDeliver:m-delayed"));
    // when CF redelivers it, it is acked without running
    fetched = 0;
    const r = await consume("m-delayed", hook(), 2);
    assert.deepEqual([r.acked, r.results, fetched], [1, ["cancelled"], 0]);
  });

  it("promote-jobs runs delayed jobs now; clear empties the ring", async () => {
    status = 503;
    await consume("pr1", hook({ eventId: "pr1" }));
    await consume("pr2", hook({ eventId: "pr2" }));
    sent.length = 0;
    assert.equal((await f.call("admin/queue/promote-jobs", { queue: "userWebhookDeliver" }, "a")).status, 204);
    assert.deepEqual(sent.map((s) => (s.body as { eventId: string }).eventId).sort(), ["pr1", "pr2"]);
    assert.deepEqual(sent.map((s) => s.opts), [undefined, undefined]);
    assert.deepEqual((await f.call("admin/queue/jobs", { queue: "userWebhookDeliver", state: ["delayed"] }, "a")).data, []);
    assert.deepEqual((await consume("pr1", hook(), 2)).results, ["cancelled"]);

    assert.equal((await f.call("admin/queue/clear", { queue: "userWebhookDeliver", state: "failed" }, "a")).status, 204);
    const q = (await f.call("admin/queue/queue-stats", { queue: "userWebhookDeliver" }, "a")).data;
    assert.equal(q.counts.failed, 0);
    assert.ok(q.counts.completed > 0);
    assert.deepEqual((await f.call("admin/queue/jobs", { queue: "userWebhookDeliver", state: ["failed"] }, "a")).data, []);
    assert.equal((await f.call("admin/queue/clear", { queue: "deliver", state: "*" }, "a")).status, 204);
    assert.deepEqual((await f.call("admin/queue/deliver-delayed", {}, "a")).data, []);
    const logs = await f.db.query(`SELECT type FROM moderation_log WHERE type IN ('clearQueue', 'promoteQueue')`);
    assert.equal(logs.rows.length, 3);
  });

  it("cf-debug reset clears the ring too", async () => {
    await consume("z1", hook());
    const ns = ops;
    await ns.get().reset();
    assert.ok(!ops.keys().some((k) => k.startsWith("job:")));
    assert.deepEqual((await f.call("admin/queue/jobs", { queue: "userWebhookDeliver", state: ["delayed", "failed"] }, "a")).data, []);
  });
});
