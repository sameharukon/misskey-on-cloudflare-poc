import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { InMemoryStreamHub, StreamConnection, applyClientFrame, applyOptsFrame, framesFor, noteAllowedOnChannel, parseClientMessage, subscriptionOpts } from "./protocol.js";
import { rpcStub } from "../../shared/src/testing/do-namespace.js";
import type { PublishEvent } from "../../shared/src/do-rpc.js";

describe("stream protocol", () => {
  it("parses connect/disconnect", () => {
    const m = parseClientMessage(
      JSON.stringify({ type: "connect", body: { channel: "main", id: "1" } }),
    );
    assert.equal(m?.type, "connect");
  });

  it("subscribes and delivers; disconnect stops", () => {
    const hub = new InMemoryStreamHub();
    const c = hub.connect("user-a");
    assert.deepEqual(
      c.handleClientMessage({ type: "connect", body: { channel: "homeTimeline", id: "x" } }),
      { ok: true },
    );
    assert.equal(
      c.handleClientMessage({ type: "connect", body: { channel: "globalTimeline", id: "g" } }).ok,
      false,
    );

    assert.equal(hub.onBusEvent("homeTimeline:user-a", "note", { id: "n1" }), 1);
    assert.equal(c.outbound.length, 1);
    assert.equal(c.outbound[0]!.body.type, "note");

    // other user ignored
    assert.equal(hub.onBusEvent("homeTimeline:other", "note", { id: "n2" }), 0);

    c.handleClientMessage({ type: "disconnect", body: { id: "x" } });
    assert.equal(hub.onBusEvent("homeTimeline:user-a", "note", { id: "n3" }), 0);

    hub.disconnect(c.connectionId);
    assert.equal(hub.get(c.connectionId), undefined);
  });

  it("main channel delivery", () => {
    const c = new StreamConnection("c1", "u1");
    c.handleClientMessage({ type: "connect", body: { channel: "main", id: "m" } });
    c.deliver("main", "notification", { id: "notif" });
    assert.equal(c.outbound[0]!.body.id, "m");
    assert.equal(c.outbound[0]!.body.type, "notification");
  });

  it("param channels are keyed by their object id", () => {
    const connect = (channel: string, id: string, params?: unknown) => JSON.stringify({ type: "connect", body: { channel, id, params } });
    let subs = applyClientFrame({}, connect("userList", "1", { listId: "L1" })).subs;
    subs = applyClientFrame(subs, connect("antenna", "2", { antennaId: "A1" })).subs;
    subs = applyClientFrame(subs, connect("channel", "3", { channelId: "C1" })).subs;
    subs = applyClientFrame(subs, connect("roleTimeline", "5", { roleId: "R1" })).subs;
    assert.deepEqual(subs, { "1": "userList:L1", "2": "antenna:A1", "3": "channel:C1", "5": "roleTimeline:R1" });
    assert.equal(applyClientFrame(subs, connect("userList", "4", {})).error, "unsupported_channel:userList");
    assert.equal(applyClientFrame(subs, connect("userList", "4", { listId: "a:b" })).changed, false);
    assert.equal(framesFor(subs, "userList:L1", "note", { id: "n" }).length, 1);
    assert.equal(framesFor(subs, "userList:L2", "note", { id: "n" }).length, 0);
    assert.equal(JSON.parse(framesFor(subs, "channel:C1", "note", {})[0]!).body.id, "3");
  });
});

describe("timeline options (withRenotes / withFiles / withReplies)", () => {
  const connect = (channel: string, id: string, params: Record<string, unknown> = {}) => JSON.stringify({ type: "connect", body: { channel, id, params } });

  it("are stored per subscription only when not the default, with each channel's own params", () => {
    assert.equal(subscriptionOpts("homeTimeline", {}), null);
    assert.equal(subscriptionOpts("homeTimeline", { withRenotes: false, withFiles: true }), "010");
    assert.equal(subscriptionOpts("homeTimeline", { withReplies: true }), null); // home has no withReplies param
    assert.equal(subscriptionOpts("localTimeline", { withReplies: true }), "101");
    assert.equal(subscriptionOpts("main", { withFiles: true }), null);
    let opts = applyOptsFrame({}, connect("localTimeline", "a", { withFiles: true }));
    opts = applyOptsFrame(opts, connect("globalTimeline", "b"));
    opts = applyOptsFrame(opts, connect("bogus", "c", { withFiles: true }));
    assert.deepEqual(opts, { a: "110" });
    assert.deepEqual(applyOptsFrame(opts, JSON.stringify({ type: "disconnect", body: { id: "a" } })), {});
    assert.deepEqual(applyOptsFrame(opts, "h"), opts);
  });

  const me = "me";
  const plain = { id: "n", userId: "u", text: "x", fileIds: [] };
  const withFile = { ...plain, fileIds: ["f"] };
  const pureRenote = { id: "r", userId: "u", text: null, renoteId: "n", fileIds: [], renote: { id: "n" } };
  const quote = { ...pureRenote, text: "q" };
  const replyToOther = { ...plain, replyId: "p", reply: { userId: "other", visibility: "public" } };
  const replyToMe = { ...replyToOther, reply: { userId: me, visibility: "public" } };
  const selfReply = { ...replyToOther, reply: { userId: "u", visibility: "public" } };
  const replyToHidden = { ...replyToOther, reply: { userId: "other", visibility: "followers" } };

  it("withFiles and withRenotes on every timeline channel", () => {
    for (const ch of ["homeTimeline", "localTimeline", "hybridTimeline", "globalTimeline", "userList:l1"]) {
      assert.equal(noteAllowedOnChannel(ch, "110", plain, me), false, ch);
      assert.equal(noteAllowedOnChannel(ch, "110", withFile, me), true, ch);
      assert.equal(noteAllowedOnChannel(ch, "000", pureRenote, me), false, ch);
      assert.equal(noteAllowedOnChannel(ch, "000", quote, me), true, ch);
      assert.equal(noteAllowedOnChannel(ch, undefined, pureRenote, me), true, ch);
    }
    assert.equal(noteAllowedOnChannel("main", "010", plain, me), true);
    assert.equal(noteAllowedOnChannel("antenna:a1", "010", plain, me), true);
  });

  it("replies: only related ones unless the follow (or the subscription) has withReplies", () => {
    for (const ch of ["homeTimeline", "hybridTimeline", "localTimeline"]) {
      assert.equal(noteAllowedOnChannel(ch, undefined, replyToOther, me), false, ch);
      assert.equal(noteAllowedOnChannel(ch, undefined, replyToMe, me), true, ch);
      assert.equal(noteAllowedOnChannel(ch, undefined, selfReply, me), true, ch);
      assert.equal(noteAllowedOnChannel(ch, undefined, { ...replyToOther, userId: me }, me), true, ch);
      assert.equal(noteAllowedOnChannel(ch, undefined, replyToOther, me, { followsAuthorWithReplies: true }), true, ch);
    }
    assert.equal(noteAllowedOnChannel("hybridTimeline", "101", replyToOther, me), true);
    assert.equal(noteAllowedOnChannel("localTimeline", "101", replyToOther, me), true);
    assert.equal(noteAllowedOnChannel("homeTimeline", "101", replyToOther, me), false); // no withReplies param on home
    assert.equal(noteAllowedOnChannel("globalTimeline", undefined, replyToOther, me), true);
    // replies to followers-only notes of users the viewer does not follow (home / hybrid)
    assert.equal(noteAllowedOnChannel("homeTimeline", undefined, replyToHidden, me, { followsAuthorWithReplies: true }), false);
    assert.equal(noteAllowedOnChannel("homeTimeline", undefined, replyToHidden, me, { followsAuthorWithReplies: true, follows: ["other"] }), true);
    assert.equal(noteAllowedOnChannel("localTimeline", "101", replyToHidden, me), true);
    // a renote of such a reply
    const renoteOfHidden = { ...pureRenote, renote: { id: "n", reply: { userId: "other", visibility: "followers" } } };
    assert.equal(noteAllowedOnChannel("homeTimeline", undefined, renoteOfHidden, me), false);
    assert.equal(noteAllowedOnChannel("hybridTimeline", undefined, renoteOfHidden, me, { follows: ["other"] }), true);
    assert.equal(noteAllowedOnChannel("globalTimeline", undefined, renoteOfHidden, me), true);
  });

  it("framesFor filters note events per subscription", () => {
    const subs = { a: "homeTimeline", b: "homeTimeline", c: "main" };
    const filter = { opts: { b: "110" }, userId: me };
    assert.deepEqual(framesFor(subs, "homeTimeline", "note", plain, filter).map((f) => JSON.parse(f).body.id), ["a"]);
    assert.deepEqual(framesFor(subs, "homeTimeline", "note", withFile, filter).map((f) => JSON.parse(f).body.id), ["a", "b"]);
    assert.equal(framesFor(subs, "homeTimeline", "other", plain, filter).length, 2); // non-note events are not filtered
    assert.equal(framesFor(subs, "homeTimeline", "note", plain).length, 2); // no filter given
  });
});

describe("StreamHub applies the timeline options", () => {
  it("stores them on connect and filters published notes, using the fanout's rel", async () => {
    const { StreamHub } = await import("./index.js");
    const sent: string[] = [];
    let att: unknown = { userId: "me", subs: {} };
    const sock = { send: (d: string) => sent.push(d), close() {}, serializeAttachment: (v: unknown) => { att = v; }, deserializeAttachment: () => att };
    const hub = new StreamHub({ id: { toString: () => "h" }, acceptWebSocket() {}, getWebSockets: () => [sock] });
    await hub.webSocketMessage(sock, JSON.stringify({ type: "connect", body: { channel: "homeTimeline", id: "h1", params: { withRenotes: false } } }));
    await hub.webSocketMessage(sock, JSON.stringify({ type: "connect", body: { channel: "localTimeline", id: "l1", params: { withReplies: true } } }));
    assert.deepEqual((att as { opts: unknown }).opts, { h1: "000", l1: "101" });
    const publish = async (events: PublishEvent[]) => (await rpcStub(hub).publish(events)).delivered;
    const renote = { id: "r", userId: "u", text: null, renoteId: "n", fileIds: [], renote: { id: "n" } };
    assert.equal(await publish([{ channel: "homeTimeline", type: "note", body: renote }]), 0);
    const reply = { id: "p", userId: "u", text: "x", fileIds: [], replyId: "q", reply: { userId: "other", visibility: "public" } };
    assert.equal(await publish([{ channel: "homeTimeline", type: "note", body: reply }]), 0);
    assert.equal(await publish([{ channel: "homeTimeline", type: "note", body: reply, rel: { followsAuthorWithReplies: true } }]), 1);
    assert.equal(await publish([{ channel: "localTimeline", type: "note", body: reply }]), 1);
    // disconnect drops the options
    await hub.webSocketMessage(sock, JSON.stringify({ type: "disconnect", body: { id: "h1" } }));
    assert.deepEqual((att as { opts: unknown }).opts, { l1: "101" });
  });
});
