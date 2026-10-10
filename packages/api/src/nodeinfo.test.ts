/**
 * NodeInfo 2.0 / 2.1 from meta and the local counts (upstream NodeinfoServerService).
 */
import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeFixture, type Fixture } from "./pglite-fixture.js";
import { handleApRoutes } from "./ap/routes.js";
import { setFederationPolicy } from "./ap/federation.js";
import { fixtureMeta } from "../../packers/src/fixtures.js";

let f: Fixture;
const get = async (path: string) => (await handleApRoutes(new Request(`https://local.example${path}`), f.env))!;

before(async () => {
  const meta = fixtureMeta({
    name: "Sample",
    description: "A test server",
    maintainerName: "admin",
    maintainerEmail: "admin@example.com",
    langs: ["ja"],
    repositoryUrl: "https://example.com/repo",
    disableRegistration: false,
    themeColor: "#123456",
  });
  f = await makeFixture("Nodeinfo", { BOOTSTRAP_META_JSON: JSON.stringify(meta) });
  setFederationPolicy(f.env, { mode: "all", hosts: [], blockedHosts: [] });
  await f.db.query(`INSERT INTO note (id, "userId", "userHost", visibility, text) VALUES ('n1', $1, NULL, 'public', 'hi')`, [f.ids.a]);
});

describe("nodeinfo", () => {
  it("lists 2.1 and 2.0", async () => {
    const r = (await (await get("/.well-known/nodeinfo")).json()) as { links: { rel: string; href: string }[] };
    assert.deepEqual(r.links, [
      { rel: "http://nodeinfo.diaspora.software/ns/schema/2.1", href: "https://misskey.example.com/nodeinfo/2.1" },
      { rel: "http://nodeinfo.diaspora.software/ns/schema/2.0", href: "https://misskey.example.com/nodeinfo/2.0" },
    ]);
  });

  it("2.1 carries meta, counts and the proxy account", async () => {
    const res = await get("/nodeinfo/2.1");
    assert.match(res.headers.get("content-type")!, /schema\/2\.1#/);
    assert.equal(res.headers.get("access-control-allow-origin"), "*");
    const ni = (await res.json()) as any;
    assert.equal(ni.version, "2.1");
    assert.equal(ni.software.name, "misskey");
    assert.equal(ni.software.repository, "https://example.com/repo");
    assert.equal(ni.software.homepage, "https://example.com/repo");
    assert.equal(ni.openRegistrations, true);
    assert.deepEqual(ni.services, { inbound: [], outbound: ["atom1.0", "rss2.0"] });
    const localUsers = Number((await f.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM "user" WHERE host IS NULL`)).rows[0]!.n);
    assert.deepEqual(ni.usage, { users: { total: localUsers, activeHalfyear: null, activeMonth: null }, localPosts: 1, localComments: 0 });
    assert.equal(ni.metadata.nodeName, "Sample");
    assert.equal(ni.metadata.nodeDescription, "A test server");
    assert.deepEqual(ni.metadata.nodeAdmins, [{ name: "admin", email: "admin@example.com" }]);
    assert.deepEqual(ni.metadata.maintainer, { name: "admin", email: "admin@example.com" });
    assert.deepEqual(ni.metadata.langs, ["ja"]);
    assert.equal(ni.metadata.themeColor, "#123456");
    assert.equal(ni.metadata.proxyAccountName, "system.proxy");
    assert.equal(ni.metadata.disableRegistration, false);
    assert.equal(ni.metadata.federation, "all");
  });

  it("2.0 has the misskey-hub homepage and no repository", async () => {
    const ni = (await (await get("/nodeinfo/2.0")).json()) as any;
    assert.equal(ni.version, "2.0");
    assert.equal(ni.software.homepage, "https://misskey-hub.net");
    assert.equal("repository" in ni.software, false);
    assert.equal(ni.metadata.nodeName, "Sample");
  });
});
