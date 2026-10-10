/**
 * Custom emoji on PG (PGlite): admin/emoji/* (role gate, add/update/delete, bulk ops,
 * list/query quirks), `emojis`/`emoji` from PG with KV invalidation, moderation_log,
 * custom-emoji reactions (fallback, role-restricted, `:name@.:` packing), /emoji redirect.
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
import { MemoryCacheStore, CACHE_KEYS } from "./cache.js";
import { packReactionKey, resolveReactionPg, serveEmojiRedirect } from "./emojis-pg.js";
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
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS emojis varchar[] NOT NULL DEFAULT '{}', ADD COLUMN IF NOT EXISTS "chatScope" varchar NOT NULL DEFAULT 'mutual',
  ADD COLUMN IF NOT EXISTS "makeNotesFollowersOnlyBefore" int, ADD COLUMN IF NOT EXISTS "makeNotesHiddenBefore" int,
  ADD COLUMN IF NOT EXISTS "avatarDecorations" jsonb NOT NULL DEFAULT '[]';
ALTER TABLE user_profile ADD COLUMN IF NOT EXISTS "enableWordMute" bool NOT NULL DEFAULT false, ADD COLUMN IF NOT EXISTS "verifiedLinks" varchar[] NOT NULL DEFAULT '{}';
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
CREATE TABLE drive_file (id varchar PRIMARY KEY, "userId" varchar, type varchar, url varchar, "webpublicUrl" varchar, "webpublicType" varchar);
CREATE TYPE poll_notevisibility_enum AS ENUM ('public', 'home', 'followers', 'specified');
CREATE TABLE poll ("noteId" varchar(32) PRIMARY KEY REFERENCES note(id) ON DELETE CASCADE, "expiresAt" timestamptz, multiple boolean NOT NULL,
  choices varchar(256)[] NOT NULL DEFAULT '{}', votes integer[] NOT NULL, "noteVisibility" poll_notevisibility_enum NOT NULL,
  "userId" varchar(32) NOT NULL, "userHost" varchar(128), "channelId" varchar(32));
CREATE TABLE poll_vote (id varchar(32) PRIMARY KEY, "userId" varchar(32) NOT NULL, "noteId" varchar(32) NOT NULL REFERENCES note(id) ON DELETE CASCADE, choice integer NOT NULL);
CREATE UNIQUE INDEX poll_vote_uniq ON poll_vote ("userId", "noteId", choice);
CREATE TABLE moderation_log (id varchar PRIMARY KEY, "userId" varchar, type varchar, info jsonb);
CREATE TABLE emoji (id varchar(32) PRIMARY KEY, "updatedAt" timestamptz, name varchar(128) NOT NULL, host varchar(128), "originalUrl" varchar(512) NOT NULL,
  uri varchar(512), type varchar(64), aliases varchar(128)[] NOT NULL DEFAULT '{}', category varchar(128), "publicUrl" varchar(512) NOT NULL DEFAULT '',
  license varchar(1024), "localOnly" boolean NOT NULL DEFAULT false, "isSensitive" boolean NOT NULL DEFAULT false, "roleIdsThatCanBeUsedThisEmojiAsReaction" varchar(128)[] NOT NULL DEFAULT '{}');
CREATE UNIQUE INDEX emoji_name_host ON emoji (name, host);
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

const cache = new MemoryCacheStore();
const env: ApiEnv = {
  INSTANCE_URL: "https://misskey.example.com",
  BOOTSTRAP_META_JSON: JSON.stringify(fixtureMeta({ name: "EmojiTest" })),
  HYPERDRIVE: { connectionString: "postgres://test", __testClient: client } as unknown as ApiEnv["HYPERDRIVE"],
  __cacheStore: cache,
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

describe("custom emoji", () => {
  let e1 = "";
  let e2 = "";

  it("registers endpoints", () => {
    for (const e of ["admin/emoji/add", "admin/emoji/update", "admin/emoji/delete", "admin/emoji/delete-bulk", "admin/emoji/list", "admin/emoji/list-remote", "admin/emoji/set-aliases-bulk", "admin/emoji/add-aliases-bulk", "admin/emoji/remove-aliases-bulk", "admin/emoji/set-category-bulk", "admin/emoji/set-license-bulk"]) {
      assert.ok((IMPLEMENTED_ENDPOINTS as readonly string[]).includes(e), e);
      assert.ok(ENDPOINT_PARAM_DEFS[e], e);
    }
  });

  it("role gate: non-root without canManageCustomEmojis → ROLE_PERMISSION_DENIED; role policy grants", async () => {
    const r = await call("admin/emoji/list", {}, "b");
    assert.equal(r.status, 403);
    assert.equal(r.data.error.id, "7f86f06f-7e15-4057-8561-f4b6d4ac755a");
    await db.query(`INSERT INTO role (id, policies) VALUES ('r_emoji', $1::jsonb)`, [JSON.stringify({ canManageCustomEmojis: { useDefault: false, priority: 0, value: true } })]);
    await db.query(`INSERT INTO role_assignment (id, "userId", "roleId") VALUES ('ra1', $1, 'r_emoji')`, [ids.b]);
    assert.equal((await call("admin/emoji/list", {}, "b")).status, 200);
    await db.query(`DELETE FROM role_assignment WHERE id = 'ra1'`);
    assert.equal((await call("admin/emoji/list", {}, "c")).status, 403);
    assert.equal((await call("admin/emoji/list", {})).status, 401);
  });

  it("add: file checks, duplicate, pack, cache invalidation, moderation log", async () => {
    await db.query(`INSERT INTO drive_file (id, "userId", type, url, "webpublicUrl") VALUES ('f_png', $1, 'image/png', 'https://m.example/files/a', NULL), ('f_svg', $1, 'image/svg+xml', 'https://m.example/files/s', NULL), ('f_jpg', $1, 'image/jpeg', 'https://m.example/files/j', 'https://m.example/files/jw')`, [ids.a]);
    await cache.put(CACHE_KEYS.emojisSimple, "[]");
    const r = await call("admin/emoji/add", { name: "blob_cat", fileId: "f_png", category: "cats", aliases: ["neko"] }, "a");
    assert.equal(r.status, 200, JSON.stringify(r.data));
    e1 = r.data.id;
    assert.deepEqual(r.data, { id: e1, aliases: ["neko"], name: "blob_cat", category: "cats", host: null, url: "https://m.example/files/a", license: null, isSensitive: false, localOnly: false, roleIdsThatCanBeUsedThisEmojiAsReaction: [] });
    assert.equal(await cache.get(CACHE_KEYS.emojisSimple), null, "emojis cache invalidated");
    assert.equal((await call("admin/emoji/add", { name: "blob_cat", fileId: "f_png" }, "a")).data.error.code, "DUPLICATE_NAME");
    assert.equal((await call("admin/emoji/add", { name: "svg", fileId: "f_svg" }, "a")).data.error.id, "f7599d96-8750-af68-1633-9575d625c1a7");
    assert.equal((await call("admin/emoji/add", { name: "x", fileId: "nope" }, "a")).data.error.id, "fc46b5a4-6b92-4c33-ac66-b806659bb5cf");
    assert.equal((await call("admin/emoji/add", { name: "bad-name", fileId: "f_png" }, "a")).data.error.code, "INVALID_PARAM");
    const r2 = await call("admin/emoji/add", { name: "jpg_one", fileId: "f_jpg", isSensitive: true }, "a");
    e2 = r2.data.id;
    assert.equal(r2.data.url, "https://m.example/files/jw"); // webpublicUrl ?? url
    const log = (await db.query(`SELECT type, info FROM moderation_log WHERE "userId" = $1 ORDER BY id`, [ids.a])).rows as any[];
    assert.deepEqual(log.map((l) => l.type), ["addCustomEmoji", "addCustomEmoji"]);
    assert.equal(log[0].info.emojiId, e1);
  });

  it("emojis / emoji read PG (cached) with upstream order and simple pack", async () => {
    const r = await call("emojis", {});
    assert.deepEqual(r.data.emojis.map((e: any) => e.name), ["blob_cat", "jpg_one"]); // category 'cats' < NULL
    assert.deepEqual(r.data.emojis[1], { aliases: [], name: "jpg_one", category: null, url: "https://m.example/files/jw", isSensitive: true });
    assert.ok(await cache.get(CACHE_KEYS.emojisSimple), "cached after read");
    const one = await call("emoji", { name: "blob_cat" });
    assert.equal(one.data.id, e1);
    await assert.rejects(() => call("emoji", { name: "nope" })); // → INTERNAL_ERROR via the router
  });

  it("update by id (rename, file) and by name; errors", async () => {
    assert.equal((await call("admin/emoji/update", { id: e1, name: "blob_cat2", fileId: "f_jpg", license: "CC0" }, "a")).status, 204);
    const shown = await call("emoji", { name: "blob_cat2" });
    assert.equal(shown.data.license, "CC0");
    assert.equal(shown.data.url, "https://m.example/files/jw");
    assert.equal(shown.data.category, "cats"); // untouched
    assert.equal((await call("admin/emoji/update", { name: "jpg_one", category: "food" }, "a")).status, 204);
    assert.equal((await call("emoji", { name: "jpg_one" })).data.category, "food");
    assert.equal((await call("admin/emoji/update", { id: e1, name: "jpg_one" }, "a")).data.error.id, "7180fe9d-1ee3-bff9-647d-fe9896d2ffb8");
    assert.equal((await call("admin/emoji/update", { id: "nope" }, "a")).data.error.id, "684dec9d-a8c2-4364-9aa8-456c49cb1dc8");
    assert.equal((await call("admin/emoji/update", { id: e1, fileId: "nope" }, "a")).data.error.id, "14fb9fd9-0731-4e2f-aeb9-f09e4740333d");
  });

  it("bulk aliases / category / license", async () => {
    assert.equal((await call("admin/emoji/add-aliases-bulk", { ids: [e1, e2], aliases: ["x", "neko"] }, "a")).status, 204);
    let l = (await call("admin/emoji/list", { limit: 10 }, "a")).data;
    const byId = (id: string) => l.find((e: any) => e.id === id);
    assert.deepEqual(byId(e1).aliases, ["neko", "x"]);
    assert.deepEqual(byId(e2).aliases, ["x", "neko"]);
    await call("admin/emoji/remove-aliases-bulk", { ids: [e1, e2], aliases: ["x"] }, "a");
    await call("admin/emoji/set-category-bulk", { ids: [e1, e2], category: "misc" }, "a");
    await call("admin/emoji/set-license-bulk", { ids: [e2], license: null }, "a");
    l = (await call("admin/emoji/list", {}, "a")).data;
    assert.deepEqual(byId(e1).aliases, ["neko"]);
    assert.ok(l.every((e: any) => e.category === "misc"));
    await call("admin/emoji/set-aliases-bulk", { ids: [e2], aliases: ["only"] }, "a");
    l = (await call("admin/emoji/list", {}, "a")).data;
    assert.deepEqual(byId(e2).aliases, ["only"]);
  });

  it("list query: substring over name/aliases/category, :name: exact; list-remote", async () => {
    assert.deepEqual((await call("admin/emoji/list", { query: "only" }, "a")).data.map((e: any) => e.id), [e2]);
    assert.deepEqual((await call("admin/emoji/list", { query: ":blob_cat2:" }, "a")).data.map((e: any) => e.id), [e1]);
    assert.equal((await call("admin/emoji/list", { query: "misc", limit: 1 }, "a")).data.length, 2); // upstream splice(limit + 1)
    await db.query(`INSERT INTO emoji (id, name, host, "originalUrl") VALUES ('remote1', 'r_emoji', 'remote.example', 'https://remote.example/e.png')`);
    assert.deepEqual((await call("admin/emoji/list-remote", {}, "a")).data.map((e: any) => e.id), ["remote1"]);
    assert.equal((await call("admin/emoji/list-remote", { host: "other.example" }, "a")).data.length, 0);
    assert.ok(!(await call("admin/emoji/list", {}, "a")).data.some((e: any) => e.id === "remote1"));
  });

  it("reactions: custom emoji resolved (fallback, role restriction, sensitive), packed as :name@.:", async () => {
    const note = (await call("notes/create", { text: "react me" }, "a")).data.createdNote.id;
    assert.equal(await withClient((c) => resolveReactionPg(c, ids.b, ":nope:", null)), "❤");
    assert.equal(await withClient((c) => resolveReactionPg(c, ids.b, ":blob_cat2@.:", null)), ":blob_cat2:");
    assert.equal(await withClient((c) => resolveReactionPg(c, ids.b, ":jpg_one:", "nonSensitiveOnly")), "❤");
    assert.equal(await withClient((c) => resolveReactionPg(c, ids.b, "👍", "likeOnly")), "\u2764"); // upstream FALLBACK has no VS16
    assert.equal(packReactionKey(":a_b:"), ":a_b@.:");
    assert.equal(packReactionKey("👍"), "👍");
    assert.equal((await call("notes/reactions/create", { noteId: note, reaction: ":blob_cat2:" }, "b")).data, null);
    const shown = await call("notes/show", { noteId: note }, "b");
    assert.deepEqual(shown.data.reactions, { ":blob_cat2@.:": 1 });
    assert.equal(shown.data.myReaction, ":blob_cat2@.:");
    const list = await call("notes/reactions", { noteId: note, type: ":blob_cat2@.:" });
    assert.equal(list.data.length, 1);
    assert.equal(list.data[0].type, ":blob_cat2@.:");
    await call("admin/emoji/update", { id: e2, roleIdsThatCanBeUsedThisEmojiAsReaction: ["r_emoji"] }, "a");
    assert.equal(await withClient((c) => resolveReactionPg(c, ids.c, ":jpg_one:", null)), "❤");
    await db.query(`INSERT INTO role_assignment (id, "userId", "roleId") VALUES ('ra2', $1, 'r_emoji')`, [ids.c]);
    assert.equal(await withClient((c) => resolveReactionPg(c, ids.c, ":jpg_one:", null)), ":jpg_one:");
    const unknown = (await call("notes/create", { text: "x" }, "a")).data.createdNote.id;
    await call("notes/reactions/create", { noteId: unknown, reaction: ":missing:" }, "b");
    assert.deepEqual((await call("notes/show", { noteId: unknown }, "b")).data.reactions, { "❤": 1 });
  });

  it("/emoji/<name>.webp redirects to the file URL", async () => {
    const r = await serveEmojiRedirect(env, new URL("https://m.example/emoji/blob_cat2.webp"));
    assert.equal(r.status, 301);
    assert.equal(r.headers.get("location"), "https://m.example/files/jw");
    assert.equal(r.headers.get("cache-control"), "public, max-age=86400");
    assert.equal((await serveEmojiRedirect(env, new URL("https://m.example/emoji/blob_cat2@..webp"))).status, 301);
    assert.equal((await serveEmojiRedirect(env, new URL("https://m.example/emoji/nope.webp"))).status, 404);
    assert.equal((await serveEmojiRedirect(env, new URL("https://m.example/emoji/nope.webp?fallback=1"))).status, 302);
    assert.equal((await serveEmojiRedirect(env, new URL("https://m.example/emoji/bad.png"))).status, 404);
  });

  it("delete / delete-bulk", async () => {
    assert.equal((await call("admin/emoji/delete", { id: e1 }, "a")).status, 204);
    assert.equal((await call("admin/emoji/delete", { id: e1 }, "a")).data.error.id, "be83669b-773a-44b7-b1f8-e5e5170ac3c2");
    assert.equal((await call("admin/emoji/delete-bulk", { ids: [e2, "nope"] }, "a")).status, 204);
    assert.equal((await call("emojis", {})).data.emojis.length, 0);
    const types = (await db.query(`SELECT type FROM moderation_log ORDER BY id`)).rows.map((r: any) => r.type);
    assert.equal(types.filter((t: string) => t === "deleteCustomEmoji").length, 2);
  });
});

async function withClient<T>(fn: (c: PgQueryable) => Promise<T>): Promise<T> {
  return fn(client);
}
