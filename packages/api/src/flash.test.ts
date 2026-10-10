/**
 * Flash / Play on PG (PGlite): create / update / delete / show / like / unlike / featured / my /
 * my-likes (with search) / search, moderator deletion log.
 */
import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { IMPLEMENTED_ENDPOINTS } from "./registry.js";
import { makeFixture, type Fixture } from "./pglite-fixture.js";
import { ENDPOINT_PARAM_DEFS } from "./endpoint-params.gen.js";

let f: Fixture;
before(async () => {
  f = await makeFixture("FlashTest");
});

const E = (r: { data: any }) => r.data?.error?.id;
const base = { title: "Omikuji", summary: "daily fortune", script: "/// @ 0.19.0\n", permissions: [] };

describe("flash", () => {
  let fl = "";
  let priv = "";

  it("registers endpoints", () => {
    for (const e of ["flash/create", "flash/update", "flash/delete", "flash/show", "flash/like", "flash/unlike", "flash/featured", "flash/my", "flash/my-likes", "flash/search"]) {
      assert.ok((IMPLEMENTED_ENDPOINTS as readonly string[]).includes(e), e);
      assert.ok(ENDPOINT_PARAM_DEFS[e], e);
    }
  });

  it("create / update / show", async () => {
    assert.equal((await f.call("flash/create", { title: "x" }, "b")).status, 400);
    assert.equal((await f.call("flash/create", { ...base, visibility: "unlisted" }, "b")).status, 400);
    const r = await f.call("flash/create", base, "b");
    assert.equal(r.status, 200, JSON.stringify(r.data));
    fl = r.data.id;
    assert.deepEqual([r.data.visibility, r.data.likedCount, r.data.user.id], ["public", 0, f.ids.b]);
    assert.ok(!("isLiked" in r.data));
    priv = (await f.call("flash/create", { ...base, title: "Secret game", visibility: "private" }, "b")).data.id;
    assert.equal(E(await f.call("flash/update", { flashId: fl, title: "x" }, "c")), "08e60c88-5948-478e-a132-02ec701d67b2");
    assert.equal(E(await f.call("flash/update", { flashId: "nope" }, "b")), "611e13d2-309e-419a-a5e4-e0422da39b02");
    assert.ok((await f.call("flash/update", { flashId: fl, summary: "your fortune for today", permissions: ["read:account"] }, "b")).status < 300);
    const s = (await f.call("flash/show", { flashId: fl }, "c")).data;
    assert.deepEqual([s.summary, s.isLiked], ["your fortune for today", false]);
    assert.equal(E(await f.call("flash/show", { flashId: "nope" })), "f0d34a1a-d29a-401d-90ba-1982122b5630");
  });

  it("like / unlike / featured / my-likes", async () => {
    assert.equal(E(await f.call("flash/like", { flashId: fl }, "b")), "3fd8a0e7-5955-4ba9-85bb-bf3e0c30e13b");
    assert.ok((await f.call("flash/like", { flashId: fl }, "c")).status < 300);
    assert.equal(E(await f.call("flash/like", { flashId: fl }, "c")), "010065cf-ad43-40df-8067-abff9f4686e3");
    await f.call("flash/like", { flashId: priv }, "c");
    // featured: public only
    assert.deepEqual((await f.call("flash/featured", {})).data.map((x: any) => [x.id, x.likedCount]), [[fl, 1]]);
    assert.deepEqual((await f.call("flash/featured", { offset: 1 })).data, []);
    assert.deepEqual((await f.call("flash/my-likes", {}, "c")).data.map((l: any) => l.flash.id), [priv, fl]);
    assert.deepEqual((await f.call("flash/my-likes", { search: "secret" }, "c")).data.map((l: any) => l.flash.id), [priv]);
    assert.equal(E(await f.call("flash/unlike", { flashId: fl }, "a")), "755f25a7-9871-4f65-9f34-51eaad9ae0ac");
    assert.ok((await f.call("flash/unlike", { flashId: fl }, "c")).status < 300);
    assert.deepEqual((await f.call("flash/featured", {})).data, []);
  });

  it("my / search", async () => {
    assert.deepEqual((await f.call("flash/my", {}, "b")).data.map((x: any) => x.id), [priv, fl]);
    assert.deepEqual((await f.call("flash/search", { query: "fortune today" })).data.map((x: any) => x.id), [fl]);
    assert.deepEqual((await f.call("flash/search", { query: "secret" })).data, []); // private
    assert.deepEqual((await f.call("flash/search", { query: "100%" })).data, []);
    assert.equal((await f.call("flash/search", {})).status, 400);
  });

  it("delete: owner or moderator (logged)", async () => {
    assert.equal(E(await f.call("flash/delete", { flashId: fl }, "c")), "1036ad7b-9f92-4fff-89c3-0e50dc941704");
    assert.ok((await f.call("flash/delete", { flashId: fl }, "a")).status < 300);
    assert.equal(E(await f.call("flash/delete", { flashId: fl }, "b")), "de1623ef-bbb3-4289-a71e-14cfa83d9740");
    const log = (await f.db.query(`SELECT info FROM moderation_log WHERE type = 'deleteFlash'`)).rows as any[];
    assert.deepEqual([log.length, log[0].info.flashId, log[0].info.flashUserUsername], [1, fl, "user_b"]);
  });
});
