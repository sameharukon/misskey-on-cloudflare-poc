/**
 * Invite codes on PG (PGlite): canInvite gate, create with inviteLimit / cycle / expiration,
 * limit, list, delete rules (own / unused, moderators may delete any), admin/invite/create|list.
 */
import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { IMPLEMENTED_ENDPOINTS } from "./registry.js";
import { makeFixture, type Fixture } from "./pglite-fixture.js";
import { generateInviteCode } from "./invites-pg.js";
import { ENDPOINT_PARAM_DEFS } from "./endpoint-params.gen.js";

let f: Fixture;
before(async () => {
  f = await makeFixture("InviteTest");
});

const E = (r: { data: any }) => r.data?.error?.id;

describe("invite codes", () => {
  it("registers endpoints; code format", () => {
    for (const e of ["invite/create", "invite/delete", "invite/limit", "invite/list", "admin/invite/create", "admin/invite/list"]) {
      assert.ok((IMPLEMENTED_ENDPOINTS as readonly string[]).includes(e), e);
      assert.ok(ENDPOINT_PARAM_DEFS[e], e);
    }
    assert.match(generateInviteCode(), /^[2-9A-HJ-NP-Z]{13,}$/);
  });

  it("invite/*: canInvite, limit per cycle, expiration, list, delete", async () => {
    assert.equal((await f.call("invite/create", {}, "b")).status, 403); // canInvite is off by default
    await f.setPolicy(f.ids.b, "canInvite", true);
    await f.setPolicy(f.ids.b, "inviteLimit", 2);
    await f.setPolicy(f.ids.b, "inviteExpirationTime", 60);
    assert.deepEqual((await f.call("invite/limit", {}, "b")).data, { remaining: 2 });
    const c1 = await f.call("invite/create", {}, "b");
    assert.equal(c1.status, 200, JSON.stringify(c1.data));
    assert.equal(c1.data.createdBy.id, f.ids.b);
    assert.equal(c1.data.used, false);
    assert.ok(Math.abs(Date.parse(c1.data.expiresAt) - (Date.now() + 3600_000)) < 60_000);
    await f.call("invite/create", {}, "b");
    assert.equal(E(await f.call("invite/create", {}, "b")), "8b165dd3-6f37-4557-8db1-73175d63c641");
    assert.deepEqual((await f.call("invite/limit", {}, "b")).data, { remaining: 0 });
    assert.equal((await f.call("invite/list", {}, "b")).data.length, 2);
    // a used code can't be deleted by its creator; someone else's code is denied
    await f.db.query(`UPDATE registration_ticket SET "usedById" = $2, "usedAt" = now() WHERE id = $1`, [c1.data.id, f.ids.c]);
    assert.equal(E(await f.call("invite/delete", { inviteId: c1.data.id }, "b")), "ff17af39-000c-4d4e-abdf-848fa30fc1ce");
    await f.setPolicy(f.ids.c, "canInvite", true);
    assert.equal(E(await f.call("invite/delete", { inviteId: c1.data.id }, "c")), "5eb8d909-2540-4970-90b8-dd6f86088121");
    assert.equal(E(await f.call("invite/delete", { inviteId: "nope" }, "b")), "cd4f9ae4-7854-4e3e-8df9-c296f051e634");
    const used = (await f.call("invite/list", {}, "b")).data.find((x: any) => x.id === c1.data.id);
    assert.equal(used.used, true);
    assert.equal(used.usedBy.id, f.ids.c);
    // root (moderator) may delete it
    await f.setPolicy(f.ids.a, "canInvite", true);
    assert.equal((await f.call("invite/delete", { inviteId: c1.data.id }, "a")).status, 204);
  });

  it("admin/invite/create|list", async () => {
    assert.equal((await f.call("admin/invite/create", {}, "b")).status, 403);
    assert.equal(E(await f.call("admin/invite/create", { expiresAt: "not a date" }, "a")), "f1380b15-3760-4c6c-a1db-5c3aaf1cbd49");
    const r = await f.call("admin/invite/create", { count: 3, expiresAt: "2000-01-01T00:00:00Z" }, "a");
    assert.equal(r.data.length, 3);
    assert.equal(new Set(r.data.map((x: any) => x.code)).size, 3);
    assert.equal((await f.call("admin/invite/list", { type: "expired" }, "a")).data.length, 3);
    assert.equal((await f.call("admin/invite/list", { type: "unused", limit: 100 }, "a")).data.length, 4);
    assert.equal((await f.call("admin/invite/list", { type: "used" }, "a")).data.length, 0);
    const log = ((await f.db.query(`SELECT info FROM moderation_log WHERE type = 'createInvitation'`)).rows[0] as any).info;
    assert.equal(log.invitations.length, 3);
  });
});
