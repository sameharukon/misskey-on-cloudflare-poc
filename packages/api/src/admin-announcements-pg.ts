/**
 * admin/announcements/create|update|delete|list (W7.8) on PG `announcement` / `announcement_read`,
 * following upstream AnnouncementService: moderators only, moderation_log entries
 * (create|update|delete + Global|User), `announcementCreated` broadcast (global) or on the
 * target user's `main` stream.
 */

import { genAidx, parseAidxTime } from "../../id/src/index.js";
import type { ApiEnv } from "./env.js";
import { apiErrorResponse } from "./errors.js";
import { authenticatePg, extractToken } from "./auth-pg.js";
import { withHyperdriveClient, type PgQueryable } from "./pg.js";
import { moderationLogPg } from "./policies-pg.js";
import { pagination, packAnnouncement } from "./client-endpoints-pg.js";
import { broadcastStream, publishToUserStream } from "./stream-publish.js";
import { adminGate } from "./admin-gate.js";
import { clientError as err, errorResponse as fail, hd, invalidParam as bad } from "./handler-kit.js";

type Ctx = { hasCredential: boolean; request: Request };
type Body = Record<string, unknown>;
export type AnnouncementHandler = (env: ApiEnv, body: Body, ctx: Ctx) => Promise<Response | unknown>;

const E = {
  deleteNoSuch: err("NO_SUCH_ANNOUNCEMENT", "ecad8040-a276-4e85-bda9-015a708d291e", "No such announcement."),
  updateNoSuch: err("NO_SUCH_ANNOUNCEMENT", "d3aae5a7-6372-4cb4-b61c-f511ffc2d7cc", "No such announcement."),
};

const noContent = () => new Response(null, { status: 204 });

const ICONS = ["info", "warning", "error", "success"];
const DISPLAYS = ["normal", "banner", "dialog"];
const FLAGS = ["forExistingUsers", "silence", "needConfirmationToRead"] as const;
const nonEmpty = (v: unknown) => typeof v === "string" && v.length >= 1;
const COLS = `id, "updatedAt", text, title, "imageUrl", icon, display, "needConfirmationToRead", "isActive", "forExistingUsers", silence, "userId"`;

/** Moderator gate; returns the caller id (null when the admin surface is open in dev). */
async function gate(env: ApiEnv, body: Body, ctx: Ctx): Promise<{ denied: Response } | { me: string | null }> {
  const denied = await adminGate(ctx.request, env as never, body, "moderator");
  if (denied) return { denied };
  const token = extractToken(ctx.request, body);
  return { me: token ? ((await authenticatePg(env, token))?.user.id ?? null) : null };
}

/** The raw row as upstream logs it (createdAt-less entity). */
function rawRow(r: Record<string, unknown>) {
  return {
    id: String(r.id),
    updatedAt: r.updatedAt ? new Date(String(r.updatedAt)).toISOString() : null,
    text: r.text, title: r.title, imageUrl: r.imageUrl ?? null, icon: r.icon, display: r.display,
    needConfirmationToRead: Boolean(r.needConfirmationToRead), isActive: Boolean(r.isActive),
    forExistingUsers: Boolean(r.forExistingUsers), silence: Boolean(r.silence), userId: r.userId ?? null,
  };
}

async function getAnnouncement(c: PgQueryable, id: string): Promise<Record<string, unknown> | null> {
  return (await c.query(`SELECT ${COLS} FROM announcement WHERE id = $1`, [id])).rows[0] ?? null;
}

async function userLogInfo(c: PgQueryable, userId: string) {
  const u = (await c.query(`SELECT username, host FROM "user" WHERE id = $1`, [userId])).rows[0];
  return { userId, userUsername: u ? String(u.username) : null, userHost: (u?.host as string | null) ?? null };
}

const create: AnnouncementHandler = async (env, body, ctx) => {
  const g = await gate(env, body, ctx);
  if ("denied" in g) return g.denied;
  if (!nonEmpty(body.title) || !nonEmpty(body.text)) return bad();
  if (!("imageUrl" in body) || (body.imageUrl !== null && typeof body.imageUrl !== "string")) return bad(); // required, nullable
  if (body.icon !== undefined && !ICONS.includes(body.icon as string)) return bad();
  if (body.display !== undefined && !DISPLAYS.includes(body.display as string)) return bad();
  for (const k of FLAGS) if (body[k] !== undefined && typeof body[k] !== "boolean") return bad();
  if (body.userId != null && typeof body.userId !== "string") return bad();
  const userId = (body.userId as string | null | undefined) ?? null;
  const row = await withHyperdriveClient(hd(env), async (c) => {
    const id = genAidx(Date.now());
    await c.query(
      `INSERT INTO announcement (id, "updatedAt", title, text, "imageUrl", icon, display, "forExistingUsers", silence, "needConfirmationToRead", "userId")
       VALUES ($1, NULL, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [id, body.title, body.text, (body.imageUrl as string | null) || null, body.icon ?? "info", body.display ?? "normal",
        body.forExistingUsers === true, body.silence === true, body.needConfirmationToRead === true, userId],
    );
    const row = (await getAnnouncement(c, id))!;
    if (g.me) {
      await moderationLogPg(c, g.me, userId ? "createUserAnnouncement" : "createGlobalAnnouncement",
        { announcementId: id, announcement: rawRow(row), ...(userId ? await userLogInfo(c, userId) : {}) }, genAidx(Date.now()));
    }
    return row;
  });
  const packed = packAnnouncement(row, null, undefined);
  if (userId) await publishToUserStream(env, userId, "main", "announcementCreated", { announcement: packed });
  else await broadcastStream(env, "announcementCreated", { announcement: packed });
  return packed;
};

const update: AnnouncementHandler = async (env, body, ctx) => {
  const g = await gate(env, body, ctx);
  if ("denied" in g) return g.denied;
  if (typeof body.id !== "string" || !body.id) return bad();
  if (body.title !== undefined && !nonEmpty(body.title)) return bad();
  if (body.text !== undefined && !nonEmpty(body.text)) return bad();
  if (body.imageUrl != null && typeof body.imageUrl !== "string") return bad();
  if (body.icon !== undefined && !ICONS.includes(body.icon as string)) return bad();
  if (body.display !== undefined && !DISPLAYS.includes(body.display as string)) return bad();
  for (const k of [...FLAGS, "isActive"]) if (body[k] !== undefined && typeof body[k] !== "boolean") return bad();
  return withHyperdriveClient(hd(env), async (c) => {
    const before = await getAnnouncement(c, body.id as string);
    if (!before) return fail(E.updateNoSuch);
    const sets = [`"updatedAt" = now()`];
    const params: unknown[] = [];
    const set = (col: string, v: unknown) => {
      params.push(v);
      sets.push(`"${col}" = $${params.length}`);
    };
    for (const k of ["title", "text", "display", "icon", ...FLAGS, "isActive"]) if (body[k] !== undefined) set(k, body[k]);
    // upstream passes `ps.imageUrl || null` unconditionally, so omitting imageUrl clears it
    set("imageUrl", (body.imageUrl as string | null | undefined) || null);
    params.push(before.id);
    await c.query(`UPDATE announcement SET ${sets.join(", ")} WHERE id = $${params.length}`, params);
    const after = (await getAnnouncement(c, String(before.id)))!;
    if (g.me) {
      const uid = (before.userId as string | null) ?? null;
      await moderationLogPg(c, g.me, uid ? "updateUserAnnouncement" : "updateGlobalAnnouncement",
        { announcementId: before.id, before: rawRow(before), after: rawRow(after), ...(uid ? await userLogInfo(c, uid) : {}) }, genAidx(Date.now()));
    }
    return noContent();
  });
};

const remove: AnnouncementHandler = async (env, body, ctx) => {
  const g = await gate(env, body, ctx);
  if ("denied" in g) return g.denied;
  if (typeof body.id !== "string" || !body.id) return bad();
  return withHyperdriveClient(hd(env), async (c) => {
    const a = await getAnnouncement(c, body.id as string);
    if (!a) return fail(E.deleteNoSuch);
    await c.query(`DELETE FROM announcement_read WHERE "announcementId" = $1`, [a.id]);
    await c.query(`DELETE FROM announcement WHERE id = $1`, [a.id]);
    if (g.me) {
      const uid = (a.userId as string | null) ?? null;
      await moderationLogPg(c, g.me, uid ? "deleteUserAnnouncement" : "deleteGlobalAnnouncement",
        { announcementId: a.id, announcement: rawRow(a), ...(uid ? await userLogInfo(c, uid) : {}) }, genAidx(Date.now()));
    }
    return noContent();
  });
};

const list: AnnouncementHandler = async (env, body, ctx) => {
  const g = await gate(env, body, ctx);
  if ("denied" in g) return g.denied;
  if (body.status !== undefined && !["all", "active", "archived"].includes(body.status as string)) return bad();
  if (body.userId != null && typeof body.userId !== "string") return bad();
  if (body.limit !== undefined && !(Number.isInteger(body.limit) && (body.limit as number) >= 1 && (body.limit as number) <= 100)) return bad();
  for (const k of ["sinceId", "untilId"]) if (body[k] !== undefined && typeof body[k] !== "string") return bad();
  for (const k of ["sinceDate", "untilDate"]) if (body[k] !== undefined && !Number.isInteger(body[k])) return bad();
  const limit = (body.limit as number | undefined) ?? 10;
  return withHyperdriveClient(hd(env), async (c) => {
    const params: unknown[] = [];
    const pg = pagination(body, params, "a.id");
    const w = [...pg.where];
    const status = (body.status as string | undefined) ?? "active";
    if (status === "active") w.push(`a."isActive" = TRUE`);
    if (status === "archived") w.push(`a."isActive" = FALSE`);
    if (typeof body.userId === "string" && body.userId) {
      params.push(body.userId);
      w.push(`a."userId" = $${params.length}`);
    } else {
      w.push(`a."userId" IS NULL`);
    }
    params.push(limit);
    const r = await c.query(
      `SELECT ${COLS.split(", ").map((x) => `a.${x}`).join(", ")},
         (SELECT count(*)::int FROM announcement_read ar WHERE ar."announcementId" = a.id) AS reads
       FROM announcement a WHERE ${w.length ? w.join(" AND ") : "TRUE"} ORDER BY a.id ${pg.order} LIMIT $${params.length}`,
      params,
    );
    return r.rows.map((a) => ({
      id: String(a.id),
      createdAt: (parseAidxTime(String(a.id)) ?? new Date(0)).toISOString(),
      updatedAt: a.updatedAt ? new Date(String(a.updatedAt)).toISOString() : null,
      title: String(a.title),
      text: String(a.text),
      imageUrl: (a.imageUrl as string | null) ?? null,
      icon: String(a.icon),
      display: String(a.display),
      isActive: Boolean(a.isActive),
      forExistingUsers: Boolean(a.forExistingUsers),
      silence: Boolean(a.silence),
      needConfirmationToRead: Boolean(a.needConfirmationToRead),
      userId: (a.userId as string | null) ?? null,
      reads: Number(a.reads ?? 0),
    }));
  });
};

function pgOnly(h: AnnouncementHandler): AnnouncementHandler {
  return async (env, body, ctx) => {
    if (!env.HYPERDRIVE?.connectionString) {
      return apiErrorResponse({ message: "Hyperdrive required.", code: "HYPERDRIVE_UNBOUND", id: "00000000-0000-4000-8000-0000000000b1", kind: "server" }, 501);
    }
    return h(env, body, ctx);
  };
}

export const announcementAdminHandlers: Record<string, AnnouncementHandler> = {
  "admin/announcements/create": pgOnly(create),
  "admin/announcements/update": pgOnly(update),
  "admin/announcements/delete": pgOnly(remove),
  "admin/announcements/list": pgOnly(list),
};

