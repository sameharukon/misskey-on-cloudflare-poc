/**
 * Outbound delivery: enqueue to mk-deliver; consumer signs (draft-cavage,
 * rsa-sha256, digest) and POSTs. federation=none → nothing is enqueued and
 * the consumer drops anything already queued. Suspended instances are skipped,
 * and each result updates the instance's isNotResponding (DeliverProcessorService).
 */

import { fetchChecked, REMOTE_FETCH_TIMEOUT_MS } from "../safe-fetch.js";
import { isSafeRemoteUrl, signedPostHeaders, userUri, withContext } from "../../../ap/src/index.js";
import type { ApiEnv } from "../env.js";
import { withHyperdriveClient } from "../pg.js";
import { getQueueProducer, MK_DELIVER, sendAll } from "../queues/fanout.js";
import { FAST_DELIVER_MAX, FAST_PATH_BACKUP_DELAY_S, fastPathAvailable, runFastPath } from "./fast-path.js";
import { getFederationPolicy, hostAllowed, hostOf } from "./federation.js";
import { deliverFailed, deliverGone, deliverPrecheck, deliverSucceeded } from "./instances.js";
import { getUserKeypair } from "./keys.js";
import { localBase } from "./remote.js";

export type DeliverMessage = {
  kind: "deliver";
  signerId: string;
  inbox: string;
  activity: Record<string, unknown>;
  /** Set when the delivery was also made at once (fast-path.ts): the queued copy is a backup. */
  fast?: string;
};

export type EnqueueResult = { refused: boolean; queued: number };

/**
 * An activity without an `id` gets `{url}/{uuid}` (upstream ApRendererService.addContext): Misskey
 * drops activities without one ("activity id is not a string"). Set on the object itself, so the
 * relay copy and the followers' copy of one activity carry the same id.
 */
export function ensureActivityId(env: ApiEnv, activity: Record<string, unknown>): Record<string, unknown> {
  if (activity.id == null) activity.id = `${localBase(env)}/${crypto.randomUUID()}`;
  return activity;
}

/** Queue an activity for each inbox (dedup, policy + SSRF filtered). */
export async function enqueueDeliver(
  env: ApiEnv,
  signerId: string,
  inboxes: (string | null | undefined)[],
  activity: Record<string, unknown>,
): Promise<EnqueueResult> {
  const policy = await getFederationPolicy(env);
  if (policy.mode === "none") return { refused: true, queued: 0 };
  const targets = [...new Set(inboxes.filter((x): x is string => typeof x === "string" && x.length > 0))].filter(
    (u) => isSafeRemoteUrl(u) && hostAllowed(policy, hostOf(u)),
  );
  const producer = getQueueProducer(env);
  const body = withContext(ensureActivityId(env, activity));
  const fast = targets.length > 0 && targets.length <= FAST_DELIVER_MAX && fastPathAvailable(env);
  const messages = targets.map(
    (inbox) => ({ kind: "deliver", signerId, inbox, activity: body, ...(fast ? { fast: crypto.randomUUID() } : {}) }) satisfies DeliverMessage,
  );
  await sendAll(producer, MK_DELIVER, messages, fast ? { delaySeconds: FAST_PATH_BACKUP_DELAY_S } : undefined);
  if (fast) {
    for (const m of messages) runFastPath(env, m.fast!, "deliver", async () => (await processDeliver(env, m)) !== "retry");
  }
  return { refused: false, queued: targets.length };
}

/** Shared inboxes of remote followers of a local user. */
export async function remoteFollowerInboxes(env: ApiEnv, userId: string): Promise<string[]> {
  if (!env.HYPERDRIVE?.connectionString) return [];
  return withHyperdriveClient(env.HYPERDRIVE, async (c) => {
    const r = await c.query(
      `SELECT DISTINCT COALESCE("followerSharedInbox", "followerInbox") AS inbox
       FROM following WHERE "followeeId" = $1 AND "followerHost" IS NOT NULL`,
      [userId],
    );
    return r.rows.map((x) => x.inbox as string | null).filter((x): x is string => Boolean(x));
  });
}

/** Inbox for a remote user id (personal inbox preferred for direct activities). */
export async function remoteInboxOf(env: ApiEnv, userId: string, shared = false): Promise<string | null> {
  if (!env.HYPERDRIVE?.connectionString) return null;
  return withHyperdriveClient(env.HYPERDRIVE, async (c) => {
    const r = await c.query(`SELECT inbox, "sharedInbox" FROM "user" WHERE id = $1 AND host IS NOT NULL`, [userId]);
    const row = r.rows[0];
    if (!row) return null;
    return ((shared ? row.sharedInbox ?? row.inbox : row.inbox ?? row.sharedInbox) as string | null) ?? null;
  });
}

export function localActorUri(env: ApiEnv, userId: string): string {
  return userUri(localBase(env), userId);
}

export type DeliverOutcome = "delivered" | "dropped" | "retry";

/**
 * Delay before retry `attempts` (1 = after the first failure) of a delivery: upstream
 * httpRelatedBackoff, (2^n − 1) minutes up to 8 hours plus 0–20 % jitter. With max_retries = 11
 * (12 attempts, upstream deliverJobMaxAttempts) a delivery is retried for about 32–39 hours.
 */
export function deliverRetryDelaySeconds(attempts: number, random = Math.random): number {
  const base = Math.min(8 * 3600, (2 ** Math.max(1, attempts) - 1) * 60);
  return Math.round(base * (1 + random() * 0.2));
}

/**
 * mk-deliver messages handled at once in a batch. Deliveries to one inbox keep their order (one
 * after another); different inboxes go in parallel so a slow server does not hold the others
 * (upstream DeliverProcessor runs 128 at once). Workers let 6 connections wait for response
 * headers at a time; one is left for the batch's Postgres connection (shared by all messages,
 * pg queues the queries).
 */
export const DELIVER_CONCURRENCY = 5;


/** mk-deliver consumer body. */
export async function processDeliver(env: ApiEnv, msg: DeliverMessage): Promise<DeliverOutcome> {
  const policy = await getFederationPolicy(env);
  if (policy.mode === "none") return "dropped";
  if (!isSafeRemoteUrl(msg.inbox) || !hostAllowed(policy, hostOf(msg.inbox))) return "dropped";
  const host = hostOf(msg.inbox)!;
  // DeliverProcessorService: suspended instances and suspended software are skipped
  const pre = await deliverPrecheck(env, host);
  if (pre.skip) return "dropped";
  const kp = await getUserKeypair(env, msg.signerId);
  if (!kp) return "dropped";
  const body = JSON.stringify(msg.activity);
  const headers = await signedPostHeaders({
    privateKeyPem: kp.privateKey,
    keyId: `${localActorUri(env, msg.signerId)}#main-key`,
    url: msg.inbox,
    body,
  });
  let res: Response;
  try {
    // a redirect is followed only to another safe URL
    res = (await fetchChecked(env.AP_FETCH ?? fetch, msg.inbox, {
      method: "POST",
      headers: { ...headers, "User-Agent": "misskey-cf" },
      body,
      signal: AbortSignal.timeout(REMOTE_FETCH_TIMEOUT_MS),
    }, { check: (u) => isSafeRemoteUrl(u.href) })).res;
  } catch (e) {
    console.warn(`deliver to ${msg.inbox} failed: ${e instanceof Error ? e.message : String(e)}`);
    await deliverFailed(env, host);
    return "retry";
  }
  const act = msg.activity as { type?: unknown; object?: unknown };
  const objType = act.object && typeof act.object === "object" ? (act.object as { type?: unknown }).type : null;
  console.log(`deliver ${String(act.type)}${typeof objType === "string" ? `(${objType})` : ""} to ${msg.inbox}: ${res.status}`);
  // the answer's body is not used
  await res.body?.cancel().catch(() => {});
  if (res.ok) {
    await deliverSucceeded(env, pre.instance);
    return "delivered";
  }
  await deliverFailed(env, host);
  // a shared inbox answering 410: the server is gone, stop delivering to it
  if (res.status === 410) await deliverGone(env, host, msg.inbox);
  // upstream DeliverProcessor: 4xx (except 408/429) is permanent
  if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) return "dropped";
  return "retry";
}
