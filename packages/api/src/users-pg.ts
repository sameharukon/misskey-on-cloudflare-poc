/**
 * UserDetailed lookup by id / username and the root user id on Postgres (Hyperdrive).
 */

import type { PackConfig } from "../../packers/src/index.js";
import type { ApiEnv } from "./env.js";
import { withHyperdriveClient } from "./pg.js";
import { createKysely } from "../../db/src/kysely.js";

export type UserLookup = { userId?: string; username?: string; host?: string | null };

/** UserDetailed of one user by id or local username (user-detailed-pg); null when missing. */
export async function getUserDetailedPg(
  env: ApiEnv,
  lookup: UserLookup,
  viewerId: string | null,
  _config?: PackConfig,
  _rootUserId?: string | null,
): Promise<Record<string, unknown> | null> {
  let id = lookup.userId ?? null;
  if (!id && lookup.username) {
    id = await withHyperdriveClient(env.HYPERDRIVE!, async (c) => {
      const row = await createKysely(c)
        .selectFrom("user")
        .select(["id"])
        .where("usernameLower", "=", lookup.username!.toLowerCase())
        .where("host", lookup.host ? "=" : "is", lookup.host ? lookup.host.toLowerCase() : null)
        .limit(1)
        .executeTakeFirst();
      return row?.id ?? null;
    });
  }
  if (!id) return null;
  const { packUserDetailedPg } = await import("./user-detailed-pg.js");
  return packUserDetailedPg(env, id, viewerId, { schema: "UserDetailed" });
}

let rootCache: { id: string | null; at: number } | null = null;

/** meta.rootUserId (cached 60s per isolate). */
export async function getRootUserId(env: ApiEnv): Promise<string | null> {
  if (!env.HYPERDRIVE?.connectionString) return null;
  if (rootCache && Date.now() - rootCache.at < 60_000) return rootCache.id;
  const id = await withHyperdriveClient(env.HYPERDRIVE, async (c) => {
    const row = await createKysely(c).selectFrom("meta").select(["rootUserId"]).orderBy("id", "desc").limit(1).executeTakeFirst();
    return row?.rootUserId ?? null;
  });
  rootCache = { id, at: Date.now() };
  return id;
}

