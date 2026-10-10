/**
 * Smaller client endpoints on PG, following upstream: notes/thread-muting/create|delete,
 * users/achievements|featured-notes|flashs|reactions|update-memo, following/update|update-all|
 * invalidate, username/available, stats.
 *
 * users/featured-notes: upstream keeps a Redis per-user ranking (+1 per reaction on the user's
 * public non-reply local notes, 7-day windows, current + previous). Here the same score is
 * counted from `note_reaction` over the last two windows.
 */

import { readThroughJson } from "./cache-resolve.js";
import { packNoteFromPg, rowToPackNote } from "./notes-pg.js";
import { convertLegacyReaction } from "../../packers/src/note.js";
import { NoteQuery } from "./note-query.js";
import { metaRowPg } from "./user-lite-pg.js";
import { notesRankingPg } from "./featured-pg.js";
import { genAidx, genAidxFromDate, parseAidxTime } from "../../id/src/index.js";
import type { ApiEnv } from "./env.js";
import { apiErrorResponse, CREDENTIAL_REQUIRED, INTERNAL_ERROR } from "./errors.js";
import { withHyperdriveClient, type PgQueryable } from "./pg.js";
import { isModeratorPg } from "./policies-pg.js";
import { packUsers, pagination, visibilitySql } from "./client-endpoints-pg.js";
import { buildPackConfig } from "./meta-source.js";
import { getNotesByIdsPg, packNotesFromPg } from "./notes-pg.js";
import { decodeReactionKey } from "../../packers/src/note.js";
import * as g from "./graph-pg.js";
import * as O from "./ap/outbound.js";
import { webhooksForUnfollow } from "./webhooks-pg.js";
import { authUserId as auth, clientError as err, errorResponse as fail, hd, invalidParam as bad, optionalUserId as optionalMe } from "./handler-kit.js";

type Ctx = { hasCredential: boolean; request: Request };
type Body = Record<string, unknown>;
type Handler = (env: ApiEnv, body: Body, ctx: Ctx) => Promise<Response | unknown>;
type Row = Record<string, unknown>;

const E = {
  tmCreateNoSuchNote: err("NO_SUCH_NOTE", "5ff67ada-ed3b-2e71-8e87-a1a421e177d2", "No such note."),
  tmAlreadyMuting: err("ALREADY_MUTING", "c146e22d-1141-4b31-b28d-176371014d18", "You are already muting that thread."),
  tmDeleteNoSuchNote: err("NO_SUCH_NOTE", "bddd57ac-ceb3-b29d-4334-86ea5fae481a", "No such note."),
  reactionsNotPublic: err("REACTIONS_NOT_PUBLIC", "673a7dd2-6924-1093-e0c0-e68456ceae5c", "Reactions of the user is not public."),
  reactionsRemote: err("IS_REMOTE_USER", "6b95fa98-8cf9-2350-e284-f0ffdb54a805", "Currently unavailable to display reactions of remote users. See https://github.com/misskey-dev/misskey/issues/12964"),
  memoNoSuchUser: err("NO_SUCH_USER", "6fef56f3-e765-4957-88e5-c6f65329b8a5", "No such user."),
  updateNoSuchUser: err("NO_SUCH_USER", "14318698-f67e-492a-99da-5353a5ac52be", "No such user."),
  updateYourself: err("FOLLOWEE_IS_YOURSELF", "4c4cbaf9-962a-463b-8418-a5e365dbf2eb", "Followee is yourself."),
  updateNotFollowing: err("NOT_FOLLOWING", "b8dc75cf-1cb5-46c9-b14b-5f1ffbd782c9", "You are not following that user."),
  invalidateNoSuchUser: err("NO_SUCH_USER", "b77e6ae6-a3e5-40da-9cc8-c240115479cc", "No such user."),
  invalidateYourself: err("FOLLOWER_IS_YOURSELF", "07dc03b9-03da-422d-885b-438313707662", "Follower is yourself."),
  invalidateNotFollowing: err("NOT_FOLLOWING", "918faac3-074f-41ae-9c43-ed5d2946770d", "The other use is not following you."),
};

const noContent = () => new Response(null, { status: 204 });

const limitOf = (body: Body): number | null => {
  const l = body.limit === undefined ? 10 : body.limit;
  return Number.isInteger(l) && (l as number) >= 1 && (l as number) <= 100 ? (l as number) : null;
};

async function packOne(env: ApiEnv, userId: string, me: string | null): Promise<unknown> {
  return ((await packUsers(env, [userId], me, false)) as unknown[])[0] ?? null;
}

async function userRow(c: PgQueryable, id: unknown): Promise<Row | null> {
  if (typeof id !== "string") return null;
  return (await c.query(`SELECT id, host FROM "user" WHERE id = $1`, [id])).rows[0] ?? null;
}

// ---------------------------------------------------------------- thread muting

function threadMuting(op: "create" | "delete"): Handler {
  return async (env, body, ctx) => {
    const me = await auth(env, body, ctx);
    if (!me) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
    if (typeof body.noteId !== "string") return bad();
    return withHyperdriveClient(hd(env), async (c) => {
      const note = (await c.query(`SELECT id, "threadId" FROM note WHERE id = $1`, [body.noteId])).rows[0];
      if (!note) return fail(op === "create" ? E.tmCreateNoSuchNote : E.tmDeleteNoSuchNote);
      const threadId = String(note.threadId ?? note.id);
      if (op === "delete") {
        await c.query(`DELETE FROM note_thread_muting WHERE "threadId" = $1 AND "userId" = $2`, [threadId, me]);
        return noContent();
      }
      if ((await c.query(`SELECT 1 AS ok FROM note_thread_muting WHERE "threadId" = $1 AND "userId" = $2`, [threadId, me])).rows.length) {
        return fail(E.tmAlreadyMuting);
      }
      await c.query(`INSERT INTO note_thread_muting (id, "threadId", "userId") VALUES ($1, $2, $3)`, [genAidx(Date.now()), threadId, me]);
      return noContent();
    });
  };
}

// ---------------------------------------------------------------- users/*

const achievements: Handler = async (env, body) => {
  if (typeof body.userId !== "string") return bad();
  const p = await withHyperdriveClient(hd(env), async (c) =>
    (await c.query(`SELECT achievements FROM user_profile WHERE "userId" = $1`, [body.userId])).rows[0],
  );
  return p ? (p.achievements ?? []) : apiErrorResponse(INTERNAL_ERROR, 500); // findOneByOrFail
};

/** upstream isUserRelated */
function isUserRelated(n: { userId: string; replyUserId?: string | null; renoteUserId?: string | null }, ids: Set<string>, ignoreAuthor = false): boolean {
  if (ids.has(n.userId) && !ignoreAuthor) return true;
  if (n.replyUserId != null && n.replyUserId !== n.userId && ids.has(n.replyUserId)) return true;
  if (n.renoteUserId != null && n.renoteUserId !== n.userId && ids.has(n.renoteUserId)) return true;
  return false;
}

const featuredNotes: Handler = async (env, body, ctx) => {
  const me = await optionalMe(env, body, ctx);
  if (me === "invalid") return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  const limit = limitOf(body);
  if (limit == null || typeof body.userId !== "string" || (body.untilId !== undefined && typeof body.untilId !== "string")) return bad();
  const userId = body.userId;
  const notes = await withHyperdriveClient(hd(env), async (c) => {
    const blockingMe = new Set<string>(me ? (await c.query(`SELECT "blockerId" FROM blocking WHERE "blockeeId" = $1`, [me])).rows.map((r) => String(r.blockerId)) : []);
    if (blockingMe.has(userId)) return [];
    // FeaturedService.getPerUserNotesRanking(userId, 50)
    let ids = (await notesRankingPg(c, { kind: "user", userId }, 50).catch((e: unknown) => {
      console.warn(`user notes ranking failed: ${e instanceof Error ? e.message : String(e)}`);
      return [] as string[];
    })).sort((x, y) => (x > y ? -1 : 1));
    if (typeof body.untilId === "string") ids = ids.filter((id) => id < (body.untilId as string));
    ids = ids.slice(0, limit);
    if (!ids.length) return [];
    const muting = new Set<string>(me ? (await c.query(`SELECT "muteeId" FROM muting WHERE "muterId" = $1 AND ("expiresAt" IS NULL OR "expiresAt" > now())`, [me])).rows.map((r) => String(r.muteeId)) : []);
    const q = new NoteQuery(await metaRowPg(c));
    q.and(`note.id = ANY(${q.p(ids)}::varchar[])`);
    q.blockedHost();
    q.suspendedUser();
    return (await q.run(c, null))
      .filter((n) => !(me && isUserRelated(n, blockingMe, false)) && !(me && isUserRelated(n, muting, true)))
      .sort((x, y) => (x.id > y.id ? -1 : 1));
  });
  return packNotesFromPg(env, notes, buildPackConfig(env), me);
};

const flashs: Handler = async (env, body, ctx) => {
  const me = await optionalMe(env, body, ctx);
  if (me === "invalid") return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  const limit = limitOf(body);
  if (limit == null || typeof body.userId !== "string") return bad();
  return withHyperdriveClient(hd(env), async (c) => {
    const params: unknown[] = [body.userId];
    const p = pagination(body, params, "flash.id");
    params.push(limit);
    const rows = (await c.query(
      `SELECT flash.* FROM flash WHERE ${[`flash."userId" = $1`, `flash.visibility = 'public'`, ...p.where].join(" AND ")} ORDER BY flash.id ${p.order} LIMIT $${params.length}`,
      params,
    )).rows;
    const users = new Map(((await packUsers(env, [...new Set(rows.map((r) => String(r.userId)))], null, false)) as { id: string }[]).map((u) => [u.id, u]));
    return rows.map((f) => ({
      id: f.id, createdAt: (parseAidxTime(String(f.id)) ?? new Date(0)).toISOString(), updatedAt: new Date(String(f.updatedAt)).toISOString(),
      userId: f.userId, user: users.get(String(f.userId)) ?? null, title: f.title, summary: f.summary, script: f.script, visibility: f.visibility,
      likedCount: Number(f.likedCount ?? 0),
    }));
  });
};

const reactions: Handler = async (env, body, ctx) => {
  const me = await optionalMe(env, body, ctx);
  if (me === "invalid") return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  const limit = limitOf(body);
  if (limit == null || typeof body.userId !== "string") return bad();
  const userId = body.userId;
  const res = await withHyperdriveClient(hd(env), async (c) => {
    const blockingMe = new Set<string>(me ? (await c.query(`SELECT "blockerId" FROM blocking WHERE "blockeeId" = $1`, [me])).rows.map((r) => String(r.blockerId)) : []);
    const isMod = me ? await isModeratorPg(env, c, me) : false;
    if (!isMod) {
      const u = await userRow(c, userId);
      if (!u) throw new Error("No such user"); // cacheService.findUserById
      if (u.host != null) return fail(E.reactionsRemote);
      const p = (await c.query(`SELECT "publicReactions" FROM user_profile WHERE "userId" = $1`, [userId])).rows[0];
      if (!p) throw new Error("No such profile"); // findOneByOrFail
      if ((me == null || me !== userId) && !p.publicReactions) return fail(E.reactionsNotPublic);
      if (blockingMe.has(userId)) return [];
    }
    const muting = new Set<string>(me ? (await c.query(`SELECT "muteeId" FROM muting WHERE "muterId" = $1 AND ("expiresAt" IS NULL OR "expiresAt" > now())`, [me])).rows.map((r) => String(r.muteeId)) : []);
    // reactions joined with their notes: pagination on the reaction, note visibility, blocked hosts, suspended users
    const q = new NoteQuery(await metaRowPg(c));
    q.joins = q.joins.replace("FROM note note", `FROM note_reaction reaction LEFT JOIN note note ON note.id = reaction."noteId"`).replace(`INNER JOIN "user" "user"`, `LEFT JOIN "user" "user"`);
    q.paginate(typeof body.sinceId === "string" ? body.sinceId : null, typeof body.untilId === "string" ? body.untilId : null,
      typeof body.sinceDate === "number" ? body.sinceDate : null, typeof body.untilDate === "number" ? body.untilDate : null, "reaction.id");
    q.and(`reaction."userId" = ${q.p(userId)}`);
    q.visibility(me);
    q.blockedHost();
    q.suspendedUser();
    const sql = q.sql(limit).replace(/^SELECT /, `SELECT reaction.id AS "reactionId", reaction.reaction AS "reactionType", `);
    const rows = (await c.query(sql, q.params)).rows;
    return rows.map((r) => ({ id: String(r.reactionId), reaction: String(r.reactionType), note: rowToPackNote(r) }))
      .filter((x) => x.note.userId === userId || !(me && (isUserRelated(x.note, blockingMe) || isUserRelated(x.note, muting))));
  });
  if (res instanceof Response) return res;
  if (!res.length) return [];
  // NoteReactionEntityService.packManyWithNote: users via packMany, each note packed on its own
  const user = ((await packUsers(env, [userId], me, false)) as unknown[])[0];
  const config = buildPackConfig(env);
  const out: unknown[] = [];
  for (const r of res) {
    out.push({
      id: r.id,
      createdAt: (parseAidxTime(r.id) ?? new Date(0)).toISOString(),
      user,
      type: convertLegacyReaction(r.reaction),
      note: await packNoteFromPg(env, r.note, config, me),
    });
  }
  return out;
};

const updateMemo: Handler = async (env, body, ctx) => {
  const me = await auth(env, body, ctx);
  if (!me) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  if (typeof body.userId !== "string" || !("memo" in body) || (body.memo !== null && typeof body.memo !== "string")) return bad();
  return withHyperdriveClient(hd(env), async (c) => {
    if (!(await userRow(c, body.userId))) return fail(E.memoNoSuchUser);
    if (body.memo == null || body.memo === "") {
      await c.query(`DELETE FROM user_memo WHERE "userId" = $1 AND "targetUserId" = $2`, [me, body.userId]);
      return noContent();
    }
    const prev = (await c.query(`SELECT id FROM user_memo WHERE "userId" = $1 AND "targetUserId" = $2`, [me, body.userId])).rows[0];
    if (prev) await c.query(`UPDATE user_memo SET memo = $2 WHERE id = $1`, [prev.id, body.memo]);
    else await c.query(`INSERT INTO user_memo (id, "userId", "targetUserId", memo) VALUES ($1, $2, $3, $4)`, [genAidx(Date.now()), me, body.userId, body.memo]);
    return noContent();
  });
};

// ---------------------------------------------------------------- following/*

const notifyValue = (v: unknown) => (v === "none" ? null : v);

const followingUpdate: Handler = async (env, body, ctx) => {
  const me = await auth(env, body, ctx);
  if (!me) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  if (typeof body.userId !== "string" || (body.notify !== undefined && body.notify !== "normal" && body.notify !== "none") || (body.withReplies !== undefined && typeof body.withReplies !== "boolean")) return bad();
  if (body.userId === me) return fail(E.updateYourself);
  const r = await withHyperdriveClient(hd(env), async (c) => {
    if (!(await userRow(c, body.userId))) return fail(E.updateNoSuchUser);
    const ex = (await c.query(`SELECT id FROM following WHERE "followerId" = $1 AND "followeeId" = $2`, [me, body.userId])).rows[0];
    if (!ex) return fail(E.updateNotFollowing);
    if (body.notify !== undefined) await c.query(`UPDATE following SET notify = $2 WHERE id = $1`, [ex.id, notifyValue(body.notify)]);
    if (body.withReplies !== undefined) await c.query(`UPDATE following SET "withReplies" = $2 WHERE id = $1`, [ex.id, body.withReplies]);
    return null;
  });
  // upstream returns the follower (the caller) packed
  return r ?? packOne(env, me, me);
};

const followingUpdateAll: Handler = async (env, body, ctx) => {
  const me = await auth(env, body, ctx);
  if (!me) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  if ((body.notify !== undefined && body.notify !== "normal" && body.notify !== "none") || (body.withReplies !== undefined && typeof body.withReplies !== "boolean")) return bad();
  await withHyperdriveClient(hd(env), async (c) => {
    if (body.notify !== undefined) await c.query(`UPDATE following SET notify = $2 WHERE "followerId" = $1`, [me, notifyValue(body.notify)]);
    if (body.withReplies !== undefined) await c.query(`UPDATE following SET "withReplies" = $2 WHERE "followerId" = $1`, [me, body.withReplies]);
  });
  return noContent();
};

/** Remove a follower (the caller is the followee). */
const followingInvalidate: Handler = async (env, body, ctx) => {
  const me = await auth(env, body, ctx);
  if (!me) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  if (typeof body.userId !== "string") return bad();
  if (body.userId === me) return fail(E.invalidateYourself);
  const follower = await withHyperdriveClient(hd(env), (c) => userRow(c, body.userId));
  if (!follower) return fail(E.invalidateNoSuchUser);
  if (!(await g.unfollow(env, String(follower.id), me))) return fail(E.invalidateNotFollowing);
  // UserFollowingService.unfollow: a remote follower gets Reject(Follow); local followers' webhooks
  if (follower.host != null) await O.deliverFollowAnswer(env, "reject", me, String(follower.id), null);
  await webhooksForUnfollow(env, String(follower.id), me);
  return packOne(env, String(follower.id), me);
};

// ---------------------------------------------------------------- misc

const usernameAvailable: Handler = async (env, body) => {
  if (typeof body.username !== "string" || !/^\w{1,20}$/.test(body.username)) return bad();
  const name = body.username.toLowerCase();
  return withHyperdriveClient(hd(env), async (c) => {
    const exist = (await c.query(`SELECT 1 AS ok FROM "user" WHERE host IS NULL AND "usernameLower" = $1`, [name])).rows.length > 0;
    let used = false;
    try {
      used = (await c.query(`SELECT 1 AS ok FROM used_username WHERE username = $1`, [name])).rows.length > 0;
    } catch {
      /* no used_username table */
    }
    const preserved = ((await metaRowPg(c)).preservedUsernames as string[] | null | undefined) ?? [];
    return { available: !exist && !used && !preserved.map((x) => x.toLowerCase()).includes(name) };
  });
};

/**
 * upstream stats: totals from the notes / users charts (here: surviving rows), reactions,
 * instances. Each count reads a whole table, so the results are kept: note / user counts for
 * 5 minutes (upstream's charts are saved every 20), reactions / instances for an hour (upstream
 * caches those for an hour).
 */
const stats: Handler = async (env) => {
  const count = (sql: string) => withHyperdriveClient(hd(env), async (c) => Number((await c.query(sql)).rows[0]?.n ?? 0));
  const totals = await readThroughJson(env, "stats:v1:totals", 5 * 60, async () => ({
    notesCount: await count(`SELECT count(*)::int AS n FROM note`),
    originalNotesCount: await count(`SELECT count(*)::int AS n FROM note WHERE "userHost" IS NULL`),
    usersCount: await count(`SELECT count(*)::int AS n FROM "user"`),
    originalUsersCount: await count(`SELECT count(*)::int AS n FROM "user" WHERE host IS NULL`),
  }));
  const slow = await readThroughJson(env, "stats:v1:slow", 60 * 60, async () => ({
    reactionsCount: await count(`SELECT count(*)::int AS n FROM note_reaction`),
    instances: await count(`SELECT count(*)::int AS n FROM instance`).catch(() => count(`SELECT count(DISTINCT host)::int AS n FROM "user" WHERE host IS NOT NULL`)),
  }));
  return { ...totals, ...slow, driveUsageLocal: 0, driveUsageRemote: 0 };
};

// ---------------------------------------------------------------- registry

function pgOnly(h: Handler): Handler {
  return async (env, body, ctx) => {
    if (!env.HYPERDRIVE?.connectionString) {
      return apiErrorResponse({ message: "Hyperdrive required.", code: "HYPERDRIVE_UNBOUND", id: "00000000-0000-4000-8000-0000000000b1", kind: "server" }, 501);
    }
    return h(env, body, ctx);
  };
}

const RAW: Record<string, Handler> = {
  "notes/thread-muting/create": threadMuting("create"),
  "notes/thread-muting/delete": threadMuting("delete"),
  "users/achievements": achievements,
  "users/featured-notes": featuredNotes,
  "users/flashs": flashs,
  "users/reactions": reactions,
  "users/update-memo": updateMemo,
  "following/update": followingUpdate,
  "following/update-all": followingUpdateAll,
  "following/invalidate": followingInvalidate,
  "username/available": usernameAvailable,
  stats,
};

export const clientMiscHandlers: Record<string, Handler> = Object.fromEntries(Object.entries(RAW).map(([k, h]) => [k, pgOnly(h)]));

