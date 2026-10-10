/**
 * Misskey streaming Connection protocol (offline / DO-shaped).
 * Client messages: connect | disconnect | channel
 * Server messages: channel (typed body)
 *
 * Channels a client may subscribe to: `ACCEPTED_CHANNELS` and `PARAM_CHANNELS`.
 */

export type StreamChannelName = "main" | "homeTimeline";

export interface ClientConnectMessage {
  type: "connect";
  body: { channel: string; id: string; params?: Record<string, unknown> };
}

export interface ClientDisconnectMessage {
  type: "disconnect";
  body: { id: string };
}

export interface ClientChannelMessage {
  type: "channel";
  body: { id: string; type: string; body?: unknown };
}

export type ClientMessage = ClientConnectMessage | ClientDisconnectMessage | ClientChannelMessage;

export interface ServerChannelMessage {
  type: "channel";
  body: { id: string; type: string; body: unknown };
}

export interface ChannelSub {
  /** Client-supplied subscription id */
  id: string;
  channel: StreamChannelName;
  params: Record<string, unknown>;
}

const SUPPORTED: ReadonlySet<string> = new Set(["main", "homeTimeline"]);

export function parseClientMessage(raw: string | object): ClientMessage | null {
  try {
    const msg = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!msg || typeof msg !== "object") return null;
    const m = msg as { type?: string; body?: unknown };
    if (m.type === "connect" || m.type === "disconnect" || m.type === "channel") {
      return m as ClientMessage;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * One WebSocket-equivalent connection: channel subscribe map + outbound queue.
 */
export class StreamConnection {
  readonly outbound: ServerChannelMessage[] = [];
  readonly subs = new Map<string, ChannelSub>();

  constructor(
    public readonly connectionId: string,
    public readonly userId: string | null,
  ) {}

  handleClientMessage(raw: string | object): { ok: boolean; error?: string } {
    const msg = parseClientMessage(raw);
    if (!msg) return { ok: false, error: "invalid_message" };

    if (msg.type === "connect") {
      const ch = msg.body.channel;
      if (!SUPPORTED.has(ch)) {
        return { ok: false, error: `unsupported_channel:${ch}` };
      }
      if (!msg.body.id) return { ok: false, error: "missing_id" };
      this.subs.set(msg.body.id, {
        id: msg.body.id,
        channel: ch as StreamChannelName,
        params: msg.body.params ?? {},
      });
      return { ok: true };
    }

    if (msg.type === "disconnect") {
      this.subs.delete(msg.body.id);
      return { ok: true };
    }

    // channel → ignore for now (read-only channels in this slice)
    return { ok: true };
  }

  /**
   * Push a typed event to all subs matching channel name.
   * `main` / `homeTimeline` map 1:1 to Misskey channel names.
   */
  deliver(channel: StreamChannelName, eventType: string, body: unknown): number {
    let n = 0;
    for (const sub of this.subs.values()) {
      if (sub.channel !== channel) continue;
      this.outbound.push({
        type: "channel",
        body: { id: sub.id, type: eventType, body },
      });
      n++;
    }
    return n;
  }

  subscribedChannels(): StreamChannelName[] {
    return [...new Set([...this.subs.values()].map((s) => s.channel))];
  }
}

/**
 * In-memory StreamHub — DO-shaped: connect / disconnect / route bus → connections.
 */
export class InMemoryStreamHub {
  readonly connections = new Map<string, StreamConnection>();
  private seq = 0;

  connect(userId: string | null): StreamConnection {
    const id = `conn-${++this.seq}`;
    const c = new StreamConnection(id, userId);
    this.connections.set(id, c);
    return c;
  }

  disconnect(connectionId: string): boolean {
    return this.connections.delete(connectionId);
  }

  get(connectionId: string): StreamConnection | undefined {
    return this.connections.get(connectionId);
  }

  /**
   * Route an InstanceBus-style event into matching connections.
   * Channel forms: `mainStream:{userId}`, `homeTimeline:{userId}`
   */
  onBusEvent(busChannel: string, eventType: string, body: unknown): number {
    let delivered = 0;
    const main = /^mainStream:(.+)$/.exec(busChannel);
    if (main) {
      const uid = main[1]!;
      for (const c of this.connections.values()) {
        if (c.userId !== uid) continue;
        delivered += c.deliver("main", eventType, body);
      }
      return delivered;
    }
    const home = /^homeTimeline:(.+)$/.exec(busChannel);
    if (home) {
      const uid = home[1]!;
      for (const c of this.connections.values()) {
        if (c.userId !== uid) continue;
        delivered += c.deliver("homeTimeline", eventType, body);
      }
      return delivered;
    }
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Pure helpers used by the StreamHub DO (WebSocket hibernation): subscription
// state lives in each socket's attachment as { id → channel }.
// ---------------------------------------------------------------------------

/** Channels a client may subscribe to without an id parameter. */
export const ACCEPTED_CHANNELS: ReadonlySet<string> = new Set([
  "main",
  // moderators: newAbuseUserReport (events are only ever published to moderators' hubs)
  "admin",
  "drive",
  "homeTimeline",
  "localTimeline",
  "hybridTimeline",
  "globalTimeline",
  // reversi matchmaking events for this user (invited / matched)
  "reversi",
]);

/**
 * Channels bound to one object through a connect param. The subscription is stored (and
 * reported to presence, and published to) as `<channel>:<id>`, e.g. `userList:9xyz`, so a
 * publish only reaches sockets watching that list / antenna / channel.
 */
export const PARAM_CHANNELS: Readonly<Record<string, string>> = {
  userList: "listId",
  antenna: "antennaId",
  channel: "channelId",
  roleTimeline: "roleId",
  // client frames on this channel are forwarded to the api worker's Reversi DO (game:{gameId})
  reversiGame: "gameId",
  chatUser: "otherId",
  chatRoom: "roomId",
};

/** Subscription key for a connect frame, or null when the channel or its param is invalid. */
export function subscriptionKey(channel: unknown, params: unknown): string | null {
  if (typeof channel !== "string") return null;
  if (ACCEPTED_CHANNELS.has(channel)) return channel;
  const param = PARAM_CHANNELS[channel];
  if (!param) return null;
  const v = params && typeof params === "object" ? (params as Record<string, unknown>)[param] : undefined;
  return typeof v === "string" && v.length > 0 && v.length <= 64 && !v.includes(":") ? `${channel}:${v}` : null;
}

export type SubMap = Record<string, string>;

/** Apply one client frame to a subscription map. Returns the new map (or same). */
export function applyClientFrame(subs: SubMap, raw: string): { subs: SubMap; changed: boolean; error?: string } {
  if (raw === "h" || raw === "ping") return { subs, changed: false }; // heartbeat
  const msg = parseClientMessage(raw);
  if (!msg) return { subs, changed: false, error: "invalid_message" };
  if (msg.type === "connect") {
    const { channel, id, params } = msg.body ?? ({} as { channel?: string; id?: string; params?: unknown });
    if (!id || typeof id !== "string") return { subs, changed: false, error: "missing_id" };
    const key = subscriptionKey(channel, params);
    if (!key) return { subs, changed: false, error: `unsupported_channel:${channel}` };
    return { subs: { ...subs, [id]: key }, changed: true };
  }
  if (msg.type === "disconnect") {
    const id = msg.body?.id;
    if (!id || !(id in subs)) return { subs, changed: false };
    const next = { ...subs };
    delete next[id];
    return { subs: next, changed: true };
  }
  return { subs, changed: false };
}

/**
 * Per-subscription timeline options (upstream channel `init(params)`), kept next to the
 * subscription map as `{ id → "RFP" }` digits: withRenotes (default 1), withFiles (default 0),
 * withReplies (default 0). Only non-default entries are stored (attachments are small).
 */
export type SubOpts = Record<string, string>;

/** Channels whose `note` events honour SubOpts (and which params they read, as upstream). */
const TL_PARAMS: Readonly<Record<string, readonly ("withRenotes" | "withFiles" | "withReplies")[]>> = {
  homeTimeline: ["withRenotes", "withFiles"],
  localTimeline: ["withRenotes", "withFiles", "withReplies"],
  hybridTimeline: ["withRenotes", "withFiles", "withReplies"],
  globalTimeline: ["withRenotes", "withFiles"],
  userList: ["withRenotes", "withFiles"],
};
const DEFAULT_OPTS = "100";

function channelBase(key: string): string {
  const i = key.indexOf(":");
  return i < 0 ? key : key.slice(0, i);
}

/** `!!(params.x ?? default)` for the channel's params, encoded; null when all defaults. */
export function subscriptionOpts(channel: unknown, params: unknown): string | null {
  if (typeof channel !== "string") return null;
  const names = TL_PARAMS[channel];
  if (!names) return null;
  const p = (params && typeof params === "object" ? params : {}) as Record<string, unknown>;
  const flag = (name: "withRenotes" | "withFiles" | "withReplies", def: boolean) => (names.includes(name) ? Boolean(p[name] ?? def) : def);
  const v = `${flag("withRenotes", true) ? 1 : 0}${flag("withFiles", false) ? 1 : 0}${flag("withReplies", false) ? 1 : 0}`;
  return v === DEFAULT_OPTS ? null : v;
}

/** The SubOpts after one client frame (connect sets / clears, disconnect clears). */
export function applyOptsFrame(opts: SubOpts, raw: string): SubOpts {
  const msg = raw === "h" || raw === "ping" ? null : parseClientMessage(raw);
  if (!msg || (msg.type !== "connect" && msg.type !== "disconnect")) return opts;
  const id = msg.body?.id;
  if (!id || typeof id !== "string") return opts;
  const next = { ...opts };
  delete next[id];
  if (msg.type === "connect") {
    const { channel, params } = msg.body as { channel?: unknown; params?: unknown };
    if (subscriptionKey(channel, params)) {
      const v = subscriptionOpts(channel, params);
      if (v) next[id] = v;
    }
  }
  return next;
}

/**
 * What the fanout knows about the recipient for one note (the hub has no PG): whether it follows
 * the author with withReplies, and which of the note's related users (reply / renote's reply
 * authors) it follows.
 */
export type NoteRelation = { followsAuthorWithReplies?: boolean; follows?: string[] };

type NoteLite = {
  userId?: string;
  fileIds?: string[] | null;
  text?: string | null;
  cw?: string | null;
  replyId?: string | null;
  renoteId?: string | null;
  poll?: unknown;
  reply?: { userId?: string; visibility?: string } | null;
  renote?: { id?: string; reply?: { userId?: string; visibility?: string } | null } | null;
};

/** misskey-js isRenotePacked && !isQuotePacked */
function isPureRenotePacked(n: NoteLite): boolean {
  return n.renoteId != null && !(n.text != null || n.cw != null || n.replyId != null || n.poll != null || (n.fileIds?.length ?? 0) > 0);
}

/**
 * upstream {Home,Local,Hybrid,Global}TimelineChannel / UserListChannel.onNote checks that depend on
 * the subscription: withFiles, replies (unless related, or the follow / channel has withReplies;
 * home / hybrid also hide replies to followers-only notes of unfollowed users) and pure renotes
 * (withRenotes; home / hybrid hide renotes of such replies). Other channels pass everything.
 */
export function noteAllowedOnChannel(channelKey: string, opts: string | undefined, note: NoteLite, me: string, rel: NoteRelation = {}): boolean {
  const ch = channelBase(channelKey);
  if (!TL_PARAMS[ch]) return true;
  const o = opts ?? DEFAULT_OPTS;
  const withRenotes = o[0] === "1";
  const withFiles = o[1] === "1";
  const withReplies = o[2] === "1";
  if (withFiles && (note.fileIds == null || note.fileIds.length === 0)) return false;
  const isMe = note.userId === me;
  const follows = (id: string | undefined) => id != null && (rel.follows ?? []).includes(id);
  const reply = note.reply;
  if (reply && (ch === "homeTimeline" || ch === "hybridTimeline")) {
    if (rel.followsAuthorWithReplies || (ch === "hybridTimeline" && withReplies)) {
      if (reply.visibility === "followers" && !follows(reply.userId) && reply.userId !== me) return false;
    } else if (reply.userId !== me && !isMe && reply.userId !== note.userId) {
      return false;
    }
  }
  if (reply && ch === "localTimeline" && !rel.followsAuthorWithReplies && !withReplies) {
    if (reply.userId !== me && !isMe && reply.userId !== note.userId) return false;
  }
  if (isPureRenotePacked(note) && note.renote) {
    if (!withRenotes) return false;
    const rr = note.renote.reply;
    if (rr && (ch === "homeTimeline" || ch === "hybridTimeline") && rr.visibility === "followers" && !follows(rr.userId) && rr.userId !== me) return false;
  }
  return true;
}

/**
 * Frames to send for a publish to `channel` given a socket's subs. With `filter`, `note` events
 * on timeline channels go through noteAllowedOnChannel per subscription.
 */
export function framesFor(
  subs: SubMap,
  channel: string,
  type: string,
  body: unknown,
  filter?: { opts: SubOpts; userId: string; rel?: NoteRelation },
): string[] {
  const out: string[] = [];
  for (const [id, ch] of Object.entries(subs)) {
    if (ch !== channel) continue;
    if (filter && type === "note" && body && typeof body === "object" && !noteAllowedOnChannel(ch, filter.opts[id], body as NoteLite, filter.userId, filter.rel)) continue;
    out.push(JSON.stringify({ type: "channel", body: { id, type, body } } satisfies ServerChannelMessage));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Note capture (upstream Connection: subNote / s / sr and unsubNote / un).
// ---------------------------------------------------------------------------

/** upstream MAX_SUBSCRIBING_NOTES_PER_CONNECTION */
export const MAX_NOTES_PER_CONNECTION = 1536;

/** `{ type: "s"|"sr"|"subNote"|"un"|"unsubNote", body: { id } }` → the note op, or null. */
export function parseNoteFrame(raw: string): { op: "sub" | "unsub"; noteId: string } | null {
  let msg: unknown;
  try {
    msg = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!msg || typeof msg !== "object") return null;
  const { type, body } = msg as { type?: unknown; body?: unknown };
  const id = body && typeof body === "object" ? (body as { id?: unknown }).id : undefined;
  if (typeof id !== "string" || !id || id.length > 64) return null;
  if (type === "s" || type === "sr" || type === "subNote") return { op: "sub", noteId: id };
  if (type === "un" || type === "unsubNote") return { op: "unsub", noteId: id };
  return null;
}

/**
 * Apply a note op to one socket's ref-counted subscriptions (insertion order = LRU, as upstream:
 * a new note past the limit evicts the oldest). Returns the notes that became / stopped being
 * subscribed on this socket.
 */
export function applyNoteOp(
  notes: Record<string, number>,
  op: { op: "sub" | "unsub"; noteId: string },
  max = MAX_NOTES_PER_CONNECTION,
): { notes: Record<string, number>; added: string[]; removed: string[] } {
  const next = { ...notes };
  const added: string[] = [];
  const removed: string[] = [];
  const cur = next[op.noteId] ?? 0;
  if (op.op === "sub") {
    if (cur === 0 && Object.keys(next).length >= max) {
      const oldest = Object.keys(next)[0];
      if (oldest != null) {
        delete next[oldest];
        removed.push(oldest);
      }
    }
    delete next[op.noteId]; // re-insert to refresh LRU order
    next[op.noteId] = cur + 1;
    if (cur === 0) added.push(op.noteId);
  } else {
    if (cur === 0) return { notes, added, removed };
    if (cur <= 1) {
      delete next[op.noteId];
      removed.push(op.noteId);
    } else next[op.noteId] = cur - 1;
  }
  return { notes: next, added, removed };
}

// ---------------------------------------------------------------------------
// Client → channel messages (upstream Channel.onMessage).
// ---------------------------------------------------------------------------

/**
 * `{ type: "channel", body: { id, type, body } }` on one of this socket's subscriptions →
 * the subscription key (e.g. `reversiGame:9xyz`) and the message, or null.
 */
export function parseChannelFrame(subs: SubMap, raw: string): { key: string; type: string; body: unknown } | null {
  const msg = parseClientMessage(raw);
  if (!msg || msg.type !== "channel") return null;
  const b = msg.body as { id?: unknown; type?: unknown; body?: unknown } | undefined;
  if (!b || typeof b.id !== "string" || typeof b.type !== "string") return null;
  const key = subs[b.id];
  return key ? { key, type: b.type, body: b.body ?? null } : null;
}
