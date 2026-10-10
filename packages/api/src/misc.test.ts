/**
 * Small client / top-level endpoints (src/misc-pg.ts) on PGlite, plus the RSS parser and zip helpers.
 */
import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { genAidx } from "../../id/src/index.js";
import { IMPLEMENTED_ENDPOINTS } from "./registry.js";
import { makeFixture, withDohMx, type Fixture } from "./pglite-fixture.js";
import { withHyperdriveClient, type PgQueryable } from "./pg.js";

const withHyperdriveClientForTest = <T>(fx: Fixture, fn: (c: PgQueryable) => Promise<T>) => withHyperdriveClient(fx.env.HYPERDRIVE!, fn);
import { aggregateRetentionPg } from "./misc-pg.js";
import { parseFeed } from "./rss.js";
import { buildZip, readZip } from "./zip.js";
import type { ApiEnv } from "./env.js";
import { ENDPOINT_PARAM_DEFS } from "./endpoint-params.gen.js";

let f: Fixture;
before(async () => {
  f = await makeFixture("MiscTest", { AP_FETCH: withDohMx() });
});

const E = (r: { data: any }) => r.data?.error?.id;
const rows = async (sql: string, p: unknown[] = []) => (await f.db.query(sql, p)).rows as any[];

const RSS = `<?xml version="1.0"?><rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:atom="http://www.w3.org/2005/Atom">
<channel><title>Example &amp; Co</title><link>https://ex.example/</link><description>d</description>
<atom:link rel="self" href="https://ex.example/feed.xml"/>
<item><title>First</title><link>https://ex.example/1</link><guid>g1</guid><pubDate>Tue, 01 Oct 2024 10:00:00 GMT</pubDate>
<dc:creator>alice</dc:creator><description><![CDATA[<p>Hello <b>world</b></p>]]></description><category>a</category><category>b</category>
<enclosure url="https://ex.example/a.mp3" length="10" type="audio/mpeg"/></item>
<item><title>Second</title><link>https://ex.example/2</link></item></channel></rss>`;

const ATOM = `<feed xmlns="http://www.w3.org/2005/Atom"><title>Atom feed</title><link href="https://a.example/"/><link rel="self" href="https://a.example/atom"/>
<entry><title>E1</title><link href="https://a.example/e1"/><id>urn:1</id><updated>2024-10-01T00:00:00Z</updated><author><name>bob</name></author>
<summary>sum</summary><content type="html">&lt;p&gt;Body&lt;/p&gt;</content></entry></feed>`;

describe("misc endpoints", () => {
  it("registers endpoints", () => {
    for (const e of ["announcements/show", "my/apps", "users/recommendation", "users/get-frequently-replied-users", "users/get-following-users-by-birthday",
      "notes", "users", "retention", "page-push", "email-address/available", "server-info", "test", "reset-db", "fetch-rss", "fetch-external-resources"]) {
      assert.ok((IMPLEMENTED_ENDPOINTS as readonly string[]).includes(e), e);
      assert.ok(ENDPOINT_PARAM_DEFS[e], e);
    }
  });

  it("announcements/show", async () => {
    await f.db.query(`INSERT INTO announcement (id, title, text) VALUES ('an1', 't', 'x'), ('an2', 'mine', 'y')`);
    await f.db.query(`UPDATE announcement SET "userId" = $1 WHERE id = 'an2'`, [f.ids.b]);
    await f.db.query(`INSERT INTO announcement_read (id, "userId", "announcementId") VALUES ('r1', $1, 'an1')`, [f.ids.a]);
    assert.equal((await f.call("announcements/show", { announcementId: "an1" })).data.isRead, undefined);
    assert.equal((await f.call("announcements/show", { announcementId: "an1" }, "a")).data.isRead, true);
    assert.equal((await f.call("announcements/show", { announcementId: "an2" }, "b")).data.forYou, true);
    assert.equal(E(await f.call("announcements/show", { announcementId: "an2" }, "a")), "b57b5e1d-4f49-404a-9edb-46b00268f121");
    assert.equal(E(await f.call("announcements/show", { announcementId: "nope" })), "b57b5e1d-4f49-404a-9edb-46b00268f121");
  });

  it("my/apps", async () => {
    await f.db.query(`INSERT INTO app (id, "userId", secret, name, description, permission) VALUES ('app1', $1, 's', 'A', '', '{read:account}'), ('app2', $2, 's', 'B', '', '{}')`, [f.ids.a, f.ids.b]);
    await f.db.query(`INSERT INTO access_token (id, "userId", "appId", token, hash) VALUES ('t1', $1, 'app1', 'tok', 'tok')`, [f.ids.a]);
    assert.deepEqual((await f.call("my/apps", {}, "a")).data, [{ id: "app1", name: "A", callbackUrl: null, permission: ["read:account"], isAuthorized: true }]);
  });

  it("users/recommendation, users, users/get-following-users-by-birthday", async () => {
    await f.db.query(`UPDATE "user" SET "updatedAt" = now(), "followersCount" = 5 WHERE id = $1`, [f.ids.b]);
    await f.db.query(`UPDATE "user" SET "updatedAt" = now(), "followersCount" = 9 WHERE id = $1`, [f.ids.c]);
    // upstream bug kept: the query references `note` without joining it → always INTERNAL_ERROR
    assert.equal((await f.call("users/recommendation", {}, "a")).status, 500);
    await f.db.query(`INSERT INTO following (id, "followerId", "followeeId") VALUES ('fw1', $1, $2), ('fw2', $1, $3)`, [f.ids.a, f.ids.c, f.ids.b]);
    assert.deepEqual((await f.call("users", { sort: "+follower" })).data.map((u: any) => u.id), [f.ids.c, f.ids.b, f.ids.a]);
    assert.deepEqual((await f.call("users", { origin: "remote" })).data, []);
    await f.db.query(`INSERT INTO muting (id, "muterId", "muteeId") VALUES ('m1', $1, $2)`, [f.ids.a, f.ids.c]);
    assert.deepEqual((await f.call("users", {}, "a")).data.map((u: any) => u.id), [f.ids.a, f.ids.b]);
    await f.db.query(`DELETE FROM muting WHERE id = 'm1'`);

    const now = new Date();
    const mmdd = (d: Date) => `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    await f.db.query(`UPDATE user_profile SET birthday = $2 WHERE "userId" = $1`, [f.ids.b, `1990-${mmdd(now)}`]);
    await f.db.query(`UPDATE user_profile SET birthday = '2000-01-01' WHERE "userId" = $1`, [f.ids.c]);
    const today = (await f.call("users/get-following-users-by-birthday", { birthday: { month: now.getMonth() + 1, day: now.getDate() } }, "a")).data;
    assert.deepEqual(today.map((x: any) => [x.id, x.user.id]), [[f.ids.b, f.ids.b]]);
    assert.equal(today[0].birthday, `${now.getFullYear()}-${mmdd(now)}`);
    const range = (await f.call("users/get-following-users-by-birthday", { birthday: { begin: { month: 12, day: 1 }, end: { month: 1, day: 31 } } }, "a")).data;
    assert.deepEqual(range.map((x: any) => x.id).includes(f.ids.c), true);
    assert.equal((await f.call("users/get-following-users-by-birthday", { birthday: { month: 13, day: 1 } }, "a")).status, 400);
  });

  it("users/get-frequently-replied-users, notes", async () => {
    const tb = await f.note(f.ids.b, { text: "b1" });
    const tb2 = await f.note(f.ids.b, { text: "b2" });
    const tc = await f.note(f.ids.c, { text: "c1" });
    for (const r of [tb, tb2, tc]) await f.note(f.ids.a, { text: "re", replyId: r });
    const fr = (await f.call("users/get-frequently-replied-users", { userId: f.ids.a })).data;
    assert.deepEqual(fr.map((x: any) => [x.user.id, x.weight]), [[f.ids.b, 1], [f.ids.c, 0.5]]);
    assert.equal(E(await f.call("users/get-frequently-replied-users", { userId: "nope" })), "e6965129-7b2a-40a4-bae2-cd84cd434822");

    const all = (await f.call("notes", { limit: 100 })).data;
    assert.ok(all.length >= 6);
    assert.ok((await f.call("notes", { reply: true })).data.every((n: any) => n.replyId));
    await f.db.query(`UPDATE meta SET "ugcVisibilityForVisitor" = 'none'`);
    assert.deepEqual((await f.call("notes", {})).data, []);
    assert.ok((await f.call("notes", {}, "a")).data.length > 0);
    await f.db.query(`UPDATE meta SET "ugcVisibilityForVisitor" = 'all'`);
  });

  it("retention aggregation", async () => {
    const day1 = new Date(Date.now() - 2 * 24 * 3600_000);
    assert.equal(await aggregateRetentionPg(f.env, day1), true);
    assert.equal(await aggregateRetentionPg(f.env, day1), false); // same day
    await f.db.query(`UPDATE "user" SET "lastActiveDate" = now()`);
    await f.db.query(`UPDATE retention_aggregation SET "userIds" = $1`, [[f.ids.a, f.ids.b]]);
    assert.equal(await aggregateRetentionPg(f.env), true);
    const r = (await f.call("retention", {})).data;
    assert.equal(r.length, 2);
    const older = r[1];
    assert.deepEqual(Object.values(older.data), [2]);
  });

  it("email-address/available, test, server-info, reset-db", async () => {
    assert.deepEqual((await f.call("email-address/available", { emailAddress: "x" })).data, { available: false, reason: "format" });
    await f.db.query(`UPDATE user_profile SET email = 'used@ex.example', "emailVerified" = TRUE WHERE "userId" = $1`, [f.ids.a]);
    assert.deepEqual((await f.call("email-address/available", { emailAddress: "used@ex.example" })).data, { available: false, reason: "used" });
    await f.db.query(`UPDATE meta SET "bannedEmailDomains" = '{spam.example}'`);
    assert.deepEqual((await f.call("email-address/available", { emailAddress: "a@mail.spam.example" })).data, { available: false, reason: "banned" });
    assert.deepEqual((await f.call("email-address/available", { emailAddress: "new@ok.example" })).data, { available: true, reason: null });
    // deep-email-validator (no verifymail / truemail configured): disposable list, then MX over DoH
    assert.deepEqual((await f.call("email-address/available", { emailAddress: "a@0-180.com" })).data, { available: false, reason: "disposable" });
    const asked: string[] = [];
    const noMx = { ...f.env, AP_FETCH: withDohMx(undefined, ["nomx.example"]) } as ApiEnv;
    const { validateEmailForAccountPg } = await import("./misc-pg.js");
    const { deepEmailValidation, DOH_URL } = await import("./email.js");
    const viaPg = (email: string, env: ApiEnv) => withHyperdriveClientForTest(f, (c) => validateEmailForAccountPg(c, email, env));
    assert.deepEqual(await viaPg("a@nomx.example", noMx), { available: false, reason: "mx" });
    const spy = { ...f.env, AP_FETCH: (async (u: string, init?: RequestInit) => {
      asked.push(`${u} ${(init?.headers as Record<string, string>).Accept}`);
      return Response.json({ Status: 0, Answer: [{ type: 15 }] });
    }) as unknown as typeof fetch } as ApiEnv;
    assert.deepEqual(await deepEmailValidation(spy, "x@mail.ok.example"), { valid: true, reason: null });
    assert.deepEqual(asked, [`${DOH_URL}?name=mail.ok.example&type=MX application/dns-json`]);
    // NXDOMAIN, no MX answer, or a failing resolver count as no MX
    const answer = (body: unknown, status = 200) => ({ ...f.env, AP_FETCH: (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch }) as ApiEnv;
    assert.equal((await deepEmailValidation(answer({ Status: 3 }), "x@a.example")).reason, "mx");
    assert.equal((await deepEmailValidation(answer({ Status: 0, Answer: [{ type: 5 }] }), "x@a.example")).reason, "mx");
    assert.equal((await deepEmailValidation(answer({}, 500), "x@a.example")).reason, "mx");
    assert.equal((await deepEmailValidation(spy, "a b@x.example")).reason, "regex");
    assert.equal((await deepEmailValidation(spy, "x@localhost")).reason, "regex");
    // the disposable list matches whole domains, first to last entry (disposable-domains.txt)
    assert.equal((await deepEmailValidation(spy, "x@0-180.com")).reason, "disposable");
    assert.equal((await deepEmailValidation(spy, "x@zzzpush.icu")).reason, "disposable");
    assert.notEqual((await deepEmailValidation(spy, "x@sub.0-180.com")).reason, "disposable");
    assert.notEqual((await deepEmailValidation(spy, "x@0-180.co")).reason, "disposable");
    // only when enableActiveEmailValidation is on
    await f.db.query(`UPDATE meta SET "enableActiveEmailValidation" = FALSE`);
    assert.deepEqual(await viaPg("a@0-180.com", noMx), { available: true, reason: null });
    await f.db.query(`UPDATE meta SET "enableActiveEmailValidation" = TRUE`);
    assert.deepEqual((await f.call("test", { required: true })).data, { required: true, default: "hello", nullableDefault: "hello" });
    assert.deepEqual((await f.call("test", { required: false, nullableDefault: null, string: "s" })).data, { required: false, default: "hello", nullableDefault: null, string: "s" });
    assert.equal((await f.call("test", {})).status, 400);
    assert.equal((await f.call("server-info", {})).data.machine, "?");
    assert.equal((await f.call("reset-db", {})).status, 500);
  });

  it("page-push requires an existing page", async () => {
    assert.equal(E(await f.call("page-push", { pageId: "nope", event: "e" }, "a")), "4a13ad31-6729-46b4-b9af-e86b265c2e74");
    await f.db.query(`INSERT INTO page (id, "updatedAt", title, name, "alignCenter", font, "userId", visibility) VALUES ('pg1', now(), 't', 'n', false, 'sans-serif', $1, 'public')`, [f.ids.b]);
    assert.equal((await f.call("page-push", { pageId: "pg1", event: "e", var: 1 }, "a")).status, 204);
  });

  it("fetch-rss / fetch-external-resources (mocked fetch)", async () => {
    const env = { ...f.env, AP_FETCH: (async (u: string) => {
      if (u.includes("rss")) return new Response(RSS, { headers: { "content-type": "application/rss+xml" } });
      if (u.includes("atom")) return new Response(ATOM);
      if (u.includes("ext")) return Response.json({ type: "theme", data: "line1\r\nline2" });
      return new Response("nope", { status: 404 });
    }) as typeof fetch } as ApiEnv;
    const { handlers } = await import("./endpoints/index.js");
    const call = async (name: string, body: Record<string, unknown>, tok?: string) => {
      const r = await handlers[name]!(env, tok ? { ...body, i: tok } : body, { hasCredential: !!tok, request: new Request("https://api.test/api/" + name, { method: "POST" }) });
      return r instanceof Response ? { status: r.status, data: await r.json() } : { status: 200, data: r as any };
    };
    const rss = (await call("fetch-rss", { url: "https://ex.example/rss" })).data;
    assert.equal(rss.title, "Example & Co");
    assert.equal(rss.feedUrl, "https://ex.example/feed.xml");
    assert.equal(rss.items.length, 2);
    assert.deepEqual(
      [rss.items[0].title, rss.items[0].link, rss.items[0].creator, rss.items[0].contentSnippet, rss.items[0].isoDate, rss.items[0].categories, rss.items[0].enclosure],
      ["First", "https://ex.example/1", "alice", "Hello world", "2024-10-01T10:00:00.000Z", ["a", "b"], { url: "https://ex.example/a.mp3", length: 10, type: "audio/mpeg" }],
    );
    const atom = (await call("fetch-rss", { url: "https://a.example/atom" })).data;
    assert.deepEqual([atom.title, atom.link, atom.items[0].link, atom.items[0].author, atom.items[0].content, atom.items[0].contentSnippet], ["Atom feed", "https://a.example/", "https://a.example/e1", "bob", "<p>Body</p>", "Body"]);
    assert.equal((await call("fetch-rss", { url: "ftp://x" })).data.error.id, "89b7ee05-ccfc-4bdd-9b13-61172fd1e06c");
    assert.equal((await call("fetch-rss", { url: "https://x.example/404" })).status, 422);

    const digest = await crypto.subtle.digest("SHA-512", new TextEncoder().encode("line1\nline2"));
    const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    assert.deepEqual((await call("fetch-external-resources", { url: "https://e.example/ext", hash }, "aaaaaaaaaaaaaaaa")).data, { type: "theme", data: "line1\r\nline2" });
    assert.equal((await call("fetch-external-resources", { url: "https://e.example/ext", hash: "00" }, "aaaaaaaaaaaaaaaa")).data.error.id, "693ba8ba-b486-40df-a174-72f8279b56a4");
  });

  it("zip: build → read (stored) and read a deflated entry", async () => {
    const enc = new TextEncoder();
    const z = buildZip([{ name: "meta.json", data: enc.encode('{"a":1}') }, { name: "x/y.png", data: new Uint8Array([1, 2, 3]) }]);
    const entries = readZip(z);
    assert.deepEqual(entries.map((e) => e.name), ["meta.json", "x/y.png"]);
    assert.equal(new TextDecoder().decode(await entries[0]!.read()), '{"a":1}');
    // patch a deflated entry in: compress with CompressionStream and rebuild headers by hand
    const raw = enc.encode("hello hello hello hello");
    const comp = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream("deflate-raw"))).arrayBuffer());
    const stored = buildZip([{ name: "h.txt", data: comp }]);
    const v = new DataView(stored.buffer);
    v.setUint16(8, 8, true); // local: method deflate
    v.setUint32(22, raw.length, true);
    const cd = 30 + 5 + comp.length;
    v.setUint16(cd + 10, 8, true); // central: method deflate
    v.setUint32(cd + 24, raw.length, true);
    assert.equal(new TextDecoder().decode(await readZip(stored)[0]!.read()), "hello hello hello hello");
    assert.throws(() => readZip(new Uint8Array(10)));
    void genAidx;
    void rows;
    void parseFeed;
  });
});
