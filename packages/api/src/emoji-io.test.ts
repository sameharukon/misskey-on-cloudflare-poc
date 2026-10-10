/**
 * Custom emoji export / import / copy and v2/admin/emoji/list on PG (PGlite, fake R2, mocked
 * remote fetch, real NotificationBox): zip + meta.json (metaVersion 2), exportCompleted,
 * import replacing same-name emojis in bounded steps, user-less drive files, error ids, filters.
 */
import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { NotificationBox } from "../../timeline/src/index.js";
import { IMPLEMENTED_ENDPOINTS } from "./registry.js";
import { fakeDoNamespace, makeFixture, type Fixture } from "./pglite-fixture.js";
import { handleApQueueBatch } from "./index.js";
import { readZip, buildZip } from "./zip.js";
import { runImportCustomEmojis, setImportBatchForTest } from "./emoji-io-pg.js";
import type { ApiEnv } from "./env.js";
import { ENDPOINT_PARAM_DEFS } from "./endpoint-params.gen.js";

const objects = new Map<string, Uint8Array>();
const bucket = {
  put: async (key: string, v: Uint8Array) => void objects.set(key, v),
  get: async (key: string) => {
    const v = objects.get(key);
    return v ? { arrayBuffer: async () => v.slice().buffer, httpMetadata: {} } : null;
  },
  delete: async () => {},
};

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 2, 0, 0, 0, 3, 8, 6, 0, 0, 0, 1, 2, 3, 4]);
const GIF = new TextEncoder().encode("GIF89a-remote-image");
const REMOTE: Record<string, Uint8Array> = { "https://cdn.remote.example/x.gif": GIF, "https://remote.example/files/rcat.png": PNG };
const apFetch = (async (input: RequestInfo | URL) => {
  const body = REMOTE[String(input)];
  return body ? new Response(body.slice()) : new Response("nope", { status: 404 });
}) as typeof fetch;

let f: Fixture;
const OWN = "https://misskey.example.com/files/";
async function emoji(id: string, name: string, fields: Record<string, unknown> = {}) {
  const row = { id, name, "originalUrl": `${OWN}k-${name}`, "publicUrl": `${OWN}k-${name}`, type: "image/png", "updatedAt": new Date().toISOString(), ...fields };
  const cols = Object.keys(row);
  await f.db.query(`INSERT INTO emoji (${cols.map((c) => `"${c}"`).join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")})`, Object.values(row));
}

before(async () => {
  f = await makeFixture("EmojiIoTest", {
    MEDIA_BUCKET: bucket as unknown as ApiEnv["MEDIA_BUCKET"],
    NOTIFICATION_BOX: fakeDoNamespace((s) => new NotificationBox(s as never)) as unknown as ApiEnv["NOTIFICATION_BOX"],
    AP_FETCH: apFetch,
  });
  objects.set("drive/k-blob", PNG);
  await emoji("e1", "blob", { aliases: ["b1", "round"], category: "faces", license: "CC0" });
  await emoji("e2", "remote_img", { originalUrl: "https://cdn.remote.example/x.gif", publicUrl: "https://cdn.remote.example/x.gif", type: "image/gif", isSensitive: true });
  await emoji("e3", "bad-name");
  await emoji("e4", "missing");
  await emoji("e5", "rcat", { host: "remote.example", originalUrl: "https://remote.example/files/rcat.png", publicUrl: "https://remote.example/files/rcat.png", aliases: ["cat"] });
  await emoji("e6", "rgone", { host: "remote.example", originalUrl: "https://remote.example/files/gone.png", publicUrl: "https://remote.example/files/gone.png" });
});

describe("custom emoji import / export", () => {
  let zipFileId = "";

  it("registers endpoints", () => {
    for (const e of ["export-custom-emojis", "admin/emoji/import-zip", "admin/emoji/copy", "v2/admin/emoji/list"]) {
      assert.ok((IMPLEMENTED_ENDPOINTS as readonly string[]).includes(e), e);
      assert.ok(ENDPOINT_PARAM_DEFS[e], e);
    }
  });

  it("export-custom-emojis: zip with meta.json v2 + images, exportCompleted", async () => {
    // `secure`: an anonymous call is ACCESS_DENIED before the credential check (upstream isSecure)
    assert.equal((await f.call("export-custom-emojis", {})).data.error.id, "56f35758-7dd5-468b-8439-5d6fb8ec9b8e");
    // like upstream, the zip goes through the user's drive policies (application/zip is not in the
    // default uploadableFileTypes), so a plain user's export produces no file
    assert.equal((await f.call("export-custom-emojis", {}, "b")).status, 204);
    assert.equal((await f.db.query(`SELECT * FROM drive_file WHERE "userId" = $1`, [f.ids.b])).rows.length, 0);
    const r = await f.call("export-custom-emojis", {}, "a");
    assert.equal(r.status, 204, JSON.stringify(r.data));
    const row = (await f.db.query(`SELECT * FROM drive_file WHERE "userId" = $1 ORDER BY id DESC LIMIT 1`, [f.ids.a])).rows[0] as any;
    assert.match(row.name, /^custom-emojis-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.zip$/);
    assert.equal(row.type, "application/zip");
    zipFileId = row.id;
    const entries = readZip(objects.get(`drive/${row.accessKey}`)!);
    assert.deepEqual(entries.map((e) => e.name).sort(), ["blob.png", "meta.json", "remote_img.gif"]);
    const meta = JSON.parse(new TextDecoder().decode(await entries.find((e) => e.name === "meta.json")!.read()));
    assert.equal(meta.metaVersion, 2);
    assert.equal(meta.host, "misskey.example.com");
    assert.equal(typeof meta.exportedAt, "string");
    assert.deepEqual(meta.emojis.map((x: any) => [x.fileName, x.downloaded]), [["blob.png", true], ["remote_img.gif", true], ["missing.png", false]]);
    const blob = meta.emojis[0].emoji;
    assert.deepEqual(Object.keys(blob), ["id", "updatedAt", "name", "host", "category", "originalUrl", "publicUrl", "uri", "type", "aliases", "license", "localOnly", "isSensitive", "roleIdsThatCanBeUsedThisEmojiAsReaction"]);
    assert.deepEqual([blob.name, blob.aliases, blob.category, blob.license], ["blob", ["b1", "round"], "faces", "CC0"]);
    assert.deepEqual(await entries.find((e) => e.name === "blob.png")!.read(), PNG);
    assert.deepEqual(await entries.find((e) => e.name === "remote_img.gif")!.read(), GIF);
    const n = (await f.call("i/notifications", {}, "a")).data.find((x: any) => x.type === "exportCompleted");
    assert.deepEqual([n.exportedEntity, n.fileId], ["customEmoji", row.id]);
  });

  it("admin/emoji/import-zip: admin only, replaces same-name local emojis, user-less files", async () => {
    assert.equal((await f.call("admin/emoji/import-zip", { fileId: zipFileId }, "b")).status, 403);
    assert.equal((await f.call("admin/emoji/import-zip", {}, "a")).status, 400);
    await f.db.query(`UPDATE emoji SET category = 'old' WHERE name = 'blob'`);
    await f.db.query(`DELETE FROM emoji WHERE name = 'remote_img'`);
    const r = await f.call("admin/emoji/import-zip", { fileId: zipFileId }, "a");
    assert.equal(r.status, 204, JSON.stringify(r.data));
    const rows = (await f.db.query(`SELECT * FROM emoji WHERE host IS NULL ORDER BY name`)).rows as any[];
    assert.deepEqual(rows.map((x) => x.name), ["bad-name", "blob", "missing", "remote_img"]);
    const blob = rows.find((x) => x.name === "blob");
    assert.notEqual(blob.id, "e1");
    assert.deepEqual([blob.category, blob.aliases, blob.license, blob.type], ["faces", ["b1", "round"], "CC0", "image/png"]);
    const img = rows.find((x) => x.name === "remote_img");
    assert.equal(img.isSensitive, true);
    assert.equal(img.type, "image/gif");
    assert.ok(img.originalUrl.startsWith(OWN));
    const file = (await f.db.query(`SELECT * FROM drive_file WHERE url = $1`, [img.originalUrl])).rows[0] as any;
    assert.equal(file.userId, null);
    assert.equal(file.name, "remote_img.gif");
    assert.deepEqual(objects.get(`drive/${file.accessKey}`), GIF);
    // missing.png was not downloaded → the existing row is kept
    assert.equal(rows.find((x) => x.name === "missing").id, "e4");
  });

  it("import runs in bounded steps (mk-jobs follow-up with a cursor) and skips a zip without meta.json", async () => {
    setImportBatchForTest(1);
    try {
      const job = { kind: "importCustomEmojis" as const, userId: f.ids.a, fileId: zipFileId };
      const next = await runImportCustomEmojis(f.env, job);
      assert.deepEqual(next, { ...job, cursor: 1 });
      assert.equal(await runImportCustomEmojis(f.env, next!), null);
      const results = await handleApQueueBatch({ queue: "mk-jobs", messages: [{ body: job, ack: () => {}, retry: () => assert.fail("retry") }] } as never, f.env);
      assert.deepEqual(results.results, ["continued:importCustomEmojis"]);
    } finally {
      setImportBatchForTest(20);
    }
    objects.set("drive/nometa", buildZip([{ name: "x.png", data: PNG }]));
    await f.db.query(`INSERT INTO drive_file (id, "userId", type, name, url, "accessKey", md5, size, "storedInternal") VALUES ('nometa', $1, 'application/zip', 'x.zip', $2, 'nometa', '0', 0, FALSE)`, [f.ids.a, `${OWN}nometa`]);
    const before = Number(((await f.db.query(`SELECT count(*)::int AS n FROM emoji`)).rows[0] as any).n);
    assert.equal(await runImportCustomEmojis(f.env, { kind: "importCustomEmojis", userId: f.ids.a, fileId: "nometa" }), null);
    assert.equal(await runImportCustomEmojis(f.env, { kind: "importCustomEmojis", userId: f.ids.a, fileId: "nope" }), null);
    assert.equal(Number(((await f.db.query(`SELECT count(*)::int AS n FROM emoji`)).rows[0] as any).n), before);
  });

  it("admin/emoji/copy: role policy, download into a user-less file, error ids, moderation log", async () => {
    assert.equal((await f.call("admin/emoji/copy", { emojiId: "e5" }, "c")).data.error.id, "7f86f06f-7e15-4057-8561-f4b6d4ac755a");
    await f.setPolicy(f.ids.b, "canManageCustomEmojis", true);
    const r = await f.call("admin/emoji/copy", { emojiId: "e5" }, "b");
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.name, "rcat");
    assert.equal(r.data.host, null);
    assert.deepEqual(r.data.aliases, ["cat"]);
    assert.ok(r.data.url.startsWith(OWN));
    const file = (await f.db.query(`SELECT * FROM drive_file WHERE url = $1`, [r.data.url])).rows[0] as any;
    assert.equal(file.userId, null);
    assert.equal(file.type, "image/png");
    const log = (await f.db.query(`SELECT * FROM moderation_log WHERE type = 'addCustomEmoji' AND "userId" = $1`, [f.ids.b])).rows;
    assert.equal(log.length, 1);
    const dup = await f.call("admin/emoji/copy", { emojiId: "e5" }, "b");
    assert.equal(dup.data.error.id, "f7a3462c-4e6e-4069-8421-b9bd4f4c3975");
    assert.equal((await f.call("admin/emoji/copy", { emojiId: "nope" }, "b")).data.error.id, "e2785b66-dca3-4087-9cac-b93c541cc425");
    const gone = await f.call("admin/emoji/copy", { emojiId: "e6" }, "b");
    assert.equal(gone.status, 500);
    assert.equal(gone.data.error.code, "INTERNAL_ERROR");
    assert.equal((await f.call("admin/emoji/copy", {}, "b")).status, 400);
  });
});

describe("v2/admin/emoji/list", () => {
  before(async () => {
    await f.db.query(`INSERT INTO role (id, name, "displayOrder", description, "updatedAt", "lastUsedAt") VALUES ('rlo', 'Low', 1, '', now(), now()), ('rhi', 'High', 5, '', now(), now())`);
    await emoji("e7", "party_parrot", { category: "animals", aliases: ["parrot", "bird"], roleIdsThatCanBeUsedThisEmojiAsReaction: ["rlo", "rhi", "rolegone"], localOnly: true });
  });

  it("filters, sort keys, pagination and packDetailedAdmin", async () => {
    const all = await f.call("v2/admin/emoji/list", { limit: 100 }, "a");
    assert.equal(all.status, 200, JSON.stringify(all.data));
    const total = Number(((await f.db.query(`SELECT count(*)::int AS n FROM emoji`)).rows[0] as any).n);
    assert.equal(all.data.allCount, total);
    assert.equal(all.data.count, total);
    assert.deepEqual(all.data.emojis.map((e: any) => e.id), [...all.data.emojis.map((e: any) => e.id)].sort().reverse());

    const parrot = all.data.emojis.find((e: any) => e.name === "party_parrot");
    assert.deepEqual(Object.keys(parrot), ["id", "updatedAt", "name", "host", "uri", "type", "aliases", "category", "publicUrl", "originalUrl", "license", "localOnly", "isSensitive", "roleIdsThatCanBeUsedThisEmojiAsReaction"]);
    assert.deepEqual(parrot.roleIdsThatCanBeUsedThisEmojiAsReaction, [{ id: "rhi", name: "High" }, { id: "rlo", name: "Low" }]);

    const names = async (body: Record<string, unknown>) => (await f.call("v2/admin/emoji/list", { limit: 100, ...body }, "a")).data.emojis.map((e: any) => e.name);
    assert.deepEqual(await names({ query: { hostType: "remote" }, sortKeys: ["+name"] }), ["rcat", "rgone"]);
    assert.deepEqual(await names({ query: { hostType: "remote", host: "nothere" } }), []);
    // host is ignored unless hostType is remote (upstream)
    assert.ok((await names({ query: { host: "nothere" } })).length === total);
    assert.deepEqual(await names({ query: { hostType: "local", name: "parrot  blo" }, sortKeys: ["+name"] }), ["blob", "party_parrot"]);
    assert.deepEqual(await names({ query: { aliases: "bir" } }), ["party_parrot"]);
    assert.deepEqual(await names({ query: { category: "anim", localOnly: true } }), ["party_parrot"]);
    assert.deepEqual(await names({ query: { roleIds: ["rhi"] } }), ["party_parrot"]);
    assert.deepEqual(await names({ query: { name: "_" }, sortKeys: ["+name"] }), ["party_parrot", "remote_img"]);
    assert.deepEqual(await names({ query: { updatedAtFrom: "2000-01-01", updatedAtTo: "2000-01-02" } }), []);

    const p2 = (await f.call("v2/admin/emoji/list", { limit: 2, page: 2, sortKeys: ["+name"] }, "a")).data;
    assert.equal(p2.emojis.length, 2);
    assert.deepEqual([p2.count, p2.allCount, p2.allPages], [2, total, Math.ceil(total / 2)]);
    const sorted = [...all.data.emojis.map((e: any) => e.name)].sort();
    assert.deepEqual(p2.emojis.map((e: any) => e.name), sorted.slice(2, 4));

    const since = await names({ sinceId: "e5", sortKeys: ["+id"] });
    const expected = (await f.db.query(`SELECT name FROM emoji WHERE id > 'e5' ORDER BY id`)).rows.map((r: any) => r.name);
    assert.ok(expected.includes("party_parrot"));
    assert.deepEqual(since, expected);
  });

  it("validation and role gate", async () => {
    assert.equal((await f.call("v2/admin/emoji/list", { sortKeys: ["+nope"] }, "a")).status, 400);
    assert.equal((await f.call("v2/admin/emoji/list", { limit: 101 }, "a")).status, 400);
    assert.equal((await f.call("v2/admin/emoji/list", { query: { hostType: "x" } }, "a")).status, 400);
    assert.equal((await f.call("v2/admin/emoji/list", {}, "c")).status, 403);
    assert.equal((await f.call("v2/admin/emoji/list", {})).status, 401);
    assert.equal((await f.call("v2/admin/emoji/list", { query: null }, "a")).status, 200);
  });
});
