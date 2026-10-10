/**
 * Federation gaps (PGlite, remote fetches mocked): signed GETs by the instance actor,
 * remote notes' attachments / custom emojis / hashtags / Question polls, AP votes and
 * Update(Question), inbound Delete(Person), the outbox / featured collections, the local Note's
 * attachment / tag / Question rendering, the followers / following pages, and the deliver
 * consumer's instance bookkeeping (isNotResponding, suspension, goneSuspended).
 */
import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { genAidx } from "../../id/src/index.js";
import { exportPkcs8Pem, exportSpkiPem, generateRsaKeyPair, parseActivity } from "../../ap/src/index.js";
import { makeFixture, type Fixture } from "./pglite-fixture.js";
import { setFederationPolicy } from "./ap/federation.js";
import { setUserKeypairForTest } from "./ap/keys.js";
import { InMemoryQueueProducer, MK_DELIVER, setQueueProducer } from "./queues/fanout.js";
import { applyActivity } from "./ap/inbox.js";
import { apGet, resolveRemoteUser, type RemoteUser } from "./ap/remote.js";
import { handleApRoutes, renderLocalNote } from "./ap/routes.js";
import { processDeliver } from "./ap/deliver.js";
import { getNotePg } from "./notes-pg.js";

let f: Fixture;
let q: InMemoryQueueProducer;
const remote = new Map<string, () => Response>();
const requests: { url: string; headers: Record<string, string> }[] = [];
const BASE = "https://misskey.example.com";
const rows = async (sql: string, p: unknown[] = []) => (await f.db.query(sql, p)).rows as any[];
const json = (o: unknown) => () => new Response(JSON.stringify(o), { headers: { "Content-Type": "application/activity+json" } });
const delivered = () => q.ofQueue<{ inbox: string; signerId: string; activity: any }>(MK_DELIVER);
const act = (o: Record<string, unknown>) => parseActivity(o)!;
let alice: RemoteUser;

const actor = (name: string, host: string) => ({
  "@context": "https://www.w3.org/ns/activitystreams",
  id: `https://${host}/users/${name}`,
  type: "Person",
  preferredUsername: name,
  inbox: `https://${host}/users/${name}/inbox`,
  endpoints: { sharedInbox: `https://${host}/inbox` },
  followers: `https://${host}/users/${name}/followers`,
});

const apGetReq = (path: string) => new Request(`${BASE}${path}`, { headers: { Accept: "application/activity+json" } });

before(async () => {
  f = await makeFixture("FederationGaps");
  setFederationPolicy(f.env, { mode: "all", hosts: [], blockedHosts: [] });
  q = new InMemoryQueueProducer();
  setQueueProducer(f.env, q);
  f.env.AP_FETCH = (async (url: string, init?: RequestInit) => {
    requests.push({ url, headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v])) });
    const h = remote.get(url);
    return h ? h() : new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  for (const who of ["a", "b"] as const) {
    const kp = await generateRsaKeyPair();
    setUserKeypairForTest(f.env, f.ids[who], { publicKey: await exportSpkiPem(kp.publicKey), privateKey: await exportPkcs8Pem(kp.privateKey) });
  }
  remote.set("https://remote.example/users/alice", json(actor("alice", "remote.example")));
  alice = await resolveRemoteUser(f.env, "https://remote.example/users/alice");
});

describe("authorized fetch", () => {
  it("GETs are signed by the instance actor (system.actor), unsigned when signToActivityPubGet is off", async () => {
    const sys = await rows(`SELECT u.id, u.username FROM system_account s JOIN "user" u ON u.id = s."userId" WHERE s.type = 'actor'`);
    assert.equal(sys.length, 1);
    assert.equal(sys[0].username, "system.actor");
    const get = requests.find((r) => r.url === "https://remote.example/users/alice")!;
    assert.match(get.headers.signature!, new RegExp(`keyId="${BASE}/users/${sys[0].id}#main-key"`));
    assert.match(get.headers.signature!, /headers="\(request-target\) date host accept"/);
    // the instance actor is served like any local actor (remote servers verify with its key)
    const person = await (await handleApRoutes(apGetReq(`/users/${sys[0].id}`), f.env))!.json() as any;
    assert.equal(person.preferredUsername, "system.actor");
    assert.match(person.publicKey.publicKeyPem, /BEGIN PUBLIC KEY/);

    const f2 = await makeFixture("FederationGapsUnsigned");
    await f2.db.exec(`UPDATE meta SET "signToActivityPubGet" = false`);
    const seen: Record<string, string>[] = [];
    f2.env.AP_FETCH = (async (_url: string, init?: RequestInit) => {
      seen.push((init?.headers ?? {}) as Record<string, string>);
      return new Response(JSON.stringify({ id: "x" }));
    }) as unknown as typeof fetch;
    await apGet(f2.env, "https://remote.example/notes/x");
    assert.equal(seen[0]!.Signature, undefined);
    assert.equal((await f2.db.query(`SELECT 1 FROM system_account`)).rows.length, 0);
  });
});

describe("remote notes", () => {
  it("Create(Note): attachments as link files, custom emojis, hashtags", async () => {
    const note = {
      id: "https://remote.example/notes/n1",
      type: "Note",
      attributedTo: alice.uri,
      content: "<p>hi :blobcat: #Misskey</p>",
      to: ["https://www.w3.org/ns/activitystreams#Public"],
      cc: [alice.followersUri],
      sensitive: true,
      attachment: [
        { type: "Document", mediaType: "image/png", url: "https://media.remote.example/a/cat.png", name: "a cat", width: 640, height: 480 },
        { type: "Document", mediaType: "video/mp4", url: "https://media.remote.example/a/clip.mp4", sensitive: false },
        { type: "Document", mediaType: "image/png", url: "http://insecure.example/x.png" },
        { type: "Link", href: "https://remote.example/x" },
      ],
      tag: [
        { type: "Emoji", id: "https://remote.example/emojis/blobcat", name: ":blobcat:", updated: "2026-01-01T00:00:00Z", icon: { type: "Image", url: "https://media.remote.example/emoji/blobcat.png" }, _misskey_license: { freeText: "CC0" } },
        { type: "Hashtag", name: "#Misskey", href: "https://remote.example/tags/misskey" },
        { type: "Hashtag", name: "no-hash" },
      ],
    };
    const r = await applyActivity(f.env, alice, act({ id: "https://remote.example/notes/n1/activity", type: "Create", actor: alice.uri, object: note }));
    assert.equal(r.reason, "note_created");
    const [n] = await rows(`SELECT id, "fileIds", "attachedFileTypes", emojis, tags FROM note WHERE uri = $1`, [note.id]);
    assert.equal(n.fileIds.length, 2);
    assert.deepEqual(n.attachedFileTypes, ["image/png", "video/mp4"]);
    assert.deepEqual(n.emojis, ["blobcat"]);
    assert.deepEqual(n.tags, ["misskey"]);
    const files = await rows(`SELECT id, "userId", "userHost", name, type, size, comment, properties, url, uri, "isLink", "isSensitive", "storedInternal" FROM drive_file WHERE id = ANY($1::varchar[]) ORDER BY id`, [n.fileIds]);
    const png = files.find((x) => x.type === "image/png")!;
    assert.deepEqual(
      [png.userId, png.userHost, png.name, png.size, png.comment, png.properties, png.url, png.uri, png.isLink, png.isSensitive, png.storedInternal],
      [alice.id, "remote.example", "cat.png", 0, "a cat", { width: 640, height: 480 }, "https://media.remote.example/a/cat.png", "https://media.remote.example/a/cat.png", true, true, false],
    );
    assert.equal(files.find((x) => x.type === "video/mp4")!.isSensitive, false); // the attachment's own flag wins
    const [emoji] = await rows(`SELECT host, uri, "originalUrl", "publicUrl", license FROM emoji WHERE name = 'blobcat'`);
    assert.deepEqual(emoji, { host: "remote.example", uri: "https://remote.example/emojis/blobcat", originalUrl: "https://media.remote.example/emoji/blobcat.png", publicUrl: "https://media.remote.example/emoji/blobcat.png", license: "CC0" });
    const [tag] = await rows(`SELECT "mentionedRemoteUserIds", "mentionedUsersCount" FROM hashtag WHERE name = 'misskey'`);
    assert.deepEqual([tag.mentionedRemoteUserIds, tag.mentionedUsersCount], [[alice.id], 1]);

    // the same file is reused; a changed emoji icon updates the row
    const note2 = {
      ...note, id: "https://remote.example/notes/n2",
      attachment: [note.attachment[0]],
      tag: [{ ...note.tag[0], icon: { type: "Image", url: "https://media.remote.example/emoji/blobcat2.png" } }],
    };
    await applyActivity(f.env, alice, act({ type: "Create", actor: alice.uri, object: note2 }));
    const [n2] = await rows(`SELECT "fileIds" FROM note WHERE uri = $1`, [note2.id]);
    assert.deepEqual(n2.fileIds, [png.id]);
    assert.equal((await rows(`SELECT "originalUrl" FROM emoji WHERE name = 'blobcat'`))[0].originalUrl, "https://media.remote.example/emoji/blobcat2.png");
    assert.equal((await rows(`SELECT 1 FROM emoji WHERE name = 'blobcat'`)).length, 1);
  });

  it("Question → poll (counts start at 0), Update(Question) by the author only", async () => {
    const question = {
      id: "https://remote.example/notes/q1",
      type: "Question",
      attributedTo: alice.uri,
      content: "<p>which?</p>",
      to: ["https://www.w3.org/ns/activitystreams#Public"],
      endTime: "2099-01-01T00:00:00.000Z",
      oneOf: [
        { type: "Note", name: "cats", replies: { type: "Collection", totalItems: 3 } },
        { type: "Note", name: "dogs", replies: { type: "Collection", totalItems: 1 } },
      ],
    };
    await applyActivity(f.env, alice, act({ type: "Create", actor: alice.uri, object: question }));
    const [n] = await rows(`SELECT id, "hasPoll" FROM note WHERE uri = $1`, [question.id]);
    assert.equal(n.hasPoll, true);
    const poll = async () => (await rows(`SELECT choices, votes, multiple, "expiresAt", "userHost" FROM poll WHERE "noteId" = $1`, [n.id]))[0];
    const p = await poll();
    assert.deepEqual([p.choices, p.votes, p.multiple, new Date(p.expiresAt).toISOString(), p.userHost], [["cats", "dogs"], [0, 0], false, "2099-01-01T00:00:00.000Z", "remote.example"]);

    const update = (by: RemoteUser, obj: unknown) => applyActivity(f.env, by, act({ type: "Update", actor: by.uri, object: obj }));
    assert.equal((await update(alice, question)).reason, "question_updated");
    assert.deepEqual((await poll()).votes, [3, 1]);
    assert.equal((await update(alice, question)).reason, "question_unchanged");
    // someone else's update is refused (logged, not retried)
    remote.set("https://remote.example/users/mallory", json(actor("mallory", "remote.example")));
    const mallory = await resolveRemoteUser(f.env, "https://remote.example/users/mallory");
    const forged = { ...question, attributedTo: mallory.uri, oneOf: [{ name: "cats", replies: { totalItems: 99 } }, { name: "dogs", replies: { totalItems: 0 } }] };
    assert.equal((await update(mallory, forged)).reason, "question_update_failed");
    assert.deepEqual((await poll()).votes, [3, 1]);
    // a bare id is fetched; non-Question objects are skipped
    remote.set("https://remote.example/notes/q1", json({ ...question, oneOf: [{ name: "cats", replies: { totalItems: 4 } }, { name: "dogs", replies: { totalItems: 1 } }] }));
    assert.equal((await update(alice, "https://remote.example/notes/q1")).reason, "question_updated");
    assert.deepEqual((await poll()).votes, [4, 1]);
    assert.equal((await update(alice, { id: "https://remote.example/notes/n1", type: "Note" })).reason, "update_unsupported_Note");
  });

  it("a remote vote on a local poll counts once and sends Update(Question) to remote followers", async () => {
    const pollNote = await f.note(f.ids.b, { text: "vote", hasPoll: true, visibility: "public" });
    await f.db.query(`INSERT INTO poll ("noteId", "expiresAt", multiple, choices, votes, "noteVisibility", "userId") VALUES ($1, NULL, FALSE, '{yes,no}', '{0,0}', 'public', $2)`, [pollNote, f.ids.b]);
    await f.db.query(`INSERT INTO following (id, "followerId", "followeeId", "followerHost", "followerInbox", "followerSharedInbox") VALUES ($1, $2, $3, 'remote.example', $4, 'https://remote.example/inbox')`, [genAidx(Date.now()), alice.id, f.ids.b, alice.inbox]);
    q.messages.length = 0;
    const vote = (id: string, name: string) => applyActivity(f.env, alice, act({
      type: "Create", actor: alice.uri,
      object: { id, type: "Note", attributedTo: alice.uri, to: [`${BASE}/users/${f.ids.b}`], inReplyTo: `${BASE}/notes/${pollNote}`, name },
    }));
    assert.equal((await vote("https://remote.example/users/alice#votes/1", "yes")).reason, "voted");
    assert.deepEqual((await rows(`SELECT votes FROM poll WHERE "noteId" = $1`, [pollNote]))[0].votes, [1, 0]);
    assert.equal((await rows(`SELECT 1 FROM note WHERE uri = 'https://remote.example/users/alice#votes/1'`)).length, 0); // no note row
    const upd = delivered().find((m) => m.activity.type === "Update")!;
    assert.deepEqual([upd.inbox, upd.signerId, upd.activity.object.type, upd.activity.object.oneOf.map((c: any) => c.replies.totalItems)], ["https://remote.example/inbox", f.ids.b, "Question", [1, 0]]);
    assert.equal((await vote("https://remote.example/users/alice#votes/2", "maybe")).reason, "vote_ignored");
    await assert.rejects(vote("https://remote.example/users/alice#votes/3", "no"), /already voted/);
    assert.deepEqual((await rows(`SELECT votes FROM poll WHERE "noteId" = $1`, [pollNote]))[0].votes, [1, 0]);
  });
});

describe("remote attachment download (remoteFile job)", () => {
  /** a PNG of `w`×`h` padded to `size` bytes (IHDR is all probeImage reads) */
  const png = (w: number, h: number, size = 64) => {
    const b = new Uint8Array(size);
    b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
    new DataView(b.buffer).setUint32(16, w);
    new DataView(b.buffer).setUint32(20, h);
    return b;
  };
  const r2 = new Map<string, Uint8Array>();
  const serve = (url: string, bytes: Uint8Array) => remote.set(url, () => new Response(bytes as unknown as BodyInit, { headers: { "content-type": "application/octet-stream" } }));
  const create = (id: string, attachment: Record<string, unknown>[], sensitive = false) =>
    applyActivity(f.env, alice, act({
      type: "Create", actor: alice.uri,
      object: { id: `https://remote.example/notes/${id}`, type: "Note", attributedTo: alice.uri, content: "f", sensitive, to: ["https://www.w3.org/ns/activitystreams#Public"], attachment },
    }));
  const fileOf = async (noteId: string) => {
    const [n] = await rows(`SELECT "fileIds", "attachedFileTypes" FROM note WHERE uri = $1`, [`https://remote.example/notes/${noteId}`]);
    const [file] = await rows(`SELECT * FROM drive_file WHERE id = $1`, [n.fileIds[0]]);
    return { note: n, file };
  };

  before(async () => {
    f.env.MEDIA_BUCKET = {
      put: async (k: string, v: Uint8Array) => void r2.set(k, v),
      delete: async (keys: string | string[]) => void [keys].flat().forEach((k) => r2.delete(k)),
    } as unknown as NonNullable<typeof f.env.MEDIA_BUCKET>;
  });

  it("a link gets md5, the detected type (synced to the note) and the image size; size stays 0", async () => {
    const bytes = png(300, 200);
    serve("https://media.remote.example/dl/one.jpg", bytes);
    await create("dl1", [{ type: "Image", mediaType: "image/jpeg", url: "https://media.remote.example/dl/one.jpg", width: 1, height: 1 }]);
    const { note, file } = await fileOf("dl1");
    const { createHash } = await import("node:crypto");
    assert.deepEqual(
      [file.isLink, file.size, file.md5, file.type, file.name, file.properties, file.url],
      [true, 0, createHash("md5").update(bytes).digest("hex"), "image/png", "one.jpg.png", { width: 300, height: 200 }, "https://media.remote.example/dl/one.jpg"],
    );
    assert.deepEqual(note.attachedFileTypes, ["image/png"]);
    assert.equal(r2.size, 0);
  });

  it("a failed download keeps the plain link", async () => {
    await create("dl2", [{ type: "Image", mediaType: "image/png", url: "https://media.remote.example/dl/missing.png" }]);
    const { file } = await fileOf("dl2");
    assert.deepEqual([file.isLink, file.md5, file.type], [true, "", "image/png"]);
  });

  it("cacheRemoteFiles stores the original in R2; sensitive files only with cacheRemoteSensitiveFiles", async () => {
    await f.db.query(`UPDATE meta SET "cacheRemoteFiles" = TRUE`);
    serve("https://media.remote.example/dl/c1.png", png(10, 10, 80));
    await create("dl3", [{ type: "Image", mediaType: "image/png", url: "https://media.remote.example/dl/c1.png" }]);
    const { file } = await fileOf("dl3");
    assert.deepEqual([file.isLink, file.size, file.url, file.uri], [false, 80, `${BASE}/files/${file.accessKey}`, "https://media.remote.example/dl/c1.png"]);
    assert.equal(r2.get(`drive/${file.accessKey}`)!.byteLength, 80);

    await f.db.query(`UPDATE meta SET "cacheRemoteSensitiveFiles" = FALSE`);
    serve("https://media.remote.example/dl/nsfw.png", png(10, 10, 80));
    await create("dl4", [{ type: "Image", mediaType: "image/png", url: "https://media.remote.example/dl/nsfw.png" }], true);
    assert.equal((await fileOf("dl4")).file.isLink, true);
    await f.db.query(`UPDATE meta SET "cacheRemoteSensitiveFiles" = TRUE`);
  });

  it("over driveCapacityMb the oldest cached files turn back into links", async () => {
    await f.setPolicy(alice.id, "driveCapacityMb", 120 / 1024 / 1024); // 120 bytes
    const old = (await fileOf("dl3")).file;
    serve("https://media.remote.example/dl/c2.png", png(10, 10, 80));
    await create("dl5", [{ type: "Image", mediaType: "image/png", url: "https://media.remote.example/dl/c2.png" }]);
    const fresh = (await fileOf("dl5")).file;
    assert.equal(fresh.isLink, false);
    const [expired] = await rows(`SELECT "isLink", url, "thumbnailUrl", "accessKey" FROM drive_file WHERE id = $1`, [old.id]);
    assert.deepEqual([expired.isLink, expired.url, expired.thumbnailUrl], [true, "https://media.remote.example/dl/c1.png", null]);
    assert.notEqual(expired.accessKey, old.accessKey);
    assert.equal(r2.has(`drive/${old.accessKey}`), false);
    await f.db.query(`UPDATE meta SET "cacheRemoteFiles" = FALSE`);
  });

  it("with the mk-jobs binding the download is queued", async () => {
    const sent: unknown[] = [];
    f.env.Q_JOBS = { send: async (b: unknown) => void sent.push(b) };
    try {
      await create("dl6", [{ type: "Image", mediaType: "image/png", url: "https://media.remote.example/dl/q.png" }]);
    } finally {
      delete f.env.Q_JOBS;
    }
    const { file } = await fileOf("dl6");
    assert.deepEqual(sent, [{ kind: "remoteFile", fileId: file.id }]);
    assert.equal(file.md5, "");
    serve("https://media.remote.example/dl/q.png", png(5, 6));
    const { runJobStep } = await import("./jobs.js");
    assert.equal(await runJobStep(f.env, sent[0] as never), null);
    assert.deepEqual((await fileOf("dl6")).file.properties, { width: 5, height: 6 });
  });
});

describe("Delete(Person)", () => {
  it("marks the remote user deleted once and removes it with its notes and files", async () => {
    remote.set("https://gone.example/users/bob", json(actor("bob", "gone.example")));
    const bob = await resolveRemoteUser(f.env, "https://gone.example/users/bob");
    await applyActivity(f.env, bob, act({ type: "Create", actor: bob.uri, object: { id: "https://gone.example/notes/1", type: "Note", attributedTo: bob.uri, content: "bye", to: ["https://www.w3.org/ns/activitystreams#Public"], attachment: [{ type: "Image", url: "https://gone.example/f.png", mediaType: "image/png" }] } }));
    assert.equal((await rows(`SELECT 1 FROM note WHERE "userId" = $1`, [bob.id])).length, 1);
    // someone else's actor cannot be deleted
    assert.equal((await applyActivity(f.env, alice, act({ type: "Delete", actor: alice.uri, object: { id: bob.uri, type: "Person" } }))).reason, "delete_actor_mismatch");
    const r = await applyActivity(f.env, bob, act({ type: "Delete", actor: bob.uri, object: bob.uri }));
    assert.equal(r.reason, "actor_deleted");
    assert.equal((await rows(`SELECT 1 FROM "user" WHERE id = $1`, [bob.id])).length, 0); // no Q_JOBS: the job ran inline
    assert.equal((await rows(`SELECT 1 FROM note WHERE "userId" = $1`, [bob.id])).length, 0);
    assert.equal((await rows(`SELECT 1 FROM drive_file WHERE "userId" = $1`, [bob.id])).length, 0);
    // a Tombstone with formerType Note is a note deletion
    assert.equal((await applyActivity(f.env, alice, act({ type: "Delete", actor: alice.uri, object: { id: "https://remote.example/notes/n2", type: "Tombstone", formerType: "Note" } }))).reason, "note_deleted");
  });

  it("an already deleted actor is skipped", async () => {
    remote.set("https://gone.example/users/carol", json(actor("carol", "gone.example")));
    const carol = await resolveRemoteUser(f.env, "https://gone.example/users/carol");
    await f.db.query(`UPDATE "user" SET "isDeleted" = TRUE WHERE id = $1`, [carol.id]);
    assert.equal((await applyActivity(f.env, carol, act({ type: "Delete", actor: carol.uri, object: { id: carol.uri, type: "Tombstone" } }))).reason, "actor_already_deleted");
    assert.equal((await rows(`SELECT 1 FROM "user" WHERE id = $1`, [carol.id])).length, 1);
  });
});

describe("outbox / featured / local Note rendering", () => {
  it("local Note carries attachments, hashtags, emojis and a Question", async () => {
    const c = f.ids.c;
    await f.db.query(`INSERT INTO drive_file (id, "userId", type, name, url, "webpublicUrl", comment, properties, "isSensitive", md5, size, "storedInternal") VALUES ('lf1', $1, 'image/png', 'x.png', 'https://misskey.example.com/files/o', 'https://misskey.example.com/files/w', 'alt', '{"width":10,"height":20}', TRUE, '0', 0, FALSE)`, [c]);
    await f.db.query(`INSERT INTO emoji (id, name, host, "originalUrl", "publicUrl", type, license, "updatedAt") VALUES ('e1', 'party', NULL, 'https://misskey.example.com/files/party', '', 'image/webp', 'mine', '2026-01-02T00:00:00Z'), ('e2', 'secret', NULL, 'https://x', '', NULL, NULL, NULL)`);
    await f.db.query(`UPDATE emoji SET "localOnly" = TRUE WHERE id = 'e2'`);
    const id = await f.note(c, { text: "hello :party: :secret: #Tag", fileIds: ["lf1"], emojis: ["party", "secret"], tags: ["tag"], hasPoll: true, visibility: "public" });
    await f.db.query(`INSERT INTO poll ("noteId", "expiresAt", multiple, choices, votes, "noteVisibility", "userId") VALUES ($1, '2000-01-01T00:00:00Z', TRUE, '{a,b}', '{2,5}', 'public', $2)`, [id, c]);
    const o = (await renderLocalNote(f.env, (await getNotePg(f.env, id))!)) as any;
    assert.equal(o.type, "Question");
    assert.equal(o.closed, "2000-01-01T00:00:00.000Z");
    assert.deepEqual(o.anyOf, [{ type: "Note", name: "a", replies: { type: "Collection", totalItems: 2 } }, { type: "Note", name: "b", replies: { type: "Collection", totalItems: 5 } }]);
    assert.deepEqual(o.attachment, [{ type: "Document", mediaType: "image/png", url: "https://misskey.example.com/files/w", name: "alt", width: 10, height: 20, sensitive: true }]);
    assert.equal(o.sensitive, true);
    assert.deepEqual(o.tag, [
      { type: "Hashtag", href: `${BASE}/tags/tag`, name: "#tag" },
      { id: `${BASE}/emojis/party`, type: "Emoji", name: ":party:", updated: "2026-01-02T00:00:00.000Z", icon: { type: "Image", mediaType: "image/webp", url: "https://misskey.example.com/files/party" }, _misskey_license: { freeText: "mine" } },
    ]);
  });

  it("featured lists pinned public / home notes; outbox pages Create / Announce", async () => {
    const c = f.ids.c;
    await f.db.query(`DELETE FROM note WHERE "userId" = $1`, [c]);
    const n1 = await f.note(c, { text: "one", visibility: "public" });
    const n2 = await f.note(c, { text: "two", visibility: "followers" });
    const n3 = await f.note(c, { text: "three", visibility: "home" });
    const rn = await f.note(c, { renoteId: n1, visibility: "public" });
    await f.note(c, { text: "local", visibility: "public", localOnly: true });
    await f.db.query(`UPDATE "user" SET "notesCount" = 5 WHERE id = $1`, [c]);
    await f.db.query(`INSERT INTO user_note_pining (id, "userId", "noteId") VALUES ('p1', $1, $2), ('p2', $1, $3), ('p3', $1, $4)`, [c, n1, n2, n3]);

    const feat = await handleApRoutes(apGetReq(`/users/${c}/collections/featured`), f.env);
    assert.equal(feat!.headers.get("cache-control"), "public, max-age=180");
    const fb = (await feat!.json()) as any;
    assert.deepEqual([fb.type, fb.totalItems, fb.orderedItems.map((x: any) => x.id)], ["OrderedCollection", 2, [`${BASE}/notes/${n3}`, `${BASE}/notes/${n1}`]]);

    const idx = (await (await handleApRoutes(apGetReq(`/users/${c}/outbox`), f.env))!.json()) as any;
    assert.deepEqual(idx, {
      "@context": idx["@context"], id: `${BASE}/users/${c}/outbox`, type: "OrderedCollection", totalItems: 5,
      first: `${BASE}/users/${c}/outbox?page=true`, last: `${BASE}/users/${c}/outbox?page=true&since_id=000000000000000000000000`,
    });
    const page = (await (await handleApRoutes(apGetReq(`/users/${c}/outbox?page=true`), f.env))!.json()) as any;
    assert.equal(page.type, "OrderedCollectionPage");
    assert.equal(page.partOf, `${BASE}/users/${c}/outbox`);
    assert.deepEqual(page.orderedItems.map((a: any) => [a.type, a.id]), [
      ["Announce", `${BASE}/notes/${rn}/activity`],
      ["Create", `${BASE}/notes/${n3}/activity`],
      ["Create", `${BASE}/notes/${n1}/activity`],
    ]);
    assert.equal(page.orderedItems[0].object, `${BASE}/notes/${n1}`);
    assert.equal(page.next, `${BASE}/users/${c}/outbox?page=true&until_id=${n1}`);
    assert.equal(page.prev, `${BASE}/users/${c}/outbox?page=true&since_id=${rn}`);
    const older = (await (await handleApRoutes(apGetReq(`/users/${c}/outbox?page=true&until_id=${n3}`), f.env))!.json()) as any;
    assert.deepEqual(older.orderedItems.map((a: any) => a.object.id), [`${BASE}/notes/${n1}`]);
    const newer = (await (await handleApRoutes(apGetReq(`/users/${c}/outbox?page=true&since_id=${n1}`), f.env))!.json()) as any;
    assert.deepEqual(newer.orderedItems.map((a: any) => a.id), [`${BASE}/notes/${rn}/activity`, `${BASE}/notes/${n3}/activity`]);
    assert.equal((await handleApRoutes(apGetReq(`/users/${c}/outbox?page=true&since_id=a&until_id=b`), f.env))!.status, 400);
  });
});

describe("followers / following collections", () => {
  it("public: index + 10 actor URIs per page with a cursor; private / followers-only → 403", async () => {
    const target = f.ids.a;
    const followers: string[] = [];
    for (let i = 0; i < 12; i++) {
      const id = genAidx(Date.now() + i);
      await f.db.query(`INSERT INTO "user" (id, username, "usernameLower", host, uri) VALUES ($1, $2, $2, 'many.example', $3)`, [id, `f${i}`, `https://many.example/users/f${i}`]);
      await f.db.query(`INSERT INTO following (id, "followerId", "followeeId", "followerHost") VALUES ($1, $2, $3, 'many.example')`, [`fw${String(i).padStart(2, "0")}`, id, target]);
      followers.push(`https://many.example/users/f${i}`);
    }
    await f.db.query(`INSERT INTO following (id, "followerId", "followeeId") VALUES ('fx01', $1, $2)`, [target, f.ids.b]);
    await f.db.query(`UPDATE "user" SET "followersCount" = 12, "followingCount" = 1 WHERE id = $1`, [target]);

    const get = async (path: string) => (await (await handleApRoutes(apGetReq(path), f.env))!.json()) as any;
    const idx = await get(`/users/${target}/followers`);
    assert.deepEqual([idx.type, idx.totalItems, idx.first, idx.orderedItems], ["OrderedCollection", 12, `${BASE}/users/${target}/followers?page=true`, undefined]);
    const p1 = await get(`/users/${target}/followers?page=true`);
    assert.deepEqual([p1.type, p1.partOf, p1.totalItems], ["OrderedCollectionPage", `${BASE}/users/${target}/followers`, 12]);
    assert.deepEqual(p1.orderedItems, followers.slice(2).reverse());
    assert.equal(p1.next, `${BASE}/users/${target}/followers?page=true&cursor=fw02`);
    const p2 = await get(`/users/${target}/followers?page=true&cursor=fw02`);
    assert.deepEqual([p2.orderedItems, p2.next, p2.id], [followers.slice(0, 2).reverse(), undefined, `${BASE}/users/${target}/followers?page=true&cursor=fw02`]);
    // local followees render as local actor URIs
    assert.deepEqual((await get(`/users/${target}/following?page=true`)).orderedItems, [`${BASE}/users/${f.ids.b}`]);

    for (const v of ["private", "followers"]) {
      await f.db.query(`UPDATE user_profile SET "followersVisibility" = $2 WHERE "userId" = $1`, [target, v]);
      const r = (await handleApRoutes(apGetReq(`/users/${target}/followers?page=true`), f.env))!;
      assert.deepEqual([r.status, r.headers.get("cache-control")], [403, "public, max-age=30"]);
    }
    assert.equal((await handleApRoutes(apGetReq(`/users/${target}/following`), f.env))!.status, 200); // set separately
  });
});

describe("mk-deliver instance bookkeeping", () => {
  const msg = (inbox: string) => ({ kind: "deliver" as const, signerId: f.ids.b, inbox, activity: { type: "Create" } });
  const inst = async (host: string) => (await rows(`SELECT "isNotResponding", "notRespondingSince", "suspensionState"::text AS s FROM instance WHERE host = $1`, [host]))[0];

  it("failures mark isNotResponding, a week of them suspends, success clears it, suspended hosts are skipped", async () => {
    remote.set("https://down.example/inbox", () => new Response(null, { status: 503 }));
    assert.equal(await processDeliver(f.env, msg("https://down.example/inbox")), "retry");
    let i = await inst("down.example");
    assert.equal(i.isNotResponding, true);
    assert.ok(i.notRespondingSince);
    await f.db.query(`UPDATE instance SET "notRespondingSince" = now() - interval '8 days' WHERE host = 'down.example'`);
    assert.equal(await processDeliver(f.env, msg("https://down.example/inbox")), "retry");
    assert.equal((await inst("down.example")).s, "autoSuspendedForNotResponding");
    // suspended: not even attempted
    const before = requests.length;
    assert.equal(await processDeliver(f.env, msg("https://down.example/inbox")), "dropped");
    assert.equal(requests.length, before);

    // recovery by a successful delivery
    remote.set("https://flaky.example/inbox", () => new Response(null, { status: 503 }));
    await processDeliver(f.env, msg("https://flaky.example/inbox"));
    assert.equal((await inst("flaky.example")).isNotResponding, true);
    await f.db.query(`UPDATE instance SET "infoUpdatedAt" = now() WHERE host = 'flaky.example'`); // no metadata refetch
    remote.set("https://flaky.example/inbox", () => new Response(null, { status: 202 }));
    assert.equal(await processDeliver(f.env, msg("https://flaky.example/inbox")), "delivered");
    i = await inst("flaky.example");
    assert.deepEqual([i.isNotResponding, i.notRespondingSince], [false, null]);
  });

  it("410 from a shared inbox marks the instance goneSuspended; from a personal inbox it does not", async () => {
    remote.set("https://closed.example/users/z", json(actor("z", "closed.example")));
    await resolveRemoteUser(f.env, "https://closed.example/users/z");
    remote.set("https://closed.example/users/z/inbox", () => new Response(null, { status: 410 }));
    assert.equal(await processDeliver(f.env, msg("https://closed.example/users/z/inbox")), "dropped");
    assert.equal((await inst("closed.example")).s, "none");
    remote.set("https://closed.example/inbox", () => new Response(null, { status: 410 }));
    assert.equal(await processDeliver(f.env, msg("https://closed.example/inbox")), "dropped");
    assert.equal((await inst("closed.example")).s, "goneSuspended");
    assert.equal(await processDeliver(f.env, msg("https://closed.example/users/z/inbox")), "dropped"); // skipped from now on
  });

  it("deliverSuspendedSoftware skips matching instances", async () => {
    await f.db.query(`INSERT INTO instance (id, host, "firstRetrievedAt", "softwareName", "softwareVersion", "infoUpdatedAt") VALUES ('i9', 'old.example', now(), 'oldsoft', '1.2.0', now())`);
    await f.db.query(`UPDATE meta SET "deliverSuspendedSoftware" = '[{"software":"oldsoft","versionRange":"<2.0.0"}]'`);
    remote.set("https://old.example/inbox", () => new Response(null, { status: 202 }));
    assert.equal(await processDeliver(f.env, msg("https://old.example/inbox")), "dropped");
    await f.db.query(`UPDATE instance SET "softwareVersion" = '2.1.0' WHERE host = 'old.example'`);
    assert.equal(await processDeliver(f.env, msg("https://old.example/inbox")), "delivered");
  });
});

describe("remote user / note lookups (allowExternalApRedirect)", () => {
  const ld = 'application/ld+json; profile="https://www.w3.org/ns/activitystreams"';
  const get = (path: string, accept = "application/activity+json") => handleApRoutes(new Request(`${BASE}${path}`, { headers: { Accept: accept } }), f.env);
  let noteId = "";

  before(async () => {
    noteId = genAidx(Date.now());
    await f.db.query(
      `INSERT INTO note (id, "userId", "userHost", visibility, uri) VALUES ($1, $2, 'remote.example', 'public', 'https://remote.example/notes/1')`,
      [noteId, alice.id],
    );
  });

  it("refuses to redirect an ActivityPub lookup to another server by default (406)", async () => {
    await f.db.query(`UPDATE meta SET "allowExternalApRedirect" = FALSE`);
    for (const [path, location] of [
      [`/notes/${noteId}`, "https://remote.example/notes/1"],
      [`/users/${alice.id}`, "https://remote.example/users/alice"],
      ["/@alice@remote.example", "https://remote.example/users/alice"],
    ] as const) {
      for (const accept of ["application/activity+json", ld]) {
        const r = (await get(path, accept))!;
        assert.equal(r.status, 406, `${path} ${accept}`);
        assert.equal(r.headers.get("location"), null);
        assert.equal(r.headers.get("link"), `<${location}>; rel="canonical"`);
        assert.match(await r.text(), /^Refusing to relay remote ActivityPub object lookup\./);
      }
    }
    // a bare `application/ld+json` is not an ActivityPub lookup for the check: redirected
    const r = (await get(`/notes/${noteId}`, "application/ld+json"))!;
    assert.equal(r.status, 302);
    assert.equal(r.headers.get("location"), "https://remote.example/notes/1");
  });

  it("redirects to the remote uri when allowed", async () => {
    await f.db.query(`UPDATE meta SET "allowExternalApRedirect" = TRUE`);
    const note = (await get(`/notes/${noteId}`))!;
    assert.equal(note.status, 302);
    assert.equal(note.headers.get("location"), "https://remote.example/notes/1");
    for (const path of [`/users/${alice.id}`, "/@alice@remote.example", "/@ALICE@Remote.Example"]) {
      const r = (await get(path))!;
      assert.equal(r.status, 301, path);
      assert.equal(r.headers.get("location"), "https://remote.example/users/alice");
    }
    await f.db.query(`UPDATE meta SET "allowExternalApRedirect" = FALSE`);
  });

  it("keeps local lookups, and 404s what upstream 404s", async () => {
    // `@user@<this host>` is the local user
    const local = (await get("/@user_b@misskey.example.com"))!;
    assert.equal(local.status, 301);
    assert.equal(local.headers.get("location"), `${BASE}/users/${f.ids.b}`);
    assert.equal((await get("/@nobody@remote.example"))!.status, 404);
    // a remote note's activity, and a remote user's collections, are local only
    assert.equal((await get(`/notes/${noteId}/activity`))!.status, 404);
    assert.equal((await get(`/users/${alice.id}/outbox`))!.status, 404);
    // a non-public remote note
    const home = genAidx(Date.now() + 1);
    await f.db.query(
      `INSERT INTO note (id, "userId", "userHost", visibility, uri) VALUES ($1, $2, 'remote.example', 'followers', 'https://remote.example/notes/2')`,
      [home, alice.id],
    );
    assert.equal((await get(`/notes/${home}`))!.status, 404);
  });
});

describe("remote note counters (insertNotePg)", () => {
  const PUBLIC = "https://www.w3.org/ns/activitystreams#Public";
  const counts = async () => {
    const [u] = await rows(`SELECT "notesCount" FROM "user" WHERE id = $1`, [alice.id]);
    return Number(u.notesCount);
  };
  const noteCounts = async (id: string) => {
    const [n] = await rows(`SELECT "repliesCount", "renoteCount" FROM note WHERE id = $1`, [id]);
    return { replies: Number(n.repliesCount), renotes: Number(n.renoteCount) };
  };
  let localNote = "";
  before(async () => {
    localNote = await f.note(f.ids.b, { text: "local" });
  });

  it("a note that cannot be stored changes no counter and is not retried", async () => {
    const before = await counts();
    const target = await noteCounts(localNote);
    const note = {
      id: "https://remote.example/notes/longcw",
      type: "Note",
      attributedTo: alice.uri,
      content: "<p>reply</p>",
      summary: "x".repeat(600),
      inReplyTo: `${BASE}/notes/${localNote}`,
      to: [PUBLIC],
    };
    await assert.rejects(
      applyActivity(f.env, alice, act({ id: "https://remote.example/notes/longcw/activity", type: "Create", actor: alice.uri, object: note })),
      (e: Error) => e.name === "ApPermanentError" || /not storable/.test(e.message),
    );
    assert.equal(await counts(), before);
    assert.deepEqual(await noteCounts(localNote), target);
    assert.equal((await rows(`SELECT 1 FROM note WHERE uri = $1`, [note.id])).length, 0);
  });

  it("a Question whose choice is too long leaves no note behind", async () => {
    const before = await counts();
    const q = {
      id: "https://remote.example/notes/longpoll",
      type: "Question",
      attributedTo: alice.uri,
      content: "<p>poll</p>",
      to: [PUBLIC],
      oneOf: [{ type: "Note", name: "y".repeat(300), replies: { type: "Collection", totalItems: 0 } }, { type: "Note", name: "b", replies: { type: "Collection", totalItems: 0 } }],
    };
    await assert.rejects(applyActivity(f.env, alice, act({ id: "https://remote.example/notes/longpoll/activity", type: "Create", actor: alice.uri, object: q })));
    assert.equal((await rows(`SELECT 1 FROM note WHERE uri = $1`, [q.id])).length, 0);
    assert.equal(await counts(), before);
  });

  it("the same uri stored twice counts once (a concurrent copy is a duplicate, not an error)", async () => {
    const { insertNotePg } = await import("./notes-pg.js");
    const { createNoteRow } = await import("./notes/row.js");
    const before = await counts();
    const target = await noteCounts(localNote);
    const row = () => {
      const n = createNoteRow(alice.id, { text: "dup", visibility: "public" }, genAidx(Date.now()));
      Object.assign(n, { uri: "https://remote.example/notes/dup", userHost: "remote.example", replyId: localNote, localOnly: false });
      return n;
    };
    assert.ok(await insertNotePg(f.env, row()));
    assert.equal(await insertNotePg(f.env, row()), null);
    assert.equal(await counts(), before + 1);
    assert.deepEqual(await noteCounts(localNote), { ...target, replies: target.replies + 1 });
    const [u] = await rows(`SELECT "updatedAt" FROM "user" WHERE id = $1`, [alice.id]);
    assert.ok(u.updatedAt != null);
  });

  it("renoteCount: not for a renote of one's own note, nor by a bot", async () => {
    const own = (await rows(`SELECT id FROM note WHERE uri = 'https://remote.example/notes/dup'`))[0].id as string;
    const r1 = await applyActivity(f.env, alice, act({ id: "https://remote.example/announces/own", type: "Announce", actor: alice.uri, object: "https://remote.example/notes/dup", to: [PUBLIC] }));
    assert.equal(r1.reason, "renoted");
    assert.equal((await noteCounts(own)).renotes, 0);

    const r2 = await applyActivity(f.env, alice, act({ id: "https://remote.example/announces/local", type: "Announce", actor: alice.uri, object: `${BASE}/notes/${localNote}`, to: [PUBLIC] }));
    assert.equal(r2.reason, "renoted");
    const afterHuman = (await noteCounts(localNote)).renotes;
    await f.db.query(`UPDATE "user" SET "isBot" = TRUE WHERE id = $1`, [alice.id]);
    try {
      const r3 = await applyActivity(f.env, alice, act({ id: "https://remote.example/announces/bot", type: "Announce", actor: alice.uri, object: `${BASE}/notes/${localNote}`, to: [PUBLIC] }));
      assert.equal(r3.reason, "renoted");
      assert.equal((await noteCounts(localNote)).renotes, afterHuman);
    } finally {
      await f.db.query(`UPDATE "user" SET "isBot" = FALSE WHERE id = $1`, [alice.id]);
    }
    // a repeated Announce is a duplicate
    const again = await applyActivity(f.env, alice, act({ id: "https://remote.example/announces/local", type: "Announce", actor: alice.uri, object: `${BASE}/notes/${localNote}`, to: [PUBLIC] }));
    assert.equal(again.reason, "announce_duplicate");
    assert.equal((await noteCounts(localNote)).renotes, afterHuman);
  });
});
