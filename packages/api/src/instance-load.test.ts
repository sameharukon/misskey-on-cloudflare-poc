/**
 * Per-activity instance work: latestRequestReceivedAt is written at most once a minute per
 * host in an isolate, and only one metadata refresh runs at a time (claimed through infoUpdatedAt).
 */
import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeFixture, type Fixture } from "./pglite-fixture.js";
import { fetchInstanceMetadata, findInstanceC, instanceRequestReceived, resetInstanceRequestCache } from "./ap/instances.js";
import { withHyperdriveClient } from "./pg.js";

let f: Fixture;
const fetched: string[] = [];

before(async () => {
  f = await makeFixture("InstanceLoad", {
    AP_FETCH: (async (url: string) => {
      fetched.push(url);
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch,
  });
});

const row = (host: string) => withHyperdriveClient(f.env.HYPERDRIVE!, (c) => findInstanceC(c, host));

describe("instance work per activity", () => {
  it("latestRequestReceivedAt: once a minute per host", async () => {
    resetInstanceRequestCache();
    await instanceRequestReceived(f.env, "busy.example");
    const first = (await row("busy.example"))!;
    assert.ok(first.latestRequestReceivedAt);
    await f.db.query(`UPDATE instance SET "latestRequestReceivedAt" = '2000-01-01' WHERE host = 'busy.example'`);
    await instanceRequestReceived(f.env, "busy.example");
    assert.equal(new Date(String((await row("busy.example"))!.latestRequestReceivedAt)).getUTCFullYear(), 2000);
    // after the interval (a fresh isolate here) it is written again
    resetInstanceRequestCache();
    await instanceRequestReceived(f.env, "busy.example");
    assert.notEqual(new Date(String((await row("busy.example"))!.latestRequestReceivedAt)).getUTCFullYear(), 2000);
  });

  it("metadata: concurrent refreshes of a stale instance fetch once", async () => {
    await f.db.query(`INSERT INTO instance (id, host, "firstRetrievedAt", "infoUpdatedAt") VALUES ('i-stale', 'stale.example', now(), now() - interval '2 days')`);
    const stale = (await row("stale.example"))!;
    fetched.length = 0;
    await Promise.all([fetchInstanceMetadata(f.env, stale, false), fetchInstanceMetadata(f.env, stale, false)]);
    assert.equal(fetched.filter((u) => u === "https://stale.example/.well-known/nodeinfo").length, 1);
    // now fresh: nothing more
    fetched.length = 0;
    await fetchInstanceMetadata(f.env, stale, false);
    assert.equal(fetched.length, 0);
  });
});
