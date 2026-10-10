/**
 * admin/meta, admin/update-meta, admin/server-info gate: root / moderator / administrator roles
 * are checked on PG (upstream requireModerator / requireAdmin); the old `X-Misskey-Admin-Test`
 * header bypasses nothing.
 */
import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ApiEnv } from "./env.js";
import { handlers } from "./endpoints/index.js";
import { adminGate } from "./admin-gate.js";
import { makeFixture, TOK as FTOK, type Fixture } from "./pglite-fixture.js";

let f: Fixture;
let env: ApiEnv;
// a: root (meta.rootUserId), b: moderator role, c: plain user
const TOK = { root: FTOK.a, mod: FTOK.b, user: FTOK.c };

function req(headers: Record<string, string> = {}) {
  return new Request("https://api.test/api/admin/meta", { method: "POST", headers });
}

before(async () => {
  f = await makeFixture("GateTest");
  env = f.env;
  await f.db.query(`INSERT INTO role (id, name, description, "isModerator", "updatedAt", "lastUsedAt") VALUES ('r_mod', 'mod', '', true, now(), now())`);
  await f.db.query(`INSERT INTO role_assignment (id, "userId", "roleId") VALUES ('ra', $1, 'r_mod')`, [f.ids.b]);
});

describe("admin gate (Hyperdrive bound)", () => {
  it("test header alone is rejected", async () => {
    const r = (await handlers["admin/meta"]!(env, {}, { hasCredential: false, request: req({ "X-Misskey-Admin-Test": "1" }) })) as Response;
    assert.equal(r.status, 401);
    const u = (await handlers["admin/update-meta"]!(env, { name: "x" }, { hasCredential: false, request: req({ "X-Misskey-Admin-Test": "1" }) })) as Response;
    assert.equal(u.status, 401);
  });
  it("plain user → 403 ROLE_PERMISSION_DENIED (ApiCallService ids)", async () => {
    const r = (await handlers["admin/server-info"]!(env, { i: TOK.user }, { hasCredential: true, request: req() })) as Response;
    assert.equal(r.status, 403);
    assert.deepEqual(((await r.json()) as any).error, { message: "You are not assigned to a moderator role.", code: "ROLE_PERMISSION_DENIED", id: "d33d5333-db36-423d-a8f9-1a2b9549da41", kind: "permission" });
    // admin/meta is requireAdmin upstream
    const m = (await handlers["admin/meta"]!(env, { i: TOK.mod }, { hasCredential: true, request: req() })) as Response;
    assert.equal(m.status, 403);
    assert.equal(((await m.json()) as any).error.id, "c3d38592-54c0-429d-be96-5636b0431a61");
  });
  it("root and moderator pass requireModerator; only root/admin pass requireAdmin", async () => {
    const r = await handlers["admin/meta"]!(env, { i: TOK.root }, { hasCredential: true, request: req() });
    assert.ok(!(r instanceof Response) || r.status === 200);
    assert.equal(await adminGate(req(), env as never, { i: TOK.mod }, "moderator"), null);
    assert.equal((await adminGate(req(), env as never, { i: TOK.mod }, "admin"))?.status, 403);
    assert.equal(await adminGate(req(), env as never, { i: TOK.root }, "admin"), null);
    assert.equal(await adminGate(req({ authorization: `Bearer ${TOK.root}` }), env as never, {}, "admin"), null);
  });
  it("without Hyperdrive nobody passes (the removed ADMIN_OPEN opens nothing either)", async () => {
    const off = { INSTANCE_URL: env.INSTANCE_URL };
    assert.equal((await adminGate(req({ "X-Misskey-Admin-Test": "1" }), off as never, {}, "admin"))?.status, 403);
    assert.equal((await adminGate(req(), { ...off, ADMIN_OPEN: "1" } as never, {}, "admin"))?.status, 403);
  });
  it("admin/server-info for a moderator", async () => {
    const j = (await handlers["admin/server-info"]!(env, { i: TOK.mod }, { hasCredential: true, request: req() })) as { os: string; machine: string };
    assert.equal(j.os, "workerd");
    assert.equal(j.machine, "cloudflare-workers");
  });
});
