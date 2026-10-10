/**
 * Chat on PG (PGlite): 1:1 messages (chatScope / approvals / blocking / chatAvailability),
 * reactions, delete, show, timelines + unread state (`reads`), history, read-all, search,
 * rooms (create / invite / join / members / mute / leave / update / delete), invitations,
 * drive/files/attached-chat-messages, streaming (`chatUser:<id>` / `chatRoom:<id>`,
 * `newChatMessage` on main, presence-based read) and the chatRoomInvitationReceived notification.
 */
import { before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { genAidx } from "../../id/src/index.js";
import { NotificationBox } from "../../timeline/src/index.js";
import { StreamPresence } from "../../stream/src/presence.js";
import { subscriptionKey } from "../../stream/src/protocol.js";
import { streamShardId } from "@misskey-cf/shared";
import { IMPLEMENTED_ENDPOINTS } from "./registry.js";
import { fakeDoNamespace, makeFixture, type Fixture } from "./pglite-fixture.js";
import { handlers } from "./endpoints/index.js";
import type { ApiEnv } from "./env.js";
import { ENDPOINT_PARAM_DEFS } from "./endpoint-params.gen.js";
import { recordingHubNamespace } from "../../shared/src/testing/do-namespace.js";

const published: { userId: string; channel: string; type: string; body: any }[] = [];
const hub = recordingHubNamespace((userId, _path, b) => published.push({ userId, channel: b.channel, type: b.type, body: b.body }));
const presence = fakeDoNamespace((s) => new StreamPresence(s as never));

let f: Fixture;
let d: string;
const TOK_D = "dddddddddddddddd";
before(async () => {
  f = await makeFixture("ChatTest", {
    STREAM_HUB: hub as unknown as ApiEnv["STREAM_HUB"],
    STREAM_PRESENCE: presence as unknown as ApiEnv["STREAM_PRESENCE"],
    STREAM_SHARD_COUNT: "4",
    NOTIFICATION_BOX: fakeDoNamespace((s) => new NotificationBox(s as never)) as unknown as ApiEnv["NOTIFICATION_BOX"],
  });
  d = genAidx(Date.now() - 500_000);
  await f.db.query(`INSERT INTO "user" (id, username, "usernameLower", token) VALUES ($1, 'user_d', 'user_d', $2)`, [d, TOK_D]);
  await f.db.query(`INSERT INTO user_profile ("userId") VALUES ($1)`, [d]);
  await f.db.exec(`    INSERT INTO emoji (id, name, "originalUrl") VALUES ('em1', 'blobcat', 'https://e/blobcat.png')`);
});
beforeEach(() => {
  published.length = 0;
});

const E = (r: { data: any }) => r.data?.error?.id;
const INTERNAL = "5d37dbcb-891e-41ca-a3d6-e690c97775ac";
const rows = async (sql: string, p: unknown[] = []) => (await f.db.query(sql, p)).rows as any[];
const asD = async (endpoint: string, body: Record<string, unknown>) => {
  const r = await handlers[endpoint]!(f.env, { ...body, i: TOK_D }, { hasCredential: true, request: new Request("https://api.test/api/" + endpoint, { method: "POST" }) });
  if (r instanceof Response) return { status: r.status, data: r.status === 204 ? null : await r.json() };
  return { status: 200, data: r as any };
};
const follow = (a: string, b: string) => f.db.query(`INSERT INTO following (id, "followerId", "followeeId") VALUES ($1, $2, $3)`, [genAidx(Date.now()), a, b]);
const setPresence = (userId: string, channels: string[]) =>
  presence.get(presence.idFromName(streamShardId(userId, 4))).set(userId, channels);

const ENDPOINTS = [
  "chat/messages/create-to-user", "chat/messages/create-to-room", "chat/messages/delete", "chat/messages/show", "chat/messages/react",
  "chat/messages/unreact", "chat/messages/user-timeline", "chat/messages/room-timeline", "chat/messages/search", "chat/rooms/create",
  "chat/rooms/delete", "chat/rooms/join", "chat/rooms/leave", "chat/rooms/mute", "chat/rooms/show", "chat/rooms/owned", "chat/rooms/joining",
  "chat/rooms/update", "chat/rooms/members", "chat/rooms/invitations/create", "chat/rooms/invitations/ignore", "chat/rooms/invitations/inbox",
  "chat/rooms/invitations/outbox", "chat/history", "chat/read-all", "drive/files/attached-chat-messages",
];

describe("chat", () => {
  it("registers endpoints and stream channels", () => {
    for (const e of ENDPOINTS) {
      assert.ok((IMPLEMENTED_ENDPOINTS as readonly string[]).includes(e), e);
      assert.ok(ENDPOINT_PARAM_DEFS[e], e);
      assert.ok(handlers[e], e);
    }
    assert.equal(subscriptionKey("chatUser", { otherId: "U1" }), "chatUser:U1");
    assert.equal(subscriptionKey("chatRoom", { roomId: "R1" }), "chatRoom:R1");
    assert.equal(subscriptionKey("chatRoom", {}), null);
  });

  let dm1: string;
  it("1:1 messages: chatScope, approvals, streaming, newChatMessage", async () => {
    // default scope 'mutual' → plain Error upstream (500)
    assert.equal(E(await f.call("chat/messages/create-to-user", { toUserId: f.ids.c, text: "hi" }, "b")), INTERNAL);
    await follow(f.ids.b, f.ids.c);
    await follow(f.ids.c, f.ids.b);
    const r = await f.call("chat/messages/create-to-user", { toUserId: f.ids.c, text: "  hello  " }, "b");
    assert.equal(r.status, 200);
    dm1 = r.data.id;
    assert.deepEqual(Object.keys(r.data).sort(), ["createdAt", "file", "fileId", "fromUserId", "id", "reactions", "text", "toUserId"]);
    assert.equal(r.data.text, "hello");
    assert.equal(r.data.toUserId, f.ids.c);
    // both sides' chatUser channels, then (no queue → inline) newChatMessage on c's main
    assert.ok(published.some((p) => p.userId === f.ids.b && p.channel === `chatUser:${f.ids.c}` && p.type === "message" && p.body.id === dm1));
    assert.ok(published.some((p) => p.userId === f.ids.c && p.channel === `chatUser:${f.ids.b}` && p.type === "message"));
    const ncm = published.find((p) => p.userId === f.ids.c && p.channel === "main" && p.type === "newChatMessage");
    assert.equal(ncm?.body.id, dm1);
    assert.equal(ncm?.body.toUser.id, f.ids.c);
    assert.equal(ncm?.body.fromUser.id, f.ids.b);
    assert.ok(!("toRoom" in ncm!.body));
    assert.deepEqual((await rows(`SELECT "userId", "otherId" FROM chat_approval`)).map((x) => [x.userId, x.otherId]), [[f.ids.b, f.ids.c]]);

    // c approved b by replying → c's scope no longer matters for b
    assert.equal((await f.call("chat/messages/create-to-user", { toUserId: f.ids.b, text: "yo" }, "c")).status, 200);
    await f.db.query(`UPDATE "user" SET "chatScope" = 'none' WHERE id = $1`, [f.ids.c]);
    assert.equal((await f.call("chat/messages/create-to-user", { toUserId: f.ids.c, text: "still" }, "b")).status, 200);
    // d has no approval from c
    assert.equal(E(await asD("chat/messages/create-to-user", { toUserId: f.ids.c, text: "x" })), INTERNAL);
    await f.db.query(`UPDATE "user" SET "chatScope" = 'everyone' WHERE id = $1`, [f.ids.c]);
    assert.equal((await asD("chat/messages/create-to-user", { toUserId: f.ids.c, text: "x" })).status, 200);
    // followers: sender must follow the recipient
    await f.db.query(`UPDATE "user" SET "chatScope" = 'followers' WHERE id = $1`, [f.ids.a]);
    assert.equal(E(await asD("chat/messages/create-to-user", { toUserId: f.ids.a, text: "x" })), INTERNAL);
    await follow(d, f.ids.a);
    assert.equal((await asD("chat/messages/create-to-user", { toUserId: f.ids.a, text: "x" })).status, 200);
  });

  it("1:1 errors", async () => {
    assert.equal((await f.call("chat/messages/create-to-user", { toUserId: f.ids.c, text: "x" })).status, 401);
    assert.equal(E(await f.call("chat/messages/create-to-user", { toUserId: f.ids.b, text: "x" }, "b")), "17e2ba79-e22a-4cbc-bf91-d327643f4a7e");
    assert.equal(E(await f.call("chat/messages/create-to-user", { toUserId: "nope", text: "x" }, "b")), "11795c64-40ea-4198-b06e-3c873ed9039d");
    assert.equal(E(await f.call("chat/messages/create-to-user", { toUserId: f.ids.c }, "b")), "25587321-b0e6-449c-9239-f8925092942c");
    assert.equal(E(await f.call("chat/messages/create-to-user", { toUserId: f.ids.c, fileId: "nofile" }, "b")), "4372b8e2-185d-4146-8749-2f68864a3e5f");
    assert.equal((await f.call("chat/messages/create-to-user", { toUserId: f.ids.c, text: "x".repeat(2001) }, "b")).status, 400);
    // fileId is not nullable upstream
    assert.equal(E(await f.call("chat/messages/create-to-user", { toUserId: f.ids.c, text: "x", fileId: null }, "b")), "3d81ceae-475f-4600-b2a8-2bc116157532");
    // blocked by the recipient
    await f.db.query(`INSERT INTO blocking (id, "blockerId", "blockeeId") VALUES ('blk1', $1, $2)`, [f.ids.c, d]);
    assert.equal(E(await asD("chat/messages/create-to-user", { toUserId: f.ids.c, text: "x" })), INTERNAL);
    await f.db.query(`DELETE FROM blocking WHERE id = 'blk1'`);
    // chatAvailability: readonly sender cannot write but can read; recipient must be able to write
    await f.setPolicy(d, "chatAvailability", "readonly");
    assert.equal(E(await asD("chat/messages/create-to-user", { toUserId: f.ids.c, text: "x" })), INTERNAL);
    assert.equal((await asD("chat/history", {})).status, 200);
    assert.equal(E(await f.call("chat/messages/create-to-user", { toUserId: d, text: "x" }, "c")), INTERNAL);
    await f.setPolicy(d, "chatAvailability", "unavailable");
    assert.equal(E(await asD("chat/history", {})), INTERNAL);
    await f.setPolicy(d, "chatAvailability", "available");
    // moved accounts
    await f.db.query(`UPDATE "user" SET "movedToUri" = 'https://x/u' WHERE id = $1`, [d]);
    const moved = await asD("chat/messages/create-to-user", { toUserId: f.ids.c, text: "x" });
    assert.equal(moved.status, 403);
    assert.equal(E(moved), "56f20ec9-fd06-4fa5-841b-edd6d7d4fa31");
    await f.db.query(`UPDATE "user" SET "movedToUri" = NULL WHERE id = $1`, [d]);
  });

  it("unread state, user-timeline, history, read-all", async () => {
    assert.equal((await f.call("i", {}, "c")).data.hasUnreadChatMessages, true);
    let h = (await f.call("chat/history", {}, "c")).data;
    const withB = h.find((m: any) => m.fromUserId === f.ids.b || m.toUserId === f.ids.b);
    assert.equal(withB.isRead, false);
    assert.equal(withB.text, "still");
    assert.ok(h.some((m: any) => m.fromUserId === d)); // one entry per partner
    assert.equal(h.filter((m: any) => m.fromUserId === f.ids.b || m.toUserId === f.ids.b).length, 1);

    const tl = (await f.call("chat/messages/user-timeline", { userId: f.ids.b }, "c")).data;
    assert.deepEqual(tl.map((m: any) => m.text), ["still", "yo", "hello"]);
    assert.deepEqual((await f.call("chat/messages/user-timeline", { userId: f.ids.b, sinceId: dm1, limit: 1 }, "c")).data.map((m: any) => m.text), ["yo"]);
    assert.equal(E(await f.call("chat/messages/user-timeline", { userId: "nope" }, "c")), "11795c64-40ea-4198-b06e-3c873ed9039d");
    h = (await f.call("chat/history", {}, "c")).data;
    assert.equal(h.find((m: any) => m.fromUserId === f.ids.b || m.toUserId === f.ids.b).isRead, true);
    assert.equal(h.find((m: any) => m.fromUserId === d).isRead, false);
    // muted partners are left out of history
    await f.db.query(`INSERT INTO muting (id, "muterId", "muteeId") VALUES ('mt1', $1, $2)`, [f.ids.c, d]);
    assert.ok(!(await f.call("chat/history", {}, "c")).data.some((m: any) => m.fromUserId === d));
    await f.db.query(`DELETE FROM muting WHERE id = 'mt1'`);
    assert.equal((await f.call("chat/read-all", {}, "c")).status, 204);
    assert.equal((await f.call("i", {}, "c")).data.hasUnreadChatMessages, false);
    // as upstream, read-all clears only the global flag: the conversation itself stays unread
    assert.equal((await f.call("chat/history", {}, "c")).data.find((m: any) => m.fromUserId === d).isRead, false);
    assert.equal((await f.call("chat/read-all", {}, "c")).status, 204); // idempotent
    assert.deepEqual((await rows(`SELECT reads FROM chat_message WHERE "fromUserId" = $1 AND "toUserId" = $2 ORDER BY id DESC LIMIT 1`, [d, f.ids.c]))[0].reads, [`!${f.ids.c}`]);
    // reading the conversation afterwards marks it read
    await f.call("chat/messages/user-timeline", { userId: d }, "c");
    assert.equal((await f.call("chat/history", {}, "c")).data.find((m: any) => m.fromUserId === d).isRead, true);
  });

  it("a recipient watching the conversation reads it at once", async () => {
    await setPresence(f.ids.c, ["main", `chatUser:${f.ids.b}`]);
    const r = await f.call("chat/messages/create-to-user", { toUserId: f.ids.c, text: "seen" }, "b");
    assert.ok(!published.some((p) => p.type === "newChatMessage"));
    assert.deepEqual((await rows(`SELECT reads FROM chat_message WHERE id = $1`, [r.data.id]))[0].reads, [f.ids.c]);
    assert.equal((await f.call("i", {}, "c")).data.hasUnreadChatMessages, false);
    await setPresence(f.ids.c, []);
  });

  it("react / unreact / show / delete", async () => {
    assert.equal((await f.call("chat/messages/react", { messageId: dm1, reaction: "❤️" }, "c")).status, 204);
    assert.ok(published.some((p) => p.userId === f.ids.b && p.channel === `chatUser:${f.ids.c}` && p.type === "react" && p.body.reaction === "❤" && p.body.messageId === dm1));
    // own message / third party / unknown → the same NO_SUCH_MESSAGE
    assert.equal(E(await f.call("chat/messages/react", { messageId: dm1, reaction: "👍" }, "b")), "9b5839b9-0ba0-4351-8c35-37082093d200");
    assert.equal(E(await asD("chat/messages/react", { messageId: dm1, reaction: "👍" })), "9b5839b9-0ba0-4351-8c35-37082093d200");
    assert.equal(E(await f.call("chat/messages/react", { messageId: "nope", reaction: "👍" }, "c")), "9b5839b9-0ba0-4351-8c35-37082093d200");
    assert.equal(E(await f.call("chat/messages/react", { messageId: dm1, reaction: ":nonexistent:" }, "c")), INTERNAL);
    assert.equal(E(await f.call("chat/messages/react", { messageId: dm1, reaction: "abc" }, "c")), INTERNAL);
    assert.equal((await f.call("chat/messages/react", { messageId: dm1, reaction: ":blobcat@.:" }, "c")).status, 204);
    assert.equal((await f.call("chat/messages/unreact", { messageId: dm1, reaction: ":blobcat:" }, "c")).status, 204);
    const tl = (await f.call("chat/messages/user-timeline", { userId: f.ids.c }, "b")).data;
    assert.deepEqual(tl.find((m: any) => m.id === dm1).reactions, [{ reaction: "❤" }]);

    const shown = (await f.call("chat/messages/show", { messageId: dm1 }, "c")).data;
    assert.equal(shown.fromUser.id, f.ids.b);
    assert.deepEqual(shown.reactions.map((x: any) => [x.user.id, x.reaction]), [[f.ids.c, "❤"]]);
    assert.equal(E(await asD("chat/messages/show", { messageId: dm1 })), "3710865b-1848-4da9-8d61-cfed15510b93");
    assert.equal((await f.call("chat/messages/show", { messageId: dm1 }, "a")).status, 200); // moderator (root)

    assert.equal(E(await asD("chat/messages/unreact", { messageId: dm1, reaction: "❤" })), "c39ea42f-e3ca-428a-ad57-390e0a711595");
    assert.equal((await f.call("chat/messages/unreact", { messageId: dm1, reaction: "❤" }, "c")).status, 204);
    assert.deepEqual((await rows(`SELECT reactions FROM chat_message WHERE id = $1`, [dm1]))[0].reactions, []);

    assert.equal(E(await f.call("chat/messages/delete", { messageId: dm1 }, "c")), "36b67f0e-66a6-414b-83df-992a55294f17");
    published.length = 0;
    assert.equal((await f.call("chat/messages/delete", { messageId: dm1 }, "b")).status, 204);
    assert.ok(published.some((p) => p.userId === f.ids.c && p.channel === `chatUser:${f.ids.b}` && p.type === "deleted" && p.body === dm1));
    assert.equal((await rows(`SELECT 1 FROM chat_message WHERE id = $1`, [dm1])).length, 0);
  });

  let room: string;
  it("rooms: create / invite / join / message / timeline / members", async () => {
    const created = await f.call("chat/rooms/create", { name: "room1", description: "desc" }, "b");
    assert.equal(created.status, 200);
    room = created.data.id;
    assert.deepEqual(
      { ...created.data, createdAt: undefined, owner: created.data.owner.id },
      { id: room, createdAt: undefined, name: "room1", description: "desc", ownerId: f.ids.b, owner: f.ids.b, isMuted: false, invitationExists: false },
    );
    assert.equal((await f.call("chat/rooms/create", { name: "x".repeat(257) }, "b")).status, 400);
    assert.deepEqual((await f.call("chat/rooms/owned", {}, "b")).data.map((r: any) => r.id), [room]);

    // not visible to strangers; invitees see it
    assert.equal(E(await f.call("chat/rooms/show", { roomId: room }, "c")), "857ae02f-8759-4d20-9adb-6e95fffe4fd7");
    assert.equal(E(await f.call("chat/rooms/invitations/create", { roomId: room, userId: f.ids.c }, "c")), "916f9507-49ba-4e90-b57f-1fd4deaa47a5");
    const inv = await f.call("chat/rooms/invitations/create", { roomId: room, userId: f.ids.c }, "b");
    assert.equal(inv.status, 200);
    assert.equal(inv.data.user.id, f.ids.c);
    assert.equal(inv.data.room.id, room);
    assert.equal(E(await f.call("chat/rooms/invitations/create", { roomId: room, userId: f.ids.c }, "b")), INTERNAL); // already invited
    assert.equal(E(await f.call("chat/rooms/invitations/create", { roomId: room, userId: f.ids.b }, "b")), INTERNAL); // yourself
    const notif = (await f.call("i/notifications", {}, "c")).data.find((n: any) => n.type === "chatRoomInvitationReceived");
    assert.equal(notif?.invitation.id, inv.data.id);
    assert.equal(notif?.user.id, f.ids.b);
    assert.equal((await f.call("chat/rooms/show", { roomId: room }, "c")).data.invitationExists, true);
    assert.deepEqual((await f.call("chat/rooms/invitations/inbox", {}, "c")).data.map((i: any) => i.roomId), [room]);
    assert.deepEqual((await f.call("chat/rooms/invitations/outbox", { roomId: room }, "b")).data.map((i: any) => i.userId), [f.ids.c]);
    assert.equal(E(await f.call("chat/rooms/invitations/outbox", { roomId: room }, "c")), "a3c6b309-9717-4316-ae94-a69b53437237");

    // not a member yet
    assert.equal(E(await f.call("chat/messages/create-to-room", { toRoomId: room, text: "x" }, "c")), INTERNAL);
    assert.equal(E(await f.call("chat/messages/room-timeline", { roomId: room }, "c")), "c4d9f88c-9270-4632-b032-6ed8cee36f7f");
    assert.equal(E(await asD("chat/rooms/join", { roomId: room })), INTERNAL); // no invitation
    assert.equal((await f.call("chat/rooms/join", { roomId: room }, "c")).status, 204);
    assert.equal((await f.call("chat/rooms/invitations/inbox", {}, "c")).data.length, 0);
    const joining = (await f.call("chat/rooms/joining", {}, "c")).data;
    assert.deepEqual(joining.map((m: any) => [m.roomId, m.room.id, m.userId]), [[room, room, f.ids.c]]);
    assert.ok(!("user" in joining[0]));
    const members = (await f.call("chat/rooms/members", { roomId: room }, "b")).data;
    assert.deepEqual(members.map((m: any) => m.user.id), [f.ids.c]);
    assert.ok(!("room" in members[0]));
    assert.equal(E(await asD("chat/rooms/members", { roomId: room })), "7b9fe84c-eafc-4d21-bf89-485458ed2c18");

    published.length = 0;
    const msg = await f.call("chat/messages/create-to-room", { toRoomId: room, text: "room hi" }, "c");
    assert.equal(msg.status, 200);
    assert.deepEqual(Object.keys(msg.data).sort(), ["createdAt", "file", "fileId", "fromUser", "fromUserId", "id", "reactions", "text", "toRoomId"]);
    assert.equal(msg.data.fromUser.id, f.ids.c);
    assert.deepEqual(published.filter((p) => p.channel === `chatRoom:${room}` && p.type === "message").map((p) => p.userId).sort(), [f.ids.b, f.ids.c].sort());
    const ncm = published.filter((p) => p.type === "newChatMessage");
    assert.deepEqual(ncm.map((p) => p.userId), [f.ids.b]);
    assert.equal(ncm[0]!.body.toRoom.id, room);
    // a moderator (root a) watching the room gets its events too (upstream's channel admits moderators)
    await setPresence(f.ids.a, ["main", `chatRoom:${room}`]);
    published.length = 0;
    const watched = (await f.call("chat/messages/create-to-room", { toRoomId: room, text: "watched" }, "c")).data.id;
    assert.deepEqual(published.filter((p) => p.channel === `chatRoom:${room}` && p.type === "message").map((p) => p.userId).sort(), [f.ids.a, f.ids.b, f.ids.c].sort());
    await setPresence(f.ids.a, []);
    await f.db.query(`DELETE FROM chat_message WHERE id = $1`, [watched]);
    assert.equal(E(await f.call("chat/messages/create-to-room", { toRoomId: "nope", text: "x" }, "c")), "8098520d-2da5-4e8f-8ee1-df78b55a4ec6");
    assert.equal(E(await f.call("chat/messages/create-to-room", { toRoomId: room }, "c")), "340517b7-6d04-42c0-bac1-37ee804e3594");
    assert.equal(E(await f.call("chat/messages/create-to-room", { toRoomId: room, fileId: "nofile" }, "c")), "b6accbd3-1d7b-4d9f-bdb7-eb185bac06db");

    // owner b: unread room until the timeline is read
    let h = (await f.call("chat/history", { room: true }, "b")).data;
    assert.deepEqual(h.map((m: any) => [m.toRoomId, m.isRead]), [[room, false]]);
    assert.equal((await f.call("i", {}, "b")).data.hasUnreadChatMessages, true);
    const tl = (await f.call("chat/messages/room-timeline", { roomId: room }, "b")).data;
    assert.deepEqual(tl.map((m: any) => m.text), ["room hi"]);
    h = (await f.call("chat/history", { room: true }, "b")).data;
    assert.equal(h[0].isRead, true);
    assert.equal((await f.call("chat/messages/room-timeline", { roomId: room }, "a")).status, 200); // moderator

    // room reactions carry the user
    published.length = 0;
    assert.equal((await f.call("chat/messages/react", { messageId: msg.data.id, reaction: "👍" }, "b")).status, 204);
    const ev = published.find((p) => p.channel === `chatRoom:${room}` && p.type === "react");
    assert.equal(ev?.body.user.id, f.ids.b);
    assert.deepEqual((await f.call("chat/messages/room-timeline", { roomId: room }, "c")).data[0].reactions.map((r: any) => [r.user.id, r.reaction]), [[f.ids.b, "👍"]]);
  });

  it("rooms: mute / update / leave / ignore / delete", async () => {
    assert.equal((await f.call("chat/rooms/mute", { roomId: room, mute: true }, "c")).status, 204);
    assert.equal((await f.call("chat/rooms/show", { roomId: room }, "c")).data.isMuted, true);
    published.length = 0;
    await f.call("chat/messages/create-to-room", { toRoomId: room, text: "muted?" }, "b");
    assert.ok(!published.some((p) => p.type === "newChatMessage")); // c muted the room
    assert.equal((await f.call("i", {}, "c")).data.hasUnreadChatMessages, false);
    assert.equal(E(await asD("chat/rooms/mute", { roomId: room, mute: true })), INTERNAL);

    assert.equal(E(await f.call("chat/rooms/update", { roomId: room, name: "n" }, "c")), "fcdb0f92-bda6-47f9-bd05-343e0e020932");
    const up = (await f.call("chat/rooms/update", { roomId: room, name: "renamed" }, "b")).data;
    assert.equal(up.name, "renamed");
    assert.equal(up.description, "desc");

    assert.equal((await f.call("chat/rooms/leave", { roomId: room }, "c")).status, 204);
    assert.equal((await f.call("chat/rooms/joining", {}, "c")).data.length, 0);
    assert.equal(E(await f.call("chat/rooms/leave", { roomId: room }, "c")), INTERNAL);

    await f.call("chat/rooms/invitations/create", { roomId: room, userId: d }, "b");
    assert.equal((await asD("chat/rooms/invitations/inbox", {})).data.length, 1);
    assert.equal((await asD("chat/rooms/invitations/ignore", { roomId: room })).status, 204);
    assert.equal((await asD("chat/rooms/invitations/inbox", {})).data.length, 0);
    assert.equal((await f.call("chat/rooms/invitations/outbox", { roomId: room }, "b")).data.length, 1); // still listed for the owner

    assert.equal(E(await f.call("chat/rooms/delete", { roomId: room }, "c")), "d4e3753d-97bf-4a19-ab8e-21080fbc0f4b");
    assert.equal((await f.call("chat/rooms/delete", { roomId: room }, "b")).status, 204);
    assert.equal((await rows(`SELECT 1 FROM chat_message WHERE "toRoomId" = $1`, [room])).length, 0);
    assert.equal((await rows(`SELECT 1 FROM moderation_log WHERE type = 'deleteChatRoom'`)).length, 0); // owner, not a moderator
    // moderator deletion is logged
    const r2 = (await f.call("chat/rooms/create", { name: "r2" }, "b")).data.id;
    assert.equal((await f.call("chat/rooms/delete", { roomId: r2 }, "a")).status, 204);
    const log = await rows(`SELECT info FROM moderation_log WHERE type = 'deleteChatRoom'`);
    assert.equal(log[0].info.roomId, r2);
    assert.equal(log[0].info.room.name, "r2");
  });

  it("search and drive/files/attached-chat-messages", async () => {
    const found = (await f.call("chat/messages/search", { query: "STILL" }, "c")).data;
    assert.deepEqual(found.map((m: any) => m.text), ["still"]);
    assert.equal(found[0].toUser.id, f.ids.c);
    assert.deepEqual((await f.call("chat/messages/search", { query: "%" }, "c")).data, []);
    assert.deepEqual((await f.call("chat/messages/search", { query: "o", userId: f.ids.b }, "c")).data.map((m: any) => m.text), ["yo"]);
    assert.equal(E(await f.call("chat/messages/search", { query: "x", roomId: "nope" }, "c")), "460b3669-81b0-4dc9-a997-44442141bf83");

    await f.db.query(`INSERT INTO drive_file (id, "userId", type, name, url, md5, size, "storedInternal") VALUES ('file1', $1, 'image/png', 'a.png', 'https://f/a.png', '0', 0, FALSE)`, [f.ids.b]);
    const m = await f.call("chat/messages/create-to-user", { toUserId: f.ids.c, fileId: "file1" }, "b");
    assert.equal(m.data.file.id, "file1");
    assert.equal(m.data.text, null);
    const att = (await f.call("drive/files/attached-chat-messages", { fileId: "file1" }, "b")).data;
    assert.deepEqual(att.map((x: any) => x.id), [m.data.id]);
    assert.equal(att[0].file.url, "https://f/a.png");
    assert.equal(E(await f.call("drive/files/attached-chat-messages", { fileId: "file1" }, "c")), "485ce26d-f5d2-4313-9783-e689d131eafb");
    assert.equal((await f.call("drive/files/attached-chat-messages", { fileId: "file1" }, "a")).data.length, 1); // moderator
  });
});
