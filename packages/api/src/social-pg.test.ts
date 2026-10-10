import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ApiEnv } from "./env.js";
import { fixtureMeta } from "../../packers/src/fixtures.js";
import { makeFixture, type Fixture } from "./pglite-fixture.js";
import { canViewNote } from "./visibility.js";
import { buildFanoutMessage, InMemoryQueueProducer, MK_TIMELINE_FANOUT, setQueueProducer } from "./queues/fanout.js";
import type { TimelineFanoutMessage } from "./queues/fanout.js";
import {
  applyFanoutToShards,
  followerFanoutAllowed,
} from "../../timeline/src/index.js";

function env(): ApiEnv {
  return {
    INSTANCE_URL: "https://misskey.example.com",
    VERSION: "0.0.0-test",
    BOOTSTRAP_META_JSON: JSON.stringify(fixtureMeta({ name: "Social" })),
  };
}

let f: Fixture;
before(async () => {
  f = await makeFixture("SocialPg");
});

const baseNote = {
  id: "n1",
  userId: "author",
  text: "x",
  cw: null,
  localOnly: false,
  reactionAcceptance: null,
  renoteCount: 0,
  repliesCount: 0,
  reactions: {},
  fileIds: [],
  replyId: null,
  renoteId: null,
  channelId: null,
  mentions: [],
  hasPoll: false,
  uri: null,
  url: null,
  tags: [],
  emojis: [],
  userHost: null,
};

describe("visibility without PG", () => {
  it("public/home visible to anyone; specified only to listed; followers needs PG", async () => {
    const e = env();
    assert.equal(
      await canViewNote(e, { ...baseNote, visibility: "public", visibleUserIds: [] }, null),
      true,
    );
    assert.equal(
      await canViewNote(e, { ...baseNote, visibility: "home", visibleUserIds: [] }, null),
      true,
    );
    assert.equal(
      await canViewNote(e, { ...baseNote, visibility: "specified", visibleUserIds: ["u2"] }, "u2"),
      true,
    );
    assert.equal(
      await canViewNote(e, { ...baseNote, visibility: "specified", visibleUserIds: ["u2"] }, "u3"),
      false,
    );
    assert.equal(
      await canViewNote(e, { ...baseNote, visibility: "followers", visibleUserIds: [] }, "author"),
      true,
    );
    assert.equal(
      await canViewNote(e, { ...baseNote, visibility: "followers", visibleUserIds: [] }, "other"),
      false,
    );
  });
});

describe("fanout message carries author + visibility", () => {
  it("notes/create enqueues authorId", async () => {
    const q = new InMemoryQueueProducer();
    setQueueProducer(f.env, q);
    const res = await f.call("notes/create", { text: "fan", visibility: "followers" }, "a");
    assert.equal(res.status, 200);
    const msgs = q.ofQueue<TimelineFanoutMessage>(MK_TIMELINE_FANOUT);
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0]!.authorId, f.ids.a);
    assert.equal(msgs[0]!.visibility, "followers");
  });

  it("followerFanoutAllowed excludes specified", () => {
    assert.equal(followerFanoutAllowed("public"), true);
    assert.equal(followerFanoutAllowed("followers"), true);
    assert.equal(followerFanoutAllowed("specified"), false);
  });
});

describe("timeline fanout consumer (no Hyperdrive)", () => {
  it("writes nothing for home / local / hybrid / global, nor for a delete", async () => {
    const writes: { key: string; body: unknown }[] = [];
    const ns = {
      idFromName(name: string) {
        return { toString: () => name };
      },
      get(id: { toString(): string }) {
        return {
          fetch: async () => new Response(null),
          list: async () => [],
          append: async (noteId: string, maxLen?: number) => void writes.push({ key: id.toString(), body: { op: "append", noteId, maxLen } }),
          remove: async (noteId: string) => void writes.push({ key: id.toString(), body: { op: "delete", noteId } }),
        };
      },
    };
    await applyFanoutToShards(
      { TIMELINE_SHARD: ns },
      buildFanoutMessage("n9", ["home:a", "local"], "create", {
        authorId: "a",
        visibility: "specified",
        visibleUserIds: ["b"],
      }),
    );
    await applyFanoutToShards({ TIMELINE_SHARD: ns }, buildFanoutMessage("n9", ["home:a", "local", "hybrid", "global"], "create", { authorId: "a", visibility: "public" }));
    await applyFanoutToShards({ TIMELINE_SHARD: ns }, buildFanoutMessage("n9", ["home:a", "local", "hybrid", "global"], "delete", { authorId: "a", visibility: "public" }));
    assert.deepEqual(writes, []);
  });
});

describe("notes/reactions list", () => {
  it("lists reactions after react", async () => {
    const noteId = await f.note(f.ids.b, { text: "react" });
    const r = await f.call("notes/reactions/create", { noteId, reaction: "👍" }, "a");
    assert.ok(r.status < 300, JSON.stringify(r.data));
    const list = await f.call("notes/reactions", { noteId });
    assert.equal(list.status, 200);
    const j = list.data as { type: string; user: { id: string } }[];
    assert.deepEqual(j.map((x) => [x.type, x.user.id]), [["👍", f.ids.a]]);
  });
});
