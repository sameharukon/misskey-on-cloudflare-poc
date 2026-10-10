/**
 * noteUpdated publishing on PG (PGlite): reactions / unreactions / deletion / poll votes reach
 * the users NoteWatch lists (real class), filtered by visibility like upstream
 * Connection.onNoteStreamMessage (followers-only → author + followers, specified → recipients).
 */
import { before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { NoteWatch, noteWatchShard } from "../../stream/src/index.js";
import { makeFixture, type Fixture } from "./pglite-fixture.js";
import { publishNoteUpdated } from "./note-stream.js";
import type { ApiEnv } from "./env.js";
import { rpcStub, recordingHubNamespace } from "../../shared/src/testing/do-namespace.js";

const watchInst = new Map<string, NoteWatch>();
const watch = {
  idFromName: (n: string) => ({ toString: () => n }),
  get(id: { toString(): string }) {
    const k = id.toString();
    if (!watchInst.has(k)) {
      const m = new Map<string, unknown>();
      watchInst.set(k, new NoteWatch({ storage: { get: async (x: string) => m.get(x) as any, put: async (x: string, v: unknown) => void m.set(x, v), delete: async (x: string) => m.delete(x) } }));
    }
    return rpcStub(watchInst.get(k)!);
  },
};
const hubCalls: { userId: string; path: string; body: any }[] = [];
const hub = recordingHubNamespace((userId, path, body) => hubCalls.push({ userId, path, body }));

let f: Fixture;
before(async () => {
  f = await makeFixture("NoteStreamTest", { NOTE_WATCH: watch as unknown as ApiEnv["NOTE_WATCH"], STREAM_HUB: hub as unknown as ApiEnv["STREAM_HUB"], STREAM_SHARD_COUNT: "4" });
});
beforeEach(() => void (hubCalls.length = 0));

async function capture(userId: string, noteId: string) {
  await watch.get(watch.idFromName(noteWatchShard(noteId, 4))).set(userId, [noteId], []);
}
const updates = () => hubCalls.filter((c) => c.path === "/noteUpdated").map((c) => [c.userId, c.body.type]);

describe("noteUpdated", () => {
  it("reacted / unreacted to everyone capturing a public note", async () => {
    const n = await f.note(f.ids.b, { text: "hi" });
    await capture(f.ids.a, n);
    await capture(f.ids.c, n);
    assert.ok((await f.call("notes/reactions/create", { noteId: n, reaction: "👍" }, "c")).status < 300);
    assert.deepEqual(updates().sort(), [[f.ids.a, "reacted"], [f.ids.c, "reacted"]].sort());
    assert.deepEqual(hubCalls[0]!.body, { id: n, type: "reacted", body: { reaction: "👍", emoji: null, userId: f.ids.c } });
    hubCalls.length = 0;
    assert.ok((await f.call("notes/reactions/delete", { noteId: n }, "c")).status < 300);
    assert.deepEqual(hubCalls.map((c) => c.body.body).at(0), { reaction: "👍", userId: f.ids.c });
  });

  it("visibility: followers-only and specified notes", async () => {
    const fo = await f.note(f.ids.b, { text: "followers", visibility: "followers" });
    for (const u of [f.ids.a, f.ids.b, f.ids.c]) await capture(u, fo);
    await f.db.query(`INSERT INTO following (id, "followerId", "followeeId") VALUES ('nsf1', $1, $2)`, [f.ids.c, f.ids.b]);
    await publishNoteUpdated(f.env, { id: fo, userId: f.ids.b, visibility: "followers" }, "pollVoted", { choice: 0, userId: f.ids.c });
    assert.deepEqual(updates().map((x) => x[0]).sort(), [f.ids.b, f.ids.c].sort());
    hubCalls.length = 0;
    const sp = await f.note(f.ids.b, { text: "dm", visibility: "specified", visibleUserIds: [f.ids.a] });
    for (const u of [f.ids.a, f.ids.b, f.ids.c]) await capture(u, sp);
    await publishNoteUpdated(f.env, { id: sp, userId: f.ids.b, visibility: "specified", visibleUserIds: [f.ids.a] }, "deleted", {});
    assert.deepEqual(updates().map((x) => x[0]).sort(), [f.ids.a, f.ids.b].sort());
  });

  it("deleted on notes/delete; nobody capturing → no hub calls", async () => {
    const n = await f.note(f.ids.b, { text: "bye" });
    await capture(f.ids.a, n);
    assert.ok((await f.call("notes/delete", { noteId: n }, "b")).status < 300);
    const d = hubCalls.find((c) => c.path === "/noteUpdated");
    assert.equal(d?.userId, f.ids.a);
    assert.equal(d?.body.type, "deleted");
    assert.ok(typeof d?.body.body.deletedAt === "string");
    hubCalls.length = 0;
    const quiet = await f.note(f.ids.b, { text: "quiet" });
    await f.call("notes/reactions/create", { noteId: quiet, reaction: "👍" }, "c");
    assert.deepEqual(updates(), []);
  });
});
