/**
 * Abuse reports on PG (PGlite): users/report-abuse (self / admin / unknown target), the
 * moderator list with filters and packed users, resolve / update note / forward checks, and
 * moderation_log entries.
 */
import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { IMPLEMENTED_ENDPOINTS } from "./registry.js";
import { makeFixture, type Fixture } from "./pglite-fixture.js";
import { ENDPOINT_PARAM_DEFS } from "./endpoint-params.gen.js";

let f: Fixture;
before(async () => {
  f = await makeFixture("AbuseTest");
});

const E = (r: { data: any }) => r.data?.error?.id;

describe("abuse reports", () => {
  let rep = "";

  it("registers endpoints", () => {
    for (const e of ["users/report-abuse", "admin/abuse-user-reports", "admin/resolve-abuse-user-report", "admin/update-abuse-user-report", "admin/forward-abuse-user-report"]) {
      assert.ok((IMPLEMENTED_ENDPOINTS as readonly string[]).includes(e), e);
      assert.ok(ENDPOINT_PARAM_DEFS[e], e);
    }
  });

  it("users/report-abuse", async () => {
    assert.equal((await f.call("users/report-abuse", { userId: f.ids.c, comment: "spam" })).status, 401);
    assert.equal(E(await f.call("users/report-abuse", { userId: "nope", comment: "x" }, "b")), "1acefcb5-0959-43fd-9685-b48305736cb5");
    assert.equal(E(await f.call("users/report-abuse", { userId: f.ids.b, comment: "x" }, "b")), "1e13149e-b1e8-43cf-902e-c01dbfcb202f");
    assert.equal(E(await f.call("users/report-abuse", { userId: f.ids.a, comment: "x" }, "b")), "35e166f5-05fb-4f87-a2d5-adb42676d48f"); // root
    assert.equal((await f.call("users/report-abuse", { userId: f.ids.c, comment: "" }, "b")).status, 400);
    assert.equal((await f.call("users/report-abuse", { userId: f.ids.c, comment: "spam" }, "b")).status, 204);
  });

  it("admin list / resolve / update / forward", async () => {
    assert.equal((await f.call("admin/abuse-user-reports", {}, "b")).status, 403);
    const l = await f.call("admin/abuse-user-reports", {}, "a");
    assert.equal(l.data.length, 1);
    rep = l.data[0].id;
    assert.equal(l.data[0].comment, "spam");
    assert.equal(l.data[0].reporter.id, f.ids.b);
    assert.equal(l.data[0].targetUser.id, f.ids.c);
    assert.equal(l.data[0].assignee, null);
    assert.equal(l.data[0].resolved, false);
    assert.equal(l.data[0].moderationNote, "");
    assert.equal((await f.call("admin/abuse-user-reports", { targetUserOrigin: "remote" }, "a")).data.length, 0);
    assert.equal((await f.call("admin/update-abuse-user-report", { reportId: rep, moderationNote: "looking" }, "a")).status, 204);
    const nf = await f.call("admin/resolve-abuse-user-report", { reportId: "nope" }, "a");
    assert.equal(nf.status, 404);
    assert.equal(E(nf), "ac3794dd-2ce4-d878-e546-73c60c06b398");
    assert.equal((await f.call("admin/resolve-abuse-user-report", { reportId: rep, resolvedAs: "bogus" }, "a")).status, 400);
    assert.equal((await f.call("admin/resolve-abuse-user-report", { reportId: rep, resolvedAs: "accept" }, "a")).status, 204);
    const r = (await f.call("admin/abuse-user-reports", { state: "resolved" }, "a")).data[0];
    assert.equal(r.resolved, true);
    assert.equal(r.resolvedAs, "accept");
    assert.equal(r.assignee.id, f.ids.a);
    assert.equal(r.moderationNote, "looking");
    assert.equal((await f.call("admin/abuse-user-reports", { state: "unresolved" }, "a")).data.length, 0);
    // a local target cannot be forwarded (upstream Error → 500)
    assert.equal((await f.call("admin/forward-abuse-user-report", { reportId: rep }, "a")).status, 500);
    assert.equal((await f.call("admin/forward-abuse-user-report", { reportId: "nope" }, "a")).status, 404);
    const types = ((await f.db.query(`SELECT type FROM moderation_log`)).rows as any[]).map((x) => x.type).sort();
    assert.deepEqual(types, ["resolveAbuseReport", "updateAbuseReportNote"]);
  });

  it("forward: a remote target gets a Flag from the instance actor", async () => {
    const sent: any[] = [];
    const { setQueueProducer } = await import("./queues/fanout.js");
    setQueueProducer(f.env, { send: async (_q: string, m: unknown) => void sent.push(m) } as never);
    await f.db.query(`UPDATE meta SET federation = 'all'`);
    await f.db.query(`INSERT INTO "user" (id, username, "usernameLower", host, uri, inbox) VALUES ('rmt1', 'r', 'r', 'remote.example', 'https://remote.example/users/r', 'https://remote.example/inbox')`);
    await f.db.query(`INSERT INTO abuse_user_report (id, "targetUserId", "targetUserHost", "reporterId", comment) VALUES ('rpt1', 'rmt1', 'remote.example', $1, 'bad')`, [f.ids.b]);
    assert.equal((await f.call("admin/forward-abuse-user-report", { reportId: "rpt1" }, "a")).status, 204);
    assert.equal(((await f.db.query(`SELECT forwarded FROM abuse_user_report WHERE id = 'rpt1'`)).rows[0] as any).forwarded, true);
    const flag = sent.find((m) => m.activity?.type === "Flag");
    assert.equal(flag.inbox, "https://remote.example/inbox");
    assert.deepEqual([flag.activity.object, flag.activity.content], ["https://remote.example/users/r", "bad"]);
    const actor = (await f.db.query(`SELECT "userId" FROM system_account WHERE type = 'actor'`)).rows[0] as any;
    assert.equal(flag.signerId, actor.userId);
    // already forwarded → 500 as upstream
    assert.equal((await f.call("admin/forward-abuse-user-report", { reportId: "rpt1" }, "a")).status, 500);
  });
});
