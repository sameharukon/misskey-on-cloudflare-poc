/**
 * Custom emoji (W7.5) on PG `emoji` (upstream schema). Images are Drive files
 * (R2 `MEDIA_BUCKET`, served from /files/…); the emoji row stores their URLs
 * like upstream CustomEmojiService.add.
 *
 * - admin/emoji/add|update|delete|delete-bulk|list|list-remote|
 *   set-aliases-bulk|add-aliases-bulk|remove-aliases-bulk|set-category-bulk|set-license-bulk
 * - `emojis` / `emoji` read PG (KV `emojis:simple` read-through, invalidated on every write)
 * - broadcast stream emojiAdded / emojiUpdated / emojiDeleted, moderation_log rows
 * - custom-emoji reactions resolved like upstream ReactionService.create
 */

import { emojiRegex as twemojiRegex } from "@misskey-dev/emoji-data/regex";
import { genAidx } from "../../id/src/index.js";
import type { ApiEnv } from "./env.js";
import { apiErrorResponse, CREDENTIAL_REQUIRED, type ApiErrorBody } from "./errors.js";
import { authenticatePg, extractToken } from "./auth-pg.js";
import { withHyperdriveClient, type PgQueryable } from "./pg.js";
import { pagination } from "./client-endpoints-pg.js";
import { userRoleIdsPg, hasRolePolicyPg, moderationLogPg } from "./policies-pg.js";
import { CACHE_KEYS } from "./cache.js";
import { resolveCacheStore } from "./cache-resolve.js";
import { broadcastStream } from "./stream-publish.js";
import { packEmojiDetailed, type BootstrapEmoji, type PackedEmojiDetailed } from "./emoji-store.js";
import { likeEscape } from "./clips-pg.js";
import { clientError as err, errorResponse as fail, invalidParam as bad } from "./handler-kit.js";
import { metaRowPg } from "./user-lite-pg.js";

type Ctx = { hasCredential: boolean; request: Request; waitUntil?: (p: Promise<unknown>) => void };
type Body = Record<string, unknown>;
export type EmojiHandler = (env: ApiEnv, body: Body, ctx: Ctx) => Promise<Response | unknown>;

export const ROLE_PERMISSION_DENIED: ApiErrorBody = { message: "You are not assigned to a required role.", code: "ROLE_PERMISSION_DENIED", id: "7f86f06f-7e15-4057-8561-f4b6d4ac755a", kind: "permission" };
const E = {
  addNoSuchFile: err("NO_SUCH_FILE", "fc46b5a4-6b92-4c33-ac66-b806659bb5cf", "No such file."),
  unsupportedFileType: err("UNSUPPORTED_FILE_TYPE", "f7599d96-8750-af68-1633-9575d625c1a7", "Unsupported file type."),
  duplicateName: err("DUPLICATE_NAME", "f7a3462c-4e6e-4069-8421-b9bd4f4c3975", "Duplicate name."),
  updateNoSuchEmoji: err("NO_SUCH_EMOJI", "684dec9d-a8c2-4364-9aa8-456c49cb1dc8", "No such emoji."),
  updateNoSuchFile: err("NO_SUCH_FILE", "14fb9fd9-0731-4e2f-aeb9-f09e4740333d", "No such file."),
  sameNameEmojiExists: err("SAME_NAME_EMOJI_EXISTS", "7180fe9d-1ee3-bff9-647d-fe9896d2ffb8", "Emoji that have same name already exists."),
  deleteNoSuchEmoji: err("NO_SUCH_EMOJI", "be83669b-773a-44b7-b1f8-e5e5170ac3c2", "No such emoji."),
};

/** upstream const FILE_TYPE_IMAGE */
export const FILE_TYPE_IMAGE = ["image/png", "image/gif", "image/jpeg", "image/webp", "image/avif", "image/apng", "image/bmp", "image/tiff", "image/x-icon"];
const NAME_RE = /^[a-zA-Z0-9_]+$/;
const COLS = `id, name, host, aliases, category, "originalUrl", "publicUrl", type, license, "isSensitive", "localOnly", "roleIdsThatCanBeUsedThisEmojiAsReaction"`;

export function rowToEmoji(row: Record<string, unknown>): BootstrapEmoji {
  return {
    id: String(row.id),
    name: String(row.name),
    host: (row.host as string | null) ?? null,
    aliases: (row.aliases as string[] | null) ?? [],
    category: (row.category as string | null) ?? null,
    originalUrl: String(row.originalUrl ?? ""),
    publicUrl: String(row.publicUrl ?? ""),
    license: (row.license as string | null) ?? null,
    isSensitive: Boolean(row.isSensitive),
    localOnly: Boolean(row.localOnly),
    roleIdsThatCanBeUsedThisEmojiAsReaction: (row.roleIdsThatCanBeUsedThisEmojiAsReaction as string[] | null) ?? [],
  };
}

/** `emojis`: host IS NULL ordered by category, name (upstream order; NULL category last). */
export async function loadLocalEmojisPg(env: ApiEnv): Promise<BootstrapEmoji[]> {
  return withHyperdriveClient(env.HYPERDRIVE!, async (c) =>
    (await c.query(`SELECT ${COLS} FROM emoji WHERE host IS NULL ORDER BY category ASC, name ASC`)).rows.map(rowToEmoji),
  );
}

export async function getLocalEmojiPg(c: PgQueryable, name: string): Promise<BootstrapEmoji | null> {
  const row = (await c.query(`SELECT ${COLS} FROM emoji WHERE name = $1 AND host IS NULL LIMIT 1`, [name])).rows[0];
  return row ? rowToEmoji(row) : null;
}

/** Drop the KV `emojis` cache (upstream localEmojisCache.refresh). KV is eventually consistent across PoPs (≤60 s). */
export async function invalidateEmojiCache(env: ApiEnv): Promise<void> {
  const store = resolveCacheStore(env);
  try {
    await store?.delete?.(CACHE_KEYS.emojisSimple);
  } catch {
    /* best-effort */
  }
}

async function byIds(c: PgQueryable, ids: string[]): Promise<BootstrapEmoji[]> {
  if (!ids.length) return [];
  return (await c.query(`SELECT ${COLS} FROM emoji WHERE id = ANY($1::varchar[])`, [ids])).rows.map(rowToEmoji);
}

function later(ctx: Pick<Ctx, "waitUntil">, p: Promise<unknown>) {
  const safe = p.catch((e) => console.warn(`emoji broadcast failed: ${e instanceof Error ? e.message : String(e)}`));
  if (ctx.waitUntil) ctx.waitUntil(safe);
}

async function after(env: ApiEnv, ctx: Pick<Ctx, "waitUntil">, events: { type: string; body: unknown }[]) {
  await invalidateEmojiCache(env);
  later(ctx, (async () => { for (const e of events) await broadcastStream(env, e.type, e.body); })());
}

const strArr = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === "string");
const optStr = (v: unknown) => v === undefined || v === null || typeof v === "string";
const optBool = (v: unknown) => v === undefined || typeof v === "boolean";

/** requireCredential + requiredRolePolicy 'canManageCustomEmojis' */
export function gated(h: (env: ApiEnv, body: Body, ctx: Ctx, me: string, c: PgQueryable) => Promise<Response | unknown>): EmojiHandler {
  return async (env, body, ctx) => {
    if (!env.HYPERDRIVE?.connectionString) {
      return apiErrorResponse({ message: "Hyperdrive required.", code: "HYPERDRIVE_UNBOUND", id: "00000000-0000-4000-8000-0000000000b1", kind: "server" }, 501);
    }
    const token = ctx.hasCredential ? extractToken(ctx.request, body) : null;
    const a = token ? await authenticatePg(env, token) : null;
    if (!a) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
    const me = a.user.id;
    return withHyperdriveClient(env.HYPERDRIVE, async (c) => {
      if (!(await hasRolePolicyPg(env, c, me, "canManageCustomEmojis"))) return apiErrorResponse(ROLE_PERMISSION_DENIED, 403);
      return h(env, body, ctx, me, c);
    });
  };
}

const noContent = () => new Response(null, { status: 204 });

const add = gated(async (env, body, ctx, me, c) => {
  if (typeof body.name !== "string" || !NAME_RE.test(body.name) || typeof body.fileId !== "string") return bad();
  if (!optStr(body.category) || !optStr(body.license) || !optBool(body.isSensitive) || !optBool(body.localOnly)) return bad();
  if ((body.aliases !== undefined && !strArr(body.aliases)) || (body.roleIdsThatCanBeUsedThisEmojiAsReaction !== undefined && !strArr(body.roleIdsThatCanBeUsedThisEmojiAsReaction))) return bad();
  const file = (await c.query(`SELECT url, "webpublicUrl", type, "webpublicType" FROM drive_file WHERE id = $1`, [body.fileId])).rows[0];
  if (!file) return fail(E.addNoSuchFile);
  if (await getLocalEmojiPg(c, body.name)) return fail(E.duplicateName);
  if (!FILE_TYPE_IMAGE.includes(String(file.type))) return fail(E.unsupportedFileType);
  return addEmojiPg(env, c, {
    name: body.name, category: (body.category as string | null | undefined) ?? null, aliases: (body.aliases as string[] | undefined) ?? [],
    originalUrl: String(file.url), publicUrl: String(file.webpublicUrl ?? file.url), fileType: String(file.webpublicType ?? file.type),
    license: (body.license as string | null | undefined) ?? null, isSensitive: (body.isSensitive as boolean | undefined) ?? false,
    localOnly: (body.localOnly as boolean | undefined) ?? false, roleIdsThatCanBeUsedThisEmojiAsReaction: (body.roleIdsThatCanBeUsedThisEmojiAsReaction as string[] | undefined) ?? [],
  }, me, ctx.waitUntil);
});

export type AddEmojiData = {
  name: string; category: string | null; aliases: string[]; originalUrl: string; publicUrl: string; fileType: string;
  license: string | null; isSensitive: boolean; localOnly: boolean; roleIdsThatCanBeUsedThisEmojiAsReaction: string[];
};

/**
 * CustomEmojiService.add for a local emoji: insert, invalidate the cache, broadcast `emojiAdded`
 * (through `waitUntil` when given) and, with a moderator, log `addCustomEmoji`. Returns the packed emoji.
 */
export async function addEmojiPg(env: ApiEnv, c: PgQueryable, d: AddEmojiData, moderatorId: string | null, waitUntil?: (p: Promise<unknown>) => void): Promise<PackedEmojiDetailed> {
  const id = genAidx(Date.now());
  await c.query(
    `INSERT INTO emoji (id, "updatedAt", name, category, host, aliases, "originalUrl", "publicUrl", type, license, "isSensitive", "localOnly", "roleIdsThatCanBeUsedThisEmojiAsReaction")
     VALUES ($1, now(), $2, $3, NULL, $4::varchar[], $5, $6, $7, $8, $9, $10, $11::varchar[])`,
    [id, d.name, d.category, d.aliases, d.originalUrl, d.publicUrl, d.fileType, d.license, d.isSensitive, d.localOnly, d.roleIdsThatCanBeUsedThisEmojiAsReaction],
  );
  const emoji = (await byIds(c, [id]))[0]!;
  const packed = packEmojiDetailed(emoji);
  if (moderatorId) await moderationLogPg(c, moderatorId, "addCustomEmoji", { emojiId: id, emoji }, genAidx(Date.now()));
  await after(env, { waitUntil }, [{ type: "emojiAdded", body: { emoji: packed } }]);
  return packed;
}

const update = gated(async (env, body, ctx, me, c) => {
  const hasId = typeof body.id === "string";
  const hasName = typeof body.name === "string";
  if (!hasId && !hasName) return bad();
  if (hasName && !NAME_RE.test(body.name as string)) return bad();
  if (!optStr(body.category) || !optStr(body.license) || !optBool(body.isSensitive) || !optBool(body.localOnly)) return bad();
  if ((body.aliases !== undefined && !strArr(body.aliases)) || (body.roleIdsThatCanBeUsedThisEmojiAsReaction !== undefined && !strArr(body.roleIdsThatCanBeUsedThisEmojiAsReaction))) return bad();
  let file: Record<string, unknown> | undefined;
  if (typeof body.fileId === "string" && body.fileId) {
    file = (await c.query(`SELECT url, "webpublicUrl", type, "webpublicType" FROM drive_file WHERE id = $1`, [body.fileId])).rows[0];
    if (!file) return fail(E.updateNoSuchFile);
  }
  const before = hasId
    ? (await byIds(c, [body.id as string]))[0] ?? null
    : await getLocalEmojiPg(c, body.name as string);
  if (!before) return fail(E.updateNoSuchEmoji);
  const doNameUpdate = hasId && hasName && body.name !== before.name;
  if (doNameUpdate && (await getLocalEmojiPg(c, body.name as string))) return fail(E.sameNameEmojiExists);
  const sets = [`"updatedAt" = now()`];
  const params: unknown[] = [];
  const set = (col: string, v: unknown, cast = "") => { params.push(v); sets.push(`${col} = $${params.length}${cast}`); };
  if (hasName) set("name", body.name);
  if (body.category !== undefined) set("category", body.category);
  if (body.aliases !== undefined) set("aliases", body.aliases, "::varchar[]");
  if (body.license !== undefined) set("license", body.license);
  if (body.isSensitive !== undefined) set(`"isSensitive"`, body.isSensitive);
  if (body.localOnly !== undefined) set(`"localOnly"`, body.localOnly);
  if (file) {
    set(`"originalUrl"`, file.url);
    set(`"publicUrl"`, file.webpublicUrl ?? file.url);
    set("type", file.webpublicType ?? file.type);
  }
  if (body.roleIdsThatCanBeUsedThisEmojiAsReaction !== undefined) set(`"roleIdsThatCanBeUsedThisEmojiAsReaction"`, body.roleIdsThatCanBeUsedThisEmojiAsReaction, "::varchar[]");
  params.push(before.id);
  await c.query(`UPDATE emoji SET ${sets.join(", ")} WHERE id = $${params.length}`, params);
  const updated = (await byIds(c, [before.id]))[0]!;
  const packed = packEmojiDetailed(updated);
  await moderationLogPg(c, me, "updateCustomEmoji", { emojiId: before.id, before, after: updated }, genAidx(Date.now()));
  await after(env, ctx, doNameUpdate
    ? [{ type: "emojiDeleted", body: { emojis: [packEmojiDetailed(before)] } }, { type: "emojiAdded", body: { emoji: packed } }]
    : [{ type: "emojiUpdated", body: { emojis: [packed] } }]);
  return noContent();
});

const del = gated(async (env, body, ctx, me, c) => {
  if (typeof body.id !== "string") return bad();
  const emoji = (await byIds(c, [body.id]))[0];
  // upstream findOneByOrFail → EntityNotFound; we answer the declared NO_SUCH_EMOJI
  if (!emoji) return fail(E.deleteNoSuchEmoji);
  await c.query(`DELETE FROM emoji WHERE id = $1`, [emoji.id]);
  await moderationLogPg(c, me, "deleteCustomEmoji", { emojiId: emoji.id, emoji }, genAidx(Date.now()));
  await after(env, ctx, [{ type: "emojiDeleted", body: { emojis: [packEmojiDetailed(emoji)] } }]);
  return noContent();
});

const deleteBulk = gated(async (env, body, ctx, me, c) => {
  if (!strArr(body.ids)) return bad();
  const emojis = await byIds(c, body.ids as string[]);
  for (const e of emojis) {
    await c.query(`DELETE FROM emoji WHERE id = $1`, [e.id]);
    await moderationLogPg(c, me, "deleteCustomEmoji", { emojiId: e.id, emoji: e }, genAidx(Date.now()));
  }
  await after(env, ctx, [{ type: "emojiDeleted", body: { emojis: emojis.map(packEmojiDetailed) } }]);
  return noContent();
});

/** shared tail of the *-bulk endpoints: invalidate + emojiUpdated(packDetailedMany(ids)) */
async function bulkUpdated(env: ApiEnv, ctx: Ctx, c: PgQueryable, ids: string[]) {
  await after(env, ctx, [{ type: "emojiUpdated", body: { emojis: (await byIds(c, ids)).map(packEmojiDetailed) } }]);
  return noContent();
}

const setAliasesBulk = gated(async (env, body, ctx, _me, c) => {
  if (!strArr(body.ids) || !strArr(body.aliases)) return bad();
  await c.query(`UPDATE emoji SET "updatedAt" = now(), aliases = $1::varchar[] WHERE id = ANY($2::varchar[])`, [body.aliases, body.ids]);
  return bulkUpdated(env, ctx, c, body.ids as string[]);
});

const addAliasesBulk = gated(async (env, body, ctx, _me, c) => {
  if (!strArr(body.ids) || !strArr(body.aliases)) return bad();
  for (const e of await byIds(c, body.ids as string[])) {
    await c.query(`UPDATE emoji SET "updatedAt" = now(), aliases = $1::varchar[] WHERE id = $2`, [[...new Set([...(e.aliases ?? []), ...(body.aliases as string[])])], e.id]);
  }
  return bulkUpdated(env, ctx, c, body.ids as string[]);
});

const removeAliasesBulk = gated(async (env, body, ctx, _me, c) => {
  if (!strArr(body.ids) || !strArr(body.aliases)) return bad();
  const drop = new Set(body.aliases as string[]);
  for (const e of await byIds(c, body.ids as string[])) {
    await c.query(`UPDATE emoji SET "updatedAt" = now(), aliases = $1::varchar[] WHERE id = $2`, [(e.aliases ?? []).filter((x) => !drop.has(x)), e.id]);
  }
  return bulkUpdated(env, ctx, c, body.ids as string[]);
});

const setCategoryBulk = gated(async (env, body, ctx, _me, c) => {
  if (!strArr(body.ids) || !optStr(body.category)) return bad();
  await c.query(`UPDATE emoji SET "updatedAt" = now(), category = $1 WHERE id = ANY($2::varchar[])`, [body.category ?? null, body.ids]);
  return bulkUpdated(env, ctx, c, body.ids as string[]);
});

const setLicenseBulk = gated(async (env, body, ctx, _me, c) => {
  if (!strArr(body.ids) || !optStr(body.license)) return bad();
  await c.query(`UPDATE emoji SET "updatedAt" = now(), license = $1 WHERE id = ANY($2::varchar[])`, [body.license ?? null, body.ids]);
  return bulkUpdated(env, ctx, c, body.ids as string[]);
});

/** `limit: { type: 'integer', minimum: 1, maximum: 100, default: 10 }` (+ page params), checked by pageOk */
const limitOf = (body: Body) => (body.limit === undefined ? 10 : (body.limit as number));
const pageOk = (body: Body) =>
  (body.limit === undefined || (Number.isInteger(body.limit) && (body.limit as number) >= 1 && (body.limit as number) <= 100))
  && ["sinceId", "untilId"].every((k) => body[k] === undefined || typeof body[k] === "string")
  && ["sinceDate", "untilDate"].every((k) => body[k] === undefined || Number.isInteger(body[k]));

const list = gated(async (_env, body, _ctx, _me, c) => {
  if (!optStr(body.query) || !pageOk(body)) return bad();
  const params: unknown[] = [];
  const pg = pagination(body, params, "e.id");
  const where = ["e.host IS NULL", ...pg.where].join(" AND ");
  const q = typeof body.query === "string" && body.query ? body.query : null;
  const limit = limitOf(body);
  if (!q) {
    params.push(limit);
    return (await c.query(`SELECT ${COLS.split(", ").map((x) => `e.${x}`).join(", ")} FROM emoji e WHERE ${where} ORDER BY e.id ${pg.order} LIMIT $${params.length}`, params)).rows.map((r) => packEmojiDetailed(rowToEmoji(r)));
  }
  let emojis = (await c.query(`SELECT ${COLS.split(", ").map((x) => `e.${x}`).join(", ")} FROM emoji e WHERE ${where} ORDER BY e.id ${pg.order}`, params)).rows.map(rowToEmoji);
  const queryarry = q.match(/:([a-z0-9_]*):/g);
  emojis = queryarry
    ? emojis.filter((e) => queryarry.includes(`:${e.name}:`))
    : emojis.filter((e) => e.name.includes(q) || (e.aliases ?? []).some((a) => a.includes(q)) || (e.category ?? "").includes(q));
  // upstream quirk: splice(limit + 1)
  return emojis.slice(0, limit + 1).map(packEmojiDetailed);
});

const listRemote = gated(async (_env, body, _ctx, _me, c) => {
  if (!optStr(body.query) || !optStr(body.host) || !pageOk(body)) return bad();
  const params: unknown[] = [];
  const pg = pagination(body, params, "e.id");
  const where = [...pg.where];
  if (typeof body.host === "string") { params.push(body.host.toLowerCase()); where.push(`e.host = $${params.length}`); }
  else where.push("e.host IS NOT NULL");
  if (typeof body.query === "string" && body.query) { params.push(`%${likeEscape(body.query)}%`); where.push(`e.name LIKE $${params.length}`); }
  params.push(limitOf(body));
  return (await c.query(`SELECT ${COLS.split(", ").map((x) => `e.${x}`).join(", ")} FROM emoji e WHERE ${where.join(" AND ")} ORDER BY e.id DESC LIMIT $${params.length}`, params)).rows.map((r) => packEmojiDetailed(rowToEmoji(r)));
});

export const emojiAdminHandlers: Record<string, EmojiHandler> = {
  "admin/emoji/add": add,
  "admin/emoji/update": update,
  "admin/emoji/delete": del,
  "admin/emoji/delete-bulk": deleteBulk,
  "admin/emoji/list": list,
  "admin/emoji/list-remote": listRemote,
  "admin/emoji/set-aliases-bulk": setAliasesBulk,
  "admin/emoji/add-aliases-bulk": addAliasesBulk,
  "admin/emoji/remove-aliases-bulk": removeAliasesBulk,
  "admin/emoji/set-category-bulk": setCategoryBulk,
  "admin/emoji/set-license-bulk": setLicenseBulk,
};

// ------------------------------------------------------------------ reactions

const CUSTOM_RE = /^:([\w+-]+)(?:@\.)?:$/;
export const FALLBACK_REACTION = "\u2764";

const LEGACY_REACTIONS: Record<string, string> = {
  like: "👍", love: "\u2764", laugh: "😆", hmm: "🤔", surprise: "😮", congrats: "🎉", angry: "💢", confused: "😥", rip: "😇", pudding: "🍮", star: "⭐",
};
const EMOJI_RE = new RegExp(`(${twemojiRegex.source})`);

/** ReactionService.normalize: legacy names, the first Unicode emoji (FE0F stripped unless ZWJ), else ❤. */
export function normalizeReaction(reaction: string | null): string {
  if (reaction == null) return FALLBACK_REACTION;
  if (Object.hasOwn(LEGACY_REACTIONS, reaction)) return LEGACY_REACTIONS[reaction]!;
  const m = EMOJI_RE.exec(reaction);
  if (m) {
    const unicode = m[0];
    return unicode.match("\u200d") ? unicode : unicode.replace(/\ufe0f/g, "");
  }
  return FALLBACK_REACTION;
}

/**
 * ReactionService.create's reaction resolution: likeOnly (or *ForRemote for remote reacters)
 * → ❤; a custom `:name:` must name an existing emoji of the reacter's host that the user may
 * use (role restriction; sensitive ones fall back on nonSensitiveOnly notes, media-silenced
 * hosts always fall back); anything else goes through normalize().
 */
export async function resolveReactionPg(
  c: PgQueryable,
  userId: string,
  reaction: string | null,
  reactionAcceptance: string | null,
  reacterHost: string | null = null,
): Promise<string> {
  if (reactionAcceptance === "likeOnly" || ((reactionAcceptance === "likeOnlyForRemote" || reactionAcceptance === "nonSensitiveOnlyForLocalLikeOnlyForRemote") && reacterHost != null)) return FALLBACK_REACTION;
  if (reaction == null) return FALLBACK_REACTION;
  const m = CUSTOM_RE.exec(reaction);
  if (!m) return normalizeReaction(reaction);
  const host = reacterHost ? reacterHost.toLowerCase() : null;
  const emoji = host == null
    ? await getLocalEmojiPg(c, m[1]!)
    : ((await c.query(`SELECT "isSensitive", "roleIdsThatCanBeUsedThisEmojiAsReaction" FROM emoji WHERE name = $1 AND host = $2 LIMIT 1`, [m[1], host])).rows[0] as
        | { isSensitive: boolean; roleIdsThatCanBeUsedThisEmojiAsReaction: string[] }
        | undefined) ?? null;
  if (!emoji) return FALLBACK_REACTION;
  const roles = emoji.roleIdsThatCanBeUsedThisEmojiAsReaction ?? [];
  if (roles.length && !(await userRoleIdsPg(c, userId)).some((r) => roles.includes(r))) return FALLBACK_REACTION;
  let out = host ? `:${m[1]}@${host}:` : `:${m[1]}:`;
  if ((reactionAcceptance === "nonSensitiveOnly" || reactionAcceptance === "nonSensitiveOnlyForLocalLikeOnlyForRemote") && emoji.isSensitive) out = FALLBACK_REACTION;
  if (host != null) {
    const meta = (await metaRowPg(c)).mediaSilencedHosts;
    if (Array.isArray(meta) && (meta as string[]).some((x) => `.${host}`.endsWith(`.${x}`))) out = FALLBACK_REACTION;
  }
  return out;
}

/** ReactionService.decodeReaction for packing: local `:name:` → `:name@.:`. */
export function packReactionKey(r: string): string {
  const m = /^:([\w+-]+):$/.exec(r);
  return m ? `:${m[1]}@.:` : r;
}

/**
 * GET /emoji/<name>[@host].webp — upstream answers 301 to the media proxy;
 * without a proxy we redirect straight to publicUrl || originalUrl.
 */
export async function serveEmojiRedirect(env: ApiEnv, url: URL): Promise<Response> {
  const headers = { "cache-control": "public, max-age=86400", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'" };
  const path = decodeURIComponent(url.pathname.slice("/emoji/".length));
  if (!/^[a-zA-Z0-9\-_@.]+?\.webp$/.test(path)) return new Response(null, { status: 404, headers });
  const chunks = path.replace(/\.webp$/i, "").split("@");
  if (chunks.length > 2) return new Response(null, { status: 400, headers });
  const name = chunks[0]!;
  const host = chunks.length === 2 ? chunks[1]! : undefined;
  if (!env.HYPERDRIVE?.connectionString) return new Response(null, { status: 404, headers });
  const row = await withHyperdriveClient(env.HYPERDRIVE, async (c) =>
    host === undefined || host === "."
      ? (await c.query(`SELECT "publicUrl", "originalUrl" FROM emoji WHERE name = $1 AND host IS NULL LIMIT 1`, [name])).rows[0]
      : (await c.query(`SELECT "publicUrl", "originalUrl" FROM emoji WHERE name = $1 AND host = $2 LIMIT 1`, [name, host])).rows[0],
  );
  if (!row) {
    if (url.searchParams.has("fallback")) return new Response(null, { status: 302, headers: { ...headers, location: new URL("/static-assets/emoji-unknown.png", url).toString() } });
    return new Response(null, { status: 404, headers });
  }
  return new Response(null, { status: 301, headers: { ...headers, location: String(row.publicUrl || row.originalUrl) } });
}

export type { PackedEmojiDetailed };
