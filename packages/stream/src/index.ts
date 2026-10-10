/// <reference path="../../shared/src/cloudflare-workers.d.ts" />
import { DurableObject } from "cloudflare:workers";
import { streamShardId } from "@misskey-cf/shared";
import { applyClientFrame, applyNoteOp, applyOptsFrame, framesFor, parseChannelFrame, parseNoteFrame, type SubMap, type SubOpts } from "./protocol.js";
import { unionChannels } from "./presence.js";
import type { DoNs, NoteWatchRpc, PublishEvent, StreamHubRpc, StreamPresenceRpc } from "../../shared/src/do-rpc.js";
import { noteWatchShard } from "./note-watch.js";
import { LAST_ACTIVE_REFRESH_MS, PRESENCE_RESYNC_MS } from "./constants.js";
export { StreamPresence, unionChannels } from "./presence.js";
export { NoteWatch, noteWatchShard } from "./note-watch.js";
export { streamShardId };
export {
  StreamConnection,
  InMemoryStreamHub,
  parseClientMessage,
  applyClientFrame,
  applyOptsFrame,
  framesFor,
  noteAllowedOnChannel,
  subscriptionOpts,
  ACCEPTED_CHANNELS,
  PARAM_CHANNELS,
  subscriptionKey,
  parseNoteFrame,
  parseChannelFrame,
  applyNoteOp,
  type SubMap,
  type SubOpts,
  type NoteRelation,
  type StreamChannelName,
  type ClientMessage,
  type ServerChannelMessage,
  type ChannelSub,
} from "./protocol.js";

/* Minimal Workers runtime typings (no @cloudflare/workers-types dependency). */
type HubSocket = {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  serializeAttachment(v: unknown): void;
  deserializeAttachment(): unknown;
};
type DurableObjectState = {
  id: { toString(): string };
  acceptWebSocket(ws: HubSocket, tags?: string[]): void;
  getWebSockets(tag?: string): HubSocket[];
  storage?: {
    get<T = unknown>(key: string): Promise<T | undefined>;
    put(key: string, value: unknown): Promise<void>;
    delete(key: string): Promise<boolean>;
    getAlarm?(): Promise<number | null>;
    setAlarm?(scheduledTime: number): Promise<void>;
  };
};
/** Workers RPC entrypoint `ApiInternal` on misskey-cf-api (service binding, not public). */
export type ApiInternalRpc = {
  touchLastActiveDate(userId: string): Promise<void>;
  reversiFrame(gameId: string, userId: string, type: string, body: unknown): Promise<void>;
};
export type StreamEnv = {
  STREAM_PRESENCE?: DoNs<StreamPresenceRpc>;
  NOTE_WATCH?: DoNs<NoteWatchRpc>;
  STREAM_SHARD_COUNT?: string;
  /**
   * misskey-cf-api `ApiInternal` entrypoint: periodic lastActiveDate refresh (the hub has no PG
   * access) and `reversiGame` channel frames (→ the api worker's Reversi DO `game:{gameId}`)
   */
  API_INTERNAL?: ApiInternalRpc;
};
const validEvents = (events: PublishEvent[]) => (Array.isArray(events) ? events : []).filter((e) => e && typeof e.channel === "string" && typeof e.type === "string");
declare const WebSocketPair: { new (): { 0: HubSocket; 1: HubSocket } };

/** `sid` keys this socket's note captures in hub storage (`notes:{sid}`; attachments are capped at 2 KB). */
type Attachment = { userId: string; subs: SubMap; sid?: string; opts?: SubOpts };
type NoteSubs = Record<string, number>;
/** hub storage: when the user was last registered again with StreamPresence / NoteWatch */
const RESYNC_AT_KEY = "resyncAt";

/**
 * StreamHub Durable Object — one hub per user (`user:{userId}`), holding every
 * WebSocket that user has open (hibernation API, so idle sockets cost nothing).
 *
 * - Upgrade: only reachable through the API worker binding, which authenticates
 *   `/streaming?i=` and passes `x-mk-user-id`.
 * - RPC (StreamHubRpc) publish / noteUpdated / broadcast: deliver to the sockets.
 * Wire format matches Misskey: {type:"channel", body:{id, type, body}}.
 */
export class StreamHub extends DurableObject<StreamEnv> implements StreamHubRpc {
  private readonly state: DurableObjectState;
  constructor(ctx: DurableObjectState, env: StreamEnv = {}) {
    super(ctx, env);
    this.state = ctx;
  }

  private syncTail: Promise<void> = Promise.resolve();
  private syncQueued = false;
  private readonly closing = new WeakSet<HubSocket>();

  /**
   * Report this user's channel union to its presence shard (empty = offline).
   * Serialized + coalesced per hub: concurrent set calls could otherwise
   * land out of order (rapid connect frames) and leave a stale union.
   */
  private syncPresence(userId: string, exclude?: HubSocket): Promise<void> {
    if (exclude) this.closing.add(exclude);
    if (this.syncQueued) return this.syncTail;
    this.syncQueued = true;
    this.syncTail = this.syncTail.then(async () => {
      this.syncQueued = false;
      await this.doSyncPresence(userId);
    });
    return this.syncTail;
  }

  private async doSyncPresence(userId: string): Promise<void> {
    const ns = this.env.STREAM_PRESENCE;
    if (!ns || !userId) return;
    const subsList = this.state
      .getWebSockets()
      .filter((ws) => !this.closing.has(ws))
      .map((ws) => ((ws.deserializeAttachment() as Attachment | null)?.subs ?? {}) as SubMap);
    const channels = unionChannels(subsList);
    try {
      const shard = streamShardId(userId, Number(this.env.STREAM_SHARD_COUNT) || 16);
      await ns.get(ns.idFromName(shard)).set(userId, channels);
    } catch {
      /* presence is best-effort; stale entries are pruned on publish */
    }
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      const userId = request.headers.get("x-mk-user-id");
      if (!userId) return new Response("unauthenticated", { status: 401 });
      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];
      this.state.acceptWebSocket(server, [userId]);
      server.serializeAttachment({ userId, subs: {}, sid: crypto.randomUUID() } satisfies Attachment);
      // the api worker already touched lastActiveDate on connect; refresh every 5 minutes from now on
      await this.armLastActiveRefresh();
      return new Response(null, { status: 101, webSocket: client } as ResponseInit);
    }
    return Response.json({ ok: true, do: "StreamHub", id: this.state.id.toString(), sockets: this.state.getWebSockets().length });
  }

  /** Deliver to the sockets subscribed to each event's channel. */
  async publish(events: PublishEvent[]): Promise<{ delivered: number; sockets: number }> {
    const valid = validEvents(events);
    let delivered = 0;
    for (const ws of this.state.getWebSockets()) {
      const att = (ws.deserializeAttachment() as Attachment | null) ?? { userId: "", subs: {} };
      const opts = att.opts ?? {};
      for (const frame of valid.flatMap((e) => framesFor(att.subs, e.channel, e.type, e.body, { opts, userId: att.userId, rel: e.rel }))) {
        try {
          ws.send(frame);
          delivered++;
        } catch {
          /* socket gone */
        }
      }
    }
    return { delivered, sockets: this.state.getWebSockets().length };
  }

  /** upstream Connection.onNoteStreamMessage → top-level noteUpdated to sockets capturing the note. */
  async noteUpdated(id: string, type: string, body: unknown): Promise<number> {
    const frame = JSON.stringify({ type: "noteUpdated", body: { id, type, body: body ?? null } });
    let delivered = 0;
    for (const ws of this.state.getWebSockets()) {
      if (!((await this.socketNotes(ws))[id])) continue;
      try {
        ws.send(frame);
        delivered++;
      } catch {
        /* socket gone */
      }
    }
    return delivered;
  }

  /** upstream publishBroadcastStream: top-level {type, body} to every socket. */
  async broadcast(type: string, body: unknown): Promise<number> {
    const frame = JSON.stringify({ type, body: body ?? null });
    let delivered = 0;
    for (const ws of this.state.getWebSockets()) {
      try {
        ws.send(frame);
        delivered++;
      } catch {
        /* socket gone */
      }
    }
    return delivered;
  }

  /** Arm the 5-minute alarm (lastActiveDate, presence resync) unless one is pending (one alarm per hub = per user). */
  private async armLastActiveRefresh(): Promise<void> {
    const st = this.state.storage;
    if ((!this.env.API_INTERNAL && !this.env.STREAM_PRESENCE && !this.env.NOTE_WATCH) || !st?.setAlarm || !st.getAlarm) return;
    try {
      if ((await st.getAlarm()) == null) await st.setAlarm(Date.now() + LAST_ACTIVE_REFRESH_MS);
    } catch {
      /* best-effort */
    }
  }

  /**
   * DO alarm: upstream's per-connection `setInterval(updateLastActiveDate, 5 min)`. While the hub has
   * open sockets, refresh each connected user's lastActiveDate through the api worker, register
   * the user again with StreamPresence / NoteWatch every PRESENCE_RESYNC_MS, and re-arm; with no
   * sockets left the alarm is not re-armed (the next connect arms it again).
   */
  async alarm(): Promise<void> {
    const sockets = this.state.getWebSockets().filter((ws) => !this.closing.has(ws));
    if (!sockets.length) return;
    const userIds = new Set<string>();
    for (const ws of sockets) {
      const uid = (ws.deserializeAttachment() as Attachment | null)?.userId;
      if (uid) userIds.add(uid);
    }
    for (const uid of userIds) await this.resyncRegistrations(uid, sockets);
    for (const uid of this.env.API_INTERNAL ? userIds : []) {
      try {
        await this.env.API_INTERNAL!.touchLastActiveDate(uid);
      } catch {
        /* best-effort, as upstream (the interval ignores failures) */
      }
    }
    try {
      await this.state.storage?.setAlarm?.(Date.now() + LAST_ACTIVE_REFRESH_MS);
    } catch {
      /* ignore */
    }
  }

  /**
   * Presence and NoteWatch entries are written when subscriptions change and expire after a day:
   * register the user again every PRESENCE_RESYNC_MS while sockets are open. The clock (`resyncAt`)
   * starts at the first alarm that finds it missing; every registration of the open sockets was
   * made after their connect, which is at most one alarm period before that. A clock left from an
   * earlier connection is older than the registrations, so it only brings the resync forward.
   */
  private async resyncRegistrations(userId: string, sockets: HubSocket[]): Promise<void> {
    const st = this.state.storage;
    if (!st || (!this.env.STREAM_PRESENCE && !this.env.NOTE_WATCH)) return;
    const now = Date.now();
    const at = await st.get<number>(RESYNC_AT_KEY);
    if (at != null && now - at < PRESENCE_RESYNC_MS) return;
    if (at != null) {
      await this.syncPresence(userId);
      const ids = new Set<string>();
      for (const ws of sockets) for (const id of Object.keys(await this.socketNotes(ws))) ids.add(id);
      await this.syncNoteWatch(userId, [...ids], []);
    }
    await st.put(RESYNC_AT_KEY, now);
  }

  private async socketNotes(ws: HubSocket): Promise<NoteSubs> {
    const sid = (ws.deserializeAttachment() as Attachment | null)?.sid;
    if (!sid || !this.state.storage) return {};
    return (await this.state.storage.get<NoteSubs>(`notes:${sid}`)) ?? {};
  }

  /** Notes still captured by any of this hub's sockets other than `except`. */
  private async otherSocketsHave(except: HubSocket, ids: string[]): Promise<Set<string>> {
    const have = new Set<string>();
    if (!ids.length) return have;
    for (const ws of this.state.getWebSockets()) {
      if (ws === except || this.closing.has(ws)) continue;
      const n = await this.socketNotes(ws);
      for (const id of ids) if (n[id]) have.add(id);
    }
    return have;
  }

  /** Report user-level capture changes to the NoteWatch shards (grouped per shard). */
  private async syncNoteWatch(userId: string, add: string[], remove: string[]): Promise<void> {
    const ns = this.env.NOTE_WATCH;
    if (!ns || !userId || (!add.length && !remove.length)) return;
    const count = Number(this.env.STREAM_SHARD_COUNT) || 16;
    const byShard = new Map<string, { add: string[]; remove: string[] }>();
    const slot = (id: string) => {
      const k = noteWatchShard(id, count);
      return byShard.get(k) ?? byShard.set(k, { add: [], remove: [] }).get(k)!;
    };
    for (const id of add) slot(id).add.push(id);
    for (const id of remove) slot(id).remove.push(id);
    await Promise.all([...byShard].map(async ([shard, ops]) => {
      try {
        await ns.get(ns.idFromName(shard)).set(userId, ops.add, ops.remove);
      } catch {
        /* best-effort, like presence */
      }
    }));
  }

  private async onNoteFrame(ws: HubSocket, att: Attachment, op: { op: "sub" | "unsub"; noteId: string }): Promise<void> {
    if (!att.sid || !this.state.storage) return;
    const r = applyNoteOp(await this.socketNotes(ws), op);
    if (!r.added.length && !r.removed.length && op.op === "unsub") return;
    if (Object.keys(r.notes).length) await this.state.storage.put(`notes:${att.sid}`, r.notes);
    else await this.state.storage.delete(`notes:${att.sid}`);
    const other = await this.otherSocketsHave(ws, [...r.added, ...r.removed]);
    await this.syncNoteWatch(att.userId, r.added.filter((id) => !other.has(id)), r.removed.filter((id) => !other.has(id)));
  }

  /** A closing socket's captures: drop its storage, and the user's watch where no other socket has the note. */
  private async releaseNotes(ws: HubSocket): Promise<void> {
    const att = ws.deserializeAttachment() as Attachment | null;
    if (!att?.sid || !this.state.storage) return;
    const ids = Object.keys(await this.socketNotes(ws));
    await this.state.storage.delete(`notes:${att.sid}`);
    const other = await this.otherSocketsHave(ws, ids);
    await this.syncNoteWatch(att.userId, [], ids.filter((id) => !other.has(id)));
  }

  async webSocketMessage(ws: HubSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") return;
    const att = (ws.deserializeAttachment() as Attachment | null) ?? { userId: "", subs: {} };
    const noteOp = parseNoteFrame(message);
    if (noteOp) {
      await this.onNoteFrame(ws, att, noteOp);
      return;
    }
    const ch = parseChannelFrame(att.subs, message);
    if (ch) {
      await this.onChannelFrame(att.userId, ch);
      return;
    }
    const r = applyClientFrame(att.subs, message);
    if (r.changed) {
      // timeline options (withRenotes / withFiles / withReplies) per subscription id
      const opts = applyOptsFrame(att.opts ?? {}, message);
      ws.serializeAttachment({ ...att, subs: r.subs, opts } satisfies Attachment);
      await this.syncPresence(att.userId);
    }
  }

  /** Channel messages the hub cannot handle itself go to the api worker (reversiGame → Reversi DO). */
  private async onChannelFrame(userId: string, ch: { key: string; type: string; body: unknown }): Promise<void> {
    if (!userId || !ch.key.startsWith("reversiGame:") || !this.env.API_INTERNAL) return;
    const gameId = ch.key.slice("reversiGame:".length);
    try {
      await this.env.API_INTERNAL.reversiFrame(gameId, userId, ch.type, ch.body);
    } catch {
      /* best-effort, as upstream (errors in channel handlers are dropped) */
    }
  }

  async webSocketClose(ws: HubSocket, code: number): Promise<void> {
    const att = ws.deserializeAttachment() as Attachment | null;
    if (att?.userId) await this.syncPresence(att.userId, ws);
    await this.releaseNotes(ws);
    try {
      ws.close(code === 1005 ? 1000 : code);
    } catch {
      /* already closed */
    }
  }

  async webSocketError(ws: HubSocket): Promise<void> {
    const att = ws.deserializeAttachment() as Attachment | null;
    if (att?.userId) await this.syncPresence(att.userId, ws);
    await this.releaseNotes(ws);
    try {
      ws.close(1011);
    } catch {
      /* ignore */
    }
  }
}

export default {
  async fetch(): Promise<Response> {
    return Response.json({ service: "stream", note: "StreamHub DO; connect via API /streaming?i=" });
  },
};
