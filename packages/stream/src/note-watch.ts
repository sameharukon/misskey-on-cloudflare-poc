/// <reference path="../../shared/src/cloudflare-workers.d.ts" />
/**
 * NoteWatch DO — which online users capture which notes (upstream: Redis `noteStream:{noteId}`
 * subscriptions per connection). Sharded by note (`notes:{n}`, n = hash(noteId) % shard count),
 * so publishing a note event costs one lookup. Hubs report per-user changes; entries older than
 * a day are ignored and pruned, like presence.
 *
 * RPC (NoteWatchRpc): set(userId, add, remove), lookup(noteId) → userIds.
 */

import { DurableObject } from "cloudflare:workers";
import { streamShardId } from "@misskey-cf/shared";
import type { NoteWatchRpc } from "../../shared/src/do-rpc.js";

type NoteWatchState = {
  storage: {
    get<T = unknown>(key: string): Promise<T | undefined>;
    put(key: string, value: unknown): Promise<void>;
    delete(key: string): Promise<boolean>;
  };
};

const STALE_MS = 24 * 3600_000;

/** `notes:{n}` for a note id (same hash as the presence shards). */
export function noteWatchShard(noteId: string, count: number): string {
  return streamShardId(noteId, count).replace(/^stream:/, "notes:");
}

export class NoteWatch extends DurableObject implements NoteWatchRpc {
  private readonly state: NoteWatchState;
  constructor(ctx: NoteWatchState, env?: unknown) {
    super(ctx, env);
    this.state = ctx;
  }

  async set(userId: string, add: string[], remove: string[]): Promise<void> {
    const now = Date.now();
    for (const id of add ?? []) {
      const m = (await this.state.storage.get<Record<string, number>>(`n:${id}`)) ?? {};
      m[userId] = now;
      await this.state.storage.put(`n:${id}`, m);
    }
    for (const id of remove ?? []) {
      const m = await this.state.storage.get<Record<string, number>>(`n:${id}`);
      if (!m || !(userId in m)) continue;
      delete m[userId];
      if (Object.keys(m).length) await this.state.storage.put(`n:${id}`, m);
      else await this.state.storage.delete(`n:${id}`);
    }
  }

  async lookup(noteId: string): Promise<string[]> {
    const now = Date.now();
    const m = (await this.state.storage.get<Record<string, number>>(`n:${noteId}`)) ?? {};
    const live = Object.entries(m).filter(([, at]) => now - at < STALE_MS);
    if (live.length !== Object.keys(m).length) {
      if (live.length) await this.state.storage.put(`n:${noteId}`, Object.fromEntries(live));
      else await this.state.storage.delete(`n:${noteId}`);
    }
    return live.map(([id]) => id);
  }
}
