/**
 * Roles on PG (PGlite): admin/roles create/update/delete (admins), list/show/users (moderators),
 * assign/unassign (canEditMembersByModerator, expiry, moderation log), the effect on policies,
 * the roleAssigned notification (real NotificationBox class on in-memory storage), and the
 * public roles/* endpoints.
 */
import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { NotificationBox, TimelineShard } from "../../timeline/src/index.js";
import { timelineDoId } from "../../shared/src/index.js";
import { IMPLEMENTED_ENDPOINTS } from "./registry.js";
import { fakeDoNamespace, makeFixture, type Fixture } from "./pglite-fixture.js";
import type { ApiEnv } from "./env.js";
import { testDoStorage } from "../../shared/src/test-do-storage.js";
import { ENDPOINT_PARAM_DEFS } from "./endpoint-params.gen.js";
import { rpcStub } from "../../shared/src/testing/do-namespace.js";

let f: Fixture;
before(async () => {
  f = await makeFixture("RoleTest", { NOTIFICATION_BOX: fakeDoNamespace((s) => new NotificationBox(s as never)) as unknown as ApiEnv["NOTIFICATION_BOX"] });
});

const E = (r: { data: any }) => r.data?.error?.id;
const base = {
  name: "Mods", description: "moderators", color: null, iconUrl: null, target: "manual", condFormula: {}, isPublic: false,
  isModerator: true, isAdministrator: false, asBadge: false, canEditMembersByModerator: false, displayOrder: 0, policies: {},
};

describe("roles", () => {
  let mod = "";
  let pub = "";

  it("registers endpoints", () => {
    for (const e of ["admin/roles/create", "admin/roles/update", "admin/roles/delete", "admin/roles/list", "admin/roles/show", "admin/roles/users", "admin/roles/assign", "admin/roles/unassign", "roles/list", "roles/show", "roles/users", "roles/notes"]) {
      assert.ok((IMPLEMENTED_ENDPOINTS as readonly string[]).includes(e), e);
      assert.ok(ENDPOINT_PARAM_DEFS[e], e);
    }
  });

  it("create / show / list / update (admins only for writes)", async () => {
    assert.equal((await f.call("admin/roles/create", base, "b")).status, 403);
    assert.equal((await f.call("admin/roles/create", { ...base, displayOrder: undefined }, "a")).status, 400);
    const r = await f.call("admin/roles/create", base, "a");
    assert.equal(r.status, 200, JSON.stringify(r.data));
    mod = r.data.id;
    assert.equal(r.data.isModerator, true);
    assert.equal(r.data.isExplorable, false);
    assert.equal(r.data.usersCount, 0);
    assert.deepEqual(r.data.policies.canSearchNotes, { useDefault: true, priority: 0, value: false });
    pub = (await f.call("admin/roles/create", {
      ...base, name: "Searchers", isModerator: false, isPublic: true, isExplorable: true, canEditMembersByModerator: true,
      policies: { canSearchNotes: { useDefault: false, priority: 0, value: true } },
    }, "a")).data.id;
    assert.equal((await f.call("admin/roles/update", { roleId: pub, description: "can search", color: "#f00" }, "a")).status, 204);
    const s = await f.call("admin/roles/show", { roleId: pub }, "a");
    assert.equal(s.data.description, "can search");
    assert.equal(s.data.color, "#f00");
    assert.equal(s.data.policies.canSearchNotes.value, true);
    assert.equal(E(await f.call("admin/roles/show", { roleId: "nope" }, "a")), "07dc7d34-c0d8-49b7-96c6-db3ce64ee0b3");
    assert.equal(E(await f.call("admin/roles/update", { roleId: "nope", name: "x" }, "a")), "cd23ef55-09ad-428a-ac61-95a45e124b32");
    assert.equal((await f.call("admin/roles/update", { roleId: pub, target: "bogus" }, "a")).status, 400);
    assert.equal((await f.call("admin/roles/list", {}, "a")).data.length, 2);
    assert.equal((await f.call("admin/roles/list", {}, "b")).status, 403);
  });

  it("assign / unassign: permissions, expiry, policies take effect, notification, log", async () => {
    // b becomes moderator through the role; moderators may only edit canEditMembersByModerator roles
    assert.equal((await f.call("admin/roles/assign", { roleId: mod, userId: f.ids.b }, "a")).status, 204);
    assert.equal((await f.call("admin/roles/list", {}, "b")).status, 200);
    assert.equal(E(await f.call("admin/roles/assign", { roleId: mod, userId: f.ids.c }, "b")), "25b5bc31-dc79-4ebd-9bd2-c84978fd052c");
    assert.equal(E(await f.call("admin/roles/assign", { roleId: pub, userId: "nope" }, "b")), "558ea170-f653-4700-94d0-5a818371d0df");
    // canSearchNotes off by default → UNAVAILABLE; on through the role
    assert.equal(E(await f.call("notes/search", { query: "x" }, "c")), "0b44998d-77aa-4427-80d0-d2c9b8523011");
    assert.equal((await f.call("admin/roles/assign", { roleId: pub, userId: f.ids.c }, "b")).status, 204);
    assert.equal((await f.call("notes/search", { query: "x" }, "c")).status, 200);
    assert.equal((await f.call("admin/roles/assign", { roleId: pub, userId: f.ids.c }, "b")).status, 500); // upstream AlreadyAssignedError
    // past expiry is ignored
    assert.equal((await f.call("admin/roles/assign", { roleId: pub, userId: f.ids.a, expiresAt: Date.now() - 1 }, "a")).status, 204);
    const users = await f.call("admin/roles/users", { roleId: pub }, "b");
    assert.deepEqual(users.data.map((x: any) => [x.user.id, x.expiresAt]), [[f.ids.c, null]]);
    assert.equal((await f.call("admin/roles/show", { roleId: pub }, "a")).data.usersCount, 1);
    // public role → roleAssigned notification with the packed role
    const notifs = (await f.call("i/notifications", {}, "c")).data;
    const n = notifs.find((x: any) => x.type === "roleAssigned");
    assert.ok(n, JSON.stringify(notifs));
    assert.equal(n.role.id, pub);
    assert.ok(!("user" in n));
    assert.ok(!(await f.call("i/notifications", {}, "b")).data.some((x: any) => x.type === "roleAssigned")); // non-public role
    assert.equal((await f.call("admin/roles/unassign", { roleId: pub, userId: f.ids.c }, "b")).status, 204);
    // as upstream: RoleService.NotAssignedError is not mapped by the endpoint → 500 (NOT_ASSIGNED is never sent)
    assert.equal(E(await f.call("admin/roles/unassign", { roleId: pub, userId: f.ids.c }, "b")), "5d37dbcb-891e-41ca-a3d6-e690c97775ac");
    assert.equal((await f.call("roles/users", { roleId: pub, limit: 0 })).status, 400);
    assert.equal(E(await f.call("notes/search", { query: "x" }, "c")), "0b44998d-77aa-4427-80d0-d2c9b8523011");
    const types = ((await f.db.query(`SELECT type FROM moderation_log`)).rows as any[]).map((x) => x.type).sort();
    assert.deepEqual(types, ["assignRole", "assignRole", "createRole", "createRole", "unassignRole", "updateRole"]);
  });

  it("public roles/*", async () => {
    await f.call("admin/roles/assign", { roleId: pub, userId: f.ids.c }, "a");
    const nid = await f.note(f.ids.c, { text: "from a searcher" });
    await f.note(f.ids.c, { text: "home only", visibility: "home" });
    assert.deepEqual((await f.call("roles/list", {}, "b")).data.map((x: any) => x.id), [pub]);
    assert.equal((await f.call("roles/list", {})).status, 401);
    assert.equal((await f.call("roles/show", { roleId: pub })).data.name, "Searchers");
    assert.equal(E(await f.call("roles/show", { roleId: mod })), "de5502bf-009a-4639-86c1-fec349e46dcb");
    assert.deepEqual((await f.call("roles/users", { roleId: pub })).data.map((x: any) => x.user.id), [f.ids.c]);
    assert.equal(E(await f.call("roles/users", { roleId: mod })), "30aaaee3-4792-48dc-ab0d-cf501a575ac5");
    assert.deepEqual((await f.call("roles/notes", { roleId: pub }, "b")).data.map((x: any) => x.id), [nid]);
    await f.call("admin/roles/update", { roleId: pub, isExplorable: false }, "a");
    assert.deepEqual((await f.call("roles/notes", { roleId: pub }, "b")).data, []);
  });

  it("delete removes assignments", async () => {
    assert.equal(E(await f.call("admin/roles/delete", { roleId: "nope" }, "a")), "de0d6ecd-8e0a-4253-88ff-74bc89ae3d45");
    assert.equal((await f.call("admin/roles/delete", { roleId: pub }, "a")).status, 204);
    assert.equal(((await f.db.query(`SELECT count(*)::int AS n FROM role_assignment WHERE "roleId" = $1`, [pub])).rows[0] as any).n, 0);
    // the roleAssigned notification whose role is gone is dropped
    assert.ok(!(await f.call("i/notifications", {}, "c")).data.some((x: any) => x.type === "roleAssigned"));
  });

  it("policies take effect: ltlAvailable / gtlAvailable / canPublicNote", async () => {
    assert.equal((await f.call("notes/local-timeline", {}, "c")).status, 200);
    await f.setPolicy(f.ids.c, "ltlAvailable", false);
    await f.setPolicy(f.ids.c, "gtlAvailable", false);
    assert.equal(E(await f.call("notes/local-timeline", {}, "c")), "45a6eb02-7695-4393-b023-dd3be9aaaefd");
    assert.equal(E(await f.call("notes/hybrid-timeline", {}, "c")), "620763f4-f621-4533-ab33-0577a1a3c342");
    assert.equal(E(await f.call("notes/global-timeline", {}, "c")), "0332fc13-6ab2-4427-ae80-a9fadffd1a6b");
    assert.equal((await f.call("notes/local-timeline", {}, "b")).status, 200);
    assert.equal((await f.call("notes/local-timeline", {})).status, 200); // anonymous: base policies
    await f.setPolicy(f.ids.c, "canPublicNote", false);
    assert.equal((await f.call("notes/create", { text: "silenced" }, "c")).data.createdNote.visibility, "home");
    assert.equal((await f.call("notes/create", { text: "followers", visibility: "followers" }, "c")).data.createdNote.visibility, "followers");
    assert.equal((await f.call("notes/create", { text: "free" }, "b")).data.createdNote.visibility, "public");
    assert.equal((await f.call("admin/show-user", { userId: f.ids.c }, "a")).data.isSilenced, true);
  });

  it("conditional roles: evaluated per request for policies, roles, badgeRoles, moderator", async () => {
    const cats = (await f.call("admin/roles/create", {
      ...base, name: "Cats", isModerator: false, isPublic: true, asBadge: true, target: "conditional",
      condFormula: { type: "and", values: [{ type: "isLocal" }, { type: "isCat" }] },
      policies: { canSearchNotes: { useDefault: false, priority: 0, value: true } },
    }, "a")).data.id;
    assert.equal(E(await f.call("notes/search", { query: "x" }, "b")), "0b44998d-77aa-4427-80d0-d2c9b8523011");
    assert.ok(!(await f.call("users/show", { userId: f.ids.b }, "c")).data.roles.some((r: any) => r.id === cats));
    await f.db.query(`UPDATE "user" SET "isCat" = true WHERE id = $1`, [f.ids.b]);
    assert.equal((await f.call("notes/search", { query: "x" }, "b")).status, 200);
    const shown = (await f.call("users/show", { userId: f.ids.b }, "c")).data;
    assert.deepEqual(shown.roles.map((r: any) => r.name), ["Cats"]); // the assigned "Mods" role is not public
    assert.deepEqual(shown.badgeRoles, [{ name: "Cats", iconUrl: null, displayOrder: 0 }]);
    assert.ok((await f.call("admin/show-user", { userId: f.ids.b }, "a")).data.roles.some((r: any) => r.id === cats));
    assert.equal((await f.call("i", {}, "b")).data.policies.canSearchNotes, true);
    // usersCount / roles/users only count assignments (upstream)
    assert.equal((await f.call("admin/roles/show", { roleId: cats }, "a")).data.usersCount, 0);

    // a conditional moderator role: "not assigned to Cats-free role X" style formulas with roleAssignedTo / not
    const flag = (await f.call("admin/roles/create", { ...base, name: "Flag", isModerator: false }, "a")).data.id;
    await f.call("admin/roles/create", {
      ...base, name: "Flagged mods", target: "conditional", condFormula: { type: "roleAssignedTo", roleId: flag },
    }, "a");
    assert.equal((await f.call("admin/roles/list", {}, "c")).status, 403);
    await f.call("admin/roles/assign", { roleId: flag, userId: f.ids.c }, "a");
    assert.equal((await f.call("admin/roles/list", {}, "c")).status, 200);
    await f.call("admin/roles/unassign", { roleId: flag, userId: f.ids.c }, "a");
    assert.equal((await f.call("admin/roles/list", {}, "c")).status, 403);
  });

  it("evalCond (upstream RoleService.evalCond)", async () => {
    const { evalCond } = await import("./policies-pg.js");
    const { genAidx } = await import("../../id/src/index.js");
    const now = Date.now();
    const u = { id: genAidx(now - 3600_000), host: null, isSuspended: false, isLocked: true, isBot: false, isCat: false, isExplorable: true, followersCount: 10, followingCount: 3, notesCount: 0 };
    assert.equal(evalCond(u, [], { type: "isLocal" }, now), true);
    assert.equal(evalCond(u, [], { type: "isRemote" }, now), false);
    assert.equal(evalCond(u, [], { type: "isLocked" }, now), true);
    assert.equal(evalCond(u, [], { type: "createdLessThan", sec: 7200 }, now), true);
    assert.equal(evalCond(u, [], { type: "createdMoreThan", sec: 7200 }, now), false);
    assert.equal(evalCond(u, [], { type: "followersMoreThanOrEq", value: 10 }, now), true);
    assert.equal(evalCond(u, [], { type: "followingLessThanOrEq", value: 2 }, now), false);
    assert.equal(evalCond(u, [], { type: "notesLessThanOrEq", value: 0 }, now), true);
    assert.equal(evalCond(u, ["r1"], { type: "or", values: [{ type: "isBot" }, { type: "roleAssignedTo", roleId: "r1" }] }, now), true);
    assert.equal(evalCond(u, [], { type: "not", value: { type: "isExplorable" } }, now), false);
    assert.equal(evalCond(u, [], { type: "and" } as never, now), false); // malformed → throws → false (upstream)
    assert.equal(evalCond(u, [], { type: "bogus" }, now), false);
    assert.equal(evalCond(u, [], {}, now), false);
  });
});

describe("roles/notes from the TimelineShard role:{id}", () => {
  const inst = new Map<string, TimelineShard>();
  const shard = {
    idFromName: (n: string) => ({ toString: () => n }),
    get(id: { toString(): string }) {
      const name = id.toString();
      if (!inst.has(name)) {
        inst.set(name, new TimelineShard({ id: { toString: () => name }, storage: testDoStorage() }));
      }
      return rpcStub(inst.get(name)!);
    },
  };
  let g: Fixture;
  before(async () => {
    g = await makeFixture("RoleTlTest", { TIMELINE_SHARD: shard as unknown as ApiEnv["TIMELINE_SHARD"] });
  });

  it("reads the DO ids (public notes only), not the member query", async () => {
    // inserted directly: the root id is cached per isolate from the first fixture
    const role = "rolePub";
    await g.db.query(`INSERT INTO role (id, name, description, "isPublic", "isExplorable", "updatedAt", "lastUsedAt") VALUES ($1, 'Pub', '', true, true, now(), now())`, [role]);
    const pub = await g.note(g.ids.b, { text: "public" });
    const home = await g.note(g.ids.b, { text: "home", visibility: "home" });
    await g.note(g.ids.b, { text: "not in the timeline" });
    for (const id of [pub, home]) {
      await shard.get(shard.idFromName(timelineDoId(`role:${role}`))).append(id, 1000);
    }
    const rn = await g.call("roles/notes", { roleId: role }, "c");
    assert.equal(rn.status, 200, JSON.stringify(rn.data));
    assert.deepEqual(rn.data.map((x: any) => x.id), [pub]);
    assert.deepEqual((await g.call("roles/notes", { roleId: role, untilId: pub }, "c")).data, []);
  });
});

