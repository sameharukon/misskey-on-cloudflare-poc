/**
 * Charts on PG (PGlite): bucket alignment (UTC hour / day, offset cursor, newest first), and
 * series computed from notes / users / drive files / follows / reactions, in upstream's shape.
 */
import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { genAidxFromDate } from "../../id/src/index.js";
import { IMPLEMENTED_ENDPOINTS } from "./registry.js";
import { makeFixture, type Fixture } from "./pglite-fixture.js";
import { chartBuckets } from "./charts-pg.js";
import { ENDPOINT_PARAM_DEFS } from "./endpoint-params.gen.js";

let f: Fixture;
const H = 3600_000;
const nowHour = Math.floor(Date.now() / H) * H;
let seq = 0;
const R1 = genAidxFromDate(new Date(nowHour - 100 * H));
/** An aidx id inside the hour `hoursAgo` hours before the current one. */
const idAt = (hoursAgo: number) => genAidxFromDate(new Date(nowHour - hoursAgo * H + 60_000 + seq++));

before(async () => {
  f = await makeFixture("ChartsTest");
  await f.db.query(`INSERT INTO "user" (id, username, "usernameLower", host) VALUES ($1, 'r', 'r', 'remote.example')`, [R1]);
  const note = (userId: string, hoursAgo: number, extra: Record<string, unknown> = {}) =>
    f.db.query(`INSERT INTO note (id, "userId", "userHost", "replyId", "renoteId", "fileIds", visibility) VALUES ($1, $2, $3, $4, $5, $6, 'public')`, [
      idAt(hoursAgo), userId, extra.host ?? null, extra.replyId ?? null, extra.renoteId ?? null, extra.fileIds ?? [],
    ]);
  await note(f.ids.b, 0);
  await note(f.ids.b, 0, { replyId: "x" });
  await note(f.ids.b, 1, { renoteId: "y", fileIds: ["f"] });
  await note(f.ids.b, 5); // before a 3-hour window
  await note(f.ids.c, 0);
  await note(R1, 0, { host: "remote.example" });
  await f.db.query(`INSERT INTO drive_file (id, "userId", "userHost", type, name, size, url, md5, "storedInternal") VALUES ($1, $2, NULL, 'image/png', 'a', 2000, 'u', '0', FALSE), ($3, $2, NULL, 'image/png', 'b', 3000, 'u', '0', FALSE)`, [idAt(0), f.ids.b, idAt(10)]);
  await f.db.query(`INSERT INTO following (id, "followerId", "followeeId", "followerHost", "followeeHost") VALUES ($1, $2, $3, NULL, NULL), ($4, $5, $3, 'remote.example', NULL)`, [idAt(1), f.ids.c, f.ids.b, idAt(0), R1]);
});

describe("charts", () => {
  it("registers endpoints", () => {
    for (const e of ["charts/notes", "charts/users", "charts/drive", "charts/federation", "charts/ap-request", "charts/active-users", "charts/instance", "charts/user/notes", "charts/user/following", "charts/user/drive", "charts/user/pv", "charts/user/reactions"]) {
      assert.ok((IMPLEMENTED_ENDPOINTS as readonly string[]).includes(e), e);
      assert.ok(ENDPOINT_PARAM_DEFS[e], e);
    }
  });

  it("bucket alignment", () => {
    const now = Date.UTC(2026, 0, 2, 13, 30);
    assert.deepEqual(chartBuckets("hour", 2, null, now), { starts: [Date.UTC(2026, 0, 2, 12), Date.UTC(2026, 0, 2, 13)], end: Date.UTC(2026, 0, 2, 14) });
    assert.deepEqual(chartBuckets("day", 1, null, now).starts, [Date.UTC(2026, 0, 2)]);
    // a cursor at a bucket start belongs to that bucket; just after it, to the next (upstream +span-1ms)
    assert.deepEqual(chartBuckets("hour", 1, Date.UTC(2026, 0, 2, 10), now).starts, [Date.UTC(2026, 0, 2, 10)]);
    assert.deepEqual(chartBuckets("hour", 1, Date.UTC(2026, 0, 2, 10, 1), now).starts, [Date.UTC(2026, 0, 2, 11)]);
  });

  it("charts/notes and charts/user/notes", async () => {
    const r = (await f.call("charts/notes", { span: "hour", limit: 3 })).data;
    assert.deepEqual(r.local.inc, [3, 1, 0]); // newest first
    assert.deepEqual(r.local.total, [5, 2, 1]); // includes the older note
    assert.deepEqual(r.local.dec, [0, 0, 0]);
    assert.deepEqual(r.local.diffs, { normal: [2, 0, 0], reply: [1, 0, 0], renote: [0, 1, 0], withFile: [0, 1, 0] });
    assert.deepEqual(r.remote.inc, [1, 0, 0]);
    const u = (await f.call("charts/user/notes", { span: "hour", limit: 2, userId: f.ids.b })).data;
    assert.deepEqual([u.total, u.inc], [[4, 2], [2, 1]]);
    const past = (await f.call("charts/user/notes", { span: "hour", limit: 1, userId: f.ids.b, offset: nowHour - H })).data;
    assert.deepEqual(past.inc, [1]);
    assert.equal((await f.call("charts/notes", { span: "week" })).status, 400);
    assert.equal((await f.call("charts/user/notes", { span: "day" })).status, 400);
  });

  it("users / drive / user/drive / user/following / instance / active-users / zero charts", async () => {
    const users = (await f.call("charts/users", { span: "day", limit: 1 })).data;
    assert.deepEqual([users.local.total[0], users.remote.total[0]], [3, 1]);
    const drive = (await f.call("charts/drive", { span: "hour", limit: 1 })).data;
    assert.deepEqual([drive.local.incCount, drive.local.incSize], [[1], [2]]);
    const ud = (await f.call("charts/user/drive", { span: "hour", limit: 1, userId: f.ids.b })).data;
    assert.deepEqual([ud.totalCount, ud.totalSize, ud.incCount], [[2], [5], [1]]);
    const fo = (await f.call("charts/user/following", { span: "hour", limit: 2, userId: f.ids.b })).data;
    assert.deepEqual(fo.local.followers, { total: [2, 1], inc: [1, 1], dec: [0, 0] });
    assert.deepEqual(fo.remote.followers.total, [0, 0]);
    const inst = (await f.call("charts/instance", { span: "hour", limit: 1, host: "remote.example" })).data;
    assert.deepEqual([inst.notes.inc, inst.following.inc, inst.followers.inc, inst.requests.received], [[1], [1], [0], [0]]);
    const au = (await f.call("charts/active-users", { span: "hour", limit: 1 })).data;
    assert.deepEqual([au.write, au.readWrite], [[2], [2]]);
    assert.deepEqual(au.registeredWithinWeek, [2]);
    assert.deepEqual((await f.call("charts/federation", { span: "day", limit: 2 })).data.pub, [0, 0]);
    assert.deepEqual((await f.call("charts/user/pv", { span: "day", limit: 1, userId: f.ids.b })).data, { upv: { user: [0], visitor: [0] }, pv: { user: [0], visitor: [0] } });
  });

  it("user/reactions: received, split by reactor locality", async () => {
    const n = (await f.db.query(`SELECT id FROM note WHERE "userId" = $1 ORDER BY id DESC LIMIT 1`, [f.ids.b])).rows[0] as any;
    await f.db.query(`INSERT INTO note_reaction (id, "userId", "noteId", reaction) VALUES ($1, $2, $3, '👍'), ($4, $5, $3, '👍')`, [idAt(0), f.ids.c, n.id, idAt(0), R1]);
    const r = (await f.call("charts/user/reactions", { span: "hour", limit: 1, userId: f.ids.b })).data;
    assert.deepEqual(r, { local: { count: [1] }, remote: { count: [1] } });
  });
});
