/**
 * Search & hashtags on PG (PGlite): hashtag extraction on notes/create + `hashtag` table,
 * notes/search (LIKE, canSearchNotes gate), notes/search-by-tag, users/search,
 * hashtags/list|search|show|users|trend, i/update user tags, admin/roles/update-default-policies.
 */
import { ENDPOINT_PARAM_DEFS } from "./endpoint-params.gen.js";
import { validateParams, type ParamSchema } from "./param-validate.js";
import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { genAidx } from "../../id/src/index.js";
import { fixtureMeta } from "../../packers/src/fixtures.js";
import type { ApiEnv } from "./env.js";
import type { PgQueryable } from "./pg.js";
import { handlers } from "./endpoints/index.js";
import { IMPLEMENTED_ENDPOINTS } from "./registry.js";
import { computeTrend, extractNoteHashtags, extractProfileHashtags, isKeyWordIncluded, normalizeForSearch } from "./search-pg.js";

const SCHEMA = `
CREATE TYPE note_visibility_enum AS ENUM ('public', 'home', 'followers', 'specified');
CREATE TABLE "user" (id varchar PRIMARY KEY, username varchar, "usernameLower" varchar, name varchar, host varchar,
  token varchar, "isBot" bool DEFAULT false, "isCat" bool DEFAULT false, "isSuspended" bool DEFAULT false,
  "avatarId" varchar, "avatarUrl" varchar, "avatarBlurhash" varchar, "bannerId" varchar, "bannerUrl" varchar, "bannerBlurhash" varchar,
  "hideOnlineStatus" bool DEFAULT false, "lastActiveDate" timestamptz, "requireSigninToViewContents" bool DEFAULT false,
  "isLocked" bool DEFAULT false, "followersCount" int DEFAULT 0, "followingCount" int DEFAULT 0, "notesCount" int DEFAULT 0,
  "updatedAt" timestamptz, "lastFetchedAt" timestamptz, "movedToUri" varchar, "alsoKnownAs" text, uri varchar,
  "isExplorable" bool DEFAULT true, tags varchar[] DEFAULT '{}');
CREATE TABLE user_profile ("userId" varchar PRIMARY KEY, description varchar, location varchar, birthday varchar, lang varchar,
  fields jsonb DEFAULT '[]', url varchar, "followingVisibility" varchar DEFAULT 'public', "followersVisibility" varchar DEFAULT 'public',
  "publicReactions" bool DEFAULT true, "pinnedPageId" varchar, "followedMessage" varchar, achievements jsonb DEFAULT '[]',
  "loggedInDates" varchar[] DEFAULT '{}', "mutedWords" jsonb DEFAULT '[]', "hardMutedWords" jsonb DEFAULT '[]', "mutedInstances" jsonb DEFAULT '[]',
  "notificationRecieveConfig" jsonb DEFAULT '{}', "emailNotificationTypes" jsonb DEFAULT '[]', "alwaysMarkNsfw" bool DEFAULT false,
  "autoSensitive" bool DEFAULT false, "carefulBot" bool DEFAULT false, "autoAcceptFollowed" bool DEFAULT true, "noCrawle" bool DEFAULT false,
  "preventAiLearning" bool DEFAULT true, "injectFeaturedNote" bool DEFAULT true, "receiveAnnouncementEmail" bool DEFAULT true,
  "twoFactorEnabled" bool DEFAULT false, "usePasswordLessLogin" bool DEFAULT false, "securityKeysAvailable" bool DEFAULT false,
  email varchar, "emailVerified" bool DEFAULT false, "userHost" varchar);
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS emojis varchar[] NOT NULL DEFAULT '{}', ADD COLUMN IF NOT EXISTS "chatScope" varchar NOT NULL DEFAULT 'mutual',
  ADD COLUMN IF NOT EXISTS "makeNotesFollowersOnlyBefore" int, ADD COLUMN IF NOT EXISTS "makeNotesHiddenBefore" int,
  ADD COLUMN IF NOT EXISTS "avatarDecorations" jsonb NOT NULL DEFAULT '[]';
ALTER TABLE user_profile ADD COLUMN IF NOT EXISTS "enableWordMute" bool NOT NULL DEFAULT false, ADD COLUMN IF NOT EXISTS "verifiedLinks" varchar[] NOT NULL DEFAULT '{}';
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
CREATE TABLE registry_item (id varchar PRIMARY KEY, "updatedAt" timestamptz, "userId" varchar, key varchar, scope varchar[], domain varchar, value jsonb);
CREATE TABLE note_favorite (id varchar, "userId" varchar, "noteId" varchar);
CREATE TABLE note_thread_muting (id varchar, "userId" varchar, "threadId" varchar);
CREATE TABLE user_note_pining (id varchar, "userId" varchar, "noteId" varchar);
CREATE TABLE announcement (id varchar PRIMARY KEY, "updatedAt" timestamptz, text varchar, title varchar, "imageUrl" varchar, icon varchar DEFAULT 'info',
  display varchar DEFAULT 'normal', "needConfirmationToRead" bool DEFAULT false, "isActive" bool DEFAULT true, "forExistingUsers" bool DEFAULT false,
  silence bool DEFAULT false, "userId" varchar);
CREATE TABLE announcement_read (id varchar, "userId" varchar, "announcementId" varchar, UNIQUE ("userId", "announcementId"));
CREATE TABLE avatar_decoration (id varchar, name varchar, description varchar, url varchar, "roleIdsThatCanBeUsedThisDecoration" varchar[] DEFAULT '{}');
CREATE TABLE meta (id varchar, "rootUserId" varchar, "pinnedUsers" varchar[] DEFAULT '{}', policies jsonb DEFAULT '{}', "hiddenTags" varchar[] DEFAULT '{}', "sensitiveWords" varchar[] DEFAULT '{}');
CREATE TABLE note_reaction (id varchar, "userId" varchar, "noteId" varchar, reaction varchar);
CREATE TABLE drive_file (id varchar, "userId" varchar, md5 varchar, name varchar, type varchar, size int, comment varchar, blurhash varchar,
  properties jsonb DEFAULT '{}', url varchar, "thumbnailUrl" varchar, "isSensitive" bool DEFAULT false, "folderId" varchar, "accessKey" varchar);
CREATE TABLE access_token (id varchar, "userId" varchar, token varchar, hash varchar, permission varchar[], name varchar, "iconUrl" varchar, "lastUsedAt" timestamptz);
CREATE TABLE role (id varchar PRIMARY KEY, policies jsonb DEFAULT '{}', "isModerator" bool DEFAULT false, "isAdministrator" bool DEFAULT false,
  name varchar DEFAULT '', description varchar DEFAULT '', color varchar, "iconUrl" varchar, target varchar DEFAULT 'manual', "condFormula" jsonb DEFAULT '{}',
  "isPublic" bool DEFAULT false, "isExplorable" bool DEFAULT false, "asBadge" bool DEFAULT false, "displayOrder" int DEFAULT 0);
CREATE TABLE role_assignment (id varchar, "userId" varchar, "roleId" varchar, "expiresAt" timestamptz);
CREATE TABLE moderation_log (id varchar PRIMARY KEY, "userId" varchar, type varchar, info jsonb);
CREATE TYPE poll_notevisibility_enum AS ENUM ('public', 'home', 'followers', 'specified');
CREATE TABLE poll ("noteId" varchar(32) PRIMARY KEY REFERENCES note(id) ON DELETE CASCADE, "expiresAt" timestamptz, multiple boolean NOT NULL,
  choices varchar(256)[] NOT NULL DEFAULT '{}', votes integer[] NOT NULL, "noteVisibility" poll_notevisibility_enum NOT NULL,
  "userId" varchar(32) NOT NULL, "userHost" varchar(128), "channelId" varchar(32));
CREATE TABLE poll_vote (id varchar(32) PRIMARY KEY, "userId" varchar(32) NOT NULL, "noteId" varchar(32) NOT NULL, choice integer NOT NULL);
CREATE TABLE hashtag (id varchar(32) PRIMARY KEY, name varchar(128) NOT NULL UNIQUE,
  "mentionedUserIds" varchar(32)[] NOT NULL DEFAULT '{}', "mentionedUsersCount" integer NOT NULL DEFAULT 0,
  "mentionedLocalUserIds" varchar(32)[] NOT NULL DEFAULT '{}', "mentionedLocalUsersCount" integer NOT NULL DEFAULT 0,
  "mentionedRemoteUserIds" varchar(32)[] NOT NULL DEFAULT '{}', "mentionedRemoteUsersCount" integer NOT NULL DEFAULT 0,
  "attachedUserIds" varchar(32)[] NOT NULL DEFAULT '{}', "attachedUsersCount" integer NOT NULL DEFAULT 0,
  "attachedLocalUserIds" varchar(32)[] NOT NULL DEFAULT '{}', "attachedLocalUsersCount" integer NOT NULL DEFAULT 0,
  "attachedRemoteUserIds" varchar(32)[] NOT NULL DEFAULT '{}', "attachedRemoteUsersCount" integer NOT NULL DEFAULT 0);
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
  BOOTSTRAP_META_JSON: JSON.stringify(fixtureMeta({ name: "SearchTest" })),
  HYPERDRIVE: { connectionString: "postgres://test", __testClient: client } as unknown as ApiEnv["HYPERDRIVE"],
};
(env as { __noTrendCache?: boolean }).__noTrendCache = true;

const ids = { a: genAidx(Date.now() - 100000), b: genAidx(Date.now() - 90000), c: genAidx(Date.now() - 80000) };
const TOK = { a: "aaaaaaaaaaaaaaaa", b: "bbbbbbbbbbbbbbbb", c: "cccccccccccccccc" };
type Who = keyof typeof TOK;

async function call(name: string, body: Record<string, unknown>, who?: Who): Promise<{ status: number; data: any }> {
  const b: Record<string, unknown> = who ? { ...body, i: TOK[who] } : { ...body };
  // the router's paramDef validation (ajv in upstream) runs before the handler
  const pe = validateParams(ENDPOINT_PARAM_DEFS[name] as ParamSchema, b);
  if (pe) return { status: 400, data: { error: { code: "INVALID_PARAM", info: pe } } };
  let r: unknown;
  try {
    r = await handlers[name]!(env, b, { hasCredential: Boolean(who), request: new Request("https://api.test/api/" + name, { method: "POST" }) });
  } catch (e) {
    return { status: 500, data: { error: { code: "INTERNAL_ERROR", message: String(e) } } };
  }
  if (r instanceof Response) return { status: r.status, data: r.status === 204 ? null : await r.json() };
  return { status: 200, data: r };
}
const tagRow = async (name: string) => (await db.query(`SELECT * FROM hashtag WHERE name = $1`, [name])).rows[0] as any;

before(async () => {
  await db.exec(SCHEMA);
  const names = { a: "Alice Admin", b: "Bob Builder", c: "Carol" };
  for (const [k, id] of Object.entries(ids)) {
    await db.query(`INSERT INTO "user" (id, username, "usernameLower", name, token) VALUES ($1, $2, $3, $4, $5)`, [id, `user_${k}`, `user_${k}`, names[k as Who], TOK[k as Who]]);
    await db.query(`INSERT INTO user_profile ("userId") VALUES ($1)`, [id]);
  }
  await db.query(`INSERT INTO meta (id, "rootUserId") VALUES ('x', $1)`, [ids.a]);
});

describe("search & hashtags", () => {
  const notes: Record<string, string> = {};

  it("registers endpoints", () => {
    for (const e of ["notes/search", "notes/search-by-tag", "users/search", "hashtags/list", "hashtags/search", "hashtags/show", "hashtags/users", "hashtags/trend", "admin/roles/update-default-policies"]) {
      assert.ok((IMPLEMENTED_ENDPOINTS as readonly string[]).includes(e), e);
      assert.ok(ENDPOINT_PARAM_DEFS[e], e);
    }
  });

  it("extracts hashtags like upstream (mfm-js)", () => {
    assert.deepEqual(extractNoteHashtags("hi #Misskey #ミスキー #Misskey `#code` https://x.example/#frag", null), ["Misskey", "ミスキー"]);
    assert.deepEqual(extractNoteHashtags("text", "#cw_tag", ["#choice", "plain"]), ["cw_tag", "choice"]);
    assert.deepEqual(extractNoteHashtags(`#${"x".repeat(129)} #ok`, null), ["ok"]);
    assert.equal(extractNoteHashtags(Array.from({ length: 40 }, (_, i) => `#t${i}`).join(" "), null).length, 32);
    assert.equal(normalizeForSearch("ＦＯＯ"), "foo");
    assert.deepEqual(extractProfileHashtags("I like #Cats and #DOGS"), ["cats", "dogs"]);
    assert.ok(isKeyWordIncluded("badword", ["bad"]));
    assert.ok(isKeyWordIncluded("abc123", ["/\\d+$/"]));
    assert.ok(!isKeyWordIncluded("fine", ["a b"]));
  });

  it("notes/create stores normalized tags and updates the hashtag table (public/home only)", async () => {
    const r = await call("notes/create", { text: "Hello #CloudFlare #misskey 100% sure" }, "a");
    assert.equal(r.status, 200, JSON.stringify(r.data));
    notes.a1 = r.data.createdNote.id;
    assert.deepEqual(r.data.createdNote.tags, ["cloudflare", "misskey"]);
    let t = await tagRow("cloudflare");
    assert.equal(t.mentionedUsersCount, 1);
    assert.equal(t.mentionedLocalUsersCount, 1);
    assert.deepEqual(t.mentionedUserIds, [ids.a]);
    notes.a2 = (await call("notes/create", { text: "again #cloudflare", visibility: "home" }, "a")).data.createdNote.id;
    assert.equal((await tagRow("cloudflare")).mentionedUsersCount, 1, "same user counted once");
    notes.b1 = (await call("notes/create", { text: "bob says #CloudFlare", poll: { choices: ["x", "y"] } }, "b")).data.createdNote.id;
    t = await tagRow("cloudflare");
    assert.equal(t.mentionedUsersCount, 2);
    notes.bf = (await call("notes/create", { text: "secret #hidden_tag", visibility: "followers" }, "b")).data.createdNote.id;
    assert.equal(await tagRow("hidden_tag"), undefined, "followers note not counted");
    const stored = (await db.query(`SELECT tags FROM note WHERE id = $1`, [notes.bf])).rows[0] as any;
    assert.deepEqual(stored.tags, ["hidden_tag"]);
    notes.c1 = (await call("notes/create", { text: "reply #misskey", replyId: notes.a1 }, "c")).data.createdNote.id;
    notes.plain = (await call("notes/create", { text: "no tags here, just 100_percent" }, "c")).data.createdNote.id;
  });

  it("notes/search-by-tag: tag / query (OR of AND), visibility, filters, injection", async () => {
    let r = await call("notes/search-by-tag", { tag: "CLOUDFLARE" });
    assert.deepEqual(r.data.map((n: any) => n.id), [notes.b1, notes.a2, notes.a1]);
    r = await call("notes/search-by-tag", { query: [["cloudflare", "misskey"], ["hidden_tag"]] });
    assert.deepEqual(r.data.map((n: any) => n.id), [notes.a1], "followers note invisible to anon");
    r = await call("notes/search-by-tag", { query: [["hidden_tag"]] }, "b");
    assert.deepEqual(r.data.map((n: any) => n.id), [notes.bf]);
    r = await call("notes/search-by-tag", { tag: "misskey", reply: true });
    assert.deepEqual(r.data.map((n: any) => n.id), [notes.c1]);
    r = await call("notes/search-by-tag", { tag: "cloudflare", poll: true });
    assert.deepEqual(r.data.map((n: any) => n.id), [notes.b1]);
    r = await call("notes/search-by-tag", { tag: "cloudflare", limit: 1 });
    assert.equal(r.data.length, 1);
    // upstream: Error('Injection') is not caught by the endpoint → INTERNAL_ERROR
    assert.equal((await call("notes/search-by-tag", { tag: "x'y" })).status, 500);
    assert.equal((await call("notes/search-by-tag", {})).status, 400);
    assert.equal((await call("notes/search-by-tag", { query: [[]] })).status, 400);
  });

  it("notes/search: canSearchNotes gate (UNAVAILABLE), LIKE with escaping, filters, mutes", async () => {
    let r = await call("notes/search", { query: "cloud" });
    assert.equal(r.status, 400);
    assert.equal(r.data.error.id, "0b44998d-77aa-4427-80d0-d2c9b8523011");
    assert.equal((await call("notes/search", { query: "cloud" }, "a")).data.error.code, "UNAVAILABLE", "root has no implicit canSearchNotes");
    await db.query(`INSERT INTO role (id, policies) VALUES ('r_search', $1::jsonb)`, [JSON.stringify({ canSearchNotes: { useDefault: false, priority: 0, value: true } })]);
    await db.query(`INSERT INTO role_assignment (id, "userId", "roleId") VALUES ('ra_s', $1, 'r_search')`, [ids.b]);
    r = await call("notes/search", { query: "CLOUD" }, "b");
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.deepEqual(r.data.map((n: any) => n.id), [notes.b1, notes.a2, notes.a1]);
    r = await call("notes/search", { query: "100%" }, "b");
    assert.deepEqual(r.data.map((n: any) => n.id), [notes.a1], "% is literal");
    r = await call("notes/search", { query: "100_" }, "b");
    assert.deepEqual(r.data.map((n: any) => n.id), [notes.plain], "_ is literal");
    r = await call("notes/search", { query: "cloud", userId: ids.a }, "b");
    assert.deepEqual(r.data.map((n: any) => n.id), [notes.a2, notes.a1]);
    r = await call("notes/search", { query: "cloud", host: "." , limit: 1 }, "b");
    assert.deepEqual(r.data.map((n: any) => n.id), [notes.b1]);
    r = await call("notes/search", { query: "cloud", host: "remote.example" }, "b");
    assert.deepEqual(r.data, []);
    r = await call("notes/search", { query: "cloud", untilId: notes.b1 }, "b");
    assert.deepEqual(r.data.map((n: any) => n.id), [notes.a2, notes.a1]);
    await db.query(`INSERT INTO muting (id, "muterId", "muteeId") VALUES ('m1', $1, $2)`, [ids.b, ids.a]);
    r = await call("notes/search", { query: "cloud" }, "b");
    assert.deepEqual(r.data.map((n: any) => n.id), [notes.b1], "muted author hidden");
    await db.query(`DELETE FROM muting WHERE id = 'm1'`);
    assert.equal((await call("notes/search", {}, "b")).status, 400);
  });

  it("users/search: name / @username / description, mutes, origin, detail, role gate", async () => {
    await db.query(`UPDATE user_profile SET description = 'builds Workers on Cloudflare' WHERE "userId" = $1`, [ids.c]);
    let r = await call("users/search", { query: "bob", detail: false });
    assert.deepEqual(r.data.map((u: any) => u.id), [ids.b]);
    assert.deepEqual(Object.keys(r.data[0]).includes("followersCount"), false, "UserLite");
    r = await call("users/search", { query: "@user_" , limit: 10, detail: false });
    assert.equal(r.data.length, 3);
    r = await call("users/search", { query: "user_c" });
    assert.equal(r.data[0].id, ids.c);
    assert.equal(typeof r.data[0].followersCount, "number", "UserDetailed by default");
    r = await call("users/search", { query: "cloudflare", detail: false });
    assert.deepEqual(r.data.map((u: any) => u.id), [ids.c], "description match");
    await db.query(`INSERT INTO muting (id, "muterId", "muteeId") VALUES ('m2', $1, $2)`, [ids.a, ids.c]);
    r = await call("users/search", { query: "carol", detail: false }, "a");
    assert.deepEqual(r.data, []);
    await db.query(`DELETE FROM muting WHERE id = 'm2'`);
    assert.deepEqual((await call("users/search", { query: "carol", origin: "remote", detail: false })).data, []);
    await db.query(`INSERT INTO role (id, policies) VALUES ('r_nosearch', $1::jsonb)`, [JSON.stringify({ canSearchUsers: { useDefault: false, priority: 2, value: false } })]);
    await db.query(`INSERT INTO role_assignment (id, "userId", "roleId") VALUES ('ra_n', $1, 'r_nosearch')`, [ids.c]);
    r = await call("users/search", { query: "bob" }, "c");
    assert.equal(r.status, 403);
    assert.equal(r.data.error.id, "7f86f06f-7e15-4057-8561-f4b6d4ac755a");
    assert.equal((await call("users/search", { query: "bob" }, "a")).status, 200, "root bypasses requiredRolePolicy");
    assert.equal((await call("users/search", { query: "x", origin: "nope" })).status, 400);
  });

  it("i/update description → user.tags + attached counts; hashtags/users", async () => {
    let r = await call("i/update", { description: "I love #CloudFlare and #Rust" }, "b");
    assert.equal(r.status, 200, JSON.stringify(r.data));
    let u = (await db.query(`SELECT tags FROM "user" WHERE id = $1`, [ids.b])).rows[0] as any;
    assert.deepEqual(u.tags, ["cloudflare", "rust"]);
    assert.equal((await tagRow("rust")).attachedUsersCount, 1);
    assert.equal((await tagRow("cloudflare")).attachedLocalUsersCount, 1);
    r = await call("i/update", { description: "only #Rust now" }, "b");
    u = (await db.query(`SELECT tags FROM "user" WHERE id = $1`, [ids.b])).rows[0] as any;
    assert.deepEqual(u.tags, ["rust"]);
    assert.equal((await tagRow("cloudflare")).attachedUsersCount, 0, "removed tag decremented");
    assert.equal((await tagRow("rust")).attachedUsersCount, 1, "kept tag not double counted");
    await call("i/update", { name: "Bobby" }, "b"); // description unchanged → tags unchanged
    assert.deepEqual(((await db.query(`SELECT tags FROM "user" WHERE id = $1`, [ids.b])).rows[0] as any).tags, ["rust"]);
    r = await call("hashtags/users", { tag: "RUST", sort: "+follower" });
    assert.deepEqual(r.data.map((x: any) => x.id), [ids.b]);
    assert.equal(typeof r.data[0].followersCount, "number");
    assert.deepEqual((await call("hashtags/users", { tag: "rust", sort: "+follower", origin: "remote" })).data, []);
    assert.equal((await call("hashtags/users", { tag: "rust" })).status, 400, "sort required");
  });

  it("hashtags/list, search, show", async () => {
    let r = await call("hashtags/list", { sort: "+mentionedUsers" });
    assert.equal(r.data[0].tag, "cloudflare");
    assert.deepEqual(Object.keys(r.data[0]).sort(), ["attachedLocalUsersCount", "attachedRemoteUsersCount", "attachedUsersCount", "mentionedLocalUsersCount", "mentionedRemoteUsersCount", "mentionedUsersCount", "tag"]);
    r = await call("hashtags/list", { sort: "+attachedUsers", attachedToUserOnly: true });
    assert.deepEqual(r.data.map((t: any) => t.tag), ["rust"]);
    assert.equal((await call("hashtags/list", {})).status, 400);
    r = await call("hashtags/search", { query: "CL" });
    assert.deepEqual(r.data, ["cloudflare"]);
    assert.deepEqual((await call("hashtags/search", { query: "%" })).data, []);
    r = await call("hashtags/show", { tag: "MissKey" });
    assert.equal(r.data.tag, "misskey");
    assert.equal(r.data.mentionedUsersCount, 2);
    r = await call("hashtags/show", { tag: "nothing" });
    assert.equal(r.data.error.id, "110ee688-193e-4a3a-9ecf-c167b2e6981e");
  });

  it("hashtags/trend: ranking + 10-minute charts from recent notes", async () => {
    const r = await call("hashtags/trend", {});
    assert.equal(r.status, 200);
    const cf = r.data.find((t: any) => t.tag === "cloudflare");
    assert.ok(cf, JSON.stringify(r.data));
    assert.equal(cf.chart.length, 20);
    assert.equal(cf.usersCount, 2);
    assert.equal(r.data[0].tag, "cloudflare", "most users first");
    assert.ok(!r.data.some((t: any) => t.tag === "hidden_tag"), "followers-only notes excluded");
    // unit: hidden / sensitive excluded, chart buckets, prev-window tags appended
    const now = Date.UTC(2026, 9, 8, 12, 35);
    const at = (msAgo: number) => genAidx(now - msAgo);
    const rows = [
      { id: at(60_000), userId: "u1", tags: ["a", "secret"] },
      { id: at(120_000), userId: "u2", tags: ["a"] },
      { id: at(15 * 60_000), userId: "u3", tags: ["a", "b"] },
      { id: at(50 * 60_000), userId: "u4", tags: ["old"] },
      { id: at(50 * 60_000), userId: "u5", tags: ["nsfw_word"] },
    ];
    const t = computeTrend(rows, now, new Set(["secret"]), ["nsfw"]);
    assert.deepEqual(t.map((x) => x.tag), ["a", "b", "old"]);
    assert.deepEqual(t[0]!.chart.slice(0, 3), [2, 1, 0]);
    assert.equal(t[0]!.usersCount, 2);
    assert.equal(t[2]!.chart[5], 1);
  });

  it("admin/roles/update-default-policies: admin only, writes meta.policies + moderation log", async () => {
    assert.equal((await call("admin/roles/update-default-policies", { policies: { canSearchNotes: true } }, "b")).status, 403);
    const r = await call("admin/roles/update-default-policies", { policies: { canSearchNotes: true } }, "a");
    assert.equal(r.status, 204, JSON.stringify(r.data));
    const m = (await db.query(`SELECT policies FROM meta`)).rows[0] as any;
    assert.deepEqual(m.policies, { canSearchNotes: true });
    const log = (await db.query(`SELECT type, info FROM moderation_log WHERE type = 'updateServerSettings'`)).rows as any[];
    assert.equal(log.length, 1);
    assert.deepEqual(log[0].info.after, { canSearchNotes: true });
    assert.equal((await call("admin/roles/update-default-policies", { policies: [] }, "a")).status, 400);
  });
});
