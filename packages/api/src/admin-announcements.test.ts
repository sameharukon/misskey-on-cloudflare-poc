/**
 * admin/announcements/* on PG (PGlite): moderator gate, validation, create (global / per user),
 * update (incl. the upstream imageUrl quirk), list (status, userId, reads), delete, and
 * moderation_log entries; the public `announcements` endpoint sees the result.
 */
import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { IMPLEMENTED_ENDPOINTS } from "./registry.js";
import { makeFixture, type Fixture } from "./pglite-fixture.js";
import { ENDPOINT_PARAM_DEFS } from "./endpoint-params.gen.js";

let f: Fixture;
before(async () => {
  f = await makeFixture("AnnouncementAdminTest");
});

const E = (r: { data: any }) => r.data?.error?.id;

describe("admin/announcements", () => {
  let g = "";
  let u = "";

  it("registers endpoints and gates on moderators", async () => {
    for (const e of ["admin/announcements/create", "admin/announcements/update", "admin/announcements/delete", "admin/announcements/list"]) {
      assert.ok((IMPLEMENTED_ENDPOINTS as readonly string[]).includes(e), e);
      assert.ok(ENDPOINT_PARAM_DEFS[e], e);
    }
    assert.equal((await f.call("admin/announcements/list", {}, "b")).status, 403);
    assert.equal((await f.call("admin/announcements/list", {})).status, 401);
  });

  it("create: validation, global + per user, pack shape", async () => {
    assert.equal((await f.call("admin/announcements/create", { title: "t", text: "x" }, "a")).status, 400); // imageUrl required
    assert.equal((await f.call("admin/announcements/create", { title: "", text: "x", imageUrl: null }, "a")).status, 400);
    assert.equal((await f.call("admin/announcements/create", { title: "t", text: "x", imageUrl: null, icon: "bogus" }, "a")).status, 400);
    const r = await f.call("admin/announcements/create", { title: "Hello", text: "world", imageUrl: "", display: "banner" }, "a");
    assert.equal(r.status, 200, JSON.stringify(r.data));
    g = r.data.id;
    assert.equal(r.data.imageUrl, null); // "" → null
    assert.equal(r.data.icon, "info");
    assert.equal(r.data.display, "banner");
    assert.equal(r.data.forYou, false);
    assert.equal(r.data.updatedAt, null);
    u = (await f.call("admin/announcements/create", { title: "Just b", text: "hi", imageUrl: null, userId: f.ids.b }, "a")).data.id;
    // the public endpoint: b sees both, c only the global one
    assert.deepEqual((await f.call("announcements", {}, "b")).data.map((x: any) => x.id).sort(), [g, u].sort());
    assert.deepEqual((await f.call("announcements", {}, "c")).data.map((x: any) => x.id), [g]);
  });

  it("list: status / userId filters and read counts", async () => {
    await f.call("i/read-announcement", { announcementId: g }, "b");
    const l = await f.call("admin/announcements/list", {}, "a");
    assert.deepEqual(l.data.map((x: any) => [x.id, x.reads, x.isActive]), [[g, 1, true]]);
    assert.deepEqual((await f.call("admin/announcements/list", { userId: f.ids.b }, "a")).data.map((x: any) => x.id), [u]);
    assert.deepEqual((await f.call("admin/announcements/list", { status: "archived" }, "a")).data, []);
  });

  it("update: fields, isActive, imageUrl cleared when omitted (upstream)", async () => {
    await f.call("admin/announcements/update", { id: g, imageUrl: "https://img" }, "a");
    assert.equal((await f.call("admin/announcements/list", {}, "a")).data[0].imageUrl, "https://img");
    assert.equal((await f.call("admin/announcements/update", { id: g, title: "Hello!", isActive: false }, "a")).status, 204);
    const l = (await f.call("admin/announcements/list", { status: "archived" }, "a")).data;
    assert.equal(l[0].title, "Hello!");
    assert.equal(l[0].imageUrl, null);
    assert.ok(l[0].updatedAt);
    assert.equal(E(await f.call("admin/announcements/update", { id: "nope" }, "a")), "d3aae5a7-6372-4cb4-b61c-f511ffc2d7cc");
    assert.equal((await f.call("admin/announcements/update", { id: g, text: "" }, "a")).status, 400);
  });

  it("delete + moderation log", async () => {
    assert.equal(E(await f.call("admin/announcements/delete", { id: "nope" }, "a")), "ecad8040-a276-4e85-bda9-015a708d291e");
    assert.equal((await f.call("admin/announcements/delete", { id: u }, "a")).status, 204);
    assert.equal((await f.call("admin/announcements/delete", { id: g }, "a")).status, 204);
    // ids minted in the same millisecond carry no order guarantee
    const logs = (await f.db.query(`SELECT type, info FROM moderation_log WHERE "userId" = $1`, [f.ids.a])).rows as any[];
    assert.deepEqual(logs.map((x) => x.type).sort(), [
      "createGlobalAnnouncement", "createUserAnnouncement", "deleteGlobalAnnouncement", "deleteUserAnnouncement", "updateGlobalAnnouncement", "updateGlobalAnnouncement",
    ]);
    assert.equal(logs.find((x) => x.type === "createUserAnnouncement").info.userUsername, "user_b");
    assert.ok(logs.some((x) => x.type === "updateGlobalAnnouncement" && x.info.after.isActive === false));
    assert.equal(((await f.db.query(`SELECT count(*)::int AS n FROM announcement_read`)).rows[0] as any).n, 0);
  });
});
