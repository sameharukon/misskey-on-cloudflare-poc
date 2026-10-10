/**
 * Gallery (W7.12) on PG `gallery_post` / `gallery_like` (upstream schema): gallery/posts,
 * gallery/featured, gallery/popular, gallery/posts/create|update|delete|show|like|unlike,
 * i/gallery/posts, i/gallery/likes, users/gallery/posts. Follows the upstream endpoints and
 * GalleryPostEntityService (UserLite user, packed files in fileIds order, isLiked for callers).
 *
 * gallery/featured: upstream ranks by likes counted in Redis per 3-day window (current +
 * previous). Here the same windows are computed from `gallery_like`: likes given since the start
 * of the previous window to posts created at most one window before that, top 100, cached per
 * isolate for 30 minutes as upstream caches its ranking.
 */

import { genAidx, genAidxFromDate, parseAidxTime } from "../../id/src/index.js";
import type { ApiEnv } from "./env.js";
import { apiErrorResponse, CREDENTIAL_REQUIRED, INTERNAL_ERROR } from "./errors.js";
import { withHyperdriveClient, type PgQueryable } from "./pg.js";
import { isModeratorPg, moderationLogPg } from "./policies-pg.js";
import { packUsers, pagination } from "./client-endpoints-pg.js";
import { packDriveFile } from "./drive/pack.js";
import { authUserId as auth, clientError as err, errorResponse as fail, hd, invalidParam as bad, optionalUserId as optionalMe } from "./handler-kit.js";

type Ctx = { hasCredential: boolean; request: Request };
type Body = Record<string, unknown>;
type Handler = (env: ApiEnv, body: Body, ctx: Ctx) => Promise<Response | unknown>;
type Row = Record<string, unknown>;

const noSuchPost = (id: string) => err("NO_SUCH_POST", id, "No such post.");
const E = {
  deleteNoSuch: noSuchPost("ae52f367-4bd7-4ecd-afc6-5672fff427f5"),
  deleteDenied: err("ACCESS_DENIED", "c86e09de-1c48-43ac-a435-1c7e42ed4496", "Access denied."),
  likeNoSuch: noSuchPost("56c06af3-1287-442f-9701-c93f7c4a62ff"),
  yourPost: err("YOUR_POST", "f78f1511-5ebc-4478-a888-1198d752da68", "You cannot like your post."),
  alreadyLiked: err("ALREADY_LIKED", "40e9ed56-a59c-473a-bf3f-f289c54fb5a7", "The post has already been liked."),
  showNoSuch: noSuchPost("1137bf14-c5b0-4604-85bb-5b5371b1cd45"),
  unlikeNoSuch: noSuchPost("c32e6dd0-b555-4413-925e-b3757d19ed84"),
  notLiked: err("NOT_LIKED", "e3e8e06e-be37-41f7-a5b4-87a8250288f0", "You have not liked that post."),
};

const noContent = () => new Response(null, { status: 204 });
export const GALLERY_POSTS_RANKING_WINDOW = 1000 * 60 * 60 * 24 * 3;

/** GalleryPostEntityService.pack */
export async function packPosts(env: ApiEnv, c: PgQueryable, posts: Row[], me: string | null): Promise<Record<string, unknown>[]> {
  if (!posts.length) return [];
  const users = new Map(((await packUsers(env, [...new Set(posts.map((p) => String(p.userId)))], me, false)) as { id: string }[]).map((u) => [u.id, u]));
  const fileIds = [...new Set(posts.flatMap((p) => (p.fileIds as string[] | null) ?? []))];
  const files = fileIds.length
    ? new Map((await c.query(`SELECT * FROM drive_file WHERE id = ANY($1::varchar[])`, [fileIds])).rows.map((f) => [String(f.id), packDriveFile(f)]))
    : new Map<string, unknown>();
  const liked = me
    ? new Set((await c.query(`SELECT "postId" FROM gallery_like WHERE "userId" = $1 AND "postId" = ANY($2::varchar[])`, [me, posts.map((p) => p.id)])).rows.map((r) => String(r.postId)))
    : null;
  return posts.map((p) => {
    const tags = (p.tags as string[] | null) ?? [];
    return {
      id: p.id,
      createdAt: (parseAidxTime(String(p.id)) ?? new Date(0)).toISOString(),
      updatedAt: new Date(String(p.updatedAt)).toISOString(),
      userId: p.userId,
      user: users.get(String(p.userId)) ?? null,
      title: p.title,
      description: p.description ?? null,
      fileIds: p.fileIds ?? [],
      files: ((p.fileIds as string[] | null) ?? []).map((id) => files.get(id)).filter(Boolean),
      ...(tags.length ? { tags } : {}),
      isSensitive: Boolean(p.isSensitive),
      likedCount: Number(p.likedCount ?? 0),
      ...(liked ? { isLiked: liked.has(String(p.id)) } : {}),
    };
  });
}

const limitOf = (body: Body): number | null => {
  const l = body.limit === undefined ? 10 : body.limit;
  return Number.isInteger(l) && (l as number) >= 1 && (l as number) <= 100 ? (l as number) : null;
};

async function listPosts(c: PgQueryable, body: Body, where: string[], params: unknown[], limit: number): Promise<Row[]> {
  const p = pagination(body, params, "post.id");
  params.push(limit);
  const all = [...where, ...p.where];
  return (await c.query(
    `SELECT post.* FROM gallery_post post ${all.length ? `WHERE ${all.join(" AND ")}` : ""} ORDER BY post.id ${p.order} LIMIT $${params.length}`,
    params,
  )).rows;
}

const validFileIds = (v: unknown) => Array.isArray(v) && v.length >= 1 && v.length <= 32 && v.every((x) => typeof x === "string") && new Set(v).size === v.length;

/** The caller's own files among `ids`, in request order (upstream filters out the rest). */
async function ownFiles(c: PgQueryable, ids: string[], me: string): Promise<string[]> {
  const own = new Set((await c.query(`SELECT id FROM drive_file WHERE "userId" = $1 AND id = ANY($2::varchar[])`, [me, ids])).rows.map((r) => String(r.id)));
  return ids.filter((id) => own.has(id));
}

// ---------------------------------------------------------------- endpoints

const create: Handler = async (env, body, ctx) => {
  const me = await auth(env, body, ctx);
  if (!me) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  if (typeof body.title !== "string" || body.title.length < 1 || !validFileIds(body.fileIds)) return bad();
  if (body.description !== undefined && body.description !== null && typeof body.description !== "string") return bad();
  if (body.isSensitive !== undefined && typeof body.isSensitive !== "boolean") return bad();
  return withHyperdriveClient(hd(env), async (c) => {
    const files = await ownFiles(c, body.fileIds as string[], me);
    if (!files.length) return apiErrorResponse(INTERNAL_ERROR, 500); // upstream: throw new Error()
    const id = genAidx(Date.now());
    await c.query(`INSERT INTO gallery_post (id, "updatedAt", title, description, "userId", "isSensitive", "fileIds") VALUES ($1, now(), $2, $3, $4, $5, $6::varchar[])`, [
      id, body.title, (body.description as string | null | undefined) ?? null, me, body.isSensitive === true, files,
    ]);
    const post = (await c.query(`SELECT * FROM gallery_post WHERE id = $1`, [id])).rows[0]!;
    return (await packPosts(env, c, [post], me))[0];
  });
};

const update: Handler = async (env, body, ctx) => {
  const me = await auth(env, body, ctx);
  if (!me) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  if (typeof body.postId !== "string") return bad();
  if (body.title !== undefined && (typeof body.title !== "string" || body.title.length < 1)) return bad();
  if (body.fileIds !== undefined && !validFileIds(body.fileIds)) return bad();
  if (body.description !== undefined && body.description !== null && typeof body.description !== "string") return bad();
  if (body.isSensitive !== undefined && typeof body.isSensitive !== "boolean") return bad();
  return withHyperdriveClient(hd(env), async (c) => {
    let files: string[] | undefined;
    if (body.fileIds) {
      files = await ownFiles(c, body.fileIds as string[], me);
      if (!files.length) return apiErrorResponse(INTERNAL_ERROR, 500);
    }
    const sets = [`"updatedAt" = now()`];
    const params: unknown[] = [body.postId, me];
    const set = (col: string, v: unknown, cast = "") => sets.push(`"${col}" = $${params.push(v)}${cast}`);
    if (body.title !== undefined) set("title", body.title);
    if (body.description !== undefined) set("description", body.description);
    // upstream paramDef default: isSensitive = false when omitted
    set("isSensitive", body.isSensitive === true);
    if (files) set("fileIds", files, "::varchar[]");
    // upstream: update scoped to the caller, then findOneByOrFail (someone else's id → 500)
    await c.query(`UPDATE gallery_post SET ${sets.join(", ")} WHERE id = $1 AND "userId" = $2`, params);
    const post = (await c.query(`SELECT * FROM gallery_post WHERE id = $1`, [body.postId])).rows[0];
    if (!post) return apiErrorResponse(INTERNAL_ERROR, 500);
    return (await packPosts(env, c, [post], me))[0];
  });
};

const del: Handler = async (env, body, ctx) => {
  const me = await auth(env, body, ctx);
  if (!me) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  if (typeof body.postId !== "string") return bad();
  return withHyperdriveClient(hd(env), async (c) => {
    const post = (await c.query(`SELECT * FROM gallery_post WHERE id = $1`, [body.postId])).rows[0];
    if (!post) return fail(E.deleteNoSuch);
    if (post.userId !== me && !(await isModeratorPg(env, c, me))) return fail(E.deleteDenied);
    await c.query(`DELETE FROM gallery_like WHERE "postId" = $1`, [post.id]);
    await c.query(`DELETE FROM gallery_post WHERE id = $1`, [post.id]);
    if (post.userId !== me) {
      const owner = (await c.query(`SELECT username FROM "user" WHERE id = $1`, [post.userId])).rows[0];
      await moderationLogPg(c, me, "deleteGalleryPost", { postId: post.id, postUserId: post.userId, postUserUsername: owner?.username ?? null, post: post }, genAidx(Date.now()));
    }
    return noContent();
  });
};

const show: Handler = async (env, body, ctx) => {
  const me = await optionalMe(env, body, ctx);
  if (me === "invalid") return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  if (typeof body.postId !== "string") return bad();
  return withHyperdriveClient(hd(env), async (c) => {
    const post = (await c.query(`SELECT * FROM gallery_post WHERE id = $1`, [body.postId])).rows[0];
    return post ? (await packPosts(env, c, [post], me))[0] : fail(E.showNoSuch);
  });
};

const like: Handler = async (env, body, ctx) => {
  const me = await auth(env, body, ctx);
  if (!me) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  if (typeof body.postId !== "string") return bad();
  return withHyperdriveClient(hd(env), async (c) => {
    const post = (await c.query(`SELECT id, "userId" FROM gallery_post WHERE id = $1`, [body.postId])).rows[0];
    if (!post) return fail(E.likeNoSuch);
    if (post.userId === me) return fail(E.yourPost);
    if ((await c.query(`SELECT 1 AS ok FROM gallery_like WHERE "postId" = $1 AND "userId" = $2`, [post.id, me])).rows.length) return fail(E.alreadyLiked);
    await c.query(`INSERT INTO gallery_like (id, "userId", "postId") VALUES ($1, $2, $3)`, [genAidx(Date.now()), me, post.id]);
    await c.query(`UPDATE gallery_post SET "likedCount" = "likedCount" + 1 WHERE id = $1`, [post.id]);
    return noContent();
  });
};

const unlike: Handler = async (env, body, ctx) => {
  const me = await auth(env, body, ctx);
  if (!me) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  if (typeof body.postId !== "string") return bad();
  return withHyperdriveClient(hd(env), async (c) => {
    const post = (await c.query(`SELECT id FROM gallery_post WHERE id = $1`, [body.postId])).rows[0];
    if (!post) return fail(E.unlikeNoSuch);
    const ex = (await c.query(`SELECT id FROM gallery_like WHERE "postId" = $1 AND "userId" = $2`, [post.id, me])).rows[0];
    if (!ex) return fail(E.notLiked);
    await c.query(`DELETE FROM gallery_like WHERE id = $1`, [ex.id]);
    await c.query(`UPDATE gallery_post SET "likedCount" = "likedCount" - 1 WHERE id = $1`, [post.id]);
    return noContent();
  });
};

// (the endpoint's 30-minute cache; likes do not invalidate it, as upstream)
let rankingCache: { at: number; ids: string[] } | null = null;
export function resetGalleryRankingCacheForTest(): void {
  rankingCache = null;
}

/** FeaturedService.getGalleryPostsRanking(100) over the current + previous 3-day windows. */
export async function galleryRanking(c: PgQueryable, now = Date.now()): Promise<string[]> {
  if (rankingCache && now - rankingCache.at < 30 * 60_000) return rankingCache.ids;
  const w = GALLERY_POSTS_RANKING_WINDOW;
  const prevStart = (Math.floor(now / w) - 1) * w;
  const r = await c.query(
    `SELECT l."postId", count(*)::int AS score
     FROM gallery_like l JOIN gallery_post p ON p.id = l."postId"
     WHERE l.id >= $1 AND p.id >= $2
     GROUP BY l."postId" ORDER BY score DESC, l."postId" DESC LIMIT 100`,
    [genAidxFromDate(new Date(prevStart)).slice(0, 8), genAidxFromDate(new Date(prevStart - w)).slice(0, 8)],
  );
  const ids = r.rows.map((x) => String(x.postId));
  rankingCache = { at: now, ids };
  return ids;
}

const featured: Handler = async (env, body, ctx) => {
  const me = await optionalMe(env, body, ctx);
  if (me === "invalid") return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  const limit = limitOf(body);
  if (limit == null || (body.untilId !== undefined && typeof body.untilId !== "string")) return bad();
  return withHyperdriveClient(hd(env), async (c) => {
    let ids = [...(await galleryRanking(c))].sort((a, b) => (a > b ? -1 : 1));
    if (typeof body.untilId === "string") ids = ids.filter((id) => id < (body.untilId as string));
    ids = ids.slice(0, limit);
    if (!ids.length) return [];
    const posts = (await c.query(`SELECT * FROM gallery_post WHERE id = ANY($1::varchar[]) ORDER BY id DESC`, [ids])).rows;
    return packPosts(env, c, posts, me);
  });
};

const popular: Handler = async (env, body, ctx) => {
  const me = await optionalMe(env, body, ctx);
  if (me === "invalid") return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  return withHyperdriveClient(hd(env), async (c) =>
    packPosts(env, c, (await c.query(`SELECT * FROM gallery_post WHERE "likedCount" > 0 ORDER BY "likedCount" DESC LIMIT 10`)).rows, me),
  );
};

const posts: Handler = async (env, body, ctx) => {
  const me = await optionalMe(env, body, ctx);
  if (me === "invalid") return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  const limit = limitOf(body);
  if (limit == null) return bad();
  return withHyperdriveClient(hd(env), async (c) => packPosts(env, c, await listPosts(c, body, [], [], limit), me));
};

const iPosts: Handler = async (env, body, ctx) => {
  const me = await auth(env, body, ctx);
  if (!me) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  const limit = limitOf(body);
  if (limit == null) return bad();
  return withHyperdriveClient(hd(env), async (c) => packPosts(env, c, await listPosts(c, body, [`post."userId" = $1`], [me], limit), me));
};

const usersPosts: Handler = async (env, body, ctx) => {
  const me = await optionalMe(env, body, ctx);
  if (me === "invalid") return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  const limit = limitOf(body);
  if (limit == null || typeof body.userId !== "string") return bad();
  return withHyperdriveClient(hd(env), async (c) => packPosts(env, c, await listPosts(c, body, [`post."userId" = $1`], [body.userId], limit), me));
};

const iLikes: Handler = async (env, body, ctx) => {
  const me = await auth(env, body, ctx);
  if (!me) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  const limit = limitOf(body);
  if (limit == null) return bad();
  return withHyperdriveClient(hd(env), async (c) => {
    const params: unknown[] = [me];
    const p = pagination(body, params, "l.id");
    params.push(limit);
    const likes = (await c.query(
      `SELECT l.id AS "likeId", l."postId" FROM gallery_like l WHERE ${[`l."userId" = $1`, ...p.where].join(" AND ")} ORDER BY l.id ${p.order} LIMIT $${params.length}`,
      params,
    )).rows;
    const rows = likes.length ? (await c.query(`SELECT * FROM gallery_post WHERE id = ANY($1::varchar[])`, [likes.map((l) => l.postId)])).rows : [];
    const packed = new Map((await packPosts(env, c, rows, me)).map((x) => [String(x.id), x]));
    return likes.filter((l) => packed.has(String(l.postId))).map((l) => ({ id: l.likeId, post: packed.get(String(l.postId)) }));
  });
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
  "gallery/posts": posts,
  "gallery/featured": featured,
  "gallery/popular": popular,
  "gallery/posts/create": create,
  "gallery/posts/update": update,
  "gallery/posts/delete": del,
  "gallery/posts/show": show,
  "gallery/posts/like": like,
  "gallery/posts/unlike": unlike,
  "i/gallery/posts": iPosts,
  "i/gallery/likes": iLikes,
  "users/gallery/posts": usersPosts,
};

export const galleryHandlers: Record<string, Handler> = Object.fromEntries(Object.entries(RAW).map(([k, h]) => [k, pgOnly(h)]));

