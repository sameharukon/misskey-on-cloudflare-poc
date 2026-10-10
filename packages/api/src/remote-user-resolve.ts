/**
 * upstream RemoteUserResolveService.resolveUser(username, host): local users by name, remote
 * users from the database, unknown or stale (lastFetchedAt > 1 day) ones through WebFinger
 * (`acct:user@host` → `self` link, checked by webfingerSelf in ap/remote.ts) and the AP person
 * resolver. Throws on failure.
 */

import type { ApiEnv } from "./env.js";
import { buildPackConfig } from "./meta-source.js";
import { withHyperdriveClient } from "./pg.js";

/** domainToASCII for hosts (UtilityService.toPuny). */
function toPuny(host: string): string {
  try {
    return new URL(`https://${host}`).hostname.toLowerCase();
  } catch {
    return host.toLowerCase();
  }
}

export async function resolveUserIdByAcct(env: ApiEnv, username: string, host: string | null): Promise<string> {
  const usernameLower = username.toLowerCase();
  const selfHost = toPuny(buildPackConfig(env).host);
  const local = () =>
    withHyperdriveClient(env.HYPERDRIVE!, async (c) => {
      const r = await c.query(`SELECT id FROM "user" WHERE "usernameLower" = $1 AND host IS NULL LIMIT 1`, [usernameLower]);
      if (!r.rows[0]) throw new Error("user not found");
      return String(r.rows[0].id);
    });
  if (host == null) return local();
  host = toPuny(host);
  if (host === selfHost) return local();

  const user = await withHyperdriveClient(env.HYPERDRIVE!, async (c) =>
    (await c.query(`SELECT id, uri, "lastFetchedAt" FROM "user" WHERE "usernameLower" = $1 AND host = $2 LIMIT 1`, [usernameLower, host])).rows[0] ?? null,
  );
  const acctLower = `${usernameLower}@${host}`;
  const { resolveRemoteUser, webfingerSelf } = await import("./ap/remote.js");
  if (user == null) {
    const href = await webfingerSelf(env, acctLower);
    return (await resolveRemoteUser(env, href)).id;
  }
  const last = user.lastFetchedAt ? new Date(String(user.lastFetchedAt)).getTime() : null;
  if (last == null || Date.now() - last > 86_400_000) {
    await withHyperdriveClient(env.HYPERDRIVE!, (c) => c.query(`UPDATE "user" SET "lastFetchedAt" = now() WHERE id = $1`, [user.id]));
    const href = await webfingerSelf(env, acctLower);
    if (user.uri !== href) {
      if (new URL(href).hostname !== host) throw new Error("Invalid uri");
      await withHyperdriveClient(env.HYPERDRIVE!, (c) => c.query(`UPDATE "user" SET uri = $3 WHERE "usernameLower" = $1 AND host = $2`, [usernameLower, host, href]));
    }
    return (await resolveRemoteUser(env, href, { refresh: true })).id;
  }
  return String(user.id);
}
