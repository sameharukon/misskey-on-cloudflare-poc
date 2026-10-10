/**
 * Flash / Play (W7.12) on PG `flash` / `flash_like` (upstream schema): flash/create|update|delete|
 * show|like|unlike|featured|my|my-likes|search. Follows the upstream endpoints, FlashService
 * (featured order, ILIKE search per word on title / summary) and FlashEntityService.
 */

import { genAidx, parseAidxTime } from "../../id/src/index.js";
import type { ApiEnv } from "./env.js";
import { apiErrorResponse, CREDENTIAL_REQUIRED } from "./errors.js";
import { withHyperdriveClient, type PgQueryable } from "./pg.js";
import { isModeratorPg, moderationLogPg } from "./policies-pg.js";
import { packUsers, pagination } from "./client-endpoints-pg.js";
import { authUserId as auth, clientError as err, errorResponse as fail, hd, invalidParam as bad, optionalUserId as optionalMe } from "./handler-kit.js";

type Ctx = { hasCredential: boolean; request: Request };
type Body = Record<string, unknown>;
type Handler = (env: ApiEnv, body: Body, ctx: Ctx) => Promise<Response | unknown>;
type Row = Record<string, unknown>;

const noSuch = (id: string) => err("NO_SUCH_FLASH", id, "No such flash.");
const E = {
  updateNoSuch: noSuch("611e13d2-309e-419a-a5e4-e0422da39b02"),
  updateDenied: err("ACCESS_DENIED", "08e60c88-5948-478e-a132-02ec701d67b2", "Access denied."),
  deleteNoSuch: noSuch("de1623ef-bbb3-4289-a71e-14cfa83d9740"),
  deleteDenied: err("ACCESS_DENIED", "1036ad7b-9f92-4fff-89c3-0e50dc941704", "Access denied."),
  showNoSuch: noSuch("f0d34a1a-d29a-401d-90ba-1982122b5630"),
  likeNoSuch: noSuch("c07c1491-9161-4c5c-9d75-01906f911f73"),
  yourFlash: err("YOUR_FLASH", "3fd8a0e7-5955-4ba9-85bb-bf3e0c30e13b", "You cannot like your flash."),
  alreadyLiked: err("ALREADY_LIKED", "010065cf-ad43-40df-8067-abff9f4686e3", "The flash has already been liked."),
  unlikeNoSuch: noSuch("afe8424a-a69e-432d-a5f2-2f0740c62410"),
  notLiked: err("NOT_LIKED", "755f25a7-9871-4f65-9f34-51eaad9ae0ac", "You have not liked that flash."),
};

const noContent = () => new Response(null, { status: 204 });
const sqlLikeEscape = (s: string) => s.replace(/([\\%_])/g, "\\$1");
const isStrArr = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === "string");
const VIS = ["public", "private"];

/** FlashEntityService.pack (isLiked only for a caller). */
export async function packFlashes(env: ApiEnv, c: PgQueryable, rows: Row[], me: string | null): Promise<Record<string, unknown>[]> {
  if (!rows.length) return [];
  const users = new Map(((await packUsers(env, [...new Set(rows.map((r) => String(r.userId)))], me, false)) as { id: string }[]).map((u) => [u.id, u]));
  const liked = me
    ? new Set((await c.query(`SELECT "flashId" FROM flash_like WHERE "userId" = $1 AND "flashId" = ANY($2::varchar[])`, [me, rows.map((r) => r.id)])).rows.map((r) => String(r.flashId)))
    : null;
  return rows.map((f) => ({
    id: f.id,
    createdAt: (parseAidxTime(String(f.id)) ?? new Date(0)).toISOString(),
    updatedAt: new Date(String(f.updatedAt)).toISOString(),
    userId: f.userId,
    user: users.get(String(f.userId)) ?? null,
    title: f.title,
    summary: f.summary,
    script: f.script,
    visibility: f.visibility,
    likedCount: Number(f.likedCount ?? 0),
    ...(liked ? { isLiked: liked.has(String(f.id)) } : {}),
  }));
}

const limitOf = (body: Body, def = 10): number | null => {
  const l = body.limit === undefined ? def : body.limit;
  return Number.isInteger(l) && (l as number) >= 1 && (l as number) <= 100 ? (l as number) : null;
};

/** `(title ILIKE w OR summary ILIKE w)` for each space-separated word. */
function wordFilters(q: string, params: unknown[], a: string): string[] {
  return q.trim().split(" ").map((w) => {
    params.push(`%${sqlLikeEscape(w)}%`);
    return `(${a}.title ILIKE $${params.length} OR ${a}.summary ILIKE $${params.length})`;
  });
}

// ---------------------------------------------------------------- endpoints

const create: Handler = async (env, body, ctx) => {
  const me = await auth(env, body, ctx);
  if (!me) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  if (typeof body.title !== "string" || typeof body.summary !== "string" || typeof body.script !== "string" || !isStrArr(body.permissions)) return bad();
  if (body.visibility !== undefined && !VIS.includes(body.visibility as string)) return bad();
  return withHyperdriveClient(hd(env), async (c) => {
    const id = genAidx(Date.now());
    await c.query(`INSERT INTO flash (id, "userId", "updatedAt", title, summary, script, permissions, visibility) VALUES ($1, $2, now(), $3, $4, $5, $6::varchar[], $7)`, [
      id, me, body.title, body.summary, body.script, body.permissions, (body.visibility as string | undefined) ?? "public",
    ]);
    const row = (await c.query(`SELECT * FROM flash WHERE id = $1`, [id])).rows[0]!;
    return (await packFlashes(env, c, [row], null))[0]; // upstream packs without a viewer
  });
};

const update: Handler = async (env, body, ctx) => {
  const me = await auth(env, body, ctx);
  if (!me) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  if (typeof body.flashId !== "string") return bad();
  for (const k of ["title", "summary", "script"]) if (body[k] !== undefined && typeof body[k] !== "string") return bad();
  if (body.permissions !== undefined && !isStrArr(body.permissions)) return bad();
  if (body.visibility !== undefined && !VIS.includes(body.visibility as string)) return bad();
  return withHyperdriveClient(hd(env), async (c) => {
    const f = (await c.query(`SELECT id, "userId" FROM flash WHERE id = $1`, [body.flashId])).rows[0];
    if (!f) return fail(E.updateNoSuch);
    if (f.userId !== me) return fail(E.updateDenied);
    const sets = [`"updatedAt" = now()`];
    const params: unknown[] = [f.id];
    for (const k of ["title", "summary", "script", "visibility"]) if (body[k] !== undefined) sets.push(`"${k}" = $${params.push(body[k])}`);
    if (body.permissions !== undefined) sets.push(`permissions = $${params.push(body.permissions)}::varchar[]`);
    await c.query(`UPDATE flash SET ${sets.join(", ")} WHERE id = $1`, params);
    return noContent();
  });
};

const del: Handler = async (env, body, ctx) => {
  const me = await auth(env, body, ctx);
  if (!me) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  if (typeof body.flashId !== "string") return bad();
  return withHyperdriveClient(hd(env), async (c) => {
    const f = (await c.query(`SELECT * FROM flash WHERE id = $1`, [body.flashId])).rows[0];
    if (!f) return fail(E.deleteNoSuch);
    if (f.userId !== me && !(await isModeratorPg(env, c, me))) return fail(E.deleteDenied);
    await c.query(`DELETE FROM flash_like WHERE "flashId" = $1`, [f.id]);
    await c.query(`DELETE FROM flash WHERE id = $1`, [f.id]);
    if (f.userId !== me) {
      const owner = (await c.query(`SELECT username FROM "user" WHERE id = $1`, [f.userId])).rows[0];
      await moderationLogPg(c, me, "deleteFlash", { flashId: f.id, flashUserId: f.userId, flashUserUsername: owner?.username ?? null, flash: f }, genAidx(Date.now()));
    }
    return noContent();
  });
};

const show: Handler = async (env, body, ctx) => {
  const me = await optionalMe(env, body, ctx);
  if (me === "invalid") return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  if (typeof body.flashId !== "string") return bad();
  return withHyperdriveClient(hd(env), async (c) => {
    const f = (await c.query(`SELECT * FROM flash WHERE id = $1`, [body.flashId])).rows[0];
    return f ? (await packFlashes(env, c, [f], me))[0] : fail(E.showNoSuch);
  });
};

const like: Handler = async (env, body, ctx) => {
  const me = await auth(env, body, ctx);
  if (!me) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  if (typeof body.flashId !== "string") return bad();
  return withHyperdriveClient(hd(env), async (c) => {
    const f = (await c.query(`SELECT id, "userId" FROM flash WHERE id = $1`, [body.flashId])).rows[0];
    if (!f) return fail(E.likeNoSuch);
    if (f.userId === me) return fail(E.yourFlash);
    if ((await c.query(`SELECT 1 AS ok FROM flash_like WHERE "flashId" = $1 AND "userId" = $2`, [f.id, me])).rows.length) return fail(E.alreadyLiked);
    await c.query(`INSERT INTO flash_like (id, "userId", "flashId") VALUES ($1, $2, $3)`, [genAidx(Date.now()), me, f.id]);
    await c.query(`UPDATE flash SET "likedCount" = "likedCount" + 1 WHERE id = $1`, [f.id]);
    return noContent();
  });
};

const unlike: Handler = async (env, body, ctx) => {
  const me = await auth(env, body, ctx);
  if (!me) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  if (typeof body.flashId !== "string") return bad();
  return withHyperdriveClient(hd(env), async (c) => {
    const f = (await c.query(`SELECT id FROM flash WHERE id = $1`, [body.flashId])).rows[0];
    if (!f) return fail(E.unlikeNoSuch);
    const ex = (await c.query(`SELECT id FROM flash_like WHERE "flashId" = $1 AND "userId" = $2`, [f.id, me])).rows[0];
    if (!ex) return fail(E.notLiked);
    await c.query(`DELETE FROM flash_like WHERE id = $1`, [ex.id]);
    await c.query(`UPDATE flash SET "likedCount" = "likedCount" - 1 WHERE id = $1`, [f.id]);
    return noContent();
  });
};

const featured: Handler = async (env, body, ctx) => {
  const me = await optionalMe(env, body, ctx);
  if (me === "invalid") return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  const limit = limitOf(body);
  const offset = body.offset === undefined ? 0 : body.offset;
  if (limit == null || !Number.isInteger(offset) || (offset as number) < 0) return bad();
  return withHyperdriveClient(hd(env), async (c) =>
    packFlashes(env, c, (await c.query(
      `SELECT * FROM flash WHERE "likedCount" > 0 AND visibility = 'public' ORDER BY "likedCount" DESC, "updatedAt" DESC, id DESC LIMIT $1 OFFSET $2`,
      [limit, offset],
    )).rows, me),
  );
};

const my: Handler = async (env, body, ctx) => {
  const me = await auth(env, body, ctx);
  if (!me) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  const limit = limitOf(body);
  if (limit == null) return bad();
  return withHyperdriveClient(hd(env), async (c) => {
    const params: unknown[] = [me];
    const p = pagination(body, params, "flash.id");
    params.push(limit);
    const rows = (await c.query(
      `SELECT flash.* FROM flash WHERE ${[`flash."userId" = $1`, ...p.where].join(" AND ")} ORDER BY flash.id ${p.order} LIMIT $${params.length}`,
      params,
    )).rows;
    return packFlashes(env, c, rows, null); // upstream packs without a viewer
  });
};

const myLikes: Handler = async (env, body, ctx) => {
  const me = await auth(env, body, ctx);
  if (!me) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  const limit = limitOf(body);
  if (limit == null) return bad();
  if (body.search !== undefined && body.search !== null && (typeof body.search !== "string" || body.search.length < 1 || body.search.length > 100)) return bad();
  return withHyperdriveClient(hd(env), async (c) => {
    const params: unknown[] = [me];
    const p = pagination(body, params, "l.id");
    const where = [`l."userId" = $1`, ...p.where, ...(typeof body.search === "string" ? wordFilters(body.search, params, "flash") : [])];
    params.push(limit);
    const likes = (await c.query(
      `SELECT l.id AS "likeId", flash.* FROM flash_like l JOIN flash ON flash.id = l."flashId"
       WHERE ${where.join(" AND ")} ORDER BY l.id ${p.order} LIMIT $${params.length}`,
      params,
    )).rows;
    const packed = await packFlashes(env, c, likes, me);
    return likes.map((l, i) => ({ id: l.likeId, flash: packed[i] }));
  });
};

const search: Handler = async (env, body, ctx) => {
  const me = await optionalMe(env, body, ctx);
  if (me === "invalid") return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  const limit = limitOf(body, 5);
  if (limit == null || typeof body.query !== "string" || body.query.length < 1 || body.query.length > 100) return bad();
  return withHyperdriveClient(hd(env), async (c) => {
    const params: unknown[] = [];
    const p = pagination(body, params, "flash.id");
    const where = [`flash.visibility = 'public'`, ...p.where, ...wordFilters(body.query as string, params, "flash")];
    params.push(limit);
    const rows = (await c.query(
      `SELECT flash.* FROM flash WHERE ${where.join(" AND ")} ORDER BY flash.id ${p.order} LIMIT $${params.length}`,
      params,
    )).rows;
    return packFlashes(env, c, rows, me);
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
  "flash/create": create,
  "flash/update": update,
  "flash/delete": del,
  "flash/show": show,
  "flash/like": like,
  "flash/unlike": unlike,
  "flash/featured": featured,
  "flash/my": my,
  "flash/my-likes": myLikes,
  "flash/search": search,
};

export const flashHandlers: Record<string, Handler> = Object.fromEntries(Object.entries(RAW).map(([k, h]) => [k, pgOnly(h)]));

