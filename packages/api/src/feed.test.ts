/**
 * `/@user.atom|rss|json` (upstream FeedService), MfmService.toHtml, and the gateway's SSR data (ssr-pg.ts).
 */
import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as mfm from "mfm-js";
import { genAidx } from "../../id/src/index.js";
import worker from "./index.js";
import { makeFixture, type Fixture } from "./pglite-fixture.js";
import { mfmToHtml } from "./mfm-html.js";

let f: Fixture;
const BASE = "https://misskey.example.com";
const ctx = { waitUntil() {}, passThroughOnException() {} };
const get = (path: string) => worker.fetch(new Request(`${BASE}${path}`), f.env, ctx);

before(async () => {
  f = await makeFixture("FeedTest");
  const b = f.ids.b;
  await f.db.query(`INSERT INTO drive_file (id, "userId", type, name, url, md5, size, "storedInternal") VALUES ('av', $1, 'image/png', 'av.png', 'https://cdn.example/av.png', '0', 0, FALSE)`, [b]);
  await f.db.query(`UPDATE "user" SET name = 'Bee', "notesCount" = 7, "followingCount" = 2, "followersCount" = 3, "avatarId" = 'av', "avatarUrl" = 'https://cdn.example/av.png' WHERE id = $1`, [b]);
  await f.db.query(`UPDATE user_profile SET description = 'hi there', "followingVisibility" = 'followers' WHERE "userId" = $1`, [b]);
  await f.db.query(`INSERT INTO drive_file (id, "userId", type, name, url, "webpublicUrl", md5, size, "storedInternal") VALUES ('fv', $1, 'video/mp4', 'v.mp4', 'https://cdn.example/v.mp4', NULL, '0', 0, FALSE), ('fi', $1, 'image/png', 'i.png', 'https://cdn.example/i.png', 'https://cdn.example/i.webp', '0', 0, FALSE)`, [b]);
  const t = Date.now() - 60_000;
  await f.db.query(`INSERT INTO note (id, "userId", text, visibility, "fileIds") VALUES ($1, $2, 'first **bold** #tag', 'public', '{fv,fi}')`, [genAidx(t), b]);
  await f.db.query(`INSERT INTO note (id, "userId", text, cw, visibility) VALUES ($1, $2, 'secret', 'CW!', 'home')`, [genAidx(t + 1000), b]);
  await f.db.query(`INSERT INTO note (id, "userId", text, visibility) VALUES ($1, $2, 'followers only', 'followers')`, [genAidx(t + 2000), b]);
  await f.db.query(`INSERT INTO note (id, "userId", "renoteId", visibility) VALUES ($1, $2, $3, 'public')`, [genAidx(t + 3000), b, genAidx(t)]);
});

describe("user feeds", () => {
  it("RSS / Atom / JSON with upstream's fields: 20 latest public / home non-renotes", async () => {
    const rss = await get("/@user_b.rss");
    assert.equal(rss.status, 200);
    assert.equal(rss.headers.get("content-type"), "application/rss+xml; charset=utf-8");
    const xml = await rss.text();
    assert.match(xml, /<title>Bee \(@user_b@misskey\.example\.com\)<\/title>/);
    assert.match(xml, /<description>7 Notes, \? Following, 3 Followers · hi there<\/description>/);
    assert.match(xml, /<generator>Misskey<\/generator>/);
    assert.match(xml, /https:\/\/cdn\.example\/av\.png/);
    assert.equal((xml.match(/<item>/g) ?? []).length, 2);
    assert.match(xml, /<b>bold<\/b> <a href="https:\/\/misskey\.example\.com\/tags\/tag" rel="tag">#tag<\/a>/);
    assert.match(xml, /https:\/\/cdn\.example\/i\.webp/); // the image file, webpublic URL
    assert.doesNotMatch(xml, /followers only/);

    const atom = await get("/@user_b.atom");
    assert.equal(atom.headers.get("content-type"), "application/atom+xml; charset=utf-8");
    assert.match(await atom.text(), /<feed xmlns="http:\/\/www\.w3\.org\/2005\/Atom">/);

    const json = (await (await get("/@USER_B.json")).json()) as { title: string; feed_url: string; items: { summary?: string; title: string }[] };
    assert.equal(json.title, "Bee (@user_b@misskey.example.com)");
    assert.equal(json.feed_url, `${BASE}/@user_b.json`);
    assert.deepEqual(json.items.map((i) => [i.title, i.summary]), [["New note by Bee", "CW!"], ["New note by Bee", undefined]]);
  });

  it("404 for unknown, suspended, sign-in-only and (ugcVisibilityForVisitor) hidden users", async () => {
    assert.equal((await get("/@nobody.rss")).status, 404);
    await f.db.query(`UPDATE "user" SET "isSuspended" = TRUE WHERE id = $1`, [f.ids.c]);
    assert.equal((await get("/@user_c.rss")).status, 404);
    await f.db.query(`UPDATE "user" SET "isSuspended" = FALSE, "requireSigninToViewContents" = TRUE WHERE id = $1`, [f.ids.c]);
    assert.equal((await get("/@user_c.rss")).status, 404);
    await f.db.query(`UPDATE meta SET "ugcVisibilityForVisitor" = 'none'`);
    assert.equal((await get("/@user_b.rss")).status, 404);
    await f.db.query(`UPDATE meta SET "ugcVisibilityForVisitor" = 'local', federation = 'all'`);
    // remote users only with ugcVisibilityForVisitor = all
    await f.db.query(`INSERT INTO "user" (id, username, "usernameLower", host) VALUES ('r1', 'rem', 'rem', 'remote.example')`);
    await f.db.query(`INSERT INTO user_profile ("userId") VALUES ('r1')`);
    assert.equal((await get("/@rem@remote.example.rss")).status, 404);
    await f.db.query(`UPDATE meta SET "ugcVisibilityForVisitor" = 'all'`);
    const r = await get("/@rem@remote.example.rss");
    assert.equal(r.status, 200);
    assert.match(await r.text(), /identicon\/rem@remote\.example/); // no avatar → identicon
  });
});

describe("MfmService.toHtml", () => {
  const html = (text: string, remotes: Parameters<typeof mfmToHtml>[2] = []) => mfmToHtml(mfm.parse(text), BASE, remotes);
  it("renders each node type as upstream", () => {
    assert.equal(html("a\nb <c>"), "a<br />b &lt;c&gt;");
    assert.equal(html("**b** <small>s</small> ~~x~~ <i>i</i>"), "<b>b</b> <small>s</small> <del>x</del> <i>i</i>");
    assert.equal(html("`c`"), "<code>c</code>");
    assert.equal(html("```\nblock\n```"), "<pre><code>block</code></pre>");
    assert.equal(html("<center>m</center>"), '<div style="text-align: center;">m</div>');
    assert.equal(html(":blob: 😀"), "​:blob:​ 😀");
    assert.equal(html("https://ex.example/a?b=1&c=2"), '<a href="https://ex.example/a?b=1&amp;c=2">https://ex.example/a?b=1&amp;c=2</a>');
    assert.equal(html("[label](https://ex.example)"), '<a href="https://ex.example/">label</a>');
    assert.equal(html("@alice"), `<a href="${BASE}/@alice" class="u-url mention">@alice</a>`);
    assert.equal(html("@bob@remote.example", [{ uri: "https://remote.example/users/1", url: "https://remote.example/@bob", username: "Bob", host: "REMOTE.example" }]), '<a href="https://remote.example/@bob" class="u-url mention">@bob@remote.example</a>');
    assert.equal(html("> q"), "<blockquote>q</blockquote>");
    assert.equal(html("$[unixtime 0]"), '<time datetime="1970-01-01T00:00:00.000Z">1970-01-01T00:00:00.000Z</time>');
    assert.equal(html("$[ruby 漢字 かんじ]"), "<ruby>漢字<rp>(</rp><rt>かんじ</rt><rp>)</rp></ruby>");
    assert.equal(html("$[spin x]"), "<i>x</i>");
    assert.equal(html("misskey 検索"), `<a href="https://www.google.com/search?q=misskey">misskey 検索</a>`);
    assert.equal(html("<plain>**x**</plain>"), "<span>**x**</span>");
    assert.equal(mfmToHtml(null, BASE), null);
  });
  it("links only to http(s): a remote user's url / uri with another scheme is left as text", () => {
    assert.equal(html("@bob@remote.example", [{ uri: "javascript:alert(1)", url: "javascript:alert(1)", username: "bob", host: "remote.example" }]), "@bob@remote.example");
    assert.equal(html("@bob@remote.example", [{ uri: "data:text/html,x", username: "bob", host: "remote.example" }]), "@bob@remote.example");
  });
});

describe("SSR data for the gateway (ApiInternal ssrUser / ssrNote)", () => {
  it("packs the user / note with the profile's page fields and the visitor rules", async () => {
    const { ssrUser, ssrNote } = await import("./ssr-pg.js");
    await f.db.query(`UPDATE meta SET "ugcVisibilityForVisitor" = 'local', federation = 'all'`);
    await f.db.query(`UPDATE user_profile SET "noCrawle" = TRUE, fields = '[{"name":"w","value":"https://b.example"}]', url = 'https://b.example' WHERE "userId" = $1`, [f.ids.b]);
    const u = await ssrUser(f.env, "@USER_B");
    assert.equal(u!.user.id, f.ids.b);
    assert.equal(u!.user.username, "user_b");
    assert.deepEqual(u!.profile, { noCrawle: true, preventAiLearning: true, fields: [{ name: "w", value: "https://b.example" }], url: "https://b.example" });
    assert.equal(u!.federationEnabled, true);
    assert.equal(await ssrUser(f.env, "nobody"), null);
    assert.equal(await ssrUser(f.env, "rem@remote.example"), null); // remote + ugcVisibilityForVisitor local
    await f.db.query(`UPDATE meta SET "ugcVisibilityForVisitor" = 'all', federation = 'none'`);
    assert.equal((await ssrUser(f.env, "rem@remote.example"))!.federationEnabled, false);

    const id = genAidx(Date.now() - 1000);
    await f.db.query(`INSERT INTO note (id, "userId", text, visibility) VALUES ($1, $2, 'ssr', 'public'), ($3, $2, 'f', 'followers')`, [id, f.ids.b, genAidx(Date.now() - 500)]);
    const n = await ssrNote(f.env, id);
    assert.equal(n!.note.text, "ssr");
    assert.equal((n!.note.user as { username: string }).username, "user_b");
    assert.equal(n!.profile.noCrawle, true);
    const followersOnly = (await f.db.query(`SELECT id FROM note WHERE text = 'f'`)).rows[0] as { id: string };
    assert.equal(await ssrNote(f.env, followersOnly.id), null);
    await f.db.query(`UPDATE "user" SET "requireSigninToViewContents" = TRUE WHERE id = $1`, [f.ids.b]);
    assert.equal(await ssrNote(f.env, id), null);
    await f.db.query(`UPDATE "user" SET "requireSigninToViewContents" = FALSE WHERE id = $1`, [f.ids.b]);
    await f.db.query(`UPDATE meta SET "ugcVisibilityForVisitor" = 'none'`);
    assert.equal(await ssrNote(f.env, id), null);
    assert.equal(await ssrUser(f.env, "user_b"), null);
  });
});

describe("SSR data for the other entity pages and embeds (ApiInternal ssrEntity)", () => {
  it("packs each entity with upstream's lookup rules", async () => {
    const { ssrEntity } = await import("./ssr-pg.js");
    const b = f.ids.b;
    await f.db.query(`UPDATE meta SET "ugcVisibilityForVisitor" = 'all'`); // an earlier test left 'none' (the packer hides note bodies then)
    await f.db.query(`UPDATE "user" SET "isSuspended" = FALSE, "requireSigninToViewContents" = FALSE WHERE id = $1`, [b]);
    await f.db.query(`INSERT INTO page (id, "updatedAt", title, name, summary, "alignCenter", font, "userId", visibility) VALUES ('pg1', now(), 'Page T', 'hello', 'sum', false, 'sans-serif', $1, 'followers')`, [b]);
    await f.db.query(`INSERT INTO flash (id, "updatedAt", title, summary, "userId", script, visibility) VALUES ('fl1', now(), 'Play', 'fun', $1, '', 'private')`, [b]);
    await f.db.query(`INSERT INTO clip (id, "userId", name, description, "isPublic") VALUES ('cl1', $1, 'Pub', 'd', TRUE), ('cl2', $1, 'Priv', NULL, FALSE)`, [b]);
    await f.db.query(`INSERT INTO gallery_post (id, "updatedAt", title, "userId") VALUES ('gp1', now(), 'Pics', $1)`, [b]);
    await f.db.query(`INSERT INTO channel (id, "userId", name) VALUES ('ch1', $1, 'Chan')`, [b]);
    await f.db.query(`INSERT INTO reversi_game (id, "user1Id", "user2Id", map, bw) VALUES ('rg1', $1, $2, '{}', 'random')`, [b, f.ids.c]);
    await f.db.query(`INSERT INTO announcement (id, title, text) VALUES ('an1', 'News', 'body'), ('an2', 'Mine', 'x')`);
    await f.db.query(`UPDATE announcement SET "userId" = $1 WHERE id = 'an2'`, [b]);

    const page = await ssrEntity(f.env, "page", "user_b", "hello");
    assert.deepEqual([page!.entity.title, page!.entity.summary, (page!.entity.user as { username: string }).username, page!.visibility], ["Page T", "sum", "user_b", "followers"]);
    assert.equal(page!.profile!.noCrawle, true);
    assert.equal(await ssrEntity(f.env, "page", "user_b", "nope"), null);
    assert.equal(await ssrEntity(f.env, "page", "ghost", "hello"), null);
    assert.equal((await ssrEntity(f.env, "flash", "fl1"))!.entity.title, "Play"); // upstream renders any flash
    assert.equal((await ssrEntity(f.env, "clip", "cl1"))!.entity.name, "Pub");
    assert.equal(await ssrEntity(f.env, "clip", "cl2"), null); // private clips: base HTML
    assert.equal((await ssrEntity(f.env, "embedClip", "cl2"))!.entity.name, "Priv"); // the embed does not check, as upstream
    assert.equal((await ssrEntity(f.env, "galleryPost", "gp1"))!.entity.title, "Pics");
    assert.equal((await ssrEntity(f.env, "channel", "ch1"))!.entity.name, "Chan");
    assert.deepEqual((await ssrEntity(f.env, "reversiGame", "rg1"))!.entity, { id: "rg1", user1: { username: "user_b" }, user2: { username: "user_c" } });
    assert.equal((await ssrEntity(f.env, "announcement", "an1"))!.entity.title, "News");
    assert.equal(await ssrEntity(f.env, "announcement", "an2"), null); // per-user announcements are not public

    assert.equal((await ssrEntity(f.env, "embedUser", b))!.entity.username, "user_b");
    assert.equal(await ssrEntity(f.env, "embedUser", "r1"), null); // remote
    const pub = genAidx(Date.now() - 100);
    const fo = genAidx(Date.now() - 50);
    await f.db.query(`INSERT INTO note (id, "userId", text, visibility) VALUES ($1, $3, 'e', 'home'), ($2, $3, 'f', 'followers')`, [pub, fo, b]);
    assert.equal((await ssrEntity(f.env, "embedNote", pub))!.entity.text, "e");
    assert.equal(await ssrEntity(f.env, "embedNote", fo), null);
    assert.equal(await ssrEntity(f.env, "bogus", "x"), null);
  });
});
