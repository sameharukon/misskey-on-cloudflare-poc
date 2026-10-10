/**
 * Channels on PG (PGlite): CRUD + permissions, follow / favorite / mute, lists (owned,
 * followed, featured, search, my-favorites), posting into a channel through notes/create
 * (validation, forced public + localOnly, reply scope, renote-to-external, stats), the channel
 * timeline, and channel notes in home / local timelines.
 */
import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { IMPLEMENTED_ENDPOINTS } from "./registry.js";
import { makeFixture, type Fixture } from "./pglite-fixture.js";
import { getQueueProducer } from "./queues/fanout.js";
import { ENDPOINT_PARAM_DEFS } from "./endpoint-params.gen.js";

let f: Fixture;
before(async () => {
  f = await makeFixture("ChannelTest");
});

const E = (r: { data: any }) => r.data?.error?.id;

describe("channels", () => {
  let ch = "";
  let ch2 = "";

  it("registers endpoints", () => {
    for (const e of ["channels/create", "channels/show", "channels/update", "channels/follow", "channels/unfollow", "channels/favorite", "channels/unfavorite", "channels/followed", "channels/owned", "channels/featured", "channels/search", "channels/my-favorites", "channels/timeline", "channels/mute/create", "channels/mute/delete", "channels/mute/list"]) {
      assert.ok((IMPLEMENTED_ENDPOINTS as readonly string[]).includes(e), e);
      assert.ok(ENDPOINT_PARAM_DEFS[e], e);
    }
  });

  it("create / show / update (owner or moderator) / canCreateChannel", async () => {
    await f.db.query(`INSERT INTO drive_file (id, "userId", type, name, url, md5, size, "storedInternal") VALUES ('banner', $1, 'image/png', 'b.png', 'https://files/b.png', '0', 0, FALSE)`, [f.ids.a]);
    const r = await f.call("channels/create", { name: "Cats", description: "meow", bannerId: "banner" }, "a");
    assert.equal(r.status, 200, JSON.stringify(r.data));
    ch = r.data.id;
    assert.equal(r.data.color, "#86b300");
    assert.equal(r.data.bannerUrl, "https://files/b.png");
    assert.equal(r.data.userId, f.ids.a);
    assert.equal(r.data.isFollowing, false);
    assert.equal(r.data.allowRenoteToExternal, true);
    assert.equal(r.data.pinnedNotes, undefined);
    assert.equal(E(await f.call("channels/create", { name: "x", bannerId: "banner" }, "b")), "cd1e9f3e-5a12-4ab4-96f6-5d0a2cc32050");
    assert.equal((await f.call("channels/create", { name: "" }, "a")).status, 400);
    await f.setPolicy(f.ids.c, "canCreateChannel", false);
    assert.equal((await f.call("channels/create", { name: "nope" }, "c")).status, 403);
    ch2 = (await f.call("channels/create", { name: "Dogs", color: "#ff0000", allowRenoteToExternal: false }, "b")).data.id;
    const anon = await f.call("channels/show", { channelId: ch });
    assert.equal(anon.data.isFollowing, undefined);
    assert.deepEqual(anon.data.pinnedNotes, []);
    assert.equal(E(await f.call("channels/show", { channelId: "nope" })), "6f6c314b-7486-4897-8966-c04a66a02923");
    // b is neither owner nor moderator; a is root
    assert.equal(E(await f.call("channels/update", { channelId: ch, name: "x" }, "b")), "1fb7cb09-d46a-4fdf-b8df-057788cce513");
    const u = await f.call("channels/update", { channelId: ch2, description: "woof", isSensitive: true }, "a");
    assert.equal(u.data.description, "woof");
    assert.equal(u.data.isSensitive, true);
    assert.equal(u.data.name, "Dogs");
    // bannerId: null keeps the banner (upstream)
    assert.equal((await f.call("channels/update", { channelId: ch, bannerId: null }, "a")).data.bannerId, "banner");
  });

  it("follow / favorite / mute + packed flags and lists", async () => {
    assert.equal((await f.call("channels/follow", { channelId: ch }, "b")).status, 204);
    assert.equal(E(await f.call("channels/follow", { channelId: ch }, "b")), "7db31665-651e-40c1-8e6e-28e9ad829a2d");
    assert.equal(E(await f.call("channels/follow", { channelId: "nope" }, "b")), "c0031718-d573-4e85-928e-10039f1fbb68");
    assert.equal((await f.call("channels/favorite", { channelId: ch }, "b")).status, 204);
    // upstream: a second favorite violates the unique key → INTERNAL_ERROR
    assert.equal((await f.call("channels/favorite", { channelId: ch }, "b")).status, 500);
    const s = await f.call("channels/show", { channelId: ch }, "b");
    assert.equal(s.data.isFollowing, true);
    assert.equal(s.data.isFavorited, true);
    assert.equal(s.data.isMuting, false);
    assert.deepEqual((await f.call("channels/followed", {}, "b")).data.map((x: any) => x.id), [ch]);
    assert.deepEqual((await f.call("channels/my-favorites", {}, "b")).data.map((x: any) => x.id), [ch]);
    assert.deepEqual((await f.call("channels/owned", {}, "b")).data.map((x: any) => x.id), [ch2]);
    assert.deepEqual((await f.call("channels/search", { query: "meow" })).data.map((x: any) => x.id), [ch]);
    assert.deepEqual((await f.call("channels/search", { query: "meow", type: "nameOnly" })).data, []);
    assert.deepEqual((await f.call("channels/search", { query: "" })).data.map((x: any) => x.id), [ch2, ch]);
    assert.equal(E(await f.call("channels/mute/create", { channelId: ch2, expiresAt: Date.now() - 1000 }, "b")), "42b32236-df2c-a45f-fdbf-def67268f749");
    assert.equal((await f.call("channels/mute/create", { channelId: ch2 }, "c")).status, 204);
    assert.equal(E(await f.call("channels/mute/create", { channelId: ch2 }, "c")), "5a251978-769a-da44-3e89-3931e43bb592");
    assert.deepEqual((await f.call("channels/mute/list", {}, "c")).data.map((x: any) => [x.id, x.isMuting]), [[ch2, true]]);
    assert.equal(E(await f.call("channels/mute/delete", { channelId: ch }, "c")), "14d55962-6ea8-d990-1333-d6bef78dc2ab");
    assert.equal((await f.call("channels/unfavorite", { channelId: ch }, "b")).status, 204);
    assert.deepEqual((await f.call("channels/my-favorites", {}, "b")).data, []);
  });

  it("notes/create into a channel: validation, forced scope, stats, fanout to channel followers", async () => {
    const q = getQueueProducer(f.env);
    assert.equal(E(await f.call("notes/create", { text: "x", channelId: "nope" }, "a")), "b1653923-5453-4edc-b786-7c4f39bb0bbb");
    await f.db.query(`UPDATE channel SET "isArchived" = TRUE WHERE id = $1`, [ch2]);
    assert.equal(E(await f.call("notes/create", { text: "x", channelId: ch2 }, "a")), "b1653923-5453-4edc-b786-7c4f39bb0bbb");
    await f.db.query(`UPDATE channel SET "isArchived" = FALSE WHERE id = $1`, [ch2]);
    const r = await f.call("notes/create", { text: "in cats", channelId: ch, visibility: "followers" }, "a");
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const n = r.data.createdNote;
    assert.equal(n.channelId, ch);
    assert.equal(n.visibility, "public");
    assert.equal(n.localOnly, true);
    assert.deepEqual(n.channel, { id: ch, name: "Cats", color: "#86b300", isSensitive: false, allowRenoteToExternal: true, userId: f.ids.a });
    const row = (await f.db.query(`SELECT "notesCount", "usersCount", "lastNotedAt" FROM channel WHERE id = $1`, [ch])).rows[0] as any;
    assert.equal(row.notesCount, 1);
    assert.equal(row.usersCount, 1);
    assert.ok(row.lastNotedAt);
    await f.call("notes/create", { text: "again", channelId: ch }, "a");
    assert.equal(((await f.db.query(`SELECT "usersCount" FROM channel WHERE id = $1`, [ch])).rows[0] as any).usersCount, 1);
    // the fanout message carries channelId and no local/hybrid/global keys
    const sent = JSON.stringify(q);
    assert.ok(sent.includes(`"channelId":"${ch}"`), "fanout message has channelId");
    // a reply follows its parent into the channel
    const reply = (await f.call("notes/create", { text: "re", replyId: n.id }, "b")).data.createdNote;
    assert.equal(reply.channelId, ch);
    // a reply to a non-channel note from inside a channel leaves the channel
    const plain = (await f.call("notes/create", { text: "plain" }, "b")).data.createdNote;
    assert.equal((await f.call("notes/create", { text: "re", replyId: plain.id, channelId: ch }, "a")).data.createdNote.channelId, undefined);
    // renote out of a channel that forbids it
    const dog = (await f.call("notes/create", { text: "woof", channelId: ch2 }, "b")).data.createdNote;
    assert.equal(E(await f.call("notes/create", { renoteId: dog.id }, "a")), "33510210-8452-094c-6227-4a6c05d99f00");
    assert.equal((await f.call("notes/create", { renoteId: dog.id, channelId: ch2 }, "a")).status, 200);
    const rn = (await f.call("notes/create", { renoteId: n.id }, "c")).data.createdNote;
    assert.equal(((await f.db.query(`SELECT "renoteChannelId" FROM note WHERE id = $1`, [rn.id])).rows[0] as any).renoteChannelId, ch);
    assert.equal((await f.call("channels/featured", {})).data[0].id, ch2);
  });

  it("channels/timeline, home (followed channels) and local (no channel notes)", async () => {
    const tl = await f.call("channels/timeline", { channelId: ch });
    assert.equal(tl.status, 200);
    assert.ok(tl.data.length >= 3);
    assert.ok(tl.data.every((x: any) => x.channelId === ch));
    assert.equal(E(await f.call("channels/timeline", { channelId: "nope" })), "4d0eeeba-a02c-4c3c-9966-ef60d38d2e7f");
    const local = (await f.call("notes/local-timeline", { limit: 100 })).data;
    assert.ok(local.length > 0);
    assert.ok(local.every((x: any) => !x.channelId), "local timeline has no channel notes");
    // b follows ch (not user a): a's channel notes are in b's home; c follows nothing
    const home = (await f.call("notes/timeline", { limit: 100 }, "b")).data;
    assert.ok(home.some((x: any) => x.channelId === ch && x.userId === f.ids.a));
    const homeC = (await f.call("notes/timeline", { limit: 100 }, "c")).data;
    assert.ok(!homeC.some((x: any) => x.channelId === ch && x.userId !== f.ids.c));
    // c mutes ch2: a renote of a ch2 note posted into ch disappears from ch's timeline for c only
    await f.db.query(`UPDATE channel SET "allowRenoteToExternal" = TRUE WHERE id = $1`, [ch2]);
    const dog = (await f.call("notes/create", { text: "bark", channelId: ch2 }, "b")).data.createdNote;
    const cross = (await f.call("notes/create", { renoteId: dog.id, channelId: ch }, "a")).data.createdNote;
    const ids = async (who?: "b" | "c") => (await f.call("channels/timeline", { channelId: ch, limit: 100 }, who)).data.map((x: any) => x.id);
    assert.ok((await ids("b")).includes(cross.id));
    assert.ok(!(await ids("c")).includes(cross.id));
    await f.call("channels/unfollow", { channelId: ch }, "b");
    assert.deepEqual((await f.call("channels/followed", {}, "b")).data, []);
  });
});
