/**
 * The router's ApiCallService gate (callGate): upstream's order of authentication, credential,
 * suspension, role, role-policy and app-permission checks, GET param casting and IP logging.
 */
import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeFixture, TOK, type Fixture } from "./pglite-fixture.js";
import { callGate, dispatchApi } from "./router.js";

let f: Fixture;
before(async () => {
  f = await makeFixture("GateTest");
});

const gate = async (name: string, body: Record<string, unknown>, init: RequestInit = { method: "POST" }) => {
  const r = await callGate(f.env, name, new Request(`https://api.test/api/${name}`, init), body);
  return r ? { status: r.status, id: r.status === 400 && !r.headers.get("content-type") ? null : (((await r.json()) as any).error?.id ?? null), headers: r.headers } : null;
};

describe("callGate", () => {
  it("unknown token → AUTHENTICATION_FAILED 401 (with WWW-Authenticate), even on public endpoints", async () => {
    const r = await gate("meta", { i: "zzzzzzzzzzzzzzzz" });
    assert.equal(r?.status, 401);
    assert.equal(r?.id, "b0a7f5f8-dc2f-4171-b91f-de88ad238e14");
    assert.match(r!.headers.get("WWW-Authenticate") ?? "", /invalid_token/);
    assert.equal(await gate("meta", {}), null);
  });

  it("non-string `i` → bare 400", async () => {
    const r = await callGate(f.env, "meta", new Request("https://api.test/api/meta", { method: "POST" }), { i: 123 });
    assert.equal(r?.status, 400);
  });

  it("credential required: none → CREDENTIAL_REQUIRED 401; suspended → YOUR_ACCOUNT_SUSPENDED 403", async () => {
    assert.equal((await gate("i", {}))?.id, "1384574d-a912-4b81-8601-c7b1c4085df1");
    await f.db.query(`UPDATE "user" SET "isSuspended" = TRUE WHERE id = $1`, [f.ids.c]);
    assert.deepEqual([(await gate("i", { i: TOK.c }))?.status, (await gate("i", { i: TOK.c }))?.id], [403, "a8c724b3-6e9c-4b46-b1a8-bc3ed6258370"]);
    // a public endpoint still answers a suspended user (as upstream)
    assert.equal(await gate("meta", { i: TOK.c }), null);
    await f.db.query(`UPDATE "user" SET "isSuspended" = FALSE WHERE id = $1`, [f.ids.c]);
  });

  it("requireModerator / requireAdmin / requiredRolePolicy (root passes)", async () => {
    assert.equal((await gate("admin/show-users", { i: TOK.b }))?.id, "d33d5333-db36-423d-a8f9-1a2b9549da41");
    assert.equal((await gate("admin/meta", { i: TOK.b }))?.id, "c3d38592-54c0-429d-be96-5636b0431a61");
    assert.equal(await gate("admin/meta", { i: TOK.a }), null); // root
    assert.equal((await gate("admin/emoji/add", { i: TOK.b }))?.id, "7f86f06f-7e15-4057-8561-f4b6d4ac755a");
    await f.setPolicy(f.ids.b, "canManageCustomEmojis", true);
    // past the role checks, upstream validates the paramDef (name / fileId required)
    assert.equal((await gate("admin/emoji/add", { i: TOK.b }))?.id, "3d81ceae-475f-4600-b2a8-2bc116157532");
    assert.equal(await gate("admin/emoji/add", { i: TOK.b, name: "x", fileId: "abc" }), null);
  });

  it("GET params of type boolean / integer are JSON.parse'd; a bad value → INVALID_PARAM 0b5f1631", async () => {
    const r = await dispatchApi(new Request("https://api.test/api/bubble-game/ranking?gameMode=normal"), f.env);
    assert.equal(r.status, 200);
    const body: Record<string, unknown> = { limit: "5", detail: "false" };
    // meta allows GET: detail is Boolean
    assert.equal(await callGate(f.env, "meta", new Request("https://api.test/api/meta?detail=false"), body), null);
    assert.equal(body.detail, false);
    const bad: Record<string, unknown> = { detail: "nope" };
    const res = await callGate(f.env, "meta", new Request("https://api.test/api/meta?detail=nope"), bad);
    assert.equal(res?.status, 400);
    const e = ((await res!.json()) as any).error;
    assert.equal(e.id, "0b5f1631-7c1a-41a6-b399-cce335f34d85");
    assert.equal(e.info.param, "detail");
  });

  it("logIp: one user_ip row per (user, ip) when meta.enableIpLogging", async () => {
    await f.db.query(`UPDATE meta SET "enableIpLogging" = TRUE`);
    const h = { method: "POST", headers: { "cf-connecting-ip": "198.51.100.42" } };
    await gate("meta", { i: TOK.b }, h);
    await gate("meta", { i: TOK.b }, h);
    const rows = (await f.db.query(`SELECT ip FROM user_ip WHERE "userId" = $1 AND ip = '198.51.100.42'`, [f.ids.b])).rows;
    assert.equal(rows.length, 1);
  });
});
