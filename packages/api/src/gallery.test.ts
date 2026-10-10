/**
 * Gallery on PG (PGlite): create / update / delete / show / like / unlike, posts listings,
 * popular, featured ranking from gallery_like, moderator deletion log.
 */
import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { IMPLEMENTED_ENDPOINTS } from "./registry.js";
import { makeFixture, type Fixture } from "./pglite-fixture.js";
import { ENDPOINT_PARAM_DEFS } from "./endpoint-params.gen.js";

let f: Fixture;
before(async () => {
  f = await makeFixture("GalleryTest");
  await f.db.query(
    `INSERT INTO drive_file (id, "userId", type, name, url, md5, size, "storedInternal") VALUES ('g1', $1, 'image/png', '1.png', 'https://x/1', '0', 0, FALSE), ('g2', $1, 'image/png', '2.png', 'https://x/2', '0', 0, FALSE), ('gc', $2, 'image/png', 'c.png', 'https://x/c', '0', 0, FALSE)`,
    [f.ids.b, f.ids.c],
  );
});

const E = (r: { data: any }) => r.data?.error?.id;

describe("gallery", () => {
  let post = "";

  it("registers endpoints", () => {
    for (const e of ["gallery/posts", "gallery/featured", "gallery/popular", "gallery/posts/create", "gallery/posts/update", "gallery/posts/delete", "gallery/posts/show", "gallery/posts/like", "gallery/posts/unlike", "i/gallery/posts", "i/gallery/likes", "users/gallery/posts"]) {
      assert.ok((IMPLEMENTED_ENDPOINTS as readonly string[]).includes(e), e);
      assert.ok(ENDPOINT_PARAM_DEFS[e], e);
    }
  });

  it("create: own files only (order kept), validation", async () => {
    assert.equal((await f.call("gallery/posts/create", { title: "", fileIds: ["g1"] }, "b")).status, 400);
    assert.equal((await f.call("gallery/posts/create", { title: "x", fileIds: [] }, "b")).status, 400);
    assert.equal((await f.call("gallery/posts/create", { title: "x", fileIds: ["g1", "g1"] }, "b")).status, 400);
    assert.equal((await f.call("gallery/posts/create", { title: "x", fileIds: ["gc"] }, "b")).status, 500); // no own file
    const r = await f.call("gallery/posts/create", { title: "Cats", description: "d", fileIds: ["g2", "gc", "g1"], isSensitive: true }, "b");
    assert.equal(r.status, 200, JSON.stringify(r.data));
    post = r.data.id;
    assert.deepEqual(r.data.fileIds, ["g2", "g1"]);
    assert.deepEqual(r.data.files.map((x: any) => x.id), ["g2", "g1"]);
    assert.deepEqual([r.data.user.id, r.data.isSensitive, r.data.likedCount, r.data.isLiked], [f.ids.b, true, 0, false]);
    assert.ok(!("tags" in r.data));
  });

  it("update (owner scoped), show", async () => {
    const u = await f.call("gallery/posts/update", { postId: post, title: "Dogs", fileIds: ["g1"] }, "b");
    assert.deepEqual([u.data.title, u.data.fileIds, u.data.isSensitive, u.data.description], ["Dogs", ["g1"], false, "d"]);
    await f.call("gallery/posts/update", { postId: post, title: "Hacked" }, "c"); // not the owner: no change
    assert.equal((await f.call("gallery/posts/show", { postId: post })).data.title, "Dogs");
    assert.equal(E(await f.call("gallery/posts/show", { postId: "nope" })), "1137bf14-c5b0-4604-85bb-5b5371b1cd45");
  });

  it("like / unlike / popular / featured / i/gallery/likes", async () => {
    assert.equal(E(await f.call("gallery/posts/like", { postId: post }, "b")), "f78f1511-5ebc-4478-a888-1198d752da68");
    assert.ok((await f.call("gallery/posts/like", { postId: post }, "c")).status < 300);
    assert.equal(E(await f.call("gallery/posts/like", { postId: post }, "c")), "40e9ed56-a59c-473a-bf3f-f289c54fb5a7");
    assert.ok((await f.call("gallery/posts/like", { postId: post }, "a")).status < 300);
    assert.equal((await f.call("gallery/posts/show", { postId: post }, "c")).data.isLiked, true);
    assert.deepEqual((await f.call("gallery/popular", {})).data.map((p: any) => [p.id, p.likedCount]), [[post, 2]]);
    assert.deepEqual((await f.call("gallery/featured", {})).data.map((p: any) => p.id), [post]);
    assert.deepEqual((await f.call("gallery/featured", { untilId: post })).data, []);
    assert.deepEqual((await f.call("i/gallery/likes", {}, "c")).data.map((l: any) => l.post.id), [post]);
    assert.equal(E(await f.call("gallery/posts/unlike", { postId: post }, "b")), "e3e8e06e-be37-41f7-a5b4-87a8250288f0");
    assert.ok((await f.call("gallery/posts/unlike", { postId: post }, "c")).status < 300);
    assert.equal((await f.call("gallery/posts/show", { postId: post })).data.likedCount, 1);
  });

  it("listings", async () => {
    const second = (await f.call("gallery/posts/create", { title: "Second", fileIds: ["gc"] }, "c")).data.id;
    assert.deepEqual((await f.call("gallery/posts", {})).data.map((p: any) => p.id), [second, post]);
    assert.deepEqual((await f.call("gallery/posts", { sinceId: post })).data.map((p: any) => p.id), [second]);
    assert.deepEqual((await f.call("i/gallery/posts", {}, "b")).data.map((p: any) => p.id), [post]);
    assert.deepEqual((await f.call("users/gallery/posts", { userId: f.ids.c })).data.map((p: any) => p.id), [second]);
    assert.equal((await f.call("users/gallery/posts", {})).status, 400);
  });

  it("delete: owner or moderator (logged)", async () => {
    assert.equal(E(await f.call("gallery/posts/delete", { postId: post }, "c")), "c86e09de-1c48-43ac-a435-1c7e42ed4496");
    assert.ok((await f.call("gallery/posts/delete", { postId: post }, "a")).status < 300);
    assert.equal(E(await f.call("gallery/posts/delete", { postId: post }, "b")), "ae52f367-4bd7-4ecd-afc6-5672fff427f5");
    const log = (await f.db.query(`SELECT info FROM moderation_log WHERE type = 'deleteGalleryPost'`)).rows as any[];
    assert.deepEqual([log.length, log[0].info.postId, log[0].info.postUserUsername], [1, post, "user_b"]);
    assert.equal(Number(((await f.db.query(`SELECT count(*)::int AS n FROM gallery_like WHERE "postId" = $1`, [post])).rows[0] as any).n), 0);
  });
});
