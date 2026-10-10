import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  AS_PUBLIC,
  exportPkcs8Pem,
  exportSpkiPem,
  generateRsaKeyPair,
  importSpkiPem,
  isSafeRemoteUrl,
  likeReaction,
  noteText,
  parseActivity,
  parseVisibility,
  precheckIncoming,
  renderNote,
  renderPerson,
  signedGetHeaders,
  signedPostHeaders,
  verifyRequest,
} from "./index.js";

async function keys() {
  const kp = await generateRsaKeyPair();
  return { pub: await exportSpkiPem(kp.publicKey), priv: await exportPkcs8Pem(kp.privateKey) };
}

describe("outbound signing ↔ inbound verification", () => {
  it("signed POST verifies; tampering is detected", async () => {
    const k = await keys();
    const body = JSON.stringify({ type: "Create", actor: "https://a.example/users/1" });
    const headers = await signedPostHeaders({ privateKeyPem: k.priv, keyId: "https://a.example/users/1#main-key", url: "https://b.example/inbox", body });
    assert.match(headers.Signature!, /headers="\(request-target\) date host digest"/);
    const lower = Object.fromEntries(Object.entries(headers).map(([a, b]) => [a.toLowerCase(), b]));
    const pre = await precheckIncoming({ method: "POST", headers: lower, body, expectedHost: "b.example" });
    assert.deepEqual(pre, { ok: true, keyId: "https://a.example/users/1#main-key" });
    const pub = await importSpkiPem(k.pub);
    assert.equal(await verifyRequest({ publicKey: pub, method: "POST", pathWithQuery: "/inbox", headers: lower, signatureHeader: lower.signature! }), true);
    // wrong path → signature invalid
    assert.equal(await verifyRequest({ publicKey: pub, method: "POST", pathWithQuery: "/users/x/inbox", headers: lower, signatureHeader: lower.signature! }), false);
    // body tamper → digest mismatch
    const bad = await precheckIncoming({ method: "POST", headers: lower, body: body + " ", expectedHost: "b.example" });
    assert.deepEqual(bad, { ok: false, reason: "digest_mismatch" });
    // host mismatch / skew
    assert.deepEqual(await precheckIncoming({ method: "POST", headers: lower, body, expectedHost: "c.example" }), { ok: false, reason: "host_mismatch" });
    assert.deepEqual(
      await precheckIncoming({ method: "POST", headers: lower, body, expectedHost: "b.example", now: new Date(Date.now() + 2 * 3600_000) }),
      { ok: false, reason: "date_skew" },
    );
  });

  it("rejects POST signatures that do not cover digest", async () => {
    const pre = await precheckIncoming({
      method: "POST",
      headers: { signature: 'keyId="k",algorithm="rsa-sha256",headers="(request-target) host date",signature="x"', host: "b.example", date: new Date().toUTCString() },
      body: "{}",
      expectedHost: "b.example",
    });
    assert.deepEqual(pre, { ok: false, reason: "unsigned_digest" });
  });

  it("signed GET covers accept", async () => {
    const k = await keys();
    const h = await signedGetHeaders({ privateKeyPem: k.priv, keyId: "k#main-key", url: "https://r.example/users/9" });
    assert.match(h.Signature!, /headers="\(request-target\) date host accept"/);
  });
});

describe("renderer + parser", () => {
  it("audience per visibility round-trips through parseVisibility", () => {
    for (const v of ["public", "home", "followers"] as const) {
      const n = renderNote({ base: "https://l.example", id: "n1", userId: "u1", text: "hi <b>", cw: null, createdAt: "2026-01-01T00:00:00Z", visibility: v, inReplyTo: null, mentionUris: [] });
      assert.equal(parseVisibility(n, "https://l.example/users/u1/followers"), v);
      assert.equal(noteText(n), "hi <b>");
      assert.equal(n.content, "<p>hi &lt;b&gt;</p>");
    }
    const s = renderNote({ base: "https://l.example", id: "n2", userId: "u1", text: "x", cw: null, createdAt: "", visibility: "specified", inReplyTo: null, mentionUris: ["https://r.example/users/2"] });
    assert.deepEqual(s.to, ["https://r.example/users/2"]);
    assert.equal(parseVisibility(s, null), "specified");
    assert.equal(parseVisibility({ to: [AS_PUBLIC] }, null), "public");
  });

  it("Person fields: URL values become rel=me links (upstream tryRewriteUrl)", () => {
    const p = renderPerson({
      base: "https://a.example", id: "u1", username: "u", name: null, summary: null, publicKeyPem: "k", isLocked: false, isBot: false,
      fields: [
        { name: "site", value: "https://example.com/path?q=1 (mine)" },
        { name: "text", value: "hello" },
        { name: "odd", value: "https://" },
      ],
    });
    assert.deepEqual(p.attachment, [
      { type: "PropertyValue", name: "site", value: '<a href="https://example.com/path?q=1" rel="me nofollow noopener" target="_blank">https://example.com/path?q=1</a> (mine)' },
      { type: "PropertyValue", name: "text", value: "hello" },
      { type: "PropertyValue", name: "odd", value: "https://" },
    ]);
  });

  it("a quote carries RE: <link> in content (upstream quote-inline)", () => {
    const n = renderNote({
      base: "https://a.example", id: "n1", userId: "u1", text: "look", cw: null, createdAt: "2026-01-01T00:00:00.000Z",
      visibility: "public", mentionUris: [], inReplyTo: null, quoteUri: "https://b.example/notes/q",
    });
    assert.equal(n.content, '<p>look<br><br><span class="quote-inline">RE: <a href="https://b.example/notes/q">https://b.example/notes/q</a></span></p>');
    assert.deepEqual([n._misskey_quote, n.quoteUrl, n._misskey_content], ["https://b.example/notes/q", "https://b.example/notes/q", "look"]);
  });

  it("importSpkiPem reads PKCS#1 (BEGIN RSA PUBLIC KEY) as well as SPKI", async () => {
    const kp = await generateRsaKeyPair();
    const spkiPem = await exportSpkiPem(kp.publicKey);
    // the PKCS#1 RSAPublicKey is the BIT STRING content of the SPKI (after its unused-bits octet)
    const spki = Uint8Array.from(atob(spkiPem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "")), (c) => c.charCodeAt(0));
    const pkcs1 = spki.subarray(spki.length - 270);
    assert.equal(pkcs1[0], 0x30);
    const pkcs1Pem = `-----BEGIN RSA PUBLIC KEY-----\n${btoa(String.fromCharCode(...pkcs1)).match(/.{1,64}/g)!.join("\n")}\n-----END RSA PUBLIC KEY-----\n`;
    for (const pem of [spkiPem, pkcs1Pem]) {
      const key = await importSpkiPem(pem);
      const data = new TextEncoder().encode("hello");
      const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", kp.privateKey, data);
      assert.equal(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, sig, data), true);
    }
  });

  it("noteText falls back to HTML", () => {
    assert.equal(noteText({ content: "<p>a<br>b &amp; c</p>" }), "a\nb & c");
  });

  it("likeReaction maps custom emoji to remote host; default ❤", () => {
    assert.equal(likeReaction({ _misskey_reaction: ":blob:" }, "r.example"), ":blob@r.example:");
    assert.equal(likeReaction({ content: "👍" }, "r.example"), "👍");
    assert.equal(likeReaction({}, "r.example"), "❤");
  });

  it("parseActivity requires type + actor", () => {
    assert.equal(parseActivity({ type: "Follow" }), null);
    assert.equal(parseActivity({ type: "Follow", actor: { id: "https://r/u" }, object: "x" })?.actor, "https://r/u");
  });

  it("SSRF guard", () => {
    assert.equal(isSafeRemoteUrl("https://r.example/inbox"), true);
    for (const u of ["http://r.example/inbox", "https://127.0.0.1/x", "https://localhost/x", "https://[::1]/x", "https://svc.internal/x", "nope"]) {
      assert.equal(isSafeRemoteUrl(u), false, u);
    }
  });
});
