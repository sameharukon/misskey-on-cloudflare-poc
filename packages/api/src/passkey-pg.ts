/**
 * Security keys / passkeys (WebAuthn) on PG, following upstream core/WebAuthnService.ts and
 * endpoints i/2fa/register-key|key-done|update-key|remove-key, SigninApiService's `credential` /
 * `next: "passkey"` branch (via `signinPasskeyOps`) and SigninWithPasskeyApiService
 * (`POST /api/signin-with-passkey`, usernameless sign-in).
 *
 * Verification is webauthn.ts (WebCrypto; upstream uses @simplewebauthn/server). Challenges live
 * 90 s and are single-use, as upstream's Redis SETEX / GETDEL: here `putOnce` / `takeOnce` on the
 * OnceGuard DO (without the binding, in isolate memory only). Keys are stored in
 * `user_security_key` exactly as upstream (id = base64url credential id, publicKey = base64url
 * COSE_Key, counter, lastUsed, credentialDeviceType, credentialBackedUp, transports).
 */

import bcrypt from "bcryptjs";
import type { ApiEnv } from "./env.js";
import { apiErrorResponse, CREDENTIAL_REQUIRED, INTERNAL_ERROR, type ApiErrorBody } from "./errors.js";
import { withHyperdriveClient, type PgQueryable } from "./pg.js";
import { loadMetaSource, buildPackConfig } from "./meta-source.js";
import { auth, getProfile, publishMe, secondFactorOk, type AccountHandler } from "./account-pg.js";
import { putOnce, takeOnce } from "./once-guard.js";
import { ipActor, rateLimit } from "./rate-limit.js";
import { recordSignin, signinRequestInfo } from "./signin-pg.js";
import {
  authenticationOptions,
  b64uDecode,
  b64uEncode,
  migrateLegacyPublicKey,
  registrationOptions,
  relyingParty,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type RelyingParty,
} from "./webauthn.js";
import { hd, invalidParam as bad } from "./handler-kit.js";

/** upstream IdentifiableError */
export class WebAuthnError extends Error {
  constructor(readonly id: string, message: string) {
    super(message);
    this.name = "IdentifiableError";
  }
}

const CHALLENGE_TTL = 90;
const ID = {
  regChallengeNotFound: "7dbfb66c-9216-4e2b-9c27-cef2ac8efb84",
  regFailed: "5c1446f8-8ca7-4d31-9f39-656afe9c5d87",
  noKeys: "f27fd449-9af4-4841-9249-1f989b9fa4a4",
  challengeNotFound: "2d16e51c-007b-4edd-afd2-f7dd02c947f6",
  unknownKey: "36b96a7d-b547-412d-aeed-2d611cdc8cdc",
  authFailed: "b18c89a7-5b5e-4cec-bb5b-0419f332d430",
};

async function getRelyingParty(env: ApiEnv): Promise<RelyingParty> {
  const meta = await loadMetaSource(env).catch(() => null);
  return relyingParty(buildPackConfig(env).url, meta?.name ?? null);
}

type KeyRow = { id: string; userId: string; publicKey: string; counter: number; transports: string[] | null };

async function keysOf(c: PgQueryable, userId: string): Promise<KeyRow[]> {
  const rows = (await c.query(`SELECT to_jsonb(k) AS k FROM user_security_key k WHERE "userId" = $1 ORDER BY id`, [userId])).rows;
  return rows.map((r) => toKey(r.k as Record<string, unknown>));
}

function toKey(k: Record<string, unknown>): KeyRow {
  return {
    id: String(k.id),
    userId: String(k.userId),
    publicKey: String(k.publicKey),
    counter: Number(k.counter ?? 0),
    transports: Array.isArray(k.transports) ? (k.transports as string[]) : null,
  };
}

async function findKey(c: PgQueryable, id: string, userId?: string): Promise<KeyRow | null> {
  const r = userId
    ? await c.query(`SELECT to_jsonb(k) AS k FROM user_security_key k WHERE id = $1 AND "userId" = $2`, [id, userId])
    : await c.query(`SELECT to_jsonb(k) AS k FROM user_security_key k WHERE id = $1`, [id]);
  const row = r.rows[0];
  return row ? toKey(row.k as Record<string, unknown>) : null;
}

const credentialId = (response: unknown): string => {
  const id = (response as { id?: unknown } | null)?.id;
  return typeof id === "string" ? id : "";
};

// ---------------------------------------------------------------- WebAuthnService

export async function initiateRegistration(env: ApiEnv, c: PgQueryable, userId: string, userName: string, displayName?: string) {
  const rp = await getRelyingParty(env);
  const keys = await keysOf(c, userId);
  const options = registrationOptions(rp, { id: userId, name: userName, displayName }, keys);
  await putOnce(env, `webauthn:registrationChallenge:${userId}`, options.challenge, CHALLENGE_TTL);
  return options;
}

export async function verifyRegistration(env: ApiEnv, userId: string, response: unknown) {
  const challenge = await takeOnce(env, `webauthn:registrationChallenge:${userId}`);
  if (!challenge) throw new WebAuthnError(ID.regChallengeNotFound, "challenge not found");
  const rp = await getRelyingParty(env);
  try {
    return await verifyRegistrationResponse(response, { challenge, origin: rp.origin, rpId: rp.rpId });
  } catch (e) {
    console.warn(`webauthn registration: ${e instanceof Error ? e.message : String(e)}`);
    throw new WebAuthnError(ID.regFailed, "verification failed");
  }
}

export async function initiateAuthentication(env: ApiEnv, c: PgQueryable, userId: string) {
  const rp = await getRelyingParty(env);
  const keys = await keysOf(c, userId);
  if (keys.length === 0) throw new WebAuthnError(ID.noKeys, "no keys found");
  const options = authenticationOptions(rp, keys);
  await putOnce(env, `webauthn:authenticationChallenge:${userId}`, options.challenge, CHALLENGE_TTL);
  return options;
}

/** Shared tail of verifyAuthentication / verifySignInWithPasskeyAuthentication. */
async function verifyWithKey(env: ApiEnv, c: PgQueryable, key: KeyRow, challenge: string, response: unknown, errorDetail: boolean): Promise<boolean> {
  const rp = await getRelyingParty(env);
  let info;
  try {
    info = await verifyAuthenticationResponse(response, { challenge, origin: rp.origin, rpId: rp.rpId }, { publicKey: b64uDecode(key.publicKey), counter: key.counter });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`webauthn authentication: ${msg}`);
    throw new WebAuthnError(ID.authFailed, errorDetail ? `verification failed: ${msg}` : "verification failed");
  }
  if (!info.verified) return false;
  await c.query(
    `UPDATE user_security_key SET "lastUsed" = now(), counter = $2, "credentialDeviceType" = $3, "credentialBackedUp" = $4 WHERE id = $1 AND "userId" = $5`,
    [key.id, info.newCounter, info.credentialDeviceType, info.credentialBackedUp, key.userId],
  );
  return true;
}

export async function verifyAuthentication(env: ApiEnv, c: PgQueryable, userId: string, response: unknown): Promise<boolean> {
  const challenge = await takeOnce(env, `webauthn:authenticationChallenge:${userId}`);
  if (!challenge) throw new WebAuthnError(ID.challengeNotFound, "challenge not found");
  const key = await findKey(c, credentialId(response), userId);
  if (!key) throw new WebAuthnError(ID.unknownKey, "unknown key");
  // keys stored by the pre-13 implementation (raw P-256 point) → COSE (upstream "マイグレーション")
  const migrated = migrateLegacyPublicKey(key.publicKey, key.counter);
  if (migrated) {
    await c.query(`UPDATE user_security_key SET "publicKey" = $3 WHERE id = $1 AND "userId" = $2`, [key.id, userId, migrated]);
    key.publicKey = migrated;
  }
  return verifyWithKey(env, c, key, challenge, response, false);
}

export async function initiateSignInWithPasskeyAuthentication(env: ApiEnv, context: string) {
  const rp = await getRelyingParty(env);
  const options = authenticationOptions(rp, undefined);
  await putOnce(env, `webauthn:passkeyChallenge:${context}`, options.challenge, CHALLENGE_TTL);
  return options;
}

export async function verifySignInWithPasskeyAuthentication(env: ApiEnv, c: PgQueryable, context: string, response: unknown): Promise<string | null> {
  const challenge = await takeOnce(env, `webauthn:passkeyChallenge:${context}`);
  if (!challenge) throw new WebAuthnError(ID.challengeNotFound, `challenge '${context}' not found`);
  const key = await findKey(c, credentialId(response));
  if (!key) throw new WebAuthnError(ID.unknownKey, "Unknown Webauthn key");
  return (await verifyWithKey(env, c, key, challenge, response, true)) ? key.userId : null;
}

async function securityKeyCount(c: PgQueryable, userId: string): Promise<number> {
  return Number((await c.query(`SELECT count(*)::int AS n FROM user_security_key WHERE "userId" = $1`, [userId])).rows[0]?.n ?? 0);
}

/** The WebAuthn hooks signin-flow (SigninApiService) uses. */
export async function signinPasskeyOps(env: ApiEnv, c: PgQueryable, userId: string, usePasswordLessLogin: boolean) {
  let securityKeysAvailable = false;
  try {
    securityKeysAvailable = (await securityKeyCount(c, userId)) >= 1;
  } catch {
    /* no table */
  }
  return {
    usePasswordLessLogin,
    securityKeysAvailable,
    verify: (credential: unknown) => verifyAuthentication(env, c, userId, credential),
    initiate: () => initiateAuthentication(env, c, userId),
  };
}

// ---------------------------------------------------------------- i/2fa/*-key endpoints

const err = (code: string, id: string, message: string, kind: ApiErrorBody["kind"] = "client"): ApiErrorBody => ({ message, code, id, kind });
const E = {
  registerUserNotFound: err("USER_NOT_FOUND", "652f899f-66d4-490e-993e-6606c8ec04c3", "User not found."),
  registerIncorrectPassword: err("INCORRECT_PASSWORD", "38769596-efe2-4faf-9bec-abbb3f2cd9ba", "Incorrect password."),
  registerTwoFactorNotEnabled: err("TWO_FACTOR_NOT_ENABLED", "bf32b864-449b-47b8-974e-f9a5468546f1", "2fa not enabled."),
  doneIncorrectPassword: err("INCORRECT_PASSWORD", "0d7ec6d2-e652-443e-a7bf-9ee9a0cd77b0", "Incorrect password."),
  doneTwoFactorNotEnabled: err("TWO_FACTOR_NOT_ENABLED", "798d6847-b1ed-4f9c-b1f9-163c42655995", "2fa not enabled."),
  updateNoSuchKey: err("NO_SUCH_KEY", "f9c5467f-d492-4d3c-9a8g-a70dacc86512", "No such key."),
  updateAccessDenied: err("ACCESS_DENIED", "1fb7cb09-d46a-4fff-b8df-057708cce513", "You do not have edit privilege of this key."),
  removeIncorrectPassword: err("INCORRECT_PASSWORD", "141c598d-a825-44c8-9173-cfb9d92be493", "Incorrect password."),
};

const internal = () => apiErrorResponse(INTERNAL_ERROR, 500);
/** A plain Error / IdentifiableError thrown by an upstream endpoint → INTERNAL_ERROR with `info.e`. */
const thrown = (e: unknown) =>
  apiErrorResponse(INTERNAL_ERROR, 500, {
    e: { message: e instanceof Error ? e.message : String(e), code: e instanceof Error ? e.name : "Error", id: crypto.randomUUID() },
  });

const optToken = (v: unknown) => v == null || typeof v === "string";
const validName = (v: unknown): v is string => typeof v === "string" && v.length >= 1 && v.length <= 30;

const registerKey: AccountHandler = async (env, body, ctx) => {
  const me = await auth(env, body, ctx);
  if (!me) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  if (typeof body.password !== "string" || !optToken(body.token)) return bad();
  return withHyperdriveClient(hd(env), async (c) => {
    const p = await getProfile(c, me.id);
    if (!p) return apiErrorResponse(E.registerUserNotFound, 400);
    if (!(await secondFactorOk(env, c, p, body.token))) return internal(); // 'authentication failed'
    if (!(await bcrypt.compare(body.password as string, p.password ?? ""))) return apiErrorResponse(E.registerIncorrectPassword, 400);
    if (!p.twoFactorEnabled) return apiErrorResponse(E.registerTwoFactorNotEnabled, 400);
    const u = (await c.query(`SELECT username, name FROM "user" WHERE id = $1`, [me.id])).rows[0];
    return initiateRegistration(env, c, me.id, (u?.username as string | undefined) ?? me.id, (u?.name as string | null) ?? undefined);
  });
};

const keyDone: AccountHandler = async (env, body, ctx) => {
  const me = await auth(env, body, ctx);
  if (!me) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  if (typeof body.password !== "string" || !optToken(body.token) || !validName(body.name)) return bad();
  if (body.credential == null || typeof body.credential !== "object" || Array.isArray(body.credential)) return bad();
  const r = await withHyperdriveClient(hd(env), async (c) => {
    const p = await getProfile(c, me.id);
    if (!p) return internal();
    if (!(await secondFactorOk(env, c, p, body.token))) return internal(); // 'authentication failed'
    if (!(await bcrypt.compare(body.password as string, p.password ?? ""))) return apiErrorResponse(E.doneIncorrectPassword, 400);
    if (!p.twoFactorEnabled) return apiErrorResponse(E.doneTwoFactorNotEnabled, 400);
    let info;
    try {
      info = await verifyRegistration(env, me.id, body.credential);
    } catch (e) {
      return thrown(e);
    }
    try {
      await c.query(
        `INSERT INTO user_security_key (id, "userId", name, "publicKey", counter, "credentialDeviceType", "credentialBackedUp", transports)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::varchar[])`,
        [info.credentialId, me.id, body.name, b64uEncode(info.credentialPublicKey), info.counter, info.credentialDeviceType, info.credentialBackedUp, info.transports],
      );
    } catch (e) {
      return thrown(e); // e.g. the credential is already registered
    }
    return { id: info.credentialId, name: body.name as string };
  });
  if (r instanceof Response) return r;
  await publishMe(env, me.id);
  return r;
};

const updateKey: AccountHandler = async (env, body, ctx) => {
  const me = await auth(env, body, ctx);
  if (!me) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  if (!validName(body.name) || typeof body.credentialId !== "string") return bad();
  const r = await withHyperdriveClient(hd(env), async (c) => {
    const key = await findKey(c, body.credentialId as string);
    if (!key) return apiErrorResponse(E.updateNoSuchKey, 400);
    if (key.userId !== me.id) return apiErrorResponse(E.updateAccessDenied, 400);
    await c.query(`UPDATE user_security_key SET name = $2 WHERE id = $1`, [key.id, body.name]);
    return null;
  });
  if (r) return r;
  await publishMe(env, me.id);
  return {};
};

const removeKey: AccountHandler = async (env, body, ctx) => {
  const me = await auth(env, body, ctx);
  if (!me) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  if (typeof body.password !== "string" || !optToken(body.token) || typeof body.credentialId !== "string") return bad();
  const r = await withHyperdriveClient(hd(env), async (c) => {
    const p = await getProfile(c, me.id);
    if (!p) return internal();
    if (!(await secondFactorOk(env, c, p, body.token))) return internal(); // 'authentication failed'
    if (!(await bcrypt.compare(body.password as string, p.password ?? ""))) return apiErrorResponse(E.removeIncorrectPassword, 400);
    await c.query(`DELETE FROM user_security_key WHERE "userId" = $1 AND id = $2`, [me.id, body.credentialId]);
    // 使われているキーがなくなったらパスワードレスログインをやめる
    if ((await securityKeyCount(c, me.id)) === 0) {
      await c.query(`UPDATE user_profile SET "usePasswordLessLogin" = FALSE WHERE "userId" = $1`, [me.id]);
    }
    return null;
  });
  if (r) return r;
  await publishMe(env, me.id);
  return {};
};

function pgOnly(h: AccountHandler): AccountHandler {
  return async (env, body, ctx) => {
    if (!env.HYPERDRIVE?.connectionString) {
      return apiErrorResponse({ message: "Hyperdrive required.", code: "HYPERDRIVE_UNBOUND", id: "00000000-0000-4000-8000-0000000000b1", kind: "server" }, 501);
    }
    return h(env, body, ctx);
  };
}

// ---------------------------------------------------------------- POST /api/signin-with-passkey

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SE = {
  badContext: "1658cc2e-4495-461f-aee4-d403cdf073c1",
  notVerified: "932c904e-9460-45b7-9ce6-7ed33be7eb2c",
  noUser: "652f899f-66d4-490e-993e-6606c8ec04c3",
  suspended: "e03a5f46-d309-4865-9b69-56282d94e1eb",
  passwordLessOff: "2d84773e-f7b7-4d0b-8f72-bb69b584c912",
  generic: "4e30e80c-e338-45a0-8c8f-44455efa3b76",
};
const sfail = (status: number, id: string) => Response.json({ error: { id } }, { status });

/** SigninWithPasskeyApiService.signin (special route, legacy `{ error: { id } }` shape). */
const signinWithPasskey: AccountHandler = async (env, body, ctx) => {
  // Not more than 1 API call per 250ms and not more than 100 attempts per 30min (2 calls each)
  const actor = ipActor(env, ctx.request);
  if (actor && (await rateLimit(env, { key: "signin-with-passkey", duration: 60 * 30 * 1000, max: 200, minInterval: 250 }, actor))) {
    return Response.json(
      { error: { message: "Too many failed attempts to sign in. Try again later.", code: "TOO_MANY_AUTHENTICATION_FAILURES", id: "22d05606-fbcf-421a-a2db-b32610dcfd1b" } },
      { status: 429 },
    );
  }
  if (!env.HYPERDRIVE?.connectionString) return sfail(501, SE.generic);

  const credential = body.credential;
  if (!credential) {
    const context = crypto.randomUUID();
    return { option: await initiateSignInWithPasskeyAuthentication(env, context), context };
  }
  const context = body.context;
  if (typeof context !== "string" || !UUID_RE.test(context)) return sfail(400, SE.badContext);

  const info = signinRequestInfo(ctx.request);
  return withHyperdriveClient(hd(env), async (c) => {
    let userId: string | null;
    try {
      userId = await verifySignInWithPasskeyAuthentication(env, c, context, credential);
    } catch (e) {
      console.warn(`Passkey challenge Verify error! : ${e instanceof Error ? e.message : String(e)}`);
      return sfail(403, e instanceof WebAuthnError ? e.id : SE.generic);
    }
    if (!userId) return sfail(403, SE.notVerified);
    const user = (await c.query(`SELECT id, token, "isSuspended" FROM "user" WHERE id = $1 AND host IS NULL`, [userId])).rows[0];
    if (!user) return sfail(403, SE.noUser);
    if (user.isSuspended) return sfail(403, SE.suspended);
    const profile = (await c.query(`SELECT "usePasswordLessLogin" FROM user_profile WHERE "userId" = $1`, [userId])).rows[0];
    if (!profile) return sfail(500, SE.generic);
    // Authentication was successful, but passwordless login is not enabled
    if (!profile.usePasswordLessLogin) {
      await recordSignin(c, userId, info, false);
      return sfail(403, SE.passwordLessOff);
    }
    if (!user.token) return sfail(500, SE.generic);
    await recordSignin(c, userId, info, true, env);
    return { signinResponse: { finished: true, id: userId, i: String(user.token) } };
  });
};

export const passkeyHandlers: Record<string, AccountHandler> = {
  "i/2fa/register-key": pgOnly(registerKey),
  "i/2fa/key-done": pgOnly(keyDone),
  "i/2fa/update-key": pgOnly(updateKey),
  "i/2fa/remove-key": pgOnly(removeKey),
  "signin-with-passkey": signinWithPasskey,
};

