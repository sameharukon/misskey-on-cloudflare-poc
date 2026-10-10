/**
 * Account deletion (W7.10): i/delete-account and admin/delete-account, following upstream
 * DeleteAccountService + DeleteAccountProcessorService.
 *
 * The request marks `user.isDeleted` (tokens stop working at once), sends Delete(Person) to every
 * known shared inbox for local users, and enqueues a `deleteAccount` job on `mk-jobs`. The job
 * runs in bounded steps that re-enqueue themselves: notes (100 per step), drive files (10 per
 * step, R2 objects included), then the `user` row (hard delete for local users, so PG's foreign
 * keys cascade as upstream; remote users are soft-deleted so they cannot federate back in); the
 * user's pages go in the last step. Without the queue binding the steps run inline. The
 * account-deleted e-mail is not sent (no mail transport).
 */

import bcrypt from "bcryptjs";
import type { ApiEnv } from "./env.js";
import { apiErrorResponse, CREDENTIAL_REQUIRED, INTERNAL_ERROR, INVALID_PARAM } from "./errors.js";
import { authenticatePg, extractToken } from "./auth-pg.js";
import { withHyperdriveClient, type PgQueryable } from "./pg.js";
import { genAidx } from "../../id/src/index.js";
import { getRootUserId } from "./users-pg.js";
import { moderationLogPg } from "./policies-pg.js";
import { twoFactorAuthenticate } from "./account-pg.js";
import { deleteObjects } from "./drive-pg.js";
import { adminGate } from "./admin-gate.js";
import { hd } from "./handler-kit.js";
import { enqueueJob as sendJob } from "./queues/jobs-queue.js";

type Ctx = { hasCredential: boolean; request: Request };
type Body = Record<string, unknown>;
type Handler = (env: ApiEnv, body: Body, ctx: Ctx) => Promise<Response | unknown>;

const internal = () => apiErrorResponse(INTERNAL_ERROR, 500);
const noContent = () => new Response(null, { status: 204 });

export type DeleteAccountJob = { kind: "deleteAccount"; userId: string; soft: boolean; step?: "notes" | "files" | "user" };

async function enqueueJob(env: ApiEnv, job: DeleteAccountJob): Promise<void> {
  if (env.Q_JOBS) await sendJob(env, job);
  else {
    // offline / tests: run every step now
    let next: DeleteAccountJob | null = job;
    while (next) next = await runDeleteAccountStep(env, next);
  }
}

/** DeleteAccountService.deleteAccount. Throws on root / system accounts (upstream Errors). */
export async function deleteAccount(env: ApiEnv, userId: string, moderatorId?: string | null): Promise<"ok" | "root" | "system" | "missing"> {
  if ((await getRootUserId(env)) === userId) return "root";
  const user = await withHyperdriveClient(hd(env), async (c) =>
    (await c.query(`SELECT id, username, host FROM "user" WHERE id = $1`, [userId])).rows[0],
  );
  if (!user) return "missing";
  const host = (user.host as string | null) ?? null;
  if (host === null && String(user.username).includes(".")) return "system";
  await withHyperdriveClient(hd(env), async (c) => {
    if (moderatorId) {
      await moderationLogPg(c, moderatorId, "deleteAccount", { userId, userUsername: user.username, userHost: host }, genAidx(Date.now()));
    }
    await c.query(`UPDATE "user" SET "isDeleted" = TRUE WHERE id = $1`, [userId]);
  });
  if (host === null) await deliverActorDelete(env, userId);
  await enqueueJob(env, { kind: "deleteAccount", userId, soft: host !== null, step: "notes" });
  return "ok";
}

/** QueueService.createDeleteAccountJob(user) for an inbound Delete(Person): a hard delete, as upstream. */
export async function enqueueDeleteAccountJob(env: ApiEnv, userId: string): Promise<void> {
  await enqueueJob(env, { kind: "deleteAccount", userId, soft: false, step: "notes" });
}

/** Delete(Person) to every shared inbox we know of (upstream: all followings' shared inboxes). */
async function deliverActorDelete(env: ApiEnv, userId: string): Promise<void> {
  try {
    const { getFederationPolicy } = await import("./ap/federation.js");
    if ((await getFederationPolicy(env)).mode === "none") return;
    const { enqueueDeliver, localActorUri } = await import("./ap/deliver.js");
    const { renderDelete } = await import("../../ap/src/index.js");
    const inboxes = await withHyperdriveClient(hd(env), async (c) =>
      (await c.query(
        `SELECT DISTINCT COALESCE("followerSharedInbox", "followeeSharedInbox") AS inbox
         FROM following WHERE "followerSharedInbox" IS NOT NULL OR "followeeSharedInbox" IS NOT NULL`,
      )).rows.map((r) => r.inbox as string),
    );
    const actor = localActorUri(env, userId);
    await enqueueDeliver(env, userId, inboxes, renderDelete(actor, actor));
  } catch (e) {
    console.warn(`account Delete delivery failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** One bounded step of DeleteAccountProcessorService; returns the follow-up job or null when done. */
export async function runDeleteAccountStep(env: ApiEnv, job: DeleteAccountJob): Promise<DeleteAccountJob | null> {
  return withHyperdriveClient(hd(env), async (c: PgQueryable) => {
    const exists = (await c.query(`SELECT 1 AS ok FROM "user" WHERE id = $1`, [job.userId])).rows.length > 0;
    if (!exists) return null;
    const step = job.step ?? "notes";
    if (step === "notes") {
      const ids = (await c.query(`SELECT id FROM note WHERE "userId" = $1 ORDER BY id LIMIT 100`, [job.userId])).rows.map((r) => String(r.id));
      if (ids.length) await c.query(`DELETE FROM note WHERE id = ANY($1::varchar[])`, [ids]);
      return { ...job, step: ids.length === 100 ? "notes" : "files" };
    }
    if (step === "files") {
      const files = (await c.query(`SELECT * FROM drive_file WHERE "userId" = $1 ORDER BY id LIMIT 10`, [job.userId])).rows;
      for (const f of files) {
        await c.query(`DELETE FROM drive_file WHERE id = $1`, [f.id]);
        await deleteObjects(env, f);
      }
      return { ...job, step: files.length === 10 ? "files" : "user" };
    }
    // pages (upstream PageService.delete per page, which releases note pageCount)
    try {
      const { collectReferencedNotes } = await import("./pages-pg.js");
      const pages = (await c.query(`SELECT id, content FROM page WHERE "userId" = $1`, [job.userId])).rows;
      for (const pg of pages) {
        const refs = collectReferencedNotes(pg.content);
        if (refs.length) await c.query(`UPDATE note SET "pageCount" = "pageCount" - 1 WHERE id = ANY($1::varchar[])`, [refs]);
        await c.query(`DELETE FROM page_like WHERE "pageId" = $1`, [pg.id]);
        await c.query(`DELETE FROM page WHERE id = $1`, [pg.id]);
      }
    } catch {
      /* no page table */
    }
    // email notification (DeleteAccountProcessorService)
    const profile = (await c.query(`SELECT email, "emailVerified" FROM user_profile WHERE "userId" = $1`, [job.userId])).rows[0];
    if (typeof profile?.email === "string" && profile.email && profile.emailVerified) {
      const { sendEmail } = await import("./email.js");
      await sendEmail(env, profile.email, "Account deleted", "Your account has been deleted.", "Your account has been deleted.");
    }
    if (!job.soft) await c.query(`DELETE FROM "user" WHERE id = $1`, [job.userId]);
    return null;
  });
}

// ---------------------------------------------------------------- endpoints

const iDeleteAccount: Handler = async (env, body, ctx) => {
  if (!ctx.hasCredential) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  const token = extractToken(ctx.request, body);
  const a = token ? await authenticatePg(env, token) : null;
  if (!a) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  if (typeof body.password !== "string" || (body.token != null && typeof body.token !== "string")) return apiErrorResponse(INVALID_PARAM, 400);
  const me = a.user.id;
  const check = await withHyperdriveClient(hd(env), async (c) => {
    const p = (await c.query(`SELECT to_jsonb(p) AS p FROM user_profile p WHERE "userId" = $1`, [me])).rows[0]?.p as Record<string, unknown> | undefined;
    if (!p) return "error";
    if (p.twoFactorEnabled) {
      const ok = typeof body.token === "string" && (await twoFactorAuthenticate(env, c, {
        userId: me,
        password: null,
        twoFactorEnabled: true,
        twoFactorSecret: (p.twoFactorSecret as string | null) ?? null,
        twoFactorTempSecret: null,
        twoFactorBackupSecret: Array.isArray(p.twoFactorBackupSecret) ? (p.twoFactorBackupSecret as string[]) : null,
      }, body.token));
      if (!ok) return "error"; // 'authentication failed'
    }
    if (!(await bcrypt.compare(body.password as string, (p.password as string | null) ?? ""))) return "error"; // 'incorrect password'
    return "ok";
  });
  if (check !== "ok") return internal();
  return (await deleteAccount(env, me)) === "ok" ? noContent() : internal();
};

const adminDeleteAccount: Handler = async (env, body, ctx) => {
  const denied = await adminGate(ctx.request, env as never, body, "admin");
  if (denied) return denied;
  if (typeof body.userId !== "string") return apiErrorResponse(INVALID_PARAM, 400);
  const token = extractToken(ctx.request, body);
  const meId = token ? ((await authenticatePg(env, token))?.user.id ?? null) : null;
  const target = await withHyperdriveClient(hd(env), async (c) =>
    (await c.query(`SELECT id, to_jsonb(u) ->> 'isDeleted' AS "isDeleted" FROM "user" u WHERE id = $1`, [body.userId])).rows[0],
  );
  if (!target) return internal(); // findOneByOrFail
  if (target.isDeleted === "true") return noContent();
  return (await deleteAccount(env, String(target.id), meId)) === "ok" ? noContent() : internal();
};

function pgOnly(h: Handler): Handler {
  return async (env, body, ctx) => {
    if (!env.HYPERDRIVE?.connectionString) {
      return apiErrorResponse({ message: "Hyperdrive required.", code: "HYPERDRIVE_UNBOUND", id: "00000000-0000-4000-8000-0000000000b1", kind: "server" }, 501);
    }
    return h(env, body, ctx);
  };
}

export const deleteAccountHandlers: Record<string, Handler> = {
  "i/delete-account": pgOnly(iDeleteAccount),
  "admin/delete-account": pgOnly(adminDeleteAccount),
};

