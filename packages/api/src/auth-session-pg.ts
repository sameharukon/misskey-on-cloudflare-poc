/**
 * auth_session + app-linked access_token via Hyperdrive.
 */

import { genAidxFromDate } from "../../id/src/index.js";
import type { ApiEnv } from "./env.js";
import { withHyperdriveClient } from "./pg.js";
import { randomUuid, secureRndstr, sha256Hex } from "./crypto-util.js";
import { findAppBySecretPg, type AppRow } from "./app-pg.js";

/** An `auth_session` row. */
export type AuthSessionRow = {
  id: string;
  token: string;
  appId: string;
  userId: string | null;
};

export async function insertAuthSessionPg(
  env: ApiEnv,
  session: AuthSessionRow,
): Promise<void> {
  if (!env.HYPERDRIVE?.connectionString) return;
  await withHyperdriveClient(env.HYPERDRIVE, async (c) => {
    await c.query(
      `INSERT INTO auth_session (id, token, "userId", "appId")
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO NOTHING`,
      [session.id, session.token, session.userId, session.appId],
    );
  });
}

export async function findAuthSessionByTokenPg(
  env: ApiEnv,
  token: string,
): Promise<AuthSessionRow | null> {
  if (!env.HYPERDRIVE?.connectionString) return null;
  return withHyperdriveClient(env.HYPERDRIVE, async (c) => {
    const r = await c.query(
      `SELECT id, token, "userId", "appId"
       FROM auth_session WHERE token = $1 LIMIT 1`,
      [token],
    );
    const row = r.rows[0];
    if (!row) return null;
    return {
      id: String(row.id),
      token: String(row.token),
      appId: String(row.appId),
      userId: (row.userId as string | null) ?? null,
    };
  });
}

export async function acceptAuthSessionPg(
  env: ApiEnv,
  sessionToken: string,
  userId: string,
  app: AppRow,
): Promise<{ ok: true } | { ok: false; code: string }> {
  if (!env.HYPERDRIVE?.connectionString) return { ok: false, code: "NO_SUCH_SESSION" };
  return withHyperdriveClient(env.HYPERDRIVE, async (c) => {
    const r = await c.query(
      `SELECT id, token, "userId", "appId"
       FROM auth_session WHERE token = $1 LIMIT 1`,
      [sessionToken],
    );
    const row = r.rows[0];
    if (!row || String(row.appId) !== app.id) return { ok: false, code: "NO_SUCH_SESSION" };

    const existing = await c.query(
      `SELECT id FROM access_token
       WHERE "appId" = $1 AND "userId" = $2 LIMIT 1`,
      [app.id, userId],
    );
    if (existing.rows.length === 0) {
      const accessToken = secureRndstr(32);
      const hash = await sha256Hex(accessToken + app.secret);
      const id = genAidxFromDate(new Date());
      await c.query(
        `INSERT INTO access_token (
          id, "lastUsedAt", token, session, hash, "userId", "appId",
          name, description, "iconUrl", permission, fetched
        ) VALUES ($1, now(), $2, NULL, $3, $4, $5, NULL, NULL, NULL, $6::varchar[], FALSE)`,
        [id, accessToken, hash, userId, app.id, app.permission],
      );
    }

    await c.query(`UPDATE auth_session SET "userId" = $1 WHERE token = $2`, [
      userId,
      sessionToken,
    ]);
    return { ok: true };
  });
}

export async function userkeyFromSessionPg(
  env: ApiEnv,
  appSecret: string,
  sessionToken: string,
): Promise<
  | { ok: true; accessToken: string; userId: string }
  | { ok: false; code: "NO_SUCH_APP" | "NO_SUCH_SESSION" | "PENDING_SESSION" }
> {
  if (!env.HYPERDRIVE?.connectionString) {
    return { ok: false, code: "NO_SUCH_APP" };
  }
  const app = await findAppBySecretPg(env, appSecret);
  if (!app) return { ok: false, code: "NO_SUCH_APP" };

  return withHyperdriveClient(env.HYPERDRIVE, async (c) => {
    const r = await c.query(
      `SELECT id, token, "userId", "appId"
       FROM auth_session WHERE token = $1 LIMIT 1`,
      [sessionToken],
    );
    const row = r.rows[0];
    if (!row || String(row.appId) !== app.id) return { ok: false, code: "NO_SUCH_SESSION" };
    if (row.userId == null) return { ok: false, code: "PENDING_SESSION" };
    const userId = String(row.userId);

    const tok = await c.query(
      `SELECT token, hash FROM access_token
       WHERE "appId" = $1 AND "userId" = $2 LIMIT 1`,
      [app.id, userId],
    );
    const access = tok.rows[0];
    if (!access) return { ok: false, code: "NO_SUCH_SESSION" };

    await c.query(`DELETE FROM auth_session WHERE token = $1`, [sessionToken]);

    // App access tokens store hash = sha256(token+secret); return plaintext token column.
    return { ok: true, accessToken: String(access.token), userId };
  });
}

export function newAuthSession(appId: string): AuthSessionRow {
  return {
    id: genAidxFromDate(new Date()),
    token: randomUuid(),
    appId,
    userId: null,
  };
}
