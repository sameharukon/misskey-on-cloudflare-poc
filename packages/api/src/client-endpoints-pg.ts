/**
 * Endpoints the stock Misskey web client calls at boot / in daily use, on PG
 * (Hyperdrive) or DO where upstream uses Redis:
 * i/registry/*, notes/state|children|conversation|replies|renotes|mentions|featured,
 * users/search-by-username-and-host, pinned-users, get-avatar-decorations,
 * i/pin|unpin, notifications/flush|test-notification|create,
 * i/notifications-grouped, announcements, i/read-announcement,
 * get-online-users-count, i/claim-achievement, and the
 * `i` (MeDetailed) enrichment.
 */

import { genAidx, genAidxFromDate, parseAidxTime } from "../../id/src/index.js";
import { packUserLite, type PackNoteSource } from "../../packers/src/index.js";
import type { ApiEnv } from "./env.js";
import { apiErrorResponse, CREDENTIAL_REQUIRED, INVALID_PARAM, NO_SUCH_NOTE } from "./errors.js";
import { authenticatePg, extractToken } from "./auth-pg.js";
import { buildPackConfig } from "./meta-source.js";
import { policiesForPg } from "./policies-pg.js";
import { withHyperdriveClient, type PgQueryable } from "./pg.js";
import { getNotePg, getNotesByIdsPg, getUsersByIdsPg, packNotesFromPg, rowToPackNote } from "./notes-pg.js";
import { hiddenAuthorIds } from "./graph-pg.js";
import { canViewNote } from "./visibility.js";
import { getRootUserId, getUserDetailedPg } from "./users-pg.js";
import { publishToUserStream } from "./stream-publish.js";
import { notesReadHandlers } from "./notes-read-pg.js";
import {
  createNotification,
  flushNotifications,
  listNotifications,
  markAllNotificationsRead,
  notificationUnreadInfo,
  packNotificationsPg,
  type NotificationItem,
} from "./notifications-do.js";
import { clientError as err } from "./handler-kit.js";
import { metaRowPg } from "./user-lite-pg.js";

type Ctx = { hasCredential: boolean; request: Request };
type Body = Record<string, unknown>;
export type ClientHandler = (env: ApiEnv, body: Body, ctx: Ctx) => Promise<Response | unknown>;

function hd(env: ApiEnv) {
  return env.HYPERDRIVE!;
}

type Auth = { userId: string; accessTokenId: string | null };

async function auth(env: ApiEnv, body: Body, ctx: Ctx): Promise<Auth | null> {
  if (!ctx.hasCredential) return null;
  const token = extractToken(ctx.request, body);
  if (!token) return null;
  const a = await authenticatePg(env, token);
  return a ? { userId: a.user.id, accessTokenId: a.accessTokenId } : null;
}

function limitOf(body: Body, def: number, max = 100): number {
  const n = typeof body.limit === "number" ? body.limit : def;
  return Math.max(1, Math.min(max, Math.floor(n)));
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** makePaginationQuery: since/until id or date → WHERE + ORDER. */
/** upstream QueryService.makePaginationQuery (ids win over dates; a lone lower bound sorts ASC). */
export function pagination(body: Body, params: unknown[], col = "n.id"): { where: string[]; order: "ASC" | "DESC" } {
  const sinceId = str(body.sinceId);
  const untilId = str(body.untilId);
  const sinceDate = typeof body.sinceDate === "number" && body.sinceDate ? body.sinceDate : null;
  const untilDate = typeof body.untilDate === "number" && body.untilDate ? body.untilDate : null;
  let lo: string | null = null;
  let hi: string | null = null;
  if (sinceId || untilId) {
    lo = sinceId ?? null;
    hi = untilId ?? null;
  } else {
    lo = sinceDate ? genAidx(sinceDate) : null;
    hi = untilDate ? genAidx(untilDate) : null;
  }
  const where: string[] = [];
  if (lo) where.push(`${col} > $${params.push(lo)}`);
  if (hi) where.push(`${col} < $${params.push(hi)}`);
  return { where, order: lo && !hi ? "ASC" : "DESC" };
}

/** Upstream generateVisibilityQuery for a viewer (or anonymous). */
export function visibilitySql(viewerParam: string | null, a = "n"): string {
  if (!viewerParam) return `${a}.visibility IN ('public','home')`;
  return `(${a}.visibility IN ('public','home')
    OR ${a}."userId" = ${viewerParam}
    OR ${viewerParam} = ANY(${a}."visibleUserIds")
    OR ${viewerParam} = ANY(${a}.mentions)
    OR (${a}.visibility = 'followers' AND (${a}."userId" IN (SELECT "followeeId" FROM following WHERE "followerId" = ${viewerParam}) OR ${a}."replyUserId" = ${viewerParam})))`;
}

/** Query notes with visibility + pagination, then drop muted/blocked authors and pack. */
export async function listNotes(
  env: ApiEnv,
  viewerId: string | null,
  body: Body,
  extraWhere: (params: unknown[]) => string,
  opts: { limit: number; orderCol?: string } = { limit: 10 },
): Promise<unknown[]> {
  const params: unknown[] = [];
  let viewerParam: string | null = null;
  if (viewerId) {
    params.push(viewerId);
    viewerParam = `$${params.length}`;
  }
  const extra = extraWhere(params);
  const pg = pagination(body, params);
  const hidden = viewerId ? await hiddenAuthorIds(env, viewerId) : new Set<string>();
  params.push(Math.min(100, opts.limit + hidden.size));
  const sql = `SELECT n.* FROM note n
    WHERE ${[extra, visibilitySql(viewerParam), ...pg.where].join(" AND ")}
    ORDER BY n.id ${pg.order} LIMIT $${params.length}`;
  const rows = await withHyperdriveClient(hd(env), async (c) => (await c.query(sql, params)).rows);
  const notes = rows
    .map(rowToPackNote)
    .filter((n) => !hidden.has(n.userId) && !(n.replyUserId && hidden.has(n.replyUserId)) && !(n.renoteUserId && hidden.has(n.renoteUserId)))
    .slice(0, opts.limit);
  return packNotesFromPg(env, notes, buildPackConfig(env), viewerId);
}

// ---------------------------------------------------------------- i/registry

const SCOPE_RE = /^[a-zA-Z0-9_]+$/;
const NO_SUCH_KEY_GET = err("NO_SUCH_KEY", "ac3ed68a-62f0-422b-a7bc-d5e09e8f6a6a", "No such key.");
const NO_SUCH_KEY_DETAIL = err("NO_SUCH_KEY", "97a1e8e7-c0f7-47d2-957a-92e61256e01a", "No such key.");

type RegistryParams = { scope: string[]; domain: string | null; key?: string };

function registryParams(body: Body, a: Auth, needKey: boolean): RegistryParams | null {
  const scope = body.scope === undefined ? [] : body.scope;
  if (!Array.isArray(scope) || !scope.every((s) => typeof s === "string" && SCOPE_RE.test(s))) return null;
  if (body.domain !== undefined && body.domain !== null && typeof body.domain !== "string") return null;
  if (needKey && typeof body.key !== "string") return null;
  // upstream: access-token callers are namespaced by token id; native token uses `domain`
  const domain = a.accessTokenId ?? (typeof body.domain === "string" ? body.domain : null);
  return { scope: scope as string[], domain, key: typeof body.key === "string" ? body.key : undefined };
}

/** `truthyDomain`: set / remove test `if (domain)` (an empty domain matches NULL rows), reads `domain == null`. */
function registryWhere(p: RegistryParams, userId: string, params: unknown[], truthyDomain = false): string {
  params.push(userId, p.scope);
  let w = `"userId" = $${params.length - 1} AND scope = $${params.length}::varchar[]`;
  if (truthyDomain ? !p.domain : p.domain == null) w += ` AND domain IS NULL`;
  else {
    params.push(p.domain);
    w += ` AND domain = $${params.length}`;
  }
  if (p.key !== undefined) {
    params.push(p.key);
    w += ` AND key = $${params.length}`;
  }
  return w;
}

async function registryRows(env: ApiEnv, p: RegistryParams, userId: string): Promise<{ key: string; value: unknown; updatedAt: string }[]> {
  const params: unknown[] = [];
  const where = registryWhere(p, userId, params);
  return withHyperdriveClient(hd(env), async (c) => {
    const r = await c.query(`SELECT key, value, "updatedAt" FROM registry_item WHERE ${where} ORDER BY id`, params);
    return r.rows.map((x) => ({ key: String(x.key), value: x.value, updatedAt: new Date(String(x.updatedAt)).toISOString() }));
  });
}

function registryHandler(kind: "get" | "get-detail" | "get-all" | "keys" | "keys-with-type" | "set" | "remove"): ClientHandler {
  return async (env, body, ctx) => {
    const a = await auth(env, body, ctx);
    if (!a) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
    const needKey = kind === "get" || kind === "get-detail" || kind === "set" || kind === "remove";
    const p = registryParams(body, a, needKey);
    if (!p) return apiErrorResponse(INVALID_PARAM, 400);
    if (kind === "set") {
      if (!p.key || !("value" in body)) return apiErrorResponse(INVALID_PARAM, 400);
      const value = body.value;
      await withHyperdriveClient(hd(env), async (c) => {
        const params: unknown[] = [];
        const where = registryWhere(p, a.userId, params, true);
        const ex = await c.query(`SELECT id FROM registry_item WHERE ${where} LIMIT 1`, params);
        if (ex.rows[0]) {
          await c.query(`UPDATE registry_item SET value = $1::jsonb, "updatedAt" = now() WHERE id = $2`, [JSON.stringify(value ?? null), ex.rows[0].id]);
        } else {
          await c.query(
            `INSERT INTO registry_item (id, "updatedAt", "userId", key, scope, domain, value) VALUES ($1, now(), $2, $3, $4::varchar[], $5, $6::jsonb)`,
            [genAidxFromDate(new Date()), a.userId, p.key, p.scope, p.domain, JSON.stringify(value ?? null)],
          );
        }
      });
      if (p.domain == null) {
        await publishToUserStream(env, a.userId, "main", "registryUpdated", { scope: p.scope, key: p.key, value });
      }
      return null;
    }
    if (kind === "remove") {
      const params: unknown[] = [];
      const where = registryWhere(p, a.userId, params, true);
      await withHyperdriveClient(hd(env), (c) => c.query(`DELETE FROM registry_item WHERE ${where}`, params));
      return null;
    }
    const rows = await registryRows(env, p, a.userId);
    if (kind === "get" || kind === "get-detail") {
      const item = rows[0];
      if (!item) return apiErrorResponse(kind === "get" ? NO_SUCH_KEY_GET : NO_SUCH_KEY_DETAIL, 400);
      return kind === "get" ? item.value : { updatedAt: item.updatedAt, value: item.value };
    }
    if (kind === "keys") return rows.map((r) => r.key);
    if (kind === "keys-with-type") {
      return Object.fromEntries(
        rows.map((r) => [
          r.key,
          r.value === null ? "null" : Array.isArray(r.value) ? "array" : typeof r.value === "object" ? "object" : typeof r.value,
        ]),
      );
    }
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  };
}

const registryScopesWithDomain: ClientHandler = async (env, body, ctx) => {
  const a = await auth(env, body, ctx);
  if (!a) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  const rows = await withHyperdriveClient(hd(env), async (c) =>
    (await c.query(`SELECT DISTINCT scope, domain FROM registry_item WHERE "userId" = $1`, [a.userId])).rows,
  );
  const res: { domain: string | null; scopes: string[][] }[] = [];
  for (const r of rows) {
    const domain = (r.domain as string | null) ?? null;
    const scope = (r.scope as string[]) ?? [];
    const t = res.find((x) => x.domain === domain);
    if (t) {
      if (!t.scopes.some((s) => s.join(".") === scope.join("."))) t.scopes.push(scope);
    } else res.push({ domain, scopes: [scope] });
  }
  return res;
};

// ---------------------------------------------------------------- notes/*

// notes/state|children|replies|renotes|conversation|mentions|featured live in notes-read-pg.ts
export { resetFeaturedCacheForTest } from "./notes-read-pg.js";

// ---------------------------------------------------------------- users / misc

/** upstream UserEntityService.packMany: input order, duplicates kept, missing users dropped. */
export async function packUsers(env: ApiEnv, ids: string[], viewerId: string | null, detail: boolean): Promise<unknown[]> {
  if (ids.length === 0) return [];
  if (!detail) {
    const config = buildPackConfig(env);
    const users = await getUsersByIdsPg(env, ids, viewerId);
    return ids.map((id) => users.get(id)).filter(Boolean).map((u) => packUserLite(u!, config));
  }
  const { packUsersDetailedPg } = await import("./user-detailed-pg.js");
  const packed = await packUsersDetailedPg(env, ids, viewerId, { schema: "UserDetailed", many: true });
  const byId = new Map(packed.map((u) => [String(u.id), u]));
  return ids.map((id) => byId.get(id)).filter(Boolean);
}

function likeEscape(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}

/** UserSearchService.searchByUsernameAndHost: queries in priority order until `limit` ids. */
const usersSearchByUsernameAndHost: ClientHandler = async (env, body, ctx) => {
  const a = await auth(env, body, ctx);
  const limit = limitOf(body, 10);
  const username = typeof body.username === "string" ? body.username : null;
  const host = typeof body.host === "string" ? body.host : null;
  const threshold = new Date(Date.now() - 30 * 24 * 3600_000).toISOString();
  const base = (params: unknown[]) => {
    const where: string[] = [];
    if (username) where.push(`u."usernameLower" LIKE $${params.push(likeEscape(username.toLowerCase()) + "%")}`);
    if (host) {
      if (host === buildPackConfig(env).host || host === ".") where.push(`u.host IS NULL`);
      else where.push(`u.host LIKE $${params.push(likeEscape(host.toLowerCase()) + "%")}`);
    }
    where.push(`u."isSuspended" = FALSE`);
    return where;
  };
  type Q = (params: unknown[]) => string[];
  const following = (params: unknown[]) => `SELECT "followeeId" FROM following WHERE "followerId" = $${params.push(a!.userId)}`;
  const t = (params: unknown[]) => `$${params.push(threshold)}`;
  const queries: Q[] = a
    ? [
        (p) => [...base(p), `u.id IN (${following(p)})`, `u."updatedAt" > ${t(p)}`],
        (p) => [...base(p), `u.id IN (${following(p)})`, `(u."updatedAt" IS NULL OR u."updatedAt" <= ${t(p)})`],
        (p) => [...base(p), `u.id NOT IN (${following(p)})`, `u."updatedAt" > ${t(p)}`],
        (p) => [...base(p), `u.id NOT IN (${following(p)})`, `u."updatedAt" <= ${t(p)}`],
      ]
    : [
        (p) => [...base(p), `(u."updatedAt" IS NULL OR u."updatedAt" > ${t(p)})`],
        (p) => [...base(p), `u."updatedAt" <= ${t(p)}`],
      ];
  const result = new Set<string>();
  await withHyperdriveClient(hd(env), async (c) => {
    for (const q of queries) {
      const params: unknown[] = [];
      const where = q(params);
      params.push(limit - result.size);
      const rows = (await c.query(`SELECT u.id FROM "user" u WHERE ${where.join(" AND ")} ORDER BY u."usernameLower" ASC LIMIT $${params.length}`, params)).rows;
      for (const r of rows) result.add(String(r.id));
      if (result.size >= limit) break;
    }
  });
  return packUsers(env, [...result].slice(0, limit), a?.userId ?? null, body.detail !== false);
};

const pinnedUsers: ClientHandler = async (env, body, ctx) => {
  const a = await auth(env, body, ctx);
  const accts = await withHyperdriveClient(hd(env), async (c) => {
    const p = (await metaRowPg(c)).pinnedUsers;
    return (Array.isArray(p) ? (p as unknown[]) : []).filter((x): x is string => typeof x === "string");
  });
  if (accts.length === 0) return [];
  const ids: string[] = [];
  await withHyperdriveClient(hd(env), async (c) => {
    for (const acct of accts) {
      // Acct.parse; the host is compared as written (upstream does not lowercase it)
      const [username, host] = (acct.startsWith("@") ? acct.slice(1) : acct).split("@", 2);
      const r = host
        ? await c.query(`SELECT id FROM "user" WHERE "usernameLower" = $1 AND host = $2 LIMIT 1`, [(username ?? "").toLowerCase(), host])
        : await c.query(`SELECT id FROM "user" WHERE "usernameLower" = $1 AND host IS NULL LIMIT 1`, [(username ?? "").toLowerCase()]);
      if (r.rows[0]) ids.push(String(r.rows[0].id));
    }
  });
  return packUsers(env, ids, a?.userId ?? null, true);
};

const getAvatarDecorations: ClientHandler = async (env, body, ctx) => {
  const a = await auth(env, body, ctx);
  return withHyperdriveClient(hd(env), async (c) => {
    // to_jsonb: `category` is a newer column. (upstream: find() without ORDER BY)
    const r = await c.query(`SELECT to_jsonb(d) AS j FROM avatar_decoration d ORDER BY id`, []);
    // role ids are narrowed to existing roles (public ones only for visitors)
    const roles = (await c.query(`SELECT id, "isPublic" FROM role`, [])).rows;
    const visible = new Set(roles.filter((x) => a != null || x.isPublic).map((x) => String(x.id)));
    return r.rows.map(({ j }) => {
      const x = j as Record<string, unknown>;
      return {
        id: String(x.id),
        name: String(x.name),
        description: String(x.description ?? ""),
        url: String(x.url),
        roleIdsThatCanBeUsedThisDecoration: ((x.roleIdsThatCanBeUsedThisDecoration as string[]) ?? []).filter((id) => visible.has(id)),
        category: (x.category as string | null | undefined) ?? null,
      };
    });
  });
};

// ---------------------------------------------------------------- i/pin, i/unpin

const PIN_NO_SUCH_NOTE = err("NO_SUCH_NOTE", "56734f8b-3928-431e-bf80-6ff87df40cb3", "No such note.");
const PIN_LIMIT_EXCEEDED = err("PIN_LIMIT_EXCEEDED", "72dab508-c64d-498f-8740-a8eec1ba385a", "You can not pin notes any more.");
const ALREADY_PINNED = err("ALREADY_PINNED", "8b18c2b7-68fe-4edb-9892-c0cbaeb6c913", "That note has already been pinned.");
const UNPIN_NO_SUCH_NOTE = err("NO_SUCH_NOTE", "454170ce-9d63-4a43-9da1-ea10afe81e21", "No such note.");

/** RoleService.getUserPolicies for the caller (base + their roles). */
function policiesFor(env: ApiEnv, userId: string): Promise<Record<string, unknown>> {
  return policiesForPg(env, userId);
}

const iPin: ClientHandler = async (env, body, ctx) => {
  const a = await auth(env, body, ctx);
  if (!a) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  const noteId = str(body.noteId);
  if (!noteId) return apiErrorResponse(INVALID_PARAM, 400);
  const note = await getNotePg(env, noteId);
  if (!note || note.userId !== a.userId) return apiErrorResponse(PIN_NO_SUCH_NOTE, 400);
  const limit = Number((await policiesFor(env, a.userId)).pinLimit ?? 5);
  const r = await withHyperdriveClient(hd(env), async (c) => {
    const rows = (await c.query(`SELECT "noteId" FROM user_note_pining WHERE "userId" = $1`, [a.userId])).rows;
    if (rows.length >= limit) return "limit";
    if (rows.some((x) => String(x.noteId) === noteId)) return "already";
    await c.query(`INSERT INTO user_note_pining (id, "userId", "noteId") VALUES ($1, $2, $3)`, [genAidxFromDate(new Date()), a.userId, noteId]);
    return "ok";
  });
  if (r === "limit") return apiErrorResponse(PIN_LIMIT_EXCEEDED, 400);
  if (r === "already") return apiErrorResponse(ALREADY_PINNED, 400);
  if (!note.localOnly && (note.visibility === "public" || note.visibility === "home")) {
    const { deliverPinnedChange } = await import("./ap/outbound.js");
    await deliverPinnedChange(env, a.userId, note.id, true);
  }
  return packMe(env, a.userId);
};

const iUnpin: ClientHandler = async (env, body, ctx) => {
  const a = await auth(env, body, ctx);
  if (!a) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  const noteId = str(body.noteId);
  if (!noteId) return apiErrorResponse(INVALID_PARAM, 400);
  const note = await getNotePg(env, noteId);
  if (!note || note.userId !== a.userId) return apiErrorResponse(UNPIN_NO_SUCH_NOTE, 400);
  await withHyperdriveClient(hd(env), (c) => c.query(`DELETE FROM user_note_pining WHERE "userId" = $1 AND "noteId" = $2`, [a.userId, noteId]));
  if (!note.localOnly && (note.visibility === "public" || note.visibility === "home")) {
    const { deliverPinnedChange } = await import("./ap/outbound.js");
    await deliverPinnedChange(env, a.userId, note.id, false);
  }
  return packMe(env, a.userId);
};

// ---------------------------------------------------------------- notifications

const notificationsFlush: ClientHandler = async (env, body, ctx) => {
  const a = await auth(env, body, ctx);
  if (!a) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  await flushNotifications(env, a.userId);
  return null;
};

const notificationsTest: ClientHandler = async (env, body, ctx) => {
  const a = await auth(env, body, ctx);
  if (!a) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  await createNotification(env, a.userId, { type: "test", notifierId: null });
  return null;
};

const notificationsCreate: ClientHandler = async (env, body, ctx) => {
  const a = await auth(env, body, ctx);
  if (!a) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  if (typeof body.body !== "string") return apiErrorResponse(INVALID_PARAM, 400);
  let tokenName: string | null = null;
  let tokenIcon: string | null = null;
  if (a.accessTokenId) {
    const t = await withHyperdriveClient(hd(env), async (c) =>
      (await c.query(`SELECT name, "iconUrl" FROM access_token WHERE id = $1`, [a.accessTokenId])).rows[0],
    );
    tokenName = (t?.name as string | null) ?? null;
    tokenIcon = (t?.iconUrl as string | null) ?? null;
  }
  await createNotification(env, a.userId, {
    type: "app",
    notifierId: null,
    customBody: body.body,
    customHeader: typeof body.header === "string" ? body.header : tokenName,
    customIcon: typeof body.icon === "string" ? body.icon : tokenIcon,
    appAccessTokenId: a.accessTokenId,
  });
  return null;
};

/** Upstream grouping: consecutive reactions on one note / renotes of one note. */
export function groupNotifications(items: NotificationItem[], renoteTargets: Map<string, string | null>): (NotificationItem | GroupedItem)[] {
  if (items.length === 0) return [];
  const out: (NotificationItem | GroupedItem)[] = [items[0]!];
  for (let i = 1; i < items.length; i++) {
    const n = items[i]!;
    const prev = items[i - 1]!;
    let last = out[out.length - 1]!;
    if (prev.type === "reaction" && n.type === "reaction" && prev.noteId && prev.noteId === n.noteId) {
      if (last.type !== "reaction:grouped") {
        last = out[out.length - 1] = { type: "reaction:grouped", id: "", createdAt: prev.createdAt, noteId: prev.noteId, reactions: [{ userId: prev.notifierId!, reaction: prev.reaction ?? "" }] };
      }
      (last as GroupedItem).reactions!.push({ userId: n.notifierId!, reaction: n.reaction ?? "" });
      last.id = n.id;
      continue;
    }
    // upstream compares targetNoteId (older rows without it: the renote's renoteId)
    const pt = prev.targetNoteId ?? (prev.noteId ? renoteTargets.get(prev.noteId) : null);
    const nt = n.targetNoteId ?? (n.noteId ? renoteTargets.get(n.noteId) : null);
    if (prev.type === "renote" && n.type === "renote" && pt && pt === nt) {
      if (last.type !== "renote:grouped") {
        last = out[out.length - 1] = { type: "renote:grouped", id: "", createdAt: n.createdAt, noteId: prev.noteId!, userIds: [prev.notifierId!] };
      }
      (last as GroupedItem).userIds!.push(n.notifierId!);
      last.id = n.id;
      continue;
    }
    out.push(n);
  }
  return out;
}

type GroupedItem = {
  type: "reaction:grouped" | "renote:grouped";
  id: string;
  createdAt: string;
  noteId: string;
  reactions?: { userId: string; reaction: string }[];
  userIds?: string[];
};

const iNotificationsGrouped: ClientHandler = async (env, body, ctx) => {
  const a = await auth(env, body, ctx);
  if (!a) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  const { NOTIFICATION_TYPES, OBSOLETE_NOTIFICATION_TYPES } = await import("./social-api-pg.js");
  const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined);
  const includeTypes = strs(body.includeTypes);
  const excludeTypes = strs(body.excludeTypes);
  if (includeTypes && includeTypes.length === 0) return [];
  if (NOTIFICATION_TYPES.every((t) => excludeTypes?.includes(t))) return [];
  const limit = limitOf(body, 10);
  const items = await listNotifications(env, a.userId, {
    limit,
    untilId: str(body.untilId) ?? (typeof body.untilDate === "number" && body.untilDate ? genAidx(body.untilDate) : undefined),
    sinceId: str(body.sinceId) ?? (typeof body.sinceDate === "number" && body.sinceDate ? genAidx(body.sinceDate) : undefined),
    includeTypes: includeTypes?.filter((t) => !OBSOLETE_NOTIFICATION_TYPES.includes(t)),
    excludeTypes: excludeTypes?.filter((t) => !OBSOLETE_NOTIFICATION_TYPES.includes(t)),
  });
  if (items.length === 0) return [];
  if (body.markAsRead !== false) await markAllNotificationsRead(env, a.userId);
  const renoteIds = [...new Set(items.filter((n) => n.type === "renote" && n.noteId).map((n) => n.noteId!))];
  const renotes = await getNotesByIdsPg(env, renoteIds);
  const targets = new Map(renotes.map((n) => [n.id, n.renoteId]));
  const grouped = groupNotifications(items, targets).slice(0, limit);
  const config = buildPackConfig(env);
  // pack the ungrouped ones with the normal packer, then the groups
  const plain = grouped.filter((g): g is NotificationItem => !String(g.type).endsWith(":grouped"));
  const packedPlain = new Map((await packNotificationsPg(env, plain, config, a.userId)).map((p) => [String(p.id), p]));
  const groups = grouped.filter((g): g is GroupedItem => String(g.type).endsWith(":grouped"));
  const userIds = groups.flatMap((g) => [...(g.reactions?.map((r) => r.userId) ?? []), ...(g.userIds ?? [])]);
  const users = await getUsersByIdsPg(env, userIds, a.userId);
  // a group's note is its `noteId` (for renote:grouped, the first renote itself)
  const groupNoteIds = groups.map((g) => g.noteId);
  const gNotes = await packNotesFromPg(env, await getNotesByIdsPg(env, [...new Set(groupNoteIds)]), config, a.userId);
  const noteMap = new Map(gNotes.map((n) => [n.id, n]));
  const out: unknown[] = [];
  for (const g of grouped) {
    if (!String(g.type).endsWith(":grouped")) {
      const p = packedPlain.get((g as NotificationItem).id);
      if (p) out.push(p);
      continue;
    }
    const gi = g as GroupedItem;
    const note = noteMap.get(gi.noteId);
    if (!note) continue;
    // (a group whose users are all gone is dropped)
    if (gi.type === "reaction:grouped") {
      const reactions = gi.reactions!.filter((r) => users.has(r.userId)).map((r) => ({ user: packUserLite(users.get(r.userId)!, config), reaction: r.reaction }));
      if (reactions.length === 0) continue;
      out.push({ id: gi.id, createdAt: new Date(gi.createdAt).toISOString(), type: gi.type, note, reactions });
    } else {
      const us = gi.userIds!.filter((u) => users.has(u)).map((u) => packUserLite(users.get(u)!, config));
      if (us.length === 0) continue;
      out.push({ id: gi.id, createdAt: new Date(gi.createdAt).toISOString(), type: gi.type, note, users: us });
    }
  }
  return out;
};

// ---------------------------------------------------------------- announcements

export function packAnnouncement(r: Record<string, unknown>, meId: string | null, isRead: boolean | undefined) {
  return {
    id: String(r.id),
    createdAt: (parseAidxTime(String(r.id)) ?? new Date(0)).toISOString(),
    updatedAt: r.updatedAt ? new Date(String(r.updatedAt)).toISOString() : null,
    title: String(r.title ?? ""),
    text: String(r.text ?? ""),
    imageUrl: (r.imageUrl as string | null) ?? null,
    icon: String(r.icon ?? "info"),
    display: String(r.display ?? "normal"),
    forYou: meId != null && r.userId === meId,
    needConfirmationToRead: Boolean(r.needConfirmationToRead),
    silence: Boolean(r.silence),
    ...(isRead !== undefined ? { isRead } : {}),
  };
}

const announcements: ClientHandler = async (env, body, ctx) => {
  const a = await auth(env, body, ctx);
  const params: unknown[] = [body.isActive === false ? false : true];
  const where = [`a."isActive" = $1`];
  if (a) {
    params.push(a.userId);
    where.push(`(a."userId" IS NULL OR a."userId" = $${params.length})`);
  } else where.push(`a."userId" IS NULL`);
  const pg = pagination(body, params, "a.id");
  params.push(limitOf(body, 10));
  return withHyperdriveClient(hd(env), async (c) => {
    const rows = (
      await c.query(
        `SELECT a.* FROM announcement a WHERE ${[...where, ...pg.where].join(" AND ")} ORDER BY a.id ${pg.order} LIMIT $${params.length}`,
        params,
      )
    ).rows;
    let read = new Set<string>();
    if (a && rows.length) {
      const rr = await c.query(`SELECT "announcementId" FROM announcement_read WHERE "userId" = $1 AND "announcementId" = ANY($2::varchar[])`, [
        a.userId,
        rows.map((r) => String(r.id)),
      ]);
      read = new Set(rr.rows.map((x) => String(x.announcementId)));
    }
    return rows.map((r) => packAnnouncement(r, a?.userId ?? null, a ? read.has(String(r.id)) : undefined));
  });
};

async function unreadAnnouncements(c: PgQueryable, userId: string): Promise<Record<string, unknown>[]> {
  const r = await c.query(
    `SELECT a.* FROM announcement a
     WHERE a."isActive" = TRUE AND a.silence = FALSE
       AND (a."userId" IS NULL OR a."userId" = $1)
       AND (a."forExistingUsers" = FALSE OR a.id > $1)
       AND a.id NOT IN (SELECT "announcementId" FROM announcement_read WHERE "userId" = $1)
     ORDER BY a.id DESC LIMIT 50`,
    [userId],
  );
  return r.rows.map((x) => packAnnouncement(x, userId, false));
}

const iReadAnnouncement: ClientHandler = async (env, body, ctx) => {
  const a = await auth(env, body, ctx);
  if (!a) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  const id = str(body.announcementId);
  if (!id) return apiErrorResponse(INVALID_PARAM, 400);
  const remaining = await withHyperdriveClient(hd(env), async (c) => {
    const ex = await c.query(`SELECT 1 AS ok FROM announcement_read WHERE "userId" = $1 AND "announcementId" = $2`, [a.userId, id]);
    if (ex.rows.length) return null;
    const ann = (await c.query(`SELECT id, "userId" FROM announcement WHERE id = $1`, [id])).rows[0];
    if (!ann) return null; // upstream: insert fails on FK → silently returns
    await c.query(`INSERT INTO announcement_read (id, "userId", "announcementId") VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [genAidxFromDate(new Date()), a.userId, id]);
    if (ann.userId === a.userId) await c.query(`UPDATE announcement SET "isActive" = FALSE WHERE id = $1`, [id]);
    return (await unreadAnnouncements(c, a.userId)).length;
  });
  if (remaining === 0) await publishToUserStream(env, a.userId, "main", "readAllAnnouncements", null);
  return null;
};

// ---------------------------------------------------------------- online count / achievements / trend

/** upstream: users whose lastActiveDate is within USER_ONLINE_THRESHOLD (10 min). */
const getOnlineUsersCount: ClientHandler = async (env) =>
  withHyperdriveClient(hd(env), async (c) => ({
    count: Number((await c.query(`SELECT count(*)::int AS n FROM "user" WHERE "lastActiveDate" > $1`, [new Date(Date.now() - 10 * 60_000).toISOString()])).rows[0]?.n ?? 0),
  }));

export const ACHIEVEMENT_TYPES = (
  "notes1 notes10 notes100 notes500 notes1000 notes5000 notes10000 notes20000 notes30000 notes40000 notes50000 notes60000 notes70000 notes80000 notes90000 notes100000 " +
  "login3 login7 login15 login30 login60 login100 login200 login300 login400 login500 login600 login700 login800 login900 login1000 " +
  "passedSinceAccountCreated1 passedSinceAccountCreated2 passedSinceAccountCreated3 loggedInOnBirthday loggedInOnNewYearsDay noteClipped1 noteFavorited1 myNoteFavorited1 " +
  "profileFilled markedAsCat following1 following10 following50 following100 following300 followers1 followers10 followers50 followers100 followers300 followers500 followers1000 " +
  "collectAchievements30 viewAchievements3min iLoveMisskey foundTreasure client30min client60min noteDeletedWithin1min postedAtLateNight postedAt0min0sec selfQuote htl20npm " +
  "viewInstanceChart outputHelloWorldOnScratchpad open3windows driveFolderCircularReference reactWithoutRead clickedClickHere justPlainLucky setNameToSyuilo cookieClicked " +
  "brainDiver smashTestNotificationButton tutorialCompleted bubbleGameExplodingHead bubbleGameDoubleExplodingHead"
).split(" ");

/** AchievementService.create: append once + achievementEarned notification. */
export async function grantAchievement(env: ApiEnv, userId: string, name: string): Promise<boolean> {
  if (!ACHIEVEMENT_TYPES.includes(name)) return false;
  const added = await withHyperdriveClient(hd(env), async (c) => {
    const r = await c.query(`SELECT achievements FROM user_profile WHERE "userId" = $1`, [userId]);
    const list = (r.rows[0]?.achievements as { name: string; unlockedAt: number }[] | undefined) ?? [];
    if (!r.rows[0] || list.some((x) => x.name === name)) return false;
    await c.query(`UPDATE user_profile SET achievements = $1::jsonb WHERE "userId" = $2`, [JSON.stringify([...list, { name, unlockedAt: Date.now() }]), userId]);
    return true;
  });
  if (added) await createNotification(env, userId, { type: "achievementEarned", notifierId: null, achievement: name });
  return added;
}

const iClaimAchievement: ClientHandler = async (env, body, ctx) => {
  const a = await auth(env, body, ctx);
  if (!a) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  const name = str(body.name);
  if (!name || !ACHIEVEMENT_TYPES.includes(name)) return apiErrorResponse(INVALID_PARAM, 400);
  await grantAchievement(env, a.userId, name);
  return null;
};

// ---------------------------------------------------------------- favorites

const FAV_NO_SUCH_NOTE = err("NO_SUCH_NOTE", "6dd26674-e060-4816-909a-45ba3f4da458", "No such note.");
const ALREADY_FAVORITED = err("ALREADY_FAVORITED", "a402c12b-34dd-41d2-97d8-4d2ffd96a1a6", "The note has already been marked as a favorite.");
const UNFAV_NO_SUCH_NOTE = err("NO_SUCH_NOTE", "80848a2c-398f-4343-baa9-df1d57696c56", "No such note.");
const NOT_FAVORITED = err("NOT_FAVORITED", "b625fc69-635e-45e9-86f4-dbefbef35af5", "You have not marked that note a favorite.");

const favoritesCreate: ClientHandler = async (env, body, ctx) => {
  const a = await auth(env, body, ctx);
  if (!a) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  const noteId = str(body.noteId);
  if (!noteId) return apiErrorResponse(INVALID_PARAM, 400);
  const note = await getNotePg(env, noteId);
  if (!note || !(await canViewNote(env, note, a.userId))) return apiErrorResponse(FAV_NO_SUCH_NOTE, 400);
  const ok = await withHyperdriveClient(hd(env), async (c) => {
    const ex = await c.query(`SELECT 1 AS ok FROM note_favorite WHERE "userId" = $1 AND "noteId" = $2`, [a.userId, noteId]);
    if (ex.rows.length) return false;
    await c.query(`INSERT INTO note_favorite (id, "userId", "noteId") VALUES ($1, $2, $3)`, [genAidxFromDate(new Date()), a.userId, noteId]);
    return true;
  });
  if (!ok) return apiErrorResponse(ALREADY_FAVORITED, 400);
  if (note.userHost == null && note.userId !== a.userId) await grantAchievement(env, note.userId, "myNoteFavorited1");
  return null;
};

const favoritesDelete: ClientHandler = async (env, body, ctx) => {
  const a = await auth(env, body, ctx);
  if (!a) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  const noteId = str(body.noteId);
  if (!noteId) return apiErrorResponse(INVALID_PARAM, 400);
  if (!(await getNotePg(env, noteId))) return apiErrorResponse(UNFAV_NO_SUCH_NOTE, 400);
  const n = await withHyperdriveClient(hd(env), async (c) =>
    (await c.query(`DELETE FROM note_favorite WHERE "userId" = $1 AND "noteId" = $2 RETURNING id`, [a.userId, noteId])).rows.length,
  );
  if (n === 0) return apiErrorResponse(NOT_FAVORITED, 400);
  return null;
};

const iFavorites: ClientHandler = async (env, body, ctx) => {
  const a = await auth(env, body, ctx);
  if (!a) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  const params: unknown[] = [a.userId];
  const pg = pagination(body, params, "f.id");
  params.push(limitOf(body, 10));
  const rows = await withHyperdriveClient(hd(env), async (c) =>
    (
      await c.query(
        `SELECT f.id, f."noteId" FROM note_favorite f WHERE ${[`f."userId" = $1`, ...pg.where].join(" AND ")} ORDER BY f.id ${pg.order} LIMIT $${params.length}`,
        params,
      )
    ).rows.map((r) => ({ id: String(r.id), noteId: String(r.noteId) })),
  );
  const notes = await packNotesFromPg(env, await getNotesByIdsPg(env, rows.map((r) => r.noteId)), buildPackConfig(env), a.userId);
  const byId = new Map(notes.map((n) => [n.id, n]));
  return rows
    .filter((r) => byId.has(r.noteId))
    .map((r) => ({ id: r.id, createdAt: (parseAidxTime(r.id) ?? new Date(0)).toISOString(), noteId: r.noteId, note: byId.get(r.noteId) }));
};

// ---------------------------------------------------------------- i (MeDetailed)

/** UserEntityService.pack(user, user, { schema: 'MeDetailed', includeSecrets }) */
export async function packMe(env: ApiEnv, userId: string, opts: { includeSecrets?: boolean } = {}): Promise<Record<string, unknown> | Response> {
  const { packUserDetailedPg } = await import("./user-detailed-pg.js");
  const me = await packUserDetailedPg(env, userId, userId, { schema: "MeDetailed", includeSecrets: opts.includeSecrets });
  return me ?? apiErrorResponse(CREDENTIAL_REQUIRED, 401);
}

// ---------------------------------------------------------------- registry of handlers

function pgOnly(h: ClientHandler): ClientHandler {
  return async (env, body, ctx) => {
    if (!env.HYPERDRIVE?.connectionString) {
      return apiErrorResponse({ message: "Hyperdrive required.", code: "HYPERDRIVE_UNBOUND", id: "00000000-0000-4000-8000-0000000000b1", kind: "server" }, 501);
    }
    return h(env, body, ctx);
  };
}

export const CLIENT_ENDPOINTS: Record<string, ClientHandler> = {
  "i/registry/get": registryHandler("get"),
  "i/registry/get-detail": registryHandler("get-detail"),
  "i/registry/get-all": registryHandler("get-all"),
  "i/registry/keys": registryHandler("keys"),
  "i/registry/keys-with-type": registryHandler("keys-with-type"),
  "i/registry/set": registryHandler("set"),
  "i/registry/remove": registryHandler("remove"),
  "i/registry/scopes-with-domain": registryScopesWithDomain,
  "notes/state": notesReadHandlers["notes/state"]!,
  "notes/children": notesReadHandlers["notes/children"]!,
  "notes/conversation": notesReadHandlers["notes/conversation"]!,
  "notes/replies": notesReadHandlers["notes/replies"]!,
  "notes/renotes": notesReadHandlers["notes/renotes"]!,
  "notes/mentions": notesReadHandlers["notes/mentions"]!,
  "notes/featured": notesReadHandlers["notes/featured"]!,
  "users/search-by-username-and-host": usersSearchByUsernameAndHost,
  "pinned-users": pinnedUsers,
  "get-avatar-decorations": getAvatarDecorations,
  "i/pin": iPin,
  "i/unpin": iUnpin,
  "notifications/flush": notificationsFlush,
  "notifications/test-notification": notificationsTest,
  "notifications/create": notificationsCreate,
  "i/notifications-grouped": iNotificationsGrouped,
  announcements: announcements,
  "i/read-announcement": iReadAnnouncement,
  "get-online-users-count": getOnlineUsersCount,
  "i/claim-achievement": iClaimAchievement,
  "notes/favorites/create": favoritesCreate,
  "notes/favorites/delete": favoritesDelete,
  "i/favorites": iFavorites,
};

/** Handlers wrapped so an unbound Hyperdrive answers 501 (except PG-free ones). */
export const clientHandlers: Record<string, ClientHandler> = Object.fromEntries(
  Object.entries(CLIENT_ENDPOINTS).map(([k, h]) => [k, k === "get-online-users-count" ? h : pgOnly(h)]),
);

