/**
 * Chat (upstream ChatService / ChatEntityService and endpoints/chat/**) on PG:
 * chat/messages/*, chat/rooms/*, chat/rooms/invitations/*, chat/history, chat/read-all and
 * drive/files/attached-chat-messages.
 *
 * Unread state: upstream keeps Redis markers (`newUserChatMessageExists:{reader}:{other}`,
 * `newRoomChatMessageExists:{reader}:{room}`, `newChatMessagesExists:{reader}`). Here the
 * upstream `chat_message.reads` column (created by the chat migration, never read upstream)
 * holds the ids of the users who have read a message:
 * - reading a 1:1 conversation adds the reader to every unread message the other user sent them;
 * - reading a room adds the reader to the room's latest 100 messages from others;
 * - a conversation is unread when (1:1) a message to me lacks my id, (room) the room's latest
 *   message from someone else lacks my id, is newer than my membership (upstream sets markers
 *   only for members) and the room is not muted.
 * - `chat/read-all` (upstream: deletes only the global `newChatMessagesExists` set, leaving the
 *   per-conversation markers) adds `!<reader>` (READ_ALL_MARK) to the unread messages: MeDetailed
 *   `hasUnreadChatMessages` ignores marked messages, `history[].isRead` does not.
 *
 * The delayed `newChatMessage` (upstream: setTimeout 3 s, then main stream + Web Push if the
 * marker is still there) is a `chatNotify` job on `mk-jobs` (delaySeconds 3; inline without the
 * queue). A recipient whose socket is subscribed to the conversation's channel (`chatUser:<from>`
 * / `chatRoom:<room>`, from StreamPresence) is treated as having read it: upstream's client sends
 * `read` on that channel when a message arrives, which the hub cannot forward without PG.
 *
 * Streaming: `chatUser` (param otherId) and `chatRoom` (param roomId) are hub param channels
 * (`chatUser:<otherId>`, `chatRoom:<roomId>`); events are published only to the hubs of the two
 * participants / the room owner and members.
 */

import { genAidx, parseAidxTime } from "../../id/src/index.js";
import { streamShardId } from "@misskey-cf/shared";
import type { ApiEnv } from "./env.js";
import { apiErrorResponse, CREDENTIAL_REQUIRED, INTERNAL_ERROR, INVALID_PARAM, type ApiErrorBody } from "./errors.js";
import { authenticatePg, extractToken } from "./auth-pg.js";
import { withHyperdriveClient, type PgQueryable } from "./pg.js";
import { getUserPoliciesPg, isModeratorPg, moderationLogPg } from "./policies-pg.js";
import { packUsers, pagination } from "./client-endpoints-pg.js";
import { packDriveFile } from "./drive/pack.js";
import { getLocalEmojiPg } from "./emojis-pg.js";
import { publishToUserStream } from "./stream-publish.js";
import { moderatorIds } from "./abuse-reports-pg.js";
import { clientError as err, hd } from "./handler-kit.js";
import { enqueueJob } from "./queues/jobs-queue.js";

type Ctx = { hasCredential: boolean; request: Request };
type Body = Record<string, unknown>;
type Handler = (env: ApiEnv, body: Body, ctx: Ctx) => Promise<Response | unknown>;
type Row = Record<string, unknown>;

const noSuchRoom = (id: string) => err("NO_SUCH_ROOM", id, "No such room.");
const noSuchMessage = (id: string) => err("NO_SUCH_MESSAGE", id, "No such message.");
const noSuchFile = (id: string) => err("NO_SUCH_FILE", id, "No such file.");
const contentRequired = (id: string) => err("CONTENT_REQUIRED", id, "Content required. You need to set text or fileId.");
const E = {
  ctrNoSuchRoom: noSuchRoom("8098520d-2da5-4e8f-8ee1-df78b55a4ec6"),
  ctrNoSuchFile: noSuchFile("b6accbd3-1d7b-4d9f-bdb7-eb185bac06db"),
  ctrContentRequired: contentRequired("340517b7-6d04-42c0-bac1-37ee804e3594"),
  ctuYourself: err("RECIPIENT_IS_YOURSELF", "17e2ba79-e22a-4cbc-bf91-d327643f4a7e", "You can not send a message to yourself."),
  ctuNoSuchUser: err("NO_SUCH_USER", "11795c64-40ea-4198-b06e-3c873ed9039d", "No such user."),
  ctuNoSuchFile: noSuchFile("4372b8e2-185d-4146-8749-2f68864a3e5f"),
  ctuContentRequired: contentRequired("25587321-b0e6-449c-9239-f8925092942c"),
  deleteNoSuchMessage: noSuchMessage("36b67f0e-66a6-414b-83df-992a55294f17"),
  reactNoSuchMessage: noSuchMessage("9b5839b9-0ba0-4351-8c35-37082093d200"),
  unreactNoSuchMessage: noSuchMessage("c39ea42f-e3ca-428a-ad57-390e0a711595"),
  showNoSuchMessage: noSuchMessage("3710865b-1848-4da9-8d61-cfed15510b93"),
  rtNoSuchRoom: noSuchRoom("c4d9f88c-9270-4632-b032-6ed8cee36f7f"),
  searchNoSuchRoom: noSuchRoom("460b3669-81b0-4dc9-a997-44442141bf83"),
  utNoSuchUser: err("NO_SUCH_USER", "11795c64-40ea-4198-b06e-3c873ed9039d", "No such user."),
  roomDeleteNoSuchRoom: noSuchRoom("d4e3753d-97bf-4a19-ab8e-21080fbc0f4b"),
  membersNoSuchRoom: noSuchRoom("7b9fe84c-eafc-4d21-bf89-485458ed2c18"),
  roomShowNoSuchRoom: noSuchRoom("857ae02f-8759-4d20-9adb-6e95fffe4fd7"),
  roomUpdateNoSuchRoom: noSuchRoom("fcdb0f92-bda6-47f9-bd05-343e0e020932"),
  invCreateNoSuchRoom: noSuchRoom("916f9507-49ba-4e90-b57f-1fd4deaa47a5"),
  outboxNoSuchRoom: noSuchRoom("a3c6b309-9717-4316-ae94-a69b53437237"),
  attachedNoSuchFile: noSuchFile("485ce26d-f5d2-4313-9783-e689d131eafb"),
  accountMoved: { message: "You have moved your account.", code: "YOUR_ACCOUNT_MOVED", id: "56f20ec9-fd06-4fa5-841b-edd6d7d4fa31", kind: "permission" } as ApiErrorBody,
};

/** Thrown inside handlers; `run()` turns it into the error response. */
class ChatErr extends Error {
  constructor(readonly body: ApiErrorBody, readonly status = 400) {
    super(body.code);
  }
}
/** Upstream throws a plain Error (→ 500 INTERNAL_ERROR) for these (`yourself`, `blocked`, policy, …). */
const internal = (why: string) => {
  const e = new ChatErr(INTERNAL_ERROR, 500);
  e.message = why;
  return e;
};
const fail = (e: ApiErrorBody) => new ChatErr(e);
const bad = () => new ChatErr(INVALID_PARAM);

const MAX_ROOM_MEMBERS = 50;
const MAX_REACTIONS_PER_MESSAGE = 100;
const ROOM_READ_WINDOW = 100;
const CUSTOM_EMOJI_RE = /^:([\w+-]+)(?:@\.)?:$/;
// twemoji-parser's emoji regex is not bundled; one emoji (flags, keycaps, ZWJ / modifier sequences).
const EMOJI_RE = /\p{RI}\p{RI}|[#*0-9]️?⃣|\p{Extended_Pictographic}(?:️|\p{EMod})?(?:‍\p{Extended_Pictographic}(?:️|\p{EMod})?)*/u;

const createdAt = (id: unknown) => (parseAidxTime(String(id)) ?? new Date(0)).toISOString();
const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);

type Me = { id: string; host: string | null; movedToUri: string | null };

async function requireMe(env: ApiEnv, c: PgQueryable, body: Body, ctx: Ctx): Promise<Me> {
  const token = ctx.hasCredential ? extractToken(ctx.request, body) : null;
  const a = token ? await authenticatePg(env, token) : null;
  if (!a) throw new ChatErr(CREDENTIAL_REQUIRED, 401);
  const u = (await c.query(`SELECT id, host, "movedToUri" FROM "user" WHERE id = $1`, [a.user.id])).rows[0];
  return { id: a.user.id, host: (u?.host as string | null) ?? null, movedToUri: (u?.movedToUri as string | null) ?? null };
}

function prohibitMoved(me: Me): void {
  if (me.movedToUri) throw new ChatErr(E.accountMoved, 403);
}

/** ChatService.getChatAvailability / checkChatAvailability (role policy `chatAvailability`). */
async function availability(env: ApiEnv, c: PgQueryable, userId: string): Promise<{ read: boolean; write: boolean }> {
  const v = (await getUserPoliciesPg(env, c, userId)).chatAvailability;
  if (v === "available") return { read: true, write: true };
  if (v === "readonly") return { read: true, write: false };
  return { read: false, write: false };
}
async function checkAvailability(env: ApiEnv, c: PgQueryable, userId: string, perm: "read" | "write"): Promise<void> {
  if (!(await availability(env, c, userId))[perm]) throw internal("ROLE_PERMISSION_DENIED");
}

function limitOf(body: Body, def: number): number {
  const l = body.limit === undefined ? def : body.limit;
  if (!Number.isInteger(l) || (l as number) < 1 || (l as number) > 100) throw bad();
  return l as number;
}
function checkPageParams(body: Body): void {
  for (const k of ["sinceId", "untilId"]) if (body[k] !== undefined && typeof body[k] !== "string") throw bad();
  for (const k of ["sinceDate", "untilDate"]) if (body[k] !== undefined && !Number.isInteger(body[k])) throw bad();
}
function requireId(body: Body, key: string): string {
  const v = body[key];
  if (typeof v !== "string" || !v) throw bad();
  return v;
}
function optString(body: Body, key: string, max: number, nullable = false): string | null | undefined {
  const v = body[key];
  if (v === undefined) return undefined;
  if (v === null && nullable) return null;
  if (typeof v !== "string" || v.length > max) throw bad();
  return v;
}

// ---------------------------------------------------------------- rows

const MSG_COLS = `m.id, m."fromUserId", m."toUserId", m."toRoomId", m.text, m."fileId", m.reactions, m.reads, m.uri`;

async function messageById(c: PgQueryable, id: string): Promise<Row | null> {
  return (await c.query(`SELECT ${MSG_COLS} FROM chat_message m WHERE m.id = $1`, [id])).rows[0] ?? null;
}
async function roomById(c: PgQueryable, id: string): Promise<Row | null> {
  return (await c.query(`SELECT r.* FROM chat_room r WHERE r.id = $1`, [id])).rows[0] ?? null;
}
async function userById(c: PgQueryable, id: string): Promise<Row | null> {
  return (await c.query(`SELECT id, host, "chatScope" FROM "user" WHERE id = $1`, [id])).rows[0] ?? null;
}
async function membership(c: PgQueryable, roomId: string, userId: string): Promise<Row | null> {
  return (await c.query(`SELECT * FROM chat_room_membership WHERE "roomId" = $1 AND "userId" = $2`, [roomId, userId])).rows[0] ?? null;
}
/** ChatService.isRoomMember: the owner has no membership row. */
async function isRoomMember(c: PgQueryable, room: Row, userId: string): Promise<boolean> {
  if (room.ownerId === userId) return true;
  return (await membership(c, String(room.id), userId)) != null;
}
async function roomMemberIds(c: PgQueryable, room: Row): Promise<{ userId: string; isMuted: boolean; since: string }[]> {
  const rows = (await c.query(`SELECT id, "userId", "isMuted" FROM chat_room_membership WHERE "roomId" = $1`, [room.id])).rows;
  return rows
    .map((m) => ({ userId: String(m.userId), isMuted: Boolean(m.isMuted), since: String(m.id) }))
    .concat({ userId: String(room.ownerId), isMuted: false, since: String(room.id) });
}
async function isFollowing(c: PgQueryable, followerId: string, followeeId: string): Promise<boolean> {
  return (await c.query(`SELECT 1 AS ok FROM following WHERE "followerId" = $1 AND "followeeId" = $2 LIMIT 1`, [followerId, followeeId])).rows.length > 0;
}

// ---------------------------------------------------------------- packing (ChatEntityService)

async function userLites(env: ApiEnv, ids: string[]): Promise<Map<string, unknown>> {
  const uniq = [...new Set(ids.filter(Boolean))];
  return new Map(((await packUsers(env, uniq, null, false)) as { id: string }[]).map((u) => [u.id, u]));
}
async function packFiles(c: PgQueryable, ids: unknown[]): Promise<Map<string, unknown>> {
  const uniq = [...new Set(ids.filter((x): x is string => typeof x === "string"))];
  if (!uniq.length) return new Map();
  const rows = (await c.query(`SELECT * FROM drive_file WHERE id = ANY($1::varchar[])`, [uniq])).rows;
  return new Map(rows.map((r) => [String(r.id), packDriveFile(r)]));
}
const reactionPairs = (m: Row) => ((m.reactions as string[] | null) ?? []).map((r) => {
  const i = r.indexOf("/");
  return { userId: r.slice(0, i), reaction: r.slice(i + 1) };
});

/** packRoom / packRooms: owner (UserLite), and the viewer's isMuted / invitationExists. */
async function packRooms(env: ApiEnv, c: PgQueryable, rooms: Row[], meId: string | null): Promise<Record<string, unknown>[]> {
  if (!rooms.length) return [];
  const ids = rooms.map((r) => String(r.id));
  const owners = await userLites(env, rooms.map((r) => String(r.ownerId)));
  const mine = new Map<string, Row>();
  const invited = new Set<string>();
  if (meId) {
    for (const m of (await c.query(`SELECT "roomId", "isMuted" FROM chat_room_membership WHERE "userId" = $1 AND "roomId" = ANY($2::varchar[])`, [meId, ids])).rows) mine.set(String(m.roomId), m);
    for (const i of (await c.query(`SELECT "roomId" FROM chat_room_invitation WHERE "userId" = $1 AND "roomId" = ANY($2::varchar[])`, [meId, ids])).rows) invited.add(String(i.roomId));
  }
  return rooms.map((r) => {
    const own = meId != null && meId === r.ownerId;
    return {
      id: String(r.id),
      createdAt: createdAt(r.id),
      name: r.name,
      description: r.description ?? "",
      ownerId: r.ownerId,
      owner: owners.get(String(r.ownerId)) ?? null,
      isMuted: !own && meId ? Boolean(mine.get(String(r.id))?.isMuted) : false,
      invitationExists: !own && meId ? invited.has(String(r.id)) : false,
    };
  });
}

async function packRoomsById(env: ApiEnv, c: PgQueryable, ids: string[], meId: string | null): Promise<Map<string, Record<string, unknown>>> {
  const uniq = [...new Set(ids)];
  if (!uniq.length) return new Map();
  const rows = (await c.query(`SELECT r.* FROM chat_room r WHERE r.id = ANY($1::varchar[])`, [uniq])).rows;
  return new Map((await packRooms(env, c, rows, meId)).map((r) => [String(r.id), r]));
}

/** packMessagesLiteFor1on1 */
async function packLite1on1(c: PgQueryable, msgs: Row[]): Promise<Record<string, unknown>[]> {
  const files = await packFiles(c, msgs.map((m) => m.fileId));
  return msgs.map((m) => ({
    id: String(m.id),
    createdAt: createdAt(m.id),
    text: (m.text as string | null) ?? null,
    fromUserId: m.fromUserId,
    toUserId: m.toUserId,
    fileId: (m.fileId as string | null) ?? null,
    file: m.fileId ? (files.get(String(m.fileId)) ?? null) : null,
    reactions: reactionPairs(m).map((r) => ({ reaction: r.reaction })),
  }));
}

/** packMessagesLiteForRoom (reactions of vanished users dropped) */
async function packLiteRoom(env: ApiEnv, c: PgQueryable, msgs: Row[]): Promise<Record<string, unknown>[]> {
  const files = await packFiles(c, msgs.map((m) => m.fileId));
  const users = await userLites(env, [...msgs.map((m) => String(m.fromUserId)), ...msgs.flatMap((m) => reactionPairs(m).map((r) => r.userId))]);
  return msgs.map((m) => ({
    id: String(m.id),
    createdAt: createdAt(m.id),
    text: (m.text as string | null) ?? null,
    fromUserId: m.fromUserId,
    fromUser: users.get(String(m.fromUserId)) ?? null,
    toRoomId: m.toRoomId,
    fileId: (m.fileId as string | null) ?? null,
    file: m.fileId ? (files.get(String(m.fileId)) ?? null) : null,
    reactions: reactionPairs(m).filter((r) => users.has(r.userId)).map((r) => ({ user: users.get(r.userId), reaction: r.reaction })),
  }));
}

/** packMessagesDetailed (ChatMessage): toUser / toRoom only when set. */
async function packDetailed(env: ApiEnv, c: PgQueryable, msgs: Row[], meId: string | null): Promise<Record<string, unknown>[]> {
  if (!msgs.length) return [];
  const files = await packFiles(c, msgs.map((m) => m.fileId));
  const users = await userLites(env, [
    ...msgs.map((m) => String(m.fromUserId)),
    ...msgs.map((m) => (m.toUserId as string | null) ?? ""),
    ...msgs.flatMap((m) => reactionPairs(m).map((r) => r.userId)),
  ]);
  const rooms = await packRoomsById(env, c, msgs.map((m) => m.toRoomId).filter((x): x is string => typeof x === "string"), meId);
  return msgs.map((m) => {
    const out: Record<string, unknown> = {
      id: String(m.id),
      createdAt: createdAt(m.id),
      text: (m.text as string | null) ?? null,
      fromUserId: m.fromUserId,
      fromUser: users.get(String(m.fromUserId)) ?? null,
      toUserId: (m.toUserId as string | null) ?? null,
    };
    if (m.toUserId) out.toUser = users.get(String(m.toUserId)) ?? null;
    out.toRoomId = (m.toRoomId as string | null) ?? null;
    if (m.toRoomId) out.toRoom = rooms.get(String(m.toRoomId)) ?? null;
    out.fileId = (m.fileId as string | null) ?? null;
    out.file = m.fileId ? (files.get(String(m.fileId)) ?? null) : null;
    out.reactions = reactionPairs(m).filter((r) => users.has(r.userId)).map((r) => ({ user: users.get(r.userId), reaction: r.reaction }));
    return out;
  });
}

async function packInvitations(env: ApiEnv, c: PgQueryable, invs: Row[], meId: string): Promise<Record<string, unknown>[]> {
  if (!invs.length) return [];
  const rooms = await packRoomsById(env, c, invs.map((i) => String(i.roomId)), meId);
  const users = await userLites(env, invs.map((i) => String(i.userId)));
  return invs.map((i) => ({
    id: String(i.id),
    createdAt: createdAt(i.id),
    roomId: i.roomId,
    room: rooms.get(String(i.roomId)) ?? null,
    userId: i.userId,
    user: users.get(String(i.userId)) ?? null,
  }));
}

/** packRoomInvitation by id (notifications `chatRoomInvitationReceived`); null when gone. */
export async function packChatRoomInvitationsPg(env: ApiEnv, ids: string[], meId: string): Promise<Map<string, Record<string, unknown>>> {
  if (!ids.length || !env.HYPERDRIVE?.connectionString) return new Map();
  return withHyperdriveClient(hd(env), async (c) => {
    const rows = (await c.query(`SELECT * FROM chat_room_invitation WHERE id = ANY($1::varchar[])`, [ids])).rows;
    return new Map((await packInvitations(env, c, rows, meId)).map((i) => [String(i.id), i]));
  });
}

async function packMemberships(env: ApiEnv, c: PgQueryable, ms: Row[], meId: string, opts: { populateUser: boolean; populateRoom: boolean }): Promise<Record<string, unknown>[]> {
  const users = opts.populateUser ? await userLites(env, ms.map((m) => String(m.userId))) : new Map();
  const rooms = opts.populateRoom ? await packRoomsById(env, c, ms.map((m) => String(m.roomId)), meId) : new Map();
  return ms.map((m) => {
    const out: Record<string, unknown> = { id: String(m.id), createdAt: createdAt(m.id), userId: m.userId };
    if (opts.populateUser) out.user = users.get(String(m.userId)) ?? null;
    out.roomId = m.roomId;
    if (opts.populateRoom) out.room = rooms.get(String(m.roomId)) ?? null;
    return out;
  });
}

// ---------------------------------------------------------------- unread state (PG `reads`)

/** `reads` entry written by chat/read-all: clears the global unread flag only (see the header). */
const READ_ALL_MARK = (userId: string) => `!${userId}`;

async function readUserChat(c: PgQueryable, readerId: string, senderId: string): Promise<void> {
  await c.query(
    `UPDATE chat_message SET reads = array_append(reads, $1::varchar) WHERE "toUserId" = $1 AND "fromUserId" = $2 AND NOT ($1::varchar = ANY(reads))`,
    [readerId, senderId],
  );
}
async function readRoomChat(c: PgQueryable, readerId: string, roomId: string): Promise<void> {
  await c.query(
    `UPDATE chat_message SET reads = array_append(reads, $1::varchar)
     WHERE id IN (SELECT id FROM chat_message WHERE "toRoomId" = $2 AND "fromUserId" <> $1 ORDER BY id DESC LIMIT ${ROOM_READ_WINDOW})
       AND NOT ($1::varchar = ANY(reads))`,
    [readerId, roomId],
  );
}

/** The caller's rooms (memberships + owned) with "joined" ids, as SQL (param $1 = user). */
const MY_ROOMS = (unmutedOnly: boolean) => `(
  SELECT cm."roomId", cm.id AS since FROM chat_room_membership cm WHERE cm."userId" = $1${unmutedOnly ? ` AND NOT cm."isMuted"` : ""}
  UNION ALL SELECT r.id, r.id FROM chat_room r WHERE r."ownerId" = $1)`;

/**
 * Rooms (among `roomIds`, or all of mine) whose latest message from someone else I have not read
 * (per-conversation marker). `global`: also treat chat/read-all marks as read (global flag).
 */
async function unreadRooms(c: PgQueryable, userId: string, roomIds: string[] | null, global = false): Promise<Set<string>> {
  const params: unknown[] = [userId];
  let filter = "";
  if (roomIds) {
    params.push(roomIds);
    filter = `WHERE x."roomId" = ANY($2::varchar[])`;
  }
  let readAll = "";
  if (global) {
    params.push(READ_ALL_MARK(userId));
    readAll = ` AND NOT ($${params.length}::varchar = ANY(l.reads))`;
  }
  const rows = (await c.query(
    `SELECT x."roomId" FROM ${MY_ROOMS(true)} x
     CROSS JOIN LATERAL (SELECT m.id, m.reads FROM chat_message m WHERE m."toRoomId" = x."roomId" AND m."fromUserId" <> $1 ORDER BY m.id DESC LIMIT 1) l
     ${filter} ${filter ? "AND" : "WHERE"} l.id > x.since AND NOT ($1::varchar = ANY(l.reads))${readAll}`,
    params,
  )).rows;
  return new Set(rows.map((r) => String(r.roomId)));
}

/** ChatService.hasUnreadMessages (MeDetailed.hasUnreadChatMessages). False when the tables are missing. */
export async function hasUnreadChatMessagesPg(c: PgQueryable, userId: string): Promise<boolean> {
  try {
    const dm = await c.query(
      `SELECT 1 AS ok FROM chat_message WHERE "toUserId" = $1 AND NOT ($1::varchar = ANY(reads)) AND NOT ($2::varchar = ANY(reads)) LIMIT 1`,
      [userId, READ_ALL_MARK(userId)],
    );
    if (dm.rows.length) return true;
    return (await unreadRooms(c, userId, null, true)).size > 0;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- streaming

async function publishUser(env: ApiEnv, local: Set<string>, owner: string, other: string, type: string, body: unknown): Promise<void> {
  if (local.has(owner)) await publishToUserStream(env, owner, `chatUser:${other}`, type, body);
}
/**
 * publishChatRoomStream: everyone whose `chatRoom` channel passed hasPermissionToViewRoomTimeline,
 * i.e. the owner / members and moderators watching the room (online and subscribed, per StreamPresence).
 */
async function publishRoom(env: ApiEnv, c: PgQueryable, room: Row, type: string, body: unknown): Promise<void> {
  if (!env.STREAM_HUB) return;
  const key = `chatRoom:${room.id}`;
  const targets = new Set((await roomMemberIds(c, room)).map((m) => m.userId));
  const mods = (await moderatorIds(env, c)).filter((id) => !targets.has(id));
  if (mods.length) {
    const online = await onlineChannels(env, mods);
    for (const id of mods) if (online.get(id)?.includes(key)) targets.add(id);
  }
  await Promise.all([...targets].map((id) => publishToUserStream(env, id, key, type, body)));
}
async function localUsers(c: PgQueryable, ids: string[]): Promise<Set<string>> {
  const rows = (await c.query(`SELECT id FROM "user" WHERE id = ANY($1::varchar[]) AND host IS NULL`, [ids])).rows;
  return new Set(rows.map((r) => String(r.id)));
}

/** StreamPresence `/lookup`: each online user's subscribed channels. */
async function onlineChannels(env: ApiEnv, userIds: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  const ns = env.STREAM_PRESENCE;
  if (!ns || !userIds.length) return out;
  const n = Math.max(1, Number(env.STREAM_SHARD_COUNT) || 16);
  const byShard = new Map<string, string[]>();
  for (const id of userIds) {
    const s = streamShardId(id, n);
    byShard.set(s, [...(byShard.get(s) ?? []), id]);
  }
  await Promise.all([...byShard].map(async ([shard, ids]) => {
    try {
      for (const [id, chs] of Object.entries(await ns.get(ns.idFromName(shard)).lookup(ids))) out.set(id, chs);
    } catch {
      /* best-effort */
    }
  }));
  return out;
}

// ---------------------------------------------------------------- newChatMessage (delayed)

export type ChatNotifyJob = { kind: "chatNotify"; messageId: string };

/** The delayed half of createMessageToUser / createMessageToRoom: main `newChatMessage` + Web Push to recipients that have not read it. */
export async function runChatNotifyJob(env: ApiEnv, job: ChatNotifyJob): Promise<void> {
  if (!env.HYPERDRIVE?.connectionString) return;
  const plan = await withHyperdriveClient(hd(env), async (c) => {
    const m = await messageById(c, job.messageId);
    if (!m) return null;
    const reads = new Set((m.reads as string[] | null) ?? []);
    let recipients: string[];
    let channel: string;
    if (m.toUserId) {
      recipients = [...(await localUsers(c, [String(m.toUserId)]))];
      channel = `chatUser:${m.fromUserId}`;
    } else {
      const room = await roomById(c, String(m.toRoomId));
      if (!room) return null;
      recipients = (await roomMemberIds(c, room)).filter((x) => x.userId !== m.fromUserId && !x.isMuted && x.since < String(m.id)).map((x) => x.userId);
      channel = `chatRoom:${room.id}`;
    }
    recipients = recipients.filter((id) => !reads.has(id));
    if (!recipients.length) return null;
    // a socket watching the conversation would have sent `read` (upstream client) → read
    const online = await onlineChannels(env, recipients);
    const watching = recipients.filter((id) => online.get(id)?.includes(channel));
    for (const id of watching) {
      if (m.toUserId) await readUserChat(c, id, String(m.fromUserId));
      else await readRoomChat(c, id, String(m.toRoomId));
    }
    recipients = recipients.filter((id) => !watching.includes(id));
    if (!recipients.length) return null;
    const [packed] = await packDetailed(env, c, [m], m.toUserId ? String(m.toUserId) : null);
    return { recipients, packed };
  });
  if (!plan?.packed) return;
  const { pushNotification } = await import("./sw-pg.js");
  for (const uid of plan.recipients) {
    await publishToUserStream(env, uid, "main", "newChatMessage", plan.packed);
    await pushNotification(env, uid, "newChatMessage", plan.packed);
  }
}

async function scheduleChatNotify(env: ApiEnv, messageId: string): Promise<void> {
  const job: ChatNotifyJob = { kind: "chatNotify", messageId };
  try {
    if (env.Q_JOBS) await enqueueJob(env, job, { delaySeconds: 3 });
    else await runChatNotifyJob(env, job);
  } catch (e) {
    console.warn(`chat notify failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ---------------------------------------------------------------- messages

/** `fileId` param (`{ type: 'string', format: 'misskey:id' }`, not nullable). */
function optFileId(body: Body): string | undefined {
  const v = body.fileId;
  if (v === undefined) return undefined;
  if (typeof v !== "string" || !v) throw bad();
  return v;
}
async function ownFile(c: PgQueryable, fileId: string | undefined, userId: string): Promise<Row | null | undefined> {
  if (fileId === undefined) return undefined;
  return (await c.query(`SELECT id FROM drive_file WHERE id = $1 AND "userId" = $2`, [fileId, userId])).rows[0] ?? null;
}

async function insertMessage(c: PgQueryable, fromUserId: string, to: { toUserId?: string; toRoomId?: string }, text: string | null | undefined, fileId: string | null): Promise<Row> {
  const id = genAidx(Date.now());
  await c.query(
    `INSERT INTO chat_message (id, "fromUserId", "toUserId", "toRoomId", text, "fileId", reads, uri) VALUES ($1, $2, $3, $4, $5, $6, '{}', NULL)`,
    [id, fromUserId, to.toUserId ?? null, to.toRoomId ?? null, text ? text.trim() : null, fileId],
  );
  return (await messageById(c, id))!;
}

const createToUser: Handler = (env, body, ctx) => withHyperdriveClient(hd(env), async (c) => {
  const me = await requireMe(env, c, body, ctx);
  prohibitMoved(me);
  const text = optString(body, "text", 2000, true);
  const fileId = optFileId(body);
  const toUserId = requireId(body, "toUserId");
  await checkAvailability(env, c, me.id, "write");
  const file = await ownFile(c, fileId, me.id);
  if (file === null) throw fail(E.ctuNoSuchFile);
  if (text == null && !file) throw fail(E.ctuContentRequired);
  if (toUserId === me.id) throw fail(E.ctuYourself);
  const toUser = await userById(c, toUserId);
  if (!toUser) throw fail(E.ctuNoSuchUser);

  // ChatService.createMessageToUser
  const approvals = (await c.query(
    `SELECT "userId" FROM chat_approval WHERE ("userId" = $1 AND "otherId" = $2) OR ("userId" = $2 AND "otherId" = $1) LIMIT 2`,
    [me.id, toUserId],
  )).rows;
  const otherApprovedMe = approvals.some((a) => a.userId === toUserId);
  const iApprovedOther = approvals.some((a) => a.userId === me.id);
  if (!otherApprovedMe) {
    const scope = String(toUser.chatScope ?? "mutual");
    if (scope === "none") throw internal("recipient is cannot chat (none)");
    if (scope === "followers" && !(await isFollowing(c, me.id, toUserId))) throw internal("recipient is cannot chat (followers)");
    if (scope === "following" && !(await isFollowing(c, toUserId, me.id))) throw internal("recipient is cannot chat (following)");
    if (scope === "mutual" && !((await isFollowing(c, me.id, toUserId)) && (await isFollowing(c, toUserId, me.id)))) throw internal("recipient is cannot chat (mutual)");
  }
  if (!(await availability(env, c, toUserId)).write) throw internal("recipient is cannot chat (policy)");
  if ((await c.query(`SELECT 1 AS ok FROM blocking WHERE "blockerId" = $1 AND "blockeeId" = $2`, [toUserId, me.id])).rows.length) throw internal("blocked");

  const msg = await insertMessage(c, me.id, { toUserId }, text, file ? String(file.id) : null);
  if (!iApprovedOther) {
    await c.query(`INSERT INTO chat_approval (id, "userId", "otherId") VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [genAidx(Date.now()), me.id, toUserId]);
  }
  const [packed] = await packLite1on1(c, [msg]);
  const local = new Set([...(me.host == null ? [me.id] : []), ...(toUser.host == null ? [toUserId] : [])]);
  await publishUser(env, local, me.id, toUserId, "message", packed);
  await publishUser(env, local, toUserId, me.id, "message", packed);
  if (toUser.host == null) await scheduleChatNotify(env, String(msg.id));
  return packed;
});

const createToRoom: Handler = (env, body, ctx) => withHyperdriveClient(hd(env), async (c) => {
  const me = await requireMe(env, c, body, ctx);
  prohibitMoved(me);
  const text = optString(body, "text", 2000, true);
  const fileId = optFileId(body);
  const roomId = requireId(body, "toRoomId");
  await checkAvailability(env, c, me.id, "write");
  const room = await roomById(c, roomId);
  if (!room) throw fail(E.ctrNoSuchRoom);
  const file = await ownFile(c, fileId, me.id);
  if (file === null) throw fail(E.ctrNoSuchFile);
  if (text == null && !file) throw fail(E.ctrContentRequired);
  if (!(await isRoomMember(c, room, me.id))) throw internal("you are not a member of the room");
  const msg = await insertMessage(c, me.id, { toRoomId: roomId }, text, file ? String(file.id) : null);
  const [packed] = await packLiteRoom(env, c, [msg]);
  await publishRoom(env, c, room, "message", packed);
  await scheduleChatNotify(env, String(msg.id));
  return packed;
});

const deleteMessage: Handler = (env, body, ctx) => withHyperdriveClient(hd(env), async (c) => {
  const me = await requireMe(env, c, body, ctx);
  const messageId = requireId(body, "messageId");
  await checkAvailability(env, c, me.id, "write");
  const m = await messageById(c, messageId);
  if (!m || m.fromUserId !== me.id) throw fail(E.deleteNoSuchMessage);
  await c.query(`DELETE FROM chat_message WHERE id = $1`, [m.id]);
  if (m.toUserId) {
    const local = await localUsers(c, [String(m.fromUserId), String(m.toUserId)]);
    await publishUser(env, local, String(m.fromUserId), String(m.toUserId), "deleted", m.id);
    await publishUser(env, local, String(m.toUserId), String(m.fromUserId), "deleted", m.id);
  } else if (m.toRoomId) {
    const room = await roomById(c, String(m.toRoomId));
    if (room) await publishRoom(env, c, room, "deleted", m.id);
  }
  return new Response(null, { status: 204 });
});

const showMessage: Handler = (env, body, ctx) => withHyperdriveClient(hd(env), async (c) => {
  const me = await requireMe(env, c, body, ctx);
  const messageId = requireId(body, "messageId");
  await checkAvailability(env, c, me.id, "read");
  const m = await messageById(c, messageId);
  if (!m) throw fail(E.showNoSuchMessage);
  if (m.fromUserId !== me.id && m.toUserId !== me.id && !(await isModeratorPg(env, c, me.id))) throw fail(E.showNoSuchMessage);
  return (await packDetailed(env, c, [m], me.id))[0];
});

class AccessError extends Error {}

async function normalizeReaction(c: PgQueryable, raw: string, checkExists: boolean): Promise<string> {
  const custom = CUSTOM_EMOJI_RE.exec(raw);
  if (custom) {
    if (checkExists && !(await getLocalEmojiPg(c, custom[1]!))) throw internal("no such emoji");
    return `:${custom[1]}:`;
  }
  const match = EMOJI_RE.exec(raw);
  if (!match) throw internal("invalid emoji");
  const unicode = match[0];
  return unicode.includes("‍") ? unicode : unicode.replace(/️/g, "");
}

function reactionHandler(op: "react" | "unreact"): Handler {
  return (env, body, ctx) => withHyperdriveClient(hd(env), async (c) => {
    const me = await requireMe(env, c, body, ctx);
    const messageId = requireId(body, "messageId");
    if (typeof body.reaction !== "string") throw bad();
    await checkAvailability(env, c, me.id, "write");
    const reaction = await normalizeReaction(c, body.reaction, op === "react");
    try {
      const m = await messageById(c, messageId);
      if (!m) throw new AccessError("no such message");
      if (op === "react") {
        if (m.fromUserId === me.id) throw new AccessError("cannot react to own message");
        if (m.toRoomId == null && m.toUserId !== me.id) throw new AccessError("cannot react to others message");
      }
      const room = m.toRoomId ? await roomById(c, String(m.toRoomId)) : null;
      if (m.toRoomId && !room) throw internal("room not found");
      if (room) {
        if (!(await isRoomMember(c, room, me.id))) throw new AccessError(`cannot ${op} to others message`);
      } else if (op === "unreact" && m.fromUserId !== me.id && m.toUserId !== me.id) {
        throw new AccessError("cannot unreact to others message");
      }
      const pair = `${me.id}/${reaction}`;
      if (op === "react") {
        if (((m.reactions as string[] | null) ?? []).length >= MAX_REACTIONS_PER_MESSAGE) throw internal("too many reactions");
        await c.query(`UPDATE chat_message SET reactions = array_append(reactions, $2::varchar) WHERE id = $1`, [m.id, pair]);
      } else {
        await c.query(`UPDATE chat_message SET reactions = array_remove(reactions, $2::varchar) WHERE id = $1`, [m.id, pair]);
      }
      if (room) {
        const user = (await userLites(env, [me.id])).get(me.id) ?? null;
        await publishRoom(env, c, room, op, { messageId: m.id, user, reaction });
      } else {
        const local = await localUsers(c, [String(m.fromUserId), String(m.toUserId)]);
        await publishUser(env, local, String(m.fromUserId), String(m.toUserId), op, { messageId: m.id, reaction });
        await publishUser(env, local, String(m.toUserId), String(m.fromUserId), op, { messageId: m.id, reaction });
      }
    } catch (e) {
      if (e instanceof AccessError) throw fail(op === "react" ? E.reactNoSuchMessage : E.unreactNoSuchMessage);
      throw e;
    }
    return new Response(null, { status: 204 });
  });
}

const userTimeline: Handler = (env, body, ctx) => withHyperdriveClient(hd(env), async (c) => {
  const me = await requireMe(env, c, body, ctx);
  const limit = limitOf(body, 10);
  checkPageParams(body);
  const otherId = requireId(body, "userId");
  await checkAvailability(env, c, me.id, "read");
  if (!(await userById(c, otherId))) throw fail(E.utNoSuchUser);
  const params: unknown[] = [me.id, otherId];
  const p = pagination(body, params, "m.id");
  params.push(limit);
  const rows = (await c.query(
    `SELECT ${MSG_COLS} FROM chat_message m
     WHERE ${[`((m."fromUserId" = $1 AND m."toUserId" = $2) OR (m."fromUserId" = $2 AND m."toUserId" = $1))`, ...p.where].join(" AND ")}
     ORDER BY m.id ${p.order} LIMIT $${params.length}`,
    params,
  )).rows;
  await readUserChat(c, me.id, otherId);
  return packLite1on1(c, rows);
});

const roomTimeline: Handler = (env, body, ctx) => withHyperdriveClient(hd(env), async (c) => {
  const me = await requireMe(env, c, body, ctx);
  const limit = limitOf(body, 10);
  checkPageParams(body);
  const roomId = requireId(body, "roomId");
  await checkAvailability(env, c, me.id, "read");
  const room = await roomById(c, roomId);
  if (!room) throw fail(E.rtNoSuchRoom);
  // hasPermissionToViewRoomTimeline: members or moderators
  if (!(await isRoomMember(c, room, me.id)) && !(await isModeratorPg(env, c, me.id))) throw fail(E.rtNoSuchRoom);
  const params: unknown[] = [roomId];
  const p = pagination(body, params, "m.id");
  params.push(limit);
  const rows = (await c.query(
    `SELECT ${MSG_COLS} FROM chat_message m WHERE ${[`m."toRoomId" = $1`, ...p.where].join(" AND ")} ORDER BY m.id ${p.order} LIMIT $${params.length}`,
    params,
  )).rows;
  await readRoomChat(c, me.id, roomId);
  return packLiteRoom(env, c, rows);
});

const search: Handler = (env, body, ctx) => withHyperdriveClient(hd(env), async (c) => {
  const me = await requireMe(env, c, body, ctx);
  const q = body.query;
  if (typeof q !== "string" || q.length < 1 || q.length > 256) throw bad();
  const limit = limitOf(body, 10);
  const userId = body.userId == null ? null : requireId(body, "userId");
  const roomId = body.roomId == null ? null : requireId(body, "roomId");
  await checkAvailability(env, c, me.id, "read");
  if (roomId != null) {
    const room = await roomById(c, roomId);
    if (!room || !(await isRoomMember(c, room, me.id))) throw fail(E.searchNoSuchRoom);
  }
  const params: unknown[] = [me.id];
  let scope: string;
  if (userId) {
    params.push(userId);
    scope = `((m."fromUserId" = $1 AND m."toUserId" = $2) OR (m."fromUserId" = $2 AND m."toUserId" = $1))`;
  } else if (roomId) {
    params.push(roomId);
    scope = `m."toRoomId" = $2`;
  } else {
    scope = `(m."fromUserId" = $1 OR m."toUserId" = $1
      OR m."toRoomId" IN (SELECT "roomId" FROM chat_room_membership WHERE "userId" = $1)
      OR m."toRoomId" IN (SELECT id FROM chat_room WHERE "ownerId" = $1))`;
  }
  params.push(`%${q.toLowerCase().replace(/[\\%_]/g, (x) => `\\${x}`)}%`);
  const like = `$${params.length}`;
  params.push(limit);
  const rows = (await c.query(
    `SELECT ${MSG_COLS} FROM chat_message m WHERE ${scope} AND LOWER(m.text) LIKE ${like} ORDER BY m.id DESC LIMIT $${params.length}`,
    params,
  )).rows;
  return packDetailed(env, c, rows, me.id);
});

// ---------------------------------------------------------------- history / read-all

const history: Handler = (env, body, ctx) => withHyperdriveClient(hd(env), async (c) => {
  const me = await requireMe(env, c, body, ctx);
  const limit = limitOf(body, 10);
  if (body.room !== undefined && typeof body.room !== "boolean") throw bad();
  const room = body.room === true;
  await checkAvailability(env, c, me.id, "read");
  let rows: Row[];
  if (room) {
    // ChatService.roomHistory: latest message of each room I own or belong to
    rows = (await c.query(
      `SELECT * FROM (SELECT DISTINCT ON (m."toRoomId") ${MSG_COLS} FROM chat_message m
         WHERE m."toRoomId" IN (SELECT "roomId" FROM ${MY_ROOMS(false)} x)
         ORDER BY m."toRoomId", m.id DESC) t ORDER BY t.id DESC LIMIT $2`,
      [me.id, limit],
    )).rows;
  } else {
    // ChatService.userHistory: latest 1:1 message per partner, muted users excluded
    rows = (await c.query(
      `SELECT * FROM (SELECT DISTINCT ON (partner) ${MSG_COLS}, CASE WHEN m."fromUserId" = $1 THEN m."toUserId" ELSE m."fromUserId" END AS partner
         FROM chat_message m
         WHERE (m."fromUserId" = $1 OR m."toUserId" = $1) AND m."toRoomId" IS NULL
           AND m."fromUserId" NOT IN (SELECT "muteeId" FROM muting WHERE "muterId" = $1)
           AND m."toUserId" NOT IN (SELECT "muteeId" FROM muting WHERE "muterId" = $1)
         ORDER BY partner, m.id DESC) t ORDER BY t.id DESC LIMIT $2`,
      [me.id, limit],
    )).rows;
  }
  const packed = await packDetailed(env, c, rows, me.id);
  if (room) {
    const unread = await unreadRooms(c, me.id, rows.map((m) => String(m.toRoomId)));
    for (const m of packed) m.isRead = !unread.has(String(m.toRoomId));
  } else {
    const others = rows.map((m) => String(m.fromUserId === me.id ? m.toUserId : m.fromUserId));
    const unread = new Set((await c.query(
      `SELECT DISTINCT "fromUserId" FROM chat_message WHERE "toUserId" = $1 AND "fromUserId" = ANY($2::varchar[]) AND NOT ($1::varchar = ANY(reads))`,
      [me.id, others],
    )).rows.map((r) => String(r.fromUserId)));
    for (const m of packed) m.isRead = !unread.has(String(m.fromUserId === me.id ? m.toUserId : m.fromUserId));
  }
  return packed;
});

/**
 * ChatService.readAllChatMessages only deletes the global `newChatMessagesExists` set: the
 * per-conversation markers stay, so `history[].isRead` keeps them unread. Here: mark the unread
 * messages with READ_ALL_MARK, which only hasUnreadChatMessages honours.
 */
const readAll: Handler = (env, body, ctx) => withHyperdriveClient(hd(env), async (c) => {
  const me = await requireMe(env, c, body, ctx);
  await checkAvailability(env, c, me.id, "read");
  const mark = READ_ALL_MARK(me.id);
  await c.query(
    `UPDATE chat_message SET reads = array_append(reads, $2::varchar)
     WHERE "toUserId" = $1 AND NOT ($1::varchar = ANY(reads)) AND NOT ($2::varchar = ANY(reads))`,
    [me.id, mark],
  );
  // rooms: only the latest message from someone else decides a room's unread state
  await c.query(
    `UPDATE chat_message SET reads = array_append(reads, $2::varchar)
     WHERE id IN (SELECT l.id FROM ${MY_ROOMS(false)} x
       CROSS JOIN LATERAL (SELECT m.id FROM chat_message m WHERE m."toRoomId" = x."roomId" AND m."fromUserId" <> $1 ORDER BY m.id DESC LIMIT 1) l)
       AND NOT ($1::varchar = ANY(reads)) AND NOT ($2::varchar = ANY(reads))`,
    [me.id, mark],
  );
  return new Response(null, { status: 204 });
});

// ---------------------------------------------------------------- rooms

const roomCreate: Handler = (env, body, ctx) => withHyperdriveClient(hd(env), async (c) => {
  const me = await requireMe(env, c, body, ctx);
  prohibitMoved(me);
  const name = optString(body, "name", 256);
  if (name == null) throw bad();
  const description = optString(body, "description", 1024);
  await checkAvailability(env, c, me.id, "write");
  const id = genAidx(Date.now());
  await c.query(`INSERT INTO chat_room (id, name, description, "ownerId") VALUES ($1, $2, $3, $4)`, [id, name, description ?? "", me.id]);
  return (await packRooms(env, c, [(await roomById(c, id))!], null))[0];
});

const roomDelete: Handler = (env, body, ctx) => withHyperdriveClient(hd(env), async (c) => {
  const me = await requireMe(env, c, body, ctx);
  const roomId = requireId(body, "roomId");
  await checkAvailability(env, c, me.id, "write");
  const room = await roomById(c, roomId);
  if (!room) throw fail(E.roomDeleteNoSuchRoom);
  const isMod = await isModeratorPg(env, c, me.id);
  if (room.ownerId !== me.id && !isMod) throw fail(E.roomDeleteNoSuchRoom);
  // messages / memberships / invitations go with the room (FK ON DELETE CASCADE)
  await c.query(`DELETE FROM chat_room WHERE id = $1`, [roomId]);
  if (isMod) {
    await moderationLogPg(c, me.id, "deleteChatRoom", { roomId, room }, genAidx(Date.now()));
  }
  return new Response(null, { status: 204 });
});

const roomJoin: Handler = (env, body, ctx) => withHyperdriveClient(hd(env), async (c) => {
  const me = await requireMe(env, c, body, ctx);
  const roomId = requireId(body, "roomId");
  await checkAvailability(env, c, me.id, "write");
  const inv = (await c.query(`SELECT id FROM chat_room_invitation WHERE "roomId" = $1 AND "userId" = $2`, [roomId, me.id])).rows[0];
  if (!inv) throw internal("invitation not found");
  const n = Number((await c.query(`SELECT count(*)::int AS n FROM chat_room_membership WHERE "roomId" = $1`, [roomId])).rows[0]?.n ?? 0);
  if (n >= MAX_ROOM_MEMBERS) throw internal("room is full");
  await c.query(`INSERT INTO chat_room_membership (id, "userId", "roomId") VALUES ($1, $2, $3)`, [genAidx(Date.now()), me.id, roomId]);
  await c.query(`DELETE FROM chat_room_invitation WHERE id = $1`, [inv.id]);
  return new Response(null, { status: 204 });
});

const roomLeave: Handler = (env, body, ctx) => withHyperdriveClient(hd(env), async (c) => {
  const me = await requireMe(env, c, body, ctx);
  const roomId = requireId(body, "roomId");
  await checkAvailability(env, c, me.id, "write");
  const m = await membership(c, roomId, me.id);
  if (!m) throw internal("membership not found");
  await c.query(`DELETE FROM chat_room_membership WHERE id = $1`, [m.id]);
  return new Response(null, { status: 204 });
});

const roomMute: Handler = (env, body, ctx) => withHyperdriveClient(hd(env), async (c) => {
  const me = await requireMe(env, c, body, ctx);
  const roomId = requireId(body, "roomId");
  if (typeof body.mute !== "boolean") throw bad();
  await checkAvailability(env, c, me.id, "write");
  const m = await membership(c, roomId, me.id);
  if (!m) throw internal("membership not found");
  await c.query(`UPDATE chat_room_membership SET "isMuted" = $2 WHERE id = $1`, [m.id, body.mute]);
  return new Response(null, { status: 204 });
});

const roomShow: Handler = (env, body, ctx) => withHyperdriveClient(hd(env), async (c) => {
  const me = await requireMe(env, c, body, ctx);
  const roomId = requireId(body, "roomId");
  await checkAvailability(env, c, me.id, "read");
  const room = await roomById(c, roomId);
  if (!room) throw fail(E.roomShowNoSuchRoom);
  // hasPermissionToViewRoomInfo: owner, member, invitee, moderator
  const ok = (await isRoomMember(c, room, me.id))
    || (await c.query(`SELECT 1 AS ok FROM chat_room_invitation WHERE "roomId" = $1 AND "userId" = $2`, [roomId, me.id])).rows.length > 0
    || (await isModeratorPg(env, c, me.id));
  if (!ok) throw fail(E.roomShowNoSuchRoom);
  return (await packRooms(env, c, [room], me.id))[0];
});

const roomUpdate: Handler = (env, body, ctx) => withHyperdriveClient(hd(env), async (c) => {
  const me = await requireMe(env, c, body, ctx);
  const roomId = requireId(body, "roomId");
  const name = optString(body, "name", 256);
  const description = optString(body, "description", 1024);
  await checkAvailability(env, c, me.id, "write");
  const room = await roomById(c, roomId);
  if (!room || room.ownerId !== me.id) throw fail(E.roomUpdateNoSuchRoom);
  const sets: string[] = [];
  const params: unknown[] = [roomId];
  if (name != null) sets.push(`name = $${params.push(name)}`);
  if (description != null) sets.push(`description = $${params.push(description)}`);
  if (sets.length) await c.query(`UPDATE chat_room SET ${sets.join(", ")} WHERE id = $1`, params);
  return (await packRooms(env, c, [(await roomById(c, roomId))!], me.id))[0];
});

function pageQuery(table: string, where: string[], body: Body, params: unknown[], limit: number): string {
  const p = pagination(body, params, "t.id");
  params.push(limit);
  return `SELECT t.* FROM ${table} t WHERE ${[...where, ...p.where].join(" AND ")} ORDER BY t.id ${p.order} LIMIT $${params.length}`;
}

const roomOwned: Handler = (env, body, ctx) => withHyperdriveClient(hd(env), async (c) => {
  const me = await requireMe(env, c, body, ctx);
  const limit = limitOf(body, 30);
  checkPageParams(body);
  await checkAvailability(env, c, me.id, "read");
  const params: unknown[] = [me.id];
  const rows = (await c.query(pageQuery("chat_room", [`t."ownerId" = $1`], body, params, limit), params)).rows;
  return packRooms(env, c, rows, me.id);
});

const roomJoining: Handler = (env, body, ctx) => withHyperdriveClient(hd(env), async (c) => {
  const me = await requireMe(env, c, body, ctx);
  const limit = limitOf(body, 30);
  checkPageParams(body);
  await checkAvailability(env, c, me.id, "read");
  const params: unknown[] = [me.id];
  const rows = (await c.query(pageQuery("chat_room_membership", [`t."userId" = $1`], body, params, limit), params)).rows;
  return packMemberships(env, c, rows, me.id, { populateUser: false, populateRoom: true });
});

const roomMembers: Handler = (env, body, ctx) => withHyperdriveClient(hd(env), async (c) => {
  const me = await requireMe(env, c, body, ctx);
  const roomId = requireId(body, "roomId");
  const limit = limitOf(body, 30);
  checkPageParams(body);
  await checkAvailability(env, c, me.id, "read");
  const room = await roomById(c, roomId);
  if (!room || !(await isRoomMember(c, room, me.id))) throw fail(E.membersNoSuchRoom);
  const params: unknown[] = [roomId];
  const rows = (await c.query(pageQuery("chat_room_membership", [`t."roomId" = $1`], body, params, limit), params)).rows;
  return packMemberships(env, c, rows, me.id, { populateUser: true, populateRoom: false });
});

// ---------------------------------------------------------------- invitations

const invitationCreate: Handler = async (env, body, ctx) => {
  const created = await withHyperdriveClient(hd(env), async (c) => {
    const me = await requireMe(env, c, body, ctx);
    prohibitMoved(me);
    const roomId = requireId(body, "roomId");
    const inviteeId = requireId(body, "userId");
    await checkAvailability(env, c, me.id, "write");
    const room = await roomById(c, roomId);
    if (!room || room.ownerId !== me.id) throw fail(E.invCreateNoSuchRoom);
    // ChatService.createRoomInvitation
    if (inviteeId === me.id) throw internal("yourself");
    if (!(await userById(c, inviteeId))) throw internal("no such user");
    if (await isRoomMember(c, room, inviteeId)) throw internal("already member");
    if ((await c.query(`SELECT 1 AS ok FROM chat_room_invitation WHERE "roomId" = $1 AND "userId" = $2`, [roomId, inviteeId])).rows.length) throw internal("already invited");
    const n = Number((await c.query(`SELECT count(*)::int AS n FROM chat_room_membership WHERE "roomId" = $1`, [roomId])).rows[0]?.n ?? 0);
    if (n >= MAX_ROOM_MEMBERS) throw internal("room is full");
    const id = genAidx(Date.now());
    await c.query(`INSERT INTO chat_room_invitation (id, "userId", "roomId") VALUES ($1, $2, $3)`, [id, inviteeId, roomId]);
    const row = (await c.query(`SELECT * FROM chat_room_invitation WHERE id = $1`, [id])).rows[0]!;
    return { me: me.id, inviteeId, id, packed: (await packInvitations(env, c, [row], me.id))[0] };
  });
  const { createNotification } = await import("./notifications-do.js");
  await createNotification(env, created.inviteeId, { type: "chatRoomInvitationReceived", notifierId: created.me, invitationId: created.id });
  return created.packed;
};

const invitationIgnore: Handler = (env, body, ctx) => withHyperdriveClient(hd(env), async (c) => {
  const me = await requireMe(env, c, body, ctx);
  const roomId = requireId(body, "roomId");
  await checkAvailability(env, c, me.id, "write");
  const inv = (await c.query(`SELECT id FROM chat_room_invitation WHERE "roomId" = $1 AND "userId" = $2`, [roomId, me.id])).rows[0];
  if (!inv) throw internal("invitation not found");
  await c.query(`UPDATE chat_room_invitation SET ignored = TRUE WHERE id = $1`, [inv.id]);
  return new Response(null, { status: 204 });
});

const invitationInbox: Handler = (env, body, ctx) => withHyperdriveClient(hd(env), async (c) => {
  const me = await requireMe(env, c, body, ctx);
  const limit = limitOf(body, 30);
  checkPageParams(body);
  await checkAvailability(env, c, me.id, "read");
  const params: unknown[] = [me.id];
  const rows = (await c.query(pageQuery("chat_room_invitation", [`t."userId" = $1`, `t.ignored = FALSE`], body, params, limit), params)).rows;
  return packInvitations(env, c, rows, me.id);
});

const invitationOutbox: Handler = (env, body, ctx) => withHyperdriveClient(hd(env), async (c) => {
  const me = await requireMe(env, c, body, ctx);
  const roomId = requireId(body, "roomId");
  const limit = limitOf(body, 30);
  checkPageParams(body);
  await checkAvailability(env, c, me.id, "read");
  const room = await roomById(c, roomId);
  if (!room || room.ownerId !== me.id) throw fail(E.outboxNoSuchRoom);
  const params: unknown[] = [roomId];
  const rows = (await c.query(pageQuery("chat_room_invitation", [`t."roomId" = $1`], body, params, limit), params)).rows;
  return packInvitations(env, c, rows, me.id);
});

// ---------------------------------------------------------------- drive/files/attached-chat-messages

const attachedChatMessages: Handler = (env, body, ctx) => withHyperdriveClient(hd(env), async (c) => {
  const me = await requireMe(env, c, body, ctx);
  const limit = limitOf(body, 10);
  checkPageParams(body);
  const fileId = requireId(body, "fileId");
  const isMod = await isModeratorPg(env, c, me.id);
  if (!isMod) await checkAvailability(env, c, me.id, "read");
  const file = (await c.query(
    `SELECT id FROM drive_file WHERE id = $1${isMod ? "" : ` AND "userId" = $2`}`,
    isMod ? [fileId] : [fileId, me.id],
  )).rows[0];
  if (!file) throw fail(E.attachedNoSuchFile);
  const params: unknown[] = [fileId];
  const p = pagination(body, params, "m.id");
  params.push(limit);
  const rows = (await c.query(
    `SELECT ${MSG_COLS} FROM chat_message m WHERE ${[`m."fileId" = $1`, ...p.where].join(" AND ")} ORDER BY m.id ${p.order} LIMIT $${params.length}`,
    params,
  )).rows;
  return packDetailed(env, c, rows, me.id);
});

// ---------------------------------------------------------------- registry

function run(h: Handler): Handler {
  return async (env, body, ctx) => {
    if (!env.HYPERDRIVE?.connectionString) {
      return apiErrorResponse({ message: "Hyperdrive required.", code: "HYPERDRIVE_UNBOUND", id: "00000000-0000-4000-8000-0000000000b1", kind: "server" }, 501);
    }
    try {
      return await h(env, body, ctx);
    } catch (e) {
      if (e instanceof ChatErr) return apiErrorResponse(e.body, e.status);
      throw e;
    }
  };
}

const RAW: Record<string, Handler> = {
  "chat/messages/create-to-user": createToUser,
  "chat/messages/create-to-room": createToRoom,
  "chat/messages/delete": deleteMessage,
  "chat/messages/show": showMessage,
  "chat/messages/react": reactionHandler("react"),
  "chat/messages/unreact": reactionHandler("unreact"),
  "chat/messages/user-timeline": userTimeline,
  "chat/messages/room-timeline": roomTimeline,
  "chat/messages/search": search,
  "chat/rooms/create": roomCreate,
  "chat/rooms/delete": roomDelete,
  "chat/rooms/join": roomJoin,
  "chat/rooms/leave": roomLeave,
  "chat/rooms/mute": roomMute,
  "chat/rooms/show": roomShow,
  "chat/rooms/owned": roomOwned,
  "chat/rooms/joining": roomJoining,
  "chat/rooms/update": roomUpdate,
  "chat/rooms/members": roomMembers,
  "chat/rooms/invitations/create": invitationCreate,
  "chat/rooms/invitations/ignore": invitationIgnore,
  "chat/rooms/invitations/inbox": invitationInbox,
  "chat/rooms/invitations/outbox": invitationOutbox,
  "chat/history": history,
  "chat/read-all": readAll,
  "drive/files/attached-chat-messages": attachedChatMessages,
};

export const chatHandlers: Record<string, Handler> = Object.fromEntries(Object.entries(RAW).map(([k, h]) => [k, run(h)]));

