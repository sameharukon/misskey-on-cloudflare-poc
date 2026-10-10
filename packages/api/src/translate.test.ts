/**
 * notes/translate on PG (PGlite): DeepL request shape (free / pro endpoint, auth header, form body,
 * `xx-YY` → `xx`), `{ sourceLang, text }`, cw prefix, 204 on empty text, the unavailable cases
 * (no key, canUseTranslator policy off), noSuchNote, invisible / hidden notes, upstream errors →
 * INTERNAL_ERROR, and meta.translatorAvailable following admin/update-meta deeplAuthKey.
 */
import { before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { genAidx } from "../../id/src/index.js";
import { IMPLEMENTED_ENDPOINTS } from "./registry.js";
import { makeFixture, type Fixture } from "./pglite-fixture.js";
import { TRANSLATE_ERRORS } from "./translate-pg.js";
import type { ApiEnv } from "./env.js";
import { ENDPOINT_PARAM_DEFS } from "./endpoint-params.gen.js";

type Sent = { url: string; headers: Record<string, string>; body: string };
const sent: Sent[] = [];
let reply: () => Response = () => Response.json({ translations: [{ detected_source_language: "JA", text: "Hello" }] });
const fakeFetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
  const headers: Record<string, string> = {};
  new Headers(init?.headers).forEach((v, k) => void (headers[k] = v));
  sent.push({ url: String(url), headers, body: String(init?.body ?? "") });
  return reply();
}) as typeof fetch;

let f: Fixture;
before(async () => {
  f = await makeFixture("TranslateTest", { AP_FETCH: fakeFetch } as Partial<ApiEnv>);
});
beforeEach(async () => {
  sent.length = 0;
  reply = () => Response.json({ translations: [{ detected_source_language: "JA", text: "Hello" }] });
  await f.db.query(`UPDATE meta SET "deeplAuthKey" = 'k-free', "deeplIsPro" = FALSE`);
});

const E = (r: { data: any }) => r.data?.error?.id;
const T = "notes/translate";

describe("notes/translate", () => {
  it("is registered", () => {
    assert.ok((IMPLEMENTED_ENDPOINTS as readonly string[]).includes(T));
    assert.deepEqual(Object.keys(ENDPOINT_PARAM_DEFS[T]!.properties ?? {}), ["noteId", "targetLang"]);
  });

  it("translates through DeepL (free endpoint)", async () => {
    const n = await f.note(f.ids.b, { text: "こんにちは" });
    const r = await f.call(T, { noteId: n, targetLang: "en-US" }, "c");
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.deepEqual(r.data, { sourceLang: "JA", text: "Hello" });
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.url, "https://api-free.deepl.com/v2/translate");
    assert.equal(sent[0]!.headers.authorization, "DeepL-Auth-Key k-free");
    assert.equal(sent[0]!.headers["content-type"], "application/x-www-form-urlencoded");
    const form = new URLSearchParams(sent[0]!.body);
    assert.equal(form.get("text"), "こんにちは");
    assert.equal(form.get("target_lang"), "en");
  });

  it("pro endpoint and cw prefix", async () => {
    await f.db.query(`UPDATE meta SET "deeplAuthKey" = 'k-pro', "deeplIsPro" = TRUE`);
    const n = await f.note(f.ids.b, { text: "body", cw: "warn" });
    const r = await f.call(T, { noteId: n, targetLang: "ja" }, "c");
    assert.equal(r.status, 200);
    assert.equal(sent[0]!.url, "https://api.deepl.com/v2/translate");
    assert.equal(sent[0]!.headers.authorization, "DeepL-Auth-Key k-pro");
    assert.equal(new URLSearchParams(sent[0]!.body).get("text"), "warn\n-----\nbody");
  });

  it("empty text → 204 without calling DeepL", async () => {
    const n = await f.note(f.ids.b, { text: "   " });
    const r = await f.call(T, { noteId: n, targetLang: "en" }, "c");
    assert.equal(r.status, 204);
    assert.equal(sent.length, 0);
  });

  it("unavailable: no key / policy off", async () => {
    const n = await f.note(f.ids.b, { text: "x" });
    await f.db.query(`UPDATE meta SET "deeplAuthKey" = NULL`);
    let r = await f.call(T, { noteId: n, targetLang: "en" }, "c");
    assert.equal(r.status, 400);
    assert.equal(E(r), TRANSLATE_ERRORS.unavailable.id);
    await f.db.query(`UPDATE meta SET "deeplAuthKey" = 'k'`);
    await f.setPolicy(f.ids.c, "canUseTranslator", false);
    r = await f.call(T, { noteId: n, targetLang: "en" }, "c");
    assert.equal(E(r), TRANSLATE_ERRORS.unavailable.id);
    // checked before the note lookup, as upstream
    r = await f.call(T, { noteId: "nonexistent", targetLang: "en" }, "c");
    assert.equal(E(r), TRANSLATE_ERRORS.unavailable.id);
    await f.setPolicy(f.ids.c, "canUseTranslator", true);
    assert.equal(sent.length, 0);
  });

  it("credential, params, no such note", async () => {
    const n = await f.note(f.ids.b, { text: "x" });
    assert.equal((await f.call(T, { noteId: n, targetLang: "en" })).status, 401);
    assert.equal((await f.call(T, { noteId: n }, "c")).status, 400);
    const r = await f.call(T, { noteId: genAidx(Date.now()), targetLang: "en" }, "c");
    assert.equal(r.status, 400);
    assert.equal(E(r), TRANSLATE_ERRORS.noSuchNote.id);
  });

  it("invisible notes", async () => {
    const spec = await f.note(f.ids.b, { text: "secret", visibility: "specified", visibleUserIds: [f.ids.a] });
    let r = await f.call(T, { noteId: spec, targetLang: "en" }, "c");
    assert.equal(E(r), TRANSLATE_ERRORS.cannotTranslateInvisibleNote.id);
    assert.equal((await f.call(T, { noteId: spec, targetLang: "en" }, "a")).status, 200);
    assert.equal((await f.call(T, { noteId: spec, targetLang: "en" }, "b")).status, 200); // own note
    const fol = await f.note(f.ids.b, { text: "followers", visibility: "followers" });
    r = await f.call(T, { noteId: fol, targetLang: "en" }, "c");
    assert.equal(E(r), TRANSLATE_ERRORS.cannotTranslateInvisibleNote.id);
  });

  it("notes hidden by makeNotesHiddenBefore / makeNotesFollowersOnlyBefore", async () => {
    const n = await f.note(f.ids.b, { text: "old" });
    await f.db.query(`UPDATE "user" SET "makeNotesHiddenBefore" = $2 WHERE id = $1`, [f.ids.b, Math.floor(Date.now() / 1000) + 60]);
    let r = await f.call(T, { noteId: n, targetLang: "en" }, "c");
    assert.equal(E(r), TRANSLATE_ERRORS.cannotTranslateInvisibleNote.id);
    assert.equal((await f.call(T, { noteId: n, targetLang: "en" }, "b")).status, 200); // author
    await f.db.query(`UPDATE "user" SET "makeNotesHiddenBefore" = NULL, "makeNotesFollowersOnlyBefore" = $2 WHERE id = $1`, [f.ids.b, Math.floor(Date.now() / 1000) + 60]);
    r = await f.call(T, { noteId: n, targetLang: "en" }, "c");
    assert.equal(E(r), TRANSLATE_ERRORS.cannotTranslateInvisibleNote.id);
    await f.db.query(`INSERT INTO following (id, "followerId", "followeeId") VALUES ('fl1', $1, $2)`, [f.ids.c, f.ids.b]);
    assert.equal((await f.call(T, { noteId: n, targetLang: "en" }, "c")).status, 200);
    await f.db.query(`DELETE FROM following WHERE id = 'fl1'`);
    await f.db.query(`UPDATE "user" SET "makeNotesFollowersOnlyBefore" = NULL WHERE id = $1`, [f.ids.b]);
  });

  it("DeepL failure → INTERNAL_ERROR", async () => {
    reply = () => new Response("quota", { status: 456 });
    const n = await f.note(f.ids.b, { text: "x" });
    const r = await f.call(T, { noteId: n, targetLang: "en" }, "c");
    assert.equal(r.status, 500);
    assert.equal(r.data.error.code, "INTERNAL_ERROR");
  });

  it("meta.translatorAvailable follows admin/update-meta deeplAuthKey", async () => {
    assert.equal((await f.call("meta", {})).data.translatorAvailable, false);
    assert.equal((await f.call("admin/update-meta", { deeplAuthKey: "abc", deeplIsPro: true }, "a")).status, 204); // upstream returns nothing
    assert.equal((await f.call("meta", {})).data.translatorAvailable, true);
    await f.call("admin/update-meta", { deeplAuthKey: "" }, "a"); // '' clears it
    assert.equal((await f.call("meta", {})).data.translatorAvailable, false);
  });
});
