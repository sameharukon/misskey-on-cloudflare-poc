/**
 * Abuse reports (W7.9) on PG `abuse_user_report` (upstream schema): users/report-abuse and
 * admin/abuse-user-reports|resolve-abuse-user-report|update-abuse-user-report|
 * forward-abuse-user-report, following upstream AbuseReportService.
 *
 * New reports are pushed as `newAbuseUserReport` on the `admin` stream channel of every
 * moderator (upstream notifyAdminStream) and, with resolutions, to system webhooks
 * (`abuseReport` / `abuseReportResolved`, system-webhooks-pg.ts); new reports are also mailed to
 * `email` recipients and `meta.email` (notifyAbuseReportMail). `forward` runs upstream's
 * checks and marks the report forwarded, but sends no ActivityPub Flag while federation is off.
 */

import { genAidx, parseAidxTime } from "../../id/src/index.js";
import type { ApiEnv } from "./env.js";
import { apiErrorResponse, CREDENTIAL_REQUIRED, INTERNAL_ERROR, type ApiErrorBody } from "./errors.js";
import { authenticatePg, extractToken } from "./auth-pg.js";
import { withHyperdriveClient, type PgQueryable } from "./pg.js";
import { isAdministratorPg, moderationLogPg } from "./policies-pg.js";
import { packUsers, pagination } from "./client-endpoints-pg.js";
import { publishToUserStream } from "./stream-publish.js";
import { getRootUserId } from "./users-pg.js";
import { adminGate } from "./admin-gate.js";
import { notifyAbuseReportMail, notifyAbuseReportSystemWebhook } from "./system-webhooks-pg.js";
import { clientError as err, errorResponse as fail, hd, invalidParam as bad } from "./handler-kit.js";

type Ctx = { hasCredential: boolean; request: Request };
type Body = Record<string, unknown>;
export type AbuseHandler = (env: ApiEnv, body: Body, ctx: Ctx) => Promise<Response | unknown>;

const noSuchReport = (id: string): ApiErrorBody => ({ message: "No such abuse report.", code: "NO_SUCH_ABUSE_REPORT", id, kind: "server" });
const E = {
  noSuchUser: err("NO_SUCH_USER", "1acefcb5-0959-43fd-9685-b48305736cb5", "No such user."),
  cannotReportYourself: err("CANNOT_REPORT_YOURSELF", "1e13149e-b1e8-43cf-902e-c01dbfcb202f", "Cannot report yourself."),
  cannotReportAdmin: err("CANNOT_REPORT_THE_ADMIN", "35e166f5-05fb-4f87-a2d5-adb42676d48f", "Cannot report the admin."),
  resolve: noSuchReport("ac3794dd-2ce4-d878-e546-73c60c06b398"),
  update: noSuchReport("15f51cf5-46d1-4b1d-a618-b35bcbed0662"),
  forward: noSuchReport("8763e21b-d9bc-40be-acf6-54c1a6986493"),
};

const str = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : undefined);
// upstream declares these errors with httpStatusCode 404
const notFound = (e: ApiErrorBody) => apiErrorResponse(e, 404);
const noContent = () => new Response(null, { status: 204 });

async function gate(env: ApiEnv, body: Body, ctx: Ctx): Promise<{ denied: Response } | { me: string | null }> {
  const denied = await adminGate(ctx.request, env as never, body, "moderator");
  if (denied) return { denied };
  const token = extractToken(ctx.request, body);
  return { me: token ? ((await authenticatePg(env, token))?.user.id ?? null) : null };
}

type ReportRow = Record<string, unknown> & { id: string; reporterId: string; targetUserId: string; assigneeId: string | null };

async function getReport(c: PgQueryable, id: string): Promise<ReportRow | null> {
  return ((await c.query(`SELECT * FROM abuse_user_report WHERE id = $1`, [id])).rows[0] as ReportRow | undefined) ?? null;
}

/** AbuseUserReportEntityService.packMany (users as UserDetailedNotMe). */
async function packReports(env: ApiEnv, reports: ReportRow[]): Promise<Record<string, unknown>[]> {
  const ids = [...new Set(reports.flatMap((r) => [r.reporterId, r.targetUserId, r.assigneeId].filter((x): x is string => Boolean(x))))];
  const users = new Map(((await packUsers(env, ids, null, true)) as { id: string }[]).map((u) => [u.id, u]));
  return reports.map((r) => ({
    id: r.id,
    createdAt: (parseAidxTime(r.id) ?? new Date(0)).toISOString(),
    comment: String(r.comment),
    resolved: Boolean(r.resolved),
    reporterId: r.reporterId,
    targetUserId: r.targetUserId,
    assigneeId: r.assigneeId ?? null,
    reporter: users.get(r.reporterId) ?? null,
    targetUser: users.get(r.targetUserId) ?? null,
    assignee: r.assigneeId ? (users.get(r.assigneeId) ?? null) : null,
    forwarded: Boolean(r.forwarded),
    resolvedAs: (r.resolvedAs as string | null) ?? null,
    moderationNote: String(r.moderationNote ?? ""),
  }));
}

/**
 * upstream RoleService.getModeratorIds({ includeAdmins: true }); the root user is added because
 * it passes every moderator check here without holding a role.
 */
export async function moderatorIds(env: ApiEnv, c: PgQueryable): Promise<string[]> {
  const r = await c.query(
    `SELECT DISTINCT ra."userId" FROM role_assignment ra JOIN role r ON r.id = ra."roleId"
     WHERE (ra."expiresAt" IS NULL OR ra."expiresAt" > now()) AND (r."isModerator" OR r."isAdministrator")`,
  );
  const ids = new Set(r.rows.map((x) => String(x.userId)));
  const root = await getRootUserId(env);
  if (root) ids.add(root);
  return [...ids];
}

// ---------------------------------------------------------------- users/report-abuse

const reportAbuse: AbuseHandler = async (env, body, ctx) => {
  if (!ctx.hasCredential) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  const token = extractToken(ctx.request, body);
  const me = token ? (await authenticatePg(env, token))?.user.id : undefined;
  if (!me) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  const userId = str(body.userId);
  if (!userId || typeof body.comment !== "string" || body.comment.length < 1 || body.comment.length > 2048) return bad();
  const out = await withHyperdriveClient(hd(env), async (c) => {
    const target = (await c.query(`SELECT id, host FROM "user" WHERE id = $1`, [userId])).rows[0];
    if (!target) return fail(E.noSuchUser);
    if (String(target.id) === me) return fail(E.cannotReportYourself);
    if (await isAdministratorPg(env, c, String(target.id))) return fail(E.cannotReportAdmin);
    const id = genAidx(Date.now());
    await c.query(
      `INSERT INTO abuse_user_report (id, "targetUserId", "targetUserHost", "reporterId", "reporterHost", comment) VALUES ($1, $2, $3, $4, NULL, $5)`,
      [id, target.id, target.host ?? null, me, body.comment],
    );
    return { report: (await getReport(c, id))!, mods: await moderatorIds(env, c) };
  });
  if (out instanceof Response) return out;
  // notifyAdminStream: each moderator's `admin` channel
  try {
    const event = { id: out.report.id, targetUserId: out.report.targetUserId, reporterId: out.report.reporterId, comment: out.report.comment };
    await Promise.all(out.mods.map((m) => publishToUserStream(env, m, "admin", "newAbuseUserReport", event)));
  } catch {
    /* streaming is best-effort */
  }
  await notifyAbuseReportSystemWebhook(env, [out.report.id], "abuseReport");
  await notifyAbuseReportMail(env, [out.report.id]);
  return noContent();
};

// ---------------------------------------------------------------- admin

const ORIGINS = ["combined", "local", "remote"];

const list: AbuseHandler = async (env, body, ctx) => {
  const g = await gate(env, body, ctx);
  if ("denied" in g) return g.denied;
  if (body.state != null && typeof body.state !== "string") return bad();
  for (const k of ["reporterOrigin", "targetUserOrigin"]) if (body[k] !== undefined && !ORIGINS.includes(body[k] as string)) return bad();
  if (body.limit !== undefined && !(Number.isInteger(body.limit) && (body.limit as number) >= 1 && (body.limit as number) <= 100)) return bad();
  for (const k of ["sinceId", "untilId"]) if (body[k] !== undefined && typeof body[k] !== "string") return bad();
  for (const k of ["sinceDate", "untilDate"]) if (body[k] !== undefined && !Number.isInteger(body[k])) return bad();
  const limit = (body.limit as number | undefined) ?? 10;
  const rows = await withHyperdriveClient(hd(env), async (c) => {
    const params: unknown[] = [];
    const pg = pagination(body, params, "r.id");
    const w = [...pg.where];
    if (body.state === "resolved") w.push(`r.resolved = TRUE`);
    if (body.state === "unresolved") w.push(`r.resolved = FALSE`);
    if (body.reporterOrigin === "local") w.push(`r."reporterHost" IS NULL`);
    if (body.reporterOrigin === "remote") w.push(`r."reporterHost" IS NOT NULL`);
    if (body.targetUserOrigin === "local") w.push(`r."targetUserHost" IS NULL`);
    if (body.targetUserOrigin === "remote") w.push(`r."targetUserHost" IS NOT NULL`);
    params.push(limit);
    return (await c.query(
      `SELECT r.* FROM abuse_user_report r ${w.length ? `WHERE ${w.join(" AND ")}` : ""} ORDER BY r.id ${pg.order} LIMIT $${params.length}`,
      params,
    )).rows as ReportRow[];
  });
  return packReports(env, rows);
};

const resolve: AbuseHandler = async (env, body, ctx) => {
  const g = await gate(env, body, ctx);
  if ("denied" in g) return g.denied;
  const reportId = str(body.reportId);
  if (!reportId || (body.resolvedAs != null && body.resolvedAs !== "accept" && body.resolvedAs !== "reject")) return bad();
  const res = await withHyperdriveClient(hd(env), async (c) => {
    const report = await getReport(c, reportId);
    if (!report) return notFound(E.resolve);
    const resolvedAs = (body.resolvedAs as string | null | undefined) ?? null;
    await c.query(`UPDATE abuse_user_report SET resolved = TRUE, "assigneeId" = $2, "resolvedAs" = $3 WHERE id = $1`, [report.id, g.me, resolvedAs]);
    if (g.me) await moderationLogPg(c, g.me, "resolveAbuseReport", { reportId: report.id, report: report, resolvedAs }, genAidx(Date.now()));
    return null;
  });
  if (res) return res;
  await notifyAbuseReportSystemWebhook(env, [reportId], "abuseReportResolved");
  return noContent();
};

const update: AbuseHandler = async (env, body, ctx) => {
  const g = await gate(env, body, ctx);
  if ("denied" in g) return g.denied;
  const reportId = str(body.reportId);
  if (!reportId || (body.moderationNote !== undefined && typeof body.moderationNote !== "string")) return bad();
  return withHyperdriveClient(hd(env), async (c) => {
    const report = await getReport(c, reportId);
    if (!report) return notFound(E.update);
    if (typeof body.moderationNote === "string") {
      await c.query(`UPDATE abuse_user_report SET "moderationNote" = $2 WHERE id = $1`, [report.id, body.moderationNote]);
      if (g.me && report.moderationNote !== body.moderationNote) {
        await moderationLogPg(c, g.me, "updateAbuseReportNote", {
          reportId: report.id, report: report, before: report.moderationNote, after: body.moderationNote,
        }, genAidx(Date.now()));
      }
    }
    return noContent();
  });
};

const forward: AbuseHandler = async (env, body, ctx) => {
  const g = await gate(env, body, ctx);
  if ("denied" in g) return g.denied;
  const reportId = str(body.reportId);
  if (!reportId) return bad();
  return withHyperdriveClient(hd(env), async (c) => {
    const report = await getReport(c, reportId);
    if (!report) return notFound(E.forward);
    // upstream: Error('The target user host is null.') / Error('The report has already been forwarded.')
    if (report.targetUserHost == null || report.forwarded) return apiErrorResponse(INTERNAL_ERROR, 500);
    await c.query(`UPDATE abuse_user_report SET forwarded = TRUE WHERE id = $1`, [report.id]);
    // Flag from the instance actor (system account `actor`) to the target's inbox
    const { fetchSystemAccountC } = await import("./ap/relay.js");
    const actorId = await fetchSystemAccountC(c, "actor");
    const target = (await c.query(`SELECT uri, inbox FROM "user" WHERE id = $1`, [report.targetUserId])).rows[0];
    if (!target) return apiErrorResponse(INTERNAL_ERROR, 500); // findOneByOrFail
    const { enqueueDeliver, localActorUri } = await import("./ap/deliver.js");
    await enqueueDeliver(env, actorId, [target.inbox as string | null], {
      type: "Flag",
      actor: localActorUri(env, actorId),
      content: report.comment,
      object: target.uri,
    }).catch((e) => console.warn(`abuse report forward failed: ${e instanceof Error ? e.message : String(e)}`));
    if (g.me) await moderationLogPg(c, g.me, "forwardAbuseReport", { reportId: report.id, report: report }, genAidx(Date.now()));
    return noContent();
  });
};

// ---------------------------------------------------------------- registry

function pgOnly(h: AbuseHandler): AbuseHandler {
  return async (env, body, ctx) => {
    if (!env.HYPERDRIVE?.connectionString) {
      return apiErrorResponse({ message: "Hyperdrive required.", code: "HYPERDRIVE_UNBOUND", id: "00000000-0000-4000-8000-0000000000b1", kind: "server" }, 501);
    }
    return h(env, body, ctx);
  };
}

const RAW: Record<string, AbuseHandler> = {
  "users/report-abuse": reportAbuse,
  "admin/abuse-user-reports": list,
  "admin/resolve-abuse-user-report": resolve,
  "admin/update-abuse-user-report": update,
  "admin/forward-abuse-user-report": forward,
};

export const abuseHandlers: Record<string, AbuseHandler> = Object.fromEntries(Object.entries(RAW).map(([k, h]) => [k, pgOnly(h)]));

