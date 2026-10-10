/**
 * User lists on PG (PGlite): CRUD + limits, members (block, duplicates, pull, withReplies),
 * public lists (show forPublic, favorites, create-from-public, get-memberships) and
 * notes/user-list-timeline filtering.
 */
import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { IMPLEMENTED_ENDPOINTS } from "./registry.js";
import { makeFixture, type Fixture } from "./pglite-fixture.js";
import { ENDPOINT_PARAM_DEFS } from "./endpoint-params.gen.js";

let f: Fixture;
before(async () => {
  f = await makeFixture("ListTest");
});

const E = (r: { data: any }) => r.data?.error?.id;

describe("user lists", () => {
  let list = "";

  it("registers endpoints", () => {
    for (const e of ["users/lists/create", "users/lists/create-from-public", "users/lists/delete", "users/lists/list", "users/lists/show", "users/lists/update", "users/lists/push", "users/lists/pull", "users/lists/update-membership", "users/lists/get-memberships", "users/lists/favorite", "users/lists/unfavorite", "notes/user-list-timeline"]) {
      assert.ok((IMPLEMENTED_ENDPOINTS as readonly string[]).includes(e), e);
      assert.ok(ENDPOINT_PARAM_DEFS[e], e);
    }
  });

  it("create / update / show / list / limit", async () => {
    const r = await f.call("users/lists/create", { name: "friends" }, "a");
    assert.equal(r.status, 200, JSON.stringify(r.data));
    list = r.data.id;
    assert.deepEqual(Object.keys(r.data).sort(), ["createdAt", "id", "isPublic", "name", "userIds"]);
    assert.equal(r.data.isPublic, false);
    assert.deepEqual(r.data.userIds, []);
    assert.equal((await f.call("users/lists/create", { name: "" }, "a")).status, 400);
    assert.equal((await f.call("users/lists/create", { name: "x" })).status, 401);
    const u = await f.call("users/lists/update", { listId: list, name: "pals", isPublic: true }, "a");
    assert.equal(u.data.name, "pals");
    assert.equal(u.data.isPublic, true);
    assert.equal(E(await f.call("users/lists/update", { listId: list, name: "steal" }, "b")), "796666fe-3dff-4d39-becb-8a5932c1d5b7");
    // show: owner without forPublic; others only with a public list
    assert.equal((await f.call("users/lists/show", { listId: list }, "a")).data.name, "pals");
    assert.equal(E(await f.call("users/lists/show", { listId: list }, "b")), "7bc05c21-1d7a-41ae-88f1-66820f4dc686");
    const pub = await f.call("users/lists/show", { listId: list, forPublic: true });
    assert.equal(pub.data.likedCount, 0);
    assert.equal(pub.data.isLiked, false);
    assert.deepEqual((await f.call("users/lists/list", {}, "a")).data.map((l: any) => l.id), [list]);
    assert.deepEqual((await f.call("users/lists/list", { userId: f.ids.a })).data.map((l: any) => l.id), [list]);
    assert.equal(E(await f.call("users/lists/list", {})), "ab36de0e-29e9-48cb-9732-d82f1281620d");
    assert.equal(E(await f.call("users/lists/list", { userId: "nope" })), "a8af4a82-0980-4cc4-a6af-8b0ffd54465e");
    // userListLimit
    await f.setPolicy(f.ids.a, "userListLimit", 2);
    const second = await f.call("users/lists/create", { name: "two" }, "a");
    assert.equal(second.status, 200);
    assert.equal(E(await f.call("users/lists/create", { name: "three" }, "a")), "0cf21a28-7715-4f39-a20d-777bfdb8d138");
    assert.equal((await f.call("users/lists/delete", { listId: second.data.id }, "a")).status, 204);
    assert.equal(E(await f.call("users/lists/delete", { listId: list }, "b")), "78436795-db79-42f5-b1e2-55ea2cf19166");
  });

  it("push / pull / update-membership / get-memberships", async () => {
    assert.equal((await f.call("users/lists/push", { listId: list, userId: f.ids.b }, "a")).status, 204);
    assert.equal(E(await f.call("users/lists/push", { listId: list, userId: f.ids.b }, "a")), "1de7c884-1595-49e9-857e-61f12f4d4fc5");
    assert.equal(E(await f.call("users/lists/push", { listId: list, userId: "nope" }, "a")), "a89abd3d-f0bc-4cce-beb1-2f446f4f1e6a");
    assert.equal(E(await f.call("users/lists/push", { listId: list, userId: f.ids.c }, "b")), "2214501d-ac96-4049-b717-91e42272a711");
    await f.db.query(`INSERT INTO blocking (id, "blockerId", "blockeeId") VALUES ('blk', $1, $2)`, [f.ids.c, f.ids.a]);
    assert.equal(E(await f.call("users/lists/push", { listId: list, userId: f.ids.c }, "a")), "990232c5-3f9d-4d83-9f3f-ef27b6332a4b");
    await f.db.query(`DELETE FROM blocking`);
    assert.equal((await f.call("users/lists/push", { listId: list, userId: f.ids.c }, "a")).status, 204);
    assert.deepEqual((await f.call("users/lists/show", { listId: list }, "a")).data.userIds.sort(), [f.ids.b, f.ids.c].sort());
    // userEachUserListsLimit (owner's policy)
    await f.setPolicy(f.ids.a, "userEachUserListsLimit", 2);
    assert.equal(E(await f.call("users/lists/push", { listId: list, userId: f.ids.a }, "a")), "2dd9752e-a338-413d-8eec-41814430989b");
    assert.equal((await f.call("users/lists/update-membership", { listId: list, userId: f.ids.c, withReplies: true }, "a")).status, 204);
    const m = await f.call("users/lists/get-memberships", { listId: list }, "a");
    // ids minted in the same millisecond carry no order guarantee
    assert.deepEqual(m.data.map((x: any) => [x.userId, x.withReplies, x.user.username]).sort(), [[f.ids.b, false, "user_b"], [f.ids.c, true, "user_c"]].sort());
    assert.equal((await f.call("users/lists/get-memberships", { listId: list, forPublic: true })).data.length, 2);
    assert.equal((await f.call("users/lists/get-memberships", { listId: list, limit: 1 }, "a")).data.length, 1);
    assert.equal((await f.call("users/lists/pull", { listId: list, userId: f.ids.b }, "a")).status, 204);
    assert.equal(E(await f.call("users/lists/pull", { listId: list, userId: "nope" }, "a")), "588e7f72-c744-4a61-b180-d354e912bda2");
    assert.deepEqual((await f.call("users/lists/show", { listId: list }, "a")).data.userIds, [f.ids.c]);
    await f.call("users/lists/push", { listId: list, userId: f.ids.b }, "a");
  });

  it("favorite / unfavorite / create-from-public", async () => {
    assert.equal((await f.call("users/lists/favorite", { listId: list }, "b")).status, 204);
    assert.equal(E(await f.call("users/lists/favorite", { listId: list }, "b")), "6425bba0-985b-461e-af1b-518070e72081");
    const s = await f.call("users/lists/show", { listId: list, forPublic: true }, "b");
    assert.equal(s.data.likedCount, 1);
    assert.equal(s.data.isLiked, true);
    const copy = await f.call("users/lists/create-from-public", { listId: list, name: "copy" }, "b");
    assert.equal(copy.status, 200, JSON.stringify(copy.data));
    assert.deepEqual(copy.data.userIds.sort(), [f.ids.b, f.ids.c].sort());
    assert.equal(copy.data.isPublic, false);
    assert.equal(E(await f.call("users/lists/favorite", { listId: copy.data.id }, "a")), "7dbaf3cf-7b42-4b8f-b431-b3919e580dbe");
    assert.equal(E(await f.call("users/lists/create-from-public", { listId: copy.data.id, name: "x" }, "a")), "9292f798-6175-4f7d-93f4-b6742279667d");
    assert.equal((await f.call("users/lists/unfavorite", { listId: list }, "b")).status, 204);
    assert.equal(E(await f.call("users/lists/unfavorite", { listId: list }, "b")), "835c4b27-463d-4cfa-969b-a9058678d465");
    // private lists can't be favorited
    await f.call("users/lists/update", { listId: list, isPublic: false }, "a");
    assert.equal(E(await f.call("users/lists/favorite", { listId: list }, "b")), "7dbaf3cf-7b42-4b8f-b431-b3919e580dbe");
  });

  it("notes/user-list-timeline: members, replies (withReplies), visibility, renotes, files", async () => {
    // list (owner a) = { b (withReplies false), c (withReplies true) }
    const { a, b, c } = f.ids;
    const bPost = await f.note(b, { text: "b public" });
    const bHome = await f.note(b, { text: "b home", visibility: "home" });
    const bFollowers = await f.note(b, { text: "b followers", visibility: "followers" });
    const bReplyToC = await f.note(b, { text: "b → c", replyId: bPost, replyUserId: c });
    const bReplyToA = await f.note(b, { text: "b → a", replyId: bPost, replyUserId: a });
    const bSelfReply = await f.note(b, { text: "b → b", replyId: bPost, replyUserId: b });
    const cReplyToB = await f.note(c, { text: "c → b", replyId: bPost, replyUserId: b });
    const bRenote = await f.note(b, { renoteId: bPost, renoteUserId: b });
    const bFile = await f.note(b, { text: "file", fileIds: ["f1"] });
    const aPost = await f.note(a, { text: "a (not a member)" });
    await f.db.query(`INSERT INTO channel (id, name) VALUES ('ch1', 'ch1') ON CONFLICT DO NOTHING`);
    const bChannel = await f.note(b, { text: "channel", channelId: "ch1" });
    const tl = async (body: Record<string, unknown> = {}) =>
      (await f.call("notes/user-list-timeline", { listId: list, limit: 100, ...body }, "a")).data.map((n: any) => n.id);
    const all = await tl();
    assert.deepEqual(all, [bFile, bRenote, cReplyToB, bSelfReply, bReplyToA, bHome, bPost]);
    for (const hidden of [bFollowers, bReplyToC, aPost, bChannel]) assert.ok(!all.includes(hidden));
    await f.db.query(`INSERT INTO following (id, "followerId", "followeeId") VALUES ('f1', $1, $2)`, [a, b]);
    assert.ok((await tl()).includes(bFollowers));
    assert.ok(!(await tl({ withRenotes: false })).includes(bRenote));
    assert.deepEqual(await tl({ withFiles: true }), [bFile]);
    assert.deepEqual(await tl({ limit: 2 }), [bFile, bRenote]);
    await f.db.query(`INSERT INTO renote_muting (id, "muterId", "muteeId") VALUES ('rm', $1, $2)`, [a, b]);
    assert.ok(!(await tl()).includes(bRenote));
    await f.db.query(`INSERT INTO muting (id, "muterId", "muteeId") VALUES ('m', $1, $2)`, [a, c]);
    assert.ok(!(await tl()).includes(cReplyToB));
    assert.equal(E(await f.call("notes/user-list-timeline", { listId: list }, "b")), "8fb1fbd5-e476-4c37-9fb0-43d55b63a2ff");
    assert.equal((await f.call("notes/user-list-timeline", { listId: list })).status, 401);
  });

  it("delete removes memberships and favorites", async () => {
    await f.call("users/lists/update", { listId: list, isPublic: true }, "a");
    await f.call("users/lists/favorite", { listId: list }, "c");
    assert.equal((await f.call("users/lists/delete", { listId: list }, "a")).status, 204);
    const left = await f.db.query(`SELECT (SELECT count(*) FROM user_list_membership WHERE "userListId" = $1)::int AS m, (SELECT count(*) FROM user_list_favorite WHERE "userListId" = $1)::int AS f`, [list]);
    assert.deepEqual(left.rows[0], { m: 0, f: 0 });
  });
});
