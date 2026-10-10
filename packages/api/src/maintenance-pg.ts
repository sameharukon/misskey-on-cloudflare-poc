/**
 * Periodic / operator maintenance on PG:
 *
 * - `checkModeratorsActivity` (upstream queue/processors/CheckModeratorsActivityProcessorService,
 *   upstream cron `30 * * * *`; here the api worker's hourly cron): when registration is open and
 *   every moderator (role moderators + administrators + root, unexpired assignments) with a
 *   `lastActiveDate` has been inactive for 7 days, switch to invitation-only
 *   (`meta.disableRegistration = true`), give each moderator a personal announcement and fire
 *   the `inactiveModeratorsInvitationOnlyChanged` system webhook. With ≤ 2 days left, fire
 *   `inactiveModeratorsWarning` `{ remainingTime }` every 6 hours (remaining hours % 6 === 0).
 *   Both also mail each moderator with a verified address (`sendEmail`, Cloudflare Email Service).
 *   As upstream, moderators without a `lastActiveDate` are not evaluated, so when none has one the
 *   check finds "all evaluated moderators inactive" and switches to invitation-only.
 * - `touchLastActiveDate` (UserService.updateLastActiveDate, called on streaming connect as
 *   upstream StreamingApiServerService), waking a hibernated user.
 * - `backfillInstances` mk-jobs steps (misskey-cf only, admin/cf-debug/backfill-instances):
 *   register `instance` rows for every remote host in "user", then recompute
 *   usersCount / notesCount / followingCount / followersCount from PG with the same rules as
 *   the live hooks (ap/instances.ts).
 * - `runCleanPg` (upstream queue/processors/CleanProcessorService, cron `0 0 * * *`; here the
 *   hourly cron at 0 UTC): user_ip rows over 90 days, antennas unused for
 *   DEACTIVATE_ANTENNA_THRESHOLD ms (default 7 days, 0 = never) become inactive, expired role
 *   assignments, and reversi games not started within 10 minutes.
 */

import { genAidx } from "../../id/src/index.js";
import type { ApiEnv } from "./env.js";
import { withHyperdriveClient, type PgQueryable } from "./pg.js";
import { moderatorIds } from "./abuse-reports-pg.js";
import { enqueueSystemWebhook } from "./system-webhooks-pg.js";
import { packAnnouncement } from "./client-endpoints-pg.js";
import { publishToUserStream } from "./stream-publish.js";
import { invalidateMetaCache } from "./meta-runtime.js";
import { sendEmail } from "./email.js";
import { hd } from "./handler-kit.js";
import { enqueueJob } from "./queues/jobs-queue.js";
import { metaRowPg } from "./user-lite-pg.js";

// ---------------------------------------------------------------- moderator activity

export const MODERATOR_INACTIVITY_LIMIT_DAYS = 7;
const MODERATOR_INACTIVITY_WARNING_REMAINING_DAYS = 2;
const MODERATOR_INACTIVITY_WARNING_NOTIFY_INTERVAL_HOURS = 6;
const ONE_HOUR_MILLI_SEC = 1000 * 60 * 60;
const ONE_DAY_MILLI_SEC = ONE_HOUR_MILLI_SEC * 24;

export type ModeratorInactivityRemainingTime = { time: number; asHours: number; asDays: number };

export type ModeratorInactivityEvaluation = {
  isModeratorsInactive: boolean;
  inactiveModeratorIds: string[];
  /** moderators that have a lastActiveDate */
  evaluated: number;
  remainingTime: ModeratorInactivityRemainingTime;
};

/** evaluateModeratorsInactiveDays (local-time `setDate(-7)` like upstream). */
export async function evaluateModeratorsInactiveDays(env: ApiEnv, c: PgQueryable, now = new Date()): Promise<ModeratorInactivityEvaluation> {
  const inactivePeriod = new Date(now);
  inactivePeriod.setDate(now.getDate() - MODERATOR_INACTIVITY_LIMIT_DAYS);
  const ids = await moderatorIds(env, c);
  const rows = ids.length
    ? (await c.query(`SELECT id, "lastActiveDate" FROM "user" WHERE id = ANY($1::varchar[]) AND "lastActiveDate" IS NOT NULL`, [ids])).rows
    : [];
  const mods = rows.map((r) => ({ id: String(r.id), last: new Date(r.lastActiveDate as string | Date).getTime() }));
  const inactive = mods.filter((m) => m.last < inactivePeriod.getTime());
  const newest = Math.max(...mods.map((m) => m.last));
  const time = newest - inactivePeriod.getTime();
  return {
    isModeratorsInactive: inactive.length === mods.length,
    inactiveModeratorIds: inactive.map((m) => m.id),
    evaluated: mods.length,
    remainingTime: { time, asHours: Math.floor(time / ONE_HOUR_MILLI_SEC), asDays: Math.floor(time / ONE_DAY_MILLI_SEC) },
  };
}

export type ModeratorActivityResult =
  | { action: "unavailable" | "alreadyInvitationOnly" | "ok" }
  | { action: "warned" | "warningPending"; remainingTime: ModeratorInactivityRemainingTime }
  | { action: "changedToInvitationOnly" };

const INVITATION_ONLY_SUBJECT = "Change to Invitation-Only / 招待制に変更されました";
const INVITATION_ONLY_LINES = [
  "To Moderators,",
  "",
  `Changed to invitation only because no moderator activity was detected for ${MODERATOR_INACTIVITY_LIMIT_DAYS} days.`,
  "To cancel the invitation only, you need to access the control panel.",
  "",
  "---------------",
  "",
  "To モデレーター各位",
  "",
  `モデレーターの活動が${MODERATOR_INACTIVITY_LIMIT_DAYS}日間検出されなかったため、招待制に変更されました。`,
  "招待制を解除するには、コントロールパネルにアクセスする必要があります。",
  "",
];
const INVITATION_ONLY_TEXT = INVITATION_ONLY_LINES.join("\n");

/** generateModeratorInactivityMail */
function moderatorInactivityMail(remainingTime: ModeratorInactivityRemainingTime): { subject: string; html: string; text: string } {
  const timeVariant = remainingTime.asDays === 0 ? `${remainingTime.asHours} hours` : `${remainingTime.asDays} days`;
  const timeVariantJa = remainingTime.asDays === 0 ? `${remainingTime.asHours} 時間` : `${remainingTime.asDays} 日間`;
  const message = [
    "To Moderators,",
    "",
    `A moderator has been inactive for a period of time. If there are ${timeVariant} of inactivity left, it will switch to invitation only.`,
    "If you do not wish to move to invitation only, you must log into Misskey and update your last active date and time.",
    "",
    "---------------",
    "",
    "To モデレーター各位",
    "",
    `モデレーターが一定期間活動していないようです。あと${timeVariantJa}活動していない状態が続くと招待制に切り替わります。`,
    "招待制に切り替わることを望まない場合は、Misskeyにログインして最終アクティブ日時を更新してください。",
    "",
  ];
  return { subject: "Moderator Inactivity Warning / モデレーター不在の通知", html: message.join("<br>"), text: message.join("\n") };
}

/** The moderators' verified addresses (moderatorProfiles: email && emailVerified). */
async function moderatorEmails(env: ApiEnv, c: PgQueryable): Promise<Map<string, string>> {
  const ids = await moderatorIds(env, c);
  if (!ids.length) return new Map();
  const rows = (await c.query(`SELECT "userId", email, "emailVerified" FROM user_profile WHERE "userId" = ANY($1::varchar[])`, [ids])).rows;
  return new Map(rows.filter((r) => r.email && r.emailVerified).map((r) => [String(r.userId), String(r.email)]));
}

/** notifyInactiveModeratorsWarning: mail every moderator with a verified address, then the system webhook. */
async function notifyInactiveModeratorsWarning(env: ApiEnv, remainingTime: ModeratorInactivityRemainingTime): Promise<void> {
  const mail = moderatorInactivityMail(remainingTime);
  const to = await withHyperdriveClient(hd(env), (c) => moderatorEmails(env, c));
  for (const email of to.values()) await sendEmail(env, email, mail.subject, mail.html, mail.text);
  await enqueueSystemWebhook(env, "inactiveModeratorsWarning", { remainingTime });
}

/** CheckModeratorsActivityProcessorService.process (one run; the cron calls it hourly). */
export async function checkModeratorsActivity(env: ApiEnv, now = new Date()): Promise<ModeratorActivityResult> {
  if (!env.HYPERDRIVE?.connectionString) return { action: "unavailable" };
  const state = await withHyperdriveClient(hd(env), async (c) => {
    const m = await metaRowPg(c);
    if (m.id == null) return null; // no meta row
    if (m.disableRegistration === true) return "alreadyInvitationOnly" as const;
    return evaluateModeratorsInactiveDays(env, c, now);
  });
  if (state == null) return { action: "unavailable" };
  if (state === "alreadyInvitationOnly") return { action: state };

  if (state.isModeratorsInactive) {
    console.warn(`The moderator has been inactive for ${MODERATOR_INACTIVITY_LIMIT_DAYS} days. We will move to invitation only.`);
    // MetaService.update({ disableRegistration: true }); later loads read the PG row again
    await withHyperdriveClient(hd(env), (c) =>
      c.query(`UPDATE meta SET "disableRegistration" = TRUE WHERE id = (SELECT id FROM meta ORDER BY id DESC LIMIT 1)`),
    );
    await invalidateMetaCache(env);
    await notifyChangeToInvitationOnly(env);
    return { action: "changedToInvitationOnly" };
  }
  const remainingTime = state.remainingTime;
  if (remainingTime.asDays <= MODERATOR_INACTIVITY_WARNING_REMAINING_DAYS) {
    const v = remainingTime.asDays === 0 ? `${remainingTime.asHours} hours` : `${remainingTime.asDays} days`;
    console.warn(`A moderator has been inactive for a period of time. If you are inactive for an additional ${v}, it will switch to invitation only.`);
    if (remainingTime.asHours % MODERATOR_INACTIVITY_WARNING_NOTIFY_INTERVAL_HOURS === 0) {
      await notifyInactiveModeratorsWarning(env, remainingTime);
      return { action: "warned", remainingTime };
    }
    return { action: "warningPending", remainingTime };
  }
  return { action: "ok" };
}

/** notifyChangeToInvitationOnly: a personal announcement and a mail per moderator + the system webhook. */
async function notifyChangeToInvitationOnly(env: ApiEnv): Promise<void> {
  let emails = new Map<string, string>();
  const created = await withHyperdriveClient(hd(env), async (c) => {
    emails = await moderatorEmails(env, c);
    const out: { userId: string; row: Record<string, unknown> }[] = [];
    for (const userId of await moderatorIds(env, c)) {
      // AnnouncementService.create({ title, text, forExistingUsers: true, needConfirmationToRead: true, userId })
      const id = genAidx(Date.now());
      const row = (await c.query(
        `INSERT INTO announcement (id, "updatedAt", title, text, "imageUrl", icon, display, "forExistingUsers", silence, "needConfirmationToRead", "userId")
         VALUES ($1, NULL, $2, $3, NULL, 'info', 'normal', TRUE, FALSE, TRUE, $4) RETURNING *`,
        [id, INVITATION_ONLY_SUBJECT, INVITATION_ONLY_TEXT, userId],
      )).rows[0]!;
      out.push({ userId, row });
    }
    return out;
  });
  for (const { userId, row } of created) {
    await publishToUserStream(env, userId, "main", "announcementCreated", { announcement: packAnnouncement(row, null, undefined) }).catch(() => {});
    const email = emails.get(userId);
    if (email) await sendEmail(env, email, INVITATION_ONLY_SUBJECT, INVITATION_ONLY_LINES.join("<br>"), INVITATION_ONLY_TEXT);
  }
  await enqueueSystemWebhook(env, "inactiveModeratorsInvitationOnlyChanged", {});
}

/** UserService.updateLastActiveDate (+ wake a hibernated user and their followings). Best-effort. */
export async function touchLastActiveDate(env: ApiEnv, userId: string): Promise<void> {
  if (!env.HYPERDRIVE?.connectionString) return;
  try {
    await withHyperdriveClient(hd(env), async (c) => {
      const r = (await c.query(`UPDATE "user" SET "lastActiveDate" = now() WHERE id = $1 RETURNING "isHibernated"`, [userId])).rows[0];
      if (r?.isHibernated === true) {
        await c.query(`UPDATE "user" SET "isHibernated" = FALSE WHERE id = $1`, [userId]);
        await c.query(`UPDATE following SET "isFollowerHibernated" = FALSE WHERE "followerId" = $1`, [userId]);
      }
    });
  } catch (e) {
    console.warn(`lastActiveDate update failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ---------------------------------------------------------------- instance stats backfill

/** One mk-jobs step: `register` walks distinct remote hosts of "user", then `count` walks `instance` by host. */
export type BackfillInstancesJob = { kind: "backfillInstances"; phase: "register" | "count"; cursor?: string };

export const BACKFILL_HOSTS_PER_STEP = 50;

export async function runBackfillInstancesStep(env: ApiEnv, job: BackfillInstancesJob): Promise<BackfillInstancesJob | null> {
  return withHyperdriveClient(hd(env), async (c) => {
    const params: unknown[] = [BACKFILL_HOSTS_PER_STEP];
    if (job.cursor != null) params.push(job.cursor);
    const after = job.cursor != null ? `AND host > $2` : "";
    if (job.phase === "register") {
      const hosts = (await c.query(
        `SELECT host FROM (SELECT DISTINCT host FROM "user" WHERE host IS NOT NULL ${after} ORDER BY host LIMIT $1) h ORDER BY host`,
        params,
      )).rows.map((r) => String(r.host));
      // "user".host is already lower-cased / punycode (ApPersonService) — the same key as instance.host
      for (const h of hosts) {
        await c.query(`INSERT INTO instance (id, host, "firstRetrievedAt") VALUES ($1, $2, now()) ON CONFLICT (host) DO NOTHING`, [genAidx(Date.now()), h]);
      }
      return hosts.length === BACKFILL_HOSTS_PER_STEP
        ? { kind: "backfillInstances", phase: "register", cursor: hosts[hosts.length - 1]! }
        : { kind: "backfillInstances", phase: "count" };
    }
    const rows = (await c.query(`SELECT id, host FROM instance WHERE TRUE ${after} ORDER BY host LIMIT $1`, params)).rows;
    if (rows.length) {
      // same rules as the live hooks: notes / users by host, following = remote follower → local followee,
      // followers = local follower → remote followee
      await c.query(
        `UPDATE instance i SET
           "usersCount" = (SELECT count(*) FROM "user" u WHERE u.host = i.host),
           "notesCount" = (SELECT count(*) FROM note n WHERE n."userHost" = i.host),
           "followingCount" = (SELECT count(*) FROM following f WHERE f."followerHost" = i.host AND f."followeeHost" IS NULL),
           "followersCount" = (SELECT count(*) FROM following f WHERE f."followeeHost" = i.host AND f."followerHost" IS NULL)
         WHERE i.id = ANY($1::varchar[])`,
        [rows.map((r) => String(r.id))],
      );
    }
    return rows.length === BACKFILL_HOSTS_PER_STEP ? { kind: "backfillInstances", phase: "count", cursor: String(rows[rows.length - 1]!.host) } : null;
  });
}

/** Queue the backfill on mk-jobs, or run every step inline when the queue is unbound (offline / tests). */
export async function enqueueBackfillInstances(env: ApiEnv): Promise<{ queued: boolean; steps: number }> {
  const job: BackfillInstancesJob = { kind: "backfillInstances", phase: "register" };
  if (env.Q_JOBS) {
    await enqueueJob(env, job);
    return { queued: true, steps: 0 };
  }
  let steps = 0;
  let next: BackfillInstancesJob | null = job;
  while (next) {
    next = await runBackfillInstancesStep(env, next);
    steps++;
  }
  return { queued: false, steps };
}

// ---------------------------------------------------------------- clean

/** upstream config.deactivateAntennaThreshold (ms; default 7 days, 0 disables). */
export function deactivateAntennaThreshold(env: ApiEnv): number {
  const n = Number(env.DEACTIVATE_ANTENNA_THRESHOLD);
  return env.DEACTIVATE_ANTENNA_THRESHOLD != null && Number.isFinite(n) && n >= 0 ? n : 1000 * 60 * 60 * 24 * 7;
}

export type CleanResult = { userIps: number; antennas: number; roleAssignments: number; reversiGames: number };

/** CleanProcessorService.process. Each step is independent (a missing table skips it). */
export async function runCleanPg(env: ApiEnv, now = Date.now()): Promise<CleanResult> {
  const out: CleanResult = { userIps: 0, antennas: 0, roleAssignments: 0, reversiGames: 0 };
  await withHyperdriveClient(hd(env), async (c) => {
    const step = async (key: keyof CleanResult, sql: string, params: unknown[]) => {
      try {
        out[key] = (await c.query(sql, params)).rowCount ?? 0;
      } catch (e) {
        console.warn(`clean ${key} failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    };
    await step("userIps", `DELETE FROM user_ip WHERE "createdAt" < $1`, [new Date(now - 1000 * 60 * 60 * 24 * 90).toISOString()]);
    // 使われてないアンテナを停止
    const threshold = deactivateAntennaThreshold(env);
    if (threshold > 0) {
      await step("antennas", `UPDATE antenna SET "isActive" = FALSE WHERE "lastUsedAt" < $1 AND "isActive" = TRUE`, [new Date(now - threshold).toISOString()]);
    }
    await step("roleAssignments", `DELETE FROM role_assignment WHERE "expiresAt" IS NOT NULL AND "expiresAt" < $1`, [new Date(now).toISOString()]);
    // ReversiService.cleanOutdatedGames: id < idService.gen(now - 10 min)
    await step("reversiGames", `DELETE FROM reversi_game WHERE id < $1 AND "isStarted" = FALSE`, [genAidx(now - 1000 * 60 * 10)]);
  });
  return out;
}
