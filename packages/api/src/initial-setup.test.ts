/**
 * Initial setup: while meta.rootUserId is null only admin/accounts/create with the
 * SETUP_PASSWORD creates the first account (root); /api/signup is refused, and a cleared
 * rootUserId does not reopen anonymous setup once a local account with a password exists.
 */
import { before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { handlers } from "./endpoints/index.js";
import type { ApiEnv } from "./env.js";
import { makeFixture, type Fixture } from "./pglite-fixture.js";

let f: Fixture;
before(async () => {
  f = await makeFixture("SetupTest");
});
beforeEach(async () => {
  await f.db.query(`UPDATE meta SET "rootUserId" = NULL, "disableRegistration" = FALSE`);
  await f.db.query(`UPDATE user_profile SET password = NULL`);
});

async function call(route: string, body: Record<string, unknown>, env: Partial<ApiEnv> = {}) {
  const r = await handlers[route]!({ ...f.env, ...env }, body, { hasCredential: false, request: new Request(`https://api.test/api/${route}`, { method: "POST" }) });
  if (r instanceof Response) {
    const text = await r.text();
    return { status: r.status, data: text ? JSON.parse(text) : null };
  }
  return { status: 200, data: r as any };
}
const root = async () => ((await f.db.query(`SELECT "rootUserId" FROM meta`)).rows[0] as { rootUserId: string | null }).rootUserId;
const WRONG = "97147c55-1ae1-4f6f-91d6-e1c3e0e76d62";

describe("initial setup", () => {
  it("is refused without SETUP_PASSWORD, whatever the body says", async () => {
    for (const setupPassword of [undefined, null, "", "anything"]) {
      const r = await call("admin/accounts/create", { username: "admin", password: "pw", setupPassword });
      assert.deepEqual([r.status, r.data.error.id], [400, WRONG]);
    }
    assert.equal(await root(), null);
  });

  it("needs the exact setup password (an empty one never matches)", async () => {
    const env = { SETUP_PASSWORD: "s3cret" };
    for (const setupPassword of [undefined, "", "s3cre", "s3cret ", "S3CRET"]) {
      const r = await call("admin/accounts/create", { username: "admin", password: "pw", setupPassword }, env);
      assert.deepEqual([r.status, r.data.error.id], [400, WRONG], String(setupPassword));
    }
    const ok = await call("admin/accounts/create", { username: "admin1", password: "pw", setupPassword: "s3cret" }, env);
    assert.equal(ok.status, 200, JSON.stringify(ok.data));
    assert.equal(await root(), ok.data.id);
    assert.equal(typeof ok.data.token, "string");
  });

  it("does not reopen when rootUserId is cleared after a local account with a password exists", async () => {
    await f.db.query(`UPDATE user_profile SET password = 'x' WHERE "userId" = $1`, [f.ids.b]);
    const r = await call("admin/accounts/create", { username: "admin2", password: "pw", setupPassword: "s3cret" }, { SETUP_PASSWORD: "s3cret" });
    assert.deepEqual([r.status, r.data.error.id], [400, "1fb7cb09-d46a-4fff-b8df-057708cce513"]);
    assert.equal(await root(), null);
  });

  it("/api/signup does not create the first (root) account", async () => {
    const r = await call("signup", { username: "early", password: "pw" });
    assert.deepEqual([r.status, r.data.message], [400, "Error: SETUP_REQUIRED"]);
    assert.equal(await root(), null);
    assert.equal((await f.db.query(`SELECT 1 FROM "user" WHERE "usernameLower" = 'early'`)).rows.length, 0);
  });
});
