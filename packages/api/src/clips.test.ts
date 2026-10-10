/**
 * Clips on PG (PGlite): CRUD, add/remove note (limits, duplicates, clippedCount),
 * visibility of private clips, favorites, clips/notes (+search), notes/clips, users/clips.
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
import { likeEscape } from "./clips-pg.js";
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
CREATE TABLE clip (id varchar(32) PRIMARY KEY, "lastClippedAt" timestamptz, "userId" varchar(32) NOT NULL, name varchar(128) NOT NULL, "isPublic" boolean NOT NULL DEFAULT false, description varchar(2048));
CREATE TABLE clip_note (id varchar(32) PRIMARY KEY, "noteId" varchar(32) NOT NULL REFERENCES note(id) ON DELETE CASCADE, "clipId" varchar(32) NOT NULL REFERENCES clip(id) ON DELETE CASCADE);
CREATE UNIQUE INDEX clip_note_uniq ON clip_note ("noteId", "clipId");
CREATE TABLE clip_favorite (id varchar(32) PRIMARY KEY, "userId" varchar(32) NOT NULL, "clipId" varchar(32) NOT NULL REFERENCES clip(id) ON DELETE CASCADE);
CREATE UNIQUE INDEX clip_favorite_uniq ON clip_favorite ("userId", "clipId");
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
  BOOTSTRAP_META_JSON: JSON.stringify(fixtureMeta({ name: "ClipTest" })),
  HYPERDRIVE: { connectionString: "postgres://test", __testClient: client } as unknown as ApiEnv["HYPERDRIVE"],
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

describe("clips", () => {
  let pub = "";
  let priv = "";
  let n1 = "";
  let n2 = "";

  it("registers endpoints", () => {
    for (const e of ["clips/create", "clips/update", "clips/delete", "clips/list", "clips/show", "clips/notes", "clips/add-note", "clips/remove-note", "clips/favorite", "clips/unfavorite", "clips/my-favorites", "notes/clips", "users/clips"]) {
      assert.ok((IMPLEMENTED_ENDPOINTS as readonly string[]).includes(e), e);
      assert.ok(ENDPOINT_PARAM_DEFS[e], e);
    }
    assert.equal(likeEscape("50%_a\\"), "50\\%\\_a\\\\");
  });

  it("create / update / show / list with upstream pack shape", async () => {
    const r = await call("clips/create", { name: "public clip", isPublic: true, description: "" }, "a");
    assert.equal(r.status, 200, JSON.stringify(r.data));
    pub = r.data.id;
    assert.equal(r.data.description, null); // `description || null`
    assert.equal(r.data.isPublic, true);
    assert.equal(r.data.favoritedCount, 0);
    assert.equal(r.data.isFavorited, false);
    assert.equal(r.data.notesCount, 0);
    assert.equal(r.data.lastClippedAt, null);
    assert.equal(r.data.user.username, "user_a");
    priv = (await call("clips/create", { name: "private" }, "a")).data.id;
    assert.equal((await call("clips/create", { name: "" }, "a")).data.error.code, "INVALID_PARAM");
    assert.equal((await call("clips/create", { name: "x" })).status, 401);
    const u = await call("clips/update", { clipId: pub, name: "renamed", description: "desc" }, "a");
    assert.equal(u.data.name, "renamed");
    assert.equal(u.data.description, "desc");
    assert.equal(u.data.isPublic, true);
    assert.equal((await call("clips/update", { clipId: pub, name: "steal" }, "b")).data.error.id, "b4d92d70-b216-46fa-9a3f-a8c811699257");
    const showB = await call("clips/show", { clipId: pub }, "b");
    assert.equal(showB.data.notesCount, undefined); // only for the owner
    assert.equal(showB.data.isFavorited, false);
    const anon = await call("clips/show", { clipId: pub });
    assert.ok(!("isFavorited" in anon.data));
    assert.equal((await call("clips/show", { clipId: priv }, "b")).data.error.id, "c3c5fe33-d62c-44d2-9ea5-d997703f5c20");
    assert.equal((await call("clips/show", { clipId: priv }, "a")).status, 200);
    assert.deepEqual((await call("clips/list", {}, "a")).data.map((c: any) => c.id), [priv, pub]);
    assert.deepEqual((await call("users/clips", { userId: ids.a }, "b")).data.map((c: any) => c.id), [pub]);
  });

  it("clip limit from policies → TOO_MANY_CLIPS", async () => {
    for (let i = 0; i < 8; i++) assert.equal((await call("clips/create", { name: `c${i}` }, "b")).status, 200);
    assert.equal((await call("clips/create", { name: "c8" }, "b")).status, 200);
    assert.equal((await call("clips/create", { name: "c9" }, "b")).status, 200);
    assert.equal((await call("clips/create", { name: "c10" }, "b")).data.error.id, "920f7c2d-6208-4b76-8082-e632020f5883");
  });

  it("add-note / remove-note / clippedCount / errors", async () => {
    n1 = (await call("notes/create", { text: "hello clip world" }, "b")).data.createdNote.id;
    n2 = (await call("notes/create", { text: "another 100% note" }, "a")).data.createdNote.id;
    assert.equal((await call("clips/add-note", { clipId: pub, noteId: n1 }, "a")).status, 204);
    assert.equal((await call("clips/add-note", { clipId: pub, noteId: n2 }, "a")).status, 204);
    assert.equal((await call("clips/add-note", { clipId: pub, noteId: n1 }, "a")).data.error.code, "ALREADY_CLIPPED");
    assert.equal((await call("clips/add-note", { clipId: pub, noteId: "nope" }, "a")).data.error.id, "fc8c0b49-c7a3-4664-a0a6-b418d386bb8b");
    assert.equal((await call("clips/add-note", { clipId: pub, noteId: n1 }, "b")).data.error.id, "d6e76cc0-a1b5-4c7c-a287-73fa9c716dcf");
    const shown = await call("notes/show", { noteId: n1 }, "b");
    assert.equal(shown.data.clippedCount, 1);
    const clip = await call("clips/show", { clipId: pub }, "a");
    assert.equal(clip.data.notesCount, 2);
    assert.ok(clip.data.lastClippedAt);
    assert.equal((await call("clips/remove-note", { clipId: pub, noteId: n2 }, "a")).status, 204);
    assert.equal((await call("clips/remove-note", { clipId: pub, noteId: n2 }, "a")).data.error.id, "aff017de-190e-434b-893e-33a9ff5049d8");
    assert.equal((await call("clips/remove-note", { clipId: pub, noteId: n2 }, "b")).data.error.id, "b80525c6-97f7-49d7-a42d-ebccd49cfd52");
    assert.equal((await call("notes/show", { noteId: n2 }, "a")).data.clippedCount, 0);
    await call("clips/add-note", { clipId: pub, noteId: n2 }, "a");
  });

  it("clips/notes with search; private clip hidden; notes/clips", async () => {
    const all = await call("clips/notes", { clipId: pub }, "b");
    assert.deepEqual(all.data.map((n: any) => n.id).sort(), [n1, n2].sort());
    const s = await call("clips/notes", { clipId: pub, search: "100%" });
    assert.deepEqual(s.data.map((n: any) => n.id), [n2]);
    const s2 = await call("clips/notes", { clipId: pub, search: "hello world" });
    assert.deepEqual(s2.data.map((n: any) => n.id), [n1]);
    assert.equal((await call("clips/notes", { clipId: priv }, "b")).data.error.id, "1d7645e6-2b6d-4635-b0fe-fe22b0e72e00");
    await call("clips/add-note", { clipId: priv, noteId: n1 }, "a");
    const nc = await call("notes/clips", { noteId: n1 }, "b");
    assert.deepEqual(nc.data.map((c: any) => c.id), [pub]); // public only
    assert.equal((await call("notes/clips", { noteId: "nope" })).data.error.id, "47db1a1c-b0af-458d-8fb4-986e4efafe1e");
  });

  it("favorite / unfavorite / my-favorites", async () => {
    assert.equal((await call("clips/favorite", { clipId: pub }, "b")).status, 204);
    assert.equal((await call("clips/favorite", { clipId: pub }, "b")).data.error.code, "ALREADY_FAVORITED");
    assert.equal((await call("clips/favorite", { clipId: priv }, "b")).data.error.id, "4c2aaeae-80d8-4250-9606-26cb1fdb77a5");
    const mine = await call("clips/my-favorites", {}, "b");
    assert.deepEqual(mine.data.map((c: any) => [c.id, c.isFavorited, c.favoritedCount]), [[pub, true, 1]]);
    assert.equal((await call("clips/unfavorite", { clipId: pub }, "b")).status, 204);
    assert.equal((await call("clips/unfavorite", { clipId: pub }, "b")).data.error.id, "90c3a9e8-b321-4dae-bf57-2bf79bbcc187");
    assert.equal((await call("clips/unfavorite", { clipId: "nope" }, "b")).data.error.id, "2603966e-b865-426c-94a7-af4a01241dc1");
  });

  it("delete cascades clip_note / clip_favorite", async () => {
    await call("clips/favorite", { clipId: pub }, "b");
    assert.equal((await call("clips/delete", { clipId: pub }, "b")).data.error.id, "70ca08ba-6865-4630-b6fb-8494759aa754");
    assert.equal((await call("clips/delete", { clipId: pub }, "a")).status, 204);
    assert.equal((await db.query(`SELECT 1 FROM clip_note WHERE "clipId" = $1`, [pub])).rows.length, 0);
    assert.equal((await db.query(`SELECT 1 FROM clip_favorite WHERE "clipId" = $1`, [pub])).rows.length, 0);
    assert.equal((await call("clips/show", { clipId: pub }, "a")).data.error.code, "NO_SUCH_CLIP");
  });
});
