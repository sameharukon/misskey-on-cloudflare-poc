/**
 * Role timelines in the fanout consumer (upstream RoleService.addNoteToRoleTimeline).
 *
 * Upstream pushes every created note to Redis `roleTimeline:{roleId}` (1000 entries) for each
 * of the author's roles (assigned + matching conditional) and publishes `roleTimelineStream`.
 * roles/notes and the roleTimeline channel only ever show public notes of public roles, so here
 * only public notes go to public roles' TimelineShard `role:{id}`; explorable roles also stream.
 */

import { withHyperdriveClient } from "../../db/src/hyperdrive.js";
import { getUserRolesPg } from "../../db/src/role-cond.js";

export const ROLE_TIMELINE_MAX = 1000;

export type RoleHit = { roleId: string; isExplorable: boolean };

export async function matchRoles(hd: { connectionString: string }, authorId: string): Promise<RoleHit[]> {
  return withHyperdriveClient(hd, async (client) => {
    const roles = await getUserRolesPg(client, authorId);
    return roles.filter((r) => r.isPublic).map((r) => ({ roleId: r.id, isExplorable: r.isExplorable }));
  });
}
