import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { StreamPresence, unionChannels } from "../../stream/src/presence.js";
import { planListTargets, planRecipients, streamFanout, type ListMembershipRow } from "./stream-fanout.js";
import { OpsStats } from "./ops-stats.js";
import { applyOpsEvent, estimateBacklog, recordOps, streamShardId } from "@misskey-cf/shared";
import { testDoStorage } from "../../shared/src/test-do-storage.js";
import { fakeNamespace } from "../../shared/src/testing/do-namespace.js";

function memStorage() {
  const m = new Map<string, unknown>();
  return {
    async get<T>(k: string) {
      return m.get(k) as T | undefined;
    },
    async put(k: string, v: unknown) {
      m.set(k, structuredClone(v));
    },
    async delete(k: string) {
      return m.delete(k);
    },
  };
}

/** Fake DO namespace: one instance per name, created lazily (RPC methods). */
const fakeNs = fakeNamespace;

/** The stub of shard `name`. */
const shardOf = <T extends object>(ns: ReturnType<typeof fakeNamespace<T>>, name: string) => ns.get(ns.idFromName(name));

describe("StreamPresence", () => {
  it("set / lookup / subscribers / remove", async () => {
    const ns = fakeNs(() => new StreamPresence({ storage: testDoStorage() }));
    const shard = shardOf(ns, "stream:0");
    await shard.set("a", ["homeTimeline", "main"]);
    await shard.set("b", ["globalTimeline"]);
    const look = await shard.lookup(["a", "b", "c"]);
    assert.deepEqual(Object.keys(look).sort(), ["a", "b"]);
    const subs = await shard.subscribers(["globalTimeline"]);
    assert.deepEqual(Object.keys(subs), ["b"]);
    await shard.set("a", []);
    await shard.remove(["b"]);
    const after = await shard.lookup(["a", "b"]);
    assert.deepEqual(after, {});
  });
  it("unionChannels dedups across sockets", () => {
    assert.deepEqual(unionChannels([{ x: "main" }, { y: "homeTimeline", z: "main" }]), ["homeTimeline", "main"]);
  });
});

describe("planRecipients", () => {
  const base = { noteId: "n1", authorId: "author", timelineKeys: ["local", "hybrid", "global"], visibility: "public" };
  it("followers get home (+hybrid), public subs get global/local; the author gets none (the API sends them)", () => {
    const r = planRecipients(
      base,
      true,
      { f1: ["homeTimeline", "main"], f2: ["hybridTimeline"], author: ["homeTimeline"], f3: ["main"] },
      { g1: ["globalTimeline"], l1: ["localTimeline"], author: ["globalTimeline"] },
      {},
    );
    assert.deepEqual([...r.get("f1")!], ["homeTimeline"]);
    assert.deepEqual([...r.get("f2")!], ["hybridTimeline"]);
    assert.equal(r.has("f3"), false);
    assert.deepEqual([...r.get("g1")!], ["globalTimeline"]);
    assert.deepEqual([...r.get("l1")!], ["localTimeline"]);
    assert.equal(r.has("author"), false);
  });
  it("followers-only note: no public channels; continuation pages skip public subs", () => {
    const fo = { ...base, visibility: "followers", timelineKeys: [] as string[] };
    const r = planRecipients(fo, true, { f1: ["homeTimeline"] }, { g1: ["globalTimeline"] }, {});
    assert.equal(r.has("g1"), false);
    const page2 = planRecipients(base, false, {}, { g1: ["globalTimeline"] }, {});
    assert.equal(page2.size, 0);
  });
});

describe("streamFanout", () => {
  const setup = () => {
    const published: Record<string, any[]> = {};
    const broadcasts: string[] = [];
    let onPublish: (name: string) => Promise<void> = async () => {};
    const hub = fakeNs((name) => ({
      async fetch() {
        return new Response(null);
      },
      async publish(events: any[]) {
        await onPublish(name);
        published[name] = events;
        const stale = name === "user:ghost";
        return { delivered: stale ? 0 : events.length, sockets: stale ? 0 : 1 };
      },
      async noteUpdated() {
        return 0;
      },
      async broadcast(type: string) {
        broadcasts.push(`${name} ${type}`);
        return 1;
      },
    }));
    let presenceCalls = 0;
    const presence = fakeNs(() => {
      const p = new StreamPresence({ storage: testDoStorage() }, { STREAM_HUB: hub });
      const deliver = p.deliverNote.bind(p);
      p.deliverNote = async (...a: Parameters<typeof deliver>) => (presenceCalls++, deliver(...a));
      return p;
    });
    const env = { STREAM_HUB: hub, STREAM_PRESENCE: presence, STREAM_SHARD_COUNT: "4" };
    const set = (u: string, ch: string[]) => shardOf(presence, streamShardId(u, 4)).set(u, ch);
    return { published, broadcasts, presence, env, set, calls: () => presenceCalls, onPublish: (f: (name: string) => Promise<void>) => void (onPublish = f) };
  };

  it("delivers through the presence shards (one call per shard), prunes stale presence", async () => {
    const { published, presence, env, set, calls } = setup();
    await set("f1", ["homeTimeline", "globalTimeline"]);
    await set("ghost", ["homeTimeline"]);
    await set("g1", ["globalTimeline"]);
    const res = await streamFanout(
      env,
      { noteId: "n1", authorId: "author", visibility: "public", timelineKeys: ["global"], packed: { id: "n1" } },
      ["f1", "ghost", "offline"],
      true,
    );
    assert.equal(res.recipients, 3);
    assert.equal(res.delivered, 3);
    assert.deepEqual(published["user:f1"]!.map((e) => e.channel).sort(), ["globalTimeline", "homeTimeline"]);
    assert.equal(published["user:f1"]![0].type, "note");
    assert.deepEqual(published["user:f1"]![0].body, { id: "n1" });
    assert.equal(published["user:offline"], undefined);
    assert.equal(calls(), new Set(["f1", "ghost", "g1"].map((u) => streamShardId(u, 4))).size);
    assert.equal(res.pruned, 1);
    const look = await shardOf(presence, streamShardId("ghost", 4)).lookup(["ghost"]);
    assert.deepEqual(look, {});
  });

  it("keeps a user who registered again while the delivery was running", async () => {
    const { env, set, presence, onPublish } = setup();
    await set("ghost", ["globalTimeline"]);
    // the old hub answers "no socket" while the user reconnects
    onPublish(async (name) => {
      if (name === "user:ghost") {
        await new Promise((r) => setTimeout(r, 5));
        await set("ghost", ["globalTimeline"]);
      }
    });
    const res = await streamFanout(env, { noteId: "n2", authorId: "author", visibility: "public", timelineKeys: ["global"], packed: { id: "n2" } }, [], true);
    assert.equal(res.pruned, 0);
    const look = await shardOf(presence, streamShardId("ghost", 4)).lookup(["ghost"]);
    assert.deepEqual(Object.keys(look), ["ghost"]);
  });

  it("presence broadcasts to its online users", async () => {
    const { presence, set, broadcasts } = setup();
    await set("b1", ["main"]);
    const shard = streamShardId("b1", 4);
    assert.equal(await presence.get(presence.idFromName(shard)).broadcast("emojiAdded", {}), 1);
    assert.deepEqual(broadcasts, ["user:b1 emojiAdded"]);
  });

  it("no packed note or bindings → no-op", async () => {
    const r = await streamFanout({}, { noteId: "n", timelineKeys: ["global"] }, ["a"], true);
    assert.equal(r.recipients, 0);
  });
});

describe("OpsStats", () => {
  it("counts and estimates backlog", async () => {
    const ns = fakeNs(() => new OpsStats({ storage: memStorage() }));
    await recordOps(ns, { queue: "q", enqueued: 3 });
    await recordOps(ns, { queue: "q", acked: 1, retried: 1, error: "boom" });
    const s = (await ns.get(ns.idFromName("ops:global")).stats()) as any;
    assert.equal(s.queues.q.enqueued, 3);
    assert.equal(s.queues.q.backlogEstimate, 2);
    assert.equal(s.recentErrors[0].error, "boom");
    assert.equal(estimateBacklog(applyOpsEvent(undefined, { queue: "x", acked: 5 }, new Date())), 0);
  });

  it("planListTargets: channel notes, visibility and withReplies (upstream UserListChannel)", () => {
    const m = (ownerId: string, o: Partial<ListMembershipRow> = {}): ListMembershipRow => ({
      listId: `L-${ownerId}`, ownerId, withReplies: false, followsAuthor: false, followsReplyUser: false, ...o,
    });
    const owners = (note: Parameters<typeof planListTargets>[0], rows: ListMembershipRow[]) => planListTargets(note, "author", rows).map((t) => t.ownerId);
    const rows = [m("o1"), m("o2", { followsAuthor: true }), m("author")];
    assert.deepEqual(owners({ visibility: "public" }, rows), ["o1", "o2", "author"]);
    assert.deepEqual(owners({ visibility: "public", channelId: "ch" }, rows), []);
    assert.deepEqual(owners({ visibility: "followers" }, rows), ["o2", "author"]);
    assert.deepEqual(owners({ visibility: "specified", visibleUserIds: ["o1"] }, rows), ["o1", "author"]);
    // reply to a third user: only lists with withReplies (or the author's own list)
    const reply = { visibility: "public", reply: { userId: "x", visibility: "public" } };
    assert.deepEqual(owners(reply, [m("o1"), m("o2", { withReplies: true }), m("author")]), ["o2", "author"]);
    // reply to the list owner, or self-reply, always passes
    assert.deepEqual(owners({ visibility: "public", reply: { userId: "o1" } }, [m("o1")]), ["o1"]);
    assert.deepEqual(owners({ visibility: "public", reply: { userId: "author" } }, [m("o1")]), ["o1"]);
    // withReplies to a followers-only note the owner cannot see
    const fr = { visibility: "public", reply: { userId: "x", visibility: "followers" } };
    assert.deepEqual(owners(fr, [m("o1", { withReplies: true }), m("o2", { withReplies: true, followsReplyUser: true })]), ["o2"]);
  });

  it("planRecipients: channel notes go to channel subscribers (author included) and online channel followers", () => {
    const input = { noteId: "n", authorId: "author", visibility: "public", timelineKeys: [], channelId: "C1" };
    const plan = planRecipients(
      input,
      true,
      { f1: ["homeTimeline"], author: ["homeTimeline"] },
      { s1: ["channel:C1"], s2: ["channel:C2"], author: ["channel:C1", "localTimeline"] },
      {},
    );
    assert.deepEqual(Object.fromEntries([...plan].map(([k, v]) => [k, [...v].sort()])), {
      s1: ["channel:C1"],
      author: ["channel:C1"],
      f1: ["homeTimeline"],
    });
  });

  it("planRecipients: public notes reach roleTimeline subscribers of the author's roles (first page only)", () => {
    const input = { noteId: "n", authorId: "author", visibility: "public", timelineKeys: ["local"], roleIds: ["R1"] };
    const subs = { s1: ["roleTimeline:R1"], s2: ["roleTimeline:R2"], author: ["roleTimeline:R1"] };
    const plan = planRecipients(input, true, {}, subs, {});
    assert.deepEqual(Object.fromEntries([...plan].map(([k, v]) => [k, [...v].sort()])), { s1: ["roleTimeline:R1"], author: ["roleTimeline:R1"] });
    assert.equal(planRecipients(input, false, {}, subs, {}).size, 0);
    assert.equal(planRecipients({ ...input, visibility: "home" }, true, {}, subs, {}).size, 0);
  });
});
