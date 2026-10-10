import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createPrivateKey, createPublicKey, createSign, createVerify } from "node:crypto";
import { genRsaPem } from "./ap/rsa.js";

describe("genRsaPem", () => {
  it("returns SPKI / PKCS#8 PEM of an RSA-2048 key, usable for RSA-SHA256 signatures", async () => {
    const [pub, priv] = await genRsaPem();
    assert.match(pub, /^-----BEGIN PUBLIC KEY-----\n([A-Za-z0-9+/=]{64}\n)+[A-Za-z0-9+/=]{1,64}\n-----END PUBLIC KEY-----\n$/);
    assert.match(priv, /^-----BEGIN PRIVATE KEY-----\n/);
    const pk = createPublicKey(pub);
    assert.equal(pk.asymmetricKeyType, "rsa");
    assert.equal(pk.asymmetricKeyDetails?.modulusLength, 2048);
    assert.equal(pk.asymmetricKeyDetails?.publicExponent, 65537n);
    const sig = createSign("RSA-SHA256").update("x").sign(createPrivateKey(priv));
    assert.ok(createVerify("RSA-SHA256").update("x").verify(pk, sig));
  });
});
