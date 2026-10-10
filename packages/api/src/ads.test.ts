/**
 * Ads (+ meta.ads), promo notes and avatar decorations on PG (PGlite).
 */
import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { IMPLEMENTED_ENDPOINTS } from "./registry.js";
import { makeFixture, type Fixture } from "./pglite-fixture.js";
import { packInstanceMeta } from "./meta-source.js";
import { ENDPOINT_PARAM_DEFS } from "./endpoint-params.gen.js";

let f: Fixture;
before(async () => {
  f = await makeFixture("AdTest");
});

const E = (r: { data: any }) => r.data?.error?.id;
const rows = async (sql: string, p: unknown[] = []) => (await f.db.query(sql, p)).rows as any[];
const H = 3600_000;
const ad = (over: Record<string, unknown> = {}) => ({
  url: "https://ad.example/", memo: "m", place: "square", priority: "middle", ratio: 1, expiresAt: Date.now() + H, startsAt: Date.now() - H,
  imageUrl: "https://ad.example/i.png", dayOfWeek: 0, ...over,
});

describe("ads / promo / avatar decorations", () => {
  it("registers endpoints", () => {
    for (const e of ["admin/ad/create", "admin/ad/update", "admin/ad/delete", "admin/ad/list", "admin/promo/create", "promo/read",
      "admin/avatar-decorations/create", "admin/avatar-decorations/update", "admin/avatar-decorations/delete", "admin/avatar-decorations/list"]) {
      assert.ok((IMPLEMENTED_ENDPOINTS as readonly string[]).includes(e), e);
      assert.ok(ENDPOINT_PARAM_DEFS[e], e);
    }
  });

  it("admin/ad/* and meta.ads", async () => {
    assert.equal((await f.call("admin/ad/create", ad(), "b")).status, 403); // not a moderator
    assert.equal((await f.call("admin/ad/create", { ...ad(), url: "" }, "a")).status, 400);
    const live = (await f.call("admin/ad/create", ad({ isSensitive: true }), "a")).data;
    assert.equal(live.url, "https://ad.example/");
    assert.equal(live.isSensitive, true);
    const future = (await f.call("admin/ad/create", ad({ startsAt: Date.now() + H, expiresAt: Date.now() + 2 * H, memo: "later" }), "a")).data;
    const otherDay = (await f.call("admin/ad/create", ad({ dayOfWeek: 0x7f & ~(1 << new Date().getDay()), memo: "not today" }), "a")).data;
    assert.deepEqual((await f.call("admin/ad/list", {}, "a")).data.map((x: any) => x.id), [otherDay.id, future.id, live.id]);
    assert.deepEqual((await f.call("admin/ad/list", { publishing: true }, "a")).data.map((x: any) => x.id), [otherDay.id, live.id]);
    assert.deepEqual((await f.call("admin/ad/list", { publishing: false }, "a")).data.map((x: any) => x.id), [future.id]);

    const m = (await packInstanceMeta(f.env, false)) as any;
    assert.deepEqual(m.ads.map((x: any) => x.id), [live.id]);
    assert.equal(m.ads[0].isSensitive, true);
    assert.equal(m.ads[0].memo, undefined);

    assert.equal(E(await f.call("admin/ad/update", { id: "nope", memo: "x" }, "a")), "b7aa1727-1354-47bc-a182-3a9c3973d300");
    assert.equal((await f.call("admin/ad/update", { id: live.id, memo: "edited", ratio: 3 }, "a")).status, 204);
    const after = (await rows(`SELECT memo, ratio FROM ad WHERE id = $1`, [live.id]))[0];
    assert.deepEqual([after.memo, after.ratio], ["edited", 3]);
    assert.equal(E(await f.call("admin/ad/delete", { id: "nope" }, "a")), "ccac9863-3a03-416e-b899-8a64041118b1");
    assert.equal((await f.call("admin/ad/delete", { id: future.id }, "a")).status, 204);
    assert.deepEqual((await rows(`SELECT type FROM moderation_log WHERE type LIKE '%Ad' ORDER BY id`)).map((r) => r.type), ["createAd", "createAd", "createAd", "updateAd", "deleteAd"]);
  });

  it("admin/promo/create, promo/read", async () => {
    const n = await f.note(f.ids.b, { text: "promote me" });
    assert.equal(E(await f.call("admin/promo/create", { noteId: "nope", expiresAt: Date.now() + H }, "a")), "ee449fbe-af2a-453b-9cae-cf2fe7c895fc");
    assert.equal((await f.call("admin/promo/create", { noteId: n, expiresAt: Date.now() + H }, "a")).status, 204);
    assert.equal(E(await f.call("admin/promo/create", { noteId: n, expiresAt: Date.now() + H }, "a")), "ae427aa2-7a41-484f-a18c-2c1104051604");
    assert.equal((await rows(`SELECT "userId" FROM promo_note`))[0].userId, f.ids.b);
    assert.equal(E(await f.call("promo/read", { noteId: "nope" }, "c")), "d785b897-fcd3-4fe9-8fc3-b85c26e6c932");
    await f.call("promo/read", { noteId: n }, "c");
    await f.call("promo/read", { noteId: n }, "c");
    assert.equal((await rows(`SELECT 1 FROM promo_read WHERE "userId" = $1`, [f.ids.c])).length, 1);
  });

  it("admin/avatar-decorations/*", async () => {
    assert.equal((await f.call("admin/avatar-decorations/create", { name: "x", description: "", url: "https://d/x.png" }, "b")).data.error.id, "7f86f06f-7e15-4057-8561-f4b6d4ac755a");
    const d = (await f.call("admin/avatar-decorations/create", { name: "halo", description: "shiny", url: "https://d/halo.png", category: "fun" }, "a")).data;
    assert.equal(d.name, "halo");
    assert.equal(d.updatedAt, null);
    assert.equal(d.category, "fun");
    assert.deepEqual(d.roleIdsThatCanBeUsedThisDecoration, []);
    assert.equal((await f.call("admin/avatar-decorations/update", { id: d.id, description: "shinier", roleIdsThatCanBeUsedThisDecoration: ["r1", "gone"] }, "a")).status, 204);
    const l = (await f.call("admin/avatar-decorations/list", {}, "a")).data;
    assert.equal(l.length, 1);
    assert.equal(l[0].description, "shinier");
    assert.ok(l[0].updatedAt);
    // upstream get-avatar-decorations: role ids narrowed to existing roles (public ones for visitors)
    await f.db.query(`INSERT INTO role (id, name, "isPublic", description, "updatedAt", "lastUsedAt") VALUES ('r1', 'R1', FALSE, '', now(), now())`);
    const pub = (await f.call("get-avatar-decorations", {})).data;
    assert.deepEqual(pub.map((x: any) => [x.name, x.category, x.roleIdsThatCanBeUsedThisDecoration]), [["halo", "fun", []]]);
    assert.deepEqual((await f.call("get-avatar-decorations", {}, "b")).data[0].roleIdsThatCanBeUsedThisDecoration, ["r1"]);
    await f.db.query(`UPDATE role SET "isPublic" = TRUE WHERE id = 'r1'`);
    assert.deepEqual((await f.call("get-avatar-decorations", {})).data[0].roleIdsThatCanBeUsedThisDecoration, ["r1"]);
    await f.db.query(`DELETE FROM role WHERE id = 'r1'`);
    assert.equal((await f.call("admin/avatar-decorations/update", { id: "nope", name: "x" }, "a")).status, 500);
    assert.equal((await f.call("admin/avatar-decorations/delete", { id: d.id }, "a")).status, 204);
    assert.deepEqual((await f.call("admin/avatar-decorations/list", {}, "a")).data, []);
    assert.deepEqual((await rows(`SELECT type FROM moderation_log WHERE type LIKE '%AvatarDecoration' ORDER BY id`)).map((r) => r.type), ["createAvatarDecoration", "updateAvatarDecoration", "deleteAvatarDecoration"]);
  });
});
