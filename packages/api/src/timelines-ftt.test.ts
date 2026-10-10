/**
 * Home / hybrid / list timelines with enableFanoutTimeline on (the FTT lists evaluated as SQL):
 * follows and list members bound as arrays keep the withReplies rules, followed channels and
 * own notes; an empty list falls back to getFromDb with the caller's untilId; keyset batches
 * page through the list.
 */
import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { genAidx } from "../../id/src/index.js";
import { makeFixture, type Fixture } from "./pglite-fixture.js";

let f: Fixture;
let seq = 0;
const base = Date.now() - 3600_000;
const note = (userId: string, fields: Record<string, unknown> = {}) =>
  f.db.query(`INSERT INTO note (id, "userId", visibility, text, "replyId", "replyUserId", "channelId") VALUES ($1, $2, 'public', $3, $4, $5, $6) RETURNING id`, [
    genAidx(base + 1000 * seq++), userId, fields.text ?? "t", fields.replyId ?? null, fields.replyUserId ?? null, fields.channelId ?? null,
  ]).then((r) => String((r.rows[0] as { id: string }).id));
const ids = (r: { data: { id: string }[] }) => r.data.map((n) => n.id);

describe("FTT timelines (SQL lists)", () => {
  // a follows b (withReplies false) and c (withReplies true); a follows channel ch1
  const n: Record<string, string> = {};
  before(async () => {
    f = await makeFixture("TimelinesFtt");
    const { a, b, c } = f.ids;
    await f.db.query(`INSERT INTO following (id, "followerId", "followeeId", "withReplies") VALUES ('fab', $1, $2, FALSE), ('fac', $1, $3, TRUE)`, [a, b, c]);
    await f.db.query(`INSERT INTO channel (id, "userId", name) VALUES ('ch1', $1, 'Chan')`, [c]);
    await f.db.query(`INSERT INTO channel_following (id, "followerId", "followeeId") VALUES ('cf1', $1, 'ch1')`, [a]);
    n.own = await note(a);
    n.b = await note(b);
    n.bReplyToC = await note(b, { replyId: n.own, replyUserId: c });
    n.cReplyToB = await note(c, { replyId: n.b, replyUserId: b });
    n.inChannel = await note(c, { channelId: "ch1" });
  });

  it("home: followees (with the reply rule per follow), followed channels and own notes", async () => {
    const r = await f.call("notes/timeline", { limit: 20 }, "a");
    assert.equal(r.status, 200);
    assert.deepEqual(ids(r).sort(), [n.own, n.b, n.cReplyToB, n.inChannel].sort());
  });

  it("home: keyset batches page the same list", async () => {
    const all = ids(await f.call("notes/timeline", { limit: 20 }, "a"));
    const p1 = ids(await f.call("notes/timeline", { limit: 2 }, "a"));
    const p2 = ids(await f.call("notes/timeline", { limit: 2, untilId: p1.at(-1) }, "a"));
    assert.deepEqual([...p1, ...p2], all.slice(0, 4));
  });

  it("an empty list falls back to getFromDb, keeping the caller's untilId", async () => {
    // c follows nobody: only its own notes (fallback), older than untilId
    const r = await f.call("notes/timeline", { limit: 10, untilId: n.inChannel }, "c");
    assert.deepEqual(ids(r), [n.cReplyToB]);
  });

  it("hybrid adds local public notes", async () => {
    const r = await f.call("notes/hybrid-timeline", { limit: 20 }, "b");
    assert.ok(ids(r).includes(n.own));
  });

  it("user list: members with the reply rule per membership", async () => {
    const { a, b, c } = f.ids;
    await f.db.query(`INSERT INTO user_list (id, "userId", name) VALUES ('l1', $1, 'l')`, [a]);
    await f.db.query(`INSERT INTO user_list_membership (id, "userId", "userListId", "userListUserId", "withReplies") VALUES ('m1', $1, 'l1', $3, FALSE), ('m2', $2, 'l1', $3, TRUE)`, [b, c, a]);
    const r = await f.call("notes/user-list-timeline", { listId: "l1", limit: 20 }, "a");
    assert.equal(r.status, 200);
    // b's reply to c is a reply to someone else (excluded without withReplies); c's reply is kept;
    // channel notes are not in list timelines
    assert.deepEqual(ids(r).sort(), [n.b, n.cReplyToB].sort());
    await f.db.query(`INSERT INTO user_list (id, "userId", name) VALUES ('l2', $1, 'empty')`, [a]);
    assert.deepEqual(ids(await f.call("notes/user-list-timeline", { listId: "l2", limit: 20 }, "a")), []);
  });
});
