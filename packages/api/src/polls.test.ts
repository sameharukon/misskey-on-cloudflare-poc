/**
 * Polls on PG (PGlite): notes/create with poll, packed `poll`, notes/polls/vote
 * (single/multiple, error ids), recommendation, PollTimer alarm → pollEnded.
 */
import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { genAidx } from "../../id/src/index.js";
import { fixtureMeta } from "../../packers/src/fixtures.js";
import type { ApiEnv } from "./env.js";
import type { PgQueryable } from "./pg.js";
import { handlers } from "./endpoints/index.js";
import { IMPLEMENTED_ENDPOINTS } from "./registry.js";
import { notifyPollEnded, PollTimer, validatePollParam } from "./polls-pg.js";
import { listNotifications } from "./notifications-do.js";
import { NotificationBox } from "../../timeline/src/index.js";
import { fakeDoNamespace } from "./pglite-fixture.js";
import { ENDPOINT_PARAM_DEFS } from "./endpoint-params.gen.js";

const SCHEMA = `
CREATE TYPE note_visibility_enum AS ENUM ('public', 'home', 'followers', 'specified');
CREATE TABLE "user" (id varchar PRIMARY KEY, username varchar, "usernameLower" varchar, name varchar, host varchar,
  token varchar, "isBot" bool DEFAULT false, "isCat" bool DEFAULT false, "isSuspended" bool DEFAULT false,
  "avatarId" varchar, "avatarUrl" varchar, "avatarBlurhash" varchar, "bannerId" varchar, "bannerUrl" varchar, "bannerBlurhash" varchar,
  "hideOnlineStatus" bool DEFAULT false, "lastActiveDate" timestamptz, "requireSigninToViewContents" bool DEFAULT false,
  "isLocked" bool DEFAULT false, "followersCount" int DEFAULT 0, "followingCount" int DEFAULT 0, "notesCount" int DEFAULT 0,
  "updatedAt" timestamptz, "lastFetchedAt" timestamptz, "movedToUri" varchar, "alsoKnownAs" text, uri varchar,
  "isExplorable" bool DEFAULT true);
CREATE TABLE user_profile ("userId" varchar PRIMARY KEY, "alwaysMarkNsfw" bool DEFAULT false);
CREATE TABLE meta (id varchar, "rootUserId" varchar);
CREATE TABLE role (id varchar PRIMARY KEY, policies jsonb DEFAULT '{}', "isModerator" bool DEFAULT false, "isAdministrator" bool DEFAULT false,
  name varchar DEFAULT '', description varchar DEFAULT '', color varchar, "iconUrl" varchar, target varchar DEFAULT 'manual', "condFormula" jsonb DEFAULT '{}',
  "isPublic" bool DEFAULT false, "isExplorable" bool DEFAULT false, "asBadge" bool DEFAULT false, "displayOrder" int DEFAULT 0);
CREATE TABLE role_assignment (id varchar, "userId" varchar, "roleId" varchar, "expiresAt" timestamptz);
CREATE TABLE note (id varchar PRIMARY KEY, "replyId" varchar, "renoteId" varchar, "threadId" varchar, text text, name varchar, cw varchar,
  "userId" varchar, "localOnly" bool DEFAULT false, "reactionAcceptance" varchar, "renoteCount" int DEFAULT 0, "repliesCount" int DEFAULT 0,
  "clippedCount" int DEFAULT 0, "pageCount" int DEFAULT 0, reactions jsonb DEFAULT '{}', visibility varchar DEFAULT 'public', uri varchar, url varchar,
  "fileIds" varchar[] DEFAULT '{}', "attachedFileTypes" varchar[] DEFAULT '{}', "visibleUserIds" varchar[] DEFAULT '{}', mentions varchar[] DEFAULT '{}',
  "mentionedRemoteUsers" text DEFAULT '[]', "reactionAndUserPairCache" varchar[] DEFAULT '{}', emojis varchar[] DEFAULT '{}', tags varchar[] DEFAULT '{}',
  "hasPoll" bool DEFAULT false, "channelId" varchar, "userHost" varchar, "replyUserId" varchar, "replyUserHost" varchar,
  "renoteUserId" varchar, "renoteUserHost" varchar, "renoteChannelId" varchar);
CREATE TABLE note_reaction (id varchar, "userId" varchar, "noteId" varchar, reaction varchar);
CREATE TABLE following (id varchar, "followerId" varchar, "followeeId" varchar, "followerHost" varchar, "followeeHost" varchar, notify varchar);
CREATE TABLE muting (id varchar, "muterId" varchar, "muteeId" varchar, "expiresAt" timestamptz);
CREATE TABLE blocking (id varchar, "blockerId" varchar, "blockeeId" varchar);
CREATE TABLE renote_muting (id varchar, "muterId" varchar, "muteeId" varchar);
CREATE TABLE drive_file (id varchar PRIMARY KEY, "userId" varchar, type varchar);
CREATE TYPE poll_notevisibility_enum AS ENUM ('public', 'home', 'followers', 'specified');
CREATE TABLE poll ("noteId" varchar(32) PRIMARY KEY REFERENCES note(id) ON DELETE CASCADE, "expiresAt" timestamptz, multiple boolean NOT NULL,
  choices varchar(256)[] NOT NULL DEFAULT '{}', votes integer[] NOT NULL, "noteVisibility" poll_notevisibility_enum NOT NULL,
  "userId" varchar(32) NOT NULL, "userHost" varchar(128), "channelId" varchar(32));
CREATE TABLE poll_vote (id varchar(32) PRIMARY KEY, "userId" varchar(32) NOT NULL, "noteId" varchar(32) NOT NULL REFERENCES note(id) ON DELETE CASCADE, choice integer NOT NULL);
CREATE UNIQUE INDEX poll_vote_uniq ON poll_vote ("userId", "noteId", choice);
`;

const db = new PGlite();
const client: PgQueryable = {
  async query(text, params = []) {
    const r = await db.query(text, params as unknown[]);
    return { rows: r.rows as Record<string, unknown>[], rowCount: r.affectedRows ?? r.rows.length };
  },
};

const env: ApiEnv = {
  INSTANCE_URL: "https://misskey.example.com",
  BOOTSTRAP_META_JSON: JSON.stringify(fixtureMeta({ name: "PollTest" })),
  HYPERDRIVE: { connectionString: "postgres://test", __testClient: client } as unknown as ApiEnv["HYPERDRIVE"],
  NOTIFICATION_BOX: fakeDoNamespace((st) => new NotificationBox(st as never)) as unknown as ApiEnv["NOTIFICATION_BOX"],
};

const ids = { a: genAidx(Date.now() - 100000), b: genAidx(Date.now() - 90000), c: genAidx(Date.now() - 80000) };
const TOK = { a: "aaaaaaaaaaaaaaaa", b: "bbbbbbbbbbbbbbbb", c: "cccccccccccccccc" };
type Who = keyof typeof TOK;

async function call(name: string, body: Record<string, unknown>, who?: Who): Promise<{ status: number; data: any }> {
  const b = who ? { ...body, i: TOK[who] } : body;
  const r = await handlers[name]!(env, b, { hasCredential: Boolean(who), request: new Request("https://api.test/api/" + name, { method: "POST" }) });
  if (r instanceof Response) return { status: r.status, data: r.status === 204 ? null : await r.json() };
  return { status: 200, data: r };
}

before(async () => {
  await db.exec(SCHEMA);
  for (const [k, id] of Object.entries(ids)) {
    await db.query(`INSERT INTO "user" (id, username, "usernameLower", token) VALUES ($1, $2, $3, $4)`, [id, `user_${k}`, `user_${k}`, TOK[k as Who]]);
  }
  await db.query(`INSERT INTO meta (id, "rootUserId") VALUES ('x', $1)`, [ids.a]);
});

describe("polls", () => {
  let single = "";
  let multi = "";

  it("registers endpoints", () => {
    for (const e of ["notes/polls/vote", "notes/polls/recommendation"]) {
      assert.ok((IMPLEMENTED_ENDPOINTS as readonly string[]).includes(e), e);
      assert.ok(ENDPOINT_PARAM_DEFS[e], e);
    }
  });

  it("validates the poll param like upstream", () => {
    const now = 1_000_000;
    assert.equal((validatePollParam({ choices: ["a"] }, now) as any).code, "INVALID_PARAM");
    assert.equal((validatePollParam({ choices: ["a", "a"] }, now) as any).code, "INVALID_PARAM");
    assert.equal((validatePollParam({ choices: ["a", "x".repeat(51)] }, now) as any).code, "INVALID_PARAM");
    assert.equal((validatePollParam({ choices: Array.from({ length: 11 }, (_, i) => String(i)) }, now) as any).code, "INVALID_PARAM");
    assert.equal((validatePollParam({ choices: ["a", "b"], expiresAt: now - 1 }, now) as any).id, "04da457d-b083-4055-9082-955525eda5a5");
    assert.deepEqual(validatePollParam({ choices: ["a", "b"], expiredAfter: 5000 }, now), { choices: ["a", "b"], multiple: false, expiresAt: new Date(now + 5000) });
    assert.equal(validatePollParam(null, now), null);
  });

  it("notes/create with poll (no text) packs poll", async () => {
    const r = await call("notes/create", { poll: { choices: ["red", "blue", "green"] } }, "a");
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const n = r.data.createdNote;
    single = n.id;
    assert.equal(n.hasPoll, true);
    assert.deepEqual(n.poll, { multiple: false, expiresAt: null, choices: ["red", "blue", "green"].map((text) => ({ text, votes: 0, isVoted: false })) });
    const row = (await db.query(`SELECT "noteVisibility", votes FROM poll WHERE "noteId" = $1`, [single])).rows[0] as any;
    assert.equal(row.noteVisibility, "public");
    assert.deepEqual(row.votes, [0, 0, 0]);
    const expired = await call("notes/create", { text: "late", poll: { choices: ["a", "b"], expiresAt: Date.now() - 1000 } }, "a");
    assert.equal(expired.data.error.code, "CANNOT_CREATE_ALREADY_EXPIRED_POLL");
    const m = await call("notes/create", { text: "multi", poll: { choices: ["x", "y"], multiple: true, expiredAfter: 3_600_000 } }, "a");
    multi = m.data.createdNote.id;
    assert.equal(m.data.createdNote.poll.multiple, true);
    assert.ok(Date.parse(m.data.createdNote.poll.expiresAt) > Date.now());
  });

  it("vote: single choice, already voted, invalid choice, isVoted in pack", async () => {
    assert.equal((await call("notes/polls/vote", { noteId: single, choice: 1 }, "b")).status, 204);
    assert.equal((await call("notes/polls/vote", { noteId: single, choice: 2 }, "b")).data.error.code, "ALREADY_VOTED");
    assert.equal((await call("notes/polls/vote", { noteId: single, choice: 9 }, "c")).data.error.code, "INVALID_CHOICE");
    assert.equal((await call("notes/polls/vote", { noteId: single, choice: 1 }, "a")).status, 204); // own poll is votable upstream
    const shown = await call("notes/show", { noteId: single }, "b");
    assert.deepEqual(shown.data.poll.choices.map((c: any) => [c.votes, c.isVoted]), [[0, false], [2, true], [0, false]]);
    const anon = await call("notes/show", { noteId: single });
    assert.equal(anon.data.poll.choices[1].isVoted, false);
  });

  it("vote: multiple choices; errors for missing note / no poll / blocked / expired", async () => {
    assert.equal((await call("notes/polls/vote", { noteId: multi, choice: 0 }, "b")).status, 204);
    assert.equal((await call("notes/polls/vote", { noteId: multi, choice: 1 }, "b")).status, 204);
    assert.equal((await call("notes/polls/vote", { noteId: multi, choice: 1 }, "b")).data.error.code, "ALREADY_VOTED");
    const shown = await call("notes/show", { noteId: multi }, "b");
    assert.deepEqual(shown.data.poll.choices.map((c: any) => c.isVoted), [true, true]);
    assert.equal((await call("notes/polls/vote", { noteId: "nope", choice: 0 }, "b")).data.error.id, "ecafbd2e-c283-4d6d-aecb-1a0a33b75396");
    const plain = await call("notes/create", { text: "no poll" }, "a");
    assert.equal((await call("notes/polls/vote", { noteId: plain.data.createdNote.id, choice: 0 }, "b")).data.error.code, "NO_POLL");
    await db.query(`INSERT INTO blocking (id, "blockerId", "blockeeId") VALUES ('blk', $1, $2)`, [ids.a, ids.c]);
    assert.equal((await call("notes/polls/vote", { noteId: multi, choice: 0 }, "c")).data.error.code, "YOU_HAVE_BEEN_BLOCKED");
    await db.query(`DELETE FROM blocking`);
    await db.query(`UPDATE poll SET "expiresAt" = now() - interval '1 minute' WHERE "noteId" = $1`, [multi]);
    assert.equal((await call("notes/polls/vote", { noteId: multi, choice: 0 }, "c")).data.error.code, "ALREADY_EXPIRED");
    assert.equal((await call("notes/polls/vote", { noteId: multi, choice: 0 })).status, 401);
  });

  it("recommendation: others' open public polls not yet voted, minus muted", async () => {
    const forC = await call("notes/polls/recommendation", {}, "c");
    assert.deepEqual(forC.data.map((n: any) => n.id), [single]); // multi expired
    assert.equal((await call("notes/polls/recommendation", {}, "b")).data.length, 0); // voted
    assert.equal((await call("notes/polls/recommendation", {}, "a")).data.length, 0); // own
    await db.query(`INSERT INTO muting (id, "muterId", "muteeId") VALUES ('m1', $1, $2)`, [ids.c, ids.a]);
    assert.equal((await call("notes/polls/recommendation", {}, "c")).data.length, 0);
    await db.query(`DELETE FROM muting`);
    const followersOnly = await call("notes/create", { text: "f", visibility: "followers", poll: { choices: ["1", "2"] } }, "a");
    assert.equal(followersOnly.status, 200);
    assert.deepEqual((await call("notes/polls/recommendation", {}, "c")).data.map((n: any) => n.id), [single]);
  });

  it("poll end: author + voters get pollEnded (PollTimer alarm)", async () => {
    const targets = await notifyPollEnded(env, single);
    assert.deepEqual(new Set(targets), new Set([ids.a, ids.b]));
    for (const uid of [ids.a, ids.b]) {
      const list = await listNotifications(env, uid, { limit: 50 });
      assert.ok(list.some((n) => n.type === "pollEnded" && n.noteId === single), uid);
    }
    // DO: schedule then alarm
    const mem = new Map<string, unknown>();
    let alarmAt: number | null = null;
    const state = {
      storage: {
        get: async <T,>(k: string) => mem.get(k) as T | undefined,
        put: async (k: string, v: unknown) => void mem.set(k, v),
        deleteAll: async () => void mem.clear(),
        setAlarm: async (t: number) => void (alarmAt = t),
        getAlarm: async () => alarmAt,
      },
    };
    const timer = new PollTimer(state, env);
    const when = Date.now() + 60_000;
    const r = await timer.fetch(new Request("https://poll.internal/schedule", { method: "POST", body: JSON.stringify({ noteId: multi, expiresAt: when }) }));
    assert.equal(r.status, 200);
    assert.equal(alarmAt, when);
    await timer.alarm();
    assert.equal(mem.size, 0);
    const listB = await listNotifications(env, ids.b, { limit: 50 });
    assert.ok(listB.some((n) => n.type === "pollEnded" && n.noteId === multi));
  });

  it("deleting the note removes the poll (FK cascade) and the alarm is a no-op", async () => {
    await call("notes/delete", { noteId: single }, "a");
    assert.equal((await db.query(`SELECT 1 FROM poll WHERE "noteId" = $1`, [single])).rows.length, 0);
    assert.deepEqual(await notifyPollEnded(env, single), []);
  });
});
