/**
 * Data imports on PG (PGlite): i/import-following|muting|blocking|user-lists|antennas with the
 * upstream line handling (known users only, self / host-less / unknown lines skipped), endpoint
 * checks (own file, empty, 64 KiB, canImport* policy, antennaLimit), and the mk-jobs path.
 */
import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { IMPLEMENTED_ENDPOINTS } from "./registry.js";
import { makeFixture, type Fixture } from "./pglite-fixture.js";
import type { ApiEnv } from "./env.js";
import { ENDPOINT_PARAM_DEFS } from "./endpoint-params.gen.js";

const objects = new Map<string, Uint8Array>();
const bucket = {
  get: async (key: string) => (objects.has(key) ? { arrayBuffer: async () => objects.get(key)!.slice().buffer } : null),
  put: async (key: string, v: Uint8Array) => void objects.set(key, v),
  delete: async () => {},
};

let f: Fixture;
let seq = 0;
before(async () => {
  f = await makeFixture("ImportTest", { MEDIA_BUCKET: bucket as unknown as ApiEnv["MEDIA_BUCKET"] });
  // (fetched recently: RemoteUserResolveService returns it without a WebFinger resync)
  await f.db.query(`INSERT INTO "user" (id, username, "usernameLower", host, "lastFetchedAt") VALUES ('r1', 'Remote', 'remote', 'remote.example', now())`);
  // canImport* are off by default (upstream DEFAULT_POLICIES)
  for (const k of ["canImportFollowing", "canImportMuting", "canImportBlocking", "canImportUserLists", "canImportAntennas"]) await f.setPolicy(f.ids.b, k, true);
});

/** Put `text` in `owner`'s drive and return the file id. */
async function file(text: string, owner = f.ids.b): Promise<string> {
  const id = `file${seq++}`;
  const bytes = new TextEncoder().encode(text);
  objects.set(`drive/key-${id}`, bytes);
  await f.db.query(`INSERT INTO drive_file (id, "userId", type, name, size, url, "accessKey", md5, "storedInternal") VALUES ($1, $2, 'text/csv', 'x.csv', $3, 'u', $4, '0', FALSE)`, [id, owner, bytes.byteLength, `key-${id}`]);
  return id;
}

const E = (r: { data: any }) => r.data?.error?.id;
const rows = async (sql: string, p: unknown[] = []) => (await f.db.query(sql, p)).rows as any[];

describe("imports", () => {
  it("registers endpoints", () => {
    for (const e of ["i/import-following", "i/import-muting", "i/import-blocking", "i/import-user-lists", "i/import-antennas"]) {
      assert.ok((IMPLEMENTED_ENDPOINTS as readonly string[]).includes(e), e);
      assert.ok(ENDPOINT_PARAM_DEFS[e], e);
    }
  });

  it("endpoint checks: own file, empty, too big, policy", async () => {
    assert.equal(E(await f.call("i/import-following", { fileId: await file("x", f.ids.c) }, "b")), "b98644cf-a5ac-4277-a502-0b8054a709a3");
    assert.equal(E(await f.call("i/import-muting", { fileId: await file("") }, "b")), "d2f12af1-e7b4-feac-86a3-519548f2728e");
    assert.equal(E(await f.call("i/import-blocking", { fileId: await file("a".repeat(64 * 1024 + 1)) }, "b")), "b7fbf0b1-aeef-3b21-29ef-fadd4cb72ccf");
    assert.equal((await f.call("i/import-following", {}, "b")).status, 400);
    const r = await f.call("i/import-muting", { fileId: await file("x", f.ids.c) }, "c"); // c has no canImportMuting
    assert.equal(r.status, 403);
    assert.equal(E(r), "7f86f06f-7e15-4057-8561-f4b6d4ac755a");
  });

  it("following: per-line withReplies (index 2), self / unknown / host-less skipped", async () => {
    const csv = ["user_c@misskey.example.com,withReplies=true", "Remote@remote.example", "ghost@nowhere.example", "user_b@misskey.example.com", "nohost", ""].join("\n");
    assert.equal((await f.call("i/import-following", { fileId: await file(csv) }, "b")).status, 204);
    // upstream reads key=value pairs from index 2, so `acct,withReplies=true` falls back to the job's withReplies (false)
    assert.deepEqual(await rows(`SELECT "followeeId", "withReplies" FROM following WHERE "followerId" = $1`, [f.ids.b]), [{ followeeId: f.ids.c, withReplies: false }]);
    // remote followees go through a follow request (as following/create)
    assert.deepEqual((await rows(`SELECT "followeeId" FROM follow_request WHERE "followerId" = $1`, [f.ids.b])).map((x) => x.followeeId), ["r1"]);
  });

  it("muting / blocking", async () => {
    await f.call("i/import-muting", { fileId: await file("Remote@remote.example\nuser_a@misskey.example.com\n") }, "b");
    assert.deepEqual((await rows(`SELECT "muteeId" FROM muting WHERE "muterId" = $1 ORDER BY "muteeId"`, [f.ids.b])).map((x) => x.muteeId).sort(), [f.ids.a, "r1"].sort());
    await f.call("i/import-blocking", { fileId: await file("user_c@misskey.example.com\n") }, "b");
    assert.equal((await rows(`SELECT 1 FROM blocking WHERE "blockerId" = $1 AND "blockeeId" = $2`, [f.ids.b, f.ids.c])).length, 1);
    // blocking removed b's follow of c
    assert.equal((await rows(`SELECT 1 FROM following WHERE "followerId" = $1 AND "followeeId" = $2`, [f.ids.b, f.ids.c])).length, 0);
  });

  it("user-lists: lists created by name, members added once", async () => {
    const csv = "friends,user_a@misskey.example.com,withReplies=true\nfriends,user_a@misskey.example.com\nwork,Remote@remote.example\nwork,ghost@nowhere.example\n";
    await f.call("i/import-user-lists", { fileId: await file(csv) }, "b");
    const lists = await rows(
      `SELECT l.name, m."userId", m."withReplies" FROM user_list l JOIN user_list_membership m ON m."userListId" = l.id WHERE l."userId" = $1 ORDER BY l.name`,
      [f.ids.b],
    );
    assert.deepEqual(lists, [{ name: "friends", userId: f.ids.a, withReplies: true }, { name: "work", userId: "r1", withReplies: false }]);
  });

  it("antennas: valid ones created, list sources become users, antennaLimit", async () => {
    const base = { name: "cats", src: "all", keywords: [["cat"]], excludeKeywords: [], users: [], caseSensitive: false, withReplies: false, withFile: false };
    const json = JSON.stringify([
      base,
      { ...base, name: "from list", src: "list", userListAccts: ["@x@remote.example"] },
      { ...base, name: "empty", keywords: [[""]] },
      { ...base, name: "bad", src: "nope" },
    ]);
    assert.equal((await f.call("i/import-antennas", { fileId: await file(json) }, "b")).status, 204);
    const got = await rows(`SELECT name, src, users FROM antenna WHERE "userId" = $1 ORDER BY name`, [f.ids.b]);
    assert.deepEqual(got, [{ name: "cats", src: "all", users: [] }, { name: "from list", src: "users", users: ["@x@remote.example"] }]);
    // 2 existing + 4 in the file ≥ antennaLimit (5)
    assert.equal(E(await f.call("i/import-antennas", { fileId: await file(json) }, "b")), "600917d4-a4cb-4cc5-8ba8-7ac8ea3c7779");
    assert.equal(E(await f.call("i/import-antennas", { fileId: await file("") }, "b")), "7f60115d-8d93-4b0f-bd0e-3815dcbb389f");
  });

  it("through mk-jobs", async () => {
    const queued: any[] = [];
    const env = { ...f.env, Q_JOBS: { send: async (m: unknown) => void queued.push(m) } } as ApiEnv;
    const { handlers } = await import("./endpoints/index.js");
    const fileId = await file("Remote@remote.example\n", f.ids.a);
    await f.setPolicy(f.ids.a, "canImportBlocking", false); // root passes requiredRolePolicy anyway
    const r = await handlers["i/import-blocking"]!(env, { i: "aaaaaaaaaaaaaaaa", fileId }, { hasCredential: true, request: new Request("https://api.test/api/i/import-blocking", { method: "POST" }) });
    assert.equal((r as Response).status, 204);
    assert.deepEqual(queued, [{ kind: "import", entity: "blocking", userId: f.ids.a, fileId }]);
    assert.equal((await rows(`SELECT 1 FROM blocking WHERE "blockerId" = $1`, [f.ids.a])).length, 0);
    const { handleApQueueBatch } = await import("./index.js");
    await handleApQueueBatch({ queue: "mk-jobs", messages: [{ body: queued[0], ack: () => {}, retry: () => assert.fail("retry") }] }, env);
    assert.equal((await rows(`SELECT 1 FROM blocking WHERE "blockerId" = $1 AND "blockeeId" = 'r1'`, [f.ids.a])).length, 1);
  });
});
