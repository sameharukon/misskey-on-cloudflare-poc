/**
 * Drive on PG (PGlite) + fake R2 + fake media container: upload (multipart via
 * the router), dedupe, policies/capacity, folders, update/delete, serving with
 * Range/ETag, note attachment, and the pure media helpers.
 */
import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { genAidx } from "../../id/src/index.js";
import { fixtureMeta } from "../../packers/src/fixtures.js";
import type { ApiEnv } from "./env.js";
import type { PgQueryable } from "./pg.js";
import { dispatchApi } from "./router.js";
import { DRIVE_ALTS_RETRY_DELAY_SEC, DRIVE_ENDPOINTS, packDriveFile, parseR2Range, runDriveAltsJob, serveDriveFile, setAltsTimeoutForTest, thumbnailUrlOf } from "./drive-pg.js";
import { combinePolicies } from "./policies-pg.js";
import { contentDisposition, correctFilename, detectType, isAllowedType, probeImage, validateFileName } from "./drive/media.js";
import { IMPLEMENTED_ENDPOINTS } from "./registry.js";
import { handlers } from "./endpoints/index.js";
import { ENDPOINT_PARAM_DEFS } from "./endpoint-params.gen.js";

const SCHEMA = `
CREATE TYPE note_visibility_enum AS ENUM ('public', 'home', 'followers', 'specified');
CREATE TABLE "user" (id varchar PRIMARY KEY, username varchar, "usernameLower" varchar, name varchar, host varchar,
  token varchar, "isBot" bool DEFAULT false, "isCat" bool DEFAULT false, "isSuspended" bool DEFAULT false,
  "avatarId" varchar, "avatarUrl" varchar, "avatarBlurhash" varchar, "bannerId" varchar, "bannerUrl" varchar, "bannerBlurhash" varchar,
  "hideOnlineStatus" bool DEFAULT false, "lastActiveDate" timestamptz, "requireSigninToViewContents" bool DEFAULT false,
  "isLocked" bool DEFAULT false, "followersCount" int DEFAULT 0, "followingCount" int DEFAULT 0, "notesCount" int DEFAULT 0,
  "updatedAt" timestamptz, "lastFetchedAt" timestamptz, "movedToUri" varchar, "alsoKnownAs" text, uri varchar,
  "isExplorable" bool DEFAULT true);
CREATE TABLE user_profile ("userId" varchar PRIMARY KEY, "alwaysMarkNsfw" bool DEFAULT false);
CREATE TABLE meta (id varchar, "rootUserId" varchar);
CREATE TABLE role (id varchar PRIMARY KEY, policies jsonb DEFAULT '{}', "isModerator" bool DEFAULT false, "isAdministrator" bool DEFAULT false,
  name varchar DEFAULT '', description varchar DEFAULT '', color varchar, "iconUrl" varchar, target varchar DEFAULT 'manual', "condFormula" jsonb DEFAULT '{}',
  "isPublic" bool DEFAULT false, "isExplorable" bool DEFAULT false, "asBadge" bool DEFAULT false, "displayOrder" int DEFAULT 0);
CREATE TABLE role_assignment (id varchar, "userId" varchar, "roleId" varchar, "expiresAt" timestamptz);
CREATE TABLE note (id varchar PRIMARY KEY, "replyId" varchar, "renoteId" varchar, "threadId" varchar, text text, name varchar, cw varchar,
  "userId" varchar, "localOnly" bool DEFAULT false, "reactionAcceptance" varchar, "renoteCount" int DEFAULT 0, "repliesCount" int DEFAULT 0,
  "clippedCount" int DEFAULT 0, "pageCount" int DEFAULT 0, reactions jsonb DEFAULT '{}', visibility varchar DEFAULT 'public', uri varchar, url varchar,
  "fileIds" varchar[] DEFAULT '{}', "attachedFileTypes" varchar[] DEFAULT '{}', "visibleUserIds" varchar[] DEFAULT '{}', mentions varchar[] DEFAULT '{}',
  "mentionedRemoteUsers" text DEFAULT '[]', "reactionAndUserPairCache" varchar[] DEFAULT '{}', emojis varchar[] DEFAULT '{}', tags varchar[] DEFAULT '{}',
  "hasPoll" bool DEFAULT false, "channelId" varchar, "userHost" varchar, "replyUserId" varchar, "replyUserHost" varchar,
  "renoteUserId" varchar, "renoteUserHost" varchar, "renoteChannelId" varchar);
CREATE TABLE note_reaction (id varchar, "userId" varchar, "noteId" varchar, reaction varchar);
CREATE TABLE following (id varchar PRIMARY KEY, "followerId" varchar, "followeeId" varchar, notify varchar);
CREATE TABLE drive_folder (id varchar PRIMARY KEY, name varchar(128) NOT NULL, "userId" varchar, "parentId" varchar);
CREATE TABLE drive_file (id varchar PRIMARY KEY, "userId" varchar, "userHost" varchar, md5 varchar(32) NOT NULL, name varchar(256) NOT NULL,
  type varchar(128) NOT NULL, size int NOT NULL, comment varchar(8192), blurhash varchar(128), properties jsonb NOT NULL DEFAULT '{}',
  "storedInternal" bool NOT NULL, url varchar(1024) NOT NULL, "thumbnailUrl" varchar(1024), "webpublicUrl" varchar(1024), "webpublicType" varchar(128),
  "accessKey" varchar(256), "thumbnailAccessKey" varchar(256), "webpublicAccessKey" varchar(256), uri varchar(1024), src varchar(1024),
  "folderId" varchar, "isSensitive" bool NOT NULL DEFAULT false, "maybeSensitive" bool NOT NULL DEFAULT false, "maybePorn" bool NOT NULL DEFAULT false,
  "isLink" bool NOT NULL DEFAULT false, "requestHeaders" jsonb DEFAULT '{}', "requestIp" varchar(128));
`;

const db = new PGlite();
const client: PgQueryable = {
  async query(text, params = []) {
    const r = await db.query(text, params as unknown[]);
    return { rows: r.rows as Record<string, unknown>[], rowCount: r.affectedRows ?? r.rows.length };
  },
};

/** In-memory R2 with range + etag. */
class FakeR2 {
  objs = new Map<string, { bytes: Uint8Array; type?: string }>();
  async put(key: string, v: Uint8Array | ArrayBuffer, o?: { httpMetadata?: { contentType?: string } }) {
    this.objs.set(key, { bytes: v instanceof Uint8Array ? v : new Uint8Array(v), type: o?.httpMetadata?.contentType });
  }
  meta(key: string) {
    const o = this.objs.get(key)!;
    return { size: o.bytes.byteLength, httpEtag: `"e${o.bytes.byteLength}"`, httpMetadata: { contentType: o.type } };
  }
  async head(key: string) {
    return this.objs.has(key) ? this.meta(key) : null;
  }
  async get(key: string, opts?: { range?: { offset?: number; length?: number; suffix?: number } }) {
    const o = this.objs.get(key);
    if (!o) return null;
    let slice = o.bytes;
    const range = opts?.range;
    if (range) {
      if (range.suffix != null) slice = o.bytes.subarray(o.bytes.byteLength - range.suffix);
      else {
        if ((range.offset ?? 0) >= o.bytes.byteLength) throw new Error("InvalidRange");
        slice = o.bytes.subarray(range.offset ?? 0, range.length != null ? (range.offset ?? 0) + range.length : undefined);
      }
    }
    return { ...this.meta(key), range, body: new Response(slice as unknown as BodyInit).body!, arrayBuffer: async () => slice.slice().buffer };
  }
  async delete(keys: string | string[]) {
    for (const k of Array.isArray(keys) ? keys : [keys]) this.objs.delete(k);
  }
}

const r2 = new FakeR2();
let mediaCalls = 0;
const env: ApiEnv = {
  INSTANCE_URL: "https://misskey.example.com",
  BOOTSTRAP_META_JSON: JSON.stringify(fixtureMeta({ name: "DriveTest" })),
  HYPERDRIVE: { connectionString: "postgres://test", __testClient: client } as unknown as ApiEnv["HYPERDRIVE"],
  MEDIA_BUCKET: r2 as unknown as ApiEnv["MEDIA_BUCKET"],
  MEDIA: {
    async fetch(input: RequestInfo | URL) {
      mediaCalls++;
      const u = new URL(String(input));
      assert.equal(u.pathname, "/alts");
      return Response.json({
        properties: { width: 2, height: 1 },
        blurhash: "LEHV6nWB2yk8",
        thumbnail: { type: "image/webp", data: btoa("THUMB") },
        webpublic: null,
      });
    },
  },
};

const ids = { a: genAidx(Date.now() - 100000), b: genAidx(Date.now() - 90000) };
const TOK = { a: "aaaaaaaaaaaaaaaa", b: "bbbbbbbbbbbbbbbb" };

/** 2x1 PNG header (enough for type + size probing). */
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 2, 0, 0, 0, 1, 8, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0x49, 0x44, 0x41, 0x54]);
const pngVariant = (n: number) => {
  const b = new Uint8Array(PNG.length + 1);
  b.set(PNG);
  b[PNG.length] = n;
  return b;
};

async function call(name: string, body: Record<string, unknown>, who?: keyof typeof TOK): Promise<{ status: number; data: any }> {
  const b = who ? { ...body, i: TOK[who] } : body;
  const ctx = { hasCredential: Boolean(who), request: new Request("https://api.test/api/" + name, { method: "POST" }) };
  const r = await DRIVE_ENDPOINTS[name]!(env, b, ctx);
  if (r instanceof Response) return { status: r.status, data: r.status === 204 ? null : await r.json() };
  return { status: 200, data: r };
}

async function upload(bytes: Uint8Array, fields: Record<string, string>, who: keyof typeof TOK = "a", filename = "pic") {
  const fd = new FormData();
  fd.append("i", TOK[who]);
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  fd.append("file", new Blob([bytes as unknown as BlobPart]), filename);
  const res = await dispatchApi(new Request("https://api.test/api/drive/files/create", { method: "POST", body: fd }), env);
  return { status: res.status, data: (await res.json()) as any };
}

before(async () => {
  await db.exec(SCHEMA);
  for (const [k, id] of Object.entries(ids)) {
    await db.query(`INSERT INTO "user" (id, username, "usernameLower", token) VALUES ($1, $2, $3, $4)`, [id, `user_${k}`, `user_${k}`, TOK[k as keyof typeof TOK]]);
    await db.query(`INSERT INTO user_profile ("userId") VALUES ($1)`, [id]);
  }
  await db.query(`INSERT INTO meta (id, "rootUserId") VALUES ('x', $1)`, [ids.a]);
  setAltsTimeoutForTest(2000);
});

describe("drive helpers", () => {
  it("detects types, probes sizes, fixes names", () => {
    assert.deepEqual(detectType(PNG), { mime: "image/png", ext: "png" });
    assert.deepEqual(detectType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), { mime: "image/jpeg", ext: "jpg" });
    assert.equal(detectType(new TextEncoder().encode("GIF89a....")).mime, "image/gif");
    assert.equal(detectType(new TextEncoder().encode('<?xml version="1.0"?><svg xmlns="x"></svg>')).mime, "image/svg+xml");
    assert.equal(detectType(new TextEncoder().encode("hello")).mime, "application/octet-stream");
    const mp4 = new Uint8Array([0, 0, 0, 0x18, ...new TextEncoder().encode("ftypisom"), 0, 0, 0, 0]);
    assert.equal(detectType(mp4).mime, "video/mp4");
    assert.equal(detectType(new Uint8Array([0, 0, 0, 0x18, ...new TextEncoder().encode("ftypavif")])).mime, "image/avif");
    assert.equal(detectType(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, ...new TextEncoder().encode("....webm")])).mime, "video/webm");
    assert.deepEqual(probeImage(PNG, "image/png"), { width: 2, height: 1 });
    assert.equal(correctFilename("pic", "png"), "pic.png");
    assert.equal(correctFilename("pic.jpeg", "jpg"), "pic.jpeg");
    assert.equal(correctFilename("a.txt", null), "a.txt");
    assert.equal(correctFilename("x.tar.gz", "gz"), "x.tar.gz");
    assert.equal(correctFilename("img.png", "webp"), "img.png.webp");
    assert.ok(!validateFileName("../x") && !validateFileName("a/b") && validateFileName("ok.png"));
    assert.ok(isAllowedType(["image/*"], "image/png") && !isAllowedType(["image/*"], "video/mp4") && isAllowedType(["*"], "x/y"));
    assert.equal(contentDisposition("inline", "a.png"), 'inline; filename="a.png"');
    assert.match(contentDisposition("inline", "画像.png"), /filename\*=UTF-8''%E7%94%BB%E5%83%8F\.png/);
    assert.deepEqual(parseR2Range("bytes=0-3"), { offset: 0, length: 4 });
    assert.deepEqual(parseR2Range("bytes=5-"), { offset: 5 });
    assert.deepEqual(parseR2Range("bytes=-2"), { suffix: 2 });
  });

  it("thumbnailUrl + public url follow upstream", () => {
    const base = { id: ids.a, name: "a", md5: "x", size: 1, url: "U", properties: { width: 1, height: 2, orientation: 6 } };
    assert.equal(thumbnailUrlOf({ ...base, type: "image/png" }), "U");
    assert.equal(thumbnailUrlOf({ ...base, type: "image/png", webpublicUrl: "W" }), "W");
    assert.equal(thumbnailUrlOf({ ...base, type: "video/mp4" }), null);
    assert.equal(thumbnailUrlOf({ ...base, type: "application/pdf" }), null);
    const pub = packDriveFile({ ...base, type: "image/jpeg", webpublicUrl: "W", userId: "u" });
    assert.equal(pub.url, "W");
    assert.deepEqual(pub.properties, { width: 2, height: 1 });
    assert.equal(pub.userId, null);
    assert.equal(packDriveFile({ ...base, type: "image/jpeg", webpublicUrl: "W" }, { self: true }).url, "U");
  });

  it("combines role policies with priority like upstream", () => {
    const base = { driveCapacityMb: 100, alwaysMarkNsfw: false, uploadableFileTypes: ["image/*"] };
    assert.equal(combinePolicies(base, [{ policies: { driveCapacityMb: { useDefault: false, priority: 0, value: 500 } } }]).driveCapacityMb, 500);
    assert.equal(
      combinePolicies(base, [
        { policies: { driveCapacityMb: { useDefault: false, priority: 0, value: 500 } } },
        { policies: { driveCapacityMb: { useDefault: false, priority: 2, value: 1 } } },
      ]).driveCapacityMb,
      1,
    );
    assert.deepEqual(combinePolicies(base, [{ policies: { uploadableFileTypes: { useDefault: false, priority: 0, value: ["video/*"] } } }, { policies: {} }]).uploadableFileTypes, ["video/*", "image/*"]);
  });
});

describe("drive endpoints (PGlite + fake R2/media)", () => {
  let fileId = "";
  let accessKey = "";
  let thumbKey = "";

  it("registers endpoints, handlers, params", () => {
    for (const n of Object.keys(DRIVE_ENDPOINTS)) {
      assert.ok((IMPLEMENTED_ENDPOINTS as readonly string[]).includes(n), `registry: ${n}`);
      assert.ok(handlers[n], `handler: ${n}`);
      assert.ok(ENDPOINT_PARAM_DEFS[n], `params: ${n}`);
    }
  });

  it("multipart create: type/name/md5/properties, container thumbnail, stream-free", async () => {
    const r = await upload(PNG, { comment: "hi", isSensitive: "true" });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const f = r.data;
    fileId = f.id;
    assert.equal(f.name, "pic.png");
    assert.equal(f.type, "image/png");
    assert.equal(f.size, PNG.byteLength);
    assert.equal(f.md5.length, 32);
    assert.equal(f.comment, "hi");
    assert.equal(f.isSensitive, true);
    assert.deepEqual(f.properties, { width: 2, height: 1 });
    assert.equal(f.blurhash, "LEHV6nWB2yk8");
    assert.match(f.url, /^https:\/\/misskey\.example\.com\/files\/[0-9a-f-]{36}$/);
    assert.match(f.thumbnailUrl, /\/files\/thumbnail-/);
    assert.equal(f.folderId, null);
    accessKey = f.url.split("/files/")[1];
    thumbKey = f.thumbnailUrl.split("/files/")[1];
    assert.ok(r2.objs.has(`drive/${accessKey}`) && r2.objs.has(`drive/${thumbKey}`));
    assert.equal(mediaCalls, 1);
  });

  it("create: dedupe by md5 unless force; FILE_REQUIRED; INVALID_FILE_NAME", async () => {
    const again = await upload(PNG, {});
    assert.equal(again.data.id, fileId);
    const forced = await upload(PNG, { force: "true", name: "copy.png" });
    assert.notEqual(forced.data.id, fileId);
    assert.equal(forced.data.name, "copy.png");
    assert.equal((await call("drive/files/create", {}, "a")).data.error.id, "4267801e-70d1-416a-b011-4ee502885d8b");
    assert.equal((await upload(pngVariant(1), { name: "a/b.png" })).data.error.id, "f449b209-0c60-4e51-84d5-29486263bfd4");
    assert.equal((await call("drive/files/delete", { fileId: forced.data.id }, "a")).status, 204);
  });

  it("policies: unallowed type, capacity (role priority), moderator bypass", async () => {
    // user b is not root: octet-stream is not in default uploadableFileTypes
    const deny = await upload(new TextEncoder().encode("plain text"), {}, "b", "a.txt");
    assert.equal(deny.data.error?.id, "4becd248-7f2c-48c4-a9f0-75edc4f9a1ea", JSON.stringify(deny.data));
    // root (a) bypasses the type check
    const t = await upload(new TextEncoder().encode("plain text"), {}, "a", "a.txt");
    assert.equal(t.data.type, "application/octet-stream");
    assert.equal(t.data.name, "a.txt");
    assert.equal(t.data.thumbnailUrl, null);
    await call("drive/files/delete", { fileId: t.data.id }, "a");
    await db.query(`INSERT INTO role (id, policies) VALUES ('r1', $1)`, [JSON.stringify({ driveCapacityMb: { useDefault: false, priority: 2, value: 0.00001 } })]);
    await db.query(`INSERT INTO role_assignment (id, "userId", "roleId") VALUES ('ra1', $1, 'r1')`, [ids.b]);
    assert.equal((await upload(pngVariant(2), {}, "b")).data.error.id, "d08dbc37-a6a9-463a-8c47-96c32ab5f064");
    const d = (await call("drive", {}, "b")).data;
    assert.equal(d.usage, 0);
    assert.ok(d.capacity < 100);
    await db.query(`DELETE FROM role_assignment`);
    const ok = await upload(pngVariant(2), {}, "b");
    assert.equal(ok.status, 200);
    assert.equal((await call("drive", {}, "b")).data.capacity, 100 * 1024 * 1024);
    assert.equal((await call("drive", {}, "b")).data.usage, PNG.byteLength + 1);
    await call("drive/files/delete", { fileId: ok.data.id }, "b");
  });

  it("serves original / thumbnail with headers, Range, ETag, HEAD, 404", async () => {
    const res = await serveDriveFile(env, new Request(`https://x/files/${accessKey}`), accessKey);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "image/png");
    assert.equal(res.headers.get("cache-control"), "max-age=31536000, immutable");
    assert.equal(res.headers.get("content-disposition"), 'inline; filename="pic.png"');
    assert.match(res.headers.get("content-security-policy")!, /default-src 'none'/);
    assert.deepEqual(new Uint8Array(await res.arrayBuffer()), PNG);
    const part = await serveDriveFile(env, new Request(`https://x/files/${accessKey}`, { headers: { range: "bytes=0-3" } }), accessKey);
    assert.equal(part.status, 206);
    assert.equal(part.headers.get("content-range"), `bytes 0-3/${PNG.byteLength}`);
    assert.deepEqual(new Uint8Array(await part.arrayBuffer()), PNG.subarray(0, 4));
    const etag = res.headers.get("etag")!;
    assert.equal((await serveDriveFile(env, new Request(`https://x/f`, { headers: { "if-none-match": etag } }), accessKey)).status, 304);
    const head = await serveDriveFile(env, new Request(`https://x/f`, { method: "HEAD" }), accessKey);
    assert.equal(head.headers.get("content-length"), String(PNG.byteLength));
    const th = await serveDriveFile(env, new Request(`https://x/f`), thumbKey);
    assert.equal(th.headers.get("content-type"), "image/webp");
    assert.equal(th.headers.get("content-disposition"), 'inline; filename="pic-thumb.webp"');
    assert.equal(await th.text(), "THUMB");
    assert.equal((await serveDriveFile(env, new Request(`https://x/f`), "nope")).status, 404);
  });

  it("show / find / find-by-hash / check-existence / stream / files", async () => {
    const s = await call("drive/files/show", { fileId }, "a");
    assert.equal(s.data.userId, ids.a);
    assert.equal(s.data.user.username, "user_a");
    assert.equal((await call("drive/files/show", { url: `https://misskey.example.com/files/${thumbKey}` }, "a")).data.id, fileId);
    assert.equal((await call("drive/files/show", { fileId }, "b")).data.error.id, "25b73c73-68b1-41d0-bad1-381cfdf6579f");
    assert.equal((await call("drive/files/show", { fileId: "nope" }, "a")).data.error.id, "067bc436-2718-4795-b0fb-ecbe43949e31");
    assert.equal((await call("drive/files/find", { name: "pic.png" }, "a")).data[0].id, fileId);
    const md5 = s.data.md5;
    assert.equal((await call("drive/files/find-by-hash", { md5 }, "a")).data.length, 1);
    assert.equal((await call("drive/files/check-existence", { md5 }, "a")).data, true);
    assert.equal((await call("drive/files/check-existence", { md5 }, "b")).data, false);
    assert.equal((await call("drive/stream", { type: "image/*" }, "a")).data[0].id, fileId);
    assert.equal((await call("drive/stream", { type: "video/*" }, "a")).data.length, 0);
    assert.equal((await call("drive/files", {}, "a")).data[0].id, fileId);
  });

  it("folders: create/show/update/find/list, nesting rules, file move/update, delete rules", async () => {
    const p = (await call("drive/folders/create", { name: "Photos" }, "a")).data;
    const ch = (await call("drive/folders/create", { name: "2026", parentId: p.id }, "a")).data;
    assert.equal(ch.parentId, p.id);
    assert.equal((await call("drive/folders/create", { parentId: "nope" }, "a")).data.error.id, "53326628-a00d-40a6-a3cd-8975105c0f95");
    assert.equal((await call("drive/folders/create", {}, "a")).data.name, "Untitled");
    const shown = (await call("drive/folders/show", { folderId: ch.id }, "a")).data;
    assert.equal(shown.parent.id, p.id);
    assert.equal(shown.parent.foldersCount, 1);
    assert.equal((await call("drive/folders/show", { folderId: ch.id }, "b")).data.error.id, "d74ab9eb-bb09-4bba-bf24-fb58f761e1e9");
    assert.equal((await call("drive/folders/update", { folderId: p.id, parentId: ch.id }, "a")).data.error.id, "dbeb024837894013aed44279f9199740");
    assert.equal((await call("drive/folders/update", { folderId: p.id, parentId: p.id }, "a")).data.error.id, "dbeb024837894013aed44279f9199740");
    assert.equal((await call("drive/folders/update", { folderId: p.id, parentId: "nope" }, "a")).data.error.id, "ce104e3a-faaf-49d5-b459-10ff0cbbcaa1");
    assert.equal((await call("drive/folders/update", { folderId: ch.id, name: "2027" }, "a")).data.name, "2027");
    assert.equal((await call("drive/folders/find", { name: "2027", parentId: p.id }, "a")).data.length, 1);
    assert.equal((await call("drive/folders", {}, "a")).data.length, 2);
    assert.equal((await call("drive/folders", { folderId: p.id }, "a")).data[0].id, ch.id);

    const u = await call("drive/files/update", { fileId, folderId: ch.id, name: "renamed.png", isSensitive: false, comment: null }, "a");
    assert.equal(u.data.folderId, ch.id);
    assert.equal(u.data.name, "renamed.png");
    assert.equal(u.data.isSensitive, false);
    assert.equal(u.data.comment, null);
    assert.equal((await call("drive/files/update", { fileId, name: "../x" }, "a")).data.error.id, "395e7156-f9f0-475e-af89-53c3c23080c2");
    assert.equal((await call("drive/files/update", { fileId, folderId: "nope" }, "a")).data.error.id, "ea8fb7a5-af77-4a08-b608-c0218176cd73");
    assert.equal((await call("drive/files/update", { fileId, name: "x.png" }, "b")).data.error.id, "01a53b27-82fc-445b-a0c1-b558465a8ed2");
    assert.equal((await call("drive/files", { folderId: ch.id }, "a")).data[0].id, fileId);
    assert.equal((await call("drive/files", {}, "a")).data.length, 0);
    assert.equal((await call("drive/files/show", { fileId }, "a")).data.folder.parent.id, p.id);

    assert.equal((await call("drive/folders/delete", { folderId: ch.id }, "a")).data.error.id, "b0fc8a17-963c-405d-bfbc-859a487295e1");
    assert.equal((await call("drive/files/move-bulk", { fileIds: [fileId], folderId: null }, "a")).status, 204);
    assert.equal((await call("drive/folders/delete", { folderId: ch.id }, "a")).status, 204);
    assert.equal((await call("drive/folders/delete", { folderId: ch.id }, "a")).data.error.id, "1069098f-c281-440f-b085-f9932edbe091");
  });

  it("notes/create validates fileIds; packed notes carry files; attached-notes", async () => {
    const res = await handlers["notes/create"]!(env, { i: TOK.a, text: "with file", fileIds: [fileId] }, { hasCredential: true, request: new Request("https://x/api/notes/create", { method: "POST" }) });
    const created = res instanceof Response ? await res.json() : res;
    const note = (created as any).createdNote;
    assert.ok(note, JSON.stringify(created));
    assert.equal(note.files[0].id, fileId);
    assert.match(note.files[0].url, /\/files\//);
    assert.equal(note.files[0].userId, null);
    assert.deepEqual(note.fileIds, [fileId]);
    const row = (await db.query<{ attachedFileTypes: string[] }>(`SELECT "attachedFileTypes" FROM note WHERE id = $1`, [note.id])).rows[0]!;
    assert.deepEqual(row.attachedFileTypes, ["image/png"]);
    const bad = await handlers["notes/create"]!(env, { i: TOK.b, text: "steal", fileIds: [fileId] }, { hasCredential: true, request: new Request("https://x/api/notes/create", { method: "POST" }) });
    assert.equal(((await (bad as Response).json()) as any).error.id, "b6992544-63e7-67f0-fa7f-32444b1b5306");
    const att = await call("drive/files/attached-notes", { fileId }, "a");
    assert.equal(att.data[0].id, note.id);
    assert.equal((await call("drive/files/attached-notes", { fileId }, "b")).data.error.id, "c118ece3-2e4b-4296-99d1-51756e32d232");
  });

  it("delete removes R2 objects + row; errors", async () => {
    assert.equal((await call("drive/files/delete", { fileId }, "b")).data.error.id, "5eb8d909-2540-4970-90b8-dd6f86088121");
    assert.equal((await call("drive/files/delete", { fileId }, "a")).status, 204);
    assert.ok(!r2.objs.has(`drive/${accessKey}`) && !r2.objs.has(`drive/${thumbKey}`));
    assert.equal((await call("drive/files/delete", { fileId }, "a")).data.error.id, "908939ec-e52b-4458-b395-1025195cea58");
  });

  it("container unavailable → original only, thumbnailUrl falls back to url", async () => {
    const saved = env.MEDIA;
    env.MEDIA = { fetch: async () => new Response("down", { status: 503 }) };
    const r = await upload(pngVariant(9), {});
    env.MEDIA = saved;
    assert.equal(r.status, 200);
    assert.equal(r.data.thumbnailUrl, r.data.url);
    assert.equal(r.data.blurhash, null);
    await call("drive/files/delete", { fileId: r.data.id }, "a");
  });

  it("alternates that time out are retried by a delayed driveAlts job", async () => {
    const saved = env.MEDIA;
    const sent: { body: unknown; opts?: { delaySeconds?: number } }[] = [];
    env.Q_JOBS = { send: async (body, opts) => void sent.push({ body, opts }) };
    env.MEDIA = { fetch: async () => new Promise<Response>(() => {}) };
    setAltsTimeoutForTest(10);
    const r = await upload(pngVariant(11), {});
    setAltsTimeoutForTest(2000);
    env.MEDIA = saved;
    env.Q_JOBS = undefined;
    assert.equal(r.status, 200);
    assert.equal(r.data.thumbnailUrl, r.data.url);
    assert.deepEqual(sent, [{ body: { kind: "driveAlts", fileId: r.data.id }, opts: { delaySeconds: DRIVE_ALTS_RETRY_DELAY_SEC } }]);
    await runDriveAltsJob(env, { kind: "driveAlts", fileId: r.data.id });
    const shown = (await call("drive/files/show", { fileId: r.data.id }, "a")).data;
    assert.match(shown.thumbnailUrl, /\/files\/thumbnail-/);
    const before = mediaCalls;
    await runDriveAltsJob(env, { kind: "driveAlts", fileId: r.data.id });
    assert.equal(mediaCalls, before, "a file with alternates is left alone");
    await call("drive/files/delete", { fileId: r.data.id }, "a");
  });

  it("upload-from-url fetches and stores in the background", async () => {
    env.AP_FETCH = (async () => new Response(pngVariant(7), { headers: { "content-type": "image/png" } })) as typeof fetch;
    const r = await call("drive/files/upload-from-url", { url: "https://example.org/img/cat.png", comment: "c" }, "a");
    env.AP_FETCH = undefined;
    assert.equal(r.status, 204);
    const found = (await call("drive/files/find", { name: "cat.png" }, "a")).data;
    assert.equal(found.length, 1);
    assert.equal(found[0].comment, "c");
    await call("drive/files/delete", { fileId: found[0].id }, "a");
  });

  it("upload-from-url of our own /files/ URL is served in-process (no self-fetch)", async () => {
    const src = await upload(pngVariant(8), {}, "a", "self.png");
    env.AP_FETCH = (async () => {
      throw new Error("must not fetch own origin");
    }) as typeof fetch;
    const r = await call("drive/files/upload-from-url", { url: src.data.url, force: true }, "a");
    env.AP_FETCH = undefined;
    assert.equal(r.status, 204);
    const copies = (await call("drive/files/find-by-hash", { md5: src.data.md5 }, "a")).data;
    assert.equal(copies.length, 2);
    for (const c of copies) await call("drive/files/delete", { fileId: c.id }, "a");
  });
});
