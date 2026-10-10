/// <reference path="../../shared/src/cloudflare-workers.d.ts" />
/**
 * StreamPresence DO — sharded registry of online users and the channels they
 * subscribe to (`stream:{n}`, n = hash(userId) % STREAM_SHARD_COUNT).
 *
 * The fanout path asks presence first so it only wakes hubs that have a live
 * socket on a matching channel; offline users cost nothing per note.
 */

import { DurableObject } from "cloudflare:workers";
import type { SubMap } from "./protocol.js";
import type { DoNs, NoteTarget, StreamHubRpc, StreamPresenceRpc } from "../../shared/src/do-rpc.js";

export type PresenceNs = DoNs<StreamPresenceRpc>;

type PresenceState = {
  storage: {
    get<T = unknown>(key: string): Promise<T | undefined>;
    put(key: string, value: unknown): Promise<void>;
    delete(key: string | string[]): Promise<boolean | number>;
    list<T = unknown>(opts?: { prefix?: string }): Promise<Map<string, T>>;
  };
};

type Entry = { channels: string[]; at: number };

/** Union of channels across a user's sockets. */
export function unionChannels(subsList: SubMap[]): string[] {
  return [...new Set(subsList.flatMap((s) => Object.values(s)))].sort();
}

const STALE_MS = 24 * 3600_000;

/** Parallel StreamHub calls while delivering from a shard. */
const DELIVER_CONCURRENCY = 32;

/** Storage key of one user's entry. */
const KEY = "u:";

/**
 * One storage key per online user (`u:{userId}`), so a connect / disconnect writes only that
 * user's entry; reads use the in-memory copy loaded once per instance. Stale entries are dropped
 * when the instance loads. The single `users` map of older deployments is split on first load.
 */
export class StreamPresence extends DurableObject implements StreamPresenceRpc {
  private users: Promise<Record<string, Entry>> | null = null;
  private readonly state: PresenceState;
  private readonly hubs: DoNs<StreamHubRpc> | undefined;
  constructor(ctx: PresenceState, env?: { STREAM_HUB?: DoNs<StreamHubRpc> }) {
    super(ctx, env);
    this.state = ctx;
    this.hubs = env?.STREAM_HUB;
  }

  /** Run `call` for each user's hub, DELIVER_CONCURRENCY at a time. */
  private async eachHub<T>(userIds: string[], call: (hub: StreamHubRpc, userId: string) => Promise<T>): Promise<T[]> {
    const ns = this.hubs;
    if (!ns) return [];
    const out: T[] = [];
    for (let i = 0; i < userIds.length; i += DELIVER_CONCURRENCY) {
      out.push(...(await Promise.all(userIds.slice(i, i + DELIVER_CONCURRENCY).map((id) => call(ns.get(ns.idFromName(`user:${id}`)), id)))));
    }
    return out;
  }

  async deliverNote(body: unknown, targets: NoteTarget[]): Promise<{ delivered: number; pruned: number }> {
    const started = Date.now();
    const byUser = new Map((targets ?? []).map((t) => [t.userId, t]));
    const results = await this.eachHub([...byUser.keys()], async (hub, userId) => {
      const t = byUser.get(userId)!;
      try {
        return { userId, ...(await hub.publish(t.channels.map((channel) => ({ channel, type: "note", body, ...(t.rel ? { rel: t.rel } : {}) })))) };
      } catch {
        return { userId, delivered: 0, sockets: -1 };
      }
    });
    let delivered = 0;
    const stale: string[] = [];
    for (const r of results) {
      delivered += r.delivered;
      if (r.sockets === 0) stale.push(r.userId);
    }
    // a hub with no socket: the user went away without webSocketClose. Keep anyone who registered
    // (reconnected) after this delivery started.
    let pruned = 0;
    if (stale.length) {
      const users = await this.load();
      for (const id of stale) {
        if (users[id] && users[id]!.at <= started) {
          await this.setEntry(id, null);
          pruned++;
        }
      }
    }
    return { delivered, pruned };
  }

  async broadcast(type: string, body: unknown): Promise<number> {
    const counts = await this.eachHub(await this.all(), async (hub) => {
      try {
        return await hub.broadcast(type, body);
      } catch {
        return 0;
      }
    });
    return counts.reduce((a, b) => a + b, 0);
  }

  private load(): Promise<Record<string, Entry>> {
    this.users ??= this.loadFromStorage();
    return this.users;
  }

  private async loadFromStorage(): Promise<Record<string, Entry>> {
    const users: Record<string, Entry> = {};
    const now = Date.now();
    const stale: string[] = [];
    for (const [k, e] of await this.state.storage.list<Entry>({ prefix: KEY })) {
      if (now - e.at >= STALE_MS) stale.push(k);
      else users[k.slice(KEY.length)] = e;
    }
    const legacy = await this.state.storage.get<Record<string, Entry>>("users");
    if (legacy) {
      for (const [id, e] of Object.entries(legacy)) {
        if (now - e.at < STALE_MS && !users[id]) {
          users[id] = e;
          await this.state.storage.put(KEY + id, e);
        }
      }
      await this.state.storage.delete("users");
    }
    for (let i = 0; i < stale.length; i += 128) await this.state.storage.delete(stale.slice(i, i + 128));
    return users;
  }

  private async setEntry(userId: string, e: Entry | null): Promise<void> {
    const users = await this.load();
    if (e) {
      users[userId] = e;
      await this.state.storage.put(KEY + userId, e);
    } else if (users[userId]) {
      delete users[userId];
      await this.state.storage.delete(KEY + userId);
    }
  }

  async set(userId: string, channels: string[]): Promise<void> {
    const ch = (channels ?? []).filter((c) => typeof c === "string");
    await this.load();
    await this.setEntry(userId, ch.length === 0 ? null : { channels: ch, at: Date.now() });
  }

  async remove(userIds: string[]): Promise<void> {
    await this.load();
    for (const id of userIds ?? []) await this.setEntry(id, null);
  }

  /** Which of these users are online (any channel). */
  async lookup(userIds: string[]): Promise<Record<string, string[]>> {
    const users = await this.load();
    const now = Date.now();
    const online: Record<string, string[]> = {};
    for (const id of userIds ?? []) {
      const e = users[id];
      if (e && now - e.at < STALE_MS) online[id] = e.channels;
    }
    return online;
  }

  /** Every online user (broadcast stream events: emojiAdded, …). */
  async all(): Promise<string[]> {
    const users = await this.load();
    const now = Date.now();
    return Object.entries(users).filter(([, e]) => now - e.at < STALE_MS).map(([id]) => id);
  }

  /** Everyone online subscribed to any of these channels. */
  async subscribers(channels: string[]): Promise<Record<string, string[]>> {
    const users = await this.load();
    const now = Date.now();
    const want = new Set(channels ?? []);
    const online: Record<string, string[]> = {};
    for (const [id, e] of Object.entries(users)) {
      if (now - e.at >= STALE_MS) continue;
      if (e.channels.some((c) => want.has(c))) online[id] = e.channels;
    }
    return online;
  }

  async online(): Promise<number> {
    const now = Date.now();
    return Object.values(await this.load()).filter((e) => now - e.at < STALE_MS).length;
  }
}
