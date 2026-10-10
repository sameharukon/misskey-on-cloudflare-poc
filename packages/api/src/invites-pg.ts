/**
 * Invite codes (W7.9) on PG `registration_ticket` (upstream schema): invite/create|delete|limit|list
 * (role policy `canInvite`, limits `inviteLimit` / `inviteLimitCycle` / `inviteExpirationTime`)
 * and admin/invite/create|list (moderators). Codes use upstream generateInviteCode.
 *
 * Consuming a code happens at public signup (`invitationCode` while registration is disabled,
 * `signup-api-pg.ts`).
 */

import { genAidx, genAidxFromDate, parseAidxTime } from "../../id/src/index.js";
import type { ApiEnv } from "./env.js";
import { apiErrorResponse, CREDENTIAL_REQUIRED, INTERNAL_ERROR } from "./errors.js";
import { authenticatePg, extractToken } from "./auth-pg.js";
import { withHyperdriveClient, type PgQueryable } from "./pg.js";
import { getUserPoliciesPg, hasRolePolicyPg, isModeratorPg, moderationLogPg } from "./policies-pg.js";
import { packUsers, pagination } from "./client-endpoints-pg.js";
import { ROLE_PERMISSION_DENIED } from "./emojis-pg.js";
import { adminGate } from "./admin-gate.js";
import { clientError as err, errorResponse as fail, hd, invalidParam as bad } from "./handler-kit.js";

type Ctx = { hasCredential: boolean; request: Request };
type Body = Record<string, unknown>;
export type InviteHandler = (env: ApiEnv, body: Body, ctx: Ctx) => Promise<Response | unknown>;

const E = {
  exceeded: err("EXCEEDED_LIMIT_OF_CREATE_INVITE_CODE", "8b165dd3-6f37-4557-8db1-73175d63c641", "You have exceeded the limit for creating an invitation code."),
  noSuchCode: err("NO_SUCH_INVITE_CODE", "cd4f9ae4-7854-4e3e-8df9-c296f051e634", "No such invite code."),
  cantDelete: err("CAN_NOT_DELETE_INVITE_CODE", "ff17af39-000c-4d4e-abdf-848fa30fc1ce", "You can't delete this invite code."),
  accessDenied: err("ACCESS_DENIED", "5eb8d909-2540-4970-90b8-dd6f86088121", "Access denied."),
  invalidDateTime: err("INVALID_DATE_TIME", "f1380b15-3760-4c6c-a1db-5c3aaf1cbd49", "Invalid date-time format"),
};

const noContent = () => new Response(null, { status: 204 });
const limitOf = (body: Body, def: number) => Math.max(1, Math.min(100, Math.floor(typeof body.limit === "number" ? body.limit : def)));
const iso = (v: unknown) => (v ? new Date(String(v)).toISOString() : null);

/** upstream misc/generate-invite-code: 8 random chars + the current minute in base 32 */
export function generateInviteCode(now = Date.now()): string {
  const CHARS = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const code = Array.from(bytes, (b) => CHARS[Math.min(CHARS.length - 1, Math.floor((b / 0xff) * CHARS.length))]).join("");
  const unique: string[] = [];
  let n = Math.floor(now / 1000 / 60);
  for (;;) {
    unique.push(CHARS[n % CHARS.length]!);
    const t = Math.floor(n / CHARS.length);
    if (!t) break;
    n = t;
  }
  return code + unique.reverse().join("");
}

type Ticket = { id: string; code: string; expiresAt: unknown; createdById: string | null; usedById: string | null; usedAt: unknown };
const COLS = `id, code, "expiresAt", "createdById", "usedById", "usedAt"`;

/** InviteCodeEntityService.packMany (users as UserLite for the viewer). */
async function packTickets(env: ApiEnv, tickets: Ticket[], me: string | null): Promise<Record<string, unknown>[]> {
  const ids = [...new Set(tickets.flatMap((t) => [t.createdById, t.usedById].filter((x): x is string => Boolean(x))))];
  const users = new Map(((await packUsers(env, ids, me, false)) as { id: string }[]).map((u) => [u.id, u]));
  return tickets.map((t) => ({
    id: t.id,
    code: t.code,
    expiresAt: iso(t.expiresAt),
    createdAt: (parseAidxTime(t.id) ?? new Date(0)).toISOString(),
    createdBy: t.createdById ? (users.get(t.createdById) ?? null) : null,
    usedBy: t.usedById ? (users.get(t.usedById) ?? null) : null,
    usedAt: iso(t.usedAt),
    used: Boolean(t.usedAt),
  }));
}

/** requireCredential + requiredRolePolicy: canInvite */
async function inviter(env: ApiEnv, body: Body, ctx: Ctx): Promise<Response | string> {
  if (!ctx.hasCredential) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  const token = extractToken(ctx.request, body);
  const me = token ? (await authenticatePg(env, token))?.user.id : undefined;
  if (!me) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  const ok = await withHyperdriveClient(hd(env), (c) => hasRolePolicyPg(env, c, me, "canInvite"));
  return ok ? me : apiErrorResponse(ROLE_PERMISSION_DENIED, 403);
}

/** Codes the user created within the policy's cycle (upstream: id > gen(now - cycle)). */
async function createdInCycle(c: PgQueryable, me: string, cycleMinutes: number): Promise<number> {
  const since = genAidxFromDate(new Date(Date.now() - cycleMinutes * 60 * 1000));
  return Number((await c.query(`SELECT count(*)::int AS n FROM registration_ticket WHERE "createdById" = $1 AND id > $2`, [me, since])).rows[0]?.n ?? 0);
}

async function insertTicket(c: PgQueryable, me: string | null, expiresAt: Date | null): Promise<Ticket> {
  const t: Ticket = { id: genAidx(Date.now()), code: generateInviteCode(), expiresAt: expiresAt?.toISOString() ?? null, createdById: me, usedById: null, usedAt: null };
  await c.query(`INSERT INTO registration_ticket (id, code, "expiresAt", "createdById") VALUES ($1, $2, $3, $4)`, [t.id, t.code, t.expiresAt, me]);
  return t;
}

// ---------------------------------------------------------------- invite/*

const inviteCreate: InviteHandler = async (env, body, ctx) => {
  const me = await inviter(env, body, ctx);
  if (me instanceof Response) return me;
  const ticket = await withHyperdriveClient(hd(env), async (c) => {
    const p = await getUserPoliciesPg(env, c, me);
    const limit = Number(p.inviteLimit ?? 0);
    if (limit && (await createdInCycle(c, me, Number(p.inviteLimitCycle ?? 0))) >= limit) return null;
    const exp = Number(p.inviteExpirationTime ?? 0);
    return insertTicket(c, me, exp ? new Date(Date.now() + exp * 60 * 1000) : null);
  });
  if (!ticket) return fail(E.exceeded);
  return (await packTickets(env, [ticket], me))[0];
};

const inviteDelete: InviteHandler = async (env, body, ctx) => {
  const me = await inviter(env, body, ctx);
  if (me instanceof Response) return me;
  if (typeof body.inviteId !== "string" || !body.inviteId) return bad();
  return withHyperdriveClient(hd(env), async (c) => {
    const t = (await c.query(`SELECT ${COLS} FROM registration_ticket WHERE id = $1`, [body.inviteId])).rows[0] as Ticket | undefined;
    const isMod = await isModeratorPg(env, c, me);
    if (!t) return fail(E.noSuchCode);
    if (t.createdById !== me && !isMod) return fail(E.accessDenied);
    if (t.usedAt && !isMod) return fail(E.cantDelete);
    await c.query(`DELETE FROM registration_ticket WHERE id = $1`, [t.id]);
    return noContent();
  });
};

const inviteLimit: InviteHandler = async (env, body, ctx) => {
  const me = await inviter(env, body, ctx);
  if (me instanceof Response) return me;
  return withHyperdriveClient(hd(env), async (c) => {
    const p = await getUserPoliciesPg(env, c, me);
    const limit = Number(p.inviteLimit ?? 0);
    if (!limit) return { remaining: null };
    return { remaining: Math.max(0, limit - (await createdInCycle(c, me, Number(p.inviteLimitCycle ?? 0)))) };
  });
};

const inviteList: InviteHandler = async (env, body, ctx) => {
  const me = await inviter(env, body, ctx);
  if (me instanceof Response) return me;
  const rows = await withHyperdriveClient(hd(env), async (c) => {
    const params: unknown[] = [me];
    const pg = pagination(body, params, "t.id");
    params.push(limitOf(body, 30));
    return (await c.query(
      `SELECT ${COLS.split(", ").map((x) => `t.${x}`).join(", ")} FROM registration_ticket t
       WHERE ${[`t."createdById" = $1`, ...pg.where].join(" AND ")} ORDER BY t.id ${pg.order} LIMIT $${params.length}`,
      params,
    )).rows as Ticket[];
  });
  return packTickets(env, rows, me);
};

// ---------------------------------------------------------------- admin/invite/*

async function modGate(env: ApiEnv, body: Body, ctx: Ctx): Promise<{ denied: Response } | { me: string | null }> {
  const denied = await adminGate(ctx.request, env as never, body, "moderator");
  if (denied) return { denied };
  const token = extractToken(ctx.request, body);
  return { me: token ? ((await authenticatePg(env, token))?.user.id ?? null) : null };
}

const adminCreate: InviteHandler = async (env, body, ctx) => {
  const g = await modGate(env, body, ctx);
  if ("denied" in g) return g.denied;
  if (body.count !== undefined && (typeof body.count !== "number" || !Number.isInteger(body.count) || body.count < 1 || body.count > 100)) return bad();
  if (body.expiresAt != null && typeof body.expiresAt !== "string") return bad();
  if (typeof body.expiresAt === "string" && body.expiresAt && Number.isNaN(Date.parse(body.expiresAt))) return fail(E.invalidDateTime);
  const expiresAt = typeof body.expiresAt === "string" && body.expiresAt ? new Date(body.expiresAt) : null;
  const tickets = await withHyperdriveClient(hd(env), async (c) => {
    const out: Ticket[] = [];
    for (let i = 0; i < ((body.count as number | undefined) ?? 1); i++) out.push(await insertTicket(c, g.me, expiresAt));
    if (g.me) await moderationLogPg(c, g.me, "createInvitation", { invitations: out }, genAidx(Date.now()));
    return out;
  });
  return packTickets(env, tickets, g.me);
};

const ADMIN_SORTS: Record<string, string> = {
  "+createdAt": "t.id DESC",
  "-createdAt": "t.id ASC",
  "+usedAt": `t."usedAt" DESC NULLS LAST`,
  "-usedAt": `t."usedAt" ASC NULLS FIRST`,
};

const adminList: InviteHandler = async (env, body, ctx) => {
  const g = await modGate(env, body, ctx);
  if ("denied" in g) return g.denied;
  if (body.type !== undefined && !["unused", "used", "expired", "all"].includes(body.type as string)) return bad();
  if (body.sort !== undefined && !ADMIN_SORTS[body.sort as string]) return bad();
  if (body.limit !== undefined && !(Number.isInteger(body.limit) && (body.limit as number) >= 1 && (body.limit as number) <= 100)) return bad();
  if (body.offset !== undefined && !Number.isInteger(body.offset)) return bad();
  const offset = (body.offset as number | undefined) ?? 0;
  if (offset < 0) return apiErrorResponse(INTERNAL_ERROR, 500); // no minimum upstream: PG rejects a negative OFFSET
  const rows = await withHyperdriveClient(hd(env), async (c) => {
    const w: string[] = [];
    if (body.type === "unused") w.push(`t."usedById" IS NULL`);
    if (body.type === "used") w.push(`t."usedById" IS NOT NULL`);
    if (body.type === "expired") w.push(`t."expiresAt" < now()`);
    return (await c.query(
      `SELECT ${COLS.split(", ").map((x) => `t.${x}`).join(", ")} FROM registration_ticket t
       ${w.length ? `WHERE ${w.join(" AND ")}` : ""} ORDER BY ${ADMIN_SORTS[body.sort as string] ?? "t.id DESC"} LIMIT $1 OFFSET $2`,
      [(body.limit as number | undefined) ?? 30, offset],
    )).rows as Ticket[];
  });
  return packTickets(env, rows, g.me);
};

// ---------------------------------------------------------------- registry

function pgOnly(h: InviteHandler): InviteHandler {
  return async (env, body, ctx) => {
    if (!env.HYPERDRIVE?.connectionString) {
      return apiErrorResponse({ message: "Hyperdrive required.", code: "HYPERDRIVE_UNBOUND", id: "00000000-0000-4000-8000-0000000000b1", kind: "server" }, 501);
    }
    return h(env, body, ctx);
  };
}

const RAW: Record<string, InviteHandler> = {
  "invite/create": inviteCreate,
  "invite/delete": inviteDelete,
  "invite/limit": inviteLimit,
  "invite/list": inviteList,
  "admin/invite/create": adminCreate,
  "admin/invite/list": adminList,
};

export const inviteHandlers: Record<string, InviteHandler> = Object.fromEntries(Object.entries(RAW).map(([k, h]) => [k, pgOnly(h)]));

