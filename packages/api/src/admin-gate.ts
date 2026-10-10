/** upstream requireModerator / requireAdmin for the admin endpoints the API Worker gates by hand. */
import type { ApiEnv } from "./env.js";
import { authenticatePg, extractToken } from "./auth-pg.js";
import { withHyperdriveClient } from "./pg.js";
import { isAdministratorPg, isModeratorPg } from "./policies-pg.js";

/** The bindings the gate reads. */
export type GateEnv = { HYPERDRIVE?: { connectionString: string } };

const ACCESS_DENIED = {
  message: "Access denied.",
  code: "ACCESS_DENIED",
  id: "56f35758-7dd5-468b-8439-5d6fb8ec9b8e",
  kind: "permission" as const,
};

const CREDENTIAL_REQUIRED = {
  message: "Credential required.",
  code: "CREDENTIAL_REQUIRED",
  id: "1384574d-a912-4b81-8601-c7b1c4085df1",
  kind: "client" as const,
};

/** ApiCallService: requireModerator / requireAdmin failures (kind permission → 403). */
const NOT_MODERATOR = {
  message: "You are not assigned to a moderator role.",
  code: "ROLE_PERMISSION_DENIED",
  id: "d33d5333-db36-423d-a8f9-1a2b9549da41",
  kind: "permission" as const,
};
const NOT_ADMINISTRATOR = {
  message: "You are not assigned to an administrator role.",
  code: "ROLE_PERMISSION_DENIED",
  id: "c3d38592-54c0-429d-be96-5636b0431a61",
  kind: "permission" as const,
};

/**
 * upstream requireModerator / requireAdmin. With Hyperdrive bound: the caller's
 * token (body `i` or Authorization: Bearer) must belong to root or a
 * moderator/administrator role; without Hyperdrive nobody passes.
 */
export async function adminGate(
  request: Request,
  env: GateEnv,
  body: Record<string, unknown>,
  level: "moderator" | "admin",
): Promise<Response | null> {
  const hd = env.HYPERDRIVE;
  if (!hd?.connectionString) return Response.json({ error: ACCESS_DENIED }, { status: 403 });
  const token = extractToken(request, body);
  if (!token) return Response.json({ error: CREDENTIAL_REQUIRED }, { status: 401 });
  const apiEnv = env as unknown as ApiEnv;
  const a = await authenticatePg(apiEnv, token);
  if (!a) {
    return Response.json(
      { error: { message: "Authentication failed. Please ensure your token is correct.", code: "AUTHENTICATION_FAILED", id: "b0a7f5f8-dc2f-4171-b91f-de88ad238e14", kind: "client" } },
      { status: 401 },
    );
  }
  if (a.user.isSuspended) {
    return Response.json({ error: { message: "Your account has been suspended.", code: "YOUR_ACCOUNT_SUSPENDED", id: "a8c724b3-6e9c-4b46-b1a8-bc3ed6258370", kind: "permission" } }, { status: 403 });
  }
  const ok = await withHyperdriveClient(apiEnv.HYPERDRIVE!, (c) =>
    level === "admin" ? isAdministratorPg(apiEnv, c, a.user.id) : isModeratorPg(apiEnv, c, a.user.id),
  );
  return ok ? null : Response.json({ error: level === "admin" ? NOT_ADMINISTRATOR : NOT_MODERATOR }, { status: 403 });
}
