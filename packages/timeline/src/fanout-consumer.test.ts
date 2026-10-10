/**
 * mk-timeline-fanout consumer: TimelineShard is written only for `antenna:` / `role:` (timelines
 * are read from PG); followers are fetched in one query and streamed page by page, later pages
 * queued as continuations (`followerIds`) before the first page streams; continuations only
 * stream; deletes do nothing.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyFanoutToShards, type TimelineEnv } from "./index.js";
import { resetAntennaCacheForTest } from "./antenna.js";

type Call = { kind: string; detail: unknown };

function setup(followers: string[], opts: { antennas?: Record<string, unknown>[] } = {}) {
  const calls: Call[] = [];
  const queries: string[] = [];
  const client = {
    async query(text: string) {
      queries.push(text);
      if (/^SELECT "followerId" FROM following/.test(text)) return { rows: followers.map((followerId) => ({ followerId })), rowCount: followers.length };
      if (/FROM antenna/.test(text)) return { rows: opts.antennas ?? [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    },
  };
  const ns = <T>(make: (name: string) => T) => ({ idFromName: (n: string) => ({ toString: () => n }), get: (id: { toString(): string }) => make(id.toString()) });
  const env = {
    TIMELINE_SHARD: ns((name) => ({ append: async (noteId: string) => void calls.push({ kind: "append", detail: `${name} ${noteId}` }) })),
    HYPERDRIVE: { connectionString: "postgres://test", __testClient: client },
    STREAM_SHARD_COUNT: "1",
    FANOUT_PAGE_SIZE: "10",
    STREAM_PRESENCE: ns(() => ({
      lookup: async (ids: string[]) => (calls.push({ kind: "lookup", detail: ids }), Object.fromEntries(ids.map((id) => [id, ["homeTimeline"]]))),
      subscribers: async (ch: string[]) => (calls.push({ kind: "subscribers", detail: ch }), {}),
      remove: async () => {},
    })),
    STREAM_HUB: ns((name) => ({ publish: async () => (calls.push({ kind: "push", detail: name }), { delivered: 1, sockets: 1 }) })),
    Q_TIMELINE_FANOUT: {
      send: async (m: unknown) => void calls.push({ kind: "send", detail: m }),
      sendBatch: async (ms: { body: unknown }[]) => void calls.push({ kind: "sendBatch", detail: ms.map((m) => m.body) }),
    },
  } as unknown as TimelineEnv;
  return { env, calls, queries };
}

const msg = (extra: Record<string, unknown> = {}) => ({
  noteId: "n1", timelineKeys: ["home:a", "local", "hybrid", "global"], reason: "create" as const,
  authorId: "a", visibility: "public", packed: { id: "n1", userId: "a" }, ...extra,
});

describe("timeline fanout consumer", () => {
  it("writes no timeline lists, fetches followers once and queues later pages before streaming", async () => {
    resetAntennaCacheForTest();
    const followers = Array.from({ length: 25 }, (_, i) => `f${String(i).padStart(2, "0")}`);
    const { env, calls, queries } = setup(followers);
    await applyFanoutToShards(env, msg());

    assert.deepEqual(calls.filter((c) => c.kind === "append"), []);
    assert.equal(queries.filter((q) => /FROM following/.test(q) && /followerId/.test(q) && !/EXISTS/.test(q)).length, 1);
    assert.ok(queries.every((q) => !/ORDER BY id DESC/.test(q)), "no keyset paging");

    const batchAt = calls.findIndex((c) => c.kind === "sendBatch");
    const firstLookup = calls.findIndex((c) => c.kind === "lookup");
    assert.ok(batchAt >= 0 && batchAt < firstLookup, "continuations are queued before streaming");
    const queued = calls[batchAt]!.detail as Record<string, unknown>[];
    assert.deepEqual(queued.map((m) => m.followerIds), [followers.slice(10, 20), followers.slice(20)]);
    assert.ok(queued.every((m) => m.continuation === true && m.followerCursor === undefined));
    assert.deepEqual(calls[firstLookup]!.detail, followers.slice(0, 10));
    // public channels are looked up on the first message
    assert.ok(calls.some((c) => c.kind === "subscribers"));
  });

  it("a continuation only streams its followers (no antennas, roles or public channels)", async () => {
    resetAntennaCacheForTest();
    const { env, calls, queries } = setup(["x"]);
    await applyFanoutToShards(env, msg({ followerIds: ["f10", "f11"], continuation: true }));
    assert.deepEqual(calls.filter((c) => c.kind === "lookup").map((c) => c.detail), [["f10", "f11"]]);
    assert.ok(!calls.some((c) => c.kind === "subscribers" || c.kind === "append" || c.kind === "sendBatch"));
    assert.ok(!queries.some((q) => /FROM antenna|FROM role|FROM following WHERE "followeeId" = \$1 AND "followerHost" IS NULL$/.test(q)));
  });

  it("matched antennas are the only timeline appends", async () => {
    resetAntennaCacheForTest();
    const antenna = { id: "ant1", userId: "o", src: "all", keywords: [["hello"]], excludeKeywords: [], users: [], caseSensitive: false, localOnly: false, excludeBots: false, withReplies: true, withFile: false, isActive: true, excludeNotesInSensitiveChannel: false };
    const { env, calls } = setup([], { antennas: [antenna] });
    await applyFanoutToShards(env, msg({ packed: { id: "n1", userId: "a", text: "hello", visibility: "public", user: { host: null, username: "a" } } }));
    assert.deepEqual(calls.filter((c) => c.kind === "append").map((c) => c.detail), ["tl:antenna:ant1 n1"]);
  });

  it("skips the follower query when nothing would be streamed, and does nothing for a delete", async () => {
    resetAntennaCacheForTest();
    const { env, calls, queries } = setup(["f1"]);
    await applyFanoutToShards(env, msg({ packed: undefined }));
    assert.ok(!queries.some((q) => /^SELECT "followerId" FROM following/.test(q)));
    await applyFanoutToShards(env, msg({ reason: "delete" }));
    assert.deepEqual(calls.filter((c) => c.kind !== "subscribers"), []);
  });

  it("still streams a continuation queued by the previous deployment (followerCursor)", async () => {
    resetAntennaCacheForTest();
    const { env, calls, queries } = setup([]);
    await applyFanoutToShards(env, msg({ followerCursor: "zzz" }));
    assert.ok(queries.some((q) => /AND id < \$2 ORDER BY id DESC/.test(q)));
    assert.ok(!calls.some((c) => c.kind === "subscribers" || c.kind === "append"));
  });
});
