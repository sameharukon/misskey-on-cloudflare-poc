/**
 * app/create, app/show, auth/session/{generate,show,userkey}, auth/accept and miauth/gen-token
 * on PG (`app`, `auth_session`, `access_token`).
 */
import type { ApiEnv } from "./env.js";
import { apiErrorResponse, CREDENTIAL_REQUIRED, INVALID_PARAM, type ApiErrorBody } from "./errors.js";
import { authenticatePg, extractToken } from "./auth-pg.js";
import { authUserId, requireHyperdrive } from "./handler-kit.js";
import { findAppByIdPg, findAppBySecretPg, insertAppPg, isAppAuthorizedPg, normalizeAppPermission, packApp } from "./app-pg.js";
import { acceptAuthSessionPg, findAuthSessionByTokenPg, insertAuthSessionPg, newAuthSession, userkeyFromSessionPg } from "./auth-session-pg.js";
import { insertAccessTokenPg, newMiauthToken } from "./miauth-pg.js";
import { packUserDetailedPg } from "./user-detailed-pg.js";

type Ctx = { hasCredential: boolean; request: Request };
type Handler = (env: ApiEnv, body: Record<string, unknown>, ctx: Ctx) => Promise<Response | unknown>;

const client = (code: string, id: string, message: string): ApiErrorBody => ({ message, code, id, kind: "client" });
const AUTHENTICATION_FAILED: ApiErrorBody = { message: "Authentication failed. Please try to sign in again.", code: "AUTHENTICATION_FAILED", id: "b0a7f5f5-5c9c-4e2e-8c0a-0f0e0e0e0e0e", kind: "permission" };
const ACCEPT_NO_SUCH_SESSION = client("NO_SUCH_SESSION", "9c72d8de-391a-43c1-9d06-08d29efde8df", "No such session.");

const appCreate: Handler = async (env, body, ctx) => {
  const name = typeof body.name === "string" ? body.name : "";
  const description = typeof body.description === "string" ? body.description : "";
  const permissionRaw = body.permission;
  if (!name || !Array.isArray(permissionRaw)) return apiErrorResponse(INVALID_PARAM, 400);
  const permission = permissionRaw.filter((p): p is string => typeof p === "string");
  if (permission.length === 0 && permissionRaw.length > 0) return apiErrorResponse(INVALID_PARAM, 400);
  const callbackUrl = typeof body.callbackUrl === "string" ? body.callbackUrl : null;
  const userId = await authUserId(env, body, ctx);
  // (a failure propagates → INTERNAL_ERROR, as upstream)
  const app = await insertAppPg(env, { name, description, permission: normalizeAppPermission(permission), callbackUrl, userId });
  if (!app) throw new Error("app insert failed");
  return packApp(app, { includeSecret: true });
};

const appShow: Handler = async (env, body, ctx) => {
  const appId = typeof body.appId === "string" ? body.appId : "";
  if (!appId) return apiErrorResponse(INVALID_PARAM, 400);
  const app = await findAppByIdPg(env, appId);
  if (!app) return apiErrorResponse(client("NO_SUCH_APP", "dce83913-2dc6-4093-8a7b-71dbb11718a3", "No such app."), 400);
  let includeSecret = false;
  let isAuthorized: boolean | undefined;
  const token = ctx.hasCredential ? extractToken(ctx.request, body) : null;
  const auth = token ? await authenticatePg(env, token) : null;
  if (auth) {
    // upstream: only a native-token (secure) caller who owns the app sees the secret
    includeSecret = auth.accessTokenId == null && app.userId === auth.user.id;
    isAuthorized = await isAppAuthorizedPg(env, app.id, auth.user.id);
  }
  return packApp(app, { includeSecret, isAuthorized });
};

const sessionGenerate: Handler = async (env, body) => {
  const appSecret = typeof body.appSecret === "string" ? body.appSecret : "";
  if (!appSecret) return apiErrorResponse(INVALID_PARAM, 400);
  const app = await findAppBySecretPg(env, appSecret);
  if (!app) return apiErrorResponse(client("NO_SUCH_APP", "92f93e63-428e-4f2f-a5a4-39e1407fe998", "No such app."), 400);
  const session = newAuthSession(app.id);
  // (a failure propagates → INTERNAL_ERROR, as upstream)
  await insertAuthSessionPg(env, session);
  const base = (env.INSTANCE_URL ?? "https://misskey.local").replace(/\/$/, "");
  return { token: session.token, url: `${base}/auth/${session.token}` };
};

const sessionShow: Handler = async (env, body) => {
  const token = typeof body.token === "string" ? body.token : "";
  if (!token) return apiErrorResponse(INVALID_PARAM, 400);
  const session = await findAuthSessionByTokenPg(env, token);
  if (!session) return apiErrorResponse(client("NO_SUCH_SESSION", "bd72c97d-eba7-4adb-a467-f171b8847250", "No such session."), 400);
  const app = await findAppByIdPg(env, session.appId);
  return {
    id: session.id,
    token: session.token,
    app: app ? { id: app.id, name: app.name, description: app.description, permission: app.permission, callbackUrl: app.callbackUrl } : null,
  };
};

const USERKEY_ERRORS = {
  NO_SUCH_APP: client("NO_SUCH_APP", "fcab192a-2c5a-43b7-8ad8-9b7054d8d40d", "No such app."),
  NO_SUCH_SESSION: client("NO_SUCH_SESSION", "5b5a1503-8bc8-4bd0-8054-dc189e8cdcb3", "No such session."),
  PENDING_SESSION: client("PENDING_SESSION", "8c8a4145-02cc-4cca-8e66-29ba60445a8e", "This session is not completed yet."),
} as const;

/** upstream auth/session/userkey: the access token and the user (UserDetailedNotMe). */
const sessionUserkey: Handler = async (env, body) => {
  const appSecret = typeof body.appSecret === "string" ? body.appSecret : "";
  const token = typeof body.token === "string" ? body.token : "";
  if (!appSecret || !token) return apiErrorResponse(INVALID_PARAM, 400);
  const result = await userkeyFromSessionPg(env, appSecret, token);
  if (!result.ok) return apiErrorResponse(USERKEY_ERRORS[result.code], 400);
  return { accessToken: result.accessToken, user: await packUserDetailedPg(env, result.userId, null, { schema: "UserDetailedNotMe" }) };
};

const authAccept: Handler = async (env, body, ctx) => {
  if (!ctx.hasCredential) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  const token = typeof body.token === "string" ? body.token : "";
  if (!token) return apiErrorResponse(INVALID_PARAM, 400);
  if (!extractToken(ctx.request, body)) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  const userId = await authUserId(env, body, ctx);
  if (!userId) return apiErrorResponse(AUTHENTICATION_FAILED, 401);
  const session = await findAuthSessionByTokenPg(env, token);
  const app = session ? await findAppByIdPg(env, session.appId) : null;
  if (!app) return apiErrorResponse(ACCEPT_NO_SUCH_SESSION, 400);
  const result = await acceptAuthSessionPg(env, token, userId, app);
  if (!result.ok) return apiErrorResponse(ACCEPT_NO_SUCH_SESSION, 400);
  return {};
};

const miauthGenToken: Handler = async (env, body, ctx) => {
  if (!ctx.hasCredential) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  const session = typeof body.session === "string" ? body.session : null;
  const permission = Array.isArray(body.permission) ? body.permission.filter((p): p is string => typeof p === "string") : null;
  if (!permission) return apiErrorResponse(INVALID_PARAM, 400);
  if (!extractToken(ctx.request, body)) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  const userId = await authUserId(env, body, ctx);
  if (!userId) return apiErrorResponse(AUTHENTICATION_FAILED, 401);
  const tok = newMiauthToken({
    userId,
    session,
    name: typeof body.name === "string" ? body.name : null,
    description: typeof body.description === "string" ? body.description : null,
    iconUrl: typeof body.iconUrl === "string" ? body.iconUrl : null,
    permission,
  });
  // (a failure propagates → INTERNAL_ERROR, as upstream)
  await insertAccessTokenPg(env, tok);
  // upstream: notify that an access token was created
  const { createNotification } = await import("./notifications-do.js");
  await createNotification(env, userId, { type: "createToken", notifierId: null });
  return { token: tok.token };
};

export const appAuthApiHandlers: Record<string, Handler> = requireHyperdrive({
  "app/create": appCreate,
  "app/show": appShow,
  "auth/session/generate": sessionGenerate,
  "auth/session/show": sessionShow,
  "auth/session/userkey": sessionUserkey,
  "auth/accept": authAccept,
  "miauth/gen-token": miauthGenToken,
});
