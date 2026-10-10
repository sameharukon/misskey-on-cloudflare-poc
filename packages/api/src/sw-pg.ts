/**
 * Web Push (W7.11): sw/register|unregister|show-registration|update-registration on PG
 * `sw_subscription`, and upstream PushNotificationService.pushNotification.
 *
 * Sending needs meta.enableServiceWorker plus meta.swPublicKey / swPrivateKey (VAPID; set by an
 * administrator through admin/update-meta, as upstream). Notifications are pushed as upstream
 * NotificationService does: two seconds after creation, only if still unread, with the note
 * trimmed (truncateBody). That delay is an `mk-jobs` message with `delaySeconds: 2`; without the
 * queue binding the push is sent at once. `readAllNotifications` goes to subscriptions with
 * `sendReadMessage`. A 410 from the push service deletes the subscription.
 */

import { genAidx } from "../../id/src/index.js";
import type { ApiEnv } from "./env.js";
import { apiErrorResponse, CREDENTIAL_REQUIRED, INVALID_PARAM } from "./errors.js";
import { withHyperdriveClient } from "./pg.js";
import { buildPackConfig } from "./meta-source.js";
import { buildPushRequest } from "./web-push.js";
import { REMOTE_FETCH_TIMEOUT_MS } from "./safe-fetch.js";
import { authUserId as auth, clientError as err, hd } from "./handler-kit.js";
import { enqueueJob } from "./queues/jobs-queue.js";
import { metaRowPg } from "./user-lite-pg.js";

type Ctx = { hasCredential: boolean; request: Request };
type Body = Record<string, unknown>;
type Handler = (env: ApiEnv, body: Body, ctx: Ctx) => Promise<Response | unknown>;
type Row = Record<string, unknown>;

const INVALID_ENDPOINT = err("INVALID_ENDPOINT", "4432adbe-17c0-4f9f-b43c-9ceb2f8910fe", "Invalid push endpoint.");
// upstream's id carries a leading space
const NO_SUCH_REGISTRATION = err("NO_SUCH_REGISTRATION", " b09d8066-8064-5613-efb6-0e963b21d012", "No such registration.");

/** PushNotificationService.isValidEndpoint */
export function isValidPushEndpoint(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  return url.protocol === "https:" && url.username === "" && url.password === "";
}

type ServerKeys = { enabled: boolean; publicKey: string | null; privateKey: string | null };

async function serverKeys(env: ApiEnv): Promise<ServerKeys> {
  try {
    const r = await withHyperdriveClient(hd(env), (c) => metaRowPg(c));
    return { enabled: Boolean(r?.enableServiceWorker), publicKey: (r?.swPublicKey as string | null) ?? null, privateKey: (r?.swPrivateKey as string | null) ?? null };
  } catch {
    return { enabled: false, publicKey: null, privateKey: null };
  }
}

// ---------------------------------------------------------------- endpoints

const register: Handler = async (env, body, ctx) => {
  const me = await auth(env, body, ctx);
  if (!me) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  if (typeof body.endpoint !== "string" || typeof body.auth !== "string" || typeof body.publickey !== "string") return apiErrorResponse(INVALID_PARAM, 400);
  if (body.sendReadMessage !== undefined && typeof body.sendReadMessage !== "boolean") return apiErrorResponse(INVALID_PARAM, 400);
  if (!isValidPushEndpoint(body.endpoint)) return apiErrorResponse(INVALID_ENDPOINT, 400);
  const sendReadMessage = body.sendReadMessage === true;
  const key = (await serverKeys(env)).publicKey;
  return withHyperdriveClient(hd(env), async (c) => {
    const exist = (await c.query(
      `SELECT endpoint, "sendReadMessage" FROM sw_subscription WHERE "userId" = $1 AND endpoint = $2 AND auth = $3 AND publickey = $4`,
      [me, body.endpoint, body.auth, body.publickey],
    )).rows[0];
    if (exist) return { state: "already-subscribed", key, userId: me, endpoint: exist.endpoint, sendReadMessage: Boolean(exist.sendReadMessage) };
    await c.query(`INSERT INTO sw_subscription (id, "userId", endpoint, auth, publickey, "sendReadMessage") VALUES ($1, $2, $3, $4, $5, $6)`, [
      genAidx(Date.now()), me, body.endpoint, body.auth, body.publickey, sendReadMessage,
    ]);
    return { state: "subscribed", key, userId: me, endpoint: body.endpoint, sendReadMessage };
  });
};

/** Ownership is proven by the subscription's auth secret (RFC 8291), so no credential is required. */
const unregister: Handler = async (env, body, ctx) => {
  if (typeof body.endpoint !== "string" || typeof body.auth !== "string" || typeof body.publickey !== "string") return apiErrorResponse(INVALID_PARAM, 400);
  const me = await auth(env, body, ctx);
  await withHyperdriveClient(hd(env), (c) =>
    c.query(
      `DELETE FROM sw_subscription WHERE endpoint = $1 AND auth = $2 AND publickey = $3 ${me ? `AND "userId" = $4` : ""}`,
      me ? [body.endpoint, body.auth, body.publickey, me] : [body.endpoint, body.auth, body.publickey],
    ),
  );
  return new Response(null, { status: 204 });
};

const showRegistration: Handler = async (env, body, ctx) => {
  const me = await auth(env, body, ctx);
  if (!me) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  if (typeof body.endpoint !== "string") return apiErrorResponse(INVALID_PARAM, 400);
  const r = await withHyperdriveClient(hd(env), async (c) =>
    (await c.query(`SELECT "userId", endpoint, "sendReadMessage" FROM sw_subscription WHERE "userId" = $1 AND endpoint = $2 LIMIT 1`, [me, body.endpoint])).rows[0],
  );
  return r ? { userId: r.userId, endpoint: r.endpoint, sendReadMessage: Boolean(r.sendReadMessage) } : null;
};

const updateRegistration: Handler = async (env, body, ctx) => {
  const me = await auth(env, body, ctx);
  if (!me) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  if (typeof body.endpoint !== "string" || (body.sendReadMessage !== undefined && typeof body.sendReadMessage !== "boolean")) return apiErrorResponse(INVALID_PARAM, 400);
  return withHyperdriveClient(hd(env), async (c) => {
    const r = (await c.query(`SELECT id, "userId", endpoint, "sendReadMessage" FROM sw_subscription WHERE "userId" = $1 AND endpoint = $2 LIMIT 1`, [me, body.endpoint])).rows[0];
    if (!r) return apiErrorResponse(NO_SUCH_REGISTRATION, 400);
    const sendReadMessage = body.sendReadMessage === undefined ? Boolean(r.sendReadMessage) : body.sendReadMessage;
    await c.query(`UPDATE sw_subscription SET "sendReadMessage" = $2 WHERE id = $1`, [r.id, sendReadMessage]);
    return { userId: r.userId, endpoint: r.endpoint, sendReadMessage };
  });
};

// ---------------------------------------------------------------- sending

/** misc/get-note-summary */
export function noteSummary(note: Row): string {
  if (note.deletedAt) return "(❌⛔)";
  if (note.isHidden) return "(⛔)";
  let s = note.cw != null ? String(note.cw) : note.text ? String(note.text) : "";
  const files = (note.files as unknown[] | undefined) ?? [];
  if (files.length) s += ` (📎${files.length})`;
  if (note.poll) s += " (📊)";
  if (note.replyId) s += note.reply ? `\n\nRE: ${noteSummary(note.reply as Row)}` : "\n\nRE: ...";
  if (note.renoteId) s += note.renote ? `\n\nRN: ${noteSummary(note.renote as Row)}` : "\n\nRN: ...";
  return s.trim();
}

/** PushNotificationService truncateBody (push services limit the message size). */
export function truncateBody(type: string, body: unknown): unknown {
  if (!body || typeof body !== "object") return body;
  const b = body as Row;
  if (!("note" in b) || !b.note) return body;
  const note = b.note as Row;
  const source = b.type === "renote" ? ((note.renote as Row | undefined) ?? note) : note;
  return {
    ...b,
    note: { ...note, text: noteSummary(source), cw: undefined, reply: undefined, renote: undefined, user: type === "notification" ? undefined : note.user },
  };
}

/** PushNotificationService.pushNotification. Returns how many pushes were accepted. */
export async function pushNotification(env: ApiEnv, userId: string, type: "notification" | "readAllNotifications" | "unreadAntennaNote" | "newChatMessage", body: unknown): Promise<number> {
  if (!env.HYPERDRIVE?.connectionString) return 0;
  const keys = await serverKeys(env);
  if (!keys.enabled || !keys.publicKey || !keys.privateKey) return 0;
  const subs = await withHyperdriveClient(hd(env), async (c) =>
    (await c.query(`SELECT id, endpoint, auth, publickey, "sendReadMessage" FROM sw_subscription WHERE "userId" = $1`, [userId])).rows,
  );
  if (!subs.length) return 0;
  const payload = JSON.stringify({
    type,
    body: type === "notification" || type === "unreadAntennaNote" ? truncateBody(type, body) : body,
    userId,
    dateTime: Date.now(),
  });
  const config = buildPackConfig(env);
  const fetcher = env.AP_FETCH ?? fetch;
  let ok = 0;
  for (const s of subs) {
    if (type === "readAllNotifications" && !s.sendReadMessage) continue;
    if (!isValidPushEndpoint(String(s.endpoint))) continue;
    try {
      const req = await buildPushRequest(
        { endpoint: String(s.endpoint), auth: String(s.auth), publickey: String(s.publickey) },
        payload,
        { subject: config.url, publicKey: keys.publicKey, privateKey: keys.privateKey },
      );
      const res = await fetcher(String(s.endpoint), { ...req, signal: AbortSignal.timeout(REMOTE_FETCH_TIMEOUT_MS) });
      if (res.ok) ok++;
      else if (res.status === 410) await withHyperdriveClient(hd(env), (c) => c.query(`DELETE FROM sw_subscription WHERE id = $1`, [s.id]));
    } catch (e) {
      console.warn(`web push failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return ok;
}

export type PushJob = { kind: "push"; userId: string; notificationId: string };

/** The delayed half of NotificationService.createNotification: push if still unread. */
/** upstream NotificationService: still unread after the delay → `unreadNotification` on `main` + Web Push. */
export async function runPushJob(env: ApiEnv, job: PushJob): Promise<void> {
  const { listNotifications, packNotificationsPg } = await import("./notifications-do.js");
  const unread = await listNotifications(env, job.userId, { limit: 100, unreadOnly: true });
  const item = unread.find((n) => n.id === job.notificationId);
  if (!item) return;
  const [packed] = await packNotificationsPg(env, [item], buildPackConfig(env), job.userId);
  if (!packed) return;
  const { publishToUserStream } = await import("./stream-publish.js");
  await publishToUserStream(env, job.userId, "main", "unreadNotification", packed);
  await pushNotification(env, job.userId, "notification", packed);
}

/** Called from createNotification: the 2 s "still unread?" check (at once for test notifications). */
export async function schedulePush(env: ApiEnv, userId: string, notificationId: string, immediate = false): Promise<void> {
  try {
    if (!env.HYPERDRIVE?.connectionString) return;
    const job: PushJob = { kind: "push", userId, notificationId };
    if (env.Q_JOBS) await enqueueJob(env, job, immediate ? undefined : { delaySeconds: 2 });
    else await runPushJob(env, job);
  } catch (e) {
    console.warn(`push schedule failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ---------------------------------------------------------------- registry

function pgOnly(h: Handler): Handler {
  return async (env, body, ctx) => {
    if (!env.HYPERDRIVE?.connectionString) {
      return apiErrorResponse({ message: "Hyperdrive required.", code: "HYPERDRIVE_UNBOUND", id: "00000000-0000-4000-8000-0000000000b1", kind: "server" }, 501);
    }
    return h(env, body, ctx);
  };
}

export const swHandlers: Record<string, Handler> = {
  "sw/register": pgOnly(register),
  "sw/unregister": pgOnly(unregister),
  "sw/show-registration": pgOnly(showRegistration),
  "sw/update-registration": pgOnly(updateRegistration),
};

