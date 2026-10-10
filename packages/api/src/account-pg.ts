/**
 * Account security endpoints (W7.10) on PG, following upstream:
 * i/change-password, i/regenerate-token, i/revoke-token, i/apps, i/authorized-apps,
 * i/signin-history, i/2fa/register|done|unregister|password-less, and
 * `twoFactorAuthenticate` (backup codes, TOTP with replay protection) shared with signin-flow.
 *
 * Security keys / passkeys (i/2fa/register-key|key-done|remove-key|update-key, WebAuthn) are in
 * passkey-pg.ts.
 *
 * Upstream throws plain Errors in several of these (wrong password, bad TOTP); those surface as
 * INTERNAL_ERROR 500 there and here.
 */

import bcrypt from "bcryptjs";
import qrcode from "qrcode-generator";
import { parseAidxTime } from "../../id/src/index.js";
import type { ApiEnv } from "./env.js";
import { apiErrorResponse, CREDENTIAL_REQUIRED, INTERNAL_ERROR, type ApiErrorBody } from "./errors.js";
import { authenticatePg, extractToken } from "./auth-pg.js";
import { withHyperdriveClient, type PgQueryable } from "./pg.js";
import { buildPackConfig } from "./meta-source.js";
import { generateNativeUserToken } from "./signup-pg.js";
import { publishToUserStream } from "./stream-publish.js";
import { packMe } from "./client-endpoints-pg.js";
import { claimOnce } from "./once-guard.js";
import { generateSecret, otpauthUrl, sha256Base64Url, totpCounter, TOTP_PERIOD, validateTotp } from "./totp.js";
import { hd, invalidParam as bad } from "./handler-kit.js";

export type Ctx = { hasCredential: boolean; request: Request };
type Body = Record<string, unknown>;
export type AccountHandler = (env: ApiEnv, body: Body, ctx: Ctx) => Promise<Response | unknown>;

const err = (code: string, id: string, message: string, kind: ApiErrorBody["kind"] = "client"): ApiErrorBody => ({ message, code, id, kind });
const E = {
  registerIncorrectPassword: err("INCORRECT_PASSWORD", "78d6c839-20c9-4c66-b90a-fc0542168b48", "Incorrect password."),
  unregisterIncorrectPassword: err("INCORRECT_PASSWORD", "7add0395-9901-4098-82f9-4f67af65f775", "Incorrect password."),
  noKey: err("NO_SECURITY_KEY", "f9c54d7f-d4c2-4d3c-9a8g-a70daac86512", "No security key."),
  revokeCredentialRequired: err("CREDENTIAL_REQUIRED", "6f1f0d3a-3d5b-4b1f-9c3e-2a6d1e5b8c47", "Credential required."),
  revokePermissionDenied: err("PERMISSION_DENIED", "fc20d118-5705-4462-b6c5-2b5b43092cf3", "Permission denied.", "permission"),
};

const internal = () => apiErrorResponse(INTERNAL_ERROR, 500);
const noContent = () => new Response(null, { status: 204 });
const iso = (id: string) => (parseAidxTime(id) ?? new Date(0)).toISOString();

export type Me = { id: string; username: string; accessTokenId: string | null };

export async function auth(env: ApiEnv, body: Body, ctx: Ctx): Promise<Me | null> {
  if (!ctx.hasCredential) return null;
  const token = extractToken(ctx.request, body);
  if (!token) return null;
  const a = await authenticatePg(env, token);
  return a ? { id: a.user.id, username: a.user.username, accessTokenId: a.accessTokenId } : null;
}

export type Profile = {
  userId: string;
  password: string | null;
  twoFactorEnabled: boolean;
  twoFactorSecret: string | null;
  twoFactorTempSecret: string | null;
  twoFactorBackupSecret: string[] | null;
};

export async function getProfile(c: PgQueryable, userId: string): Promise<Profile | null> {
  const r = (await c.query(`SELECT to_jsonb(p) AS p FROM user_profile p WHERE "userId" = $1`, [userId])).rows[0];
  if (!r) return null;
  const p = r.p as Record<string, unknown>;
  return {
    userId,
    password: (p.password as string | null) ?? null,
    twoFactorEnabled: Boolean(p.twoFactorEnabled),
    twoFactorSecret: (p.twoFactorSecret as string | null) ?? null,
    twoFactorTempSecret: (p.twoFactorTempSecret as string | null) ?? null,
    twoFactorBackupSecret: Array.isArray(p.twoFactorBackupSecret) ? (p.twoFactorBackupSecret as string[]) : null,
  };
}

/**
 * UserAuthService.validateOtp: ±1 step, and each (secret, step) accepted once (upstream: Redis
 * SET NX with a TTL of three periods; here the OnceGuard DO `totp:{userId}`).
 */
export async function validateOtp(env: ApiEnv, userId: string, secret: string, token: string, now = Date.now()): Promise<boolean> {
  const t = token.trim();
  const delta = await validateTotp(secret, t, now, 1);
  if (delta === null) return false;
  const step = totpCounter(now) + delta;
  return claimOnce(env, `totp:${userId}`, `${await sha256Base64Url(secret)}:${step}`, TOTP_PERIOD * 3);
}

/** UserAuthService.twoFactorAuthenticate: a backup code is consumed, otherwise TOTP. */
export async function twoFactorAuthenticate(env: ApiEnv, c: PgQueryable, profile: Profile, token: string): Promise<boolean> {
  if (profile.twoFactorBackupSecret?.includes(token)) {
    await c.query(`UPDATE user_profile SET "twoFactorBackupSecret" = $2::varchar[] WHERE "userId" = $1`, [
      profile.userId,
      profile.twoFactorBackupSecret.filter((s) => s !== token),
    ]);
    return true;
  }
  return profile.twoFactorSecret != null && validateOtp(env, profile.userId, profile.twoFactorSecret, token);
}

/** The "if 2FA is on, the token must pass" prelude several endpoints share. */
export async function secondFactorOk(env: ApiEnv, c: PgQueryable, profile: Profile, token: unknown): Promise<boolean> {
  if (!profile.twoFactorEnabled) return true;
  if (typeof token !== "string") return false;
  return twoFactorAuthenticate(env, c, profile, token);
}

/** `meUpdated` with MeDetailed `includeSecrets: true` (as the i/2fa/* endpoints upstream). */
export async function publishMe(env: ApiEnv, userId: string): Promise<void> {
  const me = await packMe(env, userId, { includeSecrets: true });
  if (!(me instanceof Response)) await publishToUserStream(env, userId, "main", "meUpdated", me);
}

// ---------------------------------------------------------------- password / token

const changePassword: AccountHandler = async (env, body, ctx) => {
  const me = await auth(env, body, ctx);
  if (!me) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  if (typeof body.currentPassword !== "string" || typeof body.newPassword !== "string" || body.newPassword.length < 1) return bad();
  if (body.token != null && typeof body.token !== "string") return bad();
  return withHyperdriveClient(hd(env), async (c) => {
    const p = await getProfile(c, me.id);
    if (!p) return internal();
    if (!(await secondFactorOk(env, c, p, body.token))) return internal(); // 'authentication failed'
    if (!(await bcrypt.compare(body.currentPassword as string, p.password ?? ""))) return internal(); // 'incorrect password'
    const hash = await bcrypt.hash(body.newPassword as string, await bcrypt.genSalt(8));
    await c.query(`UPDATE user_profile SET password = $2 WHERE "userId" = $1`, [me.id, hash]);
    return noContent();
  });
};

const regenerateToken: AccountHandler = async (env, body, ctx) => {
  const me = await auth(env, body, ctx);
  if (!me) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  if (typeof body.password !== "string") return bad();
  const ok = await withHyperdriveClient(hd(env), async (c) => {
    const p = await getProfile(c, me.id);
    if (!p || !(await bcrypt.compare(body.password as string, p.password ?? ""))) return false;
    await c.query(`UPDATE "user" SET token = $2 WHERE id = $1`, [me.id, generateNativeUserToken()]);
    return true;
  });
  if (!ok) return internal(); // 'incorrect password'
  await publishToUserStream(env, me.id, "main", "myTokenRegenerated", undefined);
  return noContent();
};

const revokeToken: AccountHandler = async (env, body, ctx) => {
  const me = await auth(env, body, ctx);
  if (!me) return apiErrorResponse(E.revokeCredentialRequired, 401);
  const byId = typeof body.tokenId === "string";
  if (!byId && body.token !== null && typeof body.token !== "string") return bad();
  return withHyperdriveClient(hd(env), async (c) => {
    let target: Record<string, unknown> | undefined;
    if (byId) {
      target = (await c.query(`SELECT id FROM access_token WHERE id = $1 AND "userId" = $2`, [body.tokenId, me.id])).rows[0];
    } else {
      if (body.token == null || body.token === "") return noContent();
      target = (await c.query(`SELECT id FROM access_token WHERE token = $1 AND "userId" = $2`, [body.token, me.id])).rows[0];
    }
    if (!target) return noContent();
    // a third-party app may only revoke the token it is using
    if (me.accessTokenId != null && me.accessTokenId !== String(target.id)) return apiErrorResponse(E.revokePermissionDenied, 403);
    await c.query(`DELETE FROM access_token WHERE id = $1`, [target.id]);
    return noContent();
  });
};

// ---------------------------------------------------------------- apps / signins

const SORTS: Record<string, string> = {
  "+createdAt": `t.id DESC`,
  "-createdAt": `t.id ASC`,
  // (PostgreSQL defaults: NULLs first for DESC, last for ASC — as upstream's orderBy)
  "+lastUsedAt": `t."lastUsedAt" DESC`,
  "-lastUsedAt": `t."lastUsedAt" ASC`,
};

const apps: AccountHandler = async (env, body, ctx) => {
  const me = await auth(env, body, ctx);
  if (!me) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  if (body.sort !== undefined && !(String(body.sort) in SORTS)) return bad();
  return withHyperdriveClient(hd(env), async (c) => {
    const rows = (await c.query(
      `SELECT t.id, t.name, t."lastUsedAt", t.permission, t."iconUrl", t.description,
              a.name AS "appName", a.permission AS "appPermission", a.description AS "appDescription"
       FROM access_token t LEFT JOIN app a ON a.id = t."appId"
       WHERE t."userId" = $1 ORDER BY ${SORTS[String(body.sort)] ?? "t.id ASC"}`,
      [me.id],
    )).rows;
    return rows.map((t) => {
      const hasApp = t.appName != null;
      return {
        id: String(t.id),
        name: (t.name as string | null) ?? (t.appName as string | null) ?? undefined,
        createdAt: iso(String(t.id)),
        lastUsedAt: t.lastUsedAt ? new Date(String(t.lastUsedAt)).toISOString() : undefined,
        permission: (hasApp ? t.appPermission : t.permission) ?? [],
        iconUrl: (t.iconUrl as string | null) ?? null,
        description: (t.description as string | null) ?? (t.appDescription as string | null) ?? null,
      };
    });
  });
};

const authorizedApps: AccountHandler = async (env, body, ctx) => {
  const me = await auth(env, body, ctx);
  if (!me) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  const limit = body.limit === undefined ? 10 : Number(body.limit);
  const offset = body.offset === undefined ? 0 : Number(body.offset);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset)) return bad();
  if (body.sort !== undefined && body.sort !== "desc" && body.sort !== "asc") return bad();
  return withHyperdriveClient(hd(env), async (c) => {
    const rows = (await c.query(
      `SELECT a.id, a.name, a."callbackUrl", a.permission
       FROM access_token t JOIN app a ON a.id = t."appId"
       WHERE t."userId" = $1 ORDER BY t.id ${body.sort === "asc" ? "ASC" : "DESC"} LIMIT $2 OFFSET $3`,
      [me.id, limit, offset],
    )).rows;
    // AppEntityService.pack(appId, me, { detail: true }): the caller holds a token for each
    return rows.map((a) => ({
      id: String(a.id),
      name: String(a.name),
      callbackUrl: (a.callbackUrl as string | null) ?? null,
      permission: (a.permission as string[] | null) ?? [],
      isAuthorized: true,
    }));
  });
};

const signinHistory: AccountHandler = async (env, body, ctx) => {
  const me = await auth(env, body, ctx);
  if (!me) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  const limit = body.limit === undefined ? 10 : Number(body.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) return bad();
  const { pagination } = await import("./client-endpoints-pg.js");
  return withHyperdriveClient(hd(env), async (c) => {
    const params: unknown[] = [me.id];
    // makePaginationQuery
    const pg = pagination(body, params, "id");
    const where = [`"userId" = $1`, ...pg.where].join(" AND ");
    params.push(limit);
    const rows = (await c.query(`SELECT id, ip, headers, success FROM signin WHERE ${where} ORDER BY id ${pg.order} LIMIT $${params.length}`, params)).rows;
    return rows.map((s) => ({ id: String(s.id), createdAt: iso(String(s.id)), ip: s.ip, headers: s.headers, success: Boolean(s.success) }));
  });
};

// ---------------------------------------------------------------- 2FA (TOTP)

const twoFaRegister: AccountHandler = async (env, body, ctx) => {
  const me = await auth(env, body, ctx);
  if (!me) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  if (typeof body.password !== "string" || (body.token != null && typeof body.token !== "string")) return bad();
  return withHyperdriveClient(hd(env), async (c) => {
    const p = await getProfile(c, me.id);
    if (!p) return internal();
    if (!(await secondFactorOk(env, c, p, body.token))) return internal(); // 'authentication failed'
    if (!(await bcrypt.compare(body.password as string, p.password ?? ""))) return apiErrorResponse(E.registerIncorrectPassword, 400);
    const secret = generateSecret();
    await c.query(`UPDATE user_profile SET "twoFactorTempSecret" = $2 WHERE "userId" = $1`, [me.id, secret]);
    const issuer = buildPackConfig(env).host;
    const url = otpauthUrl(secret, me.username, issuer);
    const qr = qrcode(0, "M");
    qr.addData(url);
    qr.make();
    return { qr: qr.createDataURL(4, 16), url, secret, label: me.username, issuer };
  });
};

const twoFaDone: AccountHandler = async (env, body, ctx) => {
  const me = await auth(env, body, ctx);
  if (!me) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  if (typeof body.token !== "string") return bad();
  const token = body.token.replace(/\s/g, "");
  const codes = await withHyperdriveClient(hd(env), async (c) => {
    const p = await getProfile(c, me.id);
    if (!p?.twoFactorTempSecret) return null; // '二段階認証の設定が開始されていません'
    if (!(await validateOtp(env, me.id, p.twoFactorTempSecret, token))) return null; // 'not verified'
    const backupCodes = Array.from({ length: 5 }, () => generateSecret());
    await c.query(
      `UPDATE user_profile SET "twoFactorSecret" = $2, "twoFactorBackupSecret" = $3::varchar[], "twoFactorEnabled" = TRUE WHERE "userId" = $1`,
      [me.id, p.twoFactorTempSecret, backupCodes],
    );
    return backupCodes;
  });
  if (!codes) return internal();
  await publishMe(env, me.id);
  return { backupCodes: codes };
};

const twoFaUnregister: AccountHandler = async (env, body, ctx) => {
  const me = await auth(env, body, ctx);
  if (!me) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  if (typeof body.password !== "string" || (body.token != null && typeof body.token !== "string")) return bad();
  const r = await withHyperdriveClient(hd(env), async (c) => {
    const p = await getProfile(c, me.id);
    if (!p) return internal();
    if (!(await secondFactorOk(env, c, p, body.token))) return internal(); // 'authentication failed'
    if (!(await bcrypt.compare(body.password as string, p.password ?? ""))) return apiErrorResponse(E.unregisterIncorrectPassword, 400);
    await c.query(
      `UPDATE user_profile SET "twoFactorSecret" = NULL, "twoFactorBackupSecret" = NULL, "twoFactorEnabled" = FALSE, "usePasswordLessLogin" = FALSE WHERE "userId" = $1`,
      [me.id],
    );
    return null;
  });
  if (r) return r;
  await publishMe(env, me.id);
  return noContent();
};

async function securityKeyCount(c: PgQueryable, userId: string): Promise<number> {
  try {
    return Number((await c.query(`SELECT count(*)::int AS n FROM user_security_key WHERE "userId" = $1`, [userId])).rows[0]?.n ?? 0);
  } catch {
    return 0; // no table
  }
}

const twoFaPasswordLess: AccountHandler = async (env, body, ctx) => {
  const me = await auth(env, body, ctx);
  if (!me) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  if (typeof body.value !== "boolean") return bad();
  const r = await withHyperdriveClient(hd(env), async (c) => {
    if (body.value === true && (await securityKeyCount(c, me.id)) === 0) {
      await c.query(`UPDATE user_profile SET "usePasswordLessLogin" = FALSE WHERE "userId" = $1`, [me.id]);
      return apiErrorResponse(E.noKey, 400);
    }
    await c.query(`UPDATE user_profile SET "usePasswordLessLogin" = $2 WHERE "userId" = $1`, [me.id, body.value]);
    return null;
  });
  if (r) return r;
  await publishMe(env, me.id);
  return noContent();
};

// ---------------------------------------------------------------- registry

function pgOnly(h: AccountHandler): AccountHandler {
  return async (env, body, ctx) => {
    if (!env.HYPERDRIVE?.connectionString) {
      return apiErrorResponse({ message: "Hyperdrive required.", code: "HYPERDRIVE_UNBOUND", id: "00000000-0000-4000-8000-0000000000b1", kind: "server" }, 501);
    }
    return h(env, body, ctx);
  };
}

const RAW: Record<string, AccountHandler> = {
  "i/change-password": changePassword,
  "i/regenerate-token": regenerateToken,
  "i/revoke-token": revokeToken,
  "i/apps": apps,
  "i/authorized-apps": authorizedApps,
  "i/signin-history": signinHistory,
  "i/2fa/register": twoFaRegister,
  "i/2fa/done": twoFaDone,
  "i/2fa/unregister": twoFaUnregister,
  "i/2fa/password-less": twoFaPasswordLess,
};

export const accountHandlers: Record<string, AccountHandler> = Object.fromEntries(Object.entries(RAW).map(([k, h]) => [k, pgOnly(h)]));

