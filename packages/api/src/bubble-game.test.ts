/**
 * Bubble game on PG (PGlite): bubble-game/register (seed window) and bubble-game/ranking
 * (top 10 of the last 7 days per gameMode).
 */
import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { IMPLEMENTED_ENDPOINTS } from "./registry.js";
import { makeFixture, type Fixture } from "./pglite-fixture.js";
import { ENDPOINT_PARAM_DEFS } from "./endpoint-params.gen.js";

let f: Fixture;
before(async () => {
  f = await makeFixture("BubbleGameTest");
});

const E = (r: { data: any }) => r.data?.error?.id;
const reg = (who: "a" | "b" | "c", score: number, extra: Record<string, unknown> = {}) =>
  f.call("bubble-game/register", { score, seed: String(Date.now() - 60_000), logs: [[1, 2, 3]], gameMode: "normal", gameVersion: 3, ...extra }, who);

describe("bubble-game", () => {
  it("registers endpoints", () => {
    for (const e of ["bubble-game/ranking", "bubble-game/register"]) {
      assert.ok((IMPLEMENTED_ENDPOINTS as readonly string[]).includes(e), e);
      assert.ok(ENDPOINT_PARAM_DEFS[e], e);
    }
  });

  it("register validates params and the seed", async () => {
    assert.equal((await f.call("bubble-game/register", { score: 1, seed: "1", logs: [], gameMode: "normal", gameVersion: 1 })).status, 401);
    assert.equal((await reg("a", -1)).status, 400);
    assert.equal((await reg("a", 1, { logs: [["x"]] })).status, 400);
    assert.equal(E(await reg("a", 1, { seed: String(Date.now() + 60_000) })), "eb627bc7-574b-4a52-a860-3c3eae772b88");
    assert.equal(E(await reg("a", 1, { seed: String(Date.now() - 6 * 3600_000) })), "eb627bc7-574b-4a52-a860-3c3eae772b88");
    assert.equal(E(await reg("a", 1, { seed: "abc" })), "5d37dbcb-891e-41ca-a3d6-e690c97775ac"); // upstream: invalid date insert → 500
    assert.equal((await reg("a", 100)).status, 204);
    const r = (await f.db.query(`SELECT * FROM bubble_game_record`)).rows as any[];
    assert.equal(r.length, 1);
    assert.deepEqual([r[0].userId, r[0].score, r[0].logs, r[0].gameMode, r[0].gameVersion, r[0].isVerified], [f.ids.a, 100, [[1, 2, 3]], "normal", 3, false]);
  });

  it("ranking: top scores of the last 7 days for the mode", async () => {
    await reg("b", 300);
    await reg("c", 200);
    await reg("c", 999, { gameMode: "square" });
    await f.db.query(`INSERT INTO bubble_game_record (id, "userId", "seededAt", seed, "gameVersion", "gameMode", score) VALUES ('old1', $1, now() - interval '8 days', '1', 3, 'normal', 5000)`, [f.ids.b]);
    const r = (await f.call("bubble-game/ranking", { gameMode: "normal" })).data;
    assert.deepEqual(r.map((x: any) => [x.score, x.user.id]), [[300, f.ids.b], [200, f.ids.c], [100, f.ids.a]]);
    assert.deepEqual(Object.keys(r[0]), ["id", "score", "user"]);
    assert.equal((await f.call("bubble-game/ranking", {})).status, 400);
  });
});
