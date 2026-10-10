import type { ApiEnv } from "../../../env.js";
import { INTERNAL_ERROR, INVALID_PARAM, apiErrorResponse } from "../../../errors.js";
import { signupLocalViaHyperdrive } from "../../../signup-pg.js";
import { authenticatePg, extractToken } from "../../../auth-pg.js";
import { withHyperdriveClient } from "../../../pg.js";
import { timingSafeEqualStr } from "../../../crypto-util.js";
import { isAdministratorPg } from "../../../policies-pg.js";

const INCORRECT_INITIAL_PASSWORD = { message: "Initial password is incorrect.", code: "INCORRECT_INITIAL_PASSWORD", id: "97147c55-1ae1-4f6f-91d6-e1c3e0e76d62", kind: "client" as const };

/** The endpoint's own accessDenied (no kind → client, 400). */
const ACCOUNT_CREATE_ACCESS_DENIED = { message: "Access denied.", code: "ACCESS_DENIED", id: "1fb7cb09-d46a-4fff-b8df-057708cce513", kind: "client" as const };

export const name = "admin/accounts/create";

/**
 * upstream admin/accounts/create. While meta.rootUserId is null an anonymous call creates the
 * first account (root) with the right `setupPassword`; SETUP_PASSWORD must be set, and no local
 * account with a password may exist yet. Afterwards the caller must be an administrator using a
 * native token (an app access token is refused). SignupService failures are plain Errors → 500.
 */
export async function handle(
  env: ApiEnv,
  body: Record<string, unknown>,
  ctx: { hasCredential: boolean; request: Request },
): Promise<Response | unknown> {
  // localUsernameSchema / passwordSchema / setupPassword (nullable string)
  const username = typeof body.username === "string" ? body.username : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (!/^\w{1,20}$/.test(username) || !password || (body.setupPassword != null && typeof body.setupPassword !== "string")) {
    return apiErrorResponse(INVALID_PARAM, 400);
  }

  if (!env.HYPERDRIVE?.connectionString) {
    return apiErrorResponse(
      {
        message: "Hyperdrive required for account create.",
        code: "HYPERDRIVE_UNBOUND",
        id: "00000000-0000-4000-8000-0000000000b1",
        kind: "server",
      },
      501,
    );
  }

  const meta = await withHyperdriveClient(env.HYPERDRIVE, async (c) =>
    ((await c.query(`SELECT "rootUserId" FROM meta ORDER BY id DESC LIMIT 1`)).rows[0] as { rootUserId: string | null } | undefined) ?? null);
  const token = extractToken(ctx.request, body);
  const auth = token ? await authenticatePg(env, token) : null;
  const needsSetup = (meta == null || meta.rootUserId == null) && auth == null;

  if (!needsSetup) {
    const isAdmin = auth != null && auth.accessTokenId == null
      && (await withHyperdriveClient(env.HYPERDRIVE, (c) => isAdministratorPg(env, c, auth.user.id)));
    if (!isAdmin) return apiErrorResponse(ACCOUNT_CREATE_ACCESS_DENIED, 400);
  } else {
    // Initial setup. Unlike upstream (where config.setupPassword is optional), SETUP_PASSWORD is
    // required: the API is public before setup, and the first account becomes root. A local
    // account with a password also closes the anonymous path when rootUserId was cleared later.
    const setupPassword = env.SETUP_PASSWORD ?? "";
    if (!setupPassword) {
      console.warn("admin/accounts/create: initial setup refused, SETUP_PASSWORD is not set");
      return apiErrorResponse(INCORRECT_INITIAL_PASSWORD, 400);
    }
    if (typeof body.setupPassword !== "string" || !body.setupPassword || !(await timingSafeEqualStr(body.setupPassword, setupPassword))) {
      return apiErrorResponse(INCORRECT_INITIAL_PASSWORD, 400);
    }
    const hasLocalAccounts = await withHyperdriveClient(env.HYPERDRIVE, async (c) =>
      (await c.query(`SELECT 1 AS x FROM "user" u JOIN user_profile p ON p."userId" = u.id WHERE u.host IS NULL AND p.password IS NOT NULL LIMIT 1`)).rows.length > 0);
    if (hasLocalAccounts) return apiErrorResponse(ACCOUNT_CREATE_ACCESS_DENIED, 400);
  }

  const result = await signupLocalViaHyperdrive(env, {
    username,
    password,
    ignorePreserved: true,
    allowFirstRoot: needsSetup,
  });
  if (!result.ok) {
    // SignupService throws plain Errors (DUPLICATED_USERNAME, USED_USERNAME, …) → INTERNAL_ERROR
    return apiErrorResponse(INTERNAL_ERROR, 500, { e: { message: result.code, code: "Error", id: crypto.randomUUID() } });
  }

  // upstream: pack(account, account, { schema: 'MeDetailed', includeSecrets: true }) + token
  const { packMe } = await import("../../../client-endpoints-pg.js");
  // upstream: pack(account, account, { schema: 'MeDetailed', includeSecrets: true }); a pack failure
  // is a 500 (the router's INTERNAL_ERROR), never a made-up profile with the token
  const me = await packMe(env, result.user.id, { includeSecrets: true });
  if (me instanceof Response) throw new Error(`account ${result.user.id} created but could not be packed (${me.status})`);
  return { ...me, token: result.secret };
}
