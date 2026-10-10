/**
 * API rate limiting: endpoint `meta.limit` through the router gate, rateLimitFactor, minInterval,
 * IP actors (/64), signin-flow's own limit, disabled modes, and the RateLimiter DO itself.
 */
import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { fakeDoNamespace, makeFixture, TOK, type Fixture } from "./pglite-fixture.js";
import { getIpHash, rateLimit, RateLimiter } from "./rate-limit.js";
import { dispatchApi, callGate } from "./router.js";
import { ENDPOINT_META } from "./endpoint-meta.gen.js";
import type { ApiEnv } from "./env.js";
import { testDoStorage } from "../../shared/src/test-do-storage.js";
import { rpcStub } from "../../shared/src/testing/do-namespace.js";

let f: Fixture;
let env: ApiEnv;
before(async () => {
  f = await makeFixture("RateLimitTest");
  env = { ...f.env, RATE_LIMITER: fakeDoNamespace((s) => new RateLimiter(s as never)) as unknown as ApiEnv["RATE_LIMITER"] };
});

const req = (name: string, headers: Record<string, string> = {}) => new Request(`https://api.test/api/${name}`, { method: "POST", headers });
const gate = (e: ApiEnv, name: string, body: Record<string, unknown>, headers: Record<string, string> = {}) => callGate(e, name, req(name, headers), body);

describe("rate limiting", () => {
  it("generated meta carries upstream limits", () => {
    assert.deepEqual(ENDPOINT_META["notes/create"]!.limit, { duration: 3_600_000, max: 300 });
    assert.deepEqual(ENDPOINT_META["notes/delete"]!.limit, { duration: 3_600_000, max: 300, minInterval: 1000 });
    assert.equal(ENDPOINT_META["notes/show"]!.limit, undefined);
  });

  it("getIpHash: whole IPv4 address, IPv6 /64 prefix", () => {
    assert.equal(getIpHash("1.2.3.4"), "ip-" + BigInt(0x01020304).toString(36));
    assert.equal(getIpHash("2001:db8:1:2:aaaa::1"), getIpHash("2001:db8:1:2:bbbb:cccc:dddd:eeee"));
    assert.notEqual(getIpHash("2001:db8:1:2::1"), getIpHash("2001:db8:1:3::1"));
    assert.equal(getIpHash("2001:db8:1:2::1"), "ip-" + BigInt("0x20010db800010002").toString(36));
  });

  it("per-user window: second i/export-mute within the hour → 429 with Retry-After", async () => {
    assert.equal(await gate(env, "i/export-mute", { i: TOK.a }), null);
    const r = await gate(env, "i/export-mute", { i: TOK.a });
    assert.equal(r?.status, 429);
    const body = (await r!.json()) as any;
    assert.equal(body.error.id, "d5826d14-3982-4d2e-8011-b9e9f02499ef");
    assert.equal(body.error.code, "RATE_LIMIT_EXCEEDED");
    assert.equal(body.error.info.remaining, 0);
    const retry = Number(r!.headers.get("Retry-After"));
    assert.ok(retry > 3500 && retry <= 3600, String(retry));
    // another user, and another endpoint (own key), are separate windows
    assert.equal(await gate(env, "i/export-mute", { i: TOK.b }), null);
    assert.equal(await gate(env, "i/export-blocking", { i: TOK.a }), null);
  });

  it("minInterval refuses a quick second call (BRIEF_REQUEST_INTERVAL → same 429)", async () => {
    // (valid params: the paramDef is checked after the rate limit, and must pass for the first call)
    assert.equal(await gate(env, "notes/delete", { i: TOK.b, noteId: "x1" }), null);
    assert.equal((await gate(env, "notes/delete", { i: TOK.b, noteId: "x1" }))?.status, 429);
  });

  it("rateLimitFactor: 0 exempts, 2 halves max (0.5 → one call allowed)", async () => {
    await f.setPolicy(f.ids.c, "rateLimitFactor", 0);
    for (let i = 0; i < 3; i++) assert.equal(await gate(env, "i/export-following", { i: TOK.c }), null);
    await f.setPolicy(f.ids.c, "rateLimitFactor", 2);
    assert.equal(await gate(env, "i/export-antennas", { i: TOK.c }), null);
    assert.equal((await gate(env, "i/export-antennas", { i: TOK.c }))?.status, 429);
  });

  it("anonymous calls are limited per IP /64; ENABLE_IP_RATE_LIMIT=false turns that off", async () => {
    const lim = { key: "test-anon", duration: 60_000, max: 2 };
    const a1 = getIpHash("2001:db8::1");
    assert.equal(await rateLimit(env, lim, a1), null);
    assert.equal(await rateLimit(env, lim, getIpHash("2001:db8::2")), null); // same /64
    assert.equal((await rateLimit(env, lim, a1))?.code, "RATE_LIMIT_EXCEEDED");
    // request-reset-password: anonymous, 3 per hour
    const h = { "cf-connecting-ip": "198.51.100.7" };
    const p = { username: "user_a", email: "a@example.org" };
    for (let i = 0; i < 3; i++) assert.equal(await gate(env, "request-reset-password", { ...p }, h), null);
    assert.equal((await gate(env, "request-reset-password", { ...p }, h))?.status, 429);
    assert.equal(await gate({ ...env, ENABLE_IP_RATE_LIMIT: "false" }, "request-reset-password", { ...p }, h), null);
    // as upstream, an unknown token fails authentication before the rate limit
    assert.equal((await gate(env, "request-reset-password", { ...p, i: "zzzzzzzzzzzzzzzz" }, h))?.status, 401);
  });

  it("disabled without the binding or with RATE_LIMIT=off", async () => {
    assert.equal(await gate(f.env, "i/export-mute", { i: TOK.a }), null);
    assert.equal(await gate({ ...env, RATE_LIMIT: "off" }, "i/export-mute", { i: TOK.a }), null);
  });

  it("router returns the 429 before the handler runs", async () => {
    const r = await dispatchApi(new Request("https://api.test/api/i/export-mute", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ i: TOK.a }) }), env);
    assert.equal(r.status, 429);
  });

  it("signin-flow: 1 attempt per second per IP → TOO_MANY_AUTHENTICATION_FAILURES", async () => {
    const call = () => dispatchApi(new Request("https://api.test/api/signin-flow", {
      method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": "192.0.2.50" }, body: JSON.stringify({ username: "user_a" }),
    }), env);
    assert.equal((await call()).status, 200);
    const r = await call();
    assert.equal(r.status, 429);
    assert.equal(((await r.json()) as any).error.id, "22d05606-fbcf-421a-a2db-b32610dcfd1b");
  });

  it("RateLimiter DO: refused requests are logged, windows expire, alarm clears", async () => {
    const store = new Map<string, unknown>();
    let alarm = 0;
    const rl = new RateLimiter({ storage: {
      get: async (k: string) => store.get(k) as any, put: async (k: string, v: unknown) => void store.set(k, v),
      delete: async (k: string) => store.delete(k), list: async () => new Map([...store.entries()].filter(([k]) => k.startsWith("w:"))) as any,
      getAlarm: async () => alarm || null, setAlarm: async (t: number) => void (alarm = t),
    } });
    const hit = async (w: { id: string; duration: number; max: number }[]) => (await rpcStub(rl).limit(w)) as any;
    const w = [{ id: "k", duration: 50, max: 1 }];
    assert.equal((await hit(w)).limited, false);
    assert.ok(alarm > Date.now());
    assert.equal((await hit(w)).limited, true);
    await new Promise((r) => setTimeout(r, 60));
    assert.equal((await hit(w)).limited, false);
    // the first full window stops the check: the second window is not logged
    await hit([{ id: "a", duration: 10_000, max: 1 }]);
    const r = await hit([{ id: "a", duration: 10_000, max: 1 }, { id: "b", duration: 10_000, max: 5 }]);
    assert.deepEqual([r.limited, r.index], [true, 0]);
    assert.equal(store.has("w:b"), false);
    await rl.alarm();
    assert.equal(store.size, 0);
  });

  it("RateLimiter DO: a short window does not pull the alarm in front of a longer window's log", async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: 1_700_000_000_000 });
    const storage = testDoStorage();
    let alarmWrites = 0;
    const setAlarm = storage.setAlarm;
    storage.setAlarm = async (at: number) => { alarmWrites++; await setAlarm(at); };
    const rl = new RateLimiter({ storage } as never);
    // the alarm fires once its time has come, like the runtime does
    const advance = async (ms: number) => {
      t.mock.timers.tick(ms);
      const at = await storage.getAlarm();
      if (at != null && at <= Date.now()) { await storage.deleteAlarm(); await rl.alarm(); }
    };
    const signin = [{ id: "signin:min", duration: 1_000, max: 1 }, { id: "signin", duration: 3_600_000, max: 10 }];
    const rss = [{ id: "fetch-rss", duration: 60_000, max: 300 }];
    for (let i = 0; i < 10; i++) {
      assert.equal((await rl.limit(signin)).limited, false, `attempt ${i + 1}`);
      await advance(1_001);
    }
    assert.equal((await rl.limit(signin)).limited, true, "11th attempt within the hour");
    // an unrelated anonymous endpoint with a 60 s window, then a few minutes pass
    assert.equal((await rl.limit(rss)).limited, false);
    await advance(5 * 60_000);
    assert.equal((await rl.limit(signin)).limited, true, "the hourly signin window still holds");
    // repeated calls to the same window keep the alarm instead of rewriting it every time
    alarmWrites = 0;
    for (let i = 0; i < 20; i++) await rl.limit(rss);
    assert.equal(alarmWrites, 0);
    // once every window has expired the alarm clears the logs
    await advance(3 * 3_600_000);
    assert.equal(await storage.getAlarm(), null);
    assert.deepEqual([...(await storage.list({ prefix: "w:" })).keys()], []);
    assert.equal((await rl.limit(signin)).limited, false);
  });
});
