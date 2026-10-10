/**
 * Token → User via Hyperdrive (native user.token + access_token).
 * Native tokens are 16 chars (upstream isNativeUserToken).
 */

import { packUserLite } from "../../packers/src/index.js";
import type { PackUserSource } from "../../packers/src/context.js";
import { buildPackConfig } from "./meta-source.js";
import type { ApiEnv } from "./env.js";
import { requestMemo, withHyperdriveClient, type PgQueryable } from "./pg.js";
import { loadMetaSourceFromPg } from "./meta-pg.js";

export type AuthUser = {
  id: string;
  username: string;
  name: string | null;
  host: string | null;
  token: string | null;
  isBot: boolean;
  isCat: boolean;
  isSuspended: boolean;
  avatarId: string | null;
  avatarUrl: string | null;
  avatarBlurhash: string | null;
  hideOnlineStatus: boolean;
  lastActiveDate: Date | null;
  /** set once the account has moved (ApiCallService prohibitMoved) */
  movedToUri?: string | null;
};

export type AuthResult = {
  user: AuthUser;
  /** Present when authenticated via access_token (app / miauth), not native token. */
  accessTokenId: string | null;
  permission: string[];
};

export function isNativeUserToken(token: string): boolean {
  return token.length === 16;
}

export function extractToken(
  request: Request,
  body: Record<string, unknown>,
): string | null {
  const auth = request.headers.get("Authorization");
  if (auth) {
    const m = /^Bearer\s+(\S+)/i.exec(auth);
    if (m?.[1]) return m[1];
  }
  if (typeof body.i === "string" && body.i.length > 0) return body.i;
  return null;
}

function rowToAuthUser(row: Record<string, unknown>): AuthUser {
  return {
    id: String(row.id),
    username: String(row.username),
    name: (row.name as string | null) ?? null,
    host: (row.host as string | null) ?? null,
    token: (row.token as string | null) ?? null,
    isBot: Boolean(row.isBot),
    isCat: Boolean(row.isCat),
    isSuspended: Boolean(row.isSuspended),
    avatarId: (row.avatarId as string | null) ?? null,
    avatarUrl: (row.avatarUrl as string | null) ?? null,
    avatarBlurhash: (row.avatarBlurhash as string | null) ?? null,
    hideOnlineStatus: Boolean(row.hideOnlineStatus),
    lastActiveDate: row.lastActiveDate ? new Date(String(row.lastActiveDate)) : null,
    movedToUri: (row.movedToUri as string | null) ?? null,
  };
}

const USER_COLS = `
  id, username, name, host, token, "isBot", "isCat", "isSuspended",
  "avatarId", "avatarUrl", "avatarBlurhash", "hideOnlineStatus", "lastActiveDate", "movedToUri",
  to_jsonb("user") ->> 'isDeleted' AS "isDeleted"
`;

/** The token's user row and permissions, or null for an unknown token / an account being deleted. */
type TokenLookup = {
  row: Record<string, unknown>;
  accessTokenId: string | null;
  tokenPermission: string[];
  appPermission: string[] | null;
  /** access_token.lastUsedAt already updated in this request */
  touched?: boolean;
} | null;

async function lookupToken(client: PgQueryable, token: string): Promise<TokenLookup> {
  if (isNativeUserToken(token)) {
    const r = await client.query(
      `SELECT ${USER_COLS} FROM "user"
       WHERE token = $1 AND host IS NULL LIMIT 1`,
      [token],
    );
    const row = r.rows[0];
    // an account being deleted can no longer sign requests; suspended users authenticate (the
    // router refuses them on credential-required endpoints, as upstream ApiCallService)
    if (!row || row.isDeleted === "true") return null;
    return { row, accessTokenId: null, tokenPermission: [], appPermission: null };
  }

  const at = await client
    .query(
      `SELECT t.id, t."userId", t.permission, to_jsonb(a) -> 'permission' AS "appPermission"
       FROM access_token t LEFT JOIN app a ON a.id = t."appId" WHERE t.hash = $1 OR t.token = $2 LIMIT 1`,
      [token.toLowerCase(), token],
    )
    .catch(() =>
      client.query(`SELECT id, "userId", permission FROM access_token WHERE hash = $1 OR token = $2 LIMIT 1`, [
        token.toLowerCase(),
        token,
      ]),
    );
  const tok = at.rows[0];
  if (!tok) return null;

  const r = await client.query(
    `SELECT ${USER_COLS} FROM "user" WHERE id = $1 LIMIT 1`,
    [tok.userId],
  );
  const row = r.rows[0];
  if (!row || row.isDeleted === "true") return null;
  return {
    row,
    accessTokenId: String(tok.id),
    tokenPermission: Array.isArray(tok.permission) ? (tok.permission as string[]) : [],
    appPermission: Array.isArray(tok.appPermission) ? (tok.appPermission as string[]) : null,
  };
}

/** access_token.lastUsedAt precision (upstream writes it on every call; shown in the app list). */
const TOKEN_TOUCH_INTERVAL_MS = 60_000;
const tokenTouchedAt = new Map<string, number>();

/** The router's call gate and the handler authenticate the same token: look it up once per request. */
function lookupTokenOnce(client: PgQueryable, token: string): Promise<TokenLookup> {
  return requestMemo(`auth:${token}`, () => lookupToken(client, token), { stable: true });
}

export async function authenticateWithClient(
  client: PgQueryable,
  token: string,
): Promise<AuthResult | null> {
  const hit = await lookupTokenOnce(client, token);
  if (!hit) return null;
  if (hit.accessTokenId && !hit.touched) {
    hit.touched = true;
    // best-effort lastUsedAt, at most once a minute per token in this isolate: the write costs a
    // round trip and drops the request's memoized reads (roles the call gate already loaded)
    const now = Date.now();
    const last = tokenTouchedAt.get(hit.accessTokenId) ?? 0;
    if (now - last >= TOKEN_TOUCH_INTERVAL_MS) {
      tokenTouchedAt.set(hit.accessTokenId, now);
      if (tokenTouchedAt.size > 10_000) tokenTouchedAt.clear();
      try {
        await client.query(`UPDATE access_token SET "lastUsedAt" = now() WHERE id = $1`, [hit.accessTokenId]);
      } catch {
        /* ignore */
      }
    }
  }
  return {
    user: rowToAuthUser(hit.row),
    accessTokenId: hit.accessTokenId,
    permission: [...hit.tokenPermission],
  };
}

export type CallAuth = {
  userId: string;
  isSuspended: boolean;
  movedToUri: string | null;
  /** null for the native token */
  accessTokenId: string | null;
  permission: string[];
};

/**
 * upstream AuthenticateService.authenticate for ApiCallService: unlike authenticateWithClient,
 * a suspended user still authenticates (the call gate answers YOUR_ACCOUNT_SUSPENDED), and an
 * app's token carries the app's permission. null = AuthenticationError (unknown token).
 * Accounts being deleted fail like in authenticateWithClient (misskey-cf deletes in steps).
 */
export async function authenticateForCallPg(env: ApiEnv, token: string): Promise<CallAuth | null> {
  if (!env.HYPERDRIVE?.connectionString) return null;
  return withHyperdriveClient(env.HYPERDRIVE, async (c) => {
    const hit = await lookupTokenOnce(c, token);
    if (!hit) return null;
    return {
      userId: String(hit.row.id),
      isSuspended: Boolean(hit.row.isSuspended),
      movedToUri: (hit.row.movedToUri as string | null) ?? null,
      accessTokenId: hit.accessTokenId,
      permission: [...(hit.appPermission ?? hit.tokenPermission)],
    };
  });
}

export async function authenticatePg(
  env: ApiEnv,
  token: string,
): Promise<AuthResult | null> {
  if (!env.HYPERDRIVE?.connectionString) return null;
  return withHyperdriveClient(env.HYPERDRIVE, (c) => authenticateWithClient(c, token));
}

export function toPackUserSource(user: AuthUser): PackUserSource {
  return {
    id: user.id,
    name: user.name,
    username: user.username,
    host: user.host,
    avatarId: user.avatarId,
    avatarUrl: user.avatarUrl,
    avatarBlurhash: user.avatarBlurhash,
    isBot: user.isBot,
    isCat: user.isCat,
    hideOnlineStatus: user.hideOnlineStatus,
    lastActiveDate: user.lastActiveDate,
  };
}

