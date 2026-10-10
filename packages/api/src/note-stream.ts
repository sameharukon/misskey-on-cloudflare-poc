/**
 * upstream GlobalEventService.publishNoteStream → `noteUpdated` for clients capturing the note
 * (streaming `s` / `sr` / `subNote`). NoteWatch (misskey-cf-stream) says which users capture it;
 * those who may see the note (author, specified recipients, followers for followers-only notes,
 * as upstream Connection.onNoteStreamMessage) get one hub call each. Best-effort.
 *
 * Events: reacted { reaction, emoji, userId }, unreacted { reaction, userId },
 * deleted { deletedAt }, pollVoted { choice, userId }.
 */

import type { ApiEnv } from "./env.js";
import { withHyperdriveClient } from "./pg.js";
import { noteWatchShard } from "../../stream/src/note-watch.js";
import { decodeReactionKey } from "../../packers/src/note.js";

export type NoteStreamRef = { id: string; userId: string; visibility: string; visibleUserIds?: string[] | null };

export async function noteWatchers(env: ApiEnv, noteId: string): Promise<string[]> {
  const ns = env.NOTE_WATCH;
  if (!ns) return [];
  const shard = noteWatchShard(noteId, Number(env.STREAM_SHARD_COUNT) || 16);
  return ns.get(ns.idFromName(shard)).lookup(noteId);
}

export async function publishNoteUpdated(env: ApiEnv, note: NoteStreamRef, type: string, body: unknown): Promise<number> {
  try {
    if (!env.NOTE_WATCH || !env.STREAM_HUB) return 0;
    let users = await noteWatchers(env, note.id);
    if (!users.length) return 0;
    if (note.visibility === "specified") {
      const allowed = new Set([note.userId, ...(note.visibleUserIds ?? [])]);
      users = users.filter((u) => allowed.has(u));
    } else if (note.visibility === "followers" && env.HYPERDRIVE?.connectionString) {
      const followers = await withHyperdriveClient(env.HYPERDRIVE, async (c) =>
        new Set((await c.query(
          `SELECT "followerId" FROM following WHERE "followeeId" = $1 AND "followerId" = ANY($2::varchar[])`,
          [note.userId, users],
        )).rows.map((r) => String(r.followerId))),
      );
      users = users.filter((u) => u === note.userId || followers.has(u));
    }
    const hub = env.STREAM_HUB;
    const res = await Promise.all(users.map(async (u) => {
      try {
        return await hub.get(hub.idFromName(`user:${u}`)).noteUpdated(note.id, type, body);
      } catch {
        return 0;
      }
    }));
    return res.reduce((a, b) => a + b, 0);
  } catch (e) {
    console.warn(`noteUpdated publish failed: ${e instanceof Error ? e.message : String(e)}`);
    return 0;
  }
}

/** ReactionService `reacted` body: decoded reaction + the custom emoji (name@host / name@., url). */
export async function reactedBody(env: ApiEnv, stored: string, userId: string): Promise<Record<string, unknown>> {
  const reaction = decodeReactionKey(stored);
  const m = /^:([\w+-]+)(?:@([\w.-]+))?:$/.exec(reaction);
  let emoji: { name: string; url: string } | null = null;
  if (m && env.HYPERDRIVE?.connectionString) {
    const host = !m[2] || m[2] === "." ? null : m[2];
    try {
      const row = await withHyperdriveClient(env.HYPERDRIVE, async (c) =>
        (await c.query(
          `SELECT name, host, "publicUrl", "originalUrl" FROM emoji WHERE name = $1 AND ${host ? "host = $2" : "host IS NULL"} LIMIT 1`,
          host ? [m[1], host] : [m[1]],
        )).rows[0],
      );
      if (row) emoji = { name: row.host ? `${row.name}@${row.host}` : `${row.name}@.`, url: String(row.publicUrl || row.originalUrl) };
    } catch {
      /* no emoji table */
    }
  }
  return { reaction, emoji, userId };
}
