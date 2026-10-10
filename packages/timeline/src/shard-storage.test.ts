import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { handleTimelineFanoutBatch, NotificationBox, TimelineShard, type TimelineEnv } from "./index.js";
import { fanoutRetryDelay, FANOUT_MAX_RETRIES } from "./fanout-retry.js";
import { StreamPresence } from "../../stream/src/presence.js";
import { testDoStorage } from "../../shared/src/test-do-storage.js";
import type { NotificationListQuery } from "../../shared/src/do-rpc.js";

const state = (storage = testDoStorage()) => ({ id: { toString: () => "t" }, storage });

describe("TimelineShard (SQLite)", () => {
  it("appends, pages newest first, trims to maxLen and deletes", async () => {
    const s = new TimelineShard(state());
    s.trimProbability = 1;
    for (const id of ["a1", "a3", "a2", "a4", "a3"]) await s.append(id, 3);
    assert.deepEqual(await s.list({ limit: 10 }), ["a4", "a3", "a2"]);
    assert.deepEqual(await s.list({ untilId: "a4", limit: 1 }), ["a3"]);
    assert.deepEqual(await s.list({ sinceId: "a2" }), ["a4", "a3"]);
    await s.remove("a3");
    assert.deepEqual(await s.list({}), ["a4", "a2"]);
    assert.deepEqual(await s.list({ untilId: "a4", sinceId: "a1" }), ["a2"]);
  });

  it("trims on only some appends (upstream FanoutTimelineService: 10 %)", async () => {
    const s = new TimelineShard(state());
    s.trimProbability = 0;
    for (const id of ["c1", "c2", "c3", "c4"]) await s.append(id, 2);
    assert.equal((await s.list({ limit: 10 })).length, 4);
    s.trimProbability = 1;
    await s.append("c5", 2);
    assert.deepEqual(await s.list({ limit: 10 }), ["c5", "c4"]);
  });

  it("moves the JSON list of older deployments into the table", async () => {
    const storage = testDoStorage();
    await storage.put("ids", ["b3", "b2", "b1"]);
    const s = new TimelineShard(state(storage));
    assert.deepEqual(await s.list({}), ["b3", "b2", "b1"]);
    assert.equal(storage.kv.has("ids"), false);
  });
});

describe("NotificationBox (SQLite)", () => {
  const item = (id: string, type = "follow") => ({ id, createdAt: "2026-01-01T00:00:00.000Z", type, notifierId: "u" });
  const list = async (b: NotificationBox, q: NotificationListQuery = {}) => (await b.list(q)).items;

  it("lists, filters, counts unread and marks read", async () => {
    const b = new NotificationBox(state());
    for (const [id, type] of [["n1", "follow"], ["n2", "reaction"], ["n3", "follow"]] as const) await b.push(item(id, type));
    assert.deepEqual((await list(b, { limit: 10 })).map((n) => n.id), ["n3", "n2", "n1"]);
    assert.deepEqual((await list(b, { types: ["follow"] })).map((n) => n.id), ["n3", "n1"]);
    assert.deepEqual((await list(b, { sinceId: "n1" })).map((n) => n.id), ["n2", "n3"], "sinceId only: oldest first");
    assert.equal(await b.unreadCount(), 3);
    assert.deepEqual(await b.markAllRead(), { latestReadId: "n3", hadUnread: true, hasAny: true });
    assert.ok((await list(b)).every((n) => n.isRead));
    await b.push(item("n4"));
    assert.deepEqual((await list(b, { unreadOnly: true })).map((n) => n.id), ["n4"]);
    await b.flush();
    assert.deepEqual(await list(b), []);
  });

  it("markAllRead writes the cursor only when it moves", async () => {
    const storage = testDoStorage();
    let cursorWrites = 0;
    const put = storage.put;
    storage.put = async (k: string, v: unknown) => { if (k === "latestReadId") cursorWrites++; await put(k, v); };
    const b = new NotificationBox(state(storage));
    const markAllRead = () => b.markAllRead();
    assert.deepEqual(await markAllRead(), { latestReadId: "", hadUnread: false, hasAny: false });
    assert.equal(cursorWrites, 0);
    await b.push(item("p1"));
    assert.deepEqual(await markAllRead(), { latestReadId: "p1", hadUnread: true, hasAny: true });
    assert.deepEqual(await markAllRead(), { latestReadId: "p1", hadUnread: false, hasAny: true });
    assert.equal(cursorWrites, 1);
  });

  it("push stores the item without counting, and trims on only some pushes", async () => {
    const b = new NotificationBox(state());
    b.trimProbability = 0;
    for (let i = 0; i < 501; i++) assert.equal(await b.push(item(`t${String(i).padStart(3, "0")}`)), undefined);
    assert.equal(await b.unreadCount(), 501);
    b.trimProbability = 1;
    await b.push(item("t501"));
    assert.equal(await b.unreadCount(), 500);
    await b.push(item("t502"));
    assert.equal(await b.unreadCount(), 500);
  });

  it("moves the JSON items of older deployments into the table", async () => {
    const storage = testDoStorage();
    await storage.put("items", [item("m2"), item("m1")]);
    const b = new NotificationBox(state(storage));
    assert.deepEqual((await list(b)).map((n) => n.id), ["m2", "m1"]);
    assert.equal(storage.kv.has("items"), false);
  });
});

describe("StreamPresence (per-user keys)", () => {
  it("writes one key per user and splits the legacy map, dropping stale entries", async () => {
    const storage = testDoStorage();
    await storage.put("users", { old: { channels: ["main"], at: Date.now() }, gone: { channels: ["main"], at: Date.now() - 2 * 24 * 3600_000 } });
    const p = new StreamPresence({ storage });
    await p.set("u1", ["main", "homeTimeline"]);
    assert.deepEqual([...storage.kv.keys()].sort(), ["u:old", "u:u1"]);
    assert.deepEqual(await p.subscribers(["homeTimeline"]), { u1: ["main", "homeTimeline"] });
    await p.set("u1", []);
    assert.deepEqual([...storage.kv.keys()], ["u:old"]);
    // a fresh instance (after eviction) reads the per-user keys back
    const again = new StreamPresence({ storage });
    assert.deepEqual(await again.all(), ["old"]);
  });
});

describe("mk-timeline-fanout retries", () => {
  it("retries with backoff, then drops past max_retries instead of losing the message silently", async () => {
    // the followers query fails (PG down); streaming itself is best-effort
    const env = {
      TIMELINE_SHARD: { idFromName: (n: string) => ({ toString: () => n }), get: () => ({}) },
      HYPERDRIVE: { connectionString: "postgres://test", __testClient: { query: async () => { throw new Error("pg down"); } } },
      STREAM_HUB: {},
      STREAM_PRESENCE: {},
    } as unknown as TimelineEnv;
    const log: string[] = [];
    const msg = (attempts: number) => ({
      body: { noteId: "n1", timelineKeys: ["local"], reason: "create", authorId: "a", visibility: "home", packed: { id: "n1" } },
      attempts,
      ack: () => void log.push(`ack:${attempts}`),
      retry: (o?: { delaySeconds?: number }) => void log.push(`retry:${attempts}:${o?.delaySeconds}`),
    });
    const error = console.error;
    console.error = () => {};
    try {
      await handleTimelineFanoutBatch({ messages: [msg(1), msg(3), msg(FANOUT_MAX_RETRIES + 1)] }, env);
    } finally {
      console.error = error;
    }
    assert.deepEqual(log, [`retry:1:${fanoutRetryDelay(1)}`, `retry:3:${fanoutRetryDelay(3)}`, `ack:${FANOUT_MAX_RETRIES + 1}`]);
    assert.deepEqual([fanoutRetryDelay(1), fanoutRetryDelay(3), fanoutRetryDelay(10)], [10, 40, 300]);
  });
});
