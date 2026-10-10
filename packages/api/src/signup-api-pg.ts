/**
 * Public sign-up: upstream SignupApiService's special routes `POST /api/signup` and
 * `POST /api/signup-pending` (not in endpoint-list; dispatched through the handler table like
 * `signin-flow`).
 *
 * - captcha: every enabled provider in `meta` is verified (hCaptcha / mCaptcha / reCAPTCHA /
 *   Turnstile / testcaptcha, the CaptchaService helpers of `admin-misc-pg.ts`). Upstream skips
 *   this under NODE_ENV=test; here it always runs.
 * - `disableRegistration`: an `invitationCode` (registration_ticket) is required, claimed with a
 *   conditional UPDATE right before use (claimRegistrationTicket / releaseRegistrationTicket).
 * - `emailRequiredForSignup`: the account is parked in `user_pending` and a link to
 *   `/signup-complete/<code>` is mailed; `signup-pending` creates it within 30 minutes and signs
 *   in. Without the `EMAIL` binding the requirement is treated as off (nothing could be mailed).
 * - username checks (format, existing / used / preserved / prohibited words) and the MeDetailed +
 *   `token` response go through `signup-pg.ts`.
 *
 * Errors use Fastify's shape as upstream: a bare 400 (`reply.code(400)`) or
 * `{ statusCode, error, message }` (FastifyReplyError). Upstream applies no rate limit here.
 */

import bcrypt from "bcryptjs";
import { genAidx, parseAidxTime } from "../../id/src/index.js";
import type { ApiEnv } from "./env.js";
import { withHyperdriveClient, type PgQueryable } from "./pg.js";
import { packMe } from "./client-endpoints-pg.js";
import { validateEmailForAccountPg } from "./misc-pg.js";
import { secureRndstr } from "./crypto-util.js";
import { metaJson, sendEmail } from "./email.js";
import { signupLocal, type SignupResult } from "./signup-pg.js";
import { CaptchaError, verifyMcaptcha, verifySiteverify, verifyTestcaptcha } from "./admin-misc-pg.js";
import { L_CHARS } from "./email-pg.js";
import { signinRequestInfo } from "./signin-pg.js";
import { hd } from "./handler-kit.js";

type Ctx = { hasCredential: boolean; request: Request };
type Body = Record<string, unknown>;
type Handler = (env: ApiEnv, body: Body, ctx: Ctx) => Promise<Response | unknown>;
type Row = Record<string, unknown>;

const INVITATION_CODE_MAIL_TIMEOUT_MS = 30 * 60 * 1000;

/** `reply.code(400); return;` */
const bare400 = () => new Response(null, { status: 400 });
/** FastifyReplyError through Fastify's default error handler. */
const replyError = (status: number, message: string) =>
  Response.json({ statusCode: status, error: status === 400 ? "Bad Request" : "Internal Server Error", message }, { status });
const baseUrl = (env: ApiEnv) => (env.INSTANCE_URL ?? "https://localhost").replace(/\/$/, "");
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/** SignupApiService's captcha prelude. Returns an error response or null. */
export async function verifySignupCaptcha(env: ApiEnv, meta: Row, body: Body): Promise<Response | null> {
  const resp = (k: string) => (typeof body[k] === "string" ? (body[k] as string) : null);
  try {
    if (meta.enableHcaptcha && str(meta.hcaptchaSecretKey)) {
      await verifySiteverify(env, "hcaptcha", "https://hcaptcha.com/siteverify", meta.hcaptchaSecretKey as string, resp("hcaptcha-response"));
    }
    if (meta.enableMcaptcha && str(meta.mcaptchaSecretKey) && str(meta.mcaptchaSitekey) && str(meta.mcaptchaInstanceUrl)) {
      await verifyMcaptcha(env, meta.mcaptchaSecretKey as string, meta.mcaptchaSitekey as string, meta.mcaptchaInstanceUrl as string, resp("m-captcha-response"));
    }
    if (meta.enableRecaptcha && str(meta.recaptchaSecretKey)) {
      await verifySiteverify(env, "recaptcha", "https://www.recaptcha.net/recaptcha/api/siteverify", meta.recaptchaSecretKey as string, resp("g-recaptcha-response"));
    }
    if (meta.enableTurnstile && str(meta.turnstileSecretKey)) {
      await verifySiteverify(env, "turnstile", "https://challenges.cloudflare.com/turnstile/v0/siteverify", meta.turnstileSecretKey as string, resp("turnstile-response"));
    }
    if (meta.enableTestcaptcha) verifyTestcaptcha(resp("testcaptcha-response"));
  } catch (e) {
    // FastifyReplyError(400, err) carries the CaptchaError itself as `message`; Fastify's
    // serializer turns it into a string through toString()
    if (e instanceof CaptchaError) return replyError(400, `CaptchaError: ${e.message}`);
    return replyError(400, e instanceof Error ? e.toString() : String(e));
  }
  return null;
}

type Ticket = { id: string; usedById: string | null; usedAt: Date | null; expiresAt: Date | null; pendingUserId: string | null };

const toDate = (v: unknown): Date | null => (v == null ? null : v instanceof Date ? v : new Date(String(v)));

async function findTicket(c: PgQueryable, where: string, param: unknown): Promise<Ticket | null> {
  const r = (await c.query(`SELECT id, "usedById", "usedAt", "expiresAt", "pendingUserId" FROM registration_ticket WHERE ${where} LIMIT 1`, [param])).rows[0];
  return r
    ? { id: String(r.id), usedById: (r.usedById as string | null) ?? null, usedAt: toDate(r.usedAt), expiresAt: toDate(r.expiresAt), pendingUserId: (r.pendingUserId as string | null) ?? null }
    : null;
}

/** claimRegistrationTicket: true when this request took the code. */
async function claimTicket(c: PgQueryable, ticketId: string, emailRequired: boolean): Promise<boolean> {
  const r = await c.query(
    `UPDATE registration_ticket SET "usedAt" = now()
     WHERE id = $1 AND "usedById" IS NULL AND ("usedAt" IS NULL OR ($2::boolean AND "usedAt" <= $3::timestamptz AND "pendingUserId" IS NULL))`,
    [ticketId, emailRequired, new Date(Date.now() - INVITATION_CODE_MAIL_TIMEOUT_MS).toISOString()],
  );
  if ((r.rowCount ?? 0) > 0) return true;
  if (!emailRequired) return false;
  // a code still tied to an expired pending user is detached and claimed again
  const stale = await findTicket(c, `id = $1 AND "usedById" IS NULL`, ticketId);
  if (stale?.pendingUserId == null) return false;
  const pending = (await c.query(`SELECT id FROM user_pending WHERE id = $1`, [stale.pendingUserId])).rows[0];
  const expired = !pending || (parseAidxTime(String(pending.id))?.getTime() ?? 0) + INVITATION_CODE_MAIL_TIMEOUT_MS < Date.now();
  if (!expired) return false;
  const detached = await c.query(
    `UPDATE registration_ticket SET "pendingUserId" = NULL WHERE id = $1 AND "pendingUserId" = $2 AND "usedById" IS NULL`,
    [stale.id, stale.pendingUserId],
  );
  if ((detached.rowCount ?? 0) === 0) return false;
  if (pending) await c.query(`DELETE FROM user_pending WHERE id = $1`, [pending.id]);
  return claimTicket(c, ticketId, emailRequired);
}

/** releaseRegistrationTicket (codes already tied to an account stay used). */
async function releaseTicket(c: PgQueryable, ticketId: string): Promise<void> {
  await c.query(`UPDATE registration_ticket SET "usedAt" = NULL, "pendingUserId" = NULL WHERE id = $1 AND "usedById" IS NULL`, [ticketId]);
}

function signupErrorResponse(r: Extract<SignupResult, { ok: false }>): Response {
  // upstream: FastifyReplyError(400, err.toString()) → "Error: DUPLICATED_USERNAME"
  return replyError(400, `Error: ${r.code}`);
}

// ---------------------------------------------------------------- POST /api/signup

const signup: Handler = async (env, body) => {
  const meta = await withHyperdriveClient(hd(env), metaJson);
  const captcha = await verifySignupCaptcha(env, meta, body);
  if (captcha) return captcha;

  // no schema on this route upstream: bad types fail where upstream fails (TypeError → 500 in the
  // e-mail branch, INVALID_USERNAME / INVALID_PASSWORD from SignupService otherwise)
  const username = body.username as string;
  const password = body.password as string;
  const invitationCode = body.invitationCode;
  const emailAddress = body.emailAddress;
  const emailRequired = Boolean(meta.emailRequiredForSignup) && env.EMAIL != null;

  return withHyperdriveClient(hd(env), async (c) => {
    if (emailRequired) {
      if (typeof emailAddress !== "string") return bare400();
      if (!(await validateEmailForAccountPg(c, emailAddress, env)).available) return bare400();
    }

    let ticket: Ticket | null = null;
    if (meta.disableRegistration) {
      if (typeof invitationCode !== "string") return bare400();
      // early rejection only; claimTicket() decides
      ticket = await findTicket(c, `code = $1`, invitationCode);
      if (ticket == null || ticket.usedById != null) return bare400();
      if (ticket.expiresAt && ticket.expiresAt.getTime() < Date.now()) return bare400();
      if (emailRequired) {
        if (ticket.usedAt && ticket.usedAt.getTime() + INVITATION_CODE_MAIL_TIMEOUT_MS > Date.now()) return bare400();
      } else if (ticket.usedAt) {
        return bare400();
      }
    }

    if (emailRequired) {
      const lower = username.toLowerCase();
      if ((await c.query(`SELECT 1 AS ok FROM "user" WHERE "usernameLower" = $1 AND host IS NULL LIMIT 1`, [lower])).rows.length) {
        return replyError(400, "DUPLICATED_USERNAME");
      }
      if ((await c.query(`SELECT 1 AS ok FROM used_username WHERE username = $1 LIMIT 1`, [lower])).rows.length) {
        return replyError(400, "USED_USERNAME");
      }
      if (((meta.preservedUsernames as string[] | undefined) ?? []).map((x) => x.toLowerCase()).includes(lower)) {
        return replyError(400, "DENIED_USERNAME");
      }
      const code = secureRndstr(16, L_CHARS);
      const hash = await bcrypt.hash(password, await bcrypt.genSalt(8));
      if (ticket && !(await claimTicket(c, ticket.id, true))) return bare400();
      try {
        const pendingId = genAidx(Date.now());
        await c.query(`INSERT INTO user_pending (id, code, email, username, password) VALUES ($1, $2, $3, $4, $5)`, [
          pendingId, code, emailAddress, username, hash,
        ]);
        const link = `${baseUrl(env)}/signup-complete/${code}`;
        await sendEmail(env, emailAddress as string, "Signup",
          `To complete signup, please click this link:<br><a href="${link}">${link}</a>`,
          `To complete signup, please click this link: ${link}`);
        if (ticket) await c.query(`UPDATE registration_ticket SET "pendingUserId" = $2 WHERE id = $1`, [ticket.id, pendingId]);
      } catch (e) {
        if (ticket) await releaseTicket(c, ticket.id);
        throw e;
      }
      return new Response(null, { status: 204 });
    }

    if (ticket && !(await claimTicket(c, ticket.id, false))) return bare400();
    let result: SignupResult;
    try {
      result = await signupLocal(c, { username, password });
    } catch (e) {
      if (ticket) await releaseTicket(c, ticket.id);
      return replyError(400, e instanceof Error ? e.toString() : String(e));
    }
    if (!result.ok) {
      if (ticket) await releaseTicket(c, ticket.id);
      return signupErrorResponse(result);
    }
    if (ticket) await c.query(`UPDATE registration_ticket SET "usedById" = $2 WHERE id = $1`, [ticket.id, result.user.id]);
    return { userId: result.user.id, secret: result.secret };
  }).then(async (r) => {
    if (r instanceof Response) return r;
    const { userId, secret } = r as { userId: string; secret: string };
    const { notifyUserCreatedSystemWebhook } = await import("./system-webhooks-pg.js");
    await notifyUserCreatedSystemWebhook(env, userId);
    // UserEntityService.pack(account, account, { schema: 'MeDetailed', includeSecrets: true }) + token
    const me = await packMe(env, userId, { includeSecrets: true });
    if (me instanceof Response) return me;
    return { ...me, token: secret };
  });
};

// ---------------------------------------------------------------- POST /api/signup-pending

/** SigninService.signin: history row, `signin` on main, `login` notification and the login mail. */
async function recordSignin(env: ApiEnv, userId: string, request: Request): Promise<void> {
  try {
    const info = signinRequestInfo(request);
    const id = genAidx(Date.now());
    const profile = await withHyperdriveClient(hd(env), async (c) => {
      await c.query(`INSERT INTO signin (id, "userId", ip, headers, success) VALUES ($1, $2, $3, $4::jsonb, TRUE)`, [id, userId, info.ip ?? "", JSON.stringify(info.headers)]);
      return (await c.query(`SELECT email, "emailVerified" FROM user_profile WHERE "userId" = $1`, [userId])).rows[0];
    });
    const { publishToUserStream } = await import("./stream-publish.js");
    const { createNotification } = await import("./notifications-do.js");
    await publishToUserStream(env, userId, "main", "signin", { id, createdAt: new Date().toISOString(), ip: info.ip ?? "", headers: info.headers, success: true });
    await createNotification(env, userId, { type: "login", notifierId: null });
    if (profile?.email && profile.emailVerified) await sendLoginEmail(env, String(profile.email));
  } catch (e) {
    console.warn(`signin record failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

const LOGIN_MAIL =
  "There is a new login. If you do not recognize this login, update the security status of your account, including changing your password. / 新しいログインがありました。このログインに心当たりがない場合は、パスワードを変更するなど、アカウントのセキュリティ状態を更新してください。";

/** SigninService.signin's mail to a verified address. */
export async function sendLoginEmail(env: ApiEnv, to: string): Promise<void> {
  await sendEmail(env, to, "New login / ログインがありました", LOGIN_MAIL, LOGIN_MAIL);
}

const signupPending: Handler = async (env, body, ctx) => {
  const code = body.code;
  if (typeof code !== "string") return replyError(400, "EntityNotFoundError: Could not find any entity of type \"MiUserPending\"");
  const r = await withHyperdriveClient(hd(env), async (c) => {
    const pending = (await c.query(`SELECT id, code, email, username, password FROM user_pending WHERE code = $1 LIMIT 1`, [code])).rows[0];
    if (!pending) return replyError(400, "EntityNotFoundError: Could not find any entity of type \"MiUserPending\"");
    if ((parseAidxTime(String(pending.id))?.getTime() ?? 0) + INVITATION_CODE_MAIL_TIMEOUT_MS < Date.now()) return replyError(400, "Error: EXPIRED");
    const result = await signupLocal(c, { username: String(pending.username), passwordHash: String(pending.password) });
    if (!result.ok) return signupErrorResponse(result);
    await c.query(`DELETE FROM user_pending WHERE id = $1`, [pending.id]);
    await c.query(`UPDATE user_profile SET email = $2, "emailVerified" = TRUE, "emailVerifyCode" = NULL WHERE "userId" = $1`, [result.user.id, pending.email]);
    const ticket = await findTicket(c, `"pendingUserId" = $1`, pending.id);
    if (ticket) await c.query(`UPDATE registration_ticket SET "usedById" = $2, "pendingUserId" = NULL WHERE id = $1`, [ticket.id, result.user.id]);
    return { userId: result.user.id, secret: result.secret };
  });
  if (r instanceof Response) return r;
  const { notifyUserCreatedSystemWebhook } = await import("./system-webhooks-pg.js");
  await notifyUserCreatedSystemWebhook(env, r.userId);
  await recordSignin(env, r.userId, ctx.request);
  return { finished: true, id: r.userId, i: r.secret };
};

// ---------------------------------------------------------------- registry

/**
 * Unexpected errors: `signup` lets them reach Fastify's error handler (500, `message`);
 * `signupPending` wraps its whole body in try / FastifyReplyError(400, err.toString()).
 */
function pgOnly(h: Handler, onError: "500" | "400"): Handler {
  return async (env, body, ctx) => {
    if (!env.HYPERDRIVE?.connectionString) return replyError(500, "Hyperdrive required.");
    try {
      return await h(env, body, ctx);
    } catch (e) {
      if (onError === "500") return replyError(500, e instanceof Error ? e.message : String(e));
      return replyError(400, e instanceof Error ? e.toString() : String(e));
    }
  };
}

/** Special routes (not endpoints): not listed in IMPLEMENTED_ENDPOINTS / `endpoints`. */
export const signupApiHandlers: Record<string, Handler> = {
  signup: pgOnly(signup, "500"),
  "signup-pending": pgOnly(signupPending, "400"),
};
