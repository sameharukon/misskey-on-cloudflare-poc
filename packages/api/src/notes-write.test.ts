/**
 * Timeline fanout: the in-process consumer and the messages notes/create / notes/delete enqueue
 * on PG (PGlite).
 */
import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  InMemoryQueueProducer,
  MK_TIMELINE_FANOUT,
  consumeTimelineFanout,
  getQueueProducer,
  setQueueProducer,
  type TimelineFanoutMessage,
} from "./queues/fanout.js";
import { makeFixture, type Fixture } from "./pglite-fixture.js";

let f: Fixture;
let q: InMemoryQueueProducer;
before(async () => {
  f = await makeFixture("WriteTest");
  q = new InMemoryQueueProducer();
  setQueueProducer(f.env, q);
});

describe("consumeTimelineFanout", () => {
  it("appends and trims; delete removes", () => {
    const shards = new Map<string, string[]>();
    consumeTimelineFanout(shards, {
      noteId: "n1",
      timelineKeys: ["home:u1", "local"],
      reason: "create",
    }, { maxLen: 2 });
    consumeTimelineFanout(shards, {
      noteId: "n2",
      timelineKeys: ["home:u1"],
      reason: "create",
    }, { maxLen: 2 });
    consumeTimelineFanout(shards, {
      noteId: "n3",
      timelineKeys: ["home:u1"],
      reason: "create",
    }, { maxLen: 2 });
    assert.deepEqual(shards.get("home:u1"), ["n3", "n2"]);
    assert.deepEqual(shards.get("local"), ["n1"]);
    consumeTimelineFanout(shards, {
      noteId: "n2",
      timelineKeys: ["home:u1"],
      reason: "delete",
    });
    assert.deepEqual(shards.get("home:u1"), ["n3"]);
  });
});

describe("notes/create + delete", () => {
  it("401 without credential", async () => {
    assert.equal((await f.call("notes/create", { text: "hi" })).status, 401);
  });

  it("creates note, enqueues fanout, appears in timeline", async () => {
    q.clear();
    const res = await f.call("notes/create", { text: "hello w4" }, "a");
    assert.equal(res.status, 200, JSON.stringify(res.data));
    const created = res.data.createdNote as { id: string; text: string; userId: string };
    assert.equal(created.text, "hello w4");
    assert.equal(created.userId, f.ids.a);

    const fanouts = q.ofQueue<TimelineFanoutMessage>(MK_TIMELINE_FANOUT);
    assert.equal(fanouts.length, 1);
    assert.equal(fanouts[0]!.noteId, created.id);
    assert.equal(fanouts[0]!.reason, "create");
    assert.ok(fanouts[0]!.timelineKeys.includes(`home:${f.ids.a}`));
    assert.ok(fanouts[0]!.timelineKeys.includes("local"));

    // consumer simulation
    const shards = new Map<string, string[]>();
    consumeTimelineFanout(shards, fanouts[0]!);
    assert.ok(shards.get(`home:${f.ids.a}`)?.includes(created.id));

    const tl = await f.call("notes/timeline", { limit: 5 }, "a");
    assert.equal((tl.data as { text: string }[])[0]!.text, "hello w4");
  });

  it("delete: only the author (or a moderator); no timeline fanout (timelines are read from PG)", async () => {
    const id = (await f.call("notes/create", { text: "bye" }, "b")).data.createdNote.id as string;
    q.clear();
    assert.equal((await f.call("notes/delete", { noteId: id })).status, 401);
    const denied = await f.call("notes/delete", { noteId: id }, "c");
    assert.equal(denied.status, 400);
    assert.equal(denied.data.error.id, "fe8d7103-0ea8-4ec3-814d-f8b401dc69e9");

    const del = await f.call("notes/delete", { noteId: id }, "b");
    assert.deepEqual([del.status, del.data], [200, null]); // void (the router answers 204)
    assert.equal((await f.call("notes/show", { noteId: id })).status, 400);

    assert.deepEqual(q.ofQueue<TimelineFanoutMessage>(MK_TIMELINE_FANOUT), []);
  });

  it("delete missing → 400 NO_SUCH_NOTE", async () => {
    const res = await f.call("notes/delete", { noteId: "nopeeeeeeeeeeee1" }, "a");
    assert.equal(res.status, 400);
    assert.equal(res.data.error.id, "490be23f-8c1f-4796-819f-94cb4f9d1630");
  });

  it("default producer without queue bindings is InMemoryQueueProducer", () => {
    assert.ok(getQueueProducer({}) instanceof InMemoryQueueProducer);
  });
});
