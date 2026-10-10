/**
 * Relays (upstream RelayService): `relay` rows, Follow / Undo(Follow) to the relay inbox
 * signed by the `relay` system account (SystemAccountService: `system.relay`, created on
 * first use with its own keypair), the relay's Accept / Reject answer, deliverToRelays (public
 * activities LD-signed by their author to every accepted relay) and isRelayActor (relayed
 * Announces publish the note instead of renoting it).
 */

import { randomUUID } from "node:crypto";
import { genRsaPem } from "./rsa.js";
import bcrypt from "bcryptjs";
import { genAidx } from "../../../id/src/index.js";
import { AS_PUBLIC, getApId, renderFollow, renderUndo } from "../../../ap/src/index.js";
import type { ApiEnv } from "../env.js";
import { withHyperdriveClient, type PgQueryable } from "../pg.js";
import { generateNativeUserToken } from "../signup-pg.js";
import { enqueueDeliver, ensureActivityId, localActorUri } from "./deliver.js";
import { getUserKeypair } from "./keys.js";
import { CONTEXT } from "./ld-contexts.js";
import { JsonLd } from "./ld-signature.js";
import { localBase, type RemoteUser } from "./remote.js";

export type RelayRow = { id: string; inbox: string; status: "requesting" | "accepted" | "rejected" };

const PUBLIC = "https://www.w3.org/ns/activitystreams#Public";

/**
 * SystemAccountService.fetch(type): the local user behind a system account, created on demand.
 * Creation runs in one transaction under an advisory lock: the unique index on
 * "user"("usernameLower", host) does not cover local users (host NULL), so concurrent first calls
 * from other isolates would each insert their own `system.<type>` user.
 */
export async function fetchSystemAccountC(c: PgQueryable, type: "actor" | "relay" | "proxy", displayName: string | null = null): Promise<string> {
  const find = async () => (await c.query(`SELECT "userId" FROM system_account WHERE type = $1 LIMIT 1`, [type])).rows[0];
  const hit = await find();
  if (hit) return String(hit.userId);
  const username = `system.${type}`;
  await c.query("BEGIN");
  try {
    await c.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`system_account:${type}`]);
    const created = await find();
    if (created) {
      await c.query("COMMIT");
      return String(created.userId);
    }
    let userId: string;
    const exist = (await c.query(`SELECT id FROM "user" WHERE "usernameLower" = $1 AND host IS NULL ORDER BY id LIMIT 1`, [username])).rows[0];
    if (exist) {
      userId = String(exist.id);
    } else {
      const [publicKey, privateKey] = await genRsaPem();
      const hash = await bcrypt.hash(randomUUID(), await bcrypt.genSalt(8));
      const token = generateNativeUserToken();
      userId = genAidx(Date.now());
      await c.query(
        `INSERT INTO "user" (id, username, "usernameLower", host, token, "isLocked", "isExplorable", "isBot", name) VALUES ($1, $2, $2, NULL, $3, TRUE, FALSE, TRUE, $4)`,
        [userId, username, token, displayName],
      );
      await c.query(`INSERT INTO user_keypair ("userId", "publicKey", "privateKey") VALUES ($1, $2, $3)`, [userId, publicKey, privateKey]);
      await c.query(`INSERT INTO user_profile ("userId", "autoAcceptFollowed", password) VALUES ($1, FALSE, $2)`, [userId, hash]);
      await c.query(`INSERT INTO used_username (username, "createdAt") VALUES ($1, now()) ON CONFLICT DO NOTHING`, [username]);
    }
    await c.query(`INSERT INTO system_account (id, "userId", type) VALUES ($1, $2, $3)`, [genAidx(Date.now()), userId, type]);
    await c.query("COMMIT");
    return userId;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => undefined);
    throw e;
  }
}

function followRelay(env: ApiEnv, relay: RelayRow, actorId: string): Record<string, unknown> {
  return renderFollow({ id: `${localBase(env)}/activities/follow-relay/${relay.id}`, actor: localActorUri(env, actorId), object: PUBLIC });
}

const pack = (r: Record<string, unknown>): RelayRow => ({ id: String(r.id), inbox: String(r.inbox), status: r.status as RelayRow["status"] });

export async function listRelays(env: ApiEnv): Promise<RelayRow[]> {
  return withHyperdriveClient(env.HYPERDRIVE!, async (c) =>
    (await c.query(`SELECT id, inbox, status FROM relay ORDER BY id`)).rows.map(pack),
  );
}

/** Accepted relays: upstream's 10-minute MemorySingleCache (per isolate here). */
let acceptedCache = new WeakMap<object, { at: number; relays: RelayRow[] }>();

/**
 * Forget the cached accepted relays (this isolate). Upstream RelayService keeps its 10-minute cache
 * through admin changes; here adding, removing or an answer from a relay applies at once.
 */
export function resetRelayCache(): void {
  acceptedCache = new WeakMap();
}

async function getAcceptedRelays(env: ApiEnv): Promise<RelayRow[]> {
  const hit = acceptedCache.get(env);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.relays;
  if (!env.HYPERDRIVE?.connectionString) return [];
  const relays = await withHyperdriveClient(env.HYPERDRIVE, async (c) =>
    (await c.query(`SELECT id, inbox, status FROM relay WHERE status = 'accepted' ORDER BY id`)).rows.map(pack),
  );
  acceptedCache.set(env, { at: Date.now(), relays });
  return relays;
}

/** RelayService.isRelayActor: the actor's (shared) inbox is an accepted relay's inbox. */
export async function isRelayActor(env: ApiEnv, actor: { inbox: string | null; sharedInbox: string | null }): Promise<boolean> {
  const relays = await getAcceptedRelays(env);
  return relays.some((r) => (actor.inbox != null && r.inbox === actor.inbox) || (actor.sharedInbox != null && r.inbox === actor.sharedInbox));
}

/** ApRendererService.attachLdSignature: RsaSignature2017 with the local user's key. */
export async function attachLdSignature(env: ApiEnv, activity: Record<string, unknown>, userId: string): Promise<Record<string, unknown>> {
  const kp = await getUserKeypair(env, userId);
  if (!kp) throw new Error("keypair not found");
  return new JsonLd(env.AP_FETCH ?? fetch).signRsaSignature2017(activity, kp.privateKey, `${localBase(env)}/users/${userId}#main-key`);
}

/**
 * RelayService.deliverToRelays: a copy of the activity (addressed to Public when it has no `to`),
 * LD-signed by the local author, to each accepted relay's inbox. Best effort.
 */
export async function deliverToRelays(env: ApiEnv, userId: string, activity: Record<string, unknown> | null): Promise<void> {
  if (activity == null) return;
  try {
    const relays = await getAcceptedRelays(env);
    if (relays.length === 0) return;
    // upstream addContext (ApRendererService CONTEXT): defines every term the renderers use, as jsonld safe mode needs
    ensureActivityId(env, activity);
    const copy: Record<string, unknown> = { ...(JSON.parse(JSON.stringify(activity)) as Record<string, unknown>), "@context": CONTEXT };
    if (!copy.to) copy.to = [AS_PUBLIC];
    const signed = await attachLdSignature(env, copy, userId);
    await enqueueDeliver(env, userId, relays.map((r) => r.inbox), signed);
  } catch (e) {
    console.warn(`deliverToRelays failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export async function addRelay(env: ApiEnv, inbox: string): Promise<RelayRow> {
  const { relay, actorId } = await withHyperdriveClient(env.HYPERDRIVE!, async (c) => {
    const relay: RelayRow = { id: genAidx(Date.now()), inbox, status: "requesting" };
    await c.query(`INSERT INTO relay (id, inbox, status) VALUES ($1, $2, 'requesting')`, [relay.id, inbox]);
    return { relay, actorId: await fetchSystemAccountC(c, "relay") };
  });
  await enqueueDeliver(env, actorId, [relay.inbox], followRelay(env, relay, actorId));
  return relay;
}

/** Returns false when no relay has that inbox (upstream: Error('relay not found')). */
export async function removeRelay(env: ApiEnv, inbox: string): Promise<boolean> {
  const found = await withHyperdriveClient(env.HYPERDRIVE!, async (c) => {
    const row = (await c.query(`SELECT id, inbox, status FROM relay WHERE inbox = $1`, [inbox])).rows[0];
    return row ? { relay: pack(row), actorId: await fetchSystemAccountC(c, "relay") } : null;
  });
  if (!found) return false;
  const actor = localActorUri(env, found.actorId);
  await enqueueDeliver(env, found.actorId, [found.relay.inbox], renderUndo(followRelay(env, found.relay, found.actorId), actor));
  await withHyperdriveClient(env.HYPERDRIVE!, (c) => c.query(`DELETE FROM relay WHERE id = $1`, [found.relay.id]));
  resetRelayCache();
  return true;
}

/** Accept / Reject of our follow-relay activity → relay id (null when it is something else). */
export function relayIdOfFollow(env: ApiEnv, object: unknown): string | null {
  const id = getApId(object);
  const prefix = `${localBase(env)}/activities/follow-relay/`;
  return id && id.startsWith(prefix) ? id.slice(prefix.length) : null;
}

/** RelayService.relayAccepted / relayRejected: only the relay itself may answer. */
export async function relayAnswered(env: ApiEnv, relayId: string, actor: Pick<RemoteUser, "inbox" | "sharedInbox">, status: "accepted" | "rejected"): Promise<number> {
  return withHyperdriveClient(env.HYPERDRIVE!, async (c) => {
    const relay = (await c.query(`SELECT id, inbox FROM relay WHERE id = $1`, [relayId])).rows[0];
    if (!relay) return 0;
    if (actor.inbox !== relay.inbox && actor.sharedInbox !== relay.inbox) return 0;
    const r = await c.query(`UPDATE relay SET status = $2 WHERE id = $1 AND status = 'requesting' RETURNING id`, [relayId, status]);
    if (r.rows.length) resetRelayCache();
    return r.rows.length;
  });
}
