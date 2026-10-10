import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseAcctResource } from "./discovery.js";

describe("AP discovery", () => {
  it("parses acct resources", () => {
    assert.deepEqual(parseAcctResource("acct:alice@example.com"), {
      user: "alice",
      host: "example.com",
    });
    assert.equal(parseAcctResource("alice@example.com"), null);
    assert.equal(parseAcctResource(null), null);
  });
});
