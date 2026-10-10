import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_STREAM_SHARD_COUNT,
  hash32,
  streamShardId,
  timelineDoId,
} from "./index.js";

describe("hash32", () => {
  it("is stable and non-zero for typical ids", () => {
    assert.equal(hash32("user-a"), hash32("user-a"));
    assert.notEqual(hash32("user-a"), hash32("user-b"));
    assert.ok(hash32("abc") > 0);
  });
});

describe("streamShardId", () => {
  it("defaults to N=16 and format stream:{n}", () => {
    assert.equal(DEFAULT_STREAM_SHARD_COUNT, 16);
    const id = streamShardId("u1");
    assert.match(id, /^stream:\d+$/);
    const n = Number(id.split(":")[1]);
    assert.ok(n >= 0 && n < 16);
  });

  it("is deterministic", () => {
    assert.equal(streamShardId("same-user", 16), streamShardId("same-user", 16));
  });

  it("respects custom shard count", () => {
    const id = streamShardId("u1", 4);
    const n = Number(id.split(":")[1]);
    assert.ok(n >= 0 && n < 4);
  });

  it("spreads across shards for many users", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      seen.add(streamShardId(`user-${i}`, 16));
    }
    assert.ok(seen.size >= 8, `expected diversity, got ${seen.size}`);
  });
});

describe("timelineDoId", () => {
  it("cold key is tl:{key}", () => {
    assert.equal(timelineDoId("home:abc"), "tl:home:abc");
  });

  it("hot key appends shard", () => {
    const id = timelineDoId("home:abc", { hot: true, hotShardCount: 4 });
    assert.match(id, /^tl:home:abc:\d+$/);
    const shard = Number(id.split(":").pop());
    assert.ok(shard >= 0 && shard < 4);
  });
});
