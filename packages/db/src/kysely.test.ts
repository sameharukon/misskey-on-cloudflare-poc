/**
 * Kysely over a single client (PGlite with the full vendored schema): typed reads and writes of
 * jsonb / arrays / enums, transactions, and schema.gen.ts freshness.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { loadMigrations, migrate } from "./migrate.js";
import { createKysely, jsonb, type Db, type PgQueryable } from "./kysely.js";

const here = dirname(fileURLToPath(import.meta.url));

describe("kysely", () => {
  let pglite: PGlite;
  let db: Db;
  const sent: string[] = [];

  before(async () => {
    pglite = new PGlite();
    await migrate(
      {
        async query(text, params) {
          if (params === undefined) {
            const rs = await pglite.exec(text);
            return { rows: (rs[rs.length - 1]?.rows ?? []) as Record<string, unknown>[] };
          }
          return { rows: (await pglite.query<Record<string, unknown>>(text, params)).rows };
        },
      },
      loadMigrations(),
    );
    const client: PgQueryable = {
      async query(text, params = []) {
        sent.push(text);
        const r = await pglite.query<Record<string, unknown>>(text, params);
        return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length };
      },
    };
    db = createKysely(client);
    await db
      .insertInto("user")
      .values([
        { id: "u1", lastActiveDate: new Date("2026-01-01T00:00:00Z"), username: "Alice", usernameLower: "alice", token: "t1", tags: ["a", "b"] },
        { id: "u2", lastActiveDate: "2026-01-02T00:00:00Z", username: "bob", usernameLower: "bob", host: "remote.example" },
      ])
      .execute();
  });

  after(async () => {
    await pglite.close();
  });

  it("reads typed rows", async () => {
    const row = await db.selectFrom("user").select(["id", "tags", "lastActiveDate", "followersCount"]).where("usernameLower", "=", "alice").where("host", "is", null).executeTakeFirstOrThrow();
    assert.equal(row.id, "u1");
    assert.deepEqual(row.tags, ["a", "b"]);
    assert.ok(row.lastActiveDate instanceof Date);
    assert.equal(row.followersCount, 0);
  });

  it("writes jsonb and enum columns", async () => {
    await db.insertInto("user_profile").values({ userId: "u1", mutedWords: jsonb([["foo"], "/bar/"]) }).execute();
    const p = await db.selectFrom("user_profile").select(["mutedWords", "followingVisibility"]).where("userId", "=", "u1").executeTakeFirstOrThrow();
    assert.deepEqual(p.mutedWords, [["foo"], "/bar/"]);
    assert.equal(p.followingVisibility, "public");
    const r = await db.updateTable("user_profile").set({ followingVisibility: "followers" }).where("userId", "=", "u1").executeTakeFirst();
    assert.equal(r.numUpdatedRows, 1n);
    // Enum and jsonb columns are checked at compile time (never executed).
    // @ts-expect-error not a user_profile_followingvisibility_enum value
    void db.updateTable("user_profile").set({ followingVisibility: "everyone" });
    // @ts-expect-error jsonb is written as JSON text (jsonb()), not a JS array
    void db.updateTable("user_profile").set({ mutedWords: [["foo"]] });
  });

  it("rolls back a failed transaction", async () => {
    await assert.rejects(
      db.transaction().execute(async (tx) => {
        await tx.updateTable("user").set({ name: "changed" }).where("id", "=", "u2").execute();
        throw new Error("abort");
      }),
      /abort/,
    );
    const u = await db.selectFrom("user").select("name").where("id", "=", "u2").executeTakeFirstOrThrow();
    assert.equal(u.name, null);
  });

  it("schema.gen.ts matches the vendored migrations", () => {
    execFileSync(process.execPath, ["--import", "tsx", resolve(here, "../scripts/gen-types.ts"), "--check"], { stdio: "pipe" });
  });
});
