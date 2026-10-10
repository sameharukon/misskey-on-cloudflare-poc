/**
 * Pages on PG (PGlite): create / update / delete / show / featured / like / unlike, i/pages,
 * i/page-likes, users/pages, note pageCount bookkeeping, legacy `input` migration, moderator
 * deletion log, and users/show pinnedPage.
 */
import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { IMPLEMENTED_ENDPOINTS } from "./registry.js";
import { makeFixture, type Fixture } from "./pglite-fixture.js";
import { collectReferencedNotes } from "./pages-pg.js";
import { ENDPOINT_PARAM_DEFS } from "./endpoint-params.gen.js";

let f: Fixture;
before(async () => {
  f = await makeFixture("PagesTest");
});

const E = (r: { data: any }) => r.data?.error?.id;
const pageCount = async (id: string) => Number(((await f.db.query(`SELECT "pageCount" FROM note WHERE id = $1`, [id])).rows[0] as any).pageCount);
const base = { title: "Hello", name: "hello", content: [], variables: [], script: "" };

describe("pages", () => {
  let page = "";
  let n1 = "";
  let n2 = "";

  it("registers endpoints", () => {
    for (const e of ["pages/create", "pages/update", "pages/delete", "pages/show", "pages/featured", "pages/like", "pages/unlike", "i/pages", "i/page-likes", "users/pages"]) {
      assert.ok((IMPLEMENTED_ENDPOINTS as readonly string[]).includes(e), e);
      assert.ok(ENDPOINT_PARAM_DEFS[e], e);
    }
  });

  it("collectReferencedNotes recurses into sections", () => {
    assert.deepEqual(collectReferencedNotes([{ type: "note", note: "a" }, { type: "section", children: [{ type: "note", note: "b" }, { type: "note", note: "a" }] }, { type: "text" }]), ["a", "b"]);
  });

  it("create: validation, own eye-catching image, unique name, pageCount", async () => {
    n1 = await f.note(f.ids.c, { text: "quoted" });
    n2 = await f.note(f.ids.c, { text: "other" });
    await f.db.query(`INSERT INTO drive_file (id, "userId", type, name, url, md5, size, "storedInternal") VALUES ('imgb', $1, 'image/png', 'a.png', 'https://x/a', '0', 0, FALSE), ('imgc', $2, 'image/png', 'c.png', 'https://x/c', '0', 0, FALSE)`, [f.ids.b, f.ids.c]);
    assert.equal((await f.call("pages/create", { ...base, name: "has space" }, "b")).status, 400);
    assert.equal((await f.call("pages/create", { title: "x", name: "x" }, "b")).status, 400);
    assert.equal(E(await f.call("pages/create", { ...base, eyeCatchingImageId: "imgc" }, "b")), "b7b97489-0f66-4b12-a5ff-b21bd63f6e1c");
    const r = await f.call("pages/create", {
      ...base, summary: "s", eyeCatchingImageId: "imgb", font: "serif",
      content: [{ type: "note", note: n1 }, { type: "image", fileId: "imgb" }, { type: "image", fileId: "imgc" }, { type: "input", inputType: "number", default: "3" }],
    }, "b");
    assert.equal(r.status, 200, JSON.stringify(r.data));
    page = r.data.id;
    assert.equal(r.data.user.id, f.ids.b);
    assert.equal(r.data.eyeCatchingImage.id, "imgb");
    assert.deepEqual(r.data.attachedFiles.map((x: any) => x.id), ["imgb"]); // the owner's files only
    assert.equal(r.data.font, "serif");
    assert.equal(r.data.likedCount, 0);
    assert.ok(!("isLiked" in r.data));
    assert.deepEqual(r.data.content[3], { type: "numberInput", inputType: "number", default: 3 }); // legacy migration
    assert.equal(await pageCount(n1), 1);
    assert.equal(E(await f.call("pages/create", base, "b")), "4650348e-301c-499a-83c9-6aa988c66bc1");
    assert.equal((await f.call("pages/create", base, "c")).status, 200); // names are per user
  });

  it("show by id / by username+name; update; pageCount follows content", async () => {
    assert.equal((await f.call("pages/show", { pageId: page })).data.title, "Hello");
    assert.equal((await f.call("pages/show", { username: "USER_B", name: "hello" })).data.id, page);
    assert.equal(E(await f.call("pages/show", { pageId: "nope" })), "222120c0-3ead-4528-811b-b96f233388d7");
    assert.equal(E(await f.call("pages/update", { pageId: page, title: "x" }, "c")), "3c15cd52-3b4b-4274-967d-6456fc4f792b");
    assert.equal(E(await f.call("pages/update", { pageId: "nope", title: "x" }, "b")), "21149b9e-3616-4778-9592-c4ce89f5a864");
    assert.equal(E(await f.call("pages/update", { pageId: page, eyeCatchingImageId: "imgc" }, "b")), "cfc23c7c-3887-490e-af30-0ed576703c82");
    await f.call("pages/create", { ...base, name: "second" }, "b");
    assert.equal(E(await f.call("pages/update", { pageId: page, name: "second" }, "b")), "2298a392-d4a1-44c5-9ebb-ac1aeaa5a9ab");
    assert.ok((await f.call("pages/update", { pageId: page, title: "Renamed", eyeCatchingImageId: null, content: [{ type: "note", note: n2 }] }, "b")).status < 300);
    const s = (await f.call("pages/show", { pageId: page }, "c")).data;
    assert.deepEqual([s.title, s.summary, s.eyeCatchingImage, s.isLiked], ["Renamed", "s", null, false]);
    assert.deepEqual([await pageCount(n1), await pageCount(n2)], [0, 1]);
  });

  it("like / unlike / featured / i/page-likes", async () => {
    assert.equal(E(await f.call("pages/like", { pageId: page }, "b")), "28800466-e6db-40f2-8fae-bf9e82aa92b8");
    assert.ok((await f.call("pages/like", { pageId: page }, "c")).status < 300);
    assert.equal(E(await f.call("pages/like", { pageId: page }, "c")), "d4c1edbe-7da2-4eae-8714-1acfd2d63941");
    assert.equal((await f.call("pages/show", { pageId: page }, "c")).data.isLiked, true);
    assert.deepEqual((await f.call("pages/featured", {})).data.map((p: any) => [p.id, p.likedCount]), [[page, 1]]);
    const likes = (await f.call("i/page-likes", {}, "c")).data;
    assert.deepEqual(likes.map((l: any) => l.page.id), [page]);
    assert.equal(E(await f.call("pages/unlike", { pageId: page }, "a")), "f5e586b0-ce93-4050-b0e3-7f31af5259ee");
    assert.ok((await f.call("pages/unlike", { pageId: page }, "c")).status < 300);
    assert.deepEqual((await f.call("pages/featured", {})).data, []);
  });

  it("i/pages / users/pages pagination; pinnedPage in users/show", async () => {
    const mine = (await f.call("i/pages", {}, "b")).data.map((p: any) => p.name);
    assert.deepEqual(mine, ["second", "hello"]);
    assert.deepEqual((await f.call("i/pages", { limit: 1 }, "b")).data.length, 1);
    assert.equal((await f.call("i/pages", { limit: 0 }, "b")).status, 400);
    assert.deepEqual((await f.call("users/pages", { userId: f.ids.b, sinceId: page })).data.map((p: any) => p.name), ["second"]);
    await f.db.query(`UPDATE user_profile SET "pinnedPageId" = $1 WHERE "userId" = $2`, [page, f.ids.b]);
    const u = (await f.call("users/show", { userId: f.ids.b }, "c")).data;
    assert.equal(u.pinnedPageId, page);
    assert.equal(u.pinnedPage.id, page);
  });

  it("delete: owner, or a moderator (logged); pageCount released", async () => {
    assert.equal(E(await f.call("pages/delete", { pageId: page }, "c")), "8b741b3e-2c22-44b3-a15f-29949aa1601e");
    assert.ok((await f.call("pages/delete", { pageId: page }, "a")).status < 300); // root moderates
    assert.equal(await pageCount(n2), 0);
    assert.equal(E(await f.call("pages/delete", { pageId: page }, "b")), "eb0c6e1d-d519-4764-9486-52a7e1c6392a");
    const log = (await f.db.query(`SELECT info FROM moderation_log WHERE type = 'deletePage'`)).rows as any[];
    assert.equal(log.length, 1);
    assert.equal(log[0].info.pageId, page);
    assert.equal(log[0].info.pageUserUsername, "user_b");
  });
});
