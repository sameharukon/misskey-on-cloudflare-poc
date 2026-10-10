/**
 * /api/meta read from PostgreSQL: NULL columns come back as upstream returns them (not test
 * fixture values), and a failed read neither serves made-up meta nor caches it.
 */
import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeFixture, type Fixture } from "./pglite-fixture.js";
import { CACHE_KEYS, MemoryCacheStore } from "./cache.js";
import { packInstanceMeta } from "./meta-source.js";
import { FORK_REPOSITORY_URL } from "./meta-defaults.js";
import type { ApiEnv } from "./env.js";

let f: Fixture;
before(async () => {
  // no BOOTSTRAP_META_JSON: meta goes through mapRowToPackMeta like a deployment
  f = await makeFixture("MetaPgDefaults", { BOOTSTRAP_META_JSON: undefined });
});

const meta = async () => (await f.call("meta", { detail: true })).data;
const failingHyperdrive = {
  connectionString: "postgres://test",
  __testClient: { query: async () => { throw new Error("connection refused"); } },
} as unknown as ApiEnv["HYPERDRIVE"];
/** A copy of the fixture env as a fresh isolate sees it (no meta read yet). */
const coldEnv = (over: Partial<ApiEnv> = {}): ApiEnv => {
  const env = { ...f.env, ...over } as ApiEnv & { __metaOverlay?: unknown };
  delete env.__metaOverlay;
  return env;
};

describe("meta from PostgreSQL", () => {
  it("returns null / empty for NULL columns of an id-only row", async () => {
    const m = await meta();
    for (const k of ["name", "shortName", "description", "maintainerName", "maintainerEmail", "themeColor", "tosUrl"]) {
      assert.equal(m[k], null, k);
    }
    assert.deepEqual(m.langs, []);
    assert.deepEqual(m.serverRules, []);
    // the upstream column defaults apply to a row created without them
    assert.equal(m.repositoryUrl, "https://github.com/misskey-dev/misskey");
    assert.equal(m.feedbackUrl, "https://github.com/misskey-dev/misskey/issues/new");
  });

  it("feedbackUrl cleared → null; repositoryUrl cleared → this fork (AGPL §13)", async () => {
    await f.db.query(`UPDATE meta SET "repositoryUrl" = NULL, "feedbackUrl" = NULL`);
    const m = await meta();
    assert.equal(m.feedbackUrl, null);
    assert.equal(m.repositoryUrl, FORK_REPOSITORY_URL);
  });

  it("admin/update-meta setting a column back to null returns null", async () => {
    assert.equal((await f.call("admin/update-meta", { description: "hello" }, "a")).status, 204);
    assert.equal((await meta()).description, "hello");
    assert.equal((await f.call("admin/update-meta", { description: null }, "a")).status, 204);
    assert.equal((await meta()).description, null);
  });

  it("a failed read without an earlier one is an error, and nothing is cached", async () => {
    const store = new MemoryCacheStore();
    const env = coldEnv({ HYPERDRIVE: failingHyperdrive, __cacheStore: store });
    await assert.rejects(packInstanceMeta(env, true));
    await assert.rejects(packInstanceMeta(env, false));
    assert.equal(await store.get(CACHE_KEYS.metaPackedDetailed), null);
    assert.equal(await store.get(CACHE_KEYS.metaPackedLite), null);
  });

  it("a failed read after a good one serves the last row, without caching it", async () => {
    const env = coldEnv();
    await packInstanceMeta(env, true); // reads the row into this env's overlay
    const store = new MemoryCacheStore();
    const broken: ApiEnv = { ...env, HYPERDRIVE: failingHyperdrive, __cacheStore: store };
    const m = (await packInstanceMeta(broken, true)) as Record<string, unknown>;
    assert.equal(m.description, null);
    assert.equal(await store.get(CACHE_KEYS.metaPackedDetailed), null);
  });

  it("INSTANCE_URL is required when Hyperdrive is bound", async () => {
    const env = coldEnv({ INSTANCE_URL: undefined });
    await assert.rejects(packInstanceMeta(env, true), /INSTANCE_URL/);
  });
});
