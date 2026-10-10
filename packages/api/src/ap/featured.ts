/**
 * Pinned notes of remote users (user_note_pining): the actor's `featured` collection, read after
 * the actor is fetched (ApPersonService.updateFeatured), and inbound Add / Remove on that
 * collection (ApInboxService.add / remove → NotePiningService.addPinned / removePinned).
 */

import { genAidx } from "../../../id/src/index.js";
import { getApId, getApType, sameHost, toArray, type ApObject, type InboxActivity } from "../../../ap/src/index.js";
import type { ApiEnv } from "../env.js";
import { getNotePg } from "../notes-pg.js";
import { withHyperdriveClient } from "../pg.js";
import { policiesForPg } from "../policies-pg.js";
import { apGet, type RemoteUser } from "./remote.js";
import { enqueueJob } from "../queues/jobs-queue.js";

export type UpdateFeaturedJob = { kind: "updateFeatured"; userId: string };

/** Queue a featured refresh (inline without the mk-jobs binding; failures are logged, never thrown). */
export async function enqueueUpdateFeatured(env: ApiEnv, userId: string): Promise<void> {
  const job: UpdateFeaturedJob = { kind: "updateFeatured", userId };
  if (env.Q_JOBS) {
    await enqueueJob(env, job);
    return;
  }
  try {
    await updateFeatured(env, userId);
  } catch (e) {
    console.warn(`featured ${userId}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export async function runUpdateFeaturedJob(env: ApiEnv, job: UpdateFeaturedJob): Promise<void> {
  // upstream logs the failure instead of retrying (updateFeatured(...).catch(logger.error))
  await updateFeatured(env, job.userId).catch((e) => console.warn(`featured ${job.userId}: ${e instanceof Error ? e.message : String(e)}`));
}

/**
 * Replace the user's pins with the first 5 Notes of their featured collection, in its order.
 * Items must be on the user's host (upstream resolveNote's `sentFrom`); unlike upstream, a note by
 * another author is not pinned (local pins are always the user's own notes).
 */
export async function updateFeatured(env: ApiEnv, userId: string): Promise<void> {
  const user = await withHyperdriveClient(env.HYPERDRIVE!, async (c) =>
    (await c.query(`SELECT id, uri, featured FROM "user" WHERE id = $1 AND host IS NOT NULL AND "isDeleted" = false`, [userId])).rows[0]);
  if (!user?.featured || !user.uri) return;
  const actorUri = String(user.uri);
  const collection = await apGet(env, String(user.featured));
  const type = getApType(collection);
  if (type !== "Collection" && type !== "OrderedCollection") throw new Error("featured is not a Collection or OrderedCollection");
  const unresolved = toArray((type === "Collection" ? collection.items : collection.orderedItems) as unknown);

  const { resolveNoteByUri } = await import("./inbox.js");
  const noteIds: string[] = [];
  for (const item of unresolved) {
    if (noteIds.length >= 5) break;
    const uri = getApId(item);
    if (!uri || !sameHost(uri, actorUri)) continue;
    const obj = typeof item === "object" && item !== null ? (item as ApObject) : await apGet(env, uri).catch(() => null);
    if (!obj || getApType(obj) !== "Note") continue;
    const noteId = await resolveNoteByUri(env, uri, 1, obj).catch(() => null);
    if (!noteId || noteIds.includes(noteId)) continue;
    const note = await getNotePg(env, noteId);
    if (note?.userId === userId) noteIds.push(noteId);
  }

  await withHyperdriveClient(env.HYPERDRIVE!, async (c) => {
    await c.query(`DELETE FROM user_note_pining WHERE "userId" = $1`, [userId]);
    // ids a second apart keep the collection's order (newest id first, as upstream)
    let td = 0;
    for (const noteId of noteIds) {
      td -= 1000;
      await c.query(`INSERT INTO user_note_pining (id, "userId", "noteId") VALUES ($1, $2, $3)`, [genAidx(Date.now() + td), userId, noteId]);
    }
  });
}

/** Inbound Add / Remove: only on the actor's own featured collection. */
export async function onFeaturedChange(env: ApiEnv, actor: RemoteUser, activity: InboxActivity): Promise<{ ok: boolean; reason: string }> {
  const add = activity.type === "Add";
  if (activity.actor !== actor.uri) return { ok: false, reason: "invalid_actor" };
  const target = getApId(activity.raw.target);
  if (target == null) return { ok: true, reason: "target_null" };
  const featured = await withHyperdriveClient(env.HYPERDRIVE!, async (c) =>
    (await c.query(`SELECT featured FROM "user" WHERE id = $1`, [actor.id])).rows[0]?.featured as string | null | undefined);
  if (!featured || target !== featured) return { ok: true, reason: "unknown_target" };
  const noteUri = getApId(activity.object);
  if (!noteUri) return { ok: true, reason: "note_not_found" };
  const { resolveNoteByUri } = await import("./inbox.js");
  const prefetched = typeof activity.object === "object" && activity.object !== null && sameHost(noteUri, actor.uri) ? (activity.object as ApObject) : undefined;
  const noteId = await resolveNoteByUri(env, noteUri, 1, prefetched).catch(() => null);
  if (!noteId) return { ok: true, reason: "note_not_found" };
  const note = await getNotePg(env, noteId);
  // NotePiningService: the note must be the user's own
  if (note?.userId !== actor.id) return { ok: true, reason: "no_such_note" };

  if (!add) {
    await withHyperdriveClient(env.HYPERDRIVE!, (c) => c.query(`DELETE FROM user_note_pining WHERE "userId" = $1 AND "noteId" = $2`, [actor.id, noteId]));
    return { ok: true, reason: "unpinned" };
  }
  const limit = Number((await policiesForPg(env, actor.id)).pinLimit ?? 5);
  return withHyperdriveClient(env.HYPERDRIVE!, async (c) => {
    const rows = (await c.query(`SELECT "noteId" FROM user_note_pining WHERE "userId" = $1`, [actor.id])).rows;
    if (rows.some((x) => String(x.noteId) === noteId)) return { ok: true, reason: "already_pinned" };
    if (rows.length >= limit) return { ok: true, reason: "pin_limit" };
    await c.query(`INSERT INTO user_note_pining (id, "userId", "noteId") VALUES ($1, $2, $3)`, [genAidx(Date.now()), actor.id, noteId]);
    return { ok: true, reason: "pinned" };
  });
}
