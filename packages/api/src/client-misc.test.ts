/**
 * Smaller client endpoints on PG (PGlite): thread muting, users/achievements|featured-notes|
 * flashs|reactions|update-memo (+ memo in users/show), following/update|update-all|invalidate
 * (+ notify / withReplies in users/show), username/available, stats.
 */
import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { genAidx } from "../../id/src/index.js";
import { IMPLEMENTED_ENDPOINTS } from "./registry.js";
import { makeFixture, type Fixture } from "./pglite-fixture.js";
import { ENDPOINT_PARAM_DEFS } from "./endpoint-params.gen.js";

let f: Fixture;
before(async () => {
  f = await makeFixture("ClientMiscTest");
});

const E = (r: { data: any }) => r.data?.error?.id;
const rows = async (sql: string, p: unknown[] = []) => (await f.db.query(sql, p)).rows as any[];
let seq = 0;
const react = (userId: string, noteId: string, reaction = "👍") =>
  f.db.query(`INSERT INTO note_reaction (id, "userId", "noteId", reaction) VALUES ($1, $2, $3, $4)`, [genAidx(Date.now() + seq++), userId, noteId, reaction]);

describe("client misc", () => {
  it("registers endpoints", () => {
    for (const e of ["notes/thread-muting/create", "notes/thread-muting/delete", "users/achievements", "users/featured-notes", "users/flashs", "users/reactions", "users/update-memo", "following/update", "following/update-all", "following/invalidate", "username/available", "stats"]) {
      assert.ok((IMPLEMENTED_ENDPOINTS as readonly string[]).includes(e), e);
      assert.ok(ENDPOINT_PARAM_DEFS[e], e);
    }
  });

  it("thread muting (by thread root)", async () => {
    const root = await f.note(f.ids.b, { text: "root" });
    const reply = await f.note(f.ids.c, { text: "re", replyId: root, threadId: root });
    assert.ok((await f.call("notes/thread-muting/create", { noteId: reply }, "a")).status < 300);
    assert.deepEqual((await rows(`SELECT "threadId" FROM note_thread_muting WHERE "userId" = $1`, [f.ids.a])).map((r) => r.threadId), [root]);
    assert.equal(E(await f.call("notes/thread-muting/create", { noteId: root }, "a")), "c146e22d-1141-4b31-b28d-176371014d18");
    assert.equal((await f.call("notes/state", { noteId: reply }, "a")).data.isMutedThread, true);
    assert.ok((await f.call("notes/thread-muting/delete", { noteId: root }, "a")).status < 300);
    assert.equal(E(await f.call("notes/thread-muting/delete", { noteId: "nope" }, "a")), "bddd57ac-ceb3-b29d-4334-86ea5fae481a");
  });

  it("users/achievements / featured-notes / reactions", async () => {
    await f.db.query(`UPDATE user_profile SET achievements = '[{"name":"notes1","unlockedAt":1}]' WHERE "userId" = $1`, [f.ids.b]);
    assert.deepEqual((await f.call("users/achievements", { userId: f.ids.b })).data, [{ name: "notes1", unlockedAt: 1 }]);
    const hot = await f.note(f.ids.b, { text: "hot" });
    const warm = await f.note(f.ids.b, { text: "warm" });
    const priv = await f.note(f.ids.b, { text: "followers", visibility: "followers" });
    await react(f.ids.a, hot);
    await react(f.ids.c, hot);
    await react(f.ids.c, warm, ":blobcat:");
    await react(f.ids.c, priv);
    // ranked notes, returned newest first (upstream sorts the ranked ids)
    assert.deepEqual((await f.call("users/featured-notes", { userId: f.ids.b })).data.map((n: any) => n.id), [warm, hot]);
    assert.deepEqual((await f.call("users/featured-notes", { userId: f.ids.b, untilId: warm })).data.map((n: any) => n.id), [hot]);
    // reactions of c: public by default; followers-only note hidden from a non-follower
    const r = (await f.call("users/reactions", { userId: f.ids.c }, "a")).data;
    assert.deepEqual(r.map((x: any) => [x.note.id, x.type]), [[warm, ":blobcat@.:"], [hot, "👍"]]);
    assert.equal(r[0].user.id, f.ids.c);
    await f.db.query(`UPDATE user_profile SET "publicReactions" = FALSE WHERE "userId" = $1`, [f.ids.c]);
    assert.equal(E(await f.call("users/reactions", { userId: f.ids.c }, "b")), "673a7dd2-6924-1093-e0c0-e68456ceae5c");
    assert.equal((await f.call("users/reactions", { userId: f.ids.c }, "c")).data.length, 2); // yourself: private ok, but visibility still applies (c does not follow b)
    assert.equal((await f.call("users/reactions", { userId: f.ids.c }, "a")).status, 200); // root moderates
  });

  it("users/update-memo → users/show memo", async () => {
    assert.equal(E(await f.call("users/update-memo", { userId: "nope", memo: "x" }, "a")), "6fef56f3-e765-4957-88e5-c6f65329b8a5");
    assert.ok((await f.call("users/update-memo", { userId: f.ids.b, memo: "met at a meetup" }, "a")).status < 300);
    assert.equal((await f.call("users/show", { userId: f.ids.b }, "a")).data.memo, "met at a meetup");
    assert.equal((await f.call("users/show", { userId: f.ids.b }, "c")).data.memo, null);
    await f.call("users/update-memo", { userId: f.ids.b, memo: "edited" }, "a");
    assert.equal((await f.call("users/show", { userId: f.ids.b }, "a")).data.memo, "edited");
    await f.call("users/update-memo", { userId: f.ids.b, memo: "" }, "a");
    assert.equal((await rows(`SELECT 1 FROM user_memo`)).length, 0);
  });

  it("following/update / update-all / invalidate", async () => {
    await f.db.query(`INSERT INTO following (id, "followerId", "followeeId") VALUES ('fu1', $1, $2), ('fu2', $1, $3), ('fu3', $3, $1)`, [f.ids.a, f.ids.b, f.ids.c]);
    assert.equal(E(await f.call("following/update", { userId: f.ids.a, notify: "normal" }, "a")), "4c4cbaf9-962a-463b-8418-a5e365dbf2eb");
    assert.equal(E(await f.call("following/update", { userId: f.ids.b, notify: "normal" }, "c")), "b8dc75cf-1cb5-46c9-b14b-5f1ffbd782c9");
    const u = await f.call("following/update", { userId: f.ids.b, notify: "normal", withReplies: true }, "a");
    assert.equal(u.data.id, f.ids.a); // upstream returns the follower
    const shown = (await f.call("users/show", { userId: f.ids.b }, "a")).data;
    assert.deepEqual([shown.notify, shown.withReplies], ["normal", true]);
    assert.ok((await f.call("following/update-all", { notify: "none", withReplies: false }, "a")).status < 300);
    assert.deepEqual((await rows(`SELECT notify, "withReplies" FROM following WHERE "followerId" = $1`, [f.ids.a])).map((r) => [r.notify, r.withReplies]), [[null, false], [null, false]]);
    // c follows a; a removes that follower
    assert.equal(E(await f.call("following/invalidate", { userId: f.ids.b }, "a")), "918faac3-074f-41ae-9c43-ed5d2946770d");
    assert.equal((await f.call("following/invalidate", { userId: f.ids.c }, "a")).data.id, f.ids.c);
    assert.equal((await rows(`SELECT 1 FROM following WHERE "followerId" = $1 AND "followeeId" = $2`, [f.ids.c, f.ids.a])).length, 0);
  });

  it("username/available / stats", async () => {
    assert.deepEqual((await f.call("username/available", { username: "USER_A" })).data, { available: false });
    assert.deepEqual((await f.call("username/available", { username: "newbie" })).data, { available: true });
    await f.db.query(`INSERT INTO used_username (username, "createdAt") VALUES ('gone', now())`);
    assert.deepEqual((await f.call("username/available", { username: "gone" })).data, { available: false });
    assert.equal((await f.call("username/available", { username: "has space" })).status, 400);
    const s = (await f.call("stats", {})).data;
    assert.deepEqual(Object.keys(s).sort(), ["driveUsageLocal", "driveUsageRemote", "instances", "notesCount", "originalNotesCount", "originalUsersCount", "reactionsCount", "usersCount"]);
    assert.equal(s.originalUsersCount, 3);
    assert.equal(s.reactionsCount, 4);
  });
});
