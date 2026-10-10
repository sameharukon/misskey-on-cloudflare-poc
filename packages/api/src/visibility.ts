/**
 * Note visibility (upstream NoteEntityService.isVisibleForMe).
 */

import type { PackNoteSource } from "../../packers/src/index.js";
import type { ApiEnv } from "./env.js";
import { withHyperdriveClient } from "./pg.js";

/**
 * NoteEntityService.isVisibleForMe: specified → author or listed; followers → author, the
 * replied-to user, mentioned users, followers — and, when both the note's author and the
 * viewer are remote, assumed visible (the follow cannot be known).
 * The last argument is accepted for older call sites and ignored.
 */
export async function canViewNote(
  env: ApiEnv,
  note: PackNoteSource,
  viewerId: string | null,
  _legacy?: boolean,
): Promise<boolean> {
  if (note.visibility === "specified") {
    if (viewerId == null) return false;
    if (viewerId === note.userId) return true;
    return note.visibleUserIds.includes(viewerId);
  }
  if (note.visibility === "followers") {
    if (viewerId == null) return false;
    if (viewerId === note.userId) return true;
    if (note.replyUserId && viewerId === note.replyUserId) return true;
    if (note.mentions.includes(viewerId)) return true;
    if (!env.HYPERDRIVE?.connectionString) return false;
    return withHyperdriveClient(env.HYPERDRIVE, async (c) => {
      const following = (await c.query(`SELECT 1 AS x FROM following WHERE "followeeId" = $1 AND "followerId" = $2 LIMIT 1`, [note.userId, viewerId])).rows.length > 0;
      if (following) return true;
      const me = (await c.query(`SELECT host FROM "user" WHERE id = $1`, [viewerId])).rows[0];
      return note.userHost != null && me?.host != null;
    });
  }
  return true;
}
