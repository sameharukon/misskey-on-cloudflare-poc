/**
 * App table via Hyperdrive (app/create, app/show, auth/session lookup).
 */

import { genAidxFromDate } from "../../id/src/index.js";
import type { ApiEnv } from "./env.js";
import { withHyperdriveClient } from "./pg.js";
import { secureRndstr } from "./crypto-util.js";

/** An `app` row. */
export type AppRow = {
  id: string;
  secret: string;
  name: string;
  description: string;
  permission: string[];
  callbackUrl: string | null;
  userId: string | null;
};

export type PackedApp = {
  id: string;
  name: string;
  callbackUrl: string | null;
  permission: string[];
  secret?: string;
  isAuthorized?: boolean;
  description?: string;
};

/** Upstream-compatible permission normalize (read-X / X/read → read:X). */
export function normalizeAppPermission(permission: string[]): string[] {
  const mapped = permission.map((v) =>
    v.replace(/^(.+)(\/|-)(read|write)$/, "$3:$1"),
  );
  return [...new Set(mapped)];
}

export function packApp(
  app: AppRow,
  opts: { includeSecret?: boolean; isAuthorized?: boolean } = {},
): PackedApp {
  const out: PackedApp = {
    id: app.id,
    name: app.name,
    callbackUrl: app.callbackUrl,
    permission: [...app.permission],
  };
  if (opts.includeSecret) out.secret = app.secret;
  if (opts.isAuthorized !== undefined) out.isAuthorized = opts.isAuthorized;
  return out;
}

function rowToApp(row: Record<string, unknown>): AppRow {
  const perm = row.permission;
  return {
    id: String(row.id),
    secret: String(row.secret),
    name: String(row.name),
    description: String(row.description ?? ""),
    permission: Array.isArray(perm) ? perm.map(String) : [],
    callbackUrl: (row.callbackUrl as string | null) ?? null,
    userId: (row.userId as string | null) ?? null,
  };
}

export async function insertAppPg(
  env: ApiEnv,
  input: {
    name: string;
    description: string;
    permission: string[];
    callbackUrl: string | null;
    userId: string | null;
    secret?: string;
    id?: string;
  },
): Promise<AppRow | null> {
  if (!env.HYPERDRIVE?.connectionString) return null;
  const app: AppRow = {
    id: input.id ?? genAidxFromDate(new Date()),
    secret: input.secret ?? secureRndstr(32),
    name: input.name,
    description: input.description,
    permission: normalizeAppPermission(input.permission),
    callbackUrl: input.callbackUrl,
    userId: input.userId,
  };
  await withHyperdriveClient(env.HYPERDRIVE, async (c) => {
    await c.query(
      `INSERT INTO app (id, "userId", secret, name, description, permission, "callbackUrl")
       VALUES ($1, $2, $3, $4, $5, $6::varchar[], $7)`,
      [
        app.id,
        app.userId,
        app.secret,
        app.name,
        app.description,
        app.permission,
        app.callbackUrl,
      ],
    );
  });
  return app;
}

export async function findAppByIdPg(env: ApiEnv, appId: string): Promise<AppRow | null> {
  if (!env.HYPERDRIVE?.connectionString) return null;
  return withHyperdriveClient(env.HYPERDRIVE, async (c) => {
    const r = await c.query(
      `SELECT id, "userId", secret, name, description, permission, "callbackUrl"
       FROM app WHERE id = $1 LIMIT 1`,
      [appId],
    );
    const row = r.rows[0];
    return row ? rowToApp(row) : null;
  });
}

export async function findAppBySecretPg(
  env: ApiEnv,
  secret: string,
): Promise<AppRow | null> {
  if (!env.HYPERDRIVE?.connectionString) return null;
  return withHyperdriveClient(env.HYPERDRIVE, async (c) => {
    const r = await c.query(
      `SELECT id, "userId", secret, name, description, permission, "callbackUrl"
       FROM app WHERE secret = $1 LIMIT 1`,
      [secret],
    );
    const row = r.rows[0];
    return row ? rowToApp(row) : null;
  });
}

export async function isAppAuthorizedPg(
  env: ApiEnv,
  appId: string,
  userId: string,
): Promise<boolean> {
  if (!env.HYPERDRIVE?.connectionString) return false;
  return withHyperdriveClient(env.HYPERDRIVE, async (c) => {
    const r = await c.query(
      `SELECT 1 AS ok FROM access_token
       WHERE "appId" = $1 AND "userId" = $2 LIMIT 1`,
      [appId, userId],
    );
    return r.rows.length > 0;
  });
}
