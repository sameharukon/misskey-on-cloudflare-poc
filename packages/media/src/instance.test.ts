import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { instanceFor, PROXY_INSTANCES } from "./instance.js";

describe("media instanceFor", () => {
  it("sends alternates to media-bulk", () => {
    assert.equal(instanceFor(new URL("https://media.internal/alts?type=image/png&web=1")), "media-bulk");
  });

  it("spreads /proxy by key, the same key on the same instance", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const u = new URL(`https://media.internal/proxy?mode=emoji&key=${encodeURIComponent(`https://remote.example/${i}.png`)}`);
      const a = instanceFor(u);
      assert.equal(instanceFor(u), a);
      assert.match(a, /^media-\d$/);
      seen.add(a);
    }
    assert.equal(seen.size, PROXY_INSTANCES);
  });

  it("picks one at random without a key", () => {
    const u = new URL("https://media.internal/twemoji-badge");
    assert.equal(instanceFor(u, () => 0), "media-0");
    assert.equal(instanceFor(u, () => 0.999), `media-${PROXY_INSTANCES - 1}`);
  });
});
