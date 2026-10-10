/** Local user keypairs (user_keypair) for signing. Never logged. */

import type { ApiEnv } from "../env.js";
import { isolateCached, withHyperdriveClient } from "../pg.js";

const memKeys = new WeakMap<object, Map<string, { publicKey: string; privateKey: string }>>();

/** Tests: register a keypair without PG. */
export function setUserKeypairForTest(env: object, userId: string, kp: { publicKey: string; privateKey: string }): void {
  let m = memKeys.get(env);
  if (!m) memKeys.set(env, (m = new Map()));
  m.set(userId, kp);
}

export async function getUserKeypair(env: ApiEnv, userId: string): Promise<{ publicKey: string; privateKey: string } | null> {
  const m = memKeys.get(env)?.get(userId);
  if (m) return m;
  if (!env.HYPERDRIVE?.connectionString) return null;
  // A local user's keypair never changes; signing every delivery reads it.
  return withHyperdriveClient(env.HYPERDRIVE, (c) =>
    isolateCached(c, `user_keypair:${userId}`, 10 * 60_000, async () => {
      const r = await c.query(`SELECT "publicKey", "privateKey" FROM user_keypair WHERE "userId" = $1`, [userId]);
      const row = r.rows[0];
      return row ? { publicKey: String(row.publicKey), privateKey: String(row.privateKey) } : null;
    }),
  );
}
