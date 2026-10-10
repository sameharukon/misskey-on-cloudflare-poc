/**
 * Whole-table aggregates kept in the cache store: instance-wide / per-host charts (keyed by the
 * newest bucket, not by the raw offset), per-user charts computed every time, and `stats`.
 * Also the per-user featured ranking's renote score (counted per target note).
 */
import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { genAidx } from "../../id/src/index.js";
import { makeFixture, type Fixture } from "./pglite-fixture.js";
import { MemoryCacheStore } from "./cache.js";
import { notesRankingPg } from "./featured-pg.js";
import { withHyperdriveClient } from "./pg.js";

let f: Fixture;
const cache = new MemoryCacheStore();
const total = async (body: Record<string, unknown> = {}) => (await f.call("charts/notes", { span: "hour", limit: 2, ...body })).data.local.total[0] as number;

describe("cached aggregates", () => {
  before(async () => {
    f = await makeFixture("HeavyQueryCache", { __cacheStore: cache });
  });

  it("charts/notes is kept; per-user charts are not", async () => {
    await f.note(f.ids.b, { text: "one" });
    const first = await total();
    await f.note(f.ids.b, { text: "two" });
    assert.equal(await total(), first, "served from the cache");
    // an offset whose bucket is the current one (upstream: the bucket of offset + span - 1 ms) hits the same entry
    assert.equal(await total({ offset: Math.floor(Date.now() / 3600_000) * 3600_000 }), first);
    cache.clear();
    assert.equal(await total(), first + 1);

    const userTotal = async () => (await f.call("charts/user/notes", { span: "hour", limit: 2, userId: f.ids.b })).data.total[0] as number;
    const before = await userTotal();
    await f.note(f.ids.b, { text: "three" });
    assert.equal(await userTotal(), before + 1);
  });

  it("stats is kept", async () => {
    cache.clear();
    const s1 = (await f.call("stats", {})).data;
    await f.note(f.ids.c, { text: "more" });
    assert.equal((await f.call("stats", {})).data.notesCount, s1.notesCount);
    cache.clear();
    assert.equal((await f.call("stats", {})).data.notesCount, s1.notesCount + 1);
  });
});

describe("per-user featured ranking", () => {
  it("scores renotes of the user's notes (5 each) and reactions (1 each)", async () => {
    const t = await f.note(f.ids.b, { text: "renoted" });
    const r = await f.note(f.ids.b, { text: "reacted" });
    for (const who of ["a", "c"] as const) {
      await f.db.query(`INSERT INTO note (id, "userId", visibility, "renoteId") VALUES ($1, $2, 'public', $3)`, [genAidx(Date.now()), f.ids[who], t]);
    }
    for (const who of ["a", "c"] as const) {
      await f.db.query(`INSERT INTO note_reaction (id, "userId", "noteId", reaction) VALUES ($1, $2, $3, '👍')`, [genAidx(Date.now()), f.ids[who], r]);
    }
    const ids = await withHyperdriveClient(f.env.HYPERDRIVE!, (c) => notesRankingPg(c, { kind: "user", userId: f.ids.b }, 10));
    // 2 renotes (10) rank above 2 reactions (2)
    assert.deepEqual(ids.slice(0, 2), [t, r], JSON.stringify({ ids, t, r }));
  });
});
