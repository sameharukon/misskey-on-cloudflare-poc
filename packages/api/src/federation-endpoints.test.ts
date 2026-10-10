/**
 * Federation / instance management (PGlite, remote fetches mocked): federation/*, admin/federation/*,
 * ap/get|show, admin/relays/*; `instance` stats kept by the AP layer (remote user / note / follow).
 */
import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseActivity } from "../../ap/src/index.js";
import { IMPLEMENTED_ENDPOINTS } from "./registry.js";
import { makeFixture, type Fixture } from "./pglite-fixture.js";
import { setFederationPolicy } from "./ap/federation.js";
import { InMemoryQueueProducer, MK_DELIVER, setQueueProducer } from "./queues/fanout.js";
import { applyActivity } from "./ap/inbox.js";
import { enqueueDeliver } from "./ap/deliver.js";
import { semverSatisfies } from "./ap/instances.js";
import * as g from "./graph-pg.js";
import { ENDPOINT_PARAM_DEFS } from "./endpoint-params.gen.js";

let f: Fixture;
let q: InMemoryQueueProducer;
const remote = new Map<string, () => Response>();
const fetched: string[] = [];
const json = (o: unknown) => () => new Response(JSON.stringify(o), { headers: { "Content-Type": "application/activity+json" } });

const ENDPOINTS = [
  "federation/followers", "federation/following", "federation/instances", "federation/show-instance", "federation/stats",
  "federation/users", "federation/update-remote-user", "admin/federation/update-instance", "admin/federation/delete-all-files",
  "admin/federation/remove-all-following", "admin/federation/refresh-remote-instance-metadata", "ap/get", "ap/show",
  "admin/relays/add", "admin/relays/list", "admin/relays/remove",
];

const actor = (name: string, extra: Record<string, unknown> = {}) => ({
  "@context": "https://www.w3.org/ns/activitystreams",
  id: `https://remote.example/users/${name}`,
  type: "Person",
  preferredUsername: name,
  name: `${name} san`,
  inbox: `https://remote.example/users/${name}/inbox`,
  endpoints: { sharedInbox: "https://remote.example/inbox" },
  followers: `https://remote.example/users/${name}/followers`,
  ...extra,
});

before(async () => {
  f = await makeFixture("FederationTest");
  setFederationPolicy(f.env, { mode: "all", hosts: [], blockedHosts: ["bad.example"] });
  q = new InMemoryQueueProducer();
  setQueueProducer(f.env, q);
  f.env.AP_FETCH = (async (url: string) => {
    fetched.push(url);
    const h = remote.get(url);
    return h ? h() : new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  remote.set("https://remote.example/users/alice", json(actor("alice")));
});

const E = (r: { data: any }) => r.data?.error?.id;
const rows = async (sql: string, p: unknown[] = []) => (await f.db.query(sql, p)).rows as any[];
const instanceRow = async (host: string) => (await rows(`SELECT * FROM instance WHERE host = $1`, [host]))[0];
const userId = async (username: string) => (await rows(`SELECT id FROM "user" WHERE "usernameLower" = $1`, [username]))[0]?.id as string;
const delivered = () => q.ofQueue<{ inbox: string; signerId: string; activity: any }>(MK_DELIVER);

describe("federation endpoints", () => {
  it("registers endpoints", () => {
    for (const e of ENDPOINTS) {
      assert.ok((IMPLEMENTED_ENDPOINTS as readonly string[]).includes(e), e);
      assert.ok(ENDPOINT_PARAM_DEFS[e], e);
    }
  });

  it("ap/show resolves a remote user and note (instance stats follow)", async () => {
    const u = await f.call("ap/show", { uri: "https://remote.example/users/alice" }, "b");
    assert.equal(u.status, 200);
    assert.equal(u.data.type, "User");
    assert.deepEqual([u.data.object.username, u.data.object.host, u.data.object.name], ["alice", "remote.example", "alice san"]);
    assert.equal((await instanceRow("remote.example")).usersCount, 1);
    // second time: from the DB, no fetch
    const n = fetched.length;
    assert.equal((await f.call("ap/show", { uri: "https://remote.example/users/alice" }, "b")).data.object.id, u.data.object.id);
    assert.equal(fetched.length, n);

    remote.set("https://remote.example/notes/1", json({
      id: "https://remote.example/notes/1", type: "Note", attributedTo: "https://remote.example/users/alice",
      content: "<p>hello</p>", to: ["https://www.w3.org/ns/activitystreams#Public"], published: new Date().toISOString(),
    }));
    const note = await f.call("ap/show", { uri: "https://remote.example/notes/1" }, "b");
    assert.equal(note.data.type, "Note");
    assert.equal(note.data.object.text, "hello");
    assert.equal(note.data.object.user.username, "alice");
    assert.equal((await instanceRow("remote.example")).notesCount, 1);

    // local objects come from the DB
    const local = await f.call("ap/show", { uri: `https://misskey.example.com/users/${f.ids.c}` }, "b");
    assert.deepEqual([local.data.type, local.data.object.id], ["User", f.ids.c]);
    const localNote = await f.note(f.ids.c, { text: "local" });
    assert.equal((await f.call("ap/show", { uri: `https://misskey.example.com/notes/${localNote}` }, "b")).data.object.id, localNote);
    assert.equal(E(await f.call("ap/show", { uri: "https://misskey.example.com/notes/nope" }, "b")), "dc94d745-1262-4e63-a17d-fecaa57efc82");

    // errors
    assert.equal(E(await f.call("ap/show", { uri: "https://x.bad.example/users/z" }, "b")), "974b799e-1a29-4889-b706-18d4dd93e266");
    assert.equal(E(await f.call("ap/show", { uri: "https://remote.example/users/ghost" }, "b")), "81b539cf-4f57-4b29-bc98-032c33c0792e");
    remote.set("https://remote.example/broken", () => new Response("<html>", { status: 200 }));
    assert.equal(E(await f.call("ap/show", { uri: "https://remote.example/broken" }, "b")), "70193c39-54f3-4813-82f0-70a680f7495b");
    assert.equal(E(await f.call("ap/show", { uri: "https://127.0.0.1/users/x" }, "b")), "1a5eab56-e47b-48c2-8d5e-217b897d70db");
    assert.equal((await f.call("ap/show", { uri: "https://remote.example/users/alice" })).status, 401);
  });

  it("ap/get (administrators)", async () => {
    assert.equal((await f.call("ap/get", { uri: "https://remote.example/notes/1" }, "b")).status, 403);
    const r = await f.call("ap/get", { uri: "https://remote.example/notes/1" }, "a");
    assert.deepEqual([r.data.id, r.data.type], ["https://remote.example/notes/1", "Note"]);
    assert.equal((await f.call("ap/get", { uri: "https://remote.example/users/ghost" }, "a")).status, 500);
    assert.equal((await f.call("ap/get", { uri: "https://bad.example/x" }, "a")).status, 500);
  });

  it("follows keep instance counts; federation/followers|following|users|stats", async () => {
    const alice = await userId("alice");
    // remote → local (alice follows b), local → remote (a follows alice, accepted)
    assert.equal(await g.followWithPolicy(f.env, alice, f.ids.b), "followed");
    assert.equal(await g.followWithPolicy(f.env, f.ids.a, alice), "requested");
    assert.ok(await g.acceptRequest(f.env, alice, f.ids.a));
    let i = await instanceRow("remote.example");
    assert.deepEqual([i.followingCount, i.followersCount], [1, 1]);

    const following = await f.call("federation/following", { host: "remote.example" });
    assert.deepEqual(following.data.map((x: any) => [x.followerId, x.followeeId, x.followee.id]), [[alice, f.ids.b, f.ids.b]]);
    assert.ok(following.data[0].createdAt);
    assert.equal("follower" in following.data[0], false);
    const followers = await f.call("federation/followers", { host: "remote.example" });
    assert.deepEqual(followers.data.map((x: any) => [x.followerId, x.followee.username]), [[f.ids.a, "alice"]]);
    // owner (alice) hides her followers: anonymous / non-followers see nothing, moderators see all
    await f.db.query(`UPDATE user_profile SET "followersVisibility" = 'followers' WHERE "userId" = $1`, [alice]);
    assert.equal((await f.call("federation/followers", { host: "remote.example" })).data.length, 0);
    assert.equal((await f.call("federation/followers", { host: "remote.example" }, "c")).data.length, 0);
    assert.equal((await f.call("federation/followers", { host: "remote.example" }, "a")).data.length, 1);
    await f.db.query(`UPDATE user_profile SET "followersVisibility" = 'public' WHERE "userId" = $1`, [alice]);
    assert.equal((await f.call("federation/followers", { host: "remote.example" }, "a")).data.length, 1);
    assert.equal((await f.call("federation/following", { host: "remote.example", limit: 0 })).status, 400);
    assert.equal((await f.call("federation/following", {})).status, 400);

    const users = await f.call("federation/users", { host: "remote.example" });
    assert.deepEqual(users.data.map((u: any) => u.username), ["alice"]);
    assert.equal(users.data[0].host, "remote.example");

    const s = (await f.call("federation/stats", {})).data;
    assert.deepEqual(s.topSubInstances.map((x: any) => x.host), ["remote.example"]);
    assert.deepEqual(s.topPubInstances.map((x: any) => x.host), ["remote.example"]);
    assert.deepEqual([s.otherFollowersCount, s.otherFollowingCount], [0, 0]);

    // unfollow decrements
    assert.ok(await g.unfollow(f.env, f.ids.a, alice));
    i = await instanceRow("remote.example");
    assert.deepEqual([i.followingCount, i.followersCount], [1, 0]);
  });

  it("federation/instances / show-instance pack and filters", async () => {
    const ins = (id: string, host: string, extra: string) =>
      f.db.query(`INSERT INTO instance (id, host, "firstRetrievedAt", "usersCount"${extra ? ", " + extra.split("=")[0] : ""}) VALUES ($1, $2, now(), $3${extra ? ", " + extra.split("=")[1] : ""})`, [id, host, id.length]);
    await ins("i1", "silent.example", "");
    await ins("i22", "media.example", "");
    await ins("i333", "old.example", `"softwareName"='mastodon'`);
    await f.db.query(`UPDATE instance SET "softwareVersion" = '3.5.1', "isNotResponding" = true WHERE host = 'old.example'`);
    await ins("i4444", "sub.blocked.example", "");
    await f.db.query(`UPDATE meta SET "blockedHosts" = '{blocked.example}', "silencedHosts" = '{silent.example}', "mediaSilencedHosts" = '{media.example}',
      "deliverSuspendedSoftware" = '[{"software":"mastodon","versionRange":"<4.0.0"}]'`);

    const show = (await f.call("federation/show-instance", { host: "OLD.example" })).data;
    assert.deepEqual([show.host, show.isSuspended, show.suspensionState, show.isNotResponding, show.moderationNote], ["old.example", true, "softwareSuspended", true, null]);
    assert.equal(show.moderationNote, null);
    assert.equal((await f.call("federation/show-instance", { host: "old.example" }, "a")).data.moderationNote, "");
    assert.equal((await f.call("federation/show-instance", { host: "none.example" })).data, null);
    assert.equal((await f.call("federation/show-instance", { host: "silent.example" })).data.isSilenced, true);
    assert.equal((await f.call("federation/show-instance", { host: "media.example" })).data.isMediaSilenced, true);
    assert.equal((await f.call("federation/show-instance", { host: "sub.blocked.example" })).data.isBlocked, true);
    assert.equal((await f.call("federation/show-instance", { host: "remote.example" })).data.isBlocked, false);

    const hosts = async (b: Record<string, unknown>) => (await f.call("federation/instances", b)).data.map((x: any) => x.host);
    assert.equal((await hosts({})).length, 5);
    assert.deepEqual(await hosts({ sort: "+users" }), ["sub.blocked.example", "old.example", "media.example", "silent.example", "remote.example"]);
    assert.deepEqual(await hosts({ silenced: true }), ["silent.example"]);
    assert.deepEqual(await hosts({ blocked: true }), []); // upstream: exact match on the list
    assert.equal((await hosts({ blocked: false })).length, 5);
    assert.deepEqual(await hosts({ notResponding: true }), ["old.example"]);
    assert.deepEqual(await hosts({ federating: true }), ["remote.example"]);
    assert.deepEqual(await hosts({ publishing: true }), ["remote.example"]);
    assert.deepEqual(await hosts({ subscribing: true }), []);
    assert.deepEqual(await hosts({ host: "EXAMPLE", sort: "-users", limit: 2, offset: 1 }), ["silent.example", "media.example"]);
    assert.equal((await f.call("federation/instances", { sort: "nope" })).status, 400);
    const one = (await f.call("federation/instances", { host: "remote" })).data[0];
    assert.deepEqual(Object.keys(one).sort(), [
      "description", "faviconUrl", "firstRetrievedAt", "followersCount", "followingCount", "host", "iconUrl", "id", "infoUpdatedAt",
      "isBlocked", "isMediaSilenced", "isNotResponding", "isSilenced", "isSuspended", "latestRequestReceivedAt", "maintainerEmail",
      "maintainerName", "moderationNote", "name", "notesCount", "openRegistrations", "softwareName", "softwareVersion", "suspensionState",
      "themeColor", "usersCount",
    ]);
  });

  it("admin/federation/update-instance (moderation log)", async () => {
    assert.equal((await f.call("admin/federation/update-instance", { host: "remote.example", isSuspended: true }, "b")).status, 403);
    assert.equal((await f.call("admin/federation/update-instance", { host: "nowhere.example", isSuspended: true }, "a")).status, 500);
    assert.equal((await f.call("admin/federation/update-instance", { host: "remote.example", isSuspended: true, moderationNote: "spam" }, "a")).status, 204);
    const i = await instanceRow("remote.example");
    assert.deepEqual([i.suspensionState, i.moderationNote], ["manuallySuspended", "spam"]);
    assert.deepEqual((await f.call("federation/instances", { suspended: true })).data.map((x: any) => x.host).sort(), ["remote.example"]);
    await f.call("admin/federation/update-instance", { host: "remote.example", isSuspended: true }, "a"); // no change → no log
    await f.call("admin/federation/update-instance", { host: "remote.example", isSuspended: false }, "a");
    const logs = await rows(`SELECT type, info FROM moderation_log WHERE "userId" = $1 ORDER BY id`, [f.ids.a]);
    assert.deepEqual(logs.map((l) => l.type), ["suspendRemoteInstance", "updateRemoteInstanceNote", "unsuspendRemoteInstance"]);
    assert.deepEqual(logs[1].info, { id: i.id, host: "remote.example", before: "", after: "spam" });
    assert.equal((await instanceRow("remote.example")).suspensionState, "none");
  });

  it("admin/federation/refresh-remote-instance-metadata (nodeinfo, manifest, html)", async () => {
    remote.set("https://remote.example/.well-known/nodeinfo", json({ links: [{ rel: "http://nodeinfo.diaspora.software/ns/schema/2.0", href: "https://remote.example/nodeinfo/2.0" }] }));
    remote.set("https://remote.example/nodeinfo/2.0", json({
      software: { name: "Misskey", version: "2025.1.0" }, openRegistrations: true,
      metadata: { nodeName: "Remote Key", nodeDescription: "a server", maintainer: { name: "admin", email: "a@remote.example" }, themeColor: "#ABC" },
    }));
    remote.set("https://remote.example/", () => new Response(`<html><head><link rel="icon" href="/fav.png"><link rel="apple-touch-icon" href="/apple.png"></head></html>`));
    assert.equal((await f.call("admin/federation/refresh-remote-instance-metadata", { host: "remote.example" }, "b")).status, 403);
    assert.equal((await f.call("admin/federation/refresh-remote-instance-metadata", { host: "nowhere.example" }, "a")).status, 500);
    assert.equal((await f.call("admin/federation/refresh-remote-instance-metadata", { host: "remote.example" }, "a")).status, 204);
    const s = (await f.call("federation/show-instance", { host: "remote.example" })).data;
    assert.deepEqual(
      [s.softwareName, s.softwareVersion, s.openRegistrations, s.name, s.description, s.maintainerName, s.maintainerEmail, s.themeColor, s.faviconUrl, s.iconUrl],
      ["misskey", "2025.1.0", true, "Remote Key", "a server", "admin", "a@remote.example", "#aabbcc", "https://remote.example/fav.png", "https://remote.example/apple.png"],
    );
    assert.ok(s.infoUpdatedAt);
  });

  it("federation/update-remote-user re-fetches the actor", async () => {
    remote.set("https://remote.example/users/alice", json(actor("alice", {
      name: "Alice v2",
      manuallyApprovesFollowers: true,
      // PropertyValue attachments → profile fields (ApPersonService.analyzeAttachments)
      attachment: [
        { type: "PropertyValue", name: "site", value: '<a href="https://example.com/" rel="me">https://example.com/</a>' },
        { type: "PropertyValue", name: "plain", value: "a &amp; b" },
        { type: "PropertyValue", name: "bad", value: 1 },
        { type: "Image", name: "img", value: "x" },
      ],
    })));
    const alice = await userId("alice");
    assert.equal((await f.call("federation/update-remote-user", { userId: alice })).status, 401);
    assert.equal((await f.call("federation/update-remote-user", { userId: alice }, "b")).status, 204);
    const u = (await rows(`SELECT name, "isLocked" FROM "user" WHERE id = $1`, [alice]))[0];
    assert.deepEqual([u.name, u.isLocked], ["Alice v2", true]);
    assert.deepEqual((await f.call("users/show", { userId: alice }, "b")).data.fields, [
      { name: "site", value: "https://example.com/" },
      { name: "plain", value: "a & b" },
    ]);
    assert.equal((await f.call("federation/update-remote-user", { userId: f.ids.c }, "b")).status, 500);
    assert.equal((await f.call("federation/update-remote-user", { userId: "nope" }, "b")).status, 500);
  });

  it("featured collection → pinned notes; inbound Add / Remove (ApPersonService.updateFeatured, ApInboxService.add / remove)", async () => {
    const base = "https://remote.example/users/pinner";
    const note = (n: number, by = base) => ({
      id: `https://remote.example/pin/${n}`, type: "Note", attributedTo: by, content: `<p>pin ${n}</p>`,
      to: ["https://www.w3.org/ns/activitystreams#Public"], published: new Date().toISOString(),
    });
    // pin/1 embedded, pin/2 by reference, someone else's note and an off-host item are skipped
    remote.set("https://remote.example/pin/2", json(note(2)));
    remote.set("https://remote.example/pin/3", json(note(3, "https://remote.example/users/alice")));
    remote.set(`${base}/collections/featured`, json({
      id: `${base}/collections/featured`, type: "OrderedCollection",
      orderedItems: [note(1), "https://remote.example/pin/2", "https://remote.example/pin/3", "https://other.example/pin/9"],
    }));
    remote.set(base, json(actor("pinner", { featured: `${base}/collections/featured` })));
    const u = await f.call("ap/show", { uri: base }, "b");
    assert.equal(u.status, 200);
    const pinner = u.data.object.id as string;
    const pins = async () => (await rows(
      `SELECT n.uri FROM user_note_pining p JOIN note n ON n.id = p."noteId" WHERE p."userId" = $1 ORDER BY p.id DESC`, [pinner],
    )).map((r) => r.uri);
    assert.deepEqual(await pins(), ["https://remote.example/pin/1", "https://remote.example/pin/2"]);
    assert.deepEqual((await f.call("users/show", { userId: pinner }, "b")).data.pinnedNotes.map((n: any) => n.uri), await pins());

    const user = { id: pinner, uri: base, host: "remote.example", username: "pinner", inbox: `${base}/inbox`, sharedInbox: null, followersUri: null, isLocked: false };
    const act = (type: string, object: unknown, target = `${base}/collections/featured`) => parseActivity({ type, actor: base, object, target })!;
    remote.set("https://remote.example/pin/4", json(note(4)));
    assert.equal((await applyActivity(f.env, user, act("Add", "https://remote.example/pin/4"))).reason, "pinned");
    assert.equal((await applyActivity(f.env, user, act("Add", "https://remote.example/pin/4"))).reason, "already_pinned");
    assert.equal((await applyActivity(f.env, user, act("Add", "https://remote.example/pin/3"))).reason, "no_such_note");
    assert.equal((await applyActivity(f.env, user, act("Add", "https://remote.example/pin/2", `${base}/other`))).reason, "unknown_target");
    assert.deepEqual((await pins()).sort(), ["https://remote.example/pin/1", "https://remote.example/pin/2", "https://remote.example/pin/4"]);
    assert.equal((await applyActivity(f.env, user, act("Remove", "https://remote.example/pin/1"))).reason, "unpinned");
    assert.deepEqual((await pins()).sort(), ["https://remote.example/pin/2", "https://remote.example/pin/4"]);
  });

  it("an activity without an id gets {url}/{uuid} (upstream addContext; Misskey drops id-less activities)", async () => {
    q.messages.length = 0;
    const accept = { type: "Accept", actor: `https://misskey.example.com/users/${f.ids.a}`, object: "https://remote.example/follows/1" };
    await enqueueDeliver(f.env, f.ids.a, ["https://remote.example/inbox", "https://remote.example/users/alice/inbox"], accept);
    const ids = delivered().map((m) => m.activity.id);
    assert.equal(ids.length, 2);
    assert.match(ids[0], /^https:\/\/misskey\.example\.com\/[0-9a-f-]{36}$/);
    assert.equal(ids[1], ids[0]); // one activity, one id for every inbox
    const withId = { ...accept, id: "https://misskey.example.com/x" };
    q.messages.length = 0;
    await enqueueDeliver(f.env, f.ids.a, ["https://remote.example/inbox"], withId);
    assert.equal(delivered()[0]!.activity.id, "https://misskey.example.com/x");
  });

  it("remote avatar / banner become link drive files (ApPersonService.resolveAvatarAndBanner)", async () => {
    remote.set("https://remote.example/users/pic", json(actor("pic", {
      icon: { type: "Image", url: "https://remote.example/files/icon.png", mediaType: "image/png" },
      image: [{ type: "Image", url: "https://remote.example/files/banner.jpg" }],
    })));
    const u = (await f.call("ap/show", { uri: "https://remote.example/users/pic" }, "b")).data.object;
    const row = (await rows(`SELECT "avatarId", "avatarUrl", "bannerId", "bannerUrl" FROM "user" WHERE id = $1`, [u.id]))[0];
    const files = await rows(`SELECT id, uri, "isLink", "userHost", "webpublicAccessKey" FROM drive_file WHERE "userId" = $1 ORDER BY uri`, [u.id]);
    assert.deepEqual(files.map((x) => [x.uri, x.isLink, x.userHost]), [
      ["https://remote.example/files/banner.jpg", true, "remote.example"],
      ["https://remote.example/files/icon.png", true, "remote.example"],
    ]);
    assert.equal(row.avatarId, files[1].id);
    assert.equal(row.avatarUrl, "https://misskey.example.com/proxy/avatar.webp?url=https%3A%2F%2Fremote.example%2Ffiles%2Ficon.png&avatar=1");
    assert.equal(row.bannerId, files[0].id);
    assert.equal(row.bannerUrl, `https://misskey.example.com/files/${files[0].webpublicAccessKey}`);
    const shown = (await f.call("users/show", { userId: u.id }, "b")).data;
    assert.equal(shown.avatarUrl, row.avatarUrl);
    // a refetch reuses the files; a removed icon clears the avatar
    remote.set("https://remote.example/users/pic", json(actor("pic", { image: { type: "Image", url: "https://remote.example/files/banner.jpg" } })));
    assert.equal((await f.call("federation/update-remote-user", { userId: u.id }, "b")).status, 204);
    const after = (await rows(`SELECT "avatarId", "avatarUrl", "bannerId" FROM "user" WHERE id = $1`, [u.id]))[0];
    assert.deepEqual([after.avatarId, after.avatarUrl, after.bannerId], [null, null, files[0].id]);
    assert.equal((await rows(`SELECT 1 FROM drive_file WHERE "userId" = $1`, [u.id])).length, 2);
  });

  it("Update(Person) uses the embedded Person (the remote may serve a cached older document)", async () => {
    const id = await userId("alice");
    const uri = "https://remote.example/users/alice";
    const before = remote.get(uri);
    remote.set(uri, json(actor("alice", { name: "Alice stale" })));
    const user = { id, uri, host: "remote.example", username: "alice", inbox: `${uri}/inbox`, sharedInbox: null, followersUri: null, isLocked: false };
    const update = parseActivity({ type: "Update", id: `${uri}#updates/1`, actor: uri, object: actor("alice", { name: "Alice embedded" }) })!;
    assert.equal((await applyActivity(f.env, user, update)).reason, "actor_updated");
    assert.equal((await rows(`SELECT name FROM "user" WHERE id = $1`, [id]))[0].name, "Alice embedded");
    // an Update whose object is only the actor's id refetches it
    const byId = parseActivity({ type: "Update", id: `${uri}#updates/2`, actor: uri, object: uri })!;
    assert.equal((await applyActivity(f.env, user, byId)).reason, "actor_updated");
    assert.equal((await rows(`SELECT name FROM "user" WHERE id = $1`, [id]))[0].name, "Alice stale");
    if (before) remote.set(uri, before);
  });

  it("a Move already applied by Update(Person) does not refetch the actor (Mastodon serves a cached copy)", async () => {
    const uri = "https://remote.example/users/alice";
    const target = "https://remote.example/users/alice2";
    const id = await userId("alice");
    const user = { id, uri, host: "remote.example", username: "alice", inbox: `${uri}/inbox`, sharedInbox: null, followersUri: null, isLocked: false, movedToUri: target };
    const n = fetched.length;
    const move = parseActivity({ type: "Move", id: `${uri}#moves/1`, actor: uri, object: uri, target })!;
    assert.equal((await applyActivity(f.env, user, move)).reason, "move_already_processed");
    assert.equal(fetched.length, n);
    // another target: the actor is refetched (ApInboxService.move)
    assert.equal((await applyActivity(f.env, { ...user, movedToUri: null }, move)).reason, "move_processed");
    assert.ok(fetched.slice(n).includes(uri));
  });

  it("admin/federation/remove-all-following / delete-all-files", async () => {
    const alice = await userId("alice");
    q.messages.length = 0;
    assert.equal((await f.call("admin/federation/remove-all-following", { host: "remote.example" }, "b")).status, 403);
    assert.equal((await f.call("admin/federation/remove-all-following", { host: "remote.example" }, "a")).status, 204);
    assert.equal((await rows(`SELECT 1 FROM following WHERE "followerHost" = 'remote.example'`)).length, 0);
    assert.equal((await instanceRow("remote.example")).followingCount, 0);
    const d = delivered();
    assert.equal(d.length, 1);
    assert.deepEqual([d[0]!.signerId, d[0]!.activity.type, d[0]!.activity.object.actor], [f.ids.b, "Reject", "https://remote.example/users/alice"]);

    await f.db.query(`INSERT INTO drive_file (id, "userId", "userHost", "isLink", "accessKey", md5, name, type, size, "storedInternal", url) VALUES ('rf1', $1, 'remote.example', true, NULL, '0', 'f', 'application/octet-stream', 0, FALSE, ''), ('rf2', $1, 'remote.example', false, 'k2', '0', 'f', 'application/octet-stream', 0, FALSE, ''), ('lf1', $2, NULL, false, 'k3', '0', 'f', 'application/octet-stream', 0, FALSE, '')`, [alice, f.ids.a]);
    assert.equal((await f.call("admin/federation/delete-all-files", { host: "remote.example" }, "b")).status, 403);
    assert.equal((await f.call("admin/federation/delete-all-files", { host: "remote.example" }, "a")).status, 204);
    assert.deepEqual((await rows(`SELECT id FROM drive_file`)).map((r) => r.id), ["lf1"]);
  });

  it("admin/relays/add|list|remove (+ relay Accept)", async () => {
    q.messages.length = 0;
    assert.equal((await f.call("admin/relays/add", { inbox: "https://relay.example/inbox" }, "b")).status, 403);
    assert.equal(E(await f.call("admin/relays/add", { inbox: "http://relay.example/inbox" }, "a")), "fb8c92d3-d4e5-44e7-b3d4-800d5cef8b2c");
    assert.equal(E(await f.call("admin/relays/add", { inbox: "not a url" }, "a")), "fb8c92d3-d4e5-44e7-b3d4-800d5cef8b2c");
    const r = await f.call("admin/relays/add", { inbox: "https://relay.example/inbox" }, "a");
    assert.deepEqual([r.data.inbox, r.data.status], ["https://relay.example/inbox", "requesting"]);
    assert.equal((await f.call("admin/relays/add", { inbox: "https://relay.example/inbox" }, "a")).status, 500); // duplicate
    const relayActor = (await rows(`SELECT u.id, u.username, u."isBot", u."isLocked" FROM system_account s JOIN "user" u ON u.id = s."userId" WHERE s.type = 'relay'`))[0];
    assert.deepEqual([relayActor.username, relayActor.isBot, relayActor.isLocked], ["system.relay", true, true]);
    assert.equal((await rows(`SELECT 1 FROM user_keypair WHERE "userId" = $1`, [relayActor.id])).length, 1);
    const follow = delivered()[0]!;
    assert.deepEqual([follow.inbox, follow.signerId, follow.activity.type, follow.activity.object, follow.activity.id], [
      "https://relay.example/inbox", relayActor.id, "Follow", "https://www.w3.org/ns/activitystreams#Public",
      `https://misskey.example.com/activities/follow-relay/${r.data.id}`,
    ]);
    assert.deepEqual((await f.call("admin/relays/list", {}, "a")).data, [r.data]);

    // Accept from someone else is ignored; from the relay actor (inbox match) accepts
    const relayUser = { id: "x", uri: "https://relay.example/actor", host: "relay.example", username: "relay", inbox: "https://relay.example/inbox", sharedInbox: null, followersUri: null, isLocked: false };
    const accept = parseActivity({ type: "Accept", actor: relayUser.uri, object: follow.activity })!;
    assert.equal((await applyActivity(f.env, { ...relayUser, inbox: "https://evil.example/inbox" }, accept)).reason, "relay_noop");
    assert.equal((await applyActivity(f.env, relayUser, accept)).reason, "relay_accepted");
    assert.equal((await f.call("admin/relays/list", {}, "a")).data[0].status, "accepted");

    q.messages.length = 0;
    assert.equal((await f.call("admin/relays/remove", { inbox: "https://relay.example/inbox" }, "a")).status, 204);
    const undo = delivered()[0]!;
    assert.deepEqual([undo.activity.type, undo.activity.object.type, undo.signerId], ["Undo", "Follow", relayActor.id]);
    assert.deepEqual((await f.call("admin/relays/list", {}, "a")).data, []);
    assert.equal((await f.call("admin/relays/remove", { inbox: "https://relay.example/inbox" }, "a")).status, 500);
    // the system account is reused
    await f.call("admin/relays/add", { inbox: "https://relay2.example/inbox" }, "a");
    assert.equal((await rows(`SELECT 1 FROM system_account WHERE type = 'relay'`)).length, 1);
  });

  it("deliverSuspendedSoftware ranges (semver subset)", () => {
    const t: [string, string, boolean][] = [
      ["3.5.1", "<4.0.0", true], ["4.0.0", "<4.0.0", false], ["4.0.0-rc.1", "<4.0.0", true], ["1.2.3", "*", true],
      ["1.2.3", "^1.0.0", true], ["2.0.0", "^1.0.0", false], ["1.2.9", "~1.2.0", true], ["1.3.0", "~1.2.0", false],
      ["2024.5.0", ">=2024.3.1 <2024.6.0", true], ["1.0.0", "0.x || 1.x", true], ["1.5.0", "1.0.0 - 1.4.0", false], ["garbage", "*", false],
    ];
    for (const [v, r, want] of t) assert.equal(semverSatisfies(v, r), want, `${v} ${r}`);
  });
});
