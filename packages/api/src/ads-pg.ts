/**
 * Ads, promoted notes and avatar decorations on PG, following upstream:
 * admin/ad/create|update|delete|list (+ `ads` in packed meta), admin/promo/create, promo/read,
 * admin/avatar-decorations/create|update|delete|list.
 *
 * Upstream caches avatar decorations in memory and refreshes them through internal events; reads
 * here go to PG each time, so there is nothing to invalidate. Meta is cached for 60 s (KV), so ad
 * changes show up in `meta.ads` within that window.
 */

import { genAidx, parseAidxTime } from "../../id/src/index.js";
import type { PackAd } from "../../packers/src/index.js";
import type { ApiEnv } from "./env.js";
import { apiErrorResponse, CREDENTIAL_REQUIRED, INTERNAL_ERROR } from "./errors.js";
import { authenticatePg, extractToken } from "./auth-pg.js";
import { withHyperdriveClient, type PgQueryable } from "./pg.js";
import { hasRolePolicyPg, moderationLogPg } from "./policies-pg.js";
import { pagination } from "./client-endpoints-pg.js";
import { adminGate } from "./admin-gate.js";
import { ROLE_PERMISSION_DENIED } from "./emojis-pg.js";
import { clientError as err, errorResponse as fail, hd, invalidParam as bad } from "./handler-kit.js";

type Ctx = { hasCredential: boolean; request: Request };
type Body = Record<string, unknown>;
type Handler = (env: ApiEnv, body: Body, ctx: Ctx) => Promise<Response | unknown>;
type Row = Record<string, unknown>;

const E = {
  updateNoSuchAd: err("NO_SUCH_AD", "b7aa1727-1354-47bc-a182-3a9c3973d300", "No such ad."),
  deleteNoSuchAd: err("NO_SUCH_AD", "ccac9863-3a03-416e-b899-8a64041118b1", "No such ad."),
  promoNoSuchNote: err("NO_SUCH_NOTE", "ee449fbe-af2a-453b-9cae-cf2fe7c895fc", "No such note."),
  alreadyPromoted: err("ALREADY_PROMOTED", "ae427aa2-7a41-484f-a18c-2c1104051604", "The note has already promoted."),
  readNoSuchNote: err("NO_SUCH_NOTE", "d785b897-fcd3-4fe9-8fc3-b85c26e6c932", "No such note."),
};

const noContent = () => new Response(null, { status: 204 });
const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);
const toDate = (v: unknown) => (v instanceof Date ? v : new Date(String(v)));
const iso = (v: unknown) => (v == null ? null : toDate(v).toISOString());

async function authId(env: ApiEnv, body: Body, ctx: Ctx): Promise<string | null> {
  if (!ctx.hasCredential) return null;
  const token = extractToken(ctx.request, body);
  return token ? ((await authenticatePg(env, token))?.user.id ?? null) : null;
}

/** Moderator gate; the caller id (null when the admin surface is open in dev). */
function moderator(h: (env: ApiEnv, body: Body, ctx: Ctx, me: string | null) => Promise<Response | unknown>): Handler {
  return async (env, body, ctx) => {
    const denied = await adminGate(ctx.request, env as never, body, "moderator");
    if (denied) return denied;
    const token = extractToken(ctx.request, body);
    return h(env, body, ctx, token ? ((await authenticatePg(env, token))?.user.id ?? null) : null);
  };
}

const log = (c: PgQueryable, me: string | null, type: string, info: Record<string, unknown>) =>
  me ? moderationLogPg(c, me, type, info, genAidx(Date.now())) : Promise.resolve();

// ---------------------------------------------------------------- ads

function rawAd(r: Row) {
  return {
    id: String(r.id), expiresAt: iso(r.expiresAt), startsAt: iso(r.startsAt), place: r.place, priority: r.priority, ratio: Number(r.ratio),
    url: r.url, imageUrl: r.imageUrl, memo: r.memo, dayOfWeek: Number(r.dayOfWeek), isSensitive: Boolean(r.isSensitive),
  };
}

const packAd = (r: Row) => {
  const a = rawAd(r);
  return {
    id: a.id, expiresAt: a.expiresAt, startsAt: a.startsAt, dayOfWeek: a.dayOfWeek, isSensitive: a.isSensitive, url: a.url,
    imageUrl: a.imageUrl, priority: a.priority, ratio: a.ratio, place: a.place, memo: a.memo,
  };
};

const AD_STR = ["url", "memo", "place", "priority", "imageUrl"] as const;
const AD_INT = ["ratio", "expiresAt", "startsAt", "dayOfWeek"] as const;

/** paramDef check: strings / integers / isSensitive (url and imageUrl minLength 1). */
function adParamsOk(body: Body, required: boolean): boolean {
  for (const k of AD_STR) {
    if (body[k] === undefined) {
      if (required) return false;
      continue;
    }
    if (typeof body[k] !== "string") return false;
    if ((k === "url" || k === "imageUrl") && (body[k] as string).length < 1) return false;
  }
  for (const k of AD_INT) {
    if (body[k] === undefined) {
      if (required) return false;
      continue;
    }
    if (!isInt(body[k])) return false;
  }
  return body.isSensitive === undefined || typeof body.isSensitive === "boolean";
}

const adCreate = moderator(async (env, body, _ctx, me) => {
  if (!adParamsOk(body, true)) return bad();
  return withHyperdriveClient(hd(env), async (c) => {
    const id = genAidx(Date.now());
    await c.query(
      `INSERT INTO ad (id, "expiresAt", "startsAt", "dayOfWeek", "isSensitive", url, "imageUrl", priority, ratio, place, memo)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [id, new Date(body.expiresAt as number).toISOString(), new Date(body.startsAt as number).toISOString(), body.dayOfWeek, body.isSensitive ?? false,
        body.url, body.imageUrl, body.priority, body.ratio, body.place, body.memo],
    );
    const row = (await c.query(`SELECT * FROM ad WHERE id = $1`, [id])).rows[0]!;
    await log(c, me, "createAd", { adId: id, ad: rawAd(row) });
    return packAd(row);
  });
});

const adUpdate = moderator(async (env, body, _ctx, me) => {
  if (typeof body.id !== "string" || !adParamsOk(body, false)) return bad();
  return withHyperdriveClient(hd(env), async (c) => {
    const before = (await c.query(`SELECT * FROM ad WHERE id = $1`, [body.id])).rows[0];
    if (!before) return fail(E.updateNoSuchAd);
    const set: [string, unknown][] = [];
    for (const k of ["url", "place", "priority", "ratio", "memo", "imageUrl", "dayOfWeek", "isSensitive"]) if (body[k] !== undefined) set.push([k, body[k]]);
    // upstream: `ps.expiresAt ? new Date(...) : undefined` (0 leaves it alone)
    for (const k of ["expiresAt", "startsAt"]) if (body[k]) set.push([k, new Date(body[k] as number).toISOString()]);
    if (set.length) await c.query(`UPDATE ad SET ${set.map(([k], i) => `"${k}" = $${i + 2}`).join(", ")} WHERE id = $1`, [before.id, ...set.map(([, v]) => v)]);
    const after = (await c.query(`SELECT * FROM ad WHERE id = $1`, [before.id])).rows[0]!;
    await log(c, me, "updateAd", { adId: String(before.id), before: rawAd(before), after: rawAd(after) });
    return noContent();
  });
});

const adDelete = moderator(async (env, body, _ctx, me) => {
  if (typeof body.id !== "string") return bad();
  return withHyperdriveClient(hd(env), async (c) => {
    const ad = (await c.query(`SELECT * FROM ad WHERE id = $1`, [body.id])).rows[0];
    if (!ad) return fail(E.deleteNoSuchAd);
    await c.query(`DELETE FROM ad WHERE id = $1`, [ad.id]);
    await log(c, me, "deleteAd", { adId: String(ad.id), ad: rawAd(ad) });
    return noContent();
  });
});

const adList = moderator(async (env, body) => {
  const limit = body.limit === undefined ? 10 : body.limit;
  if (!isInt(limit) || limit < 1 || limit > 100) return bad();
  if (body.publishing !== undefined && body.publishing !== null && typeof body.publishing !== "boolean") return bad();
  return withHyperdriveClient(hd(env), async (c) => {
    const params: unknown[] = [];
    const p = pagination(body, params, "ad.id");
    const where = [...p.where];
    if (body.publishing === true) where.push(`ad."expiresAt" > now() AND ad."startsAt" <= now()`);
    // upstream: `.andWhere(expiresAt <= now).orWhere(startsAt > now)` — the OR escapes the pagination
    const cond = body.publishing === false
      ? `(${[...where, `ad."expiresAt" <= now()`].join(" AND ")}) OR ad."startsAt" > now()`
      : where.join(" AND ");
    params.push(limit);
    const rows = (await c.query(`SELECT ad.* FROM ad ${cond ? `WHERE ${cond}` : ""} ORDER BY ad.id ${p.order} LIMIT $${params.length}`, params)).rows;
    return rows.map(packAd);
  });
});

/** MetaEntityService.pack: ads running now, on today's weekday (bit `1 << getDay()`, 0 = every day). */
export async function activeAdsPg(env: ApiEnv): Promise<PackAd[]> {
  if (!env.HYPERDRIVE?.connectionString) return [];
  try {
    return await withHyperdriveClient(env.HYPERDRIVE, async (c) => {
      const rows = (await c.query(
        `SELECT * FROM ad WHERE "expiresAt" > now() AND "startsAt" <= now() AND ("dayOfWeek" & $1 > 0 OR "dayOfWeek" = 0)`,
        [1 << new Date().getDay()],
      )).rows;
      return rows.map((r) => ({
        id: String(r.id), url: String(r.url), place: String(r.place), ratio: Number(r.ratio), imageUrl: String(r.imageUrl),
        dayOfWeek: Number(r.dayOfWeek), isSensitive: Boolean(r.isSensitive),
      })) as PackAd[];
    });
  } catch {
    return []; // no `ad` table / PG trouble: meta must still answer
  }
}

// ---------------------------------------------------------------- promo

const promoCreate = moderator(async (env, body) => {
  if (typeof body.noteId !== "string" || !isInt(body.expiresAt)) return bad();
  return withHyperdriveClient(hd(env), async (c) => {
    const note = (await c.query(`SELECT id, "userId" FROM note WHERE id = $1`, [body.noteId])).rows[0];
    if (!note) return fail(E.promoNoSuchNote);
    if ((await c.query(`SELECT 1 AS ok FROM promo_note WHERE "noteId" = $1`, [note.id])).rows.length) return fail(E.alreadyPromoted);
    await c.query(`INSERT INTO promo_note ("noteId", "expiresAt", "userId") VALUES ($1, $2, $3)`, [note.id, new Date(body.expiresAt as number).toISOString(), note.userId]);
    return noContent();
  });
});

const promoRead: Handler = async (env, body, ctx) => {
  const me = await authId(env, body, ctx);
  if (!me) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  if (typeof body.noteId !== "string") return bad();
  return withHyperdriveClient(hd(env), async (c) => {
    const note = (await c.query(`SELECT id FROM note WHERE id = $1`, [body.noteId])).rows[0];
    if (!note) return fail(E.readNoSuchNote);
    if (!(await c.query(`SELECT 1 AS ok FROM promo_read WHERE "noteId" = $1 AND "userId" = $2`, [note.id, me])).rows.length) {
      await c.query(`INSERT INTO promo_read (id, "noteId", "userId") VALUES ($1, $2, $3)`, [genAidx(Date.now()), note.id, me]);
    }
    return noContent();
  });
};

// ---------------------------------------------------------------- avatar decorations

/** requireCredential + requiredRolePolicy 'canManageAvatarDecorations' */
function decorationManager(h: (env: ApiEnv, body: Body, c: PgQueryable, me: string) => Promise<Response | unknown>): Handler {
  return async (env, body, ctx) => {
    const me = await authId(env, body, ctx);
    if (!me) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
    return withHyperdriveClient(hd(env), async (c) => {
      if (!(await hasRolePolicyPg(env, c, me, "canManageAvatarDecorations"))) return apiErrorResponse(ROLE_PERMISSION_DENIED, 403);
      return h(env, body, c, me);
    });
  };
}

/** Row → AvatarDecoration (via to_jsonb: `category` is a newer column). */
export function packDecoration(j: Row) {
  return {
    id: String(j.id),
    createdAt: (parseAidxTime(String(j.id)) ?? new Date(0)).toISOString(),
    updatedAt: iso(j.updatedAt),
    name: j.name,
    description: j.description,
    url: j.url,
    roleIdsThatCanBeUsedThisDecoration: (j.roleIdsThatCanBeUsedThisDecoration as string[] | null) ?? [],
    category: (j.category as string | null | undefined) ?? null,
  };
}

const getDecoration = async (c: PgQueryable, id: string): Promise<Row | null> =>
  ((await c.query(`SELECT to_jsonb(d) AS j FROM avatar_decoration d WHERE id = $1`, [id])).rows[0]?.j as Row | undefined) ?? null;

function decorationParamsOk(body: Body, required: boolean): boolean {
  for (const k of ["name", "url"]) {
    if (body[k] === undefined ? required : typeof body[k] !== "string" || (body[k] as string).length < 1) return false;
  }
  if (body.description === undefined ? required : typeof body.description !== "string") return false;
  const roles = body.roleIdsThatCanBeUsedThisDecoration;
  if (roles !== undefined && !(Array.isArray(roles) && roles.every((x) => typeof x === "string"))) return false;
  return body.category === undefined || body.category === null || typeof body.category === "string";
}

const decorationCreate = decorationManager(async (_env, body, c, me) => {
  if (!decorationParamsOk(body, true)) return bad();
  const id = genAidx(Date.now());
  const cols: [string, unknown][] = [["id", id], ["name", body.name], ["description", body.description], ["url", body.url]];
  if (body.roleIdsThatCanBeUsedThisDecoration !== undefined) cols.push(["roleIdsThatCanBeUsedThisDecoration", body.roleIdsThatCanBeUsedThisDecoration]);
  if (body.category !== undefined) cols.push(["category", body.category]);
  await c.query(`INSERT INTO avatar_decoration (${cols.map(([k]) => `"${k}"`).join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")})`, cols.map(([, v]) => v));
  const created = (await getDecoration(c, id))!;
  await log(c, me, "createAvatarDecoration", { avatarDecorationId: id, avatarDecoration: created });
  return { ...packDecoration(created), updatedAt: null };
});

const decorationUpdate = decorationManager(async (_env, body, c, me) => {
  if (typeof body.id !== "string" || !decorationParamsOk(body, false)) return bad();
  const before = await getDecoration(c, body.id);
  if (!before) return apiErrorResponse(INTERNAL_ERROR, 500); // findOneByOrFail
  const set: [string, unknown][] = [["updatedAt", new Date().toISOString()]];
  for (const k of ["name", "description", "url", "roleIdsThatCanBeUsedThisDecoration", "category"]) if (body[k] !== undefined) set.push([k, body[k]]);
  await c.query(`UPDATE avatar_decoration SET ${set.map(([k], i) => `"${k}" = $${i + 2}`).join(", ")} WHERE id = $1`, [body.id, ...set.map(([, v]) => v)]);
  await log(c, me, "updateAvatarDecoration", { avatarDecorationId: body.id, before, after: await getDecoration(c, body.id) });
  return noContent();
});

const decorationDelete = decorationManager(async (_env, body, c, me) => {
  if (typeof body.id !== "string") return bad();
  const d = await getDecoration(c, body.id);
  if (!d) return apiErrorResponse(INTERNAL_ERROR, 500); // findOneByOrFail
  await c.query(`DELETE FROM avatar_decoration WHERE id = $1`, [body.id]);
  await log(c, me, "deleteAvatarDecoration", { avatarDecorationId: body.id, avatarDecoration: d });
  return noContent();
});

/** upstream ignores the paging params and returns every decoration (getAll). */
const decorationList = decorationManager(async (_env, body, c) => {
  const limit = body.limit === undefined ? 10 : body.limit;
  if (!isInt(limit) || limit < 1 || limit > 100) return bad();
  const rows = (await c.query(`SELECT to_jsonb(d) AS j FROM avatar_decoration d ORDER BY id DESC`)).rows;
  return rows.map((r) => packDecoration(r.j as Row));
});

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
  "admin/ad/create": adCreate,
  "admin/ad/update": adUpdate,
  "admin/ad/delete": adDelete,
  "admin/ad/list": adList,
  "admin/promo/create": promoCreate,
  "promo/read": promoRead,
  "admin/avatar-decorations/create": decorationCreate,
  "admin/avatar-decorations/update": decorationUpdate,
  "admin/avatar-decorations/delete": decorationDelete,
  "admin/avatar-decorations/list": decorationList,
};

export const adHandlers: Record<string, Handler> = Object.fromEntries(Object.entries(RAW).map(([k, h]) => [k, pgOnly(h)]));

