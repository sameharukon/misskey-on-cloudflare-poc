import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildSigningString,
  formatSignatureHeader,
  generateRsaKeyPair,
  parseSignatureHeader,
  signRequest,
  verifyRequest,
  exportSpkiPem,
  importSpkiPem,
} from "./http-signature.js";

describe("HTTP Signatures (Web Crypto)", () => {
  it("parses and formats Signature header", () => {
    const raw =
      'keyId="https://ex/users/a#main-key",algorithm="rsa-sha256",headers="(request-target) host date",signature="abc="';
    const p = parseSignatureHeader(raw)!;
    assert.equal(p.keyId, "https://ex/users/a#main-key");
    assert.deepEqual(p.headers, ["(request-target)", "host", "date"]);
    assert.equal(formatSignatureHeader(p), raw);
  });

  it("builds signing string with request-target", () => {
    const s = buildSigningString(
      "POST",
      "/inbox",
      { host: "ex.com", date: "Tue, 07 Jun 2014 20:51:35 GMT" },
      ["(request-target)", "host", "date"],
    );
    assert.equal(
      s,
      "(request-target): post /inbox\nhost: ex.com\ndate: Tue, 07 Jun 2014 20:51:35 GMT",
    );
  });

  it("sign + verify round-trip; tamper fails", async () => {
    const { privateKey, publicKey } = await generateRsaKeyPair();
    const headers = {
      host: "remote.example",
      date: new Date().toUTCString(),
    };
    const { signatureHeader } = await signRequest({
      privateKey,
      keyId: "https://local.example/users/seed#main-key",
      method: "POST",
      pathWithQuery: "/inbox",
      headers,
    });

    const ok = await verifyRequest({
      publicKey,
      method: "POST",
      pathWithQuery: "/inbox",
      headers,
      signatureHeader,
    });
    assert.equal(ok, true);

    const bad = await verifyRequest({
      publicKey,
      method: "POST",
      pathWithQuery: "/inbox",
      headers: { ...headers, date: "Wed, 01 Jan 2020 00:00:00 GMT" },
      signatureHeader,
    });
    assert.equal(bad, false);

    // PEM export/import still verifies
    const pem = await exportSpkiPem(publicKey);
    const imported = await importSpkiPem(pem);
    assert.equal(
      await verifyRequest({
        publicKey: imported,
        method: "POST",
        pathWithQuery: "/inbox",
        headers,
        signatureHeader,
      }),
      true,
    );
  });
});
