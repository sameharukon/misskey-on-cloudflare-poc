/**
 * Antennas on PG (PGlite): CRUD + validation + limit, list ownership, antennas/notes reading the
 * TimelineShard `antenna:{id}` (real DO class over in-memory storage) with visibility filtering,
 * and remove-note.
 */
import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { TimelineShard } from "../../timeline/src/index.js";
import { timelineDoId } from "../../shared/src/index.js";
import { IMPLEMENTED_ENDPOINTS } from "./registry.js";
import { makeFixture, type Fixture } from "./pglite-fixture.js";
import type { ApiEnv } from "./env.js";
import { testDoStorage } from "../../shared/src/test-do-storage.js";
import { ENDPOINT_PARAM_DEFS } from "./endpoint-params.gen.js";
import { rpcStub } from "../../shared/src/testing/do-namespace.js";

function fakeTimelineShard() {
  const inst = new Map<string, TimelineShard>();
  return {
    idFromName: (n: string) => ({ toString: () => n }),
    get(id: { toString(): string }) {
      const name = id.toString();
      if (!inst.has(name)) {
        inst.set(name, new TimelineShard({ id: { toString: () => name }, storage: testDoStorage() }));
      }
      return rpcStub(inst.get(name)!);
    },
  };
}

let f: Fixture;
const shard = fakeTimelineShard();
before(async () => {
  f = await makeFixture("AntennaTest", { TIMELINE_SHARD: shard as unknown as ApiEnv["TIMELINE_SHARD"] });
});

const E = (r: { data: any }) => r.data?.error?.id;
const base = { name: "cats", src: "all", keywords: [["cat"]], excludeKeywords: [], users: [], caseSensitive: false, withReplies: false, withFile: false };

async function append(antennaId: string, noteId: string) {
  await shard.get(shard.idFromName(timelineDoId(`antenna:${antennaId}`))).append(noteId, 200);
}

describe("antennas", () => {
  let an = "";

  it("registers endpoints", () => {
    for (const e of ["antennas/create", "antennas/update", "antennas/delete", "antennas/list", "antennas/show", "antennas/notes", "antennas/remove-note"]) {
      assert.ok((IMPLEMENTED_ENDPOINTS as readonly string[]).includes(e), e);
      assert.ok(ENDPOINT_PARAM_DEFS[e], e);
    }
  });

  it("create / show / list / update / validation / limit", async () => {
    const r = await f.call("antennas/create", base, "a");
    assert.equal(r.status, 200, JSON.stringify(r.data));
    an = r.data.id;
    assert.deepEqual(Object.keys(r.data).sort(), ["caseSensitive", "createdAt", "excludeBots", "excludeKeywords", "excludeNotesInSensitiveChannel", "hasUnreadNote", "id", "isActive", "keywords", "localOnly", "name", "notify", "src", "userListId", "users", "withFile", "withReplies"]);
    assert.deepEqual(r.data.keywords, [["cat"]]);
    assert.equal(r.data.isActive, true);
    assert.equal(r.data.localOnly, false);
    assert.equal((await f.call("antennas/create", { ...base, src: "nope" }, "a")).status, 400);
    assert.equal((await f.call("antennas/create", { name: "x" }, "a")).status, 400);
    assert.equal(E(await f.call("antennas/create", { ...base, keywords: [[""]], excludeKeywords: [] }, "a")), "53ee222e-1ddd-4f9a-92e5-9fb82ddb463a");
    assert.equal(E(await f.call("antennas/create", { ...base, src: "list", userListId: "nope" }, "a")), "95063e93-a283-4b8b-9aa5-bcdb8df69a7f");
    assert.equal((await f.call("antennas/create", base)).status, 401);
    assert.equal((await f.call("antennas/show", { antennaId: an }, "a")).data.name, "cats");
    assert.equal(E(await f.call("antennas/show", { antennaId: an }, "b")), "c06569fb-b025-4f23-b22d-1fcd20d2816b");
    assert.deepEqual((await f.call("antennas/list", {}, "a")).data.map((x: any) => x.id), [an]);
    assert.deepEqual((await f.call("antennas/list", {}, "b")).data, []);
    // update: list source needs an own list
    const list = (await f.call("users/lists/create", { name: "l" }, "a")).data.id;
    const u = await f.call("antennas/update", { antennaId: an, src: "list", userListId: list, keywords: [["dog"]], localOnly: true }, "a");
    assert.equal(u.status, 200, JSON.stringify(u.data));
    assert.equal(u.data.src, "list");
    assert.equal(u.data.userListId, list);
    assert.deepEqual(u.data.keywords, [["dog"]]);
    assert.equal(u.data.localOnly, true);
    assert.equal(u.data.name, "cats");
    const other = (await f.call("users/lists/create", { name: "b's" }, "b")).data.id;
    assert.equal(E(await f.call("antennas/update", { antennaId: an, userListId: other }, "a")), "1c6b35c9-943e-48c2-81e4-2844989407f7");
    assert.equal(E(await f.call("antennas/update", { antennaId: an, keywords: [], excludeKeywords: [[""]] }, "a")), "721aaff6-4e1b-4d88-8de6-877fae9f68c4");
    assert.equal(E(await f.call("antennas/update", { antennaId: an, name: "x" }, "b")), "10c673ac-8852-48eb-aa1f-f5b67f069290");
    // userListId: null clears it
    assert.equal((await f.call("antennas/update", { antennaId: an, src: "all", userListId: null }, "a")).data.userListId, null);
    // antennaLimit
    await f.setPolicy(f.ids.b, "antennaLimit", 1);
    assert.equal((await f.call("antennas/create", base, "b")).status, 200);
    assert.equal(E(await f.call("antennas/create", base, "b")), "faf47050-e8b5-438c-913c-db2b1576fde4");
  });

  it("antennas/notes: ids from the antenna timeline, visibility, pagination, re-activation, remove-note", async () => {
    const { a, b, c } = f.ids;
    const n1 = await f.note(b, { text: "cat 1" });
    const n2 = await f.note(c, { text: "cat 2 (followers)", visibility: "followers" });
    const n3 = await f.note(b, { text: "cat 3" });
    for (const n of [n1, n2, n3]) await append(an, n);
    assert.equal(E(await f.call("antennas/notes", { antennaId: an }, "b")), "850926e0-fd3b-49b6-b69a-b28a5dbd82fe");
    await f.db.query(`UPDATE antenna SET "isActive" = FALSE WHERE id = $1`, [an]);
    const ids = async (body: Record<string, unknown> = {}) => (await f.call("antennas/notes", { antennaId: an, ...body }, "a")).data.map((n: any) => n.id);
    assert.deepEqual(await ids(), [n3, n1]); // followers-only note from a non-followee is hidden
    assert.equal((await f.call("antennas/show", { antennaId: an }, "a")).data.isActive, true);
    await f.db.query(`INSERT INTO following (id, "followerId", "followeeId") VALUES ('fo', $1, $2)`, [a, c]);
    assert.deepEqual(await ids(), [n3, n2, n1]);
    assert.deepEqual(await ids({ limit: 1 }), [n3]);
    assert.deepEqual(await ids({ untilId: n3 }), [n2, n1]);
    assert.deepEqual(await ids({ sinceId: n1 }), [n2, n3]);
    await f.db.query(`INSERT INTO muting (id, "muterId", "muteeId") VALUES ('mu', $1, $2)`, [a, b]);
    assert.deepEqual(await ids(), [n2]);
    await f.db.query(`DELETE FROM muting`);
    assert.equal((await f.call("antennas/remove-note", { antennaId: an, noteId: n3 }, "a")).status, 204);
    assert.deepEqual(await ids(), [n2, n1]);
    assert.equal(E(await f.call("antennas/remove-note", { antennaId: an, noteId: n1 }, "b")), "850926e0-fd3b-49b6-b69a-b28a5dbd82fe");
  });

  it("delete", async () => {
    assert.equal(E(await f.call("antennas/delete", { antennaId: an }, "b")), "b34dcf9d-348f-44bb-99d0-6c9314cfe2df");
    assert.equal((await f.call("antennas/delete", { antennaId: an }, "a")).status, 204);
    assert.deepEqual((await f.call("antennas/list", {}, "a")).data, []);
  });
});
