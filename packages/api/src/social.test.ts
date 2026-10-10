/**
 * Following / follow requests / blocking / muting / notifications, users/followers|following|
 * relation|notes, the local and hybrid timelines and notes/unrenote on PG (PGlite + the real
 * NotificationBox).
 */
import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeFixture, type Fixture } from "./pglite-fixture.js";

let f: Fixture;
before(async () => {
  f = await makeFixture("SocialTest");
});

const ok = (r: { status: number; data: unknown }) => assert.ok(r.status < 300, JSON.stringify(r.data));
const rows = async (sql: string, params: unknown[] = []) => (await f.db.query(sql, params)).rows as Record<string, unknown>[];
const follows = async (a: string, b: string) => (await rows(`SELECT 1 FROM following WHERE "followerId" = $1 AND "followeeId" = $2`, [a, b])).length > 0;

describe("following + requests", () => {
  it("create/delete follow (with a follow notification); locked → request → accept / reject", async () => {
    const { a, b, c } = f.ids;
    await f.db.query(`UPDATE "user" SET "isLocked" = TRUE WHERE id = $1`, [c]);

    ok(await f.call("following/create", { userId: b }, "a"));
    assert.ok(await follows(a, b));
    const notifs = await f.call("i/notifications", { limit: 10 }, "b");
    assert.deepEqual((notifs.data as { type: string; userId: string }[]).map((n) => [n.type, n.userId]), [["follow", a]]);

    ok(await f.call("following/create", { userId: c }, "a"));
    assert.ok(!(await follows(a, c)));
    const list = await f.call("following/requests/list", {}, "c");
    assert.deepEqual((list.data as { follower: { id: string } }[]).map((x) => x.follower.id), [a]);
    const sent = await f.call("following/requests/sent", {}, "a");
    assert.deepEqual((sent.data as { followee: { id: string } }[]).map((x) => x.followee.id), [c]);

    ok(await f.call("following/requests/accept", { userId: a }, "c"));
    assert.ok(await follows(a, c));

    // b asks c and is turned down
    ok(await f.call("following/create", { userId: c }, "b"));
    ok(await f.call("following/requests/reject", { userId: b }, "c"));
    assert.equal((await rows(`SELECT 1 FROM follow_request WHERE "followerId" = $1`, [b])).length, 0);
    assert.ok(!(await follows(b, c)));

    ok(await f.call("following/delete", { userId: b }, "a"));
    assert.ok(!(await follows(a, b)));
    await f.db.query(`DELETE FROM following`);
    await f.db.query(`UPDATE "user" SET "isLocked" = FALSE, "followersCount" = 0, "followingCount" = 0`);
  });
});

describe("blocking + mute", () => {
  it("create/list/delete", async () => {
    const { b } = f.ids;
    ok(await f.call("blocking/create", { userId: b }, "a"));
    assert.deepEqual(((await f.call("blocking/list", {}, "a")).data as { blockeeId: string }[]).map((x) => x.blockeeId), [b]);
    ok(await f.call("blocking/delete", { userId: b }, "a"));
    assert.deepEqual((await f.call("blocking/list", {}, "a")).data, []);

    ok(await f.call("mute/create", { userId: b }, "a"));
    assert.deepEqual(((await f.call("mute/list", {}, "a")).data as { muteeId: string }[]).map((x) => x.muteeId), [b]);
    ok(await f.call("mute/delete", { userId: b }, "a"));
    assert.deepEqual((await f.call("mute/list", {}, "a")).data, []);
  });
});

describe("notifications", () => {
  it("a reaction notification, then mark-all-as-read", async () => {
    const n = await f.note(f.ids.a, { text: "react to me" });
    ok(await f.call("notes/reactions/create", { noteId: n, reaction: "✨" }, "b"));
    const list = await f.call("i/notifications", { limit: 10, markAsRead: false }, "a");
    assert.ok((list.data as { type: string; note?: { id: string } }[]).some((x) => x.type === "reaction" && x.note?.id === n));
    assert.equal((await f.call("i", {}, "a")).data.hasUnreadNotification, true);

    ok(await f.call("notifications/mark-all-as-read", {}, "a"));
    assert.equal((await f.call("i", {}, "a")).data.hasUnreadNotification, false);
  });
});

describe("users/show", () => {
  it("by username (local) and by userId", async () => {
    const byName = await f.call("users/show", { username: "user_b" }, "a");
    assert.equal(byName.data.id, f.ids.b);
    const byId = await f.call("users/show", { userId: f.ids.c });
    assert.equal(byId.data.username, "user_c");
    assert.equal((await f.call("users/show", { username: "nobody" })).status, 404); // upstream httpStatusCode 404
  });
});

describe("users followers/following/relation", () => {
  it("lists the edges and the relation flags", async () => {
    const { a, b } = f.ids;
    ok(await f.call("following/create", { userId: b }, "a"));

    const followers = await f.call("users/followers", { userId: b }, "c");
    assert.deepEqual((followers.data as { followerId: string }[]).map((x) => x.followerId), [a]);
    const following = await f.call("users/following", { userId: a }, "c");
    assert.deepEqual((following.data as { followeeId: string }[]).map((x) => x.followeeId), [b]);
    const mine = await f.call("following/list", {}, "a");
    assert.ok((mine.data as { followeeId: string }[]).some((x) => x.followeeId === b));
    // upstream: a one-element array for a single userId
    const [rel] = (await f.call("users/relation", { userId: b }, "a")).data as { following: { followeeId: string } | null; isFollowed: boolean }[];
    assert.equal(rel!.following?.followeeId, b);
    assert.equal(rel!.isFollowed, false);
    ok(await f.call("following/delete", { userId: b }, "a"));
  });
});

describe("local + hybrid timeline, users/notes, unrenote", () => {
  it("public local notes; a renote and its unrenote", async () => {
    const target = await f.note(f.ids.b, { text: "local public" });
    const local = await f.call("notes/local-timeline", { limit: 10 }, "c");
    assert.ok((local.data as { id: string }[]).some((x) => x.id === target));
    ok(await f.call("notes/hybrid-timeline", { limit: 5 }, "c"));
    assert.equal((await f.call("notes/hybrid-timeline", { limit: 5 })).status, 401);
    const byUser = await f.call("users/notes", { userId: f.ids.b, limit: 10 }, "c");
    assert.ok((byUser.data as { id: string }[]).some((x) => x.id === target));

    const created = await f.call("notes/create", { renoteId: target }, "c");
    ok(created);
    const renoteId = created.data.createdNote.id as string;
    assert.equal((await rows(`SELECT "renoteCount" FROM note WHERE id = $1`, [target]))[0]!.renoteCount, 1);

    const un = await f.call("notes/unrenote", { noteId: target }, "c");
    assert.deepEqual([un.status, un.data], [200, null]); // void (the router answers 204)
    assert.equal((await rows(`SELECT 1 FROM note WHERE id = $1`, [renoteId])).length, 0);
    // upstream NoteDeleteService leaves renoteCount as it is
  });
});
