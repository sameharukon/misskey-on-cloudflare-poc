/**
 * upstream UserFollowingService (follow / unfollow / follow requests) and UserBlockingService
 * for local actors, with their side effects: counters (skipped when either side has moved),
 * instance stats, notifications (`follow`, `followRequestAccepted` with the followee's
 * followedMessage, `receiveFollowRequest`), main-stream events (`follow`, `followed`,
 * `unfollow`, `receiveFollowRequest`, `meUpdated`), user webhooks and AP deliveries.
 */

import { genAidxFromDate } from "../../id/src/index.js";
import { packUserLite } from "../../packers/src/index.js";
import type { ApiEnv } from "./env.js";
import { buildPackConfig } from "./meta-source.js";
import { withHyperdriveClient, type PgQueryable } from "./pg.js";
import { followingInstanceStatsC } from "./ap/instances.js";
import * as O from "./ap/outbound.js";
import { createNotification } from "./notifications-do.js";
import { publishToUserStream } from "./stream-publish.js";
import { enqueueUserWebhook } from "./webhooks-pg.js";
import { packUserDetailedPg } from "./user-detailed-pg.js";
import { getUsersByIdsPg } from "./notes-pg.js";
import { metaRowPg } from "./user-lite-pg.js";

type U = { id: string; host: string | null; isLocked: boolean; isBot: boolean; movedToUri: string | null; inbox: string | null; sharedInbox: string | null };

async function userRow(c: PgQueryable, id: string): Promise<U | null> {
  const r = (await c.query(`SELECT id, host, "isLocked", "isBot", to_jsonb(u) AS j FROM "user" u WHERE id = $1`, [id])).rows[0];
  if (!r) return null;
  const j = (r.j ?? {}) as Record<string, unknown>;
  return {
    id: String(r.id),
    host: (r.host as string | null) ?? null,
    isLocked: Boolean(r.isLocked),
    isBot: Boolean(r.isBot),
    movedToUri: (j.movedToUri as string | null) ?? null,
    inbox: (j.inbox as string | null) ?? null,
    sharedInbox: (j.sharedInbox as string | null) ?? null,
  };
}

const exists = async (c: PgQueryable, sql: string, p: unknown[]) => (await c.query(sql, p)).rows.length > 0;
const isFollowingC = (c: PgQueryable, a: string, b: string) => exists(c, `SELECT 1 AS x FROM following WHERE "followerId" = $1 AND "followeeId" = $2 LIMIT 1`, [a, b]);
const isBlockingC = (c: PgQueryable, a: string, b: string) => exists(c, `SELECT 1 AS x FROM blocking WHERE "blockerId" = $1 AND "blockeeId" = $2 LIMIT 1`, [a, b]);

async function publishMeUpdated(env: ApiEnv, userId: string): Promise<void> {
  const me = await packUserDetailedPg(env, userId, userId, { schema: "MeDetailed" });
  if (me) await publishToUserStream(env, userId, "main", "meUpdated", me);
}

async function packLiteFor(env: ApiEnv, id: string, meId: string): Promise<Record<string, unknown> | null> {
  const u = (await getUsersByIdsPg(env, [id], meId)).get(id);
  return u ? (packUserLite(u, buildPackConfig(env)) as unknown as Record<string, unknown>) : null;
}

/** main `unfollow` (UserDetailedNotMe of followee) + webhook `unfollow`, for a local follower. */
async function publishUnfollow(env: ApiEnv, followeeId: string, followerId: string): Promise<void> {
  const packed = await packUserDetailedPg(env, followeeId, followerId, { schema: "UserDetailedNotMe" });
  if (!packed) return;
  await publishToUserStream(env, followerId, "main", "unfollow", packed);
  await enqueueUserWebhook(env, followerId, "unfollow", async () => ({ user: packed }));
}

/** UserFollowingService.insertFollowingDoc */
async function insertFollowingDoc(env: ApiEnv, followee: U, follower: U, withReplies: boolean | undefined, silent = false): Promise<void> {
  if (follower.id === followee.id) return;
  const followedMessage = await withHyperdriveClient(env.HYPERDRIVE!, async (c) => {
    await c.query(
      `INSERT INTO following (id, "followeeId", "followerId", "isFollowerHibernated", "withReplies", notify,
         "followerHost", "followerInbox", "followerSharedInbox", "followeeHost", "followeeInbox", "followeeSharedInbox")
       VALUES ($1,$2,$3,FALSE,$4,NULL,$5,$6,$7,$8,$9,$10)`,
      [
        genAidxFromDate(new Date()), followee.id, follower.id, withReplies ?? false,
        follower.host, follower.host ? follower.inbox : null, follower.host ? follower.sharedInbox : null,
        followee.host, followee.host ? followee.inbox : null, followee.host ? followee.sharedInbox : null,
      ],
    );
    await c.query(`DELETE FROM follow_request WHERE "followeeId" = $1 AND "followerId" = $2`, [followee.id, follower.id]);
    if (!followee.movedToUri && !follower.movedToUri) {
      await c.query(`UPDATE "user" SET "followingCount" = "followingCount" + 1 WHERE id = $1`, [follower.id]);
      await c.query(`UPDATE "user" SET "followersCount" = "followersCount" + 1 WHERE id = $1`, [followee.id]);
      await followingInstanceStatsC(c, follower.host, followee.host, 1);
    }
    return ((await c.query(`SELECT "followedMessage" FROM user_profile WHERE "userId" = $1`, [followee.id]).catch(() => ({ rows: [] }))).rows[0]?.followedMessage as string | null | undefined) ?? null;
  });
  if (follower.host == null) {
    await createNotification(env, follower.id, { type: "followRequestAccepted", notifierId: followee.id, message: followedMessage });
  }
  if (follower.host == null && !silent) {
    const packed = await packUserDetailedPg(env, followee.id, follower.id, { schema: "UserDetailedNotMe" });
    if (packed) {
      await publishToUserStream(env, follower.id, "main", "follow", packed);
      await enqueueUserWebhook(env, follower.id, "follow", async () => ({ user: packed }));
    }
  }
  if (followee.host == null) {
    const packed = await packLiteFor(env, follower.id, followee.id);
    if (packed) {
      await publishToUserStream(env, followee.id, "main", "followed", packed);
      await enqueueUserWebhook(env, followee.id, "followed", async () => ({ user: packed }));
    }
    await createNotification(env, followee.id, { type: "follow", notifierId: follower.id });
  }
}

/** UserFollowingService.createFollowRequest */
async function createFollowRequest(env: ApiEnv, follower: U, followee: U, withReplies: boolean | undefined): Promise<void> {
  if (follower.id === followee.id) return;
  await withHyperdriveClient(env.HYPERDRIVE!, async (c) => {
    await c.query(`DELETE FROM follow_request WHERE "followeeId" = $1 AND "followerId" = $2`, [followee.id, follower.id]);
    await c.query(
      `INSERT INTO follow_request (id, "followeeId", "followerId", "requestId", "withReplies",
         "followerHost", "followerInbox", "followerSharedInbox", "followeeHost", "followeeInbox", "followeeSharedInbox")
       VALUES ($1,$2,$3,NULL,$4,$5,$6,$7,$8,$9,$10)`,
      [
        genAidxFromDate(new Date()), followee.id, follower.id, withReplies ?? false,
        follower.host, follower.host ? follower.inbox : null, follower.host ? follower.sharedInbox : null,
        followee.host, followee.host ? followee.inbox : null, followee.host ? followee.sharedInbox : null,
      ],
    );
  });
  if (followee.host == null) {
    const packed = await packLiteFor(env, follower.id, followee.id);
    if (packed) await publishToUserStream(env, followee.id, "main", "receiveFollowRequest", packed);
    await publishMeUpdated(env, followee.id);
    await createNotification(env, followee.id, { type: "receiveFollowRequest", notifierId: follower.id });
  }
  if (follower.host == null && followee.host != null) await O.deliverFollow(env, follower.id, followee.id);
}

export type FollowResult = "ok" | "blocking" | "blocked" | "already_following" | "no_such_user";

/** UserFollowingService.follow for a local follower. */
export async function followPg(env: ApiEnv, followerId: string, followeeId: string, opts: { withReplies?: boolean; silent?: boolean } = {}): Promise<FollowResult> {
  const pre = await withHyperdriveClient(env.HYPERDRIVE!, async (c) => {
    const follower = await userRow(c, followerId);
    const followee = await userRow(c, followeeId);
    if (!follower || !followee) return "no_such_user" as const;
    if (await isBlockingC(c, follower.id, followee.id)) return "blocking" as const;
    if (await isBlockingC(c, followee.id, follower.id)) return "blocked" as const;
    if (await isFollowingC(c, follower.id, followee.id)) return "already_following" as const;
    const prof = ((await c.query(`SELECT to_jsonb(p) AS p FROM user_profile p WHERE "userId" = $1`, [followee.id])).rows[0]?.p ?? {}) as Record<string, unknown>;
    const meta = await metaRowPg(c);
    const silenced = Array.isArray(meta.silencedHosts) ? (meta.silencedHosts as string[]) : [];
    const isSilencedHost = (h: string | null) => h != null && silenced.some((x) => `.${h.toLowerCase()}`.endsWith(`.${x}`));
    let request =
      followee.isLocked ||
      (Boolean(prof.carefulBot) && follower.isBot) ||
      (follower.host == null && followee.host != null) ||
      (followee.host == null && follower.host != null && isSilencedHost(follower.host));
    if (request) {
      // autoAcceptFollowed: the (local) followee already follows the follower
      if (followee.host == null && prof.autoAcceptFollowed !== false && (await isFollowingC(c, followee.id, follower.id))) request = false;
    }
    return { follower, followee, request };
  });
  if (typeof pre === "string") return pre;
  if (pre.request) await createFollowRequest(env, pre.follower, pre.followee, opts.withReplies);
  else await insertFollowingDoc(env, pre.followee, pre.follower, opts.withReplies, opts.silent === true);
  return "ok";
}

/** UserFollowingService.unfollow (+ decrementFollowing) */
export async function unfollowPg(env: ApiEnv, followerId: string, followeeId: string, silent = false): Promise<void> {
  const done = await withHyperdriveClient(env.HYPERDRIVE!, async (c) => {
    const follower = await userRow(c, followerId);
    const followee = await userRow(c, followeeId);
    if (!follower || !followee) return null;
    const r = await c.query(`DELETE FROM following WHERE "followerId" = $1 AND "followeeId" = $2 RETURNING id`, [followerId, followeeId]);
    if (!r.rows.length) return null;
    await decrementFollowingC(c, follower, followee);
    return { follower, followee };
  });
  if (!done) return;
  if (!silent && done.follower.host == null) await publishUnfollow(env, followeeId, followerId);
  if (done.follower.host == null && done.followee.host != null) await O.deliverUndoFollow(env, followerId, followeeId);
  if (done.followee.host == null && done.follower.host != null) await O.deliverFollowAnswer(env, "reject", followeeId, followerId, null);
}

async function decrementFollowingC(c: PgQueryable, follower: U, followee: U): Promise<void> {
  if (!follower.movedToUri && !followee.movedToUri) {
    await c.query(`UPDATE "user" SET "followingCount" = "followingCount" - 1 WHERE id = $1`, [follower.id]);
    await c.query(`UPDATE "user" SET "followersCount" = "followersCount" - 1 WHERE id = $1`, [followee.id]);
    await followingInstanceStatsC(c, follower.host, followee.host, -1);
  } else {
    for (const u of [follower, followee]) {
      if (u.movedToUri) continue;
      const fe = Number((await c.query(`SELECT count(*)::int AS n FROM following f JOIN "user" x ON x.id = f."followeeId" WHERE f."followerId" = $1 AND x."movedToUri" IS NULL`, [u.id])).rows[0]?.n ?? 0);
      const fr = Number((await c.query(`SELECT count(*)::int AS n FROM following f JOIN "user" x ON x.id = f."followerId" WHERE f."followeeId" = $1 AND x."movedToUri" IS NULL`, [u.id])).rows[0]?.n ?? 0);
      await c.query(`UPDATE "user" SET "followingCount" = $2, "followersCount" = $3 WHERE id = $1`, [u.id, fe, fr]);
    }
  }
}

/** UserFollowingService.acceptFollowRequest; false when there is no request. */
export async function acceptFollowRequestPg(env: ApiEnv, followeeId: string, followerId: string): Promise<boolean> {
  const pre = await withHyperdriveClient(env.HYPERDRIVE!, async (c) => {
    const req = (await c.query(`SELECT "requestId", "withReplies" FROM follow_request WHERE "followeeId" = $1 AND "followerId" = $2 LIMIT 1`, [followeeId, followerId])).rows[0];
    if (!req) return null;
    return { req, follower: (await userRow(c, followerId))!, followee: (await userRow(c, followeeId))! };
  });
  if (!pre) return false;
  await insertFollowingDoc(env, pre.followee, pre.follower, pre.req.withReplies == null ? undefined : Boolean(pre.req.withReplies));
  if (pre.follower.host != null && pre.followee.host == null) {
    await O.deliverFollowAnswer(env, "accept", followeeId, followerId, (pre.req.requestId as string | null) ?? null);
  }
  await publishMeUpdated(env, followeeId);
  return true;
}

/** UserFollowingService.acceptAllFollowRequests */
export async function acceptAllFollowRequestsPg(env: ApiEnv, followeeId: string): Promise<void> {
  const ids = await withHyperdriveClient(env.HYPERDRIVE!, async (c) =>
    (await c.query(`SELECT "followerId" FROM follow_request WHERE "followeeId" = $1`, [followeeId])).rows.map((r) => String(r.followerId)),
  );
  for (const id of ids) await acceptFollowRequestPg(env, followeeId, id);
}

/** UserFollowingService.rejectFollowRequest */
export async function rejectFollowRequestPg(env: ApiEnv, meId: string, followerId: string): Promise<void> {
  const pre = await withHyperdriveClient(env.HYPERDRIVE!, async (c) => {
    const follower = await userRow(c, followerId);
    const req = (await c.query(`SELECT id, "requestId" FROM follow_request WHERE "followeeId" = $1 AND "followerId" = $2 LIMIT 1`, [meId, followerId])).rows[0];
    return { follower, req };
  });
  if (pre.follower?.host != null) await O.deliverFollowAnswer(env, "reject", meId, followerId, (pre.req?.requestId as string | null) ?? null);
  if (pre.req) await withHyperdriveClient(env.HYPERDRIVE!, (c) => c.query(`DELETE FROM follow_request WHERE id = $1`, [pre.req.id]));
  if (pre.follower && pre.follower.host == null) await publishUnfollow(env, meId, followerId);
}

/** UserFollowingService.cancelFollowRequest; false when there is no request. */
export async function cancelFollowRequestPg(env: ApiEnv, followeeId: string, followerId: string): Promise<boolean> {
  const followee = await withHyperdriveClient(env.HYPERDRIVE!, (c) => userRow(c, followeeId));
  if (followee?.host != null) await O.deliverUndoFollow(env, followerId, followeeId);
  const ok = await withHyperdriveClient(env.HYPERDRIVE!, async (c) =>
    (await c.query(`DELETE FROM follow_request WHERE "followeeId" = $1 AND "followerId" = $2 RETURNING id`, [followeeId, followerId])).rows.length > 0,
  );
  if (!ok) return false;
  await publishMeUpdated(env, followeeId);
  return true;
}

/** UserBlockingService.cancelRequest */
async function cancelRequestForBlock(env: ApiEnv, follower: U, followee: U, silent: boolean): Promise<void> {
  const req = await withHyperdriveClient(env.HYPERDRIVE!, async (c) => {
    const r = (await c.query(`SELECT id, "requestId" FROM follow_request WHERE "followeeId" = $1 AND "followerId" = $2 LIMIT 1`, [followee.id, follower.id])).rows[0];
    if (r) await c.query(`DELETE FROM follow_request WHERE "followeeId" = $1 AND "followerId" = $2`, [followee.id, follower.id]);
    return r ?? null;
  });
  if (!req) return;
  if (followee.host == null) await publishMeUpdated(env, followee.id);
  if (follower.host == null && !silent) await publishUnfollow(env, followee.id, follower.id);
  if (follower.host == null && followee.host != null) await O.deliverUndoFollow(env, follower.id, followee.id);
  if (follower.host != null && followee.host == null) await O.deliverFollowAnswer(env, "reject", followee.id, follower.id, (req.requestId as string | null) ?? null);
}

/** UserBlockingService.block */
export async function blockPg(env: ApiEnv, blockerId: string, blockeeId: string, silent = false): Promise<void> {
  const users = await withHyperdriveClient(env.HYPERDRIVE!, async (c) => ({ blocker: (await userRow(c, blockerId))!, blockee: (await userRow(c, blockeeId))! }));
  await cancelRequestForBlock(env, users.blocker, users.blockee, silent);
  await cancelRequestForBlock(env, users.blockee, users.blocker, silent);
  await unfollowPg(env, blockerId, blockeeId, silent);
  await unfollowPg(env, blockeeId, blockerId, silent);
  await withHyperdriveClient(env.HYPERDRIVE!, async (c) => {
    // removeFromList(blockee, blocker): the blocker leaves the blockee's lists
    await c.query(`DELETE FROM user_list_membership WHERE "userId" = $1 AND "userListId" IN (SELECT id FROM user_list WHERE "userId" = $2)`, [blockerId, blockeeId]).catch(() => undefined);
    await c.query(`INSERT INTO blocking (id, "blockeeId", "blockerId") VALUES ($1, $2, $3)`, [genAidxFromDate(new Date()), blockeeId, blockerId]);
  });
  if (users.blocker.host == null && users.blockee.host != null) await O.deliverBlock(env, blockerId, blockeeId);
}

/** UserBlockingService.unblock */
export async function unblockPg(env: ApiEnv, blockerId: string, blockeeId: string): Promise<void> {
  const r = await withHyperdriveClient(env.HYPERDRIVE!, async (c) => {
    const del = await c.query(`DELETE FROM blocking WHERE "blockerId" = $1 AND "blockeeId" = $2 RETURNING id`, [blockerId, blockeeId]);
    return del.rows.length ? { blockee: await userRow(c, blockeeId), blocker: await userRow(c, blockerId) } : null;
  });
  if (r && r.blocker?.host == null && r.blockee?.host != null) await O.deliverBlock(env, blockerId, blockeeId, true);
}
