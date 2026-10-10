/**
 * checkHitAntenna (pure port of upstream AntennaService.checkHitAntenna).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkHitAntenna, type AntennaFacts, type AntennaNote, type AntennaNoteUser, type AntennaRow } from "./antenna.js";

const antenna = (o: Partial<AntennaRow> = {}): AntennaRow => ({
  id: "an", userId: "owner", src: "all", userListId: null, keywords: [["cat"]], excludeKeywords: [], users: [],
  caseSensitive: false, localOnly: false, excludeBots: false, withReplies: false, withFile: false, excludeNotesInSensitiveChannel: false, ...o,
});
const note = (o: Partial<AntennaNote> = {}): AntennaNote => ({
  userId: "author", text: "I love Cats", cw: null, replyId: null, visibility: "public", visibleUserIds: [], fileIds: [], channelIsSensitive: false, ...o,
});
const user: AntennaNoteUser = { username: "Alice", host: null, isBot: false };
const facts = (o: Partial<AntennaFacts> = {}): AntennaFacts => ({ ownersFollowingAuthor: new Set(), listsWithAuthor: new Set(), ...o });
const hit = (a: Partial<AntennaRow>, n: Partial<AntennaNote> = {}, u: Partial<typeof user> = {}, f: Partial<AntennaFacts> = {}) =>
  checkHitAntenna(antenna(a), note(n), { ...user, ...u }, facts(f), "example.com");

describe("checkHitAntenna", () => {
  it("keywords: OR of AND groups, case, cw, exclude, empty groups", () => {
    assert.equal(hit({}), true);
    assert.equal(hit({ caseSensitive: true }), false);
    assert.equal(hit({ keywords: [["dog"], ["love", "cat"]] }), true);
    assert.equal(hit({ keywords: [["love", "dog"]] }), false);
    assert.equal(hit({}, { text: null, cw: "cat pics" }), true);
    assert.equal(hit({}, { text: null, cw: null }), false);
    assert.equal(hit({ excludeKeywords: [["love"]] }), false);
    assert.equal(hit({ keywords: [[""]], excludeKeywords: [["dog"]] }), true); // only "" → no keyword filter
    assert.equal(hit({ keywords: [], excludeKeywords: [["dog"]] }, { text: null }), false);
  });

  it("replies, bots, local only, files, sensitive channels", () => {
    assert.equal(hit({}, { replyId: "r" }), false);
    assert.equal(hit({ withReplies: true }, { replyId: "r" }), true);
    assert.equal(hit({ excludeBots: true }, {}, { isBot: true }), false);
    assert.equal(hit({ localOnly: true }, {}, { host: "remote.example" }), false);
    assert.equal(hit({ withFile: true }), false);
    assert.equal(hit({ withFile: true }, { fileIds: ["f"] }), true);
    assert.equal(hit({ excludeNotesInSensitiveChannel: true }, { channelIsSensitive: true }), false);
  });

  it("visibility: specified needs the owner as recipient, followers needs a follow", () => {
    assert.equal(hit({}, { visibility: "specified" }), false);
    assert.equal(hit({}, { visibility: "specified", visibleUserIds: ["owner"] }), true);
    assert.equal(hit({ userId: "author" }, { visibility: "specified" }), true);
    assert.equal(hit({}, { visibility: "followers" }), false);
    assert.equal(hit({}, { visibility: "followers" }, {}, { ownersFollowingAuthor: new Set(["owner"]) }), true);
  });

  it("sources: list, users, users_blacklist (acct with local host), home = all", () => {
    assert.equal(hit({ src: "list", userListId: "L" }), false);
    assert.equal(hit({ src: "list", userListId: "L" }, {}, {}, { listsWithAuthor: new Set(["L"]) }), true);
    assert.equal(hit({ src: "users", users: ["@alice"] }), true);
    assert.equal(hit({ src: "users", users: ["@alice@example.com"] }), true);
    assert.equal(hit({ src: "users", users: ["@alice@remote.example"] }), false);
    assert.equal(hit({ src: "users", users: ["@alice@remote.example"] }, {}, { host: "Remote.Example" }), true);
    assert.equal(hit({ src: "users_blacklist", users: ["alice"] }), false);
    assert.equal(hit({ src: "users_blacklist", users: ["bob"] }), true);
    assert.equal(hit({ src: "home" }), true);
  });
});
