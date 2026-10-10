/**
 * Packing many users / notifications does not cost queries per item: the detailed pack reads
 * roles, policies and relations for all users at once, and the notification pack reads its
 * notifiers once.
 */
import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeFixture, type Fixture } from "./pglite-fixture.js";
import { packUsersDetailedPg } from "./user-detailed-pg.js";
import { runWithPgScope } from "./pg.js";

let f: Fixture;
let queries = 0;
let texts: string[] = [];

before(async () => {
  f = await makeFixture("PackQueryCount");
  const hd = f.env.HYPERDRIVE as unknown as { __testClient: { query: (...a: unknown[]) => Promise<unknown> } };
  const inner = hd.__testClient;
  hd.__testClient = {
    ...inner,
    query: (...a: unknown[]) => {
      queries++;
      texts.push(String(typeof a[0] === "string" ? a[0] : (a[0] as { text?: string }).text));
      return inner.query(...a);
    },
  } as typeof inner;
  await f.db.query(`INSERT INTO role (id, name, description, "isModerator", "isPublic", target, "condFormula", "updatedAt", "lastUsedAt") VALUES ('r_cond', 'cond', '', false, true, 'conditional', '{"type":"isLocal"}', now(), now())`).catch(() => undefined);
});

/** Queries for one detailed pack (a fresh request scope, as each API call has). */
async function count(ids: string[]): Promise<number> {
  queries = 0;
  const out = await runWithPgScope(() => packUsersDetailedPg(f.env, ids, f.ids.a, { schema: "UserDetailedNotMe", many: true }));
  assert.equal(out.length, ids.length);
  return queries;
}

describe("detailed user pack", () => {
  it("costs the same number of queries for one user or several", async () => {
    await count([f.ids.b]); // warm the isolate caches (meta, conditional roles)
    const one = await count([f.ids.b]);
    const two = await count([f.ids.b, f.ids.c]);
    assert.equal(two, one);
  });
});

describe("home timeline page", () => {
  it("one round trip for the list page and its notes; no queries per note", async () => {
    await f.call("following/create", { userId: f.ids.b }, "a");
    const page = async () => {
      await f.call("notes/timeline", { limit: 3 }, "a"); // warm
      queries = 0;
      texts = [];
      const r = await f.call("notes/timeline", { limit: 3 }, "a");
      assert.equal(r.status, 200);
      return queries;
    };
    for (let i = 0; i < 4; i++) await f.note(f.ids.b, { text: `n${i}`, visibility: "public" });
    const few = await page();
    // no separate id query: the page and the filtered fetch are one statement
    assert.equal(texts.filter((t) => /^\s*SELECT note\.id FROM note/.test(t)).length, 0);
    assert.equal(texts.filter((t) => /^\s*WITH ids AS/.test(t)).length, 1);
    for (let i = 4; i < 10; i++) await f.note(f.ids.b, { text: `n${i}`, visibility: "public" });
    assert.equal(await page(), few);
  });
});
