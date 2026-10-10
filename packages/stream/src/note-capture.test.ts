/**
 * Note capture: s / sr / subNote / un / unsubNote parsing, per-socket ref counts with LRU
 * eviction, and StreamHub ↔ NoteWatch (real classes over in-memory storage, fake sockets):
 * user-level watch kept while any socket captures the note, released on unsubscribe / close,
 * and noteUpdated delivered only to capturing sockets.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyNoteOp, parseNoteFrame } from "./protocol.js";
import { NoteWatch, StreamHub, StreamPresence, noteWatchShard, streamShardId } from "./index.js";
import { LAST_ACTIVE_REFRESH_MS, PRESENCE_RESYNC_MS } from "./constants.js";
import { rpcStub } from "../../shared/src/testing/do-namespace.js";

function memStorage() {
  const m = new Map<string, unknown>();
  return {
    m,
    get: async <T,>(k: string) => m.get(k) as T | undefined,
    put: async (k: string, v: unknown) => void m.set(k, structuredClone(v)),
    delete: async (k: string) => m.delete(k),
  };
}

function nsOf<T extends object>(make: () => T) {
  const inst = new Map<string, T>();
  return {
    inst,
    idFromName: (n: string) => ({ toString: () => n }),
    get(id: { toString(): string }) {
      const k = id.toString();
      if (!inst.has(k)) inst.set(k, make());
      return rpcStub(inst.get(k)!);
    },
  };
}

class FakeSocket {
  sent: any[] = [];
  att: unknown = null;
  send(d: string) {
    this.sent.push(JSON.parse(d));
  }
  close() {}
  serializeAttachment(v: unknown) {
    this.att = structuredClone(v);
  }
  deserializeAttachment() {
    return this.att;
  }
}

describe("note capture protocol", () => {
  it("parses capture frames", () => {
    assert.deepEqual(parseNoteFrame(JSON.stringify({ type: "s", body: { id: "n1" } })), { op: "sub", noteId: "n1" });
    assert.deepEqual(parseNoteFrame(JSON.stringify({ type: "sr", body: { id: "n1" } })), { op: "sub", noteId: "n1" });
    assert.deepEqual(parseNoteFrame(JSON.stringify({ type: "subNote", body: { id: "n1" } })), { op: "sub", noteId: "n1" });
    assert.deepEqual(parseNoteFrame(JSON.stringify({ type: "un", body: { id: "n1" } })), { op: "unsub", noteId: "n1" });
    assert.deepEqual(parseNoteFrame(JSON.stringify({ type: "unsubNote", body: { id: "n1" } })), { op: "unsub", noteId: "n1" });
    assert.equal(parseNoteFrame(JSON.stringify({ type: "connect", body: { id: "x" } })), null);
    assert.equal(parseNoteFrame(JSON.stringify({ type: "s", body: {} })), null);
    assert.equal(parseNoteFrame("nope"), null);
  });

  it("ref counts and LRU eviction", () => {
    let r = applyNoteOp({}, { op: "sub", noteId: "a" }, 2);
    assert.deepEqual(r.added, ["a"]);
    r = applyNoteOp(r.notes, { op: "sub", noteId: "a" }, 2);
    assert.deepEqual([r.added, r.notes], [[], { a: 2 }]);
    r = applyNoteOp(r.notes, { op: "sub", noteId: "b" }, 2);
    r = applyNoteOp(r.notes, { op: "sub", noteId: "a" }, 2); // refresh a → b is oldest
    r = applyNoteOp(r.notes, { op: "sub", noteId: "c" }, 2);
    assert.deepEqual([r.added, r.removed, Object.keys(r.notes)], [["c"], ["b"], ["a", "c"]]);
    r = applyNoteOp(r.notes, { op: "unsub", noteId: "a" }, 2);
    assert.deepEqual([r.removed, r.notes.a], [[], 2]);
    r = applyNoteOp({ a: 1 }, { op: "unsub", noteId: "a" });
    assert.deepEqual([r.removed, r.notes], [["a"], {}]);
    assert.deepEqual(applyNoteOp({}, { op: "unsub", noteId: "z" }).removed, []);
  });
});

describe("StreamHub ↔ NoteWatch", () => {
  it("watch follows the union of a user's sockets; noteUpdated reaches capturing sockets only", async () => {
    const watch = nsOf(() => new NoteWatch({ storage: memStorage() }));
    const sockets: FakeSocket[] = [];
    const hubStorage = memStorage();
    const hub = new StreamHub(
      { id: { toString: () => "user:u1" }, acceptWebSocket: () => {}, getWebSockets: () => sockets as never, storage: hubStorage },
      { NOTE_WATCH: watch, STREAM_SHARD_COUNT: "4" },
    );
    const a = new FakeSocket();
    const b = new FakeSocket();
    a.serializeAttachment({ userId: "u1", subs: {}, sid: "sa" });
    b.serializeAttachment({ userId: "u1", subs: {}, sid: "sb" });
    sockets.push(a, b);
    const lookup = async (noteId: string) => {
      return watch.get(watch.idFromName(noteWatchShard(noteId, 4))).lookup(noteId);
    };
    await hub.webSocketMessage(a as never, JSON.stringify({ type: "s", body: { id: "n1" } }));
    await hub.webSocketMessage(b as never, JSON.stringify({ type: "sr", body: { id: "n1" } }));
    await hub.webSocketMessage(b as never, JSON.stringify({ type: "s", body: { id: "n2" } }));
    assert.deepEqual(await lookup("n1"), ["u1"]);
    assert.deepEqual(await lookup("n2"), ["u1"]);

    const publish = (id: string) => rpcStub(hub).noteUpdated(id, "reacted", { reaction: "👍", emoji: null, userId: "u2" });
    assert.equal(await publish("n2"), 1);
    assert.deepEqual(b.sent.at(-1), { type: "noteUpdated", body: { id: "n2", type: "reacted", body: { reaction: "👍", emoji: null, userId: "u2" } } });
    assert.equal(a.sent.length, 0);

    // a drops n1 but b still has it → still watched
    await hub.webSocketMessage(a as never, JSON.stringify({ type: "un", body: { id: "n1" } }));
    assert.deepEqual(await lookup("n1"), ["u1"]);
    assert.equal(await publish("n1"), 1);
    // b closes → nothing captures n1 / n2 any more
    sockets.splice(sockets.indexOf(b), 1);
    await hub.webSocketClose(b as never, 1000);
    assert.deepEqual(await lookup("n1"), []);
    assert.deepEqual(await lookup("n2"), []);
    assert.equal(hubStorage.m.has("notes:sb"), false);
    // channel frames still go through the channel path
    await hub.webSocketMessage(a as never, JSON.stringify({ type: "connect", body: { channel: "main", id: "c1" } }));
    assert.deepEqual((a.deserializeAttachment() as any).subs, { c1: "main" });
  });
});

describe("StreamHub lastActiveDate refresh", () => {
  it("arms a 5-minute alarm on connect and refreshes each connected user through ApiInternal while sockets are open", async () => {
    const sockets: FakeSocket[] = [];
    const base = memStorage();
    let alarm: number | null = null;
    const storage = { ...base, getAlarm: async () => alarm, setAlarm: async (t: number) => void (alarm = t) };
    const touched: string[] = [];
    const hub = new StreamHub(
      { id: { toString: () => "user:u1" }, acceptWebSocket: (ws: any) => void sockets.push(ws), getWebSockets: () => sockets as never, storage },
      { API_INTERNAL: { touchLastActiveDate: async (id: string) => void touched.push(id), reversiFrame: async () => {} } },
    );
    // WebSocketPair is a Workers runtime global; Node's Response also rejects status 101, so only the hub state is checked
    (globalThis as any).WebSocketPair = class { 0 = new FakeSocket(); 1 = new FakeSocket(); };
    const connect = () => hub.fetch(new Request("https://stream.internal/connect", { headers: { Upgrade: "websocket", "x-mk-user-id": "u1" } })).catch(() => null);
    const t0 = Date.now();
    await connect();
    assert.equal(sockets.length, 1);
    assert.ok(alarm! >= t0 + LAST_ACTIVE_REFRESH_MS);
    const armed = alarm;
    await connect(); // a pending alarm is kept
    assert.equal(alarm, armed);

    alarm = null; // fired
    await hub.alarm();
    assert.deepEqual(touched, ["u1"]);
    assert.ok(alarm! >= Date.now() + LAST_ACTIVE_REFRESH_MS - 1000);

    // every socket gone → no refresh, no re-arm (the next connect arms it again)
    sockets.length = 0;
    alarm = null;
    await hub.alarm();
    assert.deepEqual(touched, ["u1"]);
    assert.equal(alarm, null);
    delete (globalThis as any).WebSocketPair;
  });
});

describe("StreamHub presence / NoteWatch resync", () => {
  it("registers an open connection again every 12 hours, so it outlives the 1-day expiry", async (t) => {
    let now = Date.UTC(2026, 0, 1);
    t.mock.method(Date, "now", () => now);
    const HOUR = 3600_000;
    const presenceStorage = () => {
      const s = memStorage();
      return { ...s, list: async (o?: { prefix?: string }) => new Map([...s.m].filter(([k]) => k.startsWith(o?.prefix ?? ""))) };
    };
    const presence = nsOf(() => new StreamPresence({ storage: presenceStorage() as never }));
    const watch = nsOf(() => new NoteWatch({ storage: memStorage() }));
    const sockets: FakeSocket[] = [];
    let alarm: number | null = null;
    const hubStorage = { ...memStorage(), getAlarm: async () => alarm, setAlarm: async (x: number) => void (alarm = x) };
    // no API_INTERNAL: the alarm still runs for the resync
    const hub = new StreamHub(
      { id: { toString: () => "user:u1" }, acceptWebSocket: (ws: any) => void sockets.push(ws), getWebSockets: () => sockets as never, storage: hubStorage },
      { STREAM_PRESENCE: presence, NOTE_WATCH: watch, STREAM_SHARD_COUNT: "4" },
    );
    (globalThis as any).WebSocketPair = class { 0 = new FakeSocket(); 1 = new FakeSocket(); };
    await hub.fetch(new Request("https://stream.internal/connect", { headers: { Upgrade: "websocket", "x-mk-user-id": "u1" } })).catch(() => null);
    delete (globalThis as any).WebSocketPair;
    assert.ok(alarm != null);
    const ws = sockets[0]!;
    await hub.webSocketMessage(ws as never, JSON.stringify({ type: "connect", body: { channel: "homeTimeline", id: "c1" } }));
    await hub.webSocketMessage(ws as never, JSON.stringify({ type: "s", body: { id: "n1" } }));

    const shard = presence.get(presence.idFromName(streamShardId("u1", 4)));
    const online = async () => Object.keys(await shard.lookup(["u1"]));
    const watching = async () => watch.get(watch.idFromName(noteWatchShard("n1", 4))).lookup("n1");
    // count presence writes
    const presenceInst = presence.inst.get(streamShardId("u1", 4))!;
    let sets = 0;
    const origSet = presenceInst.set.bind(presenceInst);
    presenceInst.set = async (...a: Parameters<typeof origSet>) => (sets++, origSet(...a));

    const tick = async (to: number) => {
      now = to;
      await hub.alarm();
    };
    const t0 = now;
    await tick(t0 + LAST_ACTIVE_REFRESH_MS); // starts the clock
    await tick(t0 + 6 * HOUR);
    assert.equal(sets, 0);
    await tick(t0 + LAST_ACTIVE_REFRESH_MS + PRESENCE_RESYNC_MS);
    assert.equal(sets, 1);
    await tick(t0 + 13 * HOUR);
    assert.equal(sets, 1);

    now = t0 + 25 * HOUR;
    assert.deepEqual(await online(), ["u1"]);
    assert.deepEqual(await watching(), ["u1"]);
    assert.deepEqual(await shard.subscribers(["homeTimeline"]), { u1: ["homeTimeline"] });
    assert.equal(await shard.online(), 1);

    // without the resyncs the entries expire: 37 hours after the last one
    now = t0 + LAST_ACTIVE_REFRESH_MS + PRESENCE_RESYNC_MS + 25 * HOUR;
    assert.deepEqual(await online(), []);
    assert.deepEqual(await watching(), []);
    assert.equal(await shard.online(), 0);
  });
});
