import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { packMetaLite, packMetaDetailed } from "./meta.js";
import { packUserLite, getIdenticonUrl } from "./user.js";
import { packNote } from "./note.js";
import { fixtureMeta, fixtureLocalUser, fixtureRemoteUser, fixtureNote, testConfig } from "./fixtures.js";
import { DEFAULT_POLICIES } from "./policies.js";

describe("packMetaLite", () => {
  it("packs core MetaLite fields and merges policies", () => {
    const packed = packMetaLite(fixtureMeta(), testConfig, []);
    assert.equal(packed.name, "Example");
    assert.equal(packed.uri, testConfig.url);
    assert.equal(packed.version, testConfig.version);
    assert.equal(packed.mascotImageUrl, "/assets/ai.png");
    assert.equal(packed.maxNoteTextLength, 3000);
    assert.equal(packed.translatorAvailable, false);
    assert.equal(packed.federation, "all");
    assert.equal(packed.noteSearchableScope, "global");
    assert.equal(packed.policies.ltlAvailable, true);
    assert.equal(packed.policies.gtlAvailable, false);
    assert.equal(packed.policies.canPublicNote, DEFAULT_POLICIES.canPublicNote);
    assert.deepEqual(packed.ads, []);
    assert.deepEqual(packed.serverRules, ["Be nice"]);
  });

  it("marks translatorAvailable when deepl key set", () => {
    const packed = packMetaLite(fixtureMeta({ deeplAuthKey: "x" }), testConfig);
    assert.equal(packed.translatorAvailable, true);
  });
});

describe("packMetaLite themes (MetaEntityService: JSON5 → JSON)", () => {
  it("JSON5 is normalized to JSON; unparsable or empty is null", () => {
    const theme = (t: string | null) => packMetaLite(fixtureMeta({ defaultLightTheme: t, defaultDarkTheme: t }), testConfig);
    const json5 = "{\n  // comment\n  id: 'x', props: { accent: '#fff', },\n}";
    assert.equal(theme(json5).defaultLightTheme, '{"id":"x","props":{"accent":"#fff"}}');
    assert.equal(theme(json5).defaultDarkTheme, '{"id":"x","props":{"accent":"#fff"}}');
    assert.equal(theme('{"id":"y"}').defaultLightTheme, '{"id":"y"}');
    assert.equal(theme("{ broken").defaultLightTheme, null);
    assert.equal(theme(null).defaultLightTheme, null);
  });
});

describe("packMetaDetailed", () => {
  it("adds features and requireSetup", () => {
    const detailed = packMetaDetailed(fixtureMeta({ rootUserId: null, disableRegistration: true }), testConfig, {
      proxyAccountName: "proxy",
    });
    assert.equal(detailed.requireSetup, true);
    assert.equal(detailed.proxyAccountName, "proxy");
    assert.equal(detailed.features?.registration, false);
    assert.equal(detailed.features?.miauth, true);
    assert.equal(detailed.features?.objectStorage, true);
    assert.equal(detailed.features?.localTimeline, true);
    assert.equal(detailed.features?.globalTimeline, false);
    assert.equal(detailed.cacheRemoteFiles, false);
  });
});

describe("packUserLite", () => {
  it("packs local user with isCat and identicon avatar", () => {
    const user = fixtureLocalUser();
    const packed = packUserLite(user, testConfig);
    assert.equal(packed.username, "ai");
    assert.equal(packed.host, null);
    assert.equal(packed.isCat, true);
    assert.equal(packed.isBot, false);
    assert.equal(packed.onlineStatus, "online");
    assert.ok(packed.avatarUrl.includes("/identicon/ai@misskey.example.com"));
    assert.equal(packed.requireSigninToViewContents, undefined);
    assert.deepEqual(packed.emojis, {});
    assert.deepEqual(packed.avatarDecorations, []);
  });

  it("packs remote userHost and identicon", () => {
    const user = fixtureRemoteUser({ id: "remoteuser000001" });
    const packed = packUserLite(user, testConfig);
    assert.equal(packed.host, "remote.example");
    assert.ok(packed.avatarUrl.includes("bob@remote.example"));
  });

  it("getIdenticonUrl uses meta icon for dotted local system accounts", () => {
    const url = getIdenticonUrl(
      { username: "instance.actor", host: null },
      testConfig,
      "https://misskey.example.com/icon.png",
    );
    assert.equal(url, "https://misskey.example.com/icon.png");
  });
});

describe("packNote", () => {
  it("packs local note with reactionCount and nested user", () => {
    const user = fixtureLocalUser({ id: "localuser0000001" });
    const packedUser = packUserLite(user, testConfig);
    const note = fixtureNote(user.id, {
      reactions: { "👍": 2, "❤️": 1 },
      tags: ["misskey"],
    });
    const packed = packNote(note, { user: packedUser });
    assert.equal(packed.userId, user.id);
    assert.equal(packed.text, "hello world");
    assert.equal(packed.visibility, "public");
    assert.equal(packed.reactionCount, 3);
    assert.deepEqual(packed.reactions, { "👍": 2, "❤️": 1 });
    assert.equal(packed.user.isCat, true);
    assert.ok(packed.createdAt.endsWith("Z"));
    assert.deepEqual(packed.tags, ["misskey"]);
    assert.equal(packed.clippedCount, 0);
    assert.deepEqual(packed.files, []);
  });

  it("formats named AP note text like upstream", () => {
    const user = fixtureLocalUser({ id: "localuser0000002" });
    const packedUser = packUserLite(user, testConfig);
    const note = fixtureNote(user.id, {
      name: "Article",
      text: "body",
      uri: "https://remote.example/notes/1",
      url: "https://remote.example/notes/1",
      userHost: "remote.example",
    });
    const packed = packNote(note, { user: packedUser, detail: false });
    assert.equal(packed.text, "【Article】\nbody\n\nhttps://remote.example/notes/1");
    assert.equal(packed.uri, "https://remote.example/notes/1");
    assert.equal(packed.clippedCount, undefined);
  });
});
