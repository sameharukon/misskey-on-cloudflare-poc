/**
 * Client boot / daily endpoints against an in-process Postgres (PGlite) with a
 * minimal upstream-shaped schema. Exercises the real SQL.
 */
import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { genAidx } from "../../id/src/index.js";
import { fixtureMeta } from "../../packers/src/fixtures.js";
import type { ApiEnv } from "./env.js";
import type { PgQueryable } from "./pg.js";
import { CLIENT_ENDPOINTS, groupNotifications, packMe, pagination, resetFeaturedCacheForTest, visibilitySql } from "./client-endpoints-pg.js";
import { IMPLEMENTED_ENDPOINTS } from "./registry.js";
import { handlers } from "./endpoints/index.js";

const SCHEMA = `
CREATE TABLE "user" (id varchar PRIMARY KEY, username varchar, "usernameLower" varchar, name varchar, host varchar,
  token varchar, "isBot" bool DEFAULT false, "isCat" bool DEFAULT false, "isSuspended" bool DEFAULT false,
  "avatarId" varchar, "avatarUrl" varchar, "avatarBlurhash" varchar, "bannerId" varchar, "bannerUrl" varchar, "bannerBlurhash" varchar,
  "hideOnlineStatus" bool DEFAULT false, "lastActiveDate" timestamptz, "requireSigninToViewContents" bool DEFAULT false,
  "isLocked" bool DEFAULT false, "followersCount" int DEFAULT 0, "followingCount" int DEFAULT 0, "notesCount" int DEFAULT 0,
  "updatedAt" timestamptz, "lastFetchedAt" timestamptz, "movedToUri" varchar, "alsoKnownAs" text, uri varchar,
  "isExplorable" bool DEFAULT true);
CREATE TABLE user_profile ("userId" varchar PRIMARY KEY, description varchar, location varchar, birthday varchar, lang varchar,
  fields jsonb DEFAULT '[]', url varchar, "followingVisibility" varchar DEFAULT 'public', "followersVisibility" varchar DEFAULT 'public',
  "publicReactions" bool DEFAULT true, "pinnedPageId" varchar, "followedMessage" varchar, achievements jsonb DEFAULT '[]',
  "loggedInDates" varchar[] DEFAULT '{}', "mutedWords" jsonb DEFAULT '[]', "hardMutedWords" jsonb DEFAULT '[]', "mutedInstances" jsonb DEFAULT '[]',
  "notificationRecieveConfig" jsonb DEFAULT '{}', "emailNotificationTypes" jsonb DEFAULT '[]', "alwaysMarkNsfw" bool DEFAULT false,
  "autoSensitive" bool DEFAULT false, "carefulBot" bool DEFAULT false, "autoAcceptFollowed" bool DEFAULT true, "noCrawle" bool DEFAULT false,
  "preventAiLearning" bool DEFAULT true, "injectFeaturedNote" bool DEFAULT true, "receiveAnnouncementEmail" bool DEFAULT true,
  "twoFactorEnabled" bool DEFAULT false, "usePasswordLessLogin" bool DEFAULT false, "securityKeysAvailable" bool DEFAULT false,
  email varchar, "emailVerified" bool DEFAULT false);
CREATE TABLE note (id varchar PRIMARY KEY, "replyId" varchar, "renoteId" varchar, "threadId" varchar, text text, name varchar, cw varchar,
  "userId" varchar, "localOnly" bool DEFAULT false, "reactionAcceptance" varchar, "renoteCount" int DEFAULT 0, "repliesCount" int DEFAULT 0,
  "clippedCount" int DEFAULT 0, "pageCount" int DEFAULT 0, reactions jsonb DEFAULT '{}', visibility varchar DEFAULT 'public', uri varchar, url varchar,
  "fileIds" varchar[] DEFAULT '{}', "attachedFileTypes" varchar[] DEFAULT '{}', "visibleUserIds" varchar[] DEFAULT '{}', mentions varchar[] DEFAULT '{}',
  "mentionedRemoteUsers" text DEFAULT '[]', "reactionAndUserPairCache" varchar[] DEFAULT '{}', emojis varchar[] DEFAULT '{}', tags varchar[] DEFAULT '{}',
  "hasPoll" bool DEFAULT false, "channelId" varchar, "userHost" varchar, "replyUserId" varchar, "replyUserHost" varchar,
  "renoteUserId" varchar, "renoteUserHost" varchar, "renoteChannelId" varchar);
CREATE TABLE following (id varchar, "followerId" varchar, "followeeId" varchar, notify varchar);
CREATE TABLE follow_request (id varchar, "followerId" varchar, "followeeId" varchar);
CREATE TABLE muting (id varchar, "muterId" varchar, "muteeId" varchar, "expiresAt" timestamptz);
CREATE TABLE blocking (id varchar, "blockerId" varchar, "blockeeId" varchar);
CREATE TABLE renote_muting (id varchar, "muterId" varchar, "muteeId" varchar);
CREATE TABLE role (id varchar PRIMARY KEY, policies jsonb DEFAULT '{}', "isModerator" bool DEFAULT false, "isAdministrator" bool DEFAULT false,
  name varchar DEFAULT '', description varchar DEFAULT '', color varchar, "iconUrl" varchar, target varchar DEFAULT 'manual', "condFormula" jsonb DEFAULT '{}',
  "isPublic" bool DEFAULT false, "isExplorable" bool DEFAULT false, "asBadge" bool DEFAULT false, "displayOrder" int DEFAULT 0);
CREATE TABLE role_assignment (id varchar, "userId" varchar, "roleId" varchar, "expiresAt" timestamptz);
CREATE TABLE registry_item (id varchar PRIMARY KEY, "updatedAt" timestamptz, "userId" varchar, key varchar, scope varchar[], domain varchar, value jsonb);
CREATE TABLE note_favorite (id varchar, "userId" varchar, "noteId" varchar);
CREATE TABLE note_thread_muting (id varchar, "userId" varchar, "threadId" varchar);
CREATE TABLE user_note_pining (id varchar, "userId" varchar, "noteId" varchar);
CREATE TABLE announcement (id varchar PRIMARY KEY, "updatedAt" timestamptz, text varchar, title varchar, "imageUrl" varchar, icon varchar DEFAULT 'info',
  display varchar DEFAULT 'normal', "needConfirmationToRead" bool DEFAULT false, "isActive" bool DEFAULT true, "forExistingUsers" bool DEFAULT false,
  silence bool DEFAULT false, "userId" varchar);
CREATE TABLE announcement_read (id varchar, "userId" varchar, "announcementId" varchar, UNIQUE ("userId", "announcementId"));
CREATE TABLE avatar_decoration (id varchar, name varchar, description varchar, url varchar, "roleIdsThatCanBeUsedThisDecoration" varchar[] DEFAULT '{}');
CREATE TABLE meta (id varchar, "rootUserId" varchar, "pinnedUsers" varchar[] DEFAULT '{}');
CREATE TABLE note_reaction (id varchar, "userId" varchar, "noteId" varchar, reaction varchar);
CREATE TABLE drive_file (id varchar, "userId" varchar, md5 varchar, name varchar, type varchar, size int, comment varchar, blurhash varchar,
  properties jsonb DEFAULT '{}', url varchar, "thumbnailUrl" varchar, "isSensitive" bool DEFAULT false, "folderId" varchar, "accessKey" varchar);
CREATE TABLE access_token (id varchar, "userId" varchar, token varchar, hash varchar, permission varchar[], name varchar, "iconUrl" varchar, "lastUsedAt" timestamptz);
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
  VERSION: "0.0.0-test",
  BOOTSTRAP_META_JSON: JSON.stringify(fixtureMeta({ name: "ClientTest" })),
  HYPERDRIVE: { connectionString: "postgres://test", __testClient: client } as unknown as ApiEnv["HYPERDRIVE"],
};

const ids = { a: genAidx(Date.now() - 100000), b: genAidx(Date.now() - 90000), c: genAidx(Date.now() - 80000) };
const TOK = { a: "aaaaaaaaaaaaaaaa", b: "bbbbbbbbbbbbbbbb", c: "cccccccccccccccc" };
const notes: Record<string, string> = {};

async function call(name: string, body: Record<string, unknown>, who?: keyof typeof TOK): Promise<{ status: number; data: any }> {
  const b = who ? { ...body, i: TOK[who] } : body;
  const ctx = { hasCredential: Boolean(who), request: new Request("https://api.test/api/" + name, { method: "POST" }) };
  const r = await CLIENT_ENDPOINTS[name]!(env, b, ctx);
  if (r instanceof Response) return { status: r.status, data: await r.json() };
  return { status: r === null || r === undefined ? 204 : 200, data: r };
}

async function addNote(key: string, user: keyof typeof ids, extra: Record<string, unknown> = {}, ageMs = 50000) {
  const id = genAidx(Date.now() - ageMs);
  const cols = ["id", '"userId"', ...Object.keys(extra).map((k) => `"${k}"`)];
  const vals = [id, ids[user], ...Object.values(extra)];
  await db.query(`INSERT INTO note (${cols.join(",")}) VALUES (${vals.map((_, i) => `$${i + 1}`).join(",")})`, vals);
  notes[key] = id;
  return id;
}

before(async () => {
  await db.exec(SCHEMA);
  for (const [k, id] of Object.entries(ids)) {
    await db.query(`INSERT INTO "user" (id, username, "usernameLower", token) VALUES ($1, $2, $3, $4)`, [id, `user_${k}`, `user_${k}`, TOK[k as keyof typeof TOK]]);
    await db.query(`INSERT INTO user_profile ("userId") VALUES ($1)`, [id]);
  }
  await db.query(`INSERT INTO meta (id, "rootUserId", "pinnedUsers") VALUES ('x', $1, $2)`, [ids.a, ["@user_b", "@nobody"]]);
  await db.query(`INSERT INTO following (id, "followerId", "followeeId") VALUES ('f1', $1, $2)`, [ids.b, ids.a]);
  await addNote("root", "a", { text: "root", reactions: JSON.stringify({ "👍": 3 }) }, 60000);
  await addNote("reply1", "b", { text: "reply", replyId: notes.root, replyUserId: ids.a }, 59000);
  await addNote("reply2", "c", { text: "reply to reply", replyId: notes.reply1, replyUserId: ids.b }, 58000);
  await addNote("renote", "b", { renoteId: notes.root, renoteUserId: ids.a }, 57000);
  await addNote("quote", "c", { text: "quote", renoteId: notes.root, renoteUserId: ids.a }, 56000);
  await addNote("followersOnly", "a", { text: "fo", visibility: "followers", mentions: [] }, 55000);
  await addNote("mention", "a", { text: "@user_c hi", mentions: [ids.c] }, 54000);
});

describe("client endpoints (PGlite)", () => {
  it("registers all endpoints and handlers", () => {
    for (const n of Object.keys(CLIENT_ENDPOINTS)) {
      assert.ok((IMPLEMENTED_ENDPOINTS as readonly string[]).includes(n), `registry: ${n}`);
      assert.ok(handlers[n], `handler: ${n}`);
    }
  });

  it("i/registry: set/get/get-detail/get-all/keys/keys-with-type/remove/scopes-with-domain", async () => {
    assert.equal((await call("i/registry/get", { key: "x", scope: ["client"] }, "a")).data.error.id, "ac3ed68a-62f0-422b-a7bc-d5e09e8f6a6a");
    assert.equal((await call("i/registry/set", { key: "theme", value: { dark: true }, scope: ["client", "base"] }, "a")).status, 204);
    await call("i/registry/set", { key: "count", value: 3, scope: ["client", "base"] }, "a");
    await call("i/registry/set", { key: "count", value: 4, scope: ["client", "base"] }, "a");
    await call("i/registry/set", { key: "other", value: "s", scope: ["client", "base"], domain: "example.app" }, "a");
    assert.deepEqual((await call("i/registry/get", { key: "theme", scope: ["client", "base"] }, "a")).data, { dark: true });
    const d = (await call("i/registry/get-detail", { key: "count", scope: ["client", "base"] }, "a")).data;
    assert.equal(d.value, 4);
    assert.ok(d.updatedAt);
    assert.deepEqual((await call("i/registry/get-all", { scope: ["client", "base"] }, "a")).data, { theme: { dark: true }, count: 4 });
    assert.deepEqual((await call("i/registry/keys", { scope: ["client", "base"] }, "a")).data.sort(), ["count", "theme"]);
    assert.deepEqual((await call("i/registry/keys-with-type", { scope: ["client", "base"] }, "a")).data, { theme: "object", count: "number" });
    assert.deepEqual((await call("i/registry/get-all", { scope: ["client", "base"] }, "b")).data, {});
    const scopes = (await call("i/registry/scopes-with-domain", {}, "a")).data;
    assert.deepEqual(scopes.find((s: any) => s.domain === null).scopes, [["client", "base"]]);
    assert.ok(scopes.find((s: any) => s.domain === "example.app"));
    await call("i/registry/remove", { key: "theme", scope: ["client", "base"] }, "a");
    assert.equal((await call("i/registry/get-detail", { key: "theme", scope: ["client", "base"] }, "a")).data.error.id, "97a1e8e7-c0f7-47d2-957a-92e61256e01a");
    assert.equal((await call("i/registry/get-all", { scope: ["bad-scope!"] }, "a")).status, 400);
    assert.equal((await call("i/registry/get-all", { scope: [] })).status, 401);
  });

  it("notes/children, replies, renotes, conversation, mentions, state", async () => {
    const children = (await call("notes/children", { noteId: notes.root })).data.map((n: any) => n.id).sort();
    assert.deepEqual(children, [notes.reply1, notes.quote].sort(), "pure renote is not a child");
    assert.deepEqual((await call("notes/replies", { noteId: notes.root })).data.map((n: any) => n.id), [notes.reply1]);
    const renotes = (await call("notes/renotes", { noteId: notes.root })).data;
    assert.deepEqual(renotes.map((n: any) => n.id).sort(), [notes.renote, notes.quote].sort());
    assert.equal(renotes.find((n: any) => n.id === notes.renote).renote.id, notes.root, "nested renote packed");
    assert.equal((await call("notes/renotes", { noteId: "nope" })).data.error.id, "12908022-2e21-46cd-ba6a-3edaf6093f46");
    const conv = (await call("notes/conversation", { noteId: notes.reply2 })).data;
    assert.deepEqual(conv.map((n: any) => n.id), [notes.reply1, notes.root]);
    assert.equal((await call("notes/conversation", { noteId: "nope" })).data.error.id, "e1035875-9551-45ec-afa8-1ded1fcb53c8");
    assert.deepEqual((await call("notes/mentions", {}, "c")).data.map((n: any) => n.id), [notes.mention]);
    assert.equal((await call("notes/mentions", {})).status, 401);
    assert.deepEqual((await call("notes/state", { noteId: notes.root }, "b")).data, { isFavorited: false, isMutedThread: false });
  });

  it("visibility: followers-only only for followers; muted authors hidden", async () => {
    const own = async (who?: keyof typeof TOK) =>
      (await call("notes/children", { noteId: notes.root }, who)).data.map((n: any) => n.id);
    assert.equal((await own("a")).length, 2);
    await db.query(`INSERT INTO muting (id, "muterId", "muteeId") VALUES ('m1', $1, $2)`, [ids.a, ids.c]);
    assert.deepEqual(await own("a"), [notes.reply1]);
    await db.query(`DELETE FROM muting`);
    const featured = async (who?: keyof typeof TOK) => {
      resetFeaturedCacheForTest();
      return (await call("notes/featured", {}, who)).data.map((n: any) => n.id);
    };
    assert.deepEqual(await featured(), [notes.root]);
    assert.ok(visibilitySql(null).includes("'public','home'"));
    const p: unknown[] = [];
    assert.equal(pagination({ sinceId: "a" }, p).order, "ASC");
  });

  it("favorites + notes/state + i/favorites + achievement for author", async () => {
    assert.equal((await call("notes/favorites/create", { noteId: notes.root }, "b")).status, 204);
    assert.equal((await call("notes/favorites/create", { noteId: notes.root }, "b")).data.error.code, "ALREADY_FAVORITED");
    assert.equal((await call("notes/favorites/create", { noteId: notes.followersOnly }, "c")).data.error.id, "6dd26674-e060-4816-909a-45ba3f4da458");
    assert.equal((await call("notes/state", { noteId: notes.root }, "b")).data.isFavorited, true);
    const favs = (await call("i/favorites", {}, "b")).data;
    assert.equal(favs[0].noteId, notes.root);
    assert.equal(favs[0].note.id, notes.root);
    const ach = await db.query(`SELECT achievements FROM user_profile WHERE "userId" = $1`, [ids.a]);
    assert.ok((ach.rows[0] as any).achievements.some((x: any) => x.name === "myNoteFavorited1"));
    assert.equal((await call("notes/favorites/delete", { noteId: notes.root }, "b")).status, 204);
    assert.equal((await call("notes/favorites/delete", { noteId: notes.root }, "b")).data.error.id, "b625fc69-635e-45e9-86f4-dbefbef35af5");
  });

  it("users/search-by-username-and-host, pinned-users, get-avatar-decorations", async () => {
    // upstream: a signed-in search only finds non-followed users with an updatedAt
    let r = (await call("users/search-by-username-and-host", { username: "user_", detail: false }, "b")).data;
    assert.deepEqual(r.map((u: any) => u.id), [ids.a], "followed (updatedAt NULL) only");
    await db.query(`UPDATE "user" SET "updatedAt" = now() WHERE id = ANY($1)`, [[ids.b, ids.c]]);
    r = (await call("users/search-by-username-and-host", { username: "user_", detail: false }, "b")).data;
    assert.equal(r[0].id, ids.a, "followed user first");
    assert.equal(r.length, 3);
    assert.deepEqual((await call("users/search-by-username-and-host", { username: "user_c", host: "." })).data.map((u: any) => u.id), [ids.c]);
    assert.deepEqual((await call("users/search-by-username-and-host", { username: "user_c", host: "remote.example" })).data, []);
    assert.deepEqual((await call("pinned-users", {})).data.map((u: any) => u.id), [ids.b]);
    assert.deepEqual((await call("get-avatar-decorations", {})).data, []);
  });

  it("i/pin, i/unpin (limit/ALREADY_PINNED/NO_SUCH_NOTE), MeDetailed shape", async () => {
    const r = await call("i/pin", { noteId: notes.root }, "a");
    assert.deepEqual(r.data.pinnedNoteIds, [notes.root]);
    assert.equal(r.data.pinnedNotes[0].id, notes.root);
    assert.equal((await call("i/pin", { noteId: notes.root }, "a")).data.error.id, "8b18c2b7-68fe-4edb-9892-c0cbaeb6c913");
    assert.equal((await call("i/pin", { noteId: notes.reply1 }, "a")).data.error.id, "56734f8b-3928-431e-bf80-6ff87df40cb3");
    assert.equal((await call("i/unpin", { noteId: notes.reply1 }, "a")).data.error.id, "454170ce-9d63-4a43-9da1-ea10afe81e21");
    assert.deepEqual((await call("i/unpin", { noteId: notes.root }, "a")).data.pinnedNoteIds, []);
    // `i` records today in loggedInDates (upstream), then packs MeDetailed
    const me = (await handlers.i!(env, { i: TOK.a }, { hasCredential: true, request: new Request("https://api.test/api/i", { method: "POST" }) })) as Record<string, any>;
    assert.equal(me.id, ids.a);
    assert.equal(me.isAdmin, true);
    assert.equal(me.policies.pinLimit, 5);
    assert.equal(me.loggedInDays, 1);
    assert.ok(Array.isArray(me.unreadAnnouncements));
    assert.equal(typeof me.unreadNotificationsCount, "number");
  });

  it("announcements + i/read-announcement + unreadAnnouncements", async () => {
    const annId = genAidx(Date.now());
    await db.query(`INSERT INTO announcement (id, title, text) VALUES ($1, 'Hello', 'world')`, [annId]);
    let list = (await call("announcements", {}, "b")).data;
    assert.equal(list[0].id, annId);
    assert.equal(list[0].isRead, false);
    assert.equal((await call("announcements", {})).data[0].isRead, undefined);
    assert.equal(((await packMe(env, ids.b)) as any).unreadAnnouncements.length, 1);
    assert.equal((await call("i/read-announcement", { announcementId: annId }, "b")).status, 204);
    list = (await call("announcements", {}, "b")).data;
    assert.equal(list[0].isRead, true);
    assert.equal(((await packMe(env, ids.b)) as any).hasUnreadAnnouncement, false);
  });

  it("i/claim-achievement validates names and is idempotent", async () => {
    assert.equal((await call("i/claim-achievement", { name: "notAThing" }, "c")).status, 400);
    assert.equal((await call("i/claim-achievement", { name: "notes1" }, "c")).status, 204);
    await call("i/claim-achievement", { name: "notes1" }, "c");
    const r = await db.query(`SELECT achievements FROM user_profile WHERE "userId" = $1`, [ids.c]);
    assert.equal((r.rows[0] as any).achievements.filter((x: any) => x.name === "notes1").length, 1);
  });

  it("cheap boot endpoints", async () => {
    // upstream: users active (lastActiveDate) within the last 10 minutes
    await db.query(`UPDATE "user" SET "lastActiveDate" = now() WHERE id = $1`, [ids.a]);
    await db.query(`UPDATE "user" SET "lastActiveDate" = now() - interval '11 minutes' WHERE id = $1`, [ids.b]);
    assert.deepEqual((await call("get-online-users-count", {})).data, { count: 1 });
  });

  it("groupNotifications groups reactions on one note and renotes of one note", () => {
    const mk = (id: string, type: any, notifierId: string, noteId: string, reaction?: string) => ({ id, createdAt: "", type, notifierId, noteId, reaction });
    const g = groupNotifications(
      [mk("5", "reaction", "u1", "n1", "👍"), mk("4", "reaction", "u2", "n1", "🎉"), mk("3", "renote", "u3", "r1"), mk("2", "renote", "u4", "r2"), mk("1", "follow", "u5", "")],
      new Map([["r1", "t"], ["r2", "t"]]),
    );
    assert.equal(g.length, 3);
    assert.equal(g[0]!.type, "reaction:grouped");
    assert.equal((g[0] as any).reactions.length, 2);
    assert.equal(g[0]!.id, "4");
    assert.equal(g[1]!.type, "renote:grouped");
    assert.deepEqual((g[1] as any).userIds, ["u3", "u4"]);
  });
});
