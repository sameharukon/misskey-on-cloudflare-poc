import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { invalidateIsolateCache, isolateCached, requestMemo, runWithPgScope, setPgClientFactoryForTest, withHyperdriveClient, type PgQueryResult } from "./pg.js";
import { makeFixture } from "./pglite-fixture.js";

type Fake = { id: number; log: string[]; ended: boolean };

function fakeFactory() {
  const clients: Fake[] = [];
  setPgClientFactoryForTest(async () => {
    const c: Fake = { id: clients.length, log: [], ended: false };
    clients.push(c);
    return {
      async query(text: string): Promise<PgQueryResult> {
        assert.equal(c.ended, false, "query on a closed connection");
        c.log.push(text);
        await new Promise((r) => setTimeout(r, 1));
        return { rows: [{ n: c.log.length }], rowCount: 1 };
      },
      async end() {
        c.ended = true;
      },
    };
  });
  return clients;
}

const hd = { connectionString: "postgres://fake" };

afterEach(() => setPgClientFactoryForTest(null));

describe("withHyperdriveClient request scope", () => {
  it("opens a connection per call outside a scope", async () => {
    const clients = fakeFactory();
    await withHyperdriveClient(hd, (c) => c.query("SELECT 1"));
    await withHyperdriveClient(hd, (c) => c.query("SELECT 2"));
    assert.equal(clients.length, 2);
    assert.ok(clients.every((c) => c.ended));
  });

  it("shares one connection in a scope, closed when the scope ends", async () => {
    const clients = fakeFactory();
    await runWithPgScope(async () => {
      await withHyperdriveClient(hd, (c) => c.query("SELECT 1"));
      await Promise.all([
        withHyperdriveClient(hd, (c) => c.query("SELECT 2")),
        withHyperdriveClient(hd, (c) => withHyperdriveClient(hd, (d) => d.query("SELECT 3")).then(() => c.query("SELECT 4"))),
      ]);
      assert.equal(clients[0]!.ended, false);
    });
    assert.equal(clients.length, 1);
    assert.equal(clients[0]!.log.length, 4);
    assert.equal(clients[0]!.ended, true);
  });

  it("keeps the connection for waitUntil work and closes it afterwards", async () => {
    const clients = fakeFactory();
    const pending: Promise<unknown>[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    await runWithPgScope(
      async () => {
        await withHyperdriveClient(hd, (c) => c.query("SELECT 1"));
        pending.push(withHyperdriveClient(hd, async (c) => {
          await gate;
          return c.query("INSERT INTO user_ip VALUES (1)");
        }));
      },
      (p) => pending.push(p),
    );
    assert.equal(clients[0]!.ended, false);
    release();
    await Promise.all(pending);
    assert.equal(clients.length, 1);
    assert.equal(clients[0]!.ended, true);
  });

  it("holds other callers back while a transaction is open", async () => {
    const clients = fakeFactory();
    await runWithPgScope(async () => {
      let resume!: () => void;
      const paused = new Promise<void>((r) => (resume = r));
      const tx = withHyperdriveClient(hd, async (c) => {
        await c.query("BEGIN");
        await c.query("UPDATE a SET x = 1");
        await paused;
        await c.query("COMMIT");
      });
      await new Promise((r) => setTimeout(r, 5));
      const other = withHyperdriveClient(hd, (c) => c.query("SELECT other"));
      await new Promise((r) => setTimeout(r, 5));
      resume();
      await Promise.all([tx, other]);
    });
    assert.deepEqual(clients[0]!.log, ["BEGIN", "UPDATE a SET x = 1", "COMMIT", "SELECT other"]);
  });

  it("rolls back a transaction its callback left open", async () => {
    const clients = fakeFactory();
    await runWithPgScope(async () => {
      await assert.rejects(
        withHyperdriveClient(hd, async (c) => {
          await c.query("BEGIN");
          throw new Error("boom");
        }),
      );
      await withHyperdriveClient(hd, (c) => c.query("SELECT after"));
    });
    assert.deepEqual(clients[0]!.log, ["BEGIN", "ROLLBACK", "SELECT after"]);
  });
});

describe("requestMemo", () => {
  it("loads once per scope, drops reads on writes, keeps stable values", async () => {
    fakeFactory();
    let reads = 0;
    let stable = 0;
    const read = () => requestMemo("k", async () => ({ n: ++reads }), { clone: true });
    const auth = () => requestMemo("a", async () => ++stable, { stable: true });
    await runWithPgScope(async () => {
      const a = await read();
      a.n = 99;
      assert.deepEqual(await read(), { n: 1 }, "clone keeps callers from mutating the memo");
      await auth();
      await withHyperdriveClient(hd, (c) => c.query(`UPDATE meta SET name = 'x' WHERE id = $1`));
      assert.deepEqual(await read(), { n: 2 });
      await auth();
    });
    assert.equal(stable, 1);
    await read();
    assert.equal(reads, 3, "no memo outside a scope");
  });
});

describe("request scope with the API", () => {
  it("authenticates once per call and sees its own meta writes", async () => {
    const fx = await makeFixture("scope");
    const queries: string[] = [];
    const inner = (fx.env.HYPERDRIVE as unknown as { __testClient: { query: (t: string, p?: unknown[]) => Promise<PgQueryResult> } }).__testClient;
    const query = inner.query.bind(inner);
    inner.query = (t, p) => {
      queries.push(t);
      return query(t, p);
    };
    const r = await fx.call("i", {}, "a");
    assert.equal(r.status, 200);
    assert.equal(queries.filter((q) => /FROM "user"\s+WHERE token = \$1/.test(q)).length, 1);

    await runWithPgScope(async () => {
      const { metaRowPg } = await import("./user-lite-pg.js");
      await withHyperdriveClient(fx.env.HYPERDRIVE, async (c) => {
        assert.equal((await metaRowPg(c)).name ?? null, null);
        await c.query(`UPDATE meta SET name = 'renamed' WHERE id = 'x'`);
        assert.equal((await metaRowPg(c)).name, "renamed");
      });
    });
  });
});

describe("isolateCached", () => {
  it("caches across scopes for the TTL and clears on writes to the table", async () => {
    fakeFactory();
    const ns = { connectionString: "postgres://isolate-cache" };
    invalidateIsolateCache(null, "meta:");
    let loads = 0;
    const read = () =>
      runWithPgScope(() => withHyperdriveClient(ns, (c) => isolateCached(c, "meta:test", 60_000, async () => ({ n: ++loads }), { clone: true })));
    assert.deepEqual(await read(), { n: 1 });
    assert.deepEqual(await read(), { n: 1 }, "second request hits the isolate cache");
    await runWithPgScope(() => withHyperdriveClient(ns, (c) => c.query(`UPDATE meta SET name = 'x'`)));
    assert.deepEqual(await read(), { n: 2 }, "a write to meta clears it");
    await runWithPgScope(() => withHyperdriveClient(ns, (c) => c.query(`UPDATE role_assignment SET x = 1`)));
    assert.deepEqual(await read(), { n: 2 }, "writes to other tables keep it");
    await withHyperdriveClient(ns, (c) => c.query(`INSERT INTO meta (id) VALUES ('y')`));
    assert.deepEqual(await read(), { n: 3 }, "writes outside a scope clear it too");
  });

  it("does not cache outside a scope or for offline test clients", async () => {
    let loads = 0;
    const load = async () => ++loads;
    const fx = await makeFixture("isolate-off");
    await runWithPgScope(() => withHyperdriveClient(fx.env.HYPERDRIVE, (c) => isolateCached(c, "meta:off", 60_000, load)));
    await runWithPgScope(() => withHyperdriveClient(fx.env.HYPERDRIVE, (c) => isolateCached(c, "meta:off", 60_000, load)));
    assert.equal(loads, 2);
  });
});
