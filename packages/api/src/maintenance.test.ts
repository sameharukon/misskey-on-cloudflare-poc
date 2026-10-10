/**
 * Maintenance on PG (PGlite): the hourly moderator-activity check (warnings every 6 h in the last
 * 2 days, invitation-only switch + announcements + system webhooks after 7 days),
 * lastActiveDate on streaming connect, the instance stats backfill (admin/cf-debug/backfill-instances,
 * inline and as mk-jobs steps), and the router's upstream HTTP caching behaviour (cacheSec /
 * allowGet: bubble-game/ranking 60 s response cache, Cache-Control headers, GET → 405).
 */
import { before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { genAidx } from "../../id/src/index.js";
import { makeFixture, TOK, type Fixture } from "./pglite-fixture.js";
import { checkModeratorsActivity, touchLastActiveDate, BACKFILL_HOSTS_PER_STEP } from "./maintenance-pg.js";
import { runJobStep, type JobMessage } from "./jobs.js";
import { handleStreamingUpgrade } from "./stream-publish.js";
import { dispatchApi } from "./router.js";
import { ENDPOINT_META } from "./endpoint-meta.gen.js";
import type { ApiEnv } from "./env.js";

const hooks: { type: string; content: any; to: string }[] = [];
const mails: { to: unknown; subject: string; text?: string; html?: string }[] = [];
const EMAIL = { async send(m: any) { mails.push(m); return { messageId: "m" }; } };
let f: Fixture;
let modRole = "";
before(async () => {
  f = await makeFixture("MaintenanceTest", {
    Q_WEBHOOK_DELIVER: { send: async (m: any) => void hooks.push({ type: m.type, content: m.content, to: m.to }) },
    EMAIL: EMAIL as unknown as ApiEnv["EMAIL"],
  } as Partial<ApiEnv>);
  await f.db.query(`UPDATE meta SET "enableEmail" = TRUE, email = 'noreply@misskey.example.com'`);
  // b (moderator) has a verified address, c (not a moderator) too, a's is unverified
  await f.db.query(`UPDATE user_profile SET email = 'b@example.org', "emailVerified" = TRUE WHERE "userId" = $1`, [f.ids.b]);
  await f.db.query(`UPDATE user_profile SET email = 'c@example.org', "emailVerified" = TRUE WHERE "userId" = $1`, [f.ids.c]);
  await f.db.query(`UPDATE user_profile SET email = 'a@example.org', "emailVerified" = FALSE WHERE "userId" = $1`, [f.ids.a]);
  // a = root, b = moderator (role), c = plain user
  modRole = (await f.call("admin/roles/create", {
    name: "Mods", description: "", color: null, iconUrl: null, target: "manual", condFormula: {}, isPublic: false,
    isModerator: true, isAdministrator: false, asBadge: false, canEditMembersByModerator: false, displayOrder: 0, policies: {},
  }, "a")).data.id;
  await f.call("admin/roles/assign", { roleId: modRole, userId: f.ids.b }, "a");
  await f.db.query(
    `INSERT INTO system_webhook (id, name, "on", url, secret) VALUES ('sw1', 'mods', '{inactiveModeratorsWarning,inactiveModeratorsInvitationOnlyChanged}', 'https://hooks.example/m', 's')`,
  );
});

const rows = async (sql: string, p: unknown[] = []) => (await f.db.query(sql, p)).rows as any[];
const HOUR = 3600_000;

describe("checkModeratorsActivity", () => {
  const now = new Date("2026-03-10T12:30:00Z");
  const limit = new Date(now);
  limit.setDate(now.getDate() - 7);
  const setActive = async (who: "a" | "b" | "c", d: Date | null) =>
    f.db.query(`UPDATE "user" SET "lastActiveDate" = $2 WHERE id = $1`, [f.ids[who], d]);

  beforeEach(async () => {
    hooks.length = 0;
    mails.length = 0;
    await f.db.query(`UPDATE meta SET "disableRegistration" = FALSE`);
    await f.db.query(`DELETE FROM announcement`);
    for (const w of ["a", "b", "c"] as const) await setActive(w, null);
  });

  it("no lastActiveDate on any moderator → invitation-only (as upstream: 0 of 0 evaluated are active)", async () => {
    await setActive("c", new Date(0)); // not a moderator
    assert.deepEqual(await checkModeratorsActivity(f.env, now), { action: "changedToInvitationOnly" });
    assert.equal(hooks[0]!.type, "inactiveModeratorsInvitationOnlyChanged");
    assert.deepEqual(mails.map((m) => [m.to, m.subject]), [["b@example.org", "Change to Invitation-Only / 招待制に変更されました"]]);
    assert.match(mails[0]!.html!, /To Moderators,<br><br>Changed to invitation only/);
  });

  it("an active moderator → ok", async () => {
    await setActive("a", new Date(0));
    await setActive("b", new Date(now.getTime() - HOUR));
    assert.equal((await checkModeratorsActivity(f.env, now)).action, "ok");
    assert.equal(hooks.length, 0);
  });

  it("≤ 2 days left: warning every 6 hours", async () => {
    await setActive("b", new Date(limit.getTime() + 48 * HOUR));
    const r = await checkModeratorsActivity(f.env, now);
    assert.equal(r.action, "warned");
    assert.equal(hooks.length, 1);
    assert.equal(hooks[0]!.type, "inactiveModeratorsWarning");
    assert.deepEqual(hooks[0]!.content, { remainingTime: { time: 48 * HOUR, asHours: 48, asDays: 2 } });
    // generateModeratorInactivityMail to moderators with a verified address
    assert.deepEqual(mails.map((m) => [m.to, m.subject]), [["b@example.org", "Moderator Inactivity Warning / モデレーター不在の通知"]]);
    assert.match(mails[0]!.text!, /If there are 2 days of inactivity left/);
    assert.match(mails[0]!.text!, /あと2 日間活動していない/);
    hooks.length = 0;
    mails.length = 0;
    await setActive("b", new Date(limit.getTime() + 47 * HOUR + 1000));
    assert.equal((await checkModeratorsActivity(f.env, now)).action, "warningPending");
    await setActive("b", new Date(limit.getTime() + 6 * HOUR + 1000));
    const r2 = await checkModeratorsActivity(f.env, now);
    assert.equal(r2.action, "warned");
    assert.equal(hooks[0]!.content.remainingTime.asDays, 0);
    assert.equal(hooks[0]!.content.remainingTime.asHours, 6);
    // 3 days left → no warning yet
    hooks.length = 0;
    await setActive("b", new Date(limit.getTime() + 72 * HOUR));
    assert.equal((await checkModeratorsActivity(f.env, now)).action, "ok");
    assert.equal(hooks.length, 0);
  });

  it("all inactive for 7 days → invitation-only, announcements, webhook", async () => {
    await setActive("a", new Date(limit.getTime() - 10 * HOUR));
    await setActive("b", new Date(limit.getTime() - 1000));
    await setActive("c", new Date(now)); // plain users do not count
    assert.equal((await checkModeratorsActivity(f.env, now)).action, "changedToInvitationOnly");
    assert.equal((await rows(`SELECT "disableRegistration" AS d FROM meta`))[0].d, true);
    const ann = await rows(`SELECT "userId", title, "needConfirmationToRead", "forExistingUsers" FROM announcement ORDER BY "userId"`);
    assert.deepEqual(ann.map((x) => x.userId).sort(), [f.ids.a, f.ids.b].sort());
    assert.ok(ann.every((x) => x.needConfirmationToRead && x.forExistingUsers && /Invitation-Only/.test(x.title)));
    assert.deepEqual(hooks.map((h) => [h.type, h.content]), [["inactiveModeratorsInvitationOnlyChanged", {}]]);
    // the moderator sees it through announcements
    const mine = await f.call("announcements", {}, "b");
    assert.ok(mine.data.some((x: any) => /Invitation-Only/.test(x.title)));
    // already invitation-only → no-op
    hooks.length = 0;
    assert.equal((await checkModeratorsActivity(f.env, now)).action, "alreadyInvitationOnly");
    assert.equal(hooks.length, 0);
  });

  it("expired moderator assignments do not count", async () => {
    await f.db.query(`UPDATE role_assignment SET "expiresAt" = now() - interval '1 day' WHERE "roleId" = $1`, [modRole]);
    await setActive("a", new Date(limit.getTime() - HOUR));
    await setActive("b", new Date(now)); // active, but no longer a moderator
    assert.equal((await checkModeratorsActivity(f.env, now)).action, "changedToInvitationOnly");
    await f.db.query(`UPDATE role_assignment SET "expiresAt" = NULL WHERE "roleId" = $1`, [modRole]);
  });
});

describe("lastActiveDate", () => {
  it("touchLastActiveDate wakes a hibernated user", async () => {
    await f.db.query(`UPDATE "user" SET "lastActiveDate" = NULL, "isHibernated" = TRUE WHERE id = $1`, [f.ids.c]);
    await f.db.query(`INSERT INTO following (id, "followerId", "followeeId", "isFollowerHibernated") VALUES ('h1', $1, $2, TRUE)`, [f.ids.c, f.ids.a]);
    await touchLastActiveDate(f.env, f.ids.c);
    const u = (await rows(`SELECT "lastActiveDate", "isHibernated" FROM "user" WHERE id = $1`, [f.ids.c]))[0];
    assert.ok(u.lastActiveDate && Date.now() - new Date(u.lastActiveDate).getTime() < 60_000);
    assert.equal(u.isHibernated, false);
    assert.equal((await rows(`SELECT "isFollowerHibernated" AS h FROM following WHERE id = 'h1'`))[0].h, false);
    await f.db.query(`DELETE FROM following WHERE id = 'h1'`);
  });

  it("streaming connect updates lastActiveDate", async () => {
    await f.db.query(`UPDATE "user" SET "lastActiveDate" = NULL WHERE id = $1`, [f.ids.b]);
    const env = {
      ...f.env,
      STREAM_HUB: { idFromName: (n: string) => ({ toString: () => n }), get: () => ({ fetch: async () => new Response(null, { status: 200 }) }) },
    } as unknown as ApiEnv;
    const res = await handleStreamingUpgrade(new Request(`https://local.example/streaming?i=${TOK.b}`, { headers: { Upgrade: "websocket" } }), env);
    assert.equal(res.status, 200);
    assert.ok((await rows(`SELECT "lastActiveDate" FROM "user" WHERE id = $1`, [f.ids.b]))[0].lastActiveDate);
  });
});

describe("instance stats backfill", () => {
  const B = "admin/cf-debug/backfill-instances";
  const inst = async (host: string) => (await rows(`SELECT "usersCount" AS u, "notesCount" AS n, "followingCount" AS fi, "followersCount" AS fe FROM instance WHERE host = $1`, [host]))[0];
  let seq = 0;
  const remoteUser = async (host: string) => {
    const id = genAidx(Date.now() + 5_000_000 + seq++);
    await f.db.query(`INSERT INTO "user" (id, username, "usernameLower", host) VALUES ($1, $2, $2, $3)`, [id, `r${seq}`, host]);
    return id;
  };

  it("recomputes counters and creates missing rows (inline)", async () => {
    const r1a = await remoteUser("r1.example");
    await remoteUser("r1.example");
    const r2 = await remoteUser("r2.example");
    for (let i = 0; i < 3; i++) await f.note(r1a, { userHost: "r1.example" });
    await f.db.query(`INSERT INTO following (id, "followerId", "followeeId", "followerHost", "followeeHost") VALUES ('bf1', $1, $2, 'r1.example', NULL)`, [r1a, f.ids.a]);
    await f.db.query(`INSERT INTO following (id, "followerId", "followeeId", "followerHost", "followeeHost") VALUES ('bf2', $1, $2, NULL, 'r2.example')`, [f.ids.c, r2]);
    await f.db.query(`INSERT INTO instance (id, host, "firstRetrievedAt", "usersCount", "notesCount") VALUES ('i3', 'r3.example', now(), 99, 99)`);

    assert.equal((await f.call(B, {})).status, 401);
    assert.equal((await f.call(B, {}, "c")).status, 403);
    const r = await f.call(B, {}, "b");
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.queued, false);
    assert.deepEqual(await inst("r1.example"), { u: 2, n: 3, fi: 1, fe: 0 });
    assert.deepEqual(await inst("r2.example"), { u: 1, n: 0, fi: 0, fe: 1 });
    assert.deepEqual(await inst("r3.example"), { u: 0, n: 0, fi: 0, fe: 0 });
  });

  it("runs as bounded mk-jobs steps", async () => {
    await f.db.query(
      `INSERT INTO "user" (id, username, "usernameLower", host)
       SELECT 'bulk' || g, 'bulk' || g, 'bulk' || g, 'h' || lpad(g::text, 3, '0') || '.example' FROM generate_series(1, $1::int) g`,
      [BACKFILL_HOSTS_PER_STEP + 5],
    );
    const sent: JobMessage[] = [];
    const env = { ...f.env, Q_JOBS: { send: async (b: unknown) => void sent.push(b as JobMessage) } } as ApiEnv;
    const { handlers } = await import("./endpoints/index.js");
    const res = await handlers[B]!(env, { i: TOK.a }, { hasCredential: true, request: new Request(`https://api.test/api/${B}`, { method: "POST" }) });
    assert.deepEqual(res, { queued: true, steps: 0 });
    assert.deepEqual(sent, [{ kind: "backfillInstances", phase: "register" }]);
    const phases: string[] = [];
    let job: JobMessage | null = sent[0]!;
    while (job) {
      phases.push((job as { phase: string }).phase);
      job = await runJobStep(env, job);
    }
    assert.deepEqual(phases, ["register", "register", "count", "count"]);
    assert.equal((await rows(`SELECT count(*)::int AS n FROM instance WHERE host LIKE 'h%.example'`))[0].n, BACKFILL_HOSTS_PER_STEP + 5);
    assert.deepEqual(await inst("h055.example"), { u: 1, n: 0, fi: 0, fe: 0 });
  });
});

describe("router: upstream cacheSec / allowGet", () => {
  const env = () => f.env;
  const record = async (score: number) =>
    f.db.query(`INSERT INTO bubble_game_record (id, "userId", "seededAt", seed, "gameVersion", "gameMode", score) VALUES ($1, $2, now(), 's', 1, 'normal', $3)`, [genAidx(Date.now() + score), f.ids.c, score]);

  it("generated meta carries allowGet / cacheSec", () => {
    assert.deepEqual(ENDPOINT_META["bubble-game/ranking"], { allowGet: true, cacheSec: 60 });
    assert.equal(ENDPOINT_META["charts/users"]!.cacheSec, 3600);
    assert.equal(ENDPOINT_META["notes/show"]!.allowGet, undefined);
  });

  it("bubble-game/ranking: anonymous GET gets Cache-Control public, max-age=60 (header only)", async () => {
    await record(10);
    const get = (headers: Record<string, string> = {}) => dispatchApi(new Request("https://api.test/api/bubble-game/ranking?gameMode=normal", { headers }), env());
    let r = await get();
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("Cache-Control"), "public, max-age=60");
    assert.equal(((await r.json()) as unknown[]).length, 1);
    await record(20);
    r = await get();
    assert.equal(((await r.json()) as unknown[]).length, 2, "no server-side cache");
    // credentialed GET: fresh, private
    r = await get({ Authorization: `Bearer ${TOK.c}` });
    assert.equal(r.headers.get("Cache-Control"), "private, max-age=0, must-revalidate");
    assert.equal(((await r.json()) as unknown[]).length, 2);
    // POST: fresh, private
    r = await dispatchApi(new Request("https://api.test/api/bubble-game/ranking", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ gameMode: "normal" }) }), env());
    assert.equal(r.headers.get("Cache-Control"), "private, max-age=0, must-revalidate");
    assert.equal(((await r.json()) as unknown[]).length, 2);
  });

  it("GET on an endpoint without allowGet → 405; other responses are private", async () => {
    const r = await dispatchApi(new Request("https://api.test/api/notes/show?noteId=x"), env());
    assert.equal(r.status, 405);
    assert.equal(r.headers.get("Cache-Control"), "private, max-age=0, must-revalidate");
    const p = await dispatchApi(new Request("https://api.test/api/ping", { method: "POST" }), env());
    assert.equal(p.status, 200);
    assert.equal(p.headers.get("Cache-Control"), "private, max-age=0, must-revalidate");
  });
});

describe("clean (CleanProcessorService)", () => {
  it("deactivates unused antennas and drops old user_ip rows, expired role assignments and stale reversi games", async () => {
    const now = Date.now();
    const day = 86400_000;
    const ago = (ms: number) => new Date(now - ms).toISOString();
    await f.db.query(`DELETE FROM antenna`);
    await f.db.query(
      `INSERT INTO antenna (id, "userId", name, src, "withFile", "lastUsedAt", "isActive") VALUES
       ('old', $1, 'old', 'all', FALSE, $2, TRUE), ('recent', $1, 'recent', 'all', FALSE, $3, TRUE)`,
      [f.ids.b, ago(8 * day), ago(6 * day)],
    );
    await f.db.query(`INSERT INTO user_ip ("createdAt", "userId", ip) VALUES ($1, $3, '1.1.1.1'), ($2, $3, '2.2.2.2')`, [ago(91 * day), ago(89 * day), f.ids.b]);
    await f.db.query(`INSERT INTO role (id, name, description, "updatedAt", "lastUsedAt") VALUES ('r1', 'r1', '', now(), now()), ('r2', 'r2', '', now(), now()), ('r3', 'r3', '', now(), now())`);
    await f.db.query(`INSERT INTO role_assignment (id, "userId", "roleId", "expiresAt") VALUES ('ra-exp', $1, 'r1', $2), ('ra-live', $1, 'r2', $3), ('ra-none', $1, 'r3', NULL)`, [f.ids.b, ago(1000), ago(-day)]);
    await f.db.query(`INSERT INTO reversi_game (id, "user1Id", "user2Id", map, bw, "isStarted") VALUES ($1, $4, $5, '{}', 'random', FALSE), ($2, $4, $5, '{}', 'random', TRUE), ($3, $4, $5, '{}', 'random', FALSE)`, [
      genAidx(now - 11 * 60_000), genAidx(now - 11 * 60_000 + 1), genAidx(now - 60_000), f.ids.a, f.ids.b,
    ]);
    const { runCleanPg } = await import("./maintenance-pg.js");
    const r = await runCleanPg(f.env, now);
    assert.deepEqual(r, { userIps: 1, antennas: 1, roleAssignments: 1, reversiGames: 1 });
    const active = (await f.db.query(`SELECT id, "isActive" FROM antenna ORDER BY id`)).rows as { id: string; isActive: boolean }[];
    assert.deepEqual(active, [{ id: "old", isActive: false }, { id: "recent", isActive: true }]);
    assert.deepEqual(((await f.db.query(`SELECT id FROM role_assignment WHERE id LIKE 'ra-%' ORDER BY id`)).rows as { id: string }[]).map((x) => x.id), ["ra-live", "ra-none"]);

    // antennas/notes reactivates (existing behaviour); a threshold of 0 never deactivates
    f.env.DEACTIVATE_ANTENNA_THRESHOLD = "0";
    try {
      await f.db.query(`UPDATE antenna SET "isActive" = TRUE`);
      assert.equal((await runCleanPg(f.env, now)).antennas, 0);
    } finally {
      delete f.env.DEACTIVATE_ANTENNA_THRESHOLD;
    }
  });
});
