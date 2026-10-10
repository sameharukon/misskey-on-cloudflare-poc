/**
 * Password signin (`POST /api/signin-flow`) via Hyperdrive.
 * Contract: misskey-js SigninFlowRequest / SigninFlowResponse.
 */

import bcrypt from "bcryptjs";
import type { ApiEnv } from "./env.js";
import { withHyperdriveClient, type PgQueryable } from "./pg.js";
import { authenticateWithClient, type AuthUser } from "./auth-pg.js";

export type SigninFlowOk =
  | { finished: true; id: string; i: string }
  | { finished: false; next: "captcha" | "password" | "totp" }
  | { finished: false; next: "passkey"; authRequest: unknown };

export type SigninFlowFail = { status: number; error: { id: string } };

export type SigninFlowResult =
  | { ok: true; body: SigninFlowOk }
  | { ok: false; status: number; error: { id: string } };

const ERR = {
  userNotFound: "6cc579cc-885d-43d8-95c2-b8c7fc963280",
  suspended: "e03a5f46-d309-4865-9b69-56282d94e1eb",
  badPassword: "932c904e-9460-45b7-9ce6-7ed33be7eb2c",
  generic: "4e30e80c-e338-45a0-8c8f-44455efa3b76",
  totp: "cdf1235b-ac71-46d4-a3a6-84ccce48df6f",
  passkey: "93b86c4b-72f9-40eb-9815-798928603d1e",
} as const;

/** Upstream SigninApiService's WebAuthn branch (passkey-pg.ts). */
type PasskeyOps = {
  usePasswordLessLogin: boolean;
  securityKeysAvailable: boolean;
  /** WebAuthnService.verifyAuthentication (throws WebAuthnError on a bad challenge / key) */
  verify: (credential: unknown) => Promise<boolean>;
  /** WebAuthnService.initiateAuthentication */
  initiate: () => Promise<unknown>;
};

function fail(status: number, id: string): SigninFlowResult {
  return { ok: false, status, error: { id } };
}

async function signinWithProfile(
  user: { id: string; token: string | null; isSuspended: boolean },
  profile: { password: string | null; twoFactorEnabled: boolean },
  password: string | undefined,
  totpToken: string | undefined,
  /** UserAuthService.twoFactorAuthenticate (TOTP or a backup code) */
  verifySecondFactor?: (token: string) => Promise<boolean>,
  credential?: unknown,
  passkey?: PasskeyOps,
): Promise<SigninFlowResult> {
  if (user.isSuspended) return fail(403, ERR.suspended);

  if (password == null) {
    if (profile.twoFactorEnabled) {
      return { ok: true, body: { finished: false, next: "password" } };
    }
    return { ok: true, body: { finished: false, next: "captcha" } };
  }

  if (typeof password !== "string" || !profile.password) {
    return fail(403, ERR.badPassword);
  }

  const same = await bcrypt.compare(password, profile.password);

  if (profile.twoFactorEnabled) {
    // upstream order: TOTP token, then a WebAuthn credential, then offer passkey / TOTP
    const passwordLess = Boolean(passkey?.usePasswordLessLogin);
    if (totpToken) {
      if (!same) return fail(403, ERR.badPassword);
      if (!verifySecondFactor || !(await verifySecondFactor(totpToken))) return fail(403, ERR.totp);
    } else if (credential && passkey) {
      if (!same && !passwordLess) return fail(403, ERR.badPassword);
      if (!(await passkey.verify(credential))) return fail(403, ERR.passkey);
    } else if (passkey?.securityKeysAvailable) {
      if (!same && !passwordLess) return fail(403, ERR.badPassword);
      return { ok: true, body: { finished: false, next: "passkey", authRequest: await passkey.initiate() } };
    } else {
      if (!same) return fail(403, ERR.badPassword);
      return { ok: true, body: { finished: false, next: "totp" } };
    }
  } else if (!same) {
    return fail(403, ERR.badPassword);
  }

  if (!user.token) return fail(500, ERR.generic);
  return { ok: true, body: { finished: true, id: user.id, i: user.token } };
}

/** Request metadata for the `signin` history row (upstream stores ip + request headers). */
export type SigninRequestInfo = { ip: string | null; headers: Record<string, string> };

export function signinRequestInfo(request: Request | undefined): SigninRequestInfo {
  if (!request) return { ip: null, headers: {} };
  const headers: Record<string, string> = {};
  // credentials are not kept in the history
  request.headers.forEach((v, k) => {
    if (k !== "authorization" && k !== "cookie") headers[k] = v;
  });
  return { ip: request.headers.get("cf-connecting-ip") ?? request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null, headers };
}

export async function signinFlowWithClient(
  client: PgQueryable,
  body: Record<string, unknown>,
  env?: ApiEnv,
  info: SigninRequestInfo = { ip: null, headers: {} },
): Promise<SigninFlowResult> {
  const username = body.username;
  if (typeof username !== "string") {
    return fail(400, ERR.generic);
  }
  const password = body.password === undefined ? undefined : String(body.password);
  const totpToken = body.token === undefined || body.token === null ? undefined : String(body.token);

  const ur = await client.query(
    `SELECT id, token, "isSuspended"
     FROM "user" WHERE "usernameLower" = $1 AND host IS NULL LIMIT 1`,
    [username.toLowerCase()],
  );
  const row = ur.rows[0];
  if (!row) return fail(404, ERR.userNotFound);

  const pr = await client.query(
    `SELECT to_jsonb(p) AS p
     FROM user_profile p WHERE "userId" = $1 LIMIT 1`,
    [row.id],
  );
  const profile = pr.rows[0]?.p as Record<string, unknown> | undefined;
  if (!profile) return fail(500, ERR.generic);
  const userId = String(row.id);

  const result = await signinWithProfile(
    {
      id: userId,
      token: (row.token as string | null) ?? null,
      isSuspended: Boolean(row.isSuspended),
    },
    {
      password: (profile.password as string | null) ?? null,
      twoFactorEnabled: Boolean(profile.twoFactorEnabled),
    },
    password,
    totpToken,
    env
      ? async (token) => {
          const { twoFactorAuthenticate } = await import("./account-pg.js");
          return twoFactorAuthenticate(env, client, {
            userId,
            password: null,
            twoFactorEnabled: true,
            twoFactorSecret: (profile.twoFactorSecret as string | null) ?? null,
            twoFactorTempSecret: null,
            twoFactorBackupSecret: Array.isArray(profile.twoFactorBackupSecret) ? (profile.twoFactorBackupSecret as string[]) : null,
          }, token);
        }
      : undefined,
    body.credential ?? undefined,
    env ? await (await import("./passkey-pg.js")).signinPasskeyOps(env, client, userId, Boolean(profile.usePasswordLessLogin)) : undefined,
  );

  // signin history: successes, and failures at the password / second-factor stage (upstream fail())
  const recorded = result.ok ? result.body.finished : result.error.id === ERR.badPassword || result.error.id === ERR.totp || result.error.id === ERR.passkey;
  if (recorded && password != null) await recordSignin(client, userId, info, result.ok, env);
  return result;
}

/**
 * Append a `signin` history row; on success also SigninService.signin's `signin` event on main
 * and the `login` notification. Errors are logged, not thrown.
 */
export async function recordSignin(client: PgQueryable, userId: string, info: SigninRequestInfo, success: boolean, env?: ApiEnv): Promise<void> {
  try {
    const { genAidx } = await import("../../id/src/index.js");
    const id = genAidx(Date.now());
    await client.query(`INSERT INTO signin (id, "userId", ip, headers, success) VALUES ($1, $2, $3, $4::jsonb, $5)`, [
      id, userId, info.ip ?? "", JSON.stringify(info.headers), success,
    ]);
    if (success && env) {
      // SigninService.signin: `signin` on main and a `login` notification
      const { publishToUserStream } = await import("./stream-publish.js");
      const { createNotification } = await import("./notifications-do.js");
      await publishToUserStream(env, userId, "main", "signin", { id, createdAt: new Date().toISOString(), ip: info.ip ?? "", headers: info.headers, success: true });
      await createNotification(env, userId, { type: "login", notifierId: null });
      // ... and the login mail to a verified address
      const p = (await client.query(`SELECT email, "emailVerified" FROM user_profile WHERE "userId" = $1`, [userId])).rows[0];
      if (typeof p?.email === "string" && p.email && p.emailVerified) {
        const { sendLoginEmail } = await import("./signup-api-pg.js");
        await sendLoginEmail(env, p.email);
      }
    }
  } catch (e) {
    console.warn(`signin history failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export async function signinFlow(
  env: ApiEnv,
  body: Record<string, unknown>,
  request?: Request,
): Promise<SigninFlowResult> {
  if (env.HYPERDRIVE?.connectionString) {
    return withHyperdriveClient(env.HYPERDRIVE, (c) => signinFlowWithClient(c, body, env, signinRequestInfo(request)));
  }
  return fail(501, ERR.generic);
}

/** Resolve AuthUser after successful signin (optional enrichment). */
export async function loadUserByNativeToken(
  env: ApiEnv,
  token: string,
): Promise<AuthUser | null> {
  if (!env.HYPERDRIVE?.connectionString) return null;
  return withHyperdriveClient(env.HYPERDRIVE, async (c) => {
    const auth = await authenticateWithClient(c, token);
    return auth?.user ?? null;
  });
}
