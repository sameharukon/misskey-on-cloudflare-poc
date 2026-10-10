/**
 * User moderation on PG (PGlite): suspend / unsuspend (moderators protected, suspended tokens
 * stop working), moderation notes, password reset (admins protected), show-user / show-users,
 * user IPs and moderation logs (administrators only).
 */
import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";
import { IMPLEMENTED_ENDPOINTS } from "./registry.js";
import { makeFixture, TOK, type Fixture } from "./pglite-fixture.js";
import { callGate } from "./router.js";
import { secureRndstr } from "./admin-users-pg.js";
import { ENDPOINT_PARAM_DEFS } from "./endpoint-params.gen.js";

let f: Fixture;
let modRole = "";
before(async () => {
  f = await makeFixture("AdminUserTest");
  // b is a moderator through a role
  modRole = (await f.call("admin/roles/create", {
    name: "Mods", description: "", color: null, iconUrl: null, target: "manual", condFormula: {}, isPublic: false,
    isModerator: true, isAdministrator: false, asBadge: false, canEditMembersByModerator: false, displayOrder: 0, policies: {},
  }, "a")).data.id;
  await f.call("admin/roles/assign", { roleId: modRole, userId: f.ids.b }, "a");
});

const E = (r: { data: any }) => r.data?.error?.id;

describe("admin user moderation", () => {
  it("registers endpoints; secureRndstr", () => {
    for (const e of ["admin/suspend-user", "admin/unsuspend-user", "admin/update-user-note", "admin/reset-password", "admin/show-user", "admin/show-users", "admin/get-user-ips", "admin/show-moderation-logs"]) {
      assert.ok((IMPLEMENTED_ENDPOINTS as readonly string[]).includes(e), e);
      assert.ok(ENDPOINT_PARAM_DEFS[e], e);
    }
    assert.match(secureRndstr(8), /^[0-9a-zA-Z]{8}$/);
  });

  it("suspend / unsuspend", async () => {
    assert.equal((await f.call("admin/suspend-user", { userId: f.ids.a }, "c")).status, 403);
    assert.equal((await f.call("admin/suspend-user", { userId: f.ids.a }, "b")).status, 500); // root is a moderator
    assert.equal((await f.call("admin/suspend-user", { userId: "nope" }, "b")).status, 500);
    assert.equal((await f.call("i", {}, "c")).status, 200);
    // UserSuspendService follow-up: follow requests both ways deleted, followings removed silently
    await f.db.query(`INSERT INTO following (id, "followerId", "followeeId") VALUES ('sf1', $1, $2)`, [f.ids.c, f.ids.a]);
    await f.db.query(`INSERT INTO follow_request (id, "followerId", "followeeId") VALUES ('sr1', $1, $2), ('sr2', $2, $1)`, [f.ids.c, f.ids.b]);
    assert.equal((await f.call("admin/suspend-user", { userId: f.ids.c }, "b")).status, 204);
    assert.equal((await f.db.query(`SELECT id FROM following WHERE id = 'sf1'`)).rows.length, 0);
    assert.equal((await f.db.query(`SELECT id FROM follow_request WHERE id IN ('sr1', 'sr2')`)).rows.length, 0);
    // as upstream ApiCallService: the suspended user authenticates, credential-required endpoints refuse
    const gated = await callGate(f.env, "i", new Request("https://api.test/api/i", { method: "POST" }), { i: TOK.c });
    assert.equal(gated?.status, 403);
    assert.equal(((await gated!.json()) as any).error.id, "a8c724b3-6e9c-4b46-b1a8-bc3ed6258370");
    assert.equal((await f.call("admin/show-user", { userId: f.ids.c }, "b")).data.isSuspended, true);
    assert.deepEqual((await f.call("admin/show-users", { state: "suspended" }, "b")).data.map((u: any) => u.id), [f.ids.c]);
    assert.equal((await f.call("admin/unsuspend-user", { userId: f.ids.c }, "b")).status, 204);
    assert.equal((await f.call("i", {}, "c")).status, 200);
  });

  it("update-user-note / reset-password", async () => {
    assert.equal((await f.call("admin/update-user-note", { userId: f.ids.c, text: "watch" }, "b")).status, 204);
    assert.equal((await f.call("admin/show-user", { userId: f.ids.c }, "b")).data.moderationNote, "watch");
    const r = await f.call("admin/reset-password", { userId: f.ids.c }, "b");
    assert.equal(r.status, 200);
    assert.match(r.data.password, /^[0-9a-zA-Z]{8}$/);
    const hash = ((await f.db.query(`SELECT password FROM user_profile WHERE "userId" = $1`, [f.ids.c])).rows[0] as any).password;
    assert.ok(await bcrypt.compare(r.data.password, hash));
    assert.equal(E(await f.call("admin/reset-password", { userId: "nope" }, "b")), "ccafc7fe-5074-4edd-9dc0-8ef9ef6a701d");
  });

  it("show-user (admins hidden from non-admins) / show-users filters", async () => {
    const s = await f.call("admin/show-user", { userId: f.ids.b }, "a");
    assert.equal(s.status, 200);
    assert.equal(s.data.isModerator, true);
    assert.equal(s.data.isSilenced, false);
    assert.deepEqual(s.data.roles.map((x: any) => x.id), [modRole]);
    assert.equal(s.data.roleAssigns[0].roleId, modRole);
    assert.equal(s.data.policies.canPublicNote, true);
    // a is root → administrator; b (moderator) may not look at a
    assert.equal((await f.call("admin/show-user", { userId: f.ids.a }, "b")).status, 500);
    assert.deepEqual((await f.call("admin/show-users", { state: "moderator" }, "b")).data.map((u: any) => u.id), [f.ids.b]);
    assert.deepEqual((await f.call("admin/show-users", { state: "admin" }, "b")).data, []); // root is not a role holder
    assert.deepEqual((await f.call("admin/show-users", { username: "USER_" }, "b")).data.map((u: any) => u.id), [f.ids.a, f.ids.b, f.ids.c]);
    assert.deepEqual((await f.call("admin/show-users", { sort: "-createdAt", limit: 1, offset: 1 }, "b")).data.map((u: any) => u.id), [f.ids.b]);
    assert.equal((await f.call("admin/show-users", { sort: "bogus" }, "b")).status, 400);
  });

  it("get-user-ips / show-moderation-logs are admin only", async () => {
    assert.equal((await f.call("admin/get-user-ips", { userId: f.ids.c }, "b")).status, 403);
    await f.db.query(`INSERT INTO user_ip ("createdAt", "userId", ip) VALUES (now(), $1, '203.0.113.1')`, [f.ids.c]);
    assert.deepEqual((await f.call("admin/get-user-ips", { userId: f.ids.c }, "a")).data.map((x: any) => x.ip), ["203.0.113.1"]);
    assert.equal((await f.call("admin/show-moderation-logs", {}, "b")).status, 403);
    const logs = (await f.call("admin/show-moderation-logs", { limit: 100 }, "a")).data;
    const types = logs.map((x: any) => x.type).sort();
    assert.deepEqual(types, ["assignRole", "createRole", "resetPassword", "suspend", "unsuspend", "updateUserNote"]);
    const s = logs.find((x: any) => x.type === "suspend");
    assert.equal(s.user.id, f.ids.b);
    assert.equal(s.info.userUsername, "user_c");
    assert.deepEqual((await f.call("admin/show-moderation-logs", { type: "suspend" }, "a")).data.length, 1);
    assert.deepEqual((await f.call("admin/show-moderation-logs", { search: "watch" }, "a")).data.map((x: any) => x.type), ["updateUserNote"]);
    assert.deepEqual((await f.call("admin/show-moderation-logs", { userId: f.ids.a }, "a")).data.map((x: any) => x.type).sort(), ["assignRole", "createRole"]);
  });
});
