/**
 * Account deletion on PG (PGlite): i/delete-account (password, 2FA, root / system accounts),
 * admin/delete-account (remote = soft, moderation log), the stepped deleteAccount job (notes in
 * pages of 100, drive files + R2 objects, then the user row) inline and through mk-jobs.
 */
import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";
import { makeFixture, type Fixture } from "./pglite-fixture.js";
import { handleApQueueBatch } from "./index.js";
import { runJobStep, type JobMessage } from "./jobs.js";
import type { ApiEnv } from "./env.js";

const r2Deleted: string[] = [];
const bucket = { delete: async (keys: string | string[]) => void r2Deleted.push(...(Array.isArray(keys) ? keys : [keys])) };

let f: Fixture;
before(async () => {
  f = await makeFixture("DeleteAccountTest", { MEDIA_BUCKET: bucket as unknown as ApiEnv["MEDIA_BUCKET"] });
  await f.db.query(`UPDATE user_profile SET password = $1`, [await bcrypt.hash("pw", 4)]);
});

const count = async (sql: string, p: unknown[]) => Number(((await f.db.query(sql, p)).rows[0] as any).n);

describe("account deletion", () => {
  it("i/delete-account: password, root refused, then notes / files / user are removed", async () => {
    for (let i = 0; i < 120; i++) await f.note(f.ids.b, { text: `n${i}` });
    const quoted = await f.note(f.ids.a, { text: "quoted", pageCount: 1 });
    await f.db.query(
      `INSERT INTO page (id, "updatedAt", title, name, "alignCenter", font, "userId", content, visibility) VALUES ('pg1', now(), 't', 'n', false, 'serif', $1, $2::jsonb, 'public')`,
      [f.ids.b, JSON.stringify([{ type: "note", note: quoted }])],
    );
    for (let i = 0; i < 12; i++) {
      await f.db.query(`INSERT INTO drive_file (id, "userId", type, name, url, "accessKey", "thumbnailAccessKey", md5, size, "storedInternal") VALUES ($1, $2, 'image/png', 'f', 'u', $3, $4, '0', 0, FALSE)`, [`f${i}`, f.ids.b, `k${i}`, `t${i}`]);
    }
    assert.equal((await f.call("i/delete-account", { password: "nope" }, "b")).status, 500);
    assert.equal((await f.call("i/delete-account", {}, "b")).status, 400);
    assert.equal((await f.call("i/delete-account", { password: "pw" }, "a")).status, 500); // root
    assert.equal((await f.call("i/delete-account", { password: "pw" }, "b")).status, 204);
    assert.equal(await count(`SELECT count(*)::int AS n FROM note WHERE "userId" = $1`, [f.ids.b]), 0);
    assert.equal(await count(`SELECT count(*)::int AS n FROM drive_file WHERE "userId" = $1`, [f.ids.b]), 0);
    assert.equal(await count(`SELECT count(*)::int AS n FROM "user" WHERE id = $1`, [f.ids.b]), 0);
    assert.equal(await count(`SELECT count(*)::int AS n FROM page WHERE "userId" = $1`, [f.ids.b]), 0);
    assert.equal(await count(`SELECT "pageCount" AS n FROM note WHERE id = $1`, [quoted]), 0);
    assert.equal(r2Deleted.length, 24);
    assert.ok(r2Deleted.includes("drive/k0") && r2Deleted.includes("drive/t11"));
    assert.equal((await f.call("i", {}, "b")).status, 401);
  });

  it("2FA accounts need a second factor", async () => {
    await f.db.query(`UPDATE user_profile SET "twoFactorEnabled" = TRUE, "twoFactorBackupSecret" = '{BACKUP1}' WHERE "userId" = $1`, [f.ids.c]);
    assert.equal((await f.call("i/delete-account", { password: "pw" }, "c")).status, 500);
    // marked deleted → tokens stop working even before the job finishes
    await f.db.query(`UPDATE "user" SET "isDeleted" = TRUE WHERE id = $1`, [f.ids.c]);
    assert.equal((await f.call("i", {}, "c")).status, 401);
    await f.db.query(`UPDATE "user" SET "isDeleted" = FALSE WHERE id = $1`, [f.ids.c]);
    assert.equal((await f.call("i/delete-account", { password: "pw", token: "BACKUP1" }, "c")).status, 204);
    assert.equal(await count(`SELECT count(*)::int AS n FROM "user" WHERE id = $1`, [f.ids.c]), 0);
  });

  it("admin/delete-account: remote users are soft-deleted, system accounts refused, logged", async () => {
    await f.db.query(`INSERT INTO "user" (id, username, "usernameLower", host) VALUES ('remote1', 'r', 'r', 'remote.example'), ('sys1', 'instance.actor', 'instance.actor', NULL)`);
    await f.note("remote1", { text: "remote note" });
    assert.equal((await f.call("admin/delete-account", { userId: "remote1" })).status, 401);
    assert.equal((await f.call("admin/delete-account", { userId: "remote1" }, "a")).status, 204);
    assert.equal(await count(`SELECT count(*)::int AS n FROM note WHERE "userId" = 'remote1'`, []), 0);
    assert.equal(((await f.db.query(`SELECT "isDeleted" FROM "user" WHERE id = 'remote1'`)).rows[0] as any).isDeleted, true);
    assert.equal((await f.call("admin/delete-account", { userId: "remote1" }, "a")).status, 204); // already deleted: no-op
    assert.equal((await f.call("admin/delete-account", { userId: "sys1" }, "a")).status, 500);
    assert.equal((await f.call("admin/delete-account", { userId: "nope" }, "a")).status, 500);
    const logs = (await f.db.query(`SELECT info FROM moderation_log WHERE type = 'deleteAccount'`)).rows as any[];
    assert.deepEqual(logs.map((l) => l.info), [{ userId: "remote1", userUsername: "r", userHost: "remote.example" }]);
  });

  it("mk-jobs consumer runs one step and re-enqueues the next", async () => {
    await f.db.query(`INSERT INTO "user" (id, username, "usernameLower") VALUES ('q1', 'q', 'q')`);
    for (let i = 0; i < 101; i++) await f.note("q1", { text: `q${i}` });
    const queued: JobMessage[] = [];
    const env = { ...f.env, Q_JOBS: { send: async (m: unknown) => void queued.push(m as JobMessage) } } as ApiEnv;
    let acked = 0;
    const run = async (body: JobMessage) => handleApQueueBatch({ queue: "mk-jobs", messages: [{ body, ack: () => void acked++, retry: () => assert.fail("retry") }] }, env);
    await run({ kind: "deleteAccount", userId: "q1", soft: false, step: "notes" });
    assert.deepEqual(queued.at(-1), { kind: "deleteAccount", userId: "q1", soft: false, step: "notes" });
    assert.equal(await count(`SELECT count(*)::int AS n FROM note WHERE "userId" = 'q1'`, []), 1);
    await run(queued.at(-1)!);
    assert.equal((queued.at(-1) as any).step, "files");
    await run(queued.at(-1)!);
    assert.equal((queued.at(-1) as any).step, "user");
    await run(queued.at(-1)!);
    assert.equal(queued.length, 3);
    assert.equal(acked, 4);
    assert.equal(await count(`SELECT count(*)::int AS n FROM "user" WHERE id = 'q1'`, []), 0);
    assert.equal(await runJobStep(f.env, { kind: "deleteAccount", userId: "q1", soft: false }), null); // gone: nothing to do
  });
});
