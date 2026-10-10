/**
 * Reversi on PG (PGlite): matchmaking (Reversi DO `match`), reversi/* endpoints, the
 * `reversiGame` channel operations through the Reversi DO (ready → alarm → started, putStone,
 * claimTimeIsUp, cancel, updateSettings), publishes to `reversi` / `reversiGame:{id}`
 * subscribers, StreamHub forwarding of channel frames, and the ported engine.
 */
import { before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { StreamHub, StreamPresence, parseChannelFrame } from "../../stream/src/index.js";
import { streamShardId } from "@misskey-cf/shared";
import { IMPLEMENTED_ENDPOINTS } from "./registry.js";
import { makeFixture, type Fixture } from "./pglite-fixture.js";
import type { ApiEnv } from "./env.js";
import { Reversi, applyMatchOp, checkTimeout, emptyMatchState, forwardReversiFrame } from "./reversi-pg.js";
import { EIGHTEIGHT, Game, crc32Str, restoreGame, serializeLogs } from "./reversi/engine.js";
import { testDoStorage } from "../../shared/src/test-do-storage.js";
import { ENDPOINT_PARAM_DEFS } from "./endpoint-params.gen.js";
import { rpcStub, recordingHubNamespace } from "../../shared/src/testing/do-namespace.js";

// ---- fakes: presence (real class), hubs (capture), Reversi DO (real class, manual alarm)
const presenceInst = new Map<string, StreamPresence>();
const presence = {
  idFromName: (n: string) => ({ toString: () => n }),
  get(id: { toString(): string }) {
    const k = id.toString();
    if (!presenceInst.has(k)) {
      presenceInst.set(k, new StreamPresence({ storage: testDoStorage() }));
    }
    return rpcStub(presenceInst.get(k)!);
  },
};
const hubCalls: { userId: string; channel: string; type: string; body: any }[] = [];
const hub = recordingHubNamespace((userId, _path, b) => hubCalls.push({ userId, channel: b.channel, type: b.type, body: b.body }));
const reversiInst = new Map<string, { obj: Reversi; alarm: number | null; store: Map<string, unknown> }>();
let envRef: ApiEnv;
const reversiNs = {
  idFromName: (n: string) => ({ toString: () => n }),
  get(id: { toString(): string }) {
    const k = id.toString();
    if (!reversiInst.has(k)) {
      const store = new Map<string, unknown>();
      const slot = { obj: null as unknown as Reversi, alarm: null as number | null, store };
      slot.obj = new Reversi(
        { storage: { get: async (x: string) => store.get(x) as any, put: async (x: string, v: unknown) => void store.set(x, structuredClone(v)), setAlarm: async (t: number) => void (slot.alarm = t) } },
        envRef,
      );
      reversiInst.set(k, slot);
    }
    return rpcStub(reversiInst.get(k)!.obj);
  },
};

let f: Fixture;
before(async () => {
  f = await makeFixture("ReversiTest", {
    STREAM_HUB: hub as unknown as ApiEnv["STREAM_HUB"],
    STREAM_PRESENCE: presence as unknown as ApiEnv["STREAM_PRESENCE"],
    REVERSI: reversiNs as unknown as ApiEnv["REVERSI"],
    STREAM_SHARD_COUNT: "4",
  });
  envRef = f.env;
});
beforeEach(() => void (hubCalls.length = 0));

const E = (r: { data: any }) => r.data?.error?.id;
const row = async (id: string) => (await f.db.query(`SELECT * FROM reversi_game WHERE id = $1`, [id])).rows[0] as any;
const watch = (userId: string, gameId: string) =>
  presence.get(presence.idFromName(streamShardId(userId, 4))).set(userId, [`reversiGame:${gameId}`]);
const frame = (gameId: string, userId: string, type: string, body: unknown) =>
  reversiNs.get(reversiNs.idFromName(`game:${gameId}`)).fetch("https://r/frame", { method: "POST", body: JSON.stringify({ gameId, userId, type, body }) });
const events = (type: string) => hubCalls.filter((c) => c.type === type);

describe("reversi engine (misskey-reversi port)", () => {
  it("crc32 matches crc-32 CRC32.str", () => {
    assert.equal(crc32Str("123456789"), -873187034);
    assert.equal(crc32Str(""), 0);
  });

  it("plays, serializes and restores", () => {
    const g = new Game(EIGHTEIGHT, { isLlotheo: false, canPutEverywhere: false, loopedBoard: false });
    assert.equal(g.turn, true);
    assert.deepEqual(g.getPuttablePlaces(true), [19, 26, 37, 44]);
    g.putStone(19);
    assert.equal(g.turn, false);
    assert.deepEqual([g.blackCount, g.whiteCount], [4, 1]);
    const logs = serializeLogs([{ time: 1000, player: true, operation: "put", pos: 19 }]);
    const r = restoreGame({ map: EIGHTEIGHT, isLlotheo: false, canPutEverywhere: false, loopedBoard: false, logs });
    assert.equal(r.calcCrc32(), g.calcCrc32());
  });
});

describe("matchmaking store", () => {
  it("specific invitations, any-queue and expiry", () => {
    const s = emptyMatchState();
    assert.deepEqual(applyMatchOp(s, { op: "specific", me: "a", target: "b" }, 1000), {});
    assert.deepEqual(applyMatchOp(s, { op: "invitations", me: "b" }, 2000), { ids: ["a"] });
    assert.deepEqual(applyMatchOp(s, { op: "invitations", me: "b" }, 22_000), { ids: [] }); // 20s window
    applyMatchOp(s, { op: "specific", me: "a", target: "b" }, 30_000);
    assert.deepEqual(applyMatchOp(s, { op: "specific", me: "b", target: "a" }, 31_000), { matchedWith: "a", noIrregularRules: false });
    assert.deepEqual(applyMatchOp(s, { op: "invitations", me: "b" }, 31_000), { ids: [] });
    // any: first queues, second matches (noIrregularRules is sticky from either side)
    assert.deepEqual(applyMatchOp(s, { op: "any", me: "c", noIrregularRules: true }, 40_000), {});
    assert.deepEqual(applyMatchOp(s, { op: "any", me: "c", noIrregularRules: true }, 40_001), {}); // not with myself
    assert.deepEqual(applyMatchOp(s, { op: "any", me: "d", noIrregularRules: false }, 41_000), { matchedWith: "c", noIrregularRules: true });
    assert.deepEqual(s.any, {});
    applyMatchOp(s, { op: "any", me: "c", noIrregularRules: false }, 50_000);
    applyMatchOp(s, { op: "cancelAny", me: "c" }, 50_001);
    assert.deepEqual(applyMatchOp(s, { op: "any", me: "d", noIrregularRules: false }, 50_002), {});
    assert.deepEqual(applyMatchOp(s, { op: "any", me: "e", noIrregularRules: false }, 70_000), {}); // d's entry expired (15s)
  });

  it("expiry is per Redis key (expire NX from the first entry), not per entry", () => {
    const s = emptyMatchState();
    // matchAny: c queues at 200s (key TTL → 215s); re-queueing at 210s does not extend it
    applyMatchOp(s, { op: "any", me: "c", noIrregularRules: false }, 200_000);
    applyMatchOp(s, { op: "any", me: "c", noIrregularRules: false }, 210_000);
    assert.deepEqual(applyMatchOp(s, { op: "any", me: "d", noIrregularRules: false }, 216_000), {}); // queue gone with its key
    assert.deepEqual(applyMatchOp(s, { op: "any", me: "e", noIrregularRules: false }, 217_000), { matchedWith: "d", noIrregularRules: false });
    // matchSpecific:{b}: TTL 120s from the first invitation; a newer invitation inside the 20s window still goes with the key
    applyMatchOp(s, { op: "specific", me: "a", target: "b" }, 1_000);
    applyMatchOp(s, { op: "specific", me: "a", target: "b" }, 110_000);
    assert.deepEqual(applyMatchOp(s, { op: "invitations", me: "b" }, 120_000), { ids: ["a"] });
    assert.deepEqual(applyMatchOp(s, { op: "invitations", me: "b" }, 121_500), { ids: [] });
    // a key emptied by ZREM loses its TTL: a new invitation starts a fresh 120s
    applyMatchOp(s, { op: "specific", me: "a", target: "x" }, 300_000);
    applyMatchOp(s, { op: "cancelSpecific", me: "a", target: "x" }, 301_000);
    applyMatchOp(s, { op: "specific", me: "a", target: "x" }, 410_000);
    assert.deepEqual(applyMatchOp(s, { op: "invitations", me: "x" }, 421_000), { ids: ["a"] });
  });
});

describe("reversi endpoints + game channel", () => {
  it("registers endpoints", () => {
    for (const e of ["reversi/cancel-match", "reversi/games", "reversi/invitations", "reversi/match", "reversi/show-game", "reversi/surrender", "reversi/verify"]) {
      assert.ok((IMPLEMENTED_ENDPOINTS as readonly string[]).includes(e), e);
      assert.ok(ENDPOINT_PARAM_DEFS[e], e);
    }
  });

  let gameId = "";

  it("reversi/match (specific): invite, invitations, matched", async () => {
    assert.equal((await f.call("reversi/match", {})).status, 401);
    assert.equal(E(await f.call("reversi/match", { userId: f.ids.a }, "a")), "96fd7bd6-d2bc-426c-a865-d055dcd2828e");
    assert.equal(E(await f.call("reversi/match", { userId: "nope" }, "a")), "0b4f0559-b484-4e31-9581-3f73cee89b28");
    assert.equal((await f.call("reversi/match", { userId: f.ids.b }, "a")).status, 204);
    assert.deepEqual(events("invited").map((c) => [c.userId, c.channel, c.body.user.id]), [[f.ids.b, "reversi", f.ids.a]]);
    assert.deepEqual((await f.call("reversi/invitations", {}, "b")).data.map((u: any) => u.id), [f.ids.a]);
    const m = await f.call("reversi/match", { userId: f.ids.a }, "b");
    assert.equal(m.status, 200);
    gameId = m.data.id;
    assert.deepEqual([m.data.user1Id, m.data.user2Id, m.data.user1.id, m.data.isStarted, m.data.bw, m.data.timeLimitForEachTurn], [f.ids.a, f.ids.b, f.ids.a, false, "random", 90]);
    assert.deepEqual(m.data.map, EIGHTEIGHT);
    assert.deepEqual(m.data.logs, []);
    assert.deepEqual(events("matched").map((c) => [c.userId, c.channel, c.body.game.id]), [[f.ids.a, "reversi", gameId]]);
    assert.deepEqual((await f.call("reversi/invitations", {}, "b")).data, []);
    // an unstarted game between the two within 3 minutes is returned again
    assert.equal((await f.call("reversi/match", { userId: f.ids.b }, "a")).data.id, gameId);
    // cancel-match removes my pending invitation
    await f.call("reversi/match", { userId: f.ids.c }, "a");
    assert.equal((await f.call("reversi/invitations", {}, "c")).data.length, 1);
    assert.equal((await f.call("reversi/cancel-match", { userId: f.ids.c }, "a")).status, 204);
    assert.deepEqual((await f.call("reversi/invitations", {}, "c")).data, []);
  });

  it("show-game / verify / games before start", async () => {
    const s = await f.call("reversi/show-game", { gameId });
    assert.deepEqual(Object.keys(s.data), ["id", "createdAt", "startedAt", "endedAt", "isStarted", "isEnded", "form1", "form2", "user1Ready", "user2Ready", "user1Id", "user2Id", "user1", "user2", "winnerId", "winner", "surrenderedUserId", "timeoutUserId", "black", "bw", "isLlotheo", "canPutEverywhere", "loopedBoard", "timeLimitForEachTurn", "noIrregularRules", "logs", "map"]);
    assert.equal(E(await f.call("reversi/show-game", { gameId: "nope" })), "f13a03db-fae1-46c9-87f3-43c8165419e1");
    // as upstream: checkCrc throws a plain Error → INTERNAL_ERROR (the declared NO_SUCH_GAME is unused)
    const v = await f.call("reversi/verify", { gameId: "nope", crc32: "1" });
    assert.deepEqual([v.status, E(v)], [500, "5d37dbcb-891e-41ca-a3d6-e690c97775ac"]);
    assert.equal((await f.call("reversi/verify", { gameId, crc32: "1" })).data.desynced, true);
    assert.deepEqual((await f.call("reversi/games", {})).data, []); // only started games publicly
    const mine = (await f.call("reversi/games", { my: true }, "b")).data;
    assert.deepEqual(mine.map((g: any) => g.id), [gameId]);
    assert.equal("logs" in mine[0], false); // Lite
  });

  it("updateSettings / ready → alarm → started", async () => {
    await watch(f.ids.a, gameId);
    await watch(f.ids.c, gameId); // a spectator
    await frame(gameId, f.ids.a, "updateSettings", { key: "timeLimitForEachTurn", value: 30 });
    await frame(gameId, f.ids.a, "updateSettings", { key: "bw", value: "nope" }); // invalid → ignored
    await frame(gameId, f.ids.c, "updateSettings", { key: "isLlotheo", value: true }); // not a player
    assert.equal((await row(gameId)).timeLimitForEachTurn, 30);
    assert.equal((await row(gameId)).isLlotheo, false);
    assert.deepEqual(events("updateSettings").map((c) => [c.userId, c.body]).sort(), [
      [f.ids.a, { userId: f.ids.a, key: "timeLimitForEachTurn", value: 30 }],
      [f.ids.c, { userId: f.ids.a, key: "timeLimitForEachTurn", value: 30 }],
    ].sort());
    await frame(gameId, f.ids.a, "ready", true);
    await frame(gameId, f.ids.a, "updateSettings", { key: "bw", value: "1" }); // ready → locked
    assert.equal((await row(gameId)).bw, "random");
    const slot = reversiInst.get(`game:${gameId}`)!;
    assert.equal(slot.alarm, null);
    await frame(gameId, f.ids.b, "ready", true);
    assert.deepEqual(events("changeReadyStates").at(-1)!.body, { user1: true, user2: true });
    assert.ok(slot.alarm! > Date.now() + 2000);
    hubCalls.length = 0;
    await slot.obj.alarm();
    const g = await row(gameId);
    assert.equal(g.isStarted, true);
    assert.ok(g.black === 1 || g.black === 2);
    assert.equal(g.crc32, String(new Game(EIGHTEIGHT, { isLlotheo: false, canPutEverywhere: false, loopedBoard: false }).calcCrc32()));
    assert.equal(events("started").length, 2);
    assert.equal(events("started")[0]!.body.game.isStarted, true);
    assert.equal((await f.call("reversi/games", {})).data.length, 1);
  });

  it("putStone / verify / claimTimeIsUp", async () => {
    const g = await row(gameId);
    const blackUser = g.black === 1 ? f.ids.a : f.ids.b;
    const whiteUser = g.black === 1 ? f.ids.b : f.ids.a;
    await frame(gameId, whiteUser, "putStone", { pos: 19, id: "x" }); // not your turn
    await frame(gameId, blackUser, "putStone", { pos: 0, id: "x" }); // cannot put there
    assert.deepEqual((await row(gameId)).logs, []);
    await frame(gameId, blackUser, "putStone", { pos: 19, id: "m1" });
    const after = await row(gameId);
    assert.equal(after.logs.length, 1);
    assert.deepEqual(after.logs[0].slice(1), [1, 0, 19]);
    assert.deepEqual(events("log").map((c) => [c.body.pos, c.body.player, c.body.operation, c.body.id]), [[19, true, "put", "m1"], [19, true, "put", "m1"]]);
    const engine = restoreGame({ map: EIGHTEIGHT, isLlotheo: false, canPutEverywhere: false, loopedBoard: false, logs: after.logs });
    assert.deepEqual((await f.call("reversi/verify", { gameId, crc32: String(engine.calcCrc32()) })).data, { desynced: false });
    // not timed out yet
    await frame(gameId, blackUser, "claimTimeIsUp", null);
    assert.equal((await row(gameId)).isEnded, false);
    // white's 30s run out → black wins by timeout
    hubCalls.length = 0;
    await checkTimeout(f.env, gameId, Date.now() + 31_000);
    const ended = await row(gameId);
    assert.deepEqual([ended.isEnded, ended.winnerId, ended.timeoutUserId, ended.surrenderedUserId], [true, blackUser, whiteUser, null]);
    assert.deepEqual(events("ended")[0]!.body.winnerId, blackUser);
    assert.equal(events("ended")[0]!.body.game.winner.id, blackUser);
    assert.equal(E(await f.call("reversi/surrender", { gameId }, "a")), "6c2ad4a6-cbf1-4a5b-b187-b772826cfc6d");
  });

  it("updateSettings values the row cannot hold are broadcast but keep the game from starting (upstream's failing bake)", async () => {
    const id = (await f.call("reversi/match", { userId: f.ids.c, multiple: true }, "a")).status === 204
      ? (await f.call("reversi/match", { userId: f.ids.a, multiple: true }, "c")).data.id
      : null;
    assert.ok(id);
    await watch(f.ids.a, id);
    hubCalls.length = 0;
    await frame(id, f.ids.a, "updateSettings", { key: "timeLimitForEachTurn", value: 100000 }); // > smallint
    assert.deepEqual(events("updateSettings").map((c) => c.body), [{ userId: f.ids.a, key: "timeLimitForEachTurn", value: 100000 }]);
    assert.equal((await row(id)).timeLimitForEachTurn, 90);
    await frame(id, f.ids.a, "ready", true);
    await frame(id, f.ids.c, "ready", true);
    const slot = reversiInst.get(`game:${id}`)!;
    await slot.obj.alarm();
    assert.equal((await row(id)).isStarted, false);
    // a fitting value for the same key (as upstream, once the cached value can be baked) lets it start
    await frame(id, f.ids.a, "ready", false);
    await frame(id, f.ids.a, "updateSettings", { key: "timeLimitForEachTurn", value: 60 });
    await frame(id, f.ids.a, "ready", true);
    await slot.obj.alarm();
    assert.equal((await row(id)).isStarted, true);
    await frame(id, f.ids.a, "updateSettings", { key: "map", value: [] }); // started → ignored
  });

  it("claimTimeIsUp on an unstarted game ends it (no turn timer yet, as upstream)", async () => {
    await f.call("reversi/match", { userId: f.ids.b, multiple: true }, "c");
    const id = (await f.call("reversi/match", { userId: f.ids.c, multiple: true }, "b")).data.id;
    await frame(id, f.ids.b, "claimTimeIsUp", null);
    const g = await row(id);
    assert.deepEqual([g.isStarted, g.isEnded, g.winnerId, g.timeoutUserId], [false, true, g.user1Id, g.user2Id]);
  });

  it("reversi/match (any) / surrender / cancel", async () => {
    assert.equal((await f.call("reversi/match", { noIrregularRules: true, multiple: true }, "b")).status, 204);
    const m = await f.call("reversi/match", { multiple: true }, "c");
    assert.deepEqual([m.data.user1Id, m.data.user2Id, m.data.noIrregularRules], [f.ids.b, f.ids.c, true]);
    const id = m.data.id;
    assert.equal(E(await f.call("reversi/surrender", { gameId: "nope" }, "a")), "ace0b11f-e0a6-4076-a30d-e8284c81b2df");
    assert.equal(E(await f.call("reversi/surrender", { gameId: id }, "a")), "6e04164b-a992-4c93-8489-2123069973e1");
    await watch(f.ids.b, id);
    assert.equal((await f.call("reversi/surrender", { gameId: id }, "c")).status, 204);
    const s = await row(id);
    assert.deepEqual([s.isEnded, s.winnerId, s.surrenderedUserId], [true, f.ids.b, f.ids.c]);
    assert.equal(events("ended").length, 1);
    // cancel (a `cancel` frame) deletes an unstarted game
    const m2 = await f.call("reversi/match", { multiple: true }, "a");
    assert.equal(m2.status, 204);
    const id2 = (await f.call("reversi/match", { multiple: true }, "b")).data.id;
    await watch(f.ids.a, id2);
    hubCalls.length = 0;
    await frame(id2, f.ids.c, "cancel", null); // not a player
    assert.ok(await row(id2));
    await frame(id2, f.ids.b, "cancel", null);
    assert.equal(await row(id2), undefined);
    assert.deepEqual(events("canceled").map((c) => [c.userId, c.body]), [[f.ids.a, { userId: f.ids.b }]]);
  });

  it("StreamHub forwards reversiGame channel frames to the Reversi DO through ApiInternal", async () => {
    const subs = { "7": `reversiGame:g1`, "8": "main" };
    assert.deepEqual(parseChannelFrame(subs, JSON.stringify({ type: "channel", body: { id: "7", type: "putStone", body: { pos: 1, id: "z" } } })), { key: "reversiGame:g1", type: "putStone", body: { pos: 1, id: "z" } });
    assert.equal(parseChannelFrame(subs, JSON.stringify({ type: "channel", body: { id: "9", type: "x" } })), null);
    const forwarded: { name: string; body: any }[] = [];
    const ns = {
      idFromName: (n: string) => ({ toString: () => n }),
      get: (id: { toString(): string }) => ({
        fetch: async (_i: RequestInfo | URL, init?: RequestInit) => {
          forwarded.push({ name: id.toString(), body: JSON.parse(String(init?.body)) });
          return Response.json({ ok: true });
        },
      }),
    };
    // ApiInternal.reversiFrame (worker.ts) → forwardReversiFrame against the api worker's REVERSI
    const apiEnv = { REVERSI: ns } as unknown as ApiEnv;
    const API_INTERNAL = {
      touchLastActiveDate: async () => {},
      reversiFrame: (gameId: string, userId: string, type: string, body: unknown) => forwardReversiFrame(apiEnv, gameId, userId, type, body),
    };
    const hubDo = new StreamHub({ id: { toString: () => "user:u1" }, acceptWebSocket() {}, getWebSockets: () => [] }, { API_INTERNAL });
    let att: any = { userId: "u1", subs: {} };
    const ws = { send() {}, close() {}, serializeAttachment: (v: unknown) => void (att = v), deserializeAttachment: () => att };
    await hubDo.webSocketMessage(ws, JSON.stringify({ type: "connect", body: { channel: "reversiGame", id: "1", params: { gameId: "g1" } } }));
    await hubDo.webSocketMessage(ws, JSON.stringify({ type: "connect", body: { channel: "reversi", id: "2" } }));
    assert.deepEqual(att.subs, { "1": "reversiGame:g1", "2": "reversi" });
    await hubDo.webSocketMessage(ws, JSON.stringify({ type: "channel", body: { id: "1", type: "ready", body: true } }));
    await hubDo.webSocketMessage(ws, JSON.stringify({ type: "channel", body: { id: "2", type: "ready", body: true } })); // not forwarded
    assert.deepEqual(forwarded, [{ name: "game:g1", body: { gameId: "g1", userId: "u1", type: "ready", body: true } }]);
  });
});
