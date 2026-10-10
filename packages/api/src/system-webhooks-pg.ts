/**
 * System webhooks and abuse-report notification recipients on PG `system_webhook` /
 * `abuse_report_notification_recipient` (upstream schema): admin/system-webhook/create|delete|
 * list|show|test|update and admin/abuse-report/notification-recipient/create|delete|list|show|
 * update, following upstream SystemWebhookService / AbuseReportNotificationService and their
 * entity services. Moderator only, with moderation_log entries as upstream.
 *
 * Dispatch (SystemWebhookService.enqueueSystemWebhook): active system webhooks subscribed to the
 * event are delivered through the user-webhook queue `mk-webhook-deliver` as
 * `{ kind: "systemWebhook" }` messages (SystemWebhookDeliverProcessorService: same headers, body
 * without `userId`, `latestSentAt` / `latestStatus` recorded on `system_webhook`). Events fired:
 * `abuseReport` (users/report-abuse), `abuseReportResolved` (admin/resolve-abuse-user-report),
 * `userCreated` (signup). As upstream, abuse-report events skip webhooks linked to an inactive
 * `webhook` recipient. `inactiveModeratorsWarning` / `inactiveModeratorsInvitationOnlyChanged`
 * come from the hourly moderator-activity check (maintenance-pg.ts). `email` recipients get new
 * reports by mail (notifyAbuseReportMail, `email.ts`).
 */

import { genAidx } from "../../id/src/index.js";
import type { ApiEnv } from "./env.js";
import { apiErrorResponse, INTERNAL_ERROR, type ApiErrorBody } from "./errors.js";
import { authenticatePg, extractToken } from "./auth-pg.js";
import { withHyperdriveClient, type PgQueryable } from "./pg.js";
import { moderationLogPg } from "./policies-pg.js";
import { packUsers } from "./client-endpoints-pg.js";
import { sendToQueue, type SystemWebhookDeliverMessage } from "./webhooks-pg.js";
import { adminGate } from "./admin-gate.js";
import { errorResponse as fail, hd, invalidParam as bad } from "./handler-kit.js";

type Ctx = { hasCredential: boolean; request: Request };
type Body = Record<string, unknown>;
export type SystemWebhookHandler = (env: ApiEnv, body: Body, ctx: Ctx) => Promise<Response | unknown>;

export const SYSTEM_WEBHOOK_EVENT_TYPES = [
  "abuseReport",
  "abuseReportResolved",
  "userCreated",
  "inactiveModeratorsWarning",
  "inactiveModeratorsInvitationOnlyChanged",
] as const;
export type SystemWebhookEventType = (typeof SYSTEM_WEBHOOK_EVENT_TYPES)[number];
const RECIPIENT_METHODS = ["email", "webhook"] as const;

const err = (code: string, id: string, message: string, kind: "client" | "server" = "client"): ApiErrorBody => ({ message, code, id, kind });
const E = {
  noSuchSystemWebhook: err("NO_SUCH_SYSTEM_WEBHOOK", "38dd1ffe-04b4-6ff5-d8ba-4e6a6ae22c9d", "No such SystemWebhook.", "server"),
  noSuchWebhook: err("NO_SUCH_WEBHOOK", "0c52149c-e913-18f8-5dc7-74870bfe0cf9", "No such webhook."),
  correlationCheckEmail: err("CORRELATION_CHECK_EMAIL", "348bb8ae-575a-6fe9-4327-5811999def8f", 'If "method" is email, "userId" must be set.'),
  correlationCheckWebhook: err("CORRELATION_CHECK_WEBHOOK", "b0c15051-de2d-29ef-260c-9585cddd701a", 'If "method" is webhook, "systemWebhookId" must be set.'),
  emailAddressNotSet: err("EMAIL_ADDRESS_NOT_SET", "7cc1d85e-2f58-fc31-b644-3de8d0d3421f", "Email address is not set."),
  noSuchRecipient: err("NO_SUCH_RECIPIENT", "013de6a8-f757-04cb-4d73-cc2a7e3368e4", "No such recipient.", "server"),
};

// upstream declares these errors with httpStatusCode 404
const notFound = (e: ApiErrorBody) => apiErrorResponse(e, 404);
// upstream findOneByOrFail / FK violations surface as INTERNAL_ERROR
const internal = () => apiErrorResponse(INTERNAL_ERROR, 500);
const noContent = () => new Response(null, { status: 204 });

async function gate(env: ApiEnv, body: Body, ctx: Ctx): Promise<{ denied: Response } | { me: string | null }> {
  const denied = await adminGate(ctx.request, env as never, body, "moderator");
  if (denied) return { denied };
  const token = extractToken(ctx.request, body);
  return { me: token ? ((await authenticatePg(env, token))?.user.id ?? null) : null };
}

const len = (s: string) => [...s].length;
const strIn = (v: unknown, min: number, max: number) => typeof v === "string" && len(v) >= min && len(v) <= max;
const enumArray = (v: unknown, values: readonly string[]) => Array.isArray(v) && v.every((x) => values.includes(x as string));
const iso = (v: unknown) => (v == null ? null : new Date(v as string).toISOString());

// ---------------------------------------------------------------- system webhooks

type SystemWebhookRow = Record<string, unknown> & {
  id: string; isActive: boolean; updatedAt: unknown; latestSentAt: unknown; latestStatus: number | null; name: string; on: string[]; url: string; secret: string;
};

/** SystemWebhookEntityService.pack */
export function packSystemWebhook(w: SystemWebhookRow) {
  return {
    id: w.id,
    isActive: Boolean(w.isActive),
    updatedAt: iso(w.updatedAt)!,
    latestSentAt: iso(w.latestSentAt),
    latestStatus: w.latestStatus == null ? null : Number(w.latestStatus),
    name: w.name,
    on: w.on ?? [],
    url: w.url,
    secret: w.secret,
  };
}

const byId = <T extends { id: string }>(a: T, b: T) => a.id.localeCompare(b.id);

/** SystemWebhookService.fetchSystemWebhooks */
async function fetchSystemWebhooks(c: PgQueryable, p: { ids?: string[]; isActive?: boolean; on?: string[] } = {}): Promise<SystemWebhookRow[]> {
  const params: unknown[] = [];
  const w: string[] = [];
  if (p.ids && p.ids.length > 0) w.push(`id = ANY($${params.push(p.ids)}::varchar[])`);
  if (p.isActive !== undefined) w.push(`"isActive" = $${params.push(p.isActive)}`);
  if (p.on && p.on.length > 0) w.push(`$${params.push(p.on)}::varchar[] <@ "on"`);
  return (await c.query(`SELECT * FROM system_webhook ${w.length ? `WHERE ${w.join(" AND ")}` : ""} ORDER BY id`, params)).rows as SystemWebhookRow[];
}

async function getSystemWebhook(c: PgQueryable, id: string): Promise<SystemWebhookRow | null> {
  return (await fetchSystemWebhooks(c, { ids: [id] }))[0] ?? null;
}

function webhookParams(body: Body): boolean {
  if (typeof body.isActive !== "boolean" || !strIn(body.name, 1, 255) || !enumArray(body.on, SYSTEM_WEBHOOK_EVENT_TYPES) || !strIn(body.url, 1, 1024)) return false;
  return body.secret === undefined || strIn(body.secret, 0, 1024);
}

const swCreate: SystemWebhookHandler = async (env, body, ctx) => {
  const g = await gate(env, body, ctx);
  if ("denied" in g) return g.denied;
  if (!webhookParams(body)) return bad();
  return withHyperdriveClient(hd(env), async (c) => {
    const id = genAidx(Date.now());
    await c.query(`INSERT INTO system_webhook (id, "isActive", name, "on", url, secret) VALUES ($1, $2, $3, $4::varchar[], $5, $6)`, [
      id, body.isActive, body.name, body.on, body.url, (body.secret as string | undefined) ?? "",
    ]);
    const webhook = (await getSystemWebhook(c, id))!;
    if (g.me) await moderationLogPg(c, g.me, "createSystemWebhook", { systemWebhookId: id, webhook: webhook }, genAidx(Date.now()));
    return packSystemWebhook(webhook);
  });
};

const swUpdate: SystemWebhookHandler = async (env, body, ctx) => {
  const g = await gate(env, body, ctx);
  if ("denied" in g) return g.denied;
  if (typeof body.id !== "string" || !webhookParams(body)) return bad();
  return withHyperdriveClient(hd(env), async (c) => {
    const before = await getSystemWebhook(c, body.id as string);
    if (!before) return internal();
    // `secret` defaults to '' upstream, so omitting it clears the secret
    await c.query(`UPDATE system_webhook SET "updatedAt" = now(), "isActive" = $2, name = $3, "on" = $4::varchar[], url = $5, secret = $6 WHERE id = $1`, [
      before.id, body.isActive, body.name, body.on, body.url, (body.secret as string | undefined) ?? "",
    ]);
    const after = (await getSystemWebhook(c, before.id))!;
    if (g.me) await moderationLogPg(c, g.me, "updateSystemWebhook", { systemWebhookId: before.id, before: before, after: after }, genAidx(Date.now()));
    return packSystemWebhook(after);
  });
};

const swDelete: SystemWebhookHandler = async (env, body, ctx) => {
  const g = await gate(env, body, ctx);
  if ("denied" in g) return g.denied;
  if (typeof body.id !== "string") return bad();
  return withHyperdriveClient(hd(env), async (c) => {
    const webhook = await getSystemWebhook(c, body.id as string);
    if (!webhook) return internal();
    // recipients pointing at it go with it (FK ON DELETE CASCADE)
    await c.query(`DELETE FROM system_webhook WHERE id = $1`, [webhook.id]);
    if (g.me) await moderationLogPg(c, g.me, "deleteSystemWebhook", { systemWebhookId: webhook.id, webhook: webhook }, genAidx(Date.now()));
    return noContent();
  });
};

const swList: SystemWebhookHandler = async (env, body, ctx) => {
  const g = await gate(env, body, ctx);
  if ("denied" in g) return g.denied;
  if (body.isActive !== undefined && typeof body.isActive !== "boolean") return bad();
  if (body.on !== undefined && !enumArray(body.on, SYSTEM_WEBHOOK_EVENT_TYPES)) return bad();
  const rows = await withHyperdriveClient(hd(env), (c) => fetchSystemWebhooks(c, { isActive: body.isActive as boolean | undefined, on: body.on as string[] | undefined }));
  return rows.map(packSystemWebhook).sort(byId);
};

const swShow: SystemWebhookHandler = async (env, body, ctx) => {
  const g = await gate(env, body, ctx);
  if ("denied" in g) return g.denied;
  if (typeof body.id !== "string") return bad();
  const w = await withHyperdriveClient(hd(env), (c) => getSystemWebhook(c, body.id as string));
  return w ? packSystemWebhook(w) : notFound(E.noSuchSystemWebhook);
};

/** WebhookTestService (system part): dummy users / report, not in the database. */
function dummyUserLite(n: 1 | 2 | 3) {
  return {
    id: `dummy-user-${n}`, name: `DummyUser${n}`, username: `dummy${n}`, host: null, avatarUrl: "", avatarBlurhash: null, avatarDecorations: [],
    isBot: false, isCat: true, emojis: {}, onlineStatus: "active", badgeRoles: [],
  };
}

function dummyAbuseReport(override: Record<string, unknown>) {
  return {
    id: "dummy-abuse-report1", targetUserId: "dummy-target-user", targetUser: null, reporterId: "dummy-reporter-user", reporter: null,
    assigneeId: null, assignee: null, resolved: false, forwarded: false, comment: "This is a dummy report for testing purposes.",
    targetUserHost: null, reporterHost: null, resolvedAs: null, moderationNote: "foo", ...override,
  };
}

function dummySystemPayload(type: SystemWebhookEventType): unknown {
  const [u1, u2, u3] = [dummyUserLite(1), dummyUserLite(2), dummyUserLite(3)];
  switch (type) {
    case "abuseReport":
      return dummyAbuseReport({ targetUserId: u1.id, targetUser: u1, reporterId: u2.id, reporter: u2 });
    case "abuseReportResolved":
      return dummyAbuseReport({ targetUserId: u1.id, targetUser: u1, reporterId: u2.id, reporter: u2, assigneeId: u3.id, assignee: u3, resolved: true });
    case "userCreated":
      return u1;
    case "inactiveModeratorsWarning":
      return { remainingTime: { time: 100000, asDays: 1, asHours: 24 } };
    case "inactiveModeratorsInvitationOnlyChanged":
      return {};
  }
}

const swTest: SystemWebhookHandler = async (env, body, ctx) => {
  const g = await gate(env, body, ctx);
  if ("denied" in g) return g.denied;
  if (typeof body.webhookId !== "string" || !(SYSTEM_WEBHOOK_EVENT_TYPES as readonly string[]).includes(body.type as string)) return bad();
  const o = body.override;
  if (o !== undefined && (!o || typeof o !== "object" || Array.isArray(o))) return bad();
  const override = (o ?? {}) as { url?: unknown; secret?: unknown };
  if ((override.url !== undefined && typeof override.url !== "string") || (override.secret !== undefined && typeof override.secret !== "string")) return bad();
  const w = await withHyperdriveClient(hd(env), (c) => getSystemWebhook(c, body.webhookId as string));
  if (!w) return fail(E.noSuchWebhook);
  // as upstream: straight to the queue (no isActive / `on` check), one attempt
  await sendToQueue(env, {
    ...systemMessage({ ...w, url: (override.url as string | undefined) ?? w.url, secret: (override.secret as string | undefined) ?? w.secret }, body.type as SystemWebhookEventType, dummySystemPayload(body.type as SystemWebhookEventType)),
    maxAttempts: 1,
  });
  return noContent();
};

// ---------------------------------------------------------------- dispatch

function systemMessage(w: { id: string; url: string; secret: string }, type: SystemWebhookEventType, content: unknown): SystemWebhookDeliverMessage {
  return { kind: "systemWebhook", webhookId: w.id, to: w.url, secret: w.secret, type, content, createdAt: Date.now(), eventId: crypto.randomUUID(), maxAttempts: 4 };
}

/**
 * SystemWebhookService.enqueueSystemWebhook. `content` may be a thunk so payloads are only
 * packed when a webhook listens. Best-effort: never fails the calling action.
 */
export async function enqueueSystemWebhook(
  env: ApiEnv,
  type: SystemWebhookEventType,
  content: unknown | (() => Promise<unknown>),
  opts: { excludes?: string[] } = {},
): Promise<number> {
  try {
    if (!env.HYPERDRIVE?.connectionString) return 0;
    const hooks = (await withHyperdriveClient(hd(env), (c) => fetchSystemWebhooks(c, { isActive: true, on: [type] })))
      .filter((w) => !opts.excludes?.includes(w.id));
    if (!hooks.length) return 0;
    const payload = typeof content === "function" ? await (content as () => Promise<unknown>)() : content;
    for (const w of hooks) await sendToQueue(env, systemMessage(w, type, payload));
    return hooks.length;
  } catch (e) {
    console.warn(`system webhook enqueue failed: ${e instanceof Error ? e.message : String(e)}`);
    return 0;
  }
}

/**
 * AbuseReportNotificationService.notifySystemWebhook: each report (fresh row, users as UserLite)
 * to the active webhooks for `type`, minus those linked to an inactive `webhook` recipient.
 * Mail: notifyAbuseReportMail below.
 */
export async function notifyAbuseReportSystemWebhook(env: ApiEnv, reportIds: string[], type: "abuseReport" | "abuseReportResolved"): Promise<void> {
  try {
    if (!reportIds.length || !env.HYPERDRIVE?.connectionString) return;
    const { reports, excludes } = await withHyperdriveClient(hd(env), async (c) => ({
      reports: (await c.query(`SELECT * FROM abuse_user_report WHERE id = ANY($1::varchar[]) ORDER BY id`, [reportIds])).rows,
      excludes: (await fetchRecipients(env, c, { method: ["webhook"] }))
        .filter((r) => !r.isActive && r.systemWebhookId != null)
        .map((r) => r.systemWebhookId!),
    }));
    for (const report of reports) {
      await enqueueSystemWebhook(env, type, async () => {
        const ids = [report.reporterId, report.targetUserId, report.assigneeId].filter((x): x is string => typeof x === "string");
        const users = new Map(((await packUsers(env, [...new Set(ids)], null, false)) as { id: string }[]).map((u) => [u.id, u]));
        return {
          ...(report as Record<string, unknown>),
          reporter: users.get(String(report.reporterId)) ?? null,
          targetUser: users.get(String(report.targetUserId)) ?? null,
          assignee: report.assigneeId ? (users.get(String(report.assigneeId)) ?? null) : null,
        };
      }, { excludes });
    }
  } catch (e) {
    console.warn(`abuse report system webhook failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * AbuseReportNotificationService.notifyMail: each report's comment to the verified address of
 * every active `email` recipient (still a moderator) and to `meta.email`. One `sendEmail` job per
 * mail (upstream sends inline).
 */
export async function notifyAbuseReportMail(env: ApiEnv, reportIds: string[]): Promise<void> {
  // As upstream AbuseReportNotificationService.notifyMail: sent synchronously (awaited by the
  // report), so a failed send fails users/report-abuse as it does upstream.
  if (!reportIds.length || !env.HYPERDRIVE?.connectionString) return;
  const { metaJson, runSendEmailJob } = await import("./email.js");
  const { default: sanitizeHtml } = await import("sanitize-html");
  const { comments, addresses } = await withHyperdriveClient(hd(env), async (c) => {
    const recipients = (await fetchRecipients(env, c, { method: ["email"] })).filter((r) => r.isActive && r.userId != null);
    const addresses: string[] = [];
    if (recipients.length) {
      const profiles = (await c.query(
        `SELECT "userId", email, "emailVerified" FROM user_profile WHERE "userId" = ANY($1::varchar[])`,
        [recipients.map((r) => r.userId)],
      )).rows;
      const byUser = new Map(profiles.map((p) => [String(p.userId), p]));
      for (const r of recipients) {
        const p = byUser.get(r.userId!);
        if (p?.emailVerified && typeof p.email === "string" && p.email) addresses.push(p.email);
      }
    }
    const metaEmail = (await metaJson(c)).email;
    if (typeof metaEmail === "string" && metaEmail) addresses.push(metaEmail);
    const comments = (await c.query(`SELECT comment FROM abuse_user_report WHERE id = ANY($1::varchar[]) ORDER BY id`, [reportIds])).rows.map((r) => String(r.comment ?? ""));
    return { comments, addresses };
  });
  for (const to of addresses) {
    await Promise.all(comments.map((comment) =>
      runSendEmailJob(env, { kind: "sendEmail", to, subject: "New Abuse Report", html: sanitizeHtml(comment), text: sanitizeHtml(comment) })));
  }
}

/** UserService.notifySystemWebhook(user, 'userCreated'): the new user as UserLite. */
export async function notifyUserCreatedSystemWebhook(env: ApiEnv, userId: string): Promise<void> {
  await enqueueSystemWebhook(env, "userCreated", async () => ((await packUsers(env, [userId], null, false)) as unknown[])[0] ?? null);
}

// ---------------------------------------------------------------- notification recipients

type RecipientRow = Record<string, unknown> & {
  id: string; isActive: boolean; updatedAt: unknown; name: string; method: string; userId: string | null; systemWebhookId: string | null;
};

/**
 * AbuseReportNotificationService.fetchRecipients (removeUnauthorized: true): `email` recipients
 * whose user is no longer a moderator are deleted as a side effect, as upstream.
 */
async function fetchRecipients(env: ApiEnv, c: PgQueryable, p: { ids?: string[]; method?: string[] } = {}): Promise<RecipientRow[]> {
  const params: unknown[] = [];
  const w: string[] = [];
  if (p.ids) w.push(`id = ANY($${params.push(p.ids)}::varchar[])`);
  if (p.method && p.method.length > 0) {
    const or: string[] = [];
    if (p.method.includes("email")) or.push(`(method = 'email' AND "userId" IS NOT NULL)`);
    if (p.method.includes("webhook")) or.push(`(method = 'webhook' AND "userId" IS NULL)`);
    w.push(`(${or.join(" OR ")})`);
  }
  const rows = (await c.query(
    `SELECT * FROM abuse_report_notification_recipient ${w.length ? `WHERE ${w.join(" AND ")}` : ""} ORDER BY id`,
    params,
  )).rows as RecipientRow[];
  if (!rows.some((r) => r.userId != null)) return rows;
  const { moderatorIds } = await import("./abuse-reports-pg.js");
  const mods = new Set(await moderatorIds(env, c));
  const unauthorized = rows.filter((r) => r.userId != null && !mods.has(r.userId));
  if (unauthorized.length) {
    await c.query(`DELETE FROM abuse_report_notification_recipient WHERE id = ANY($1::varchar[])`, [unauthorized.map((r) => r.id)]);
  }
  return rows.filter((r) => r.userId == null || mods.has(r.userId)).sort(byId);
}

/** AbuseReportNotificationRecipientEntityService.packMany (user as UserLite). */
async function packRecipients(env: ApiEnv, c: PgQueryable, rows: RecipientRow[]) {
  const userIds = [...new Set(rows.map((r) => r.userId).filter((x): x is string => x != null))];
  const users = new Map(((await packUsers(env, userIds, null, false)) as { id: string }[]).map((u) => [u.id, u]));
  const hookIds = [...new Set(rows.map((r) => r.systemWebhookId).filter((x): x is string => x != null))];
  const hooks = new Map((hookIds.length ? await fetchSystemWebhooks(c, { ids: hookIds }) : []).map((w) => [w.id, packSystemWebhook(w)]));
  return rows
    .map((r) => ({
      id: r.id,
      isActive: Boolean(r.isActive),
      updatedAt: iso(r.updatedAt)!,
      name: r.name,
      method: r.method,
      userId: r.userId ?? undefined,
      user: r.userId ? users.get(r.userId) : undefined,
      systemWebhookId: r.systemWebhookId ?? undefined,
      systemWebhook: r.systemWebhookId ? hooks.get(r.systemWebhookId) : undefined,
    }))
    .sort(byId);
}

async function getRecipient(c: PgQueryable, id: string): Promise<RecipientRow | null> {
  return ((await c.query(`SELECT * FROM abuse_report_notification_recipient WHERE id = $1`, [id])).rows[0] as RecipientRow | undefined) ?? null;
}

/** Shared create / update validation; returns the resolved target columns or an error response. */
async function recipientTarget(c: PgQueryable, body: Body): Promise<Response | { userId: string | null; systemWebhookId: string | null }> {
  if (body.method === "email") {
    const userId = typeof body.userId === "string" ? body.userId : null;
    const profile = userId
      ? (await c.query(`SELECT email, "emailVerified" FROM user_profile WHERE "userId" = $1`, [userId])).rows[0]
      : undefined;
    if (!userId || !profile) return fail(E.correlationCheckEmail);
    if (!profile.email || !profile.emailVerified) return fail(E.emailAddressNotSet);
    return { userId, systemWebhookId: null };
  }
  if (typeof body.systemWebhookId !== "string" || !body.systemWebhookId) return fail(E.correlationCheckWebhook);
  // upstream: FK violation → INTERNAL_ERROR
  if (!(await getSystemWebhook(c, body.systemWebhookId))) return internal();
  return { userId: null, systemWebhookId: body.systemWebhookId };
}

function recipientParams(body: Body): boolean {
  if (typeof body.isActive !== "boolean" || !strIn(body.name, 1, 255) || !(RECIPIENT_METHODS as readonly string[]).includes(body.method as string)) return false;
  if (body.userId !== undefined && typeof body.userId !== "string") return false;
  return body.systemWebhookId === undefined || typeof body.systemWebhookId === "string";
}

const recCreate: SystemWebhookHandler = async (env, body, ctx) => {
  const g = await gate(env, body, ctx);
  if ("denied" in g) return g.denied;
  if (!recipientParams(body)) return bad();
  return withHyperdriveClient(hd(env), async (c) => {
    const t = await recipientTarget(c, body);
    if (t instanceof Response) return t;
    const id = genAidx(Date.now());
    await c.query(`INSERT INTO abuse_report_notification_recipient (id, "isActive", name, method, "userId", "systemWebhookId") VALUES ($1, $2, $3, $4, $5, $6)`, [
      id, body.isActive, body.name, body.method, t.userId, t.systemWebhookId,
    ]);
    const created = (await getRecipient(c, id))!;
    if (g.me) await moderationLogPg(c, g.me, "createAbuseReportNotificationRecipient", { recipientId: id, recipient: created }, genAidx(Date.now()));
    return (await packRecipients(env, c, [created]))[0];
  });
};

const recUpdate: SystemWebhookHandler = async (env, body, ctx) => {
  const g = await gate(env, body, ctx);
  if ("denied" in g) return g.denied;
  if (typeof body.id !== "string" || !recipientParams(body)) return bad();
  return withHyperdriveClient(hd(env), async (c) => {
    const t = await recipientTarget(c, body);
    if (t instanceof Response) return t;
    const before = await getRecipient(c, body.id as string);
    if (!before) return internal();
    await c.query(
      `UPDATE abuse_report_notification_recipient SET "isActive" = $2, "updatedAt" = now(), name = $3, method = $4, "userId" = $5, "systemWebhookId" = $6 WHERE id = $1`,
      [before.id, body.isActive, body.name, body.method, t.userId, t.systemWebhookId],
    );
    const after = (await getRecipient(c, before.id))!;
    if (g.me) await moderationLogPg(c, g.me, "updateAbuseReportNotificationRecipient", { recipientId: before.id, before: before, after: after }, genAidx(Date.now()));
    return (await packRecipients(env, c, [after]))[0];
  });
};

const recDelete: SystemWebhookHandler = async (env, body, ctx) => {
  const g = await gate(env, body, ctx);
  if ("denied" in g) return g.denied;
  if (typeof body.id !== "string") return bad();
  return withHyperdriveClient(hd(env), async (c) => {
    // upstream uses findBy (an array, possibly empty) and does not fail on unknown ids
    const entity = ((await c.query(`SELECT * FROM abuse_report_notification_recipient WHERE id = $1`, [body.id])).rows as RecipientRow[]);
    await c.query(`DELETE FROM abuse_report_notification_recipient WHERE id = $1`, [body.id]);
    if (g.me) await moderationLogPg(c, g.me, "deleteAbuseReportNotificationRecipient", { recipientId: body.id, recipient: entity }, genAidx(Date.now()));
    return noContent();
  });
};

const recList: SystemWebhookHandler = async (env, body, ctx) => {
  const g = await gate(env, body, ctx);
  if ("denied" in g) return g.denied;
  if (body.method !== undefined && !enumArray(body.method, RECIPIENT_METHODS)) return bad();
  return withHyperdriveClient(hd(env), async (c) => packRecipients(env, c, await fetchRecipients(env, c, { method: body.method as string[] | undefined })));
};

const recShow: SystemWebhookHandler = async (env, body, ctx) => {
  const g = await gate(env, body, ctx);
  if ("denied" in g) return g.denied;
  if (typeof body.id !== "string") return bad();
  return withHyperdriveClient(hd(env), async (c) => {
    const rows = await fetchRecipients(env, c, { ids: [body.id as string] });
    if (!rows.length) return notFound(E.noSuchRecipient);
    return (await packRecipients(env, c, rows.slice(0, 1)))[0];
  });
};

// ---------------------------------------------------------------- registry

function pgOnly(h: SystemWebhookHandler): SystemWebhookHandler {
  return async (env, body, ctx) => {
    if (!env.HYPERDRIVE?.connectionString) {
      return apiErrorResponse({ message: "Hyperdrive required.", code: "HYPERDRIVE_UNBOUND", id: "00000000-0000-4000-8000-0000000000b1", kind: "server" }, 501);
    }
    return h(env, body, ctx);
  };
}

const RAW: Record<string, SystemWebhookHandler> = {
  "admin/system-webhook/create": swCreate,
  "admin/system-webhook/delete": swDelete,
  "admin/system-webhook/list": swList,
  "admin/system-webhook/show": swShow,
  "admin/system-webhook/test": swTest,
  "admin/system-webhook/update": swUpdate,
  "admin/abuse-report/notification-recipient/create": recCreate,
  "admin/abuse-report/notification-recipient/delete": recDelete,
  "admin/abuse-report/notification-recipient/list": recList,
  "admin/abuse-report/notification-recipient/show": recShow,
  "admin/abuse-report/notification-recipient/update": recUpdate,
};

export const systemWebhookHandlers: Record<string, SystemWebhookHandler> = Object.fromEntries(Object.entries(RAW).map(([k, h]) => [k, pgOnly(h)]));

