/**
 * Note drafts / scheduled notes on PG (PGlite): notes/drafts/create|update|delete|list|count,
 * the postScheduledNote job, the PollTimer job timer and the cron sweep.
 */
import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { NotificationBox } from "../../timeline/src/index.js";
import { IMPLEMENTED_ENDPOINTS } from "./registry.js";
import { fakeDoNamespace, makeFixture, type Fixture } from "./pglite-fixture.js";
import { postOverdueScheduledNotes, runPostScheduledNote } from "./drafts-pg.js";
import { PollTimer } from "./polls-pg.js";
import type { ApiEnv } from "./env.js";
import { ENDPOINT_PARAM_DEFS } from "./endpoint-params.gen.js";

let f: Fixture;
const queued: { body: any; delaySeconds?: number }[] = [];
before(async () => {
  f = await makeFixture("DraftTest", {
    NOTIFICATION_BOX: fakeDoNamespace((s) => new NotificationBox(s as never)) as unknown as ApiEnv["NOTIFICATION_BOX"],
    Q_JOBS: { send: async (body: unknown, o?: { delaySeconds?: number }) => void queued.push({ body, delaySeconds: o?.delaySeconds }) },
  });
});

const E = (r: { data: any }) => r.data?.error?.id;
const rows = async (sql: string, p: unknown[] = []) => (await f.db.query(sql, p)).rows as any[];

describe("note drafts", () => {
  it("registers endpoints", () => {
    for (const e of ["notes/drafts/create", "notes/drafts/update", "notes/drafts/delete", "notes/drafts/list", "notes/drafts/count"]) {
      assert.ok((IMPLEMENTED_ENDPOINTS as readonly string[]).includes(e), e);
      assert.ok(ENDPOINT_PARAM_DEFS[e], e);
    }
  });

  it("create / list / count / update / delete", async () => {
    const reply = await f.note(f.ids.b, { text: "parent" });
    const c = await f.call("notes/drafts/create", { text: "hello", cw: "cw", replyId: reply, poll: { choices: ["a", "b"], expiredAfter: 60000 } }, "a");
    assert.equal(c.status, 200);
    const d = c.data.createdDraft;
    assert.equal(d.text, "hello");
    assert.equal(d.visibility, "public");
    assert.equal(d.user.id, f.ids.a);
    assert.equal(d.reply.id, reply);
    assert.equal(d.renote, undefined);
    assert.deepEqual(d.poll, { choices: ["a", "b"], multiple: false, expiresAt: undefined, expiredAfter: 60000 });
    assert.equal(d.scheduledAt, null);
    assert.equal((await f.call("notes/drafts/count", {}, "a")).data, 1);
    assert.equal((await f.call("notes/drafts/count", {}, "b")).data, 0);

    const u = await f.call("notes/drafts/update", { draftId: d.id, text: "edited", visibility: "home" }, "a");
    assert.equal(u.data.updatedDraft.text, "edited");
    assert.equal(u.data.updatedDraft.cw, "cw"); // untouched
    assert.equal(E(await f.call("notes/drafts/update", { draftId: d.id, text: "x" }, "b")), "49cd6b9d-848e-41ee-b0b9-adaca711a6b1");

    const l = (await f.call("notes/drafts/list", {}, "a")).data;
    assert.deepEqual(l.map((x: any) => x.id), [d.id]);
    assert.deepEqual((await f.call("notes/drafts/list", { scheduled: true }, "a")).data, []);

    assert.equal(E(await f.call("notes/drafts/delete", { draftId: d.id }, "b")), "49cd6b9d-848e-41ee-b0b9-adaca711a6b1");
    assert.equal((await f.call("notes/drafts/delete", { draftId: d.id }, "a")).status, 204);
    assert.equal((await f.call("notes/drafts/count", {}, "a")).data, 0);
  });

  it("validation errors (create vs update ids)", async () => {
    assert.equal((await f.call("notes/drafts/create", { visibility: "nope" }, "a")).status, 400);
    assert.equal(E(await f.call("notes/drafts/create", { replyId: "missing" }, "a")), "749ee0f6-d3da-459a-bf02-282e2da4292c");
    assert.equal(E(await f.call("notes/drafts/create", { renoteId: "missing" }, "a")), "b5c90186-4ab0-49c8-9bba-a1f76c282ba4");
    assert.equal(E(await f.call("notes/drafts/create", { fileIds: ["nofile"] }, "a")), "b6992544-63e7-67f0-fa7f-32444b1b5306");
    assert.equal(E(await f.call("notes/drafts/create", { isActuallyScheduled: true }, "a")), "15e28a55-e74c-4d65-89b7-8880cdaaa87d");
    assert.equal(E(await f.call("notes/drafts/create", { isActuallyScheduled: true, scheduledAt: Date.now() - 1000 }, "a")), "e4bed6c9-017e-4934-aed0-01c22cc60ec1");
    const spec = await f.note(f.ids.b, { text: "dm", visibility: "specified", visibleUserIds: [f.ids.a] });
    assert.equal(E(await f.call("notes/drafts/create", { replyId: spec, visibility: "public" }, "a")), "ed940410-535c-4d5e-bfa3-af798671e93c");
    const fol = await f.note(f.ids.b, { text: "fo", visibility: "followers" });
    assert.equal(E(await f.call("notes/drafts/create", { renoteId: fol }, "a")), "be9529e9-fe72-4de0-ae43-0b363c4938af");
    assert.equal(E(await f.call("notes/drafts/create", { replyId: fol }, "c")), "b98980fa-3780-406c-a935-b6d0eeee10d1");
    await f.db.query(`INSERT INTO blocking (id, "blockerId", "blockeeId") VALUES ('blk1', $1, $2)`, [f.ids.b, f.ids.c]);
    const pub = await f.note(f.ids.b, { text: "pub" });
    assert.equal(E(await f.call("notes/drafts/create", { replyId: pub }, "c")), "b390d7e1-8a5e-46ed-b625-06271cafd3d3");
    await f.db.query(`DELETE FROM blocking WHERE id = 'blk1'`);

    const d = (await f.call("notes/drafts/create", { text: "t" }, "a")).data.createdDraft;
    assert.equal(E(await f.call("notes/drafts/update", { draftId: d.id, replyId: "missing" }, "a")), "c4721841-22fc-4bb7-ad3d-897ef1d375b5");
    assert.equal(E(await f.call("notes/drafts/update", { draftId: d.id, renoteId: "missing" }, "a")), "64929870-2540-4d11-af41-3b484d78c956");
    assert.equal(E(await f.call("notes/drafts/update", { draftId: d.id, isActuallyScheduled: true }, "a")), "fe9737d5-cc41-498c-af9d-149207307530");
    // update maps the reply-to-specified failure to its own error (ed940410 / CANNOT_REPLY_TO_SPECIFIED_NOTE_…)
    const r = await f.call("notes/drafts/update", { draftId: d.id, replyId: spec, visibility: "public" }, "a");
    assert.deepEqual([r.data.error.id, r.data.error.code], ["ed940410-535c-4d5e-bfa3-af798671e93c", "CANNOT_REPLY_TO_SPECIFIED_NOTE_WITH_EXTENDED_VISIBILITY"]);
    await f.call("notes/drafts/delete", { draftId: d.id }, "a");
  });

  it("update leaves hasPoll alone and writes only the given poll keys (as upstream)", async () => {
    const d = (await f.call("notes/drafts/create", { text: "p", poll: { choices: ["a", "b"], multiple: true, expiredAfter: 60000 } }, "a")).data.createdDraft;
    // poll: null → only pollExpiresAt is written; the stored poll stays
    let u = (await f.call("notes/drafts/update", { draftId: d.id, poll: null }, "a")).data.updatedDraft;
    assert.deepEqual(u.poll, { choices: ["a", "b"], multiple: true, expiresAt: undefined, expiredAfter: 60000 });
    // choices only → multiple / expiredAfter untouched
    u = (await f.call("notes/drafts/update", { draftId: d.id, poll: { choices: ["x"] } }, "a")).data.updatedDraft;
    assert.deepEqual(u.poll, { choices: ["x"], multiple: true, expiresAt: undefined, expiredAfter: 60000 });
    // a poll given to a poll-less draft is stored but not shown (hasPoll stays false)
    const n = (await f.call("notes/drafts/create", { text: "n" }, "a")).data.createdDraft;
    u = (await f.call("notes/drafts/update", { draftId: n.id, poll: { choices: ["c"] } }, "a")).data.updatedDraft;
    assert.equal(u.poll, null);
    assert.deepEqual(((await f.db.query(`SELECT "pollChoices" FROM note_draft WHERE id = $1`, [n.id])).rows[0] as any).pollChoices, ["c"]);
    await f.call("notes/drafts/delete", { draftId: d.id }, "a");
    await f.call("notes/drafts/delete", { draftId: n.id }, "a");
  });

  it("prohibitMoved: a moved account gets YOUR_ACCOUNT_MOVED before param validation", async () => {
    await f.db.query(`UPDATE "user" SET "movedToUri" = 'https://x/u' WHERE id = $1`, [f.ids.c]);
    for (const ep of ["notes/drafts/create", "notes/drafts/update", "notes/drafts/delete", "notes/drafts/list", "notes/drafts/count"]) {
      const r = await f.call(ep, { visibility: "nope" }, "c");
      assert.deepEqual([r.status, r.data.error.id], [403, "56f20ec9-fd06-4fa5-841b-edd6d7d4fa31"], ep);
    }
    await f.db.query(`UPDATE "user" SET "movedToUri" = NULL WHERE id = $1`, [f.ids.c]);
  });

  it("draft limit and scheduled-note limit (role policies)", async () => {
    await f.setPolicy(f.ids.c, "noteDraftLimit", 2);
    await f.call("notes/drafts/create", { text: "1" }, "c");
    await f.call("notes/drafts/create", { text: "2" }, "c");
    assert.equal(E(await f.call("notes/drafts/create", { text: "3" }, "c")), "9ee33bbe-fde3-4c71-9b51-e50492c6b9c8");
    await f.db.query(`DELETE FROM note_draft WHERE "userId" = $1`, [f.ids.c]);
    const at = Date.now() + 3600_000;
    assert.equal((await f.call("notes/drafts/create", { text: "s1", scheduledAt: at, isActuallyScheduled: true }, "c")).status, 200);
    // default scheduledNoteLimit = 1
    assert.equal(E(await f.call("notes/drafts/create", { text: "s2", scheduledAt: at, isActuallyScheduled: true }, "c")), "22ae69eb-09e3-4541-a850-773cfa45e693");
    const plain = (await f.call("notes/drafts/create", { text: "p" }, "c")).data.createdDraft;
    assert.equal(E(await f.call("notes/drafts/update", { draftId: plain.id, scheduledAt: at, isActuallyScheduled: true }, "c")), "02f5df79-08ae-4a33-8524-f1503c8f6212");
    await f.db.query(`DELETE FROM note_draft WHERE "userId" = $1`, [f.ids.c]);
  });

  it("scheduled draft → mk-jobs message → posted note + notification", async () => {
    queued.length = 0;
    const at = Date.now() + 120_000;
    const d = (await f.call("notes/drafts/create", { text: "later", visibility: "home", scheduledAt: at, isActuallyScheduled: true }, "b")).data.createdDraft;
    assert.equal(d.scheduledAt, at);
    assert.equal(d.isActuallyScheduled, true);
    assert.deepEqual(queued.map((q) => q.body), [{ kind: "postScheduledNote", draftId: d.id }]);
    assert.ok(queued[0]!.delaySeconds! >= 119 && queued[0]!.delaySeconds! <= 120);
    // too early: skipped
    assert.equal(await runPostScheduledNote(f.env, { kind: "postScheduledNote", draftId: d.id }), "skipped");
    await f.db.query(`UPDATE note_draft SET "scheduledAt" = now() WHERE id = $1`, [d.id]);
    assert.equal(await runPostScheduledNote(f.env, { kind: "postScheduledNote", draftId: d.id }), "posted");
    const posted = await rows(`SELECT id, text, visibility FROM note WHERE "userId" = $1 AND text = 'later'`, [f.ids.b]);
    assert.equal(posted.length, 1);
    assert.equal(posted[0].visibility, "home");
    assert.equal((await rows(`SELECT 1 FROM note_draft WHERE id = $1`, [d.id])).length, 0);
    const n = (await f.call("i/notifications", {}, "b")).data.find((x: any) => x.type === "scheduledNotePosted");
    assert.equal(n.note.id, posted[0].id);
    // gone: a second message does nothing
    assert.equal(await runPostScheduledNote(f.env, { kind: "postScheduledNote", draftId: d.id }), "skipped");
  });

  it("failed scheduled post → scheduledNotePostFailed; cron sweep", async () => {
    const reply = await f.note(f.ids.c, { text: "will vanish" });
    const d = (await f.call("notes/drafts/create", { text: "re", replyId: reply, scheduledAt: Date.now() + 60_000, isActuallyScheduled: true }, "b")).data.createdDraft;
    await f.db.query(`DELETE FROM note WHERE id = $1`, [reply]);
    await f.db.query(`UPDATE note_draft SET "scheduledAt" = now() - interval '10 minutes' WHERE id = $1`, [d.id]);
    assert.equal(await postOverdueScheduledNotes(f.env), 0);
    const n = (await f.call("i/notifications", {}, "b")).data.find((x: any) => x.type === "scheduledNotePostFailed");
    assert.ok(n);
    assert.equal(n.noteDraft, undefined, "upstream NotificationEntityService does not embed the draft");
    // the failed draft stays, unscheduled, so the sweep does not retry it
    assert.equal((await rows(`SELECT "isActuallyScheduled" AS s FROM note_draft WHERE id = $1`, [d.id]))[0].s, false);
    await f.call("notes/drafts/delete", { draftId: d.id }, "b");
  });

  it("PollTimer as a job timer: schedule / move / cancel / alarm", async () => {
    const store = new Map<string, unknown>();
    let alarm: number | null = null;
    const state = {
      storage: {
        get: async (k: string) => store.get(k) as any,
        put: async (k: string, v: unknown) => void store.set(k, v),
        deleteAll: async () => store.clear(),
        setAlarm: async (t: number) => void (alarm = t),
        getAlarm: async () => alarm,
        deleteAlarm: async () => void (alarm = null),
      },
    };
    const sent: unknown[] = [];
    const timer = new PollTimer(state, { ...f.env, Q_JOBS: { send: async (m: unknown) => void sent.push(m) } } as ApiEnv);
    const job = { kind: "postScheduledNote", draftId: "d1" };
    const at = Date.now() + 5000;
    await timer.fetch(new Request("https://poll.internal/schedule", { method: "POST", body: JSON.stringify({ job, at }) }));
    assert.equal(alarm, at);
    await timer.fetch(new Request("https://poll.internal/schedule", { method: "POST", body: JSON.stringify({ job, at: at + 1000 }) }));
    assert.equal(alarm, at + 1000);
    await timer.alarm();
    assert.deepEqual(sent, [job]);
    await timer.fetch(new Request("https://poll.internal/schedule", { method: "POST", body: JSON.stringify({ job, at }) }));
    await timer.fetch(new Request("https://poll.internal/cancel", { method: "POST", body: "{}" }));
    assert.equal(alarm, null);
    assert.equal(store.size, 0);
  });
});
