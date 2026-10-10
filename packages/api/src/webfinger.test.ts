/**
 * WebFinger `self` resolution: redirects only to a WebFinger URL for the same resource,
 * the subject must be the account asked for, and `self` must be on the asked host or the host
 * that answered — never this server.
 */
import { before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ApiEnv } from "./env.js";
import { makeFixture, type Fixture } from "./pglite-fixture.js";
import { webfingerSelf } from "./ap/remote.js";
import { resolveUserIdByAcct } from "./remote-user-resolve.js";

let f: Fixture;
const routes = new Map<string, () => Response>();
const requested: string[] = [];
before(async () => {
  f = await makeFixture("WebfingerTest");
  f.env.AP_FETCH = (async (url: string) => {
    requested.push(url);
    const r = routes.get(url);
    return r ? r() : new Response("not found", { status: 404 });
  }) as unknown as ApiEnv["AP_FETCH"];
});
beforeEach(() => {
  routes.clear();
  requested.length = 0;
});

const wf = (acct: string, host = acct.split("@")[1]) => `https://${host}/.well-known/webfinger?resource=${encodeURIComponent(`acct:${acct}`)}`;
const jrd = (subject: string | null, self: string) => () =>
  Response.json({ ...(subject ? { subject } : {}), links: [{ rel: "self", type: "application/activity+json", href: self }] }, { headers: { "content-type": "application/jrd+json" } });
const redirect = (to: string) => () => new Response(null, { status: 301, headers: { location: to } });

describe("webfingerSelf", () => {
  it("the self link on the asked host", async () => {
    routes.set(wf("alice@honest.example"), jrd("acct:alice@honest.example", "https://honest.example/users/alice"));
    assert.equal(await webfingerSelf(f.env, "alice@honest.example"), "https://honest.example/users/alice");
  });

  it("a domain that serves WebFinger from another host (Mastodon WEB_DOMAIN)", async () => {
    routes.set(wf("user@example.com"), redirect(wf("user@example.com", "social.example.com")));
    routes.set(wf("user@example.com", "social.example.com"), jrd("acct:user@example.com", "https://social.example.com/users/user"));
    assert.equal(await webfingerSelf(f.env, "user@example.com"), "https://social.example.com/users/user");
  });

  it("refuses a redirect off WebFinger or to another resource, before following it", async () => {
    routes.set(wf("alice@honest.example"), redirect("https://evil.example/anything"));
    await assert.rejects(webfingerSelf(f.env, "alice@honest.example"), /unsafe url/);
    routes.set(wf("alice@honest.example"), redirect(wf("mallory@evil.example")));
    await assert.rejects(webfingerSelf(f.env, "alice@honest.example"), /unsafe url/);
    assert.ok(!requested.some((u) => u.includes("evil.example")));
  });

  it("refuses a subject for another account", async () => {
    routes.set(wf("alice@honest.example"), jrd("acct:mallory@honest.example", "https://honest.example/users/mallory"));
    await assert.rejects(webfingerSelf(f.env, "alice@honest.example"), /subject mismatch/);
  });

  it("refuses a self link on a third host", async () => {
    routes.set(wf("alice@honest.example"), jrd("acct:alice@honest.example", "https://evil.example/users/mallory"));
    await assert.rejects(webfingerSelf(f.env, "alice@honest.example"), /another host/);
  });

  it("refuses a self link to this server (upstream would return the local user)", async () => {
    const local = `${f.env.INSTANCE_URL}/users/${f.ids.a}`;
    routes.set(wf("alice@honest.example"), jrd(null, local));
    await assert.rejects(webfingerSelf(f.env, "alice@honest.example"), /bad self link/);
    await assert.rejects(resolveUserIdByAcct(f.env, "alice", "honest.example"));
  });
});
