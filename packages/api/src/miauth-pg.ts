/**
 * Persist miauth access_token rows to Postgres when Hyperdrive is bound.
 */

import { genAidxFromDate } from "../../id/src/index.js";
import type { ApiEnv } from "./env.js";
import { withHyperdriveClient } from "./pg.js";
import { secureRndstr } from "./crypto-util.js";

/** An `access_token` row (miauth: no app, `hash` = the token itself). */
export type AccessTokenRow = {
  id: string;
  token: string;
  hash: string;
  userId: string;
  appId: string | null;
  session: string | null;
  name: string | null;
  description: string | null;
  iconUrl: string | null;
  permission: string[];
  fetched: boolean;
};

/** A new miauth token (upstream miauth/gen-token). */
export function newMiauthToken(opts: { userId: string; session: string | null; name: string | null; description: string | null; iconUrl: string | null; permission: string[] }): AccessTokenRow {
  const token = secureRndstr(32);
  return { id: genAidxFromDate(new Date()), token, hash: token, appId: null, fetched: false, ...opts, permission: [...opts.permission] };
}

export async function insertAccessTokenPg(
  env: ApiEnv,
  tok: AccessTokenRow,
): Promise<void> {
  if (!env.HYPERDRIVE?.connectionString) return;
  await withHyperdriveClient(env.HYPERDRIVE, async (c) => {
    await c.query(
      `INSERT INTO access_token (
        id, "lastUsedAt", token, session, hash, "userId", "appId",
        name, description, "iconUrl", permission, fetched
      ) VALUES ($1, now(), $2, $3, $4, $5, $6, $7, $8, $9, $10::varchar[], $11)
      ON CONFLICT (id) DO NOTHING`,
      [
        tok.id || genAidxFromDate(new Date()),
        tok.token,
        tok.session,
        tok.hash,
        tok.userId,
        tok.appId,
        tok.name,
        tok.description,
        tok.iconUrl,
        tok.permission,
        tok.fetched,
      ],
    );
  });
}

export async function markAccessTokenFetchedPg(
  env: ApiEnv,
  tokenId: string,
): Promise<void> {
  if (!env.HYPERDRIVE?.connectionString) return;
  try {
    await withHyperdriveClient(env.HYPERDRIVE, async (c) => {
      await c.query(`UPDATE access_token SET fetched = TRUE WHERE id = $1`, [tokenId]);
    });
  } catch {
    /* ignore Hyperdrive quirks */
  }
}

export async function checkMiauthSessionPg(
  env: ApiEnv,
  session: string,
): Promise<{ ok: true; token: string; userId: string } | { ok: false }> {
  if (!env.HYPERDRIVE?.connectionString) return { ok: false };
  return withHyperdriveClient(env.HYPERDRIVE, async (c) => {
    const r = await c.query(
      `SELECT id, token, "userId", session, fetched
       FROM access_token
       WHERE session = $1 AND session IS NOT NULL AND fetched = FALSE
       LIMIT 1`,
      [session],
    );
    const row = r.rows[0];
    if (!row) return { ok: false };
    try {
      await c.query(`UPDATE access_token SET fetched = TRUE WHERE id = $1`, [row.id]);
    } catch {
      /* ignore */
    }
    return { ok: true, token: String(row.token), userId: String(row.userId) };
  });
}
