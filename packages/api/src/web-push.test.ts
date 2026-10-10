/**
 * Web Push: RFC 8291 payload encryption (decrypted here with the user agent's keys), RFC 8292
 * VAPID JWT (signature verified), sw/* endpoints on PGlite, and pushes for notifications
 * (only while unread), readAllNotifications (sendReadMessage only, only when something was
 * unread) and 410 cleanup — with the real NotificationBox class.
 */
import { before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { NotificationBox } from "../../timeline/src/index.js";
import { IMPLEMENTED_ENDPOINTS } from "./registry.js";
import { fakeDoNamespace, makeFixture, type Fixture } from "./pglite-fixture.js";
import { b64urlDecode, b64urlEncode, encryptPayload, generateVapidKeys, vapidAuthorization } from "./web-push.js";
import { noteSummary, truncateBody } from "./sw-pg.js";
import type { ApiEnv } from "./env.js";
import { ENDPOINT_PARAM_DEFS } from "./endpoint-params.gen.js";

const te = new TextEncoder();
async function hmac(key: Uint8Array, data: Uint8Array) {
  const k = await crypto.subtle.importKey("raw", key as Uint8Array<ArrayBuffer>, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, data as Uint8Array<ArrayBuffer>));
}
const cat = (...p: Uint8Array[]) => {
  const o = new Uint8Array(p.reduce((n, x) => n + x.length, 0));
  let i = 0;
  for (const x of p) (o.set(x, i), (i += x.length));
  return o;
};

/** A user agent: P-256 keys + auth secret, and RFC 8291 decryption. */
async function userAgent() {
  const kp = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const pub = new Uint8Array((await crypto.subtle.exportKey("raw", kp.publicKey)) as ArrayBuffer);
  const auth = crypto.getRandomValues(new Uint8Array(16));
  return {
    publickey: b64urlEncode(pub),
    auth: b64urlEncode(auth),
    async decrypt(body: Uint8Array): Promise<string> {
      const salt = body.slice(0, 16);
      const idlen = body[20]!;
      const asPub = body.slice(21, 21 + idlen);
      const ct = body.slice(21 + idlen);
      const asKey = await crypto.subtle.importKey("raw", asPub, { name: "ECDH", namedCurve: "P-256" }, false, []);
      const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: asKey }, kp.privateKey, 256));
      const prkKey = await hmac(auth, ecdh);
      const ikm = (await hmac(prkKey, cat(te.encode("WebPush: info\0"), pub, asPub, new Uint8Array([1])))).slice(0, 32);
      const prk = await hmac(salt, ikm);
      const cek = (await hmac(prk, cat(te.encode("Content-Encoding: aes128gcm\0"), new Uint8Array([1])))).slice(0, 16);
      const nonce = (await hmac(prk, cat(te.encode("Content-Encoding: nonce\0"), new Uint8Array([1])))).slice(0, 12);
      const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
      const pt = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, ct));
      assert.equal(pt.at(-1), 2); // last-record delimiter
      return new TextDecoder().decode(pt.slice(0, -1));
    },
  };
}

describe("web push crypto", () => {
  it("aes128gcm payload decrypts with the user agent keys; header layout", async () => {
    const ua = await userAgent();
    const body = await encryptPayload(te.encode("When I grow up, I want to be a watermelon"), ua.publickey, ua.auth);
    assert.equal(new DataView(body.buffer).getUint32(16), 4096);
    assert.equal(body[20], 65);
    assert.equal(await ua.decrypt(body), "When I grow up, I want to be a watermelon");
  });

  it("VAPID JWT: ES256 over the endpoint origin, verifiable with the public key", async () => {
    const keys = await generateVapidKeys();
    assert.equal(b64urlDecode(keys.publicKey).length, 65);
    assert.equal(b64urlDecode(keys.privateKey).length, 32);
    const h = await vapidAuthorization("https://push.example/send/abc", "https://misskey.example.com", keys.publicKey, keys.privateKey, 1_700_000_000_000);
    const m = /^vapid t=([^,]+), k=(.+)$/.exec(h)!;
    assert.equal(m[2], keys.publicKey);
    const [hd, pl, sig] = m[1]!.split(".");
    assert.deepEqual(JSON.parse(new TextDecoder().decode(b64urlDecode(pl!))), { aud: "https://push.example", exp: 1_700_000_000 + 43200, sub: "https://misskey.example.com" });
    const pub = await crypto.subtle.importKey("raw", b64urlDecode(keys.publicKey) as Uint8Array<ArrayBuffer>, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    assert.ok(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pub, b64urlDecode(sig!) as Uint8Array<ArrayBuffer>, te.encode(`${hd}.${pl}`)));
  });

  it("truncateBody / note summary (upstream)", () => {
    assert.equal(noteSummary({ text: "hi", files: [1, 2], poll: {}, replyId: "r", reply: { cw: "spoiler" } }), "hi (📎2) (📊)\n\nRE: spoiler");
    const t = truncateBody("notification", { type: "renote", note: { text: "x", user: { id: "u" }, renote: { text: "orig" }, cw: "c" } }) as any;
    assert.deepEqual([t.note.text, t.note.user, t.note.cw, t.note.renote], ["orig", undefined, undefined, undefined]);
  });
});

type Sent = { url: string; headers: Record<string, string>; body: Uint8Array };
const sent: Sent[] = [];
let status = 201;
const fakeFetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
  const headers: Record<string, string> = {};
  new Headers(init?.headers).forEach((v, k) => void (headers[k] = v));
  sent.push({ url: String(url), headers, body: new Uint8Array(init!.body as Uint8Array) });
  return new Response(null, { status });
}) as typeof fetch;

let f: Fixture;
before(async () => {
  f = await makeFixture("WebPushTest", {
    AP_FETCH: fakeFetch,
    NOTIFICATION_BOX: fakeDoNamespace((s) => new NotificationBox(s as never)) as unknown as ApiEnv["NOTIFICATION_BOX"],
  } as Partial<ApiEnv>);
});
beforeEach(() => {
  sent.length = 0;
  status = 201;
});
const E = (r: { data: any }) => r.data?.error?.id;

describe("sw/*", () => {
  let ua: Awaited<ReturnType<typeof userAgent>>;
  let keys: { publicKey: string; privateKey: string };

  it("registers endpoints", () => {
    for (const e of ["sw/register", "sw/unregister", "sw/show-registration", "sw/update-registration"]) {
      assert.ok((IMPLEMENTED_ENDPOINTS as readonly string[]).includes(e), e);
      assert.ok(ENDPOINT_PARAM_DEFS[e], e);
    }
  });

  it("register / show / update / unregister", async () => {
    keys = await generateVapidKeys();
    await f.db.query(`UPDATE meta SET "enableServiceWorker" = TRUE, "swPublicKey" = $1, "swPrivateKey" = $2`, [keys.publicKey, keys.privateKey]);
    ua = await userAgent();
    const reg = { endpoint: "https://push.example/send/b", auth: ua.auth, publickey: ua.publickey };
    assert.equal(E(await f.call("sw/register", { ...reg, endpoint: "http://push.example/x" }, "b")), "4432adbe-17c0-4f9f-b43c-9ceb2f8910fe");
    assert.equal(E(await f.call("sw/register", { ...reg, endpoint: "https://u:p@push.example/x" }, "b")), "4432adbe-17c0-4f9f-b43c-9ceb2f8910fe");
    assert.deepEqual((await f.call("sw/register", reg, "b")).data, { state: "subscribed", key: keys.publicKey, userId: f.ids.b, endpoint: reg.endpoint, sendReadMessage: false });
    assert.equal((await f.call("sw/register", reg, "b")).data.state, "already-subscribed");
    assert.deepEqual((await f.call("sw/show-registration", { endpoint: reg.endpoint }, "b")).data, { userId: f.ids.b, endpoint: reg.endpoint, sendReadMessage: false });
    assert.equal((await f.call("sw/show-registration", { endpoint: reg.endpoint }, "c")).data, null);
    assert.equal(E(await f.call("sw/update-registration", { endpoint: "https://nope.example" }, "b")), " b09d8066-8064-5613-efb6-0e963b21d012");
    assert.equal((await f.call("sw/update-registration", { endpoint: reg.endpoint, sendReadMessage: true }, "b")).data.sendReadMessage, true);
    // unregister needs no credential (the auth secret proves ownership)
    const other = await userAgent();
    await f.call("sw/register", { endpoint: "https://push.example/send/c", auth: other.auth, publickey: other.publickey }, "c");
    assert.equal((await f.call("sw/unregister", { endpoint: "https://push.example/send/c", auth: "wrong", publickey: other.publickey })).status, 204);
    assert.equal(Number(((await f.db.query(`SELECT count(*)::int AS n FROM sw_subscription`)).rows[0] as any).n), 2);
    assert.equal((await f.call("sw/unregister", { endpoint: "https://push.example/send/c", auth: other.auth, publickey: other.publickey })).status, 204);
    assert.equal(Number(((await f.db.query(`SELECT count(*)::int AS n FROM sw_subscription`)).rows[0] as any).n), 1);
  });

  it("notifications are pushed encrypted with VAPID; readAllNotifications (forced by mark-all-as-read)", async () => {
    assert.ok((await f.call("notifications/test-notification", {}, "b")).status < 300);
    assert.equal(sent.length, 1);
    const s = sent[0]!;
    assert.equal(s.url, "https://push.example/send/b");
    assert.equal(s.headers["content-encoding"], "aes128gcm");
    assert.equal(s.headers.ttl, "2419200");
    assert.match(s.headers.authorization!, new RegExp(`^vapid t=.+, k=${keys.publicKey}$`));
    const msg = JSON.parse(await ua.decrypt(s.body));
    assert.equal(msg.type, "notification");
    assert.equal(msg.userId, f.ids.b);
    assert.equal(msg.body.type, "test");
    assert.equal(typeof msg.dateTime, "number");

    sent.length = 0;
    assert.ok((await f.call("notifications/mark-all-as-read", {}, "b")).status < 300);
    assert.equal(sent.length, 1);
    assert.equal(JSON.parse(await ua.decrypt(sent[0]!.body)).type, "readAllNotifications");
    sent.length = 0;
    // upstream: notifications/mark-all-as-read calls readAllNotification(me.id, true) — forced,
    // so it is posted again even with nothing unread
    await f.call("notifications/mark-all-as-read", {}, "b");
    assert.equal(sent.length, 1);
  });

  it("410 removes the subscription; disabled service worker sends nothing", async () => {
    status = 410;
    await f.call("notifications/test-notification", {}, "b");
    assert.equal(Number(((await f.db.query(`SELECT count(*)::int AS n FROM sw_subscription WHERE "userId" = $1`, [f.ids.b])).rows[0] as any).n), 0);
    status = 201;
    await f.call("sw/register", { endpoint: "https://push.example/send/b2", auth: ua.auth, publickey: ua.publickey }, "b");
    await f.db.query(`UPDATE meta SET "enableServiceWorker" = FALSE`);
    sent.length = 0;
    await f.call("notifications/test-notification", {}, "b");
    assert.equal(sent.length, 0);
  });
});
