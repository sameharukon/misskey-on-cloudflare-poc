/**
 * i/update on PG (PGlite): upstream params and validation, role policies (wordMuteLimit,
 * canUpdateBioMedia, alwaysMarkNsfw, avatarDecorationLimit), avatar / banner from drive,
 * decorations, alsoKnownAs, prohibited name words, emoji extraction, meUpdated; and the
 * notes/create mentionLimit policy.
 */
import { before, describe, it } from "node:test";
import assert from "node:assert/strict";

import { makeFixture, type Fixture } from "./pglite-fixture.js";
import type { ApiEnv } from "./env.js";
import { ENDPOINT_PARAM_DEFS } from "./endpoint-params.gen.js";
import { recordingHubNamespace } from "../../shared/src/testing/do-namespace.js";

const published: { userId: string; body: any }[] = [];
const hub = recordingHubNamespace((userId, _path, body) => published.push({ userId, body }));

let f: Fixture;
before(async () => {
  f = await makeFixture("IUpdateTest", { STREAM_HUB: hub as unknown as ApiEnv["STREAM_HUB"] });
});

const E = (r: { data: any }) => r.data?.error?.id;
const file = async (id: string, userId: string, type: string) =>
  f.db.query(`INSERT INTO drive_file (id, "userId", type, name, url, "webpublicUrl", blurhash, md5, size, "storedInternal") VALUES ($1, $2, $3, 'f', $4, NULL, 'bh', '0', 0, FALSE)`, [id, userId, type, `https://misskey.example.com/files/${id}`]);

describe("i/update", () => {
  it("declares the upstream params", () => {
    const names = Object.keys(ENDPOINT_PARAM_DEFS["i/update"]!.properties ?? {});
    for (const n of ["name", "avatarId", "bannerId", "fields", "mutedWords", "hardMutedWords", "notificationRecieveConfig", "avatarDecorations", "alsoKnownAs", "chatScope"]) assert.ok(names.includes(n), n);
  });

  it("profile fields, flags and settings; MeDetailed response + meUpdated", async () => {
    published.length = 0;
    const r = await f.call("i/update", {
      name: "  Bob :blobcat:  ",
      description: "hi #Cats",
      location: "Tokyo",
      birthday: "2000-01-02",
      lang: "ja-JP",
      fields: [{ name: " site ", value: " https://example.com " }, { name: "", value: "dropped" }],
      isCat: true,
      isBot: true,
      isExplorable: false,
      hideOnlineStatus: true,
      publicReactions: false,
      followingVisibility: "followers",
      followersVisibility: "private",
      chatScope: "none",
      autoAcceptFollowed: false,
      preventAiLearning: false,
      makeNotesHiddenBefore: -86400,
      notificationRecieveConfig: { reaction: { type: "never" } },
      emailNotificationTypes: ["follow"],
      mutedInstances: ["spam.example"],
    }, "b");
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const me = r.data;
    assert.equal(me.name, "Bob :blobcat:");
    assert.equal(me.description, "hi #Cats");
    assert.equal(me.location, "Tokyo");
    assert.equal(me.birthday, "2000-01-02");
    assert.equal(me.lang, "ja-JP");
    assert.deepEqual(me.fields, [{ name: "site", value: "https://example.com" }]);
    assert.equal(me.isCat, true);
    assert.equal(me.isBot, true);
    assert.equal(me.isExplorable, false);
    assert.equal(me.publicReactions, false);
    assert.equal(me.followingVisibility, "followers");
    assert.equal(me.followersVisibility, "private");
    assert.equal(me.chatScope, "none");
    assert.equal(me.autoAcceptFollowed, false);
    assert.equal(me.makeNotesHiddenBefore, -86400);
    assert.deepEqual(me.notificationRecieveConfig, { reaction: { type: "never" } });
    assert.deepEqual(me.mutedInstances, ["spam.example"]);
    assert.ok("policies" in me && "unreadNotificationsCount" in me); // MeDetailed
    const row = (await f.db.query(`SELECT emojis, tags FROM "user" WHERE id = $1`, [f.ids.b])).rows[0] as any;
    assert.deepEqual(row.emojis, ["blobcat"]);
    assert.deepEqual(row.tags, ["cats"]);
    assert.ok(published.some((p) => p.userId === f.ids.b && p.body.channel === "main" && p.body.type === "meUpdated" && p.body.body.id === f.ids.b));
    // name: null / blank clears it
    assert.equal((await f.call("i/update", { name: "   " }, "b")).data.name, null);
  });

  it("validation", async () => {
    for (const bad of [
      { name: "x".repeat(51) },
      { birthday: "2000/01/02" },
      { followingVisibility: "nobody" },
      { chatScope: "all" },
      { isCat: "yes" },
      { fields: Array.from({ length: 17 }, () => ({ name: "a", value: "b" })) },
      { mutedWords: [1] },
      { notificationRecieveConfig: { reaction: { type: "sometimes" } } },
      { avatarDecorations: [{ id: "d", angle: 1 }] },
      { alsoKnownAs: ["@a", "@a"] },
    ]) {
      assert.equal((await f.call("i/update", bad, "b")).status, 400, JSON.stringify(bad));
    }
    assert.equal((await f.call("i/update", { name: "x" })).status, 401);
  });

  it("mutedWords: wordMuteLimit, regex check, enableWordMute", async () => {
    const r = await f.call("i/update", { mutedWords: [["cat", "dog"], "/fo+/i"], hardMutedWords: ["/bar/"] }, "b");
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.deepEqual(r.data.mutedWords, [["cat", "dog"], "/fo+/i"]);
    assert.deepEqual(r.data.hardMutedWords, ["/bar/"]);
    assert.equal(((await f.db.query(`SELECT "enableWordMute" FROM user_profile WHERE "userId" = $1`, [f.ids.b])).rows[0] as any).enableWordMute, true);
    assert.equal(E(await f.call("i/update", { mutedWords: ["not a regex"] }, "b")), "0d786918-10df-41cd-8f33-8dec7d9a89a5");
    assert.equal(E(await f.call("i/update", { mutedWords: ["/(/"] }, "b")), "0d786918-10df-41cd-8f33-8dec7d9a89a5");
    await f.setPolicy(f.ids.b, "wordMuteLimit", 5);
    assert.equal(E(await f.call("i/update", { mutedWords: [["abc", "def"]] }, "b")), "010665b1-a211-42d2-bc64-8f6609d79785");
    assert.equal((await f.call("i/update", { mutedWords: [["abc", "de"]] }, "b")).status, 200);
  });

  it("avatar / banner: own image files only, canUpdateBioMedia, null clears", async () => {
    await file("img1", f.ids.b, "image/png");
    await file("txt1", f.ids.b, "text/plain");
    await file("img2", f.ids.c, "image/png");
    assert.equal(E(await f.call("i/update", { avatarId: "nope" }, "b")), "539f3a45-f215-4f81-a9a8-31293640207f");
    assert.equal(E(await f.call("i/update", { avatarId: "img2" }, "b")), "539f3a45-f215-4f81-a9a8-31293640207f");
    assert.equal(E(await f.call("i/update", { avatarId: "txt1" }, "b")), "f419f9f8-2f4d-46b1-9fb4-49d3a2fd7191");
    assert.equal(E(await f.call("i/update", { bannerId: "txt1" }, "b")), "75aedb19-2afd-4e6d-87fc-67941256fa60");
    const r = await f.call("i/update", { avatarId: "img1", bannerId: "img1" }, "b");
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.avatarUrl, "https://misskey.example.com/files/img1");
    assert.equal(r.data.avatarBlurhash, "bh");
    assert.equal(r.data.bannerUrl, "https://misskey.example.com/files/img1");
    assert.equal((await f.call("i/update", { avatarId: null }, "b")).data.avatarId, null);
    await f.setPolicy(f.ids.b, "canUpdateBioMedia", false);
    assert.equal(E(await f.call("i/update", { avatarId: "img1" }, "b")), "8feff0ba-5ab5-585b-31f4-4df816663fad");
    assert.equal((await f.call("i/update", { bannerId: null }, "b")).status, 200); // clearing is always allowed
    await f.setPolicy(f.ids.b, "alwaysMarkNsfw", true);
    assert.equal(E(await f.call("i/update", { alwaysMarkNsfw: false }, "b")), "8feff0ba-5ab5-585b-31f4-4df816663fad");
  });

  it("avatarDecorations: unknown / role-limited ones dropped, avatarDecorationLimit", async () => {
    await f.db.query(`INSERT INTO avatar_decoration (id, name, description, url, "roleIdsThatCanBeUsedThisDecoration") VALUES ('d1', 'one', '', 'https://d/1.png', '{}'), ('d2', 'two', '', 'https://d/2.png', '{gone}')`);
    await f.db.query(`INSERT INTO role (id, name, description, "updatedAt", "lastUsedAt") VALUES ('rDeco', 'deco', '', now(), now())`);
    await f.db.query(`INSERT INTO avatar_decoration (id, name, description, url, "roleIdsThatCanBeUsedThisDecoration") VALUES ('d3', 'three', '', 'https://d/3.png', '{rDeco}')`);
    await f.setPolicy(f.ids.c, "avatarDecorationLimit", 4);
    const r = await f.call("i/update", { avatarDecorations: [{ id: "d1", angle: 0.25 }, { id: "d2" }, { id: "d3" }, { id: "nope" }] }, "c");
    assert.equal(r.status, 200, JSON.stringify(r.data));
    // d2's role no longer exists → usable by anyone; d3 needs rDeco
    // UserLite: falsy angle / flipH / offsets are left out (upstream `|| undefined`)
    assert.deepEqual(r.data.avatarDecorations, [
      { id: "d1", angle: 0.25, url: "https://d/1.png" },
      { id: "d2", url: "https://d/2.png" },
    ]);
    await f.setPolicy(f.ids.c, "avatarDecorationLimit", 1);
    assert.equal(E(await f.call("i/update", { avatarDecorations: [{ id: "d1" }, { id: "d2" }] }, "c")), "8feff0ba-5ab5-585b-31f4-4df816663fad");
  });

  it("alsoKnownAs: known users only, not yourself", async () => {
    const r = await f.call("i/update", { alsoKnownAs: ["@user_a"] }, "c");
    assert.equal(r.status, 200, JSON.stringify(r.data));
    // stored as URIs, packed as user ids (upstream UserEntityService)
    assert.deepEqual(r.data.alsoKnownAs, [f.ids.a]);
    assert.deepEqual((await f.db.query(`SELECT "alsoKnownAs" FROM "user" WHERE id = $1`, [f.ids.c])).rows[0], { alsoKnownAs: `https://misskey.example.com/users/${f.ids.a}` }); // simple-array (comma-joined text), as upstream
    assert.equal(E(await f.call("i/update", { alsoKnownAs: ["@user_c"] }, "c")), "25c90186-4ab0-49c8-9bba-a1fa6c202ba4");
    assert.equal(E(await f.call("i/update", { alsoKnownAs: ["@ghost@remote.example"] }, "c")), "fcd2eef9-a9b2-4c4f-8624-038099e90aa5");
    assert.equal((await f.call("i/update", { alsoKnownAs: [] }, "c")).data.alsoKnownAs, null);
  });

  it("unlocking accepts pending follow requests", async () => {
    assert.equal((await f.call("i/update", { isLocked: true }, "a")).data.isLocked, true);
    assert.equal((await f.call("following/create", { userId: f.ids.a }, "c")).status, 200);
    // users/relation answers an array even for a single id (upstream)
    assert.equal((await f.call("users/relation", { userId: f.ids.a }, "c")).data[0].hasPendingFollowRequestFromYou, true);
    assert.equal((await f.call("i/update", { isLocked: false }, "a")).data.isLocked, false);
    const rel = (await f.call("users/relation", { userId: f.ids.a }, "c")).data[0];
    assert.equal(rel.isFollowing, true);
    assert.equal(rel.hasPendingFollowRequestFromYou, false);
  });

  it("prohibited name words (moderators exempt)", async () => {
    await f.db.query(`UPDATE meta SET "prohibitedWordsForNameOfUser" = '{admin}'`);
    const r = await f.call("i/update", { name: "the admin" }, "c");
    assert.equal(r.status, 422);
    assert.equal(E(r), "0b3f9f6a-2f4d-4b1f-9fb4-49d3a2fd7191");
    assert.equal((await f.call("i/update", { name: "the admin" }, "a")).status, 200); // root
    await f.db.query(`UPDATE meta SET "prohibitedWordsForNameOfUser" = '{}'`);
  });
});

describe("notes/create mentionLimit", () => {
  it("counts mentions, the reply target's author and specified recipients", async () => {
    await f.setPolicy(f.ids.c, "mentionLimit", 1);
    assert.equal((await f.call("notes/create", { text: "hi @user_a" }, "c")).status, 200);
    assert.equal(E(await f.call("notes/create", { text: "hi @user_a @user_b" }, "c")), "4de0363a-3046-481b-9b0f-feff3e211025");
    const parent = await f.note(f.ids.a, { text: "parent" });
    assert.equal(E(await f.call("notes/create", { text: "re @user_b", replyId: parent }, "c")), "4de0363a-3046-481b-9b0f-feff3e211025");
    assert.equal(E(await f.call("notes/create", { text: "dm", visibility: "specified", visibleUserIds: [f.ids.a, f.ids.b] }, "c")), "4de0363a-3046-481b-9b0f-feff3e211025");
    assert.equal((await f.call("notes/create", { text: "self @user_c @user_a" }, "c")).status, 400); // the author counts too, as upstream
  });
});
