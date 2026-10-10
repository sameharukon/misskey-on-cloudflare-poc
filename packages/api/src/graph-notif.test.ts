import { describe, it } from "node:test";
import assert from "node:assert/strict";
import worker from "./index.js";
import type { ApiEnv } from "./env.js";
import { fixtureMeta } from "../../packers/src/fixtures.js";
import { NotificationBox } from "../../timeline/src/index.js";
import {
  createNotification,
  extractLocalMentions,
  listNotifications,
  markAllNotificationsRead,
} from "./notifications-do.js";
import { relationC, isBlockingC, isMutingC } from "./graph-pg.js";
import type { PgQueryable } from "./pg.js";
import { IMPLEMENTED_ENDPOINTS } from "./registry.js";
import { buildFanoutMessage, streamExtras } from "./queues/fanout.js";
import { isPureRenote } from "./notes-pg.js";
import { testDoStorage } from "../../shared/src/test-do-storage.js";
import { rpcStub } from "../../shared/src/testing/do-namespace.js";

function env(): ApiEnv {
  return {
    INSTANCE_URL: "https://misskey.example.com",
    VERSION: "0.0.0-test",
    BOOTSTRAP_META_JSON: JSON.stringify(fixtureMeta({ name: "GraphNotif" })),
  };
}

function memState() {
  return { id: { toString: () => "do-test" }, storage: testDoStorage() };
}

/** NotificationBox namespace stub backed by real DO instances in memory. */
function notifNs() {
  const boxes = new Map<string, NotificationBox>();
  return {
    idFromName: (n: string) => ({ toString: () => n }),
    get: (id: { toString(): string }) => {
      let b = boxes.get(id.toString());
      if (!b) {
        b = new NotificationBox(memState());
        boxes.set(id.toString(), b);
      }
      const box = b;
      return rpcStub(box);
    },
    boxes,
  };
}

describe("NotificationBox DO", () => {
  it("push/list newest-first, types filter, read cursor", async () => {
    const box = new NotificationBox(memState());
    const push = (id: string, type: string) =>
      box.push({ id, type, createdAt: "x" });
    await push("a1", "follow");
    await push("a3", "reaction");
    await push("a2", "mention");
    let j = await box.list({ limit: 10 });
    assert.deepEqual(j.items.map((x) => x.id), ["a3", "a2", "a1"]);
    assert.ok(j.items.every((x) => !x.isRead));
    j = await box.list({ types: ["mention", "follow"] });
    assert.deepEqual(j.items.map((x) => x.id), ["a2", "a1"]);
    await box.markAllRead();
    await push("a4", "reply");
    j = await box.list({ unreadOnly: true });
    assert.deepEqual(j.items.map((x) => x.id), ["a4"]);
    j = await box.list({ untilId: "a3" });
    assert.deepEqual(j.items.map((x) => x.id), ["a2", "a1"]);
  });
});

describe("notifications-do helpers", () => {
  it("extractLocalMentions keeps local, drops remote/emails", () => {
    assert.deepEqual(
      extractLocalMentions("hi @Admin and @bob@misskey.example.com, not @x@remote.tld nor a@b.c", "misskey.example.com"),
      ["admin", "bob"],
    );
    assert.deepEqual(extractLocalMentions(null, null), []);
  });

  it("createNotification via DO binding; skips self", async () => {
    const e = env();
    const ns = notifNs();
    e.NOTIFICATION_BOX = ns;
    assert.equal(await createNotification(e, "u1", { type: "follow", notifierId: "u1" }), null);
    await createNotification(e, "u1", { type: "follow", notifierId: "u2" });
    await createNotification(e, "u1", { type: "reaction", notifierId: "u2", noteId: "n1", reaction: "👍" });
    assert.ok(ns.boxes.has("notif:u1"));
    const rows = await listNotifications(e, "u1", { limit: 10 });
    assert.equal(rows.length, 2);
    assert.equal(rows[0]!.type, "reaction");
    const noFollow = await listNotifications(e, "u1", { limit: 10, excludeTypes: ["follow"] });
    assert.deepEqual(noFollow.map((r) => r.type), ["reaction"]);
    await markAllNotificationsRead(e, "u1");
    assert.equal((await listNotifications(e, "u1", { limit: 10, unreadOnly: true })).length, 0);
  });

  it("stores nothing without the DO binding", async () => {
    const e = env();
    assert.equal(await createNotification(e, "u9", { type: "mention", notifierId: "u2", noteId: "n2" }), null);
    assert.deepEqual(await listNotifications(e, "u9", { limit: 5 }), []);
  });
});

/** Fake PG: answers EXISTS-style queries from in-memory edge sets. */
function fakePg(edges: { following: [string, string][]; blocking: [string, string][]; muting: [string, string][]; requests: [string, string][]; renoteMuting?: [string, string][] }): PgQueryable {
  const has = (list: [string, string][], a: unknown, b: unknown) => list.some(([x, y]) => x === a && y === b);
  return {
    async query(text: string, params: unknown[] = []) {
      const [a, b] = params;
      let hit = false;
      if (/FROM following/.test(text)) hit = has(edges.following, a, b);
      else if (/FROM follow_request/.test(text)) hit = has(edges.requests, a, b);
      else if (/FROM blocking/.test(text)) hit = has(edges.blocking, a, b);
      else if (/FROM muting/.test(text)) hit = has(edges.muting, a, b);
      else if (/FROM renote_muting/.test(text)) hit = has(edges.renoteMuting ?? [], a, b);
      return { rows: hit ? [{ ok: 1 }] : [], rowCount: hit ? 1 : 0 };
    },
  };
}

describe("graph-pg relation (fake client)", () => {
  it("computes all relation flags", async () => {
    const c = fakePg({
      following: [["me", "you"]],
      blocking: [["you", "me"]],
      muting: [["me", "you"]],
      requests: [["you", "me"]],
      renoteMuting: [["me", "you"]],
    });
    const r = await relationC(c, "me", "you");
    assert.deepEqual(r, {
      id: "you",
      isFollowing: true,
      hasPendingFollowRequestFromYou: false,
      hasPendingFollowRequestToYou: true,
      isFollowed: false,
      isBlocking: false,
      isBlocked: true,
      isMuted: true,
      isRenoteMuted: true,
    });
    assert.equal(await isBlockingC(c, "you", "me"), true);
    assert.equal(await isMutingC(c, "you", "me"), false);
  });
});

describe("endpoint wiring", () => {
  it("registers new social endpoints", () => {
    for (const n of ["following/requests/cancel", "following/requests/sent", "i/update", "users/relation", "blocking/list", "mute/list", "renote-mute/create", "renote-mute/delete", "renote-mute/list"]) {
      assert.ok((IMPLEMENTED_ENDPOINTS as readonly string[]).includes(n), n);
    }
  });

  it("PG-only endpoints answer 501 offline; debug endpoint needs credential", async () => {
    const e = env();
    const call = (p: string, body: unknown, headers: Record<string, string> = {}) =>
      worker.fetch(
        new Request(`https://api.test/api/${p}`, {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: JSON.stringify(body),
        }),
        e,
        { waitUntil() {}, passThroughOnException() {} },
      );
    assert.equal((await call("following/requests/cancel", { userId: "x" })).status, 501);
    assert.equal((await call("i/update", { isLocked: true })).status, 501);
    assert.equal((await call("admin/cf-debug/timeline", { userId: "x" })).status, 401);
    assert.equal((await call("renote-mute/create", { userId: "x" })).status, 501);
    assert.equal((await call("admin/cf-debug/queues", {})).status, 401);
  });
});

describe("fanout stream extras", () => {
  it("packs note into fanout message (size-capped) with renote/related ids", () => {
    const pure = streamExtras({ renoteId: "r", text: null, fileIds: [], renoteUserId: "orig", replyUserId: null });
    assert.deepEqual(pure, { renoteOf: "orig", relatedUserIds: ["orig"] });
    const quote = streamExtras({ renoteId: "r", text: "hi", fileIds: [], renoteUserId: "orig" });
    assert.equal(quote.renoteOf, null);
    const m = buildFanoutMessage("n", ["global"], "create", { authorId: "a", packed: { id: "n" }, ...pure });
    assert.deepEqual(m.packed, { id: "n" });
    assert.equal(m.renoteOf, "orig");
    const big = buildFanoutMessage("n", ["global"], "create", { packed: { text: "x".repeat(70_000) } });
    assert.equal("packed" in big, false);
  });
  it("isPureRenote follows upstream (cw / files / poll make it a quote)", () => {
    assert.equal(isPureRenote({ renoteId: "r", text: null, fileIds: [] }), true);
    assert.equal(isPureRenote({ renoteId: "r", text: null, cw: "cw", fileIds: [] }), false);
    assert.equal(isPureRenote({ renoteId: "r", text: null, fileIds: ["f"] }), false);
    assert.equal(isPureRenote({ renoteId: null, text: null, fileIds: [] }), false);
  });
});
