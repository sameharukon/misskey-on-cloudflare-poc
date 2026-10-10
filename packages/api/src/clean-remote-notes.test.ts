/**
 * Remote notes cleaning on PG (PGlite): which note trees are deleted (old remote roots with their
 * replies / renotes; trees with a clipped, page, pinned, favorited or locally reacted note are
 * kept), the enable switch, the max duration, the cursor kept in META_CACHE across runs, and the
 * mk-jobs step chain.
 */
import { before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { genAidx } from "../../id/src/index.js";
import { makeFixture, type Fixture } from "./pglite-fixture.js";
import { CURSOR_KEY, runCleanRemoteNotesStep, startCleanRemoteNotes, type CleanRemoteNotesJob } from "./clean-remote-notes-pg.js";
import { runJobStep } from "./jobs.js";

const DAY = 24 * 3600_000;
const kv = new Map<string, string>();
const KV = {
  async get(k: string) { return kv.get(k) ?? null; },
  async put(k: string, v: string) { kv.set(k, v); },
  async delete(k: string) { kv.delete(k); },
};
let f: Fixture;
let remote = "";
let seq = 0;
const noPause = { pause: async () => {} };

before(async () => {
  f = await makeFixture("CleanRemoteNotesTest", { META_CACHE: KV });
  remote = genAidx(Date.now() - 400 * DAY);
  await f.db.query(`INSERT INTO "user" (id, username, "usernameLower", host) VALUES ($1, 'r', 'r', 'remote.example')`, [remote]);
});

/** A note `daysAgo` days old (remote unless `local`). */
async function note(daysAgo: number, o: { local?: boolean; replyId?: string; renoteId?: string } = {}): Promise<string> {
  const id = genAidx(Date.now() - daysAgo * DAY + seq++);
  await f.db.query(`INSERT INTO note (id, "userId", "userHost", "replyId", "renoteId", visibility) VALUES ($1, $2, $3, $4, $5, 'public')`, [
    id, o.local ? f.ids.b : remote, o.local ? null : "remote.example", o.replyId ?? null, o.renoteId ?? null,
  ]);
  return id;
}

const exists = async (id: string) => (await f.db.query(`SELECT 1 FROM note WHERE id = $1`, [id])).rows.length === 1;

async function runAll(job: CleanRemoteNotesJob, opts = {}) {
  let next: CleanRemoteNotesJob | null = job;
  let steps = 0;
  while (next) {
    next = await runCleanRemoteNotesStep(f.env, next, { ...noPause, ...opts });
    steps++;
  }
  return steps;
}

describe("cleanRemoteNotes", () => {
  beforeEach(async () => {
    kv.clear();
    await f.db.query(`DELETE FROM note`);
    await f.db.query(`UPDATE meta SET "enableRemoteNotesCleaning" = TRUE, "remoteNotesCleaningExpiryDaysForEachNotes" = 90, "remoteNotesCleaningMaxProcessingDurationInMinutes" = 60`);
  });

  it("deletes old remote note trees and keeps new, local and protected ones", async () => {
    const oldRoot = await note(200);
    const oldReply = await note(150, { replyId: oldRoot });
    const oldRenote = await note(120, { renoteId: oldRoot });
    const newRemote = await note(10);
    const oldLocal = await note(200, { local: true });
    // a tree with a recent reply is kept as a whole
    const keptRoot = await note(200);
    const keptReply = await note(5, { replyId: keptRoot });
    // a reply by a local user keeps the tree
    const localRepliedRoot = await note(200);
    const localReply = await note(150, { local: true, replyId: localRepliedRoot });
    const clipped = await note(200);
    await f.db.query(`UPDATE note SET "clippedCount" = 1 WHERE id = $1`, [clipped]);
    const inPage = await note(200);
    await f.db.query(`UPDATE note SET "pageCount" = 1 WHERE id = $1`, [inPage]);
    const pinned = await note(200);
    await f.db.query(`INSERT INTO user_note_pining (id, "userId", "noteId") VALUES ($1, $2, $3)`, [genAidx(Date.now()), remote, pinned]);
    const favorited = await note(200);
    await f.db.query(`INSERT INTO note_favorite (id, "userId", "noteId") VALUES ($1, $2, $3)`, [genAidx(Date.now()), f.ids.c, favorited]);
    const reacted = await note(200);
    await f.db.query(`INSERT INTO note_reaction (id, "userId", "noteId", reaction) VALUES ($1, $2, $3, '👍')`, [genAidx(Date.now()), f.ids.c, reacted]);
    const remoteReacted = await note(200);
    await f.db.query(`INSERT INTO note_reaction (id, "userId", "noteId", reaction) VALUES ($1, $2, $3, '👍')`, [genAidx(Date.now()), remote, remoteReacted]);

    await runAll({ kind: "cleanRemoteNotes", startAt: Date.now() });

    for (const id of [oldRoot, oldReply, oldRenote, remoteReacted]) assert.equal(await exists(id), false, id);
    for (const id of [newRemote, oldLocal, keptRoot, keptReply, localRepliedRoot, localReply, clipped, inPage, pinned, favorited, reacted]) {
      assert.equal(await exists(id), true, id);
    }
    // reached the end: the next run starts from the beginning
    assert.equal(kv.has(CURSOR_KEY), false);
  });

  it("does nothing while disabled", async () => {
    const old = await note(200);
    await f.db.query(`UPDATE meta SET "enableRemoteNotesCleaning" = FALSE`);
    assert.equal(await runCleanRemoteNotesStep(f.env, { kind: "cleanRemoteNotes", startAt: Date.now() }, noPause), null);
    assert.equal(await exists(old), true);
    // the cron does not start a run either
    assert.equal(await startCleanRemoteNotes(f.env), "disabled");
  });

  it("uses remoteNotesCleaningExpiryDaysForEachNotes", async () => {
    const n = await note(40);
    await runAll({ kind: "cleanRemoteNotes", startAt: Date.now() });
    assert.equal(await exists(n), true);
    await f.db.query(`UPDATE meta SET "remoteNotesCleaningExpiryDaysForEachNotes" = 30`);
    await runAll({ kind: "cleanRemoteNotes", startAt: Date.now() });
    assert.equal(await exists(n), false);
  });

  it("stops at the max duration and resumes from the stored cursor on the next run", async () => {
    const roots: string[] = [];
    for (let i = 0; i < 30; i++) roots.push(await note(200 - i));
    // a run started 61 minutes ago has used up its 60 minutes: nothing is done
    assert.equal(await runCleanRemoteNotesStep(f.env, { kind: "cleanRemoteNotes", startAt: Date.now() - 61 * 60_000 }, noPause), null);
    assert.equal(await exists(roots[0]!), true);

    // a clock that passes the max duration after the first batch (limit 10)
    const startAt = Date.now();
    let calls = 0;
    const clock = () => (calls++ < 4 ? startAt : startAt + 61 * 60_000);
    await runAll({ kind: "cleanRemoteNotes", startAt, limit: 10 }, { now: clock });
    assert.equal((await f.db.query(`SELECT 1 FROM note`)).rows.length, 20);
    assert.equal(kv.get(CURSOR_KEY), roots[9]);

    // the next run resumes after the cursor and reaches the end
    await runAll({ kind: "cleanRemoteNotes", startAt: Date.now() });
    assert.equal((await f.db.query(`SELECT 1 FROM note`)).rows.length, 0);
    assert.equal(kv.has(CURSOR_KEY), false);
  });

  it("splits a run into mk-jobs steps", async () => {
    for (let i = 0; i < 25; i++) await note(200 - i);
    const startAt = Date.now();
    let t = startAt;
    // each clock read advances 31 s: a step's budget (60 s) runs out after a couple of batches
    const steps = await runAll({ kind: "cleanRemoteNotes", startAt, limit: 10 }, { now: () => (t += 31_000) });
    assert.ok(steps > 1, `steps: ${steps}`);
    assert.equal((await f.db.query(`SELECT 1 FROM note`)).rows.length, 0);

    // dispatched by the mk-jobs consumer
    await note(200);
    let next = await runJobStep(f.env, { kind: "cleanRemoteNotes", startAt: Date.now() });
    while (next) next = await runJobStep(f.env, next);
    assert.equal((await f.db.query(`SELECT 1 FROM note`)).rows.length, 0);
  });

  it("the cron starts a run inline without the queue", async () => {
    const old = await note(200);
    assert.equal(await startCleanRemoteNotes(f.env), "started");
    assert.equal(await exists(old), false);
  });
});
