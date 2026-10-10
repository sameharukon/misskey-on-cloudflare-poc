/**
 * Data exports on PG (PGlite): each i/export-* builds the upstream CSV / JSON into the user's
 * drive (fake R2) and sends exportCompleted (real NotificationBox); following options; the
 * mk-jobs path.
 */
import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { NotificationBox } from "../../timeline/src/index.js";
import { IMPLEMENTED_ENDPOINTS } from "./registry.js";
import { fakeDoNamespace, makeFixture, type Fixture } from "./pglite-fixture.js";
import { handleApQueueBatch } from "./index.js";
import type { ApiEnv } from "./env.js";
import { ENDPOINT_PARAM_DEFS } from "./endpoint-params.gen.js";

const objects = new Map<string, Uint8Array>();
const bucket = {
  put: async (key: string, v: Uint8Array) => void objects.set(key, v),
  delete: async () => {},
};

let f: Fixture;
before(async () => {
  f = await makeFixture("ExportTest", {
    MEDIA_BUCKET: bucket as unknown as ApiEnv["MEDIA_BUCKET"],
    NOTIFICATION_BOX: fakeDoNamespace((s) => new NotificationBox(s as never)) as unknown as ApiEnv["NOTIFICATION_BOX"],
  });
});

/** Run an export for b and return [file row, its text]. */
async function exportOf(endpoint: string, body: Record<string, unknown> = {}): Promise<[any, string]> {
  const r = await f.call(endpoint, body, "b");
  assert.equal(r.status, 204, JSON.stringify(r.data));
  const row = (await f.db.query(`SELECT * FROM drive_file WHERE "userId" = $1 ORDER BY id DESC LIMIT 1`, [f.ids.b])).rows[0] as any;
  const key = `drive/${row.accessKey}`;
  return [row, new TextDecoder().decode(objects.get(key)!)];
}

describe("exports", () => {
  before(async () => {
    await f.db.query(`INSERT INTO "user" (id, username, "usernameLower", host, "updatedAt") VALUES ('r1', 'Remote', 'remote', 'remote.example', now() - interval '200 days')`);
    await f.db.query(`INSERT INTO following (id, "followerId", "followeeId", "withReplies") VALUES ('fo1', $1, $2, true), ('fo2', $1, 'r1', false)`, [f.ids.b, f.ids.c]);
    await f.db.query(`INSERT INTO muting (id, "muterId", "muteeId") VALUES ('mu1', $1, $2), ('mu2', $1, 'r1')`, [f.ids.b, f.ids.c]);
    await f.db.query(`UPDATE muting SET "expiresAt" = now() + interval '1 day' WHERE id = 'mu2'`);
    await f.db.query(`INSERT INTO blocking (id, "blockerId", "blockeeId") VALUES ('bl1', $1, 'r1')`, [f.ids.b]);
    await f.db.query(`INSERT INTO user_list (id, "userId", name) VALUES ('l1', $1, 'friends')`, [f.ids.b]);
    await f.db.query(`INSERT INTO user_list_membership (id, "userId", "userListId", "userListUserId", "withReplies") VALUES ('lm1', $1, 'l1', $2, true)`, [f.ids.c, f.ids.b]);
  });

  it("registers endpoints", () => {
    for (const e of ["i/export-following", "i/export-mute", "i/export-blocking", "i/export-user-lists", "i/export-antennas", "i/export-favorites", "i/export-clips", "i/export-notes"]) {
      assert.ok((IMPLEMENTED_ENDPOINTS as readonly string[]).includes(e), e);
      assert.ok(ENDPOINT_PARAM_DEFS[e], e);
    }
  });

  it("following (+ excludeMuting / excludeInactive), drive file and exportCompleted", async () => {
    const [row, text] = await exportOf("i/export-following");
    assert.equal(text, "user_c@misskey.example.com,withReplies=true\nRemote@remote.example,withReplies=false\n");
    assert.match(row.name, /^following-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.csv$/);
    assert.equal(row.type, "text/csv");
    const n = (await f.call("i/notifications", {}, "b")).data.find((x: any) => x.type === "exportCompleted");
    assert.deepEqual([n.exportedEntity, n.fileId], ["following", row.id]);
    assert.ok(!("user" in n));
    // upstream excludes every mutee, temporary mutes included
    assert.equal((await exportOf("i/export-following", { excludeMuting: true }))[1], "");
    assert.equal((await exportOf("i/export-following", { excludeInactive: true }))[1], "user_c@misskey.example.com,withReplies=true\n");
    assert.equal((await f.call("i/export-following", { excludeMuting: "yes" }, "b")).status, 400);
    // `secure`: anonymous → ACCESS_DENIED (upstream isSecure needs a user)
    assert.equal((await f.call("i/export-following", {})).data.error.id, "56f35758-7dd5-468b-8439-5d6fb8ec9b8e");
  });

  it("mute (permanent only) / blocking / user-lists", async () => {
    assert.equal((await exportOf("i/export-mute"))[1], "user_c@misskey.example.com\n");
    assert.equal((await exportOf("i/export-blocking"))[1], "Remote@remote.example\n");
    assert.equal((await exportOf("i/export-user-lists"))[1], "friends,user_c@misskey.example.com,withReplies=true\n");
  });

  it("antennas / favorites / clips / notes (JSON)", async () => {
    await f.db.query(
      `INSERT INTO antenna (id, "userId", name, src, "userListId", keywords, "excludeKeywords", users, "caseSensitive", "withReplies", "withFile", "isActive", "lastUsedAt")
       VALUES ('an1', $1, 'cats', 'list', 'l1', '[["cat"]]', '[]', '{}', false, false, false, true, now())`,
      [f.ids.b],
    );
    const antennas = JSON.parse((await exportOf("i/export-antennas"))[1]);
    assert.equal(antennas.length, 1);
    assert.deepEqual([antennas[0].name, antennas[0].src, antennas[0].keywords, antennas[0].userListAccts], ["cats", "list", [["cat"]], ["user_c@misskey.example.com"]]);

    const n1 = await f.note(f.ids.c, { text: "fav me", hasPoll: true });
    await f.db.query(`INSERT INTO poll ("noteId", choices, votes, multiple, "noteVisibility", "userId") VALUES ($1, '{a,b}', '{0,1}', false, 'public', $2)`, [n1, f.ids.c]);
    await f.db.query(`INSERT INTO note_favorite (id, "userId", "noteId") VALUES ('fav1', $1, $2)`, [f.ids.b, n1]);
    const favs = JSON.parse((await exportOf("i/export-favorites"))[1]);
    assert.equal(favs[0].id, "fav1");
    assert.equal(favs[0].note.text, "fav me");
    assert.deepEqual(favs[0].note.poll.choices, ["a", "b"]);
    assert.deepEqual(favs[0].note.user, { id: f.ids.c, name: null, username: "user_c", host: null, uri: null });

    const hidden = await f.note(f.ids.c, { text: "secret", visibility: "specified" });
    await f.db.query(`INSERT INTO clip (id, "userId", name, description) VALUES ('cl1', $1, 'mine', 'd')`, [f.ids.b]);
    await f.db.query(`INSERT INTO clip_note (id, "noteId", "clipId") VALUES ('cn1', $1, 'cl1'), ('cn2', $2, 'cl1')`, [n1, hidden]);
    const clips = JSON.parse((await exportOf("i/export-clips"))[1]);
    assert.deepEqual(clips.map((c: any) => [c.name, c.description, c.clipNotes.map((x: any) => x.note.id)]), [["mine", "d", [n1]]]);

    for (let i = 0; i < 105; i++) await f.note(f.ids.b, { text: `n${i}` });
    const [row, text] = await exportOf("i/export-notes");
    const notes = JSON.parse(text);
    assert.equal(notes.length, 105);
    assert.equal(notes[0].text, "n0");
    assert.deepEqual(Object.keys(notes[0]).sort(), ["createdAt", "cw", "fileIds", "files", "id", "localOnly", "poll", "reactionAcceptance", "renoteId", "replyId", "text", "visibility", "visibleUserIds"]);
    assert.equal(row.type, "application/json");
  });

  it("through mk-jobs", async () => {
    const queued: unknown[] = [];
    const env = { ...f.env, Q_JOBS: { send: async (m: unknown) => void queued.push(m) } } as ApiEnv;
    const { handlers } = await import("./endpoints/index.js");
    const r = await handlers["i/export-blocking"]!(env, { i: "bbbbbbbbbbbbbbbb" }, { hasCredential: true, request: new Request("https://api.test/api/i/export-blocking", { method: "POST" }) });
    assert.equal((r as Response).status, 204);
    assert.deepEqual(queued, [{ kind: "export", entity: "blocking", userId: f.ids.b }]);
    const before = Number(((await f.db.query(`SELECT count(*)::int AS n FROM drive_file`)).rows[0] as any).n);
    let acked = 0;
    await handleApQueueBatch({ queue: "mk-jobs", messages: [{ body: queued[0], ack: () => void acked++, retry: () => assert.fail("retry") }] }, env);
    assert.equal(acked, 1);
    assert.equal(Number(((await f.db.query(`SELECT count(*)::int AS n FROM drive_file`)).rows[0] as any).n), before + 1);
  });
});
