/**
 * Linked Data signatures (upstream JsonLdService / RsaSignature2017) and their two uses:
 * deliverToRelays (public activities LD-signed to accepted relays) and inbound activities
 * forwarded by someone other than their actor (relays), verified in processInbox.
 */
import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash, createSign, createVerify, generateKeyPairSync } from "node:crypto";
import jsonld from "jsonld";
import { MISSKEY_CONTEXT, parseActivity, signedPostHeaders } from "../../ap/src/index.js";
import { JsonLd, JsonLdError } from "./ap/ld-signature.js";
import { CONTEXT, PRELOADED_CONTEXTS } from "./ap/ld-contexts.js";
import { makeFixture, type Fixture } from "./pglite-fixture.js";
import { setFederationPolicy } from "./ap/federation.js";
import { setUserKeypairForTest } from "./ap/keys.js";
import { InMemoryQueueProducer, MK_DELIVER, setQueueProducer } from "./queues/fanout.js";
import { applyActivity, processInbox } from "./ap/inbox.js";
import { deliverNoteCreate, deliverNoteDelete, deliverPersonUpdate } from "./ap/outbound.js";
import { getNotePg } from "./notes-pg.js";

const keys = () => generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
const noFetch = (async (url: string) => {
  throw new Error(`unexpected fetch ${url}`);
}) as unknown as typeof fetch;
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

const NOTE_ACTIVITY = {
  "@context": MISSKEY_CONTEXT,
  id: "https://a.example/notes/1/activity",
  type: "Create",
  actor: "https://a.example/users/1",
  to: ["https://www.w3.org/ns/activitystreams#Public"],
  object: {
    id: "https://a.example/notes/1",
    type: "Note",
    attributedTo: "https://a.example/users/1",
    content: "<p>hello</p>",
    _misskey_content: "hello",
    to: ["https://www.w3.org/ns/activitystreams#Public"],
  },
};

describe("RsaSignature2017", () => {
  const kp = keys();

  it("signs and verifies (WebCrypto) the same way upstream does (node:crypto)", async () => {
    const created = new Date("2026-01-02T03:04:05.000Z");
    const signed = await new JsonLd(noFetch).signRsaSignature2017(NOTE_ACTIVITY, kp.privateKey, "https://a.example/users/1#main-key", undefined, created);
    const sig = signed.signature as Record<string, string>;
    assert.deepEqual([sig.type, sig.creator, sig.created], ["RsaSignature2017", "https://a.example/users/1#main-key", "2026-01-02T03:04:05.000Z"]);
    assert.match(sig.nonce!, /^[0-9a-f]{32}$/);
    assert.equal(await new JsonLd(noFetch).verifyRsaSignature2017(signed, kp.publicKey), true);

    // upstream createVerifyData, recomputed with jsonld directly: sha256(options) + sha256(document)
    const loader = async (url: string) => ({ contextUrl: undefined, document: PRELOADED_CONTEXTS[url], documentUrl: url });
    const opts = { creator: sig.creator, nonce: sig.nonce, created: sig.created, "@context": "https://w3id.org/identity/v1" };
    const { signature: _s, ...doc } = signed;
    const nq = async (d: unknown) => (await jsonld.normalize(d as never, { documentLoader: loader } as never)) as unknown as string;
    const expected = sha256(await nq(opts)) + sha256(await nq(doc));
    assert.equal(await new JsonLd(noFetch).createVerifyData(signed, sig), expected);
    // ...and verified with node:crypto as upstream's verifyRsaSignature2017 does
    assert.equal(createVerify("sha256").update(expected).verify(kp.publicKey, sig.signatureValue!, "base64"), true);
    // a signature made by node:crypto (upstream's signer) verifies here
    const nodeSigned = { ...doc, signature: { ...sig, signatureValue: createSign("sha256").update(expected).sign(kp.privateKey, "base64") } };
    assert.equal(await new JsonLd(noFetch).verifyRsaSignature2017(nodeSigned, kp.publicKey), true);
  });

  it("canonicalizes (URDNA2015): key order and compaction do not change the hash", async () => {
    const j = new JsonLd(noFetch);
    const reordered = { object: { ...NOTE_ACTIVITY.object }, to: NOTE_ACTIVITY.to, actor: NOTE_ACTIVITY.actor, type: "Create", id: NOTE_ACTIVITY.id, "@context": NOTE_ACTIVITY["@context"] };
    assert.equal(await j.normalize(reordered), await j.normalize(NOTE_ACTIVITY));
    const compacted = await j.compact({ ...NOTE_ACTIVITY });
    assert.deepEqual(compacted["@context"], CONTEXT);
    assert.equal(await j.normalize(compacted), await j.normalize(NOTE_ACTIVITY));
    // the N-Quads carry the activity's statements
    const nq = await j.normalize(NOTE_ACTIVITY);
    assert.match(nq, /<https:\/\/a\.example\/notes\/1\/activity> <http:\/\/www\.w3\.org\/1999\/02\/22-rdf-syntax-ns#type> <https:\/\/www\.w3\.org\/ns\/activitystreams#Create> \./);
    assert.match(nq, /<https:\/\/a\.example\/notes\/1> <https:\/\/misskey-hub\.net\/ns#_misskey_content> "hello" \./);
  });

  it("rejects tampering, a wrong key and a bad signature value", async () => {
    const signed = await new JsonLd(noFetch).signRsaSignature2017(NOTE_ACTIVITY, kp.privateKey, "https://a.example/users/1#main-key");
    const j = new JsonLd(noFetch);
    assert.equal(await j.verifyRsaSignature2017({ ...signed, object: { ...NOTE_ACTIVITY.object, content: "bye" } }, kp.publicKey), false);
    assert.equal(await j.verifyRsaSignature2017({ ...signed, signature: { ...(signed.signature as object), nonce: "00" } }, kp.publicKey), false);
    assert.equal(await j.verifyRsaSignature2017(signed, keys().publicKey), false);
    assert.equal(await j.verifyRsaSignature2017({ ...signed, signature: { ...(signed.signature as object), signatureValue: "!!" } }, kp.publicKey), false);
    // jsonld's safe mode (upstream's defaults): an undefined property fails canonicalization
    await assert.rejects(j.verifyRsaSignature2017({ ...signed, unknownProp: "x" }, kp.publicKey), (e) => e instanceof JsonLdError && /Safe mode/.test(e.message));
    // compaction keeps it (the AS2 context's `@vocab: "_:"`), so such an activity is refused (as upstream)
    const { signature, ...rest } = signed;
    const compacted = await j.compact({ ...rest, unknownProp: "x" });
    assert.equal(compacted.unknownProp, "x");
    await assert.rejects(j.verifyRsaSignature2017({ ...compacted, signature }, kp.publicKey), JsonLdError);
  });

  it("document loader: preloaded contexts, fetched ones (cached), frozen cache, forbidden directives", async () => {
    const fetched: string[] = [];
    const fetcher = (async (url: string) => {
      fetched.push(url);
      if (url === "https://ctx.example/ns") return new Response(JSON.stringify({ "@context": { foo: "https://ctx.example/ns#foo" } }), { headers: { "content-type": "application/ld+json" } });
      if (url === "https://ctx.example/evil") return new Response(JSON.stringify({ "@context": { "@included": {} } }), { headers: { "content-type": "application/json" } });
      if (url === "https://ctx.example/html") return new Response("<html>", { headers: { "content-type": "text/html" } });
      return new Response("nf", { status: 404 });
    }) as unknown as typeof fetch;
    const j = new JsonLd(fetcher);
    const doc = { "@context": ["https://www.w3.org/ns/activitystreams", "https://ctx.example/ns"], id: "https://a.example/x", type: "Note", foo: "bar" };
    assert.match(await j.normalize(doc), /<https:\/\/ctx\.example\/ns#foo> "bar"/);
    await j.normalize(doc);
    assert.deepEqual(fetched, ["https://ctx.example/ns"]);
    // loader failures surface as jsonld's InvalidUrl (wrapped): forbidden directives, non-JSON-LD content types
    await assert.rejects(j.normalize({ "@context": "https://ctx.example/evil", id: "https://a.example/y" }), JsonLdError);
    await assert.rejects(j.normalize({ "@context": "https://ctx.example/html", id: "https://a.example/y" }), JsonLdError);
    assert.deepEqual(fetched, ["https://ctx.example/ns", "https://ctx.example/evil", "https://ctx.example/html"]);
    j.freeze();
    await j.normalize(doc); // cached still works
    await assert.rejects(j.normalize({ "@context": "https://ctx.example/other", id: "https://a.example/z" }), JsonLdError);
    assert.equal(fetched.length, 3); // frozen: not fetched
    assert.throws(() => j.checkForForbiddenDirectives({ a: [{ "@graph": [] }] }), JsonLdError);
    // unsafe context URLs are not fetched
    await assert.rejects(new JsonLd(fetcher).normalize({ "@context": "https://127.0.0.1/ctx", id: "https://a.example/z" }), JsonLdError);
    assert.equal(fetched.length, 3);
  });
});

// ---------------------------------------------------------------- relays + inbox (PGlite)

let f: Fixture;
let q: InMemoryQueueProducer;
const remote = new Map<string, () => Response>();
const BASE = "https://misskey.example.com";
const json = (o: unknown) => () => new Response(JSON.stringify(o), { headers: { "Content-Type": "application/activity+json" } });
const rows = async (sql: string, p: unknown[] = []) => (await f.db.query(sql, p)).rows as any[];
const relayKeys = keys();
const authorKeys = keys();

const person = (id: string, pem: string, extra: Record<string, unknown> = {}) => ({
  "@context": ["https://www.w3.org/ns/activitystreams", "https://w3id.org/security/v1"],
  id,
  type: "Person",
  preferredUsername: id.split("/").pop(),
  inbox: `${id}/inbox`,
  endpoints: { sharedInbox: `${new URL(id).origin}/inbox` },
  publicKey: { id: `${id}#main-key`, owner: id, publicKeyPem: pem },
  ...extra,
});

/** An mk-inbox message as the route stores it: HTTP-signed by `signer`. */
async function inboxMessage(body: Record<string, unknown>, signerUri: string, privateKeyPem: string) {
  const text = JSON.stringify(body);
  const headers = await signedPostHeaders({ privateKeyPem, keyId: `${signerUri}#main-key`, url: `${BASE}/inbox`, body: text });
  return {
    kind: "inbox" as const,
    method: "POST",
    path: "/inbox",
    headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])),
    body: text,
    receivedAt: Date.now(),
  };
}

before(async () => {
  f = await makeFixture("LdTest");
  setFederationPolicy(f.env, { mode: "all", hosts: [], blockedHosts: ["bad.example"] });
  q = new InMemoryQueueProducer();
  setQueueProducer(f.env, q);
  f.env.AP_FETCH = (async (url: string) => {
    const h = remote.get(url);
    return h ? h() : new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  remote.set("https://relay.example/actor", json(person("https://relay.example/actor", relayKeys.publicKey, { type: "Application", inbox: "https://relay.example/inbox" })));
  remote.set("https://author.example/users/al", json(person("https://author.example/users/al", authorKeys.publicKey)));
  setUserKeypairForTest(f.env, f.ids.b, { publicKey: keys().publicKey, privateKey: keys().privateKey });
});

describe("relays", () => {
  it("public notes go LD-signed to accepted relays only", async () => {
    const kp = keys();
    setUserKeypairForTest(f.env, f.ids.b, { publicKey: kp.publicKey, privateKey: kp.privateKey });
    await f.db.query(`INSERT INTO relay (id, inbox, status) VALUES ('r1', 'https://relay.example/inbox', 'accepted'), ('r2', 'https://pending.example/inbox', 'requesting')`);
    const noteId = await f.note(f.ids.b, { text: "hi relay", visibility: "public" });
    const note = (await getNotePg(f.env, noteId))!;
    q.clear();
    await deliverNoteCreate(f.env, note);
    const toRelay = q.ofQueue<{ inbox: string; signerId: string; activity: any }>(MK_DELIVER).filter((m) => m.inbox === "https://relay.example/inbox");
    assert.equal(toRelay.length, 1);
    assert.equal(q.ofQueue<{ inbox: string }>(MK_DELIVER).some((m) => m.inbox === "https://pending.example/inbox"), false);
    const act = toRelay[0]!.activity;
    assert.equal(toRelay[0]!.signerId, f.ids.b);
    assert.deepEqual([act.type, act.signature.type, act.signature.creator], ["Create", "RsaSignature2017", `${BASE}/users/${f.ids.b}#main-key`]);
    assert.ok(act["@context"]);
    assert.equal(await new JsonLd(noFetch).verifyRsaSignature2017(act, kp.publicKey), true);

    // followers-only notes are not relayed, but their deletion is (NoteDeleteService.deliverToConcerned)
    const fo = (await getNotePg(f.env, await f.note(f.ids.b, { text: "secret", visibility: "followers" })))!;
    q.clear();
    await deliverNoteCreate(f.env, fo);
    assert.equal(q.ofQueue<{ inbox: string }>(MK_DELIVER).some((m) => m.inbox === "https://relay.example/inbox"), false);
    await deliverNoteDelete(f.env, fo);
    const del = q.ofQueue<{ inbox: string; activity: any }>(MK_DELIVER).find((m) => m.inbox === "https://relay.example/inbox")!;
    assert.equal(del.activity.type, "Delete");
    assert.equal(await new JsonLd(noFetch).verifyRsaSignature2017(del.activity, kp.publicKey), true);

    // deleting a pure renote: Undo of the original Announce (an empty object fails jsonld safe mode)
    const rn = (await getNotePg(f.env, await f.note(f.ids.b, { text: null, renoteId: noteId, visibility: "public" })))!;
    q.clear();
    await deliverNoteDelete(f.env, rn);
    const undo = q.ofQueue<{ inbox: string; activity: any }>(MK_DELIVER).find((m) => m.inbox === "https://relay.example/inbox")!;
    assert.deepEqual([undo.activity.type, undo.activity.object.type, undo.activity.object.id, undo.activity.object.object], [
      "Undo", "Announce", `${BASE}/notes/${rn.id}/activity`, `${BASE}/notes/${noteId}`,
    ]);
    assert.equal(await new JsonLd(noFetch).verifyRsaSignature2017(undo.activity, kp.publicKey), true);

    // Update(Person) (i/update, i/move): every term the Person uses is in the signed context
    await f.db.query(`UPDATE user_profile SET fields = $2::jsonb, description = 'bio' WHERE "userId" = $1`, [f.ids.b, JSON.stringify([{ name: "site", value: "https://example.org" }])]);
    q.clear();
    await deliverPersonUpdate(f.env, f.ids.b);
    const upd = q.ofQueue<{ inbox: string; activity: any }>(MK_DELIVER).find((m) => m.inbox === "https://relay.example/inbox")!;
    assert.deepEqual([upd.activity.type, upd.activity.object.attachment[0].type], ["Update", "PropertyValue"]);
    assert.equal(await new JsonLd(noFetch).verifyRsaSignature2017(upd.activity, kp.publicKey), true);
  });

  it("accepts an activity relayed with the author's LD signature", async () => {
    const note = {
      id: "https://author.example/notes/n1",
      type: "Note",
      attributedTo: "https://author.example/users/al",
      content: "<p>relayed</p>",
      to: ["https://www.w3.org/ns/activitystreams#Public"],
    };
    const create = { "@context": MISSKEY_CONTEXT, id: "https://author.example/notes/n1/activity", type: "Create", actor: "https://author.example/users/al", to: note.to, object: note };
    const signed = await new JsonLd(noFetch).signRsaSignature2017(create, authorKeys.privateKey, "https://author.example/users/al#main-key");

    // without an LD signature, a signer other than the actor is refused
    const plain = await processInbox(f.env, await inboxMessage(create, "https://relay.example/actor", relayKeys.privateKey));
    assert.deepEqual(plain, { ok: false, reason: "actor_signer_mismatch" });
    // tampered content
    const tampered = { ...signed, object: { ...note, content: "<p>forged</p>" } };
    assert.deepEqual(await processInbox(f.env, await inboxMessage(tampered, "https://relay.example/actor", relayKeys.privateKey)), { ok: false, reason: "ld_signature_invalid" });
    // signed by someone else than the actor
    const other = await new JsonLd(noFetch).signRsaSignature2017(create, relayKeys.privateKey, "https://relay.example/actor#main-key");
    assert.deepEqual(await processInbox(f.env, await inboxMessage(other, "https://relay.example/actor", relayKeys.privateKey)), { ok: false, reason: "ld_actor_mismatch" });
    // unsupported type
    const ed = { ...signed, signature: { ...(signed.signature as object), type: "Ed25519Signature2018" } };
    assert.deepEqual(await processInbox(f.env, await inboxMessage(ed, "https://relay.example/actor", relayKeys.privateKey)), { ok: false, reason: "ld_unsupported_type_Ed25519Signature2018" });

    const ok = await processInbox(f.env, await inboxMessage(signed, "https://relay.example/actor", relayKeys.privateKey));
    assert.deepEqual(ok, { ok: true, reason: "note_created" });
    const n = (await rows(`SELECT n.text, u.uri FROM note n JOIN "user" u ON u.id = n."userId" WHERE n.uri = 'https://author.example/notes/n1'`))[0];
    assert.deepEqual([n.text, n.uri], ["relayed", "https://author.example/users/al"]);
    // a second relayed copy is known before the LD signature is checked (even a tampered one)
    assert.deepEqual(await processInbox(f.env, await inboxMessage(signed, "https://relay.example/actor", relayKeys.privateKey)), { ok: true, reason: "create_known" });
    assert.deepEqual(await processInbox(f.env, await inboxMessage(tampered, "https://relay.example/actor", relayKeys.privateKey)), { ok: true, reason: "create_known" });
    assert.equal((await rows(`SELECT n.text FROM note n WHERE n.uri = 'https://author.example/notes/n1'`))[0]!.text, "relayed");

    // a bad HTTP signature still falls back to a valid LD signature (as upstream)
    const create2 = { ...create, id: "https://author.example/notes/n2/activity", object: { ...note, id: "https://author.example/notes/n2" } };
    const signed2 = await new JsonLd(noFetch).signRsaSignature2017(create2, authorKeys.privateKey, "https://author.example/users/al#main-key");
    const msg = await inboxMessage(signed2, "https://relay.example/actor", keys().privateKey);
    assert.deepEqual(await processInbox(f.env, msg), { ok: true, reason: "note_created" });
  });

  it("an accepted relay's Announce publishes the note instead of renoting it", async () => {
    remote.set("https://author.example/notes/n3", json({ id: "https://author.example/notes/n3", type: "Note", attributedTo: "https://author.example/users/al", content: "<p>via relay</p>", to: ["https://www.w3.org/ns/activitystreams#Public"] }));
    await f.db.query(`UPDATE relay SET inbox = 'https://relay.example/inbox' WHERE id = 'r1'`);
    const relayActor = { id: "relayuser", uri: "https://relay.example/actor", host: "relay.example", username: "actor", inbox: "https://relay.example/inbox", sharedInbox: "https://relay.example/inbox", followersUri: null, isLocked: false };
    const ann = parseActivity({ type: "Announce", id: "https://relay.example/announce/1", actor: relayActor.uri, object: "https://author.example/notes/n3", to: ["https://www.w3.org/ns/activitystreams#Public"] })!;
    assert.equal((await applyActivity(f.env, relayActor, ann)).reason, "relay_announce_published");
    assert.equal((await rows(`SELECT 1 FROM note WHERE uri = 'https://author.example/notes/n3'`)).length, 1);
    assert.equal((await rows(`SELECT 1 FROM note WHERE uri = 'https://relay.example/announce/1'`)).length, 0);
    assert.equal((await applyActivity(f.env, relayActor, ann)).reason, "relay_announce_known");
  });
});

describe("unknown signing keys", () => {
  it("the owner is stored only once the signature verifies; a failed fetch is a rejection, not a retry", async () => {
    const create = (actor: string) => ({ "@context": MISSKEY_CONTEXT, id: `${actor}/act/1`, type: "Create", actor, to: ["https://www.w3.org/ns/activitystreams#Public"], object: { id: `${actor}/notes/1`, type: "Note", attributedTo: actor, content: "x", to: ["https://www.w3.org/ns/activitystreams#Public"] } });
    const stored = async (uri: string) => (await f.db.query(`SELECT 1 FROM "user" WHERE uri = $1`, [uri])).rows.length;

    // publishes one key, the request is signed with another
    remote.set("https://forger.example/users/x", json(person("https://forger.example/users/x", relayKeys.publicKey)));
    const forged = await processInbox(f.env, await inboxMessage(create("https://forger.example/users/x"), "https://forger.example/users/x", authorKeys.privateKey));
    assert.deepEqual(forged, { ok: false, reason: "signature_invalid" });
    assert.equal(await stored("https://forger.example/users/x"), 0);

    // the owner cannot be read (5xx): rejected at once
    remote.set("https://down.example/users/x", () => new Response("oops", { status: 503 }));
    const down = await processInbox(f.env, await inboxMessage(create("https://down.example/users/x"), "https://down.example/users/x", authorKeys.privateKey));
    assert.deepEqual(down, { ok: false, reason: "signature_invalid" });
    assert.equal(await stored("https://down.example/users/x"), 0);

    // a valid signature stores the owner
    remote.set("https://good.example/users/x", json(person("https://good.example/users/x", authorKeys.publicKey)));
    const good = await processInbox(f.env, await inboxMessage(create("https://good.example/users/x"), "https://good.example/users/x", authorKeys.privateKey));
    assert.equal(good.ok, true, good.reason);
    assert.equal(await stored("https://good.example/users/x"), 1);
  });
});
