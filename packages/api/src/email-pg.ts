/**
 * Mail-backed account endpoints on PG, following upstream: i/update-email, verify-email,
 * admin/send-email, request-reset-password, reset-password. Mail goes through `sendEmail()`
 * (`email.ts`: a `sendEmail` job on `mk-jobs`, Cloudflare Email Service).
 *
 * Upstream throws plain Errors in a few places (2FA failure in i/update-email, unknown or expired
 * token in reset-password); those surface as INTERNAL_ERROR 500 there and here.
 */

import bcrypt from "bcryptjs";
import { genAidx, parseAidxTime } from "../../id/src/index.js";
import type { ApiEnv } from "./env.js";
import { apiErrorResponse, CREDENTIAL_REQUIRED, INTERNAL_ERROR } from "./errors.js";
import { withHyperdriveClient } from "./pg.js";
import { packMe } from "./client-endpoints-pg.js";
import { publishToUserStream } from "./stream-publish.js";
import { getProfile, twoFactorAuthenticate } from "./account-pg.js";
import { validateEmailForAccountPg } from "./misc-pg.js";
import { secureRndstr } from "./crypto-util.js";
import { metaJson, runSendEmailJob, sendEmail } from "./email.js";
import { adminGate } from "./admin-gate.js";
import { authUserId as auth, clientError as err, hd, invalidParam as bad } from "./handler-kit.js";

type Ctx = { hasCredential: boolean; request: Request };
type Body = Record<string, unknown>;
type Handler = (env: ApiEnv, body: Body, ctx: Ctx) => Promise<Response | unknown>;

/** upstream misc/secure-rndstr.ts L_CHARS */
export const L_CHARS = "0123456789abcdefghijklmnopqrstuvwxyz";
const RESET_TOKEN_TTL_MS = 30 * 60 * 1000;

const E = {
  incorrectPassword: err("INCORRECT_PASSWORD", "e54c1d7e-e7d6-4103-86b6-0a95069b4ad3", "Incorrect password."),
  unavailable: err("UNAVAILABLE", "a2defefb-f220-8849-0af6-17f816099323", "Unavailable email address."),
  emailRequired: err("EMAIL_REQUIRED", "324c7a88-59f2-492f-903f-89134f93e47e", "Email address is required."),
  noSuchCode: err("NO_SUCH_CODE", "97c1f576-e4b8-4b8a-a6dc-9cb65e7f6f85", "No such code."),
};

const internal = () => apiErrorResponse(INTERNAL_ERROR, 500);
const noContent = () => new Response(null, { status: 204 });
const baseUrl = (env: ApiEnv) => (env.INSTANCE_URL ?? "https://localhost").replace(/\/$/, "");

async function publishMeUpdated(env: ApiEnv, userId: string, packed?: unknown): Promise<void> {
  try {
    const me = packed ?? (await packMe(env, userId, { includeSecrets: true }));
    if (!(me instanceof Response)) await publishToUserStream(env, userId, "main", "meUpdated", me);
  } catch {
    /* streaming is best-effort */
  }
}

// ---------------------------------------------------------------- i/update-email, verify-email

const updateEmail: Handler = async (env, body, ctx) => {
  const me = await auth(env, body, ctx);
  if (!me) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  if (typeof body.password !== "string") return bad();
  if (body.email != null && typeof body.email !== "string") return bad();
  if (body.token != null && typeof body.token !== "string") return bad();
  const email = (body.email as string | null | undefined) ?? null;
  const r = await withHyperdriveClient(hd(env), async (c) => {
    const profile = await getProfile(c, me);
    if (!profile) return internal();
    if (profile.twoFactorEnabled) {
      // upstream: throw new Error('authentication failed')
      if (typeof body.token !== "string" || !(await twoFactorAuthenticate(env, c, profile, body.token))) return internal();
    }
    if (!profile.password) return internal(); // bcrypt.compare(…, null) throws upstream
    if (!(await bcrypt.compare(body.password as string, profile.password))) return apiErrorResponse(E.incorrectPassword, 400);
    if (email != null) {
      if (!(await validateEmailForAccountPg(c, email, env)).available) return apiErrorResponse(E.unavailable, 400);
    } else if ((await metaJson(c)).emailRequiredForSignup) {
      return apiErrorResponse(E.emailRequired, 400);
    }
    await c.query(`UPDATE user_profile SET email = $2, "emailVerified" = FALSE, "emailVerifyCode" = NULL WHERE "userId" = $1`, [me, email]);
    return null;
  });
  if (r) return r;
  const iObj = await packMe(env, me, { includeSecrets: true });
  if (iObj instanceof Response) return iObj;
  await publishMeUpdated(env, me, iObj);
  if (email != null) {
    const code = secureRndstr(16, L_CHARS);
    await withHyperdriveClient(hd(env), (c) => c.query(`UPDATE user_profile SET "emailVerifyCode" = $2 WHERE "userId" = $1`, [me, code]));
    const link = `${baseUrl(env)}/verify-email/${code}`;
    await sendEmail(env, email, "Email verification",
      `To verify email, please click this link:<br><a href="${link}">${link}</a>`,
      `To verify email, please click this link: ${link}`);
  }
  return iObj;
};

const verifyEmail: Handler = async (env, body) => {
  if (typeof body.code !== "string") return bad();
  const userId = await withHyperdriveClient(hd(env), async (c) => {
    const p = (await c.query(`SELECT "userId" FROM user_profile WHERE "emailVerifyCode" = $1 LIMIT 1`, [body.code])).rows[0];
    if (!p) return null;
    await c.query(`UPDATE user_profile SET "emailVerified" = TRUE, "emailVerifyCode" = NULL WHERE "userId" = $1`, [p.userId]);
    return String(p.userId);
  });
  if (!userId) return apiErrorResponse(E.noSuchCode, 400);
  await publishMeUpdated(env, userId);
  return noContent();
};

// ---------------------------------------------------------------- admin/send-email

const adminSendEmail: Handler = async (env, body, ctx) => {
  const denied = await adminGate(ctx.request, env as never, body, "moderator");
  if (denied) return denied;
  if (typeof body.to !== "string" || typeof body.subject !== "string" || typeof body.text !== "string") return bad();
  // upstream awaits EmailService.sendEmail(to, subject, text, text): sent now, errors → 500
  try {
    await runSendEmailJob(env, { kind: "sendEmail", to: body.to, subject: body.subject, html: body.text, text: body.text });
  } catch {
    return internal();
  }
  return noContent();
};

// ---------------------------------------------------------------- password reset

const requestResetPassword: Handler = async (env, body) => {
  if (typeof body.username !== "string" || typeof body.email !== "string") return bad();
  const email = body.email;
  const token = await withHyperdriveClient(hd(env), async (c) => {
    const user = (await c.query(`SELECT id FROM "user" WHERE "usernameLower" = $1 AND host IS NULL LIMIT 1`, [(body.username as string).toLowerCase()])).rows[0];
    if (!user) return null; // unknown users are ignored
    const p = (await c.query(`SELECT email, "emailVerified" FROM user_profile WHERE "userId" = $1`, [user.id])).rows[0];
    if (!p) return "missing" as const; // findOneByOrFail → 500
    if (p.email !== email || !p.emailVerified) return null;
    const token = secureRndstr(64, L_CHARS);
    await c.query(`INSERT INTO password_reset_request (id, token, "userId") VALUES ($1, $2, $3)`, [genAidx(Date.now()), token, user.id]);
    return token;
  });
  if (token === "missing") return internal();
  if (token) {
    const link = `${baseUrl(env)}/reset-password/${token}`;
    await sendEmail(env, email, "Password reset requested",
      `To reset password, please click this link:<br><a href="${link}">${link}</a>`,
      `To reset password, please click this link: ${link}`);
  }
  return noContent();
};

const resetPassword: Handler = async (env, body) => {
  if (typeof body.token !== "string" || typeof body.password !== "string") return bad();
  return withHyperdriveClient(hd(env), async (c) => {
    const req = (await c.query(`SELECT id, "userId" FROM password_reset_request WHERE token = $1 LIMIT 1`, [body.token])).rows[0];
    if (!req) return internal(); // findOneByOrFail
    const issued = parseAidxTime(String(req.id))?.getTime() ?? 0;
    if (Date.now() - issued > RESET_TOKEN_TTL_MS) return internal(); // upstream: throw new Error()
    const hash = await bcrypt.hash(body.password as string, await bcrypt.genSalt(8));
    await c.query(`UPDATE user_profile SET password = $2 WHERE "userId" = $1`, [req.userId, hash]);
    await c.query(`DELETE FROM password_reset_request WHERE id = $1`, [req.id]);
    return noContent();
  });
};

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
  "i/update-email": updateEmail,
  "verify-email": verifyEmail,
  "admin/send-email": adminSendEmail,
  "request-reset-password": requestResetPassword,
  "reset-password": resetPassword,
};

export const emailHandlers: Record<string, Handler> = Object.fromEntries(Object.entries(RAW).map(([k, h]) => [k, pgOnly(h)]));

