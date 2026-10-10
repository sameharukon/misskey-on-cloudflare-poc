import type { ApiEnv } from "./env.js";
import { handlers } from "./endpoints/index.js";
import { ACCESS_DENIED, apiErrorResponse, APP_PERMISSION_DENIED, CREDENTIAL_REQUIRED, INTERNAL_ERROR, INVALID_PARAM, type ApiErrorBody } from "./errors.js";
import { authenticateForCallPg, authenticatePg, extractToken, isNativeUserToken, type CallAuth } from "./auth-pg.js";
import { ENDPOINT_META } from "./endpoint-meta.gen.js";
import { ENDPOINT_EXTRA_META, ENDPOINT_PARAM_DEFS } from "./endpoint-params.gen.js";
import { castNonJsonInput, validateParams } from "./param-validate.js";
import type { UploadedFile } from "./drive-pg.js";
import { ipActor, rateLimit, rateLimitEnabled, rateLimitResponse } from "./rate-limit.js";
import { NO_CACHE, withHeader } from "./response-cache.js";

/** Extract Misskey endpoint name from `/api/<name>` (name may contain `/`). */
export function endpointNameFromPath(pathname: string): string | null {
  if (pathname === "/api" || pathname === "/api/") return null;
  if (!pathname.startsWith("/api/")) return null;
  return pathname.slice("/api/".length);
}

export function hasCredential(request: Request, body: Record<string, unknown>): boolean {
  const auth = request.headers.get("Authorization");
  if (auth && /^Bearer\s+\S+/i.test(auth)) return true;
  if (typeof body.i === "string" && body.i.length > 0) return true;
  return false;
}

export async function parseBody(request: Request): Promise<Record<string, unknown>> {
  if (request.method === "GET" || request.method === "HEAD") return {};
  const ct = request.headers.get("content-type") || "";
  if (ct.includes("application/json")) {
    try {
      const v = await request.json();
      return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
    } catch {
      throw Object.assign(new Error("invalid_json"), { code: "invalid_json" });
    }
  }
  // Misskey also accepts form / empty
  try {
    const text = await request.text();
    if (!text) return {};
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** multipart/form-data → string fields + the first file part (upstream: one file per request). */
export async function parseMultipart(request: Request): Promise<{ body: Record<string, unknown>; file?: UploadedFile }> {
  const form = await request.formData();
  const body: Record<string, unknown> = {};
  let file: UploadedFile | undefined;
  const entries: [string, unknown][] = [];
  (form as unknown as { forEach(cb: (v: unknown, k: string) => void): void }).forEach((v, k) => entries.push([k, v]));
  for (const [k, v] of entries) {
    if (typeof v === "string") body[k] = v;
    else if (!file) {
      const f = v as unknown as { name?: string; type?: string; arrayBuffer(): Promise<ArrayBuffer> };
      file = { name: f.name ?? null, type: f.type || null, bytes: new Uint8Array(await f.arrayBuffer()) };
    }
  }
  return { body, file };
}

/** upstream ApiCallService.logIp: per-isolate "already logged" set, cleared hourly upstream. */
const ipHistories = new Map<string, Set<string>>();
let ipHistoriesSince = Date.now();

async function logIp(env: ApiEnv, request: Request, userId: string): Promise<void> {
  const { clientIp } = await import("./rate-limit.js");
  const ip = clientIp(request);
  if (!ip || !env.HYPERDRIVE?.connectionString) return;
  if (Date.now() - ipHistoriesSince > 3_600_000) {
    ipHistories.clear();
    ipHistoriesSince = Date.now();
  }
  const ips = ipHistories.get(userId);
  if (ips?.has(ip)) return;
  if (ips) ips.add(ip);
  else ipHistories.set(userId, new Set([ip]));
  const { withHyperdriveClient } = await import("./pg.js");
  const { metaRowPg } = await import("./user-lite-pg.js");
  try {
    await withHyperdriveClient(env.HYPERDRIVE, async (c) => {
      if ((await metaRowPg(c)).enableIpLogging !== true) return;
      await c.query(`INSERT INTO user_ip ("createdAt", "userId", ip) VALUES (now(), $1, $2) ON CONFLICT DO NOTHING`, [userId, ip]);
    });
  } catch {
    /* upstream ignores insert errors */
  }
}

const AUTHENTICATION_FAILED: ApiErrorBody = {
  message: "Authentication failed. Please ensure your token is correct.",
  code: "AUTHENTICATION_FAILED",
  id: "b0a7f5f8-dc2f-4171-b91f-de88ad238e14",
  kind: "client",
};
const YOUR_ACCOUNT_SUSPENDED: ApiErrorBody = { message: "Your account has been suspended.", code: "YOUR_ACCOUNT_SUSPENDED", id: "a8c724b3-6e9c-4b46-b1a8-bc3ed6258370", kind: "permission" };
const YOUR_ACCOUNT_MOVED: ApiErrorBody = { message: "You have moved your account.", code: "YOUR_ACCOUNT_MOVED", id: "56f20ec9-fd06-4fa5-841b-edd6d7d4fa31", kind: "permission" };
const NOT_MODERATOR: ApiErrorBody = { message: "You are not assigned to a moderator role.", code: "ROLE_PERMISSION_DENIED", id: "d33d5333-db36-423d-a8f9-1a2b9549da41", kind: "permission" };
const NOT_ADMIN: ApiErrorBody = { message: "You are not assigned to an administrator role.", code: "ROLE_PERMISSION_DENIED", id: "c3d38592-54c0-429d-be96-5636b0431a61", kind: "permission" };
const NOT_REQUIRED_ROLE: ApiErrorBody = { message: "You are not assigned to a required role.", code: "ROLE_PERMISSION_DENIED", id: "7f86f06f-7e15-4057-8561-f4b6d4ac755a", kind: "permission" };
const FILE_REQUIRED: ApiErrorBody = { message: "File required.", code: "FILE_REQUIRED", id: "4267801e-70d1-416a-b011-4ee502885d8b", kind: "client" };
const CAST_INVALID_PARAM: ApiErrorBody = { ...INVALID_PARAM, id: "0b5f1631-7c1a-41a6-b399-cce335f34d85" };

function withAuthHeader(res: Response, value: string): Response {
  return withHeader(res, "WWW-Authenticate", value);
}

/** upstream ApiCallService#sendApiError: status by kind (+ WWW-Authenticate). */
function callError(err: ApiErrorBody, status?: number, info?: unknown): Response {
  if (status === 401) return withAuthHeader(apiErrorResponse(err, 401, info), 'Bearer realm="Misskey"');
  if (err.kind === "permission") {
    const res = apiErrorResponse(err, status ?? 403, info);
    return err.code === "PERMISSION_DENIED" ? withAuthHeader(res, `Bearer realm="Misskey", error="insufficient_scope", error_description="${err.message}"`) : res;
  }
  return withAuthHeader(apiErrorResponse(err, status ?? 400, info), `Bearer realm="Misskey", error="invalid_request", error_description="${err.message}"`);
}

/**
 * upstream ApiCallService.handleRequest + call + Endpoint (endpoint-base.ts), in order:
 * authentication (unknown token → 401 AUTHENTICATION_FAILED), `secure`, rate limit,
 * credential / suspended, `prohibitMoved`, moderator / admin roles, `requiredRolePolicy`,
 * the access token's `kind`, non-JSON cast, `requireFile`, then the `paramDef` validation
 * (with defaults written into `body`). Without Hyperdrive (offline fixtures) only the
 * parameter checks run; the handlers keep their own checks.
 */
export async function callGate(
  env: ApiEnv,
  name: string,
  request: Request,
  body: Record<string, unknown>,
  file?: UploadedFile,
  exec?: { waitUntil(p: Promise<unknown>): void },
): Promise<Response | null> {
  const m = ENDPOINT_META[name];
  const x = ENDPOINT_EXTRA_META[name];
  const schema = ENDPOINT_PARAM_DEFS[name];
  const pg = Boolean(env.HYPERDRIVE?.connectionString);

  const authz = request.headers.get("Authorization");
  const token: unknown = authz?.startsWith("Bearer ") ? authz.slice(7) : body.i;
  if (token != null && typeof token !== "string") return new Response(null, { status: 400 });

  let auth: CallAuth | null = null;
  if (pg && token != null) {
    auth = await authenticateForCallPg(env, token);
    if (!auth) {
      return withAuthHeader(
        apiErrorResponse(AUTHENTICATION_FAILED, 401),
        `Bearer realm="Misskey", error="invalid_token", error_description="${AUTHENTICATION_FAILED.message}"`,
      );
    }
    // ApiCallService.handleRequest: logIp for every authenticated call
    const logged = logIp(env, request, auth.userId);
    if (exec) exec.waitUntil(logged);
    else await logged;
  }

  if (m && pg) {
    // upstream: isSecure = user != null && token == null (native token); anonymous calls are refused too
    if (m.secure && !(auth && !auth.accessTokenId)) return callError({ ...ACCESS_DENIED, kind: "client" });

    if (m.limit && rateLimitEnabled(env)) {
      let actor: string | null = auth?.userId ?? null;
      let factor = 1;
      if (auth) {
        const { policiesForPg } = await import("./policies-pg.js");
        factor = Number((await policiesForPg(env, auth.userId).catch(() => null))?.rateLimitFactor ?? 1);
      }
      actor ??= ipActor(env, request);
      if (actor != null && factor > 0) {
        const r = await rateLimit(env, { ...m.limit, key: m.limit.key ?? name }, actor, factor);
        if (r) return rateLimitResponse(r);
      }
    }

    const credentialed = m.requireCredential || m.requireModerator || m.requireAdmin;
    if (credentialed) {
      if (!auth) return callError({ ...CREDENTIAL_REQUIRED, kind: "client" }, 401);
      if (auth.isSuspended) return callError(YOUR_ACCOUNT_SUSPENDED);
    }
    if (x?.prohibitMoved && auth?.movedToUri) return callError(YOUR_ACCOUNT_MOVED);

    if ((m.requireModerator || m.requireAdmin || x?.requiredRolePolicy) && auth) {
      const { getRootUserId } = await import("./users-pg.js");
      if ((await getRootUserId(env)) !== auth.userId) {
        const { withHyperdriveClient } = await import("./pg.js");
        const { getUserRolesPg } = await import("./role-cond.js");
        const { hasRolePolicyPg } = await import("./policies-pg.js");
        const denied = await withHyperdriveClient(env.HYPERDRIVE!, async (c) => {
          const roles = await getUserRolesPg(c, auth!.userId);
          if (m.requireModerator && !roles.some((r) => r.isModerator || r.isAdministrator)) return NOT_MODERATOR;
          if (m.requireAdmin && !roles.some((r) => r.isAdministrator)) return NOT_ADMIN;
          if (x?.requiredRolePolicy && !(await hasRolePolicyPg(env, c, auth!.userId, x.requiredRolePolicy))) return NOT_REQUIRED_ROLE;
          return null;
        });
        if (denied) return callError(denied);
      }
    }

    if (auth?.accessTokenId && ((m.kind && !auth.permission.includes(m.kind)) || (!m.kind && credentialed))) {
      return callError(APP_PERMISSION_DENIED);
    }
  }

  if (!schema) return null;
  if (x?.requireFile || request.method === "GET") {
    const e = castNonJsonInput(schema, body);
    if (e) return callError(CAST_INVALID_PARAM, undefined, e);
  }
  // (the offline fixture store also takes base64 JSON uploads)
  if (x?.requireFile && !file && pg) return callError(FILE_REQUIRED);
  const e = validateParams(schema, body);
  if (e) return callError(INVALID_PARAM, undefined, e);
  return null;
}

/**
 * ApiServerService / ApiCallService HTTP behaviour: every API response is
 * `Cache-Control: private, max-age=0, must-revalidate` unless the endpoint set its own (cacheSec).
 */
export async function dispatchApi(
  request: Request,
  env: ApiEnv,
  exec?: { waitUntil(p: Promise<unknown>): void },
): Promise<Response> {
  const res = await dispatchApiInner(request, env, exec);
  return res.headers.has("Cache-Control") ? res : withHeader(res, "Cache-Control", NO_CACHE);
}

async function dispatchApiInner(
  request: Request,
  env: ApiEnv,
  exec?: { waitUntil(p: Promise<unknown>): void },
): Promise<Response> {
  const url = new URL(request.url);
  const name = endpointNameFromPath(url.pathname);
  const handler = name ? handlers[name] : undefined;
  if (!name || (!handler && !ENDPOINT_PARAM_DEFS[name])) {
    // upstream ApiServerService: an unknown path under /api is 404 — UNKNOWN_API_ENDPOINT for GET,
    // fastify's own not-found body for other methods
    if (request.method === "GET") {
      return apiErrorResponse({ message: "Unknown API endpoint.", code: "UNKNOWN_API_ENDPOINT", id: "2ca3b769-540a-4f08-9dd5-b5a825b6d0f1", kind: "client" }, 404);
    }
    return Response.json({ message: `Route ${request.method}:${url.pathname} not found`, error: "Not Found", statusCode: 404 }, { status: 404 });
  }

  if (!handler) {
    return Response.json(
      { error: "not_implemented", path: url.pathname, endpoint: name },
      { status: 501 },
    );
  }

  // upstream ApiServerService: GET only for `allowGet` endpoints (misskey-cf-only endpoints keep GET)
  const gate = ENDPOINT_META[name];
  if (request.method === "GET" && gate && !gate.allowGet) return new Response(null, { status: 405 });

  let body: Record<string, unknown>;
  let file: UploadedFile | undefined;
  const multipart = (request.headers.get("content-type") || "").toLowerCase().startsWith("multipart/form-data");
  try {
    if (multipart) {
      ({ body, file } = await parseMultipart(request));
    } else {
      body = await parseBody(request);
    }
  } catch {
    return apiErrorResponse(INVALID_PARAM, 400);
  }

  // upstream ApiCallService.handleRequest: a GET call's parameters are the query string only
  if (request.method === "GET") {
    body = {};
    for (const [k, v] of url.searchParams) body[k] = v;
  }

  // upstream ApiCallService: anonymous GET of a `cacheSec` endpoint → Cache-Control public (header only)
  const cacheSec = request.method === "GET" && gate?.cacheSec && !extractToken(request, body) ? gate.cacheSec : 0;

  const refused = await callGate(env, name, request, body, file, exec);
  if (refused) return refused;

  let result: unknown;
  try {
    result = await handler(env, body, {
      hasCredential: hasCredential(request, body),
      request,
      file,
      waitUntil: exec ? (p) => exec.waitUntil(p) : undefined,
    });
  } catch (err) {
    // upstream ApiCallService#onExecError: 500 INTERNAL_ERROR with the error summary as info
    const e = err instanceof Error ? err : new Error(String(err));
    console.error(`Internal error occurred in ${name}: ${e.message}`);
    return apiErrorResponse(INTERNAL_ERROR, 500, { e: { message: e.message, code: e.name, id: crypto.randomUUID() } });
  }

  // upstream ApiCallService.send: an endpoint returning nothing answers 204
  if (result === undefined || result === null) return new Response(null, { status: 204 });
  let res = result instanceof Response ? result : Response.json(result);
  if (cacheSec && res.status >= 200 && res.status < 300) {
    res = withHeader(res, "Cache-Control", `public, max-age=${cacheSec}`);
  }
  return res;
}
