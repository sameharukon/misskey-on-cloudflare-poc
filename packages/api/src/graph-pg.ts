/**
 * Block / mute / follow_request on Postgres (Hyperdrive), plus a lock- and
 * block-aware follow.
 */

import { genAidxFromDate } from "../../id/src/index.js";
import type { ApiEnv } from "./env.js";
import { withHyperdriveClient, type PgQueryable } from "./pg.js";
import { followingInstanceStatsC } from "./ap/instances.js";

type Hd = NonNullable<ApiEnv["HYPERDRIVE"]>;
function hd(env: ApiEnv): Hd {
  if (!env.HYPERDRIVE?.connectionString) throw new Error("HYPERDRIVE_UNBOUND");
  return env.HYPERDRIVE;
}

export async function userExists(c: PgQueryable, id: string): Promise<Record<string, unknown> | null> {
  const r = await c.query(
    `SELECT id, host, inbox, "sharedInbox", "isLocked"
     FROM "user" WHERE id = $1 LIMIT 1`,
    [id],
  );
  return r.rows[0] ?? null;
}

async function exists(c: PgQueryable, sql: string, params: unknown[]): Promise<boolean> {
  const r = await c.query(sql, params);
  return r.rows.length > 0;
}

export async function isBlockingC(c: PgQueryable, blockerId: string, blockeeId: string): Promise<boolean> {
  return exists(
    c,
    `SELECT 1 AS ok FROM blocking WHERE "blockerId" = $1 AND "blockeeId" = $2 LIMIT 1`,
    [blockerId, blockeeId],
  );
}

export async function isMutingC(c: PgQueryable, muterId: string, muteeId: string): Promise<boolean> {
  return exists(
    c,
    `SELECT 1 AS ok FROM muting
     WHERE "muterId" = $1 AND "muteeId" = $2 AND ("expiresAt" IS NULL OR "expiresAt" > now()) LIMIT 1`,
    [muterId, muteeId],
  );
}

export async function isBlocking(env: ApiEnv, blockerId: string, blockeeId: string): Promise<boolean> {
  if (!env.HYPERDRIVE?.connectionString) return false;
  return withHyperdriveClient(hd(env), (c) => isBlockingC(c, blockerId, blockeeId));
}

export async function isRenoteMutedC(c: PgQueryable, muterId: string, muteeId: string): Promise<boolean> {
  return exists(
    c,
    `SELECT 1 AS ok FROM renote_muting WHERE "muterId" = $1 AND "muteeId" = $2 LIMIT 1`,
    [muterId, muteeId],
  );
}

/** Expired-mute cleanup (cron). Reads already ignore expired rows. */
export async function deleteExpiredMutes(env: ApiEnv): Promise<number> {
  if (!env.HYPERDRIVE?.connectionString) return 0;
  return withHyperdriveClient(hd(env), async (c) => {
    const r = await c.query(`DELETE FROM muting WHERE "expiresAt" IS NOT NULL AND "expiresAt" < now() RETURNING id`, []);
    return r.rows.length;
  });
}

/** Ids the viewer must not see in timelines: muted, blocking, blocked-by. */
export async function hiddenAuthorIds(env: ApiEnv, viewerId: string): Promise<Set<string>> {
  if (!env.HYPERDRIVE?.connectionString) return new Set();
  return withHyperdriveClient(hd(env), async (c) => {
    const r = await c.query(
      `SELECT "muteeId" AS id FROM muting
         WHERE "muterId" = $1 AND ("expiresAt" IS NULL OR "expiresAt" > now())
       UNION SELECT "blockeeId" AS id FROM blocking WHERE "blockerId" = $1
       UNION SELECT "blockerId" AS id FROM blocking WHERE "blockeeId" = $1`,
      [viewerId],
    );
    return new Set(r.rows.map((x) => String(x.id)));
  });
}

async function insertFollowing(c: PgQueryable, follower: Record<string, unknown>, followee: Record<string, unknown>, withReplies = false): Promise<void> {
  await c.query(
    `INSERT INTO following (
      id, "followeeId", "followerId", "isFollowerHibernated", "withReplies", notify,
      "followerHost", "followerInbox", "followerSharedInbox",
      "followeeHost", "followeeInbox", "followeeSharedInbox"
    ) VALUES ($1,$2,$3,FALSE,$4,NULL,$5,$6,$7,$8,$9,$10)
    ON CONFLICT DO NOTHING`,
    [
      genAidxFromDate(new Date()),
      followee.id,
      follower.id,
      withReplies,
      follower.host ?? null,
      follower.inbox ?? null,
      follower.sharedInbox ?? null,
      followee.host ?? null,
      followee.inbox ?? null,
      followee.sharedInbox ?? null,
    ],
  );
  await c.query(`UPDATE "user" SET "followingCount" = "followingCount" + 1 WHERE id = $1`, [follower.id]);
  await c.query(`UPDATE "user" SET "followersCount" = "followersCount" + 1 WHERE id = $1`, [followee.id]);
  await followingInstanceStatsC(c, follower.host, followee.host, 1);
}

async function deleteFollowingC(c: PgQueryable, followerId: string, followeeId: string): Promise<boolean> {
  const r = await c.query(
    `DELETE FROM following WHERE "followerId" = $1 AND "followeeId" = $2 RETURNING id, "followerHost", "followeeHost"`,
    [followerId, followeeId],
  );
  if (!r.rows[0]) return false;
  await c.query(`UPDATE "user" SET "followingCount" = GREATEST("followingCount" - 1, 0) WHERE id = $1`, [followerId]);
  await c.query(`UPDATE "user" SET "followersCount" = GREATEST("followersCount" - 1, 0) WHERE id = $1`, [followeeId]);
  await followingInstanceStatsC(c, r.rows[0].followerHost, r.rows[0].followeeHost, -1);
  return true;
}

export type FollowOutcome =
  | "followed"
  | "requested"
  | "already_following"
  | "already_requested"
  | "self"
  | "blocking"
  | "blocked"
  | "no_such_user";

/** Follow with lock + block checks (upstream following/create semantics). */
export async function followWithPolicy(
  env: ApiEnv,
  followerId: string,
  followeeId: string,
  opts: { requestId?: string | null } = {},
): Promise<FollowOutcome> {
  if (followerId === followeeId) return "self";
  return withHyperdriveClient(hd(env), async (c) => {
    const followee = await userExists(c, followeeId);
    const follower = await userExists(c, followerId);
    if (!followee || !follower) return "no_such_user";
    if (await isBlockingC(c, followerId, followeeId)) return "blocking";
    if (await isBlockingC(c, followeeId, followerId)) return "blocked";
    if (await exists(c, `SELECT 1 AS ok FROM following WHERE "followerId"=$1 AND "followeeId"=$2 LIMIT 1`, [followerId, followeeId])) {
      return "already_following";
    }
    // upstream: locked followee, or local→remote, goes through a request
    const remoteFollowee = followee.host != null && follower.host == null;
    if (followee.isLocked || remoteFollowee) {
      if (await exists(c, `SELECT 1 AS ok FROM follow_request WHERE "followerId"=$1 AND "followeeId"=$2 LIMIT 1`, [followerId, followeeId])) {
        return "already_requested";
      }
      await c.query(
        `INSERT INTO follow_request (
          id, "followeeId", "followerId", "requestId", "withReplies",
          "followerHost", "followerInbox", "followerSharedInbox",
          "followeeHost", "followeeInbox", "followeeSharedInbox"
        ) VALUES ($1,$2,$3,$10,FALSE,$4,$5,$6,$7,$8,$9)`,
        [
          genAidxFromDate(new Date()),
          followeeId,
          followerId,
          follower.host ?? null,
          follower.inbox ?? null,
          follower.sharedInbox ?? null,
          followee.host ?? null,
          followee.inbox ?? null,
          followee.sharedInbox ?? null,
          opts.requestId ?? null,
        ],
      );
      return "requested";
    }
    await insertFollowing(c, follower, followee);
    return "followed";
  });
}

export async function unfollow(env: ApiEnv, followerId: string, followeeId: string): Promise<boolean> {
  return withHyperdriveClient(hd(env), (c) => deleteFollowingC(c, followerId, followeeId));
}

/** followee accepts follower's request → following row. */
export async function acceptRequest(env: ApiEnv, followeeId: string, followerId: string): Promise<boolean> {
  return withHyperdriveClient(hd(env), async (c) => {
    const del = await c.query(
      `DELETE FROM follow_request WHERE "followerId"=$1 AND "followeeId"=$2 RETURNING id, "withReplies"`,
      [followerId, followeeId],
    );
    if (!del.rows[0]) return false;
    const follower = await userExists(c, followerId);
    const followee = await userExists(c, followeeId);
    if (!follower || !followee) return false;
    const already = await exists(c, `SELECT 1 AS ok FROM following WHERE "followerId"=$1 AND "followeeId"=$2 LIMIT 1`, [followerId, followeeId]);
    if (!already) await insertFollowing(c, follower, followee, Boolean(del.rows[0].withReplies));
    return true;
  });
}

/** Delete request (reject by followee, or cancel by follower). */
export async function deleteRequest(env: ApiEnv, followerId: string, followeeId: string): Promise<boolean> {
  return withHyperdriveClient(hd(env), async (c) => {
    const r = await c.query(
      `DELETE FROM follow_request WHERE "followerId"=$1 AND "followeeId"=$2 RETURNING id`,
      [followerId, followeeId],
    );
    return r.rows.length > 0;
  });
}

export type BlockOutcome = "blocked" | "already" | "self" | "no_such_user";

/** Block: insert blocking, remove follows + follow requests both ways. */
export async function block(env: ApiEnv, blockerId: string, blockeeId: string): Promise<BlockOutcome> {
  if (blockerId === blockeeId) return "self";
  return withHyperdriveClient(hd(env), async (c) => {
    if (!(await userExists(c, blockeeId))) return "no_such_user";
    if (await isBlockingC(c, blockerId, blockeeId)) return "already";
    await c.query(
      `INSERT INTO blocking (id, "blockeeId", "blockerId") VALUES ($1, $2, $3)`,
      [genAidxFromDate(new Date()), blockeeId, blockerId],
    );
    await deleteFollowingC(c, blockerId, blockeeId);
    await deleteFollowingC(c, blockeeId, blockerId);
    await c.query(
      `DELETE FROM follow_request WHERE ("followerId"=$1 AND "followeeId"=$2) OR ("followerId"=$2 AND "followeeId"=$1)`,
      [blockerId, blockeeId],
    );
    return "blocked";
  });
}

export async function unblock(env: ApiEnv, blockerId: string, blockeeId: string): Promise<boolean> {
  return withHyperdriveClient(hd(env), async (c) => {
    const r = await c.query(
      `DELETE FROM blocking WHERE "blockerId"=$1 AND "blockeeId"=$2 RETURNING id`,
      [blockerId, blockeeId],
    );
    return r.rows.length > 0;
  });
}

export type MuteOutcome = "muted" | "already" | "self" | "no_such_user";

export async function mute(env: ApiEnv, muterId: string, muteeId: string, expiresAt: Date | null = null): Promise<MuteOutcome> {
  if (muterId === muteeId) return "self";
  return withHyperdriveClient(hd(env), async (c) => {
    if (!(await userExists(c, muteeId))) return "no_such_user";
    if (await isMutingC(c, muterId, muteeId)) return "already";
    await c.query(
      `INSERT INTO muting (id, "expiresAt", "muteeId", "muterId") VALUES ($1, $2, $3, $4)`,
      [genAidxFromDate(new Date()), expiresAt, muteeId, muterId],
    );
    return "muted";
  });
}

export type Relation = {
  id: string;
  isFollowing: boolean;
  hasPendingFollowRequestFromYou: boolean;
  hasPendingFollowRequestToYou: boolean;
  isFollowed: boolean;
  isBlocking: boolean;
  isBlocked: boolean;
  isMuted: boolean;
  isRenoteMuted: boolean;
};

export async function relationC(c: PgQueryable, meId: string, otherId: string): Promise<Relation> {
  const q = (sql: string, p: unknown[]) => exists(c, sql, p);
  const [isFollowing, isFollowed, reqFrom, reqTo, isBlockingV, isBlockedV, isMutedV, isRenoteMutedV] = [
    await q(`SELECT 1 AS ok FROM following WHERE "followerId"=$1 AND "followeeId"=$2 LIMIT 1`, [meId, otherId]),
    await q(`SELECT 1 AS ok FROM following WHERE "followerId"=$1 AND "followeeId"=$2 LIMIT 1`, [otherId, meId]),
    await q(`SELECT 1 AS ok FROM follow_request WHERE "followerId"=$1 AND "followeeId"=$2 LIMIT 1`, [meId, otherId]),
    await q(`SELECT 1 AS ok FROM follow_request WHERE "followerId"=$1 AND "followeeId"=$2 LIMIT 1`, [otherId, meId]),
    await isBlockingC(c, meId, otherId),
    await isBlockingC(c, otherId, meId),
    await isMutingC(c, meId, otherId),
    await isRenoteMutedC(c, meId, otherId),
  ];
  return {
    id: otherId,
    isFollowing,
    hasPendingFollowRequestFromYou: reqFrom,
    hasPendingFollowRequestToYou: reqTo,
    isFollowed,
    isBlocking: isBlockingV,
    isBlocked: isBlockedV,
    isMuted: isMutedV,
    isRenoteMuted: isRenoteMutedV,
  };
}
