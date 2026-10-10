/**
 * Vendored schema migrations (packages/db/migrations) applied to PGlite: the full chain runs,
 * bookkeeping matches TypeORM's `migrations` table, re-runs are no-ops, and the emitted SQL
 * script is re-runnable.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { appliedMigrations, loadMigrations, migrate, planMigrations, renderMigrationScript, type MigrationClient } from "./migrate.js";

function client(db: PGlite): MigrationClient {
  return {
    async query(sql, params) {
      if (params === undefined) {
        const results = await db.exec(sql);
        return { rows: (results[results.length - 1]?.rows ?? []) as Record<string, unknown>[] };
      }
      const r = await db.query<Record<string, unknown>>(sql, params);
      return { rows: r.rows };
    },
  };
}

const all = loadMigrations();

describe("schema migrations", () => {
  it("are vendored in TypeORM order with unique names", () => {
    assert.ok(all.length >= 346);
    assert.equal(all[0].name, "Init1000000000000");
    for (let i = 1; i < all.length; i++) assert.ok(all[i - 1].timestamp <= all[i].timestamp, `${all[i - 1].name} before ${all[i].name}`);
    // The file name's timestamp differs from the class name's here; the name decides the order.
    const i = all.findIndex((m) => m.name === "SuspensionStateInsteadOfIsSspended1716345771510");
    assert.ok(i > 0 && all[i - 1].timestamp < 1716345771510);
  });

  it("apply the full chain to an empty database, then do nothing", async () => {
    const db = new PGlite();
    const c = client(db);
    const done = await migrate(c, all);
    assert.equal(done.length, all.length);
    const applied = await appliedMigrations(c);
    assert.deepEqual(
      applied.map((a) => a.name),
      all.map((m) => m.name),
    );
    assert.equal(applied[applied.length - 1].timestamp, all[all.length - 1].timestamp);
    const meta = await db.query(`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'meta' AND column_name = 'rootUserId'`);
    assert.equal((meta.rows[0] as { n: number }).n, 1);
    assert.deepEqual(await migrate(c, all), []);
    await db.close();
  });

  it("resumes a partially migrated database and backfills data", async () => {
    const db = new PGlite();
    const c = client(db);
    const cut = all.findIndex((m) => m.name === "UserListUserId1696807733453");
    await migrate(c, all.slice(0, cut));
    await db.exec(`
      INSERT INTO "user" (id, "createdAt", username, "usernameLower", token) VALUES ('u1', now(), 'a', 'a', 't1'), ('u2', now(), 'b', 'b', 't2');
      INSERT INTO user_list (id, "createdAt", "userId", name) VALUES ('l1', now(), 'u1', 'L');
      INSERT INTO user_list_membership (id, "createdAt", "userId", "userListId") VALUES ('m1', now(), 'u2', 'l1');
    `);
    const plan = planMigrations(all, await appliedMigrations(c));
    assert.equal(plan.pending.length, all.length - cut);
    const done = await migrate(c, all);
    assert.equal(done.length, all.length - cut);
    const r = await db.query(`SELECT "userListUserId" FROM user_list_membership WHERE id = 'm1'`);
    assert.deepEqual(r.rows, [{ userListUserId: "u1" }]);
    await db.close();
  });

  it("refuses a database that is ahead of the vendored migrations", async () => {
    const db = new PGlite();
    const c = client(db);
    await migrate(c, all.slice(0, 1));
    await db.query(`INSERT INTO "migrations" ("timestamp", "name") VALUES (9999999999999, 'Future9999999999999')`);
    const plan = planMigrations(all.slice(0, 2), await appliedMigrations(c));
    assert.deepEqual(plan.unknown, [{ name: "Future9999999999999", timestamp: 9999999999999 }]);
    assert.deepEqual(
      plan.outOfOrder.map((m) => m.name),
      [all[1].name],
    );
    await assert.rejects(migrate(c, all.slice(0, 2)), /does not know/);
    assert.equal((await migrate(c, all.slice(0, 2), { allowUnknown: true })).length, 1);
    await db.close();
  });

  it("emit a SQL script that can be run twice", async () => {
    const db = new PGlite();
    const script = renderMigrationScript(all.slice(0, 40));
    await db.exec(script);
    await db.exec(script);
    const r = await db.query(`SELECT count(*)::int AS n, count(DISTINCT name)::int AS d FROM "migrations"`);
    assert.deepEqual(r.rows, [{ n: 40, d: 40 }]);
    await db.close();
  });
});
