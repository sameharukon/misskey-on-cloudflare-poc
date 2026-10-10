/**
 * note_reaction rows + note.reactions jsonb counts.
 */

import { genAidxFromDate, parseAidxTime } from "../../id/src/index.js";
import type { ApiEnv } from "./env.js";
import { withHyperdriveClient, type PgQueryable } from "./pg.js";
import { afterResponse } from "./handler-kit.js";
import { getNotePg, getUsersByIdsPg } from "./notes-pg.js";
import type { PackNoteSource } from "../../packers/src/index.js";
import { packUserLite } from "../../packers/src/index.js";
import { decodeReactionKey } from "../../packers/src/note.js";
import { buildPackConfig } from "./meta-source.js";
import { publishNoteUpdated, reactedBody } from "./note-stream.js";

export type ReactResult =
  | { ok: true; note: PackNoteSource; reaction: string }
  | { ok: false; code: "NO_SUCH_NOTE" | "ALREADY_REACTED" };

export type UnreactResult =
  | { ok: true; note: PackNoteSource; reaction: string }
  | { ok: false; code: "NO_SUCH_NOTE" | "NOT_REACTED" };

/** upstream PER_NOTE_REACTION_USER_PAIR_CACHE_MAX */
const PAIR_CACHE_MAX = 16;

/** ReactionService.create's row update (no reaction buffering): insert, count +1, pair cache. */
async function insertReactionRowC(c: PgQueryable, noteId: string, userId: string, reaction: string): Promise<string> {
  const id = genAidxFromDate(new Date());
  await c.query(`INSERT INTO note_reaction (id, "userId", "noteId", reaction) VALUES ($1, $2, $3, $4)`, [id, userId, noteId, reaction]);
  await c.query(
    `UPDATE note SET reactions = jsonb_set(reactions, ARRAY[$2::text], (COALESCE(reactions->>$2, '0')::int + 1)::text::jsonb),
       "reactionAndUserPairCache" = CASE WHEN cardinality("reactionAndUserPairCache") < ${PAIR_CACHE_MAX} THEN array_append("reactionAndUserPairCache", $3::varchar) ELSE "reactionAndUserPairCache" END
     WHERE id = $1`,
    [noteId, reaction, `${userId}/${reaction}`],
  );
  return id;
}

/** ReactionService.delete's row update: delete, count -1 (kept as 0), pair removed. Null when not reacted. */
async function deleteReactionRowC(c: PgQueryable, noteId: string, userId: string): Promise<string | null> {
  return (await deleteReactionRowWithIdC(c, noteId, userId))?.reaction ?? null;
}

async function deleteReactionRowWithIdC(c: PgQueryable, noteId: string, userId: string): Promise<{ reaction: string; id: string } | null> {
  const r = await c.query(`DELETE FROM note_reaction WHERE "noteId" = $1 AND "userId" = $2 RETURNING reaction, id`, [noteId, userId]);
  if (r.rows.length !== 1) return null;
  const reaction = String(r.rows[0]!.reaction);
  const id = String(r.rows[0]!.id);
  await c.query(
    `UPDATE note SET reactions = jsonb_set(reactions, ARRAY[$2::text], (COALESCE(reactions->>$2, '0')::int - 1)::text::jsonb),
       "reactionAndUserPairCache" = array_remove("reactionAndUserPairCache", $3::varchar)
     WHERE id = $1`,
    [noteId, reaction, `${userId}/${reaction}`],
  );
  return { reaction, id };
}

/** A reaction by a (remote) user from the inbox; the reaction is already resolved. */
export async function reactPg(
  env: ApiEnv,
  opts: { noteId: string; userId: string; reaction: string },
): Promise<ReactResult> {
  return withHyperdriveClient(env.HYPERDRIVE!, async (c): Promise<ReactResult> => {
    const note = (await c.query(`SELECT id FROM note WHERE id = $1 LIMIT 1`, [opts.noteId])).rows[0];
    if (!note) return { ok: false, code: "NO_SUCH_NOTE" };
    const existing = (await c.query(`SELECT reaction FROM note_reaction WHERE "noteId" = $1 AND "userId" = $2 LIMIT 1`, [opts.noteId, opts.userId])).rows[0];
    if (existing) {
      if (String(existing.reaction) === opts.reaction) return { ok: false, code: "ALREADY_REACTED" };
      await deleteReactionRowC(c, opts.noteId, opts.userId);
    }
    await insertReactionRowC(c, opts.noteId, opts.userId, opts.reaction);
    const n = await getNotePg(env, opts.noteId);
    if (!n) return { ok: false, code: "NO_SUCH_NOTE" };
    return { ok: true, note: n, reaction: opts.reaction };
  }).then(async (r) => {
    if (r.ok) await publishNoteUpdated(env, r.note, "reacted", await reactedBody(env, r.reaction, opts.userId));
    return r;
  });
}

export async function unreactPg(
  env: ApiEnv,
  opts: { noteId: string; userId: string; reaction?: string },
): Promise<UnreactResult> {
  return withHyperdriveClient(env.HYPERDRIVE!, async (c): Promise<UnreactResult> => {
    const reaction = await deleteReactionRowC(c, opts.noteId, opts.userId);
    if (reaction == null) return { ok: false, code: "NOT_REACTED" };
    const note = await getNotePg(env, opts.noteId);
    if (!note) return { ok: false, code: "NO_SUCH_NOTE" };
    return { ok: true, note, reaction };
  }).then(async (r) => {
    if (r.ok) await publishNoteUpdated(env, r.note, "unreacted", { reaction: decodeReactionKey(r.reaction), userId: opts.userId });
    return r;
  });
}

export type CreateReactionError = "ALREADY_REACTED" | "YOU_HAVE_BEEN_BLOCKED" | "CANNOT_REACT_TO_RENOTE" | "NOT_ACCESSIBLE";

/**
 * upstream ReactionService.create for a local user: block / visibility / pure-renote checks,
 * reaction resolution, replace-on-different-reaction, counters + pair cache, `reacted` note
 * stream (with the custom emoji), the `reaction` notification (local authors) and AP Like.
 */
export async function createReactionPg(
  env: ApiEnv,
  userId: string,
  note: PackNoteSource,
  raw: string | null,
  /** the request's waitUntil: events, notification and delivery run after the response */
  waitUntil?: (p: Promise<unknown>) => void,
): Promise<CreateReactionError | null> {
  const { canViewNote } = await import("./visibility.js");
  const { resolveReactionPg } = await import("./emojis-pg.js");
  const { isPureRenote } = await import("./notes-pg.js");
  const pre = await withHyperdriveClient(env.HYPERDRIVE!, async (c) => {
    if (note.userId !== userId) {
      const blocked = (await c.query(`SELECT 1 AS x FROM blocking WHERE "blockerId" = $1 AND "blockeeId" = $2 LIMIT 1`, [note.userId, userId])).rows.length > 0;
      if (blocked) return "YOU_HAVE_BEEN_BLOCKED" as const;
    }
    return null;
  });
  if (pre) return pre;
  if (!(await canViewNote(env, note, userId))) return "NOT_ACCESSIBLE";
  if (isPureRenote(note)) return "CANNOT_REACT_TO_RENOTE";
  const result = await withHyperdriveClient(env.HYPERDRIVE!, async (c) => {
    const reaction = await resolveReactionPg(c, userId, raw, note.reactionAcceptance ?? null);
    const exists = (await c.query(`SELECT reaction FROM note_reaction WHERE "noteId" = $1 AND "userId" = $2 LIMIT 1`, [note.id, userId])).rows[0];
    let replaced: { reaction: string; id: string } | null = null;
    if (exists) {
      if (String(exists.reaction) === reaction) return "ALREADY_REACTED" as const;
      replaced = await deleteReactionRowWithIdC(c, note.id, userId);
    }
    const id = await insertReactionRowC(c, note.id, userId, reaction);
    return { reaction, replaced, id };
  });
  if (result === "ALREADY_REACTED") return result;
  await afterResponse(waitUntil, "reaction events", async () => {
    const fresh = (await getNotePg(env, note.id)) ?? note;
    if (result.replaced != null) {
      // the replaced reaction goes through ReactionService.delete (stream + AP Undo)
      await publishNoteUpdated(env, fresh, "unreacted", { reaction: decodeReactionKey(result.replaced.reaction), userId });
      if (!note.localOnly) await (await import("./ap/outbound.js")).deliverReaction(env, userId, note, result.replaced.reaction, true, result.replaced.id);
    }
    await publishNoteUpdated(env, fresh, "reacted", await reactedBody(env, result.reaction, userId));
    if (note.userHost == null) {
      const { createNotification } = await import("./notifications-do.js");
      await createNotification(env, note.userId, { type: "reaction", notifierId: userId, noteId: note.id, reaction: result.reaction });
    }
    if (!note.localOnly) await (await import("./ap/outbound.js")).deliverReaction(env, userId, note, result.reaction, false, result.id);
  });
  return null;
}

/** upstream ReactionService.delete for a local user; false when not reacted. */
export async function deleteReactionPg(env: ApiEnv, userId: string, note: PackNoteSource, waitUntil?: (p: Promise<unknown>) => void): Promise<boolean> {
  const del = await withHyperdriveClient(env.HYPERDRIVE!, (c) => deleteReactionRowWithIdC(c, note.id, userId));
  if (del == null) return false;
  await afterResponse(waitUntil, "unreaction events", async () => {
    const fresh = (await getNotePg(env, note.id)) ?? note;
    await publishNoteUpdated(env, fresh, "unreacted", { reaction: decodeReactionKey(del.reaction), userId });
    if (!note.localOnly) await (await import("./ap/outbound.js")).deliverReaction(env, userId, note, del.reaction, true, del.id);
  });
  return true;
}

/** notes/reactions (NoteReactionEntityService.packMany). */
export async function listReactionsPg(
  env: ApiEnv,
  opts: { noteId: string; body: Record<string, unknown>; meId: string | null },
): Promise<Record<string, unknown>[]> {
  const { paginationSql } = await import("./social-api-pg.js");
  const { convertLegacyReaction } = await import("../../packers/src/note.js");
  return withHyperdriveClient(env.HYPERDRIVE!, async (c) => {
    const params: unknown[] = [opts.noteId];
    const pg = paginationSql(opts.body, params, "r.id");
    const where = [`r."noteId" = $1`, ...pg.where];
    const t = opts.body.type;
    if (typeof t === "string" && t) {
      // local reactions are `:name@.:` in the API but `:name:` in the database
      params.push(t.endsWith("@.:") ? `${t.slice(0, -3)}:` : t);
      where.push(`r.reaction = $${params.length}`);
    }
    params.push(typeof opts.body.limit === "number" ? opts.body.limit : 10);
    const r = await c.query(`SELECT r.id, r."userId", r.reaction FROM note_reaction r WHERE ${where.join(" AND ")} ORDER BY ${pg.order} LIMIT $${params.length}`, params);
    const users = await getUsersByIdsPg(env, r.rows.map((row) => String(row.userId)), opts.meId);
    const config = buildPackConfig(env);
    return r.rows.map((row) => {
      const u = users.get(String(row.userId));
      return {
        id: String(row.id),
        createdAt: (parseAidxTime(String(row.id)) ?? new Date(0)).toISOString(),
        user: u ? packUserLite(u, config) : null,
        type: convertLegacyReaction(String(row.reaction)),
      };
    });
  });
}
