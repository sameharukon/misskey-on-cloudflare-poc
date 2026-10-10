/**
 * User webhooks (W7.10) on PG `webhook` (upstream schema): i/webhooks/create|update|delete|list|show|test,
 * the events (note / reply / renote / mention / follow / followed / unfollow) and delivery.
 *
 * Upstream enqueues a BullMQ `userWebhookDeliver` job per matching active webhook; here a CF Queue
 * `mk-webhook-deliver` consumed by this worker. Delivery follows UserWebhookDeliverProcessorService:
 * POST JSON `{ server, hookId, userId, eventId, createdAt, type, body }` with the Misskey-Hooks
 * headers, `latestSentAt` / `latestStatus` updated each attempt (1 for network errors), 4xx except
 * 408/429 not retried. Test sends try once.
 * System webhooks (system-webhooks-pg.ts) share the queue and consumer as `kind: "systemWebhook"`.
 *
 * `reaction` is accepted in `on` but, as upstream, never sent. Targets must be http(s) and not a
 * localhost / IP-literal host (upstream relies on HttpRequestService's private-address filter).
 */

import { genAidx } from "../../id/src/index.js";
import type { ApiEnv } from "./env.js";
import { apiErrorResponse, CREDENTIAL_REQUIRED } from "./errors.js";
import { withHyperdriveClient, type PgQueryable } from "./pg.js";
import { REMOTE_FETCH_TIMEOUT_MS } from "./safe-fetch.js";
import { getUserPoliciesPg } from "./policies-pg.js";
import { buildPackConfig } from "./meta-source.js";
import { authUserId as auth, clientError as err, errorResponse as fail, hd, invalidParam as bad } from "./handler-kit.js";
import { enqueueWebhook } from "./queues/jobs-queue.js";

type Ctx = { hasCredential: boolean; request: Request };
type Body = Record<string, unknown>;
export type WebhookHandler = (env: ApiEnv, body: Body, ctx: Ctx) => Promise<Response | unknown>;

export const WEBHOOK_EVENT_TYPES = ["mention", "unfollow", "follow", "followed", "note", "reply", "renote", "reaction"] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

const noSuch = (id: string) => err("NO_SUCH_WEBHOOK", id, "No such webhook.");
const E = {
  tooMany: err("TOO_MANY_WEBHOOKS", "87a9bb19-111e-4e37-81d3-a3e7426453b0", "You cannot create webhook any more."),
  update: noSuch("fb0fea69-da18-45b1-828d-bd4fd1612518"),
  delete: noSuch("bae73e5a-5522-4965-ae19-3a8688e71d82"),
  show: noSuch("50f614d9-3047-4f7e-90d8-ad6b2d5fb098"),
  test: noSuch("0c52149c-e913-18f8-5dc7-74870bfe0cf9"),
};

const noContent = () => new Response(null, { status: 204 });

type WebhookRow = { id: string; userId: string; name: string; on: string[]; url: string; secret: string; active: boolean; latestSentAt: unknown; latestStatus: number | null };

function packWebhook(w: WebhookRow) {
  return {
    id: w.id,
    userId: w.userId,
    name: w.name,
    on: w.on ?? [],
    url: w.url,
    secret: w.secret,
    active: Boolean(w.active),
    latestSentAt: w.latestSentAt ? new Date(String(w.latestSentAt)).toISOString() : null,
    latestStatus: w.latestStatus == null ? null : Number(w.latestStatus),
  };
}

const COLS = `id, "userId", name, "on", url, secret, active, "latestSentAt", "latestStatus"`;

async function getOwn(c: PgQueryable, id: unknown, userId: string): Promise<WebhookRow | null> {
  if (typeof id !== "string") return null;
  return ((await c.query(`SELECT ${COLS} FROM webhook WHERE id = $1 AND "userId" = $2`, [id, userId])).rows[0] as WebhookRow | undefined) ?? null;
}

const len = (s: string) => [...s].length;
const validOn = (v: unknown) => Array.isArray(v) && v.every((x) => (WEBHOOK_EVENT_TYPES as readonly string[]).includes(x as string));
const strIn = (v: unknown, min: number, max: number) => typeof v === "string" && len(v) >= min && len(v) <= max;

// ---------------------------------------------------------------- endpoints

const create: WebhookHandler = async (env, body, ctx) => {
  const me = await auth(env, body, ctx);
  if (!me) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  if (!strIn(body.name, 1, 100) || !strIn(body.url, 1, 1024) || !validOn(body.on)) return bad();
  if (body.secret !== undefined && !strIn(body.secret, 0, 1024)) return bad();
  return withHyperdriveClient(hd(env), async (c) => {
    const n = Number((await c.query(`SELECT count(*)::int AS n FROM webhook WHERE "userId" = $1`, [me])).rows[0]?.n ?? 0);
    if (n >= Number((await getUserPoliciesPg(env, c, me)).webhookLimit)) return fail(E.tooMany);
    const id = genAidx(Date.now());
    await c.query(`INSERT INTO webhook (id, "userId", name, url, secret, "on") VALUES ($1, $2, $3, $4, $5, $6::varchar[])`, [
      id, me, body.name, body.url, (body.secret as string | undefined) ?? "", body.on,
    ]);
    return packWebhook((await getOwn(c, id, me))!);
  });
};

const update: WebhookHandler = async (env, body, ctx) => {
  const me = await auth(env, body, ctx);
  if (!me) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  if (typeof body.webhookId !== "string") return bad();
  if (body.name !== undefined && !strIn(body.name, 1, 100)) return bad();
  if (body.url !== undefined && !strIn(body.url, 1, 1024)) return bad();
  if (body.secret !== undefined && body.secret !== null && !strIn(body.secret, 0, 1024)) return bad();
  if (body.on !== undefined && !validOn(body.on)) return bad();
  if (body.active !== undefined && typeof body.active !== "boolean") return bad();
  return withHyperdriveClient(hd(env), async (c) => {
    const w = await getOwn(c, body.webhookId, me);
    if (!w) return fail(E.update);
    const sets: string[] = [];
    const params: unknown[] = [w.id];
    const set = (col: string, v: unknown, cast = "") => sets.push(`"${col}" = $${params.push(v)}${cast}`);
    if (body.name !== undefined) set("name", body.name);
    if (body.url !== undefined) set("url", body.url);
    if (body.secret !== undefined) set("secret", body.secret === null ? "" : body.secret);
    if (body.on !== undefined) set("on", body.on, "::varchar[]");
    if (body.active !== undefined) set("active", body.active);
    if (sets.length) await c.query(`UPDATE webhook SET ${sets.join(", ")} WHERE id = $1`, params);
    return noContent();
  });
};

const del: WebhookHandler = async (env, body, ctx) => {
  const me = await auth(env, body, ctx);
  if (!me) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  if (typeof body.webhookId !== "string") return bad();
  return withHyperdriveClient(hd(env), async (c) => {
    const w = await getOwn(c, body.webhookId, me);
    if (!w) return fail(E.delete);
    await c.query(`DELETE FROM webhook WHERE id = $1`, [w.id]);
    return noContent();
  });
};

const list: WebhookHandler = async (env, body, ctx) => {
  const me = await auth(env, body, ctx);
  if (!me) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  return withHyperdriveClient(hd(env), async (c) =>
    ((await c.query(`SELECT ${COLS} FROM webhook WHERE "userId" = $1 ORDER BY id`, [me])).rows as WebhookRow[]).map(packWebhook),
  );
};

const show: WebhookHandler = async (env, body, ctx) => {
  const me = await auth(env, body, ctx);
  if (!me) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  if (typeof body.webhookId !== "string") return bad();
  const w = await withHyperdriveClient(hd(env), (c) => getOwn(c, body.webhookId, me));
  return w ? packWebhook(w) : fail(E.show);
};

/** WebhookTestService dummies (not in the database): generateDummyUser / generateDummyNote + its packers. */
const DAY_MS = 24 * 3600_000;
type DummyUser = { id: string; username: string; name: string; updatedAt: Date; lastFetchedAt: Date; followersCount: number; followingCount: number; notesCount: number };
type DummyNote = { id: string; text: string | null; userId: string; user: DummyUser; replyId: string | null; reply: DummyNote | null; renoteId: string | null; renote: DummyNote | null; mentions: string[] };

function dummyPayload(type: WebhookEventType): Record<string, unknown> | null {
  const now = Date.now();
  const u = (o: Partial<DummyUser>): DummyUser => ({
    id: "dummy-user-1", username: "dummy1", name: "DummyUser1", updatedAt: new Date(now - DAY_MS * 7), lastFetchedAt: new Date(now - DAY_MS * 5),
    followersCount: 10, followingCount: 5, notesCount: 30, ...o,
  });
  const u1 = u({});
  const u2 = u({ id: "dummy-user-2", updatedAt: new Date(now - DAY_MS * 30), lastFetchedAt: new Date(now - DAY_MS), username: "dummy2", name: "DummyUser2", followersCount: 40, followingCount: 50, notesCount: 900 });
  const u3 = u({ id: "dummy-user-3", updatedAt: new Date(now - DAY_MS * 15), lastFetchedAt: new Date(now - DAY_MS * 2), username: "dummy3", name: "DummyUser3", followersCount: 60, followingCount: 70, notesCount: 15900 });
  const lite = (x: DummyUser) => ({
    id: x.id, name: x.name, username: x.username, host: null, avatarUrl: "", avatarBlurhash: null, avatarDecorations: [], isBot: false, isCat: true,
    emojis: {}, onlineStatus: "active", badgeRoles: [],
  });
  const detailedNotMe = (x: DummyUser) => ({
    ...lite(x),
    url: null, uri: null, movedTo: null, alsoKnownAs: [], createdAt: new Date().toISOString(), updatedAt: x.updatedAt.toISOString(),
    lastFetchedAt: x.lastFetchedAt.toISOString(), bannerUrl: null, bannerBlurhash: null, isLocked: false, isSilenced: false, isSuspended: false,
    description: null, location: null, birthday: null, lang: null, fields: [], verifiedLinks: [], followersCount: x.followersCount,
    followingCount: x.followingCount, notesCount: x.notesCount, pinnedNoteIds: [], pinnedNotes: [], pinnedPageId: null, pinnedPage: null,
    publicReactions: true, followersVisibility: "public", followingVisibility: "public", chatScope: "mutual", canChat: true,
    twoFactorEnabled: false, usePasswordLessLogin: false, securityKeys: false, roles: [], memo: null, moderationNote: undefined,
    isFollowing: false, isFollowed: false, hasPendingFollowRequestFromYou: false, hasPendingFollowRequestToYou: false,
    isBlocking: false, isBlocked: false, isMuted: false, isRenoteMuted: false, notify: "none", withReplies: true,
  });
  const n = (o: Partial<DummyNote>): DummyNote => ({
    id: "dummy-note-1", text: "This is a dummy note for testing purposes.", userId: u1.id, user: u1, replyId: null, reply: null, renoteId: null, renote: null, mentions: [], ...o,
  });
  const packed = (x: DummyNote, detail = true): Record<string, unknown> => ({
    id: x.id, createdAt: new Date().toISOString(), deletedAt: null, text: x.text, cw: null, userId: x.userId, user: lite(x.user),
    replyId: x.replyId, renoteId: x.renoteId, isHidden: false, visibility: "public", mentions: x.mentions, visibleUserIds: [], fileIds: [],
    files: [], tags: [], poll: null, emojis: {}, channelId: null, channel: null, localOnly: true, reactionAcceptance: "likeOnly",
    reactionEmojis: {}, reactions: {}, reactionCount: 0, renoteCount: 10, repliesCount: 5, uri: undefined, url: undefined,
    reactionAndUserPairCache: [],
    ...(detail ? { clippedCount: 0, reply: x.reply ? packed(x.reply, false) : null, renote: x.renote ? packed(x.renote, true) : null, myReaction: null } : {}),
  });
  const note1 = n({});
  switch (type) {
    case "note": return { note: packed(note1) };
    case "reply": return { note: packed(n({ id: "dummy-reply-1", replyId: note1.id, reply: note1 })) };
    case "renote": return { note: packed(n({ id: "dummy-renote-1", renoteId: note1.id, renote: note1, userId: u2.id, user: u2, text: null })) };
    case "mention": return { note: packed(n({ id: "dummy-mention-1", text: `@${u2.username} This is a mention to you.`, mentions: [u2.id] })) };
    case "follow": return { user: detailedNotMe(u1) };
    case "followed": return { user: lite(u2) };
    case "unfollow": return { user: detailedNotMe(u3) };
    default: return null; // reaction: not implemented upstream either (#9485)
  }
}

const test: WebhookHandler = async (env, body, ctx) => {
  const me = await auth(env, body, ctx);
  if (!me) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  if (typeof body.webhookId !== "string" || !(WEBHOOK_EVENT_TYPES as readonly string[]).includes(body.type as string)) return bad();
  const o = body.override;
  if (o !== undefined && (!o || typeof o !== "object" || Array.isArray(o))) return bad();
  const override = (o ?? {}) as { url?: unknown; secret?: unknown };
  if ((override.url !== undefined && typeof override.url !== "string") || (override.secret !== undefined && typeof override.secret !== "string")) return bad();
  const w = await withHyperdriveClient(hd(env), (c) => getOwn(c, body.webhookId, me));
  if (!w) return fail(E.test);
  const content = dummyPayload(body.type as WebhookEventType);
  if (content) {
    await sendToQueue(env, {
      ...message(w, body.type as WebhookEventType, content),
      ...(typeof override.url === "string" ? { to: override.url } : {}),
      ...(typeof override.secret === "string" ? { secret: override.secret } : {}),
      maxAttempts: 1,
    });
  }
  return noContent();
};

// ---------------------------------------------------------------- enqueue

export type WebhookDeliverMessage = {
  kind: "userWebhook";
  webhookId: string;
  userId: string;
  to: string;
  secret: string;
  type: WebhookEventType;
  content: unknown;
  createdAt: number;
  eventId: string;
  /** upstream job attempts (4; 1 for tests) */
  maxAttempts?: number;
  /** R2 key of `content` when the message would be over the queue limit (see sendToQueue) */
  contentKey?: string;
};

/** upstream `systemWebhookDeliver` job (system-webhooks-pg.ts); recorded on `system_webhook`, no `userId`. */
export type SystemWebhookDeliverMessage = {
  kind: "systemWebhook";
  webhookId: string;
  to: string;
  secret: string;
  type: string;
  content: unknown;
  createdAt: number;
  eventId: string;
  maxAttempts?: number;
  contentKey?: string;
};

export type AnyWebhookDeliverMessage = WebhookDeliverMessage | SystemWebhookDeliverMessage;

function message(w: WebhookRow, type: WebhookEventType, content: unknown): WebhookDeliverMessage {
  return { kind: "userWebhook", webhookId: w.id, userId: w.userId, to: w.url, secret: w.secret, type, content, createdAt: Date.now(), eventId: crypto.randomUUID(), maxAttempts: 4 };
}

/**
 * Queue messages are capped at 128 KB (upstream's BullMQ has no such limit). A larger message
 * carries its content in R2 instead (`contentKey`), read back on every attempt and removed once
 * the job is done (releaseWebhookContent).
 */
export const WEBHOOK_INLINE_MAX_BYTES = 120 * 1024;
const WEBHOOK_CONTENT_PREFIX = "webhook-payloads/";

export async function sendToQueue(env: ApiEnv, msg: AnyWebhookDeliverMessage): Promise<void> {
  if (!env.Q_WEBHOOK_DELIVER) {
    await processWebhookDeliver(env, msg); // offline / tests: deliver inline, once
    return;
  }
  if (new TextEncoder().encode(JSON.stringify(msg)).byteLength <= WEBHOOK_INLINE_MAX_BYTES) {
    await enqueueWebhook(env, msg);
    return;
  }
  if (!env.MEDIA_BUCKET) {
    await processWebhookDeliver(env, msg); // no bucket: one attempt now rather than none
    return;
  }
  const contentKey = `${WEBHOOK_CONTENT_PREFIX}${msg.eventId}.json`;
  await env.MEDIA_BUCKET.put(contentKey, JSON.stringify(msg.content ?? null), { httpMetadata: { contentType: "application/json" } });
  await enqueueWebhook(env, { ...msg, content: null, contentKey });
}

/** Remove the R2 copy of a finished job's content (delivered, dropped or out of attempts). */
export async function releaseWebhookContent(env: ApiEnv, msg: AnyWebhookDeliverMessage): Promise<void> {
  if (!msg.contentKey || !env.MEDIA_BUCKET) return;
  await env.MEDIA_BUCKET.delete(msg.contentKey).catch((e: unknown) => console.warn(`webhook content cleanup failed: ${e instanceof Error ? e.message : String(e)}`));
}

/** Active webhooks of `userId` subscribed to `type` (cheap check before packing payloads). */
export async function activeWebhooks(env: ApiEnv, userId: string, type: WebhookEventType): Promise<WebhookRow[]> {
  if (!env.HYPERDRIVE?.connectionString) return [];
  return withHyperdriveClient(hd(env), async (c) =>
    (await c.query(`SELECT ${COLS} FROM webhook WHERE "userId" = $1 AND active = TRUE AND $2 = ANY("on")`, [userId, type])).rows as WebhookRow[],
  );
}

/**
 * UserWebhookService.enqueueUserWebhook. `content` may be a thunk so payloads are only packed
 * when someone listens. Best-effort: never fails the calling action.
 */
export async function enqueueUserWebhook(
  env: ApiEnv,
  userId: string,
  type: WebhookEventType,
  content: unknown | (() => Promise<unknown>),
): Promise<number> {
  try {
    const hooks = await activeWebhooks(env, userId, type);
    if (!hooks.length) return 0;
    const payload = typeof content === "function" ? await (content as () => Promise<unknown>)() : content;
    for (const w of hooks) await sendToQueue(env, message(w, type, payload));
    return hooks.length;
  } catch (e) {
    console.warn(`webhook enqueue failed: ${e instanceof Error ? e.message : String(e)}`);
    return 0;
  }
}

// ---------------------------------------------------------------- events

async function threadMuted(env: ApiEnv, userId: string, noteId: string): Promise<boolean> {
  return withHyperdriveClient(hd(env), async (c) =>
    (await c.query(
      `SELECT 1 AS ok FROM note_thread_muting
       WHERE "userId" = $1 AND "threadId" = COALESCE((SELECT "threadId" FROM note WHERE id = $2), $2) LIMIT 1`,
      [userId, noteId],
    )).rows.length > 0,
  );
}

/**
 * NoteCreateService.postNoteCreated: `note` to the author; `reply` to a local reply target
 * (unless they muted the thread); `renote` (renotes and quotes) to a local renote target other
 * than the author; `mention` to each mentioned local user (unless they muted the thread).
 */
export async function webhooksForNoteCreated(
  env: ApiEnv,
  note: { id: string; userId: string; replyId: string | null; replyUserId?: string | null; replyUserHost?: string | null; renoteUserId?: string | null; renoteUserHost?: string | null },
  packed: unknown,
  mentionIds: string[],
): Promise<void> {
  try {
    await enqueueUserWebhook(env, note.userId, "note", { note: packed });
    if (note.replyId && note.replyUserId && note.replyUserHost == null && !(await threadMuted(env, note.replyUserId, note.replyId))) {
      await enqueueUserWebhook(env, note.replyUserId, "reply", { note: packed });
    }
    if (note.renoteUserId && note.renoteUserHost == null && note.renoteUserId !== note.userId) {
      await enqueueUserWebhook(env, note.renoteUserId, "renote", { note: packed });
    }
    for (const uid of mentionIds) {
      if (note.replyId && (await threadMuted(env, uid, note.replyId))) continue;
      await enqueueUserWebhook(env, uid, "mention", { note: packed });
    }
  } catch (e) {
    console.warn(`note webhooks failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * UserFollowingService.insertFollowingDoc: `follow` (followee as UserDetailedNotMe for the
 * follower) and `followed` (follower as UserLite) for local users.
 */
export async function webhooksForFollow(env: ApiEnv, followerId: string, followeeId: string): Promise<void> {
  const { getUserDetailedPg, getRootUserId } = await import("./users-pg.js");
  const { getUsersByIdsPg } = await import("./notes-pg.js");
  const { packUserLite } = await import("../../packers/src/index.js");
  const config = buildPackConfig(env);
  await enqueueUserWebhook(env, followerId, "follow", async () => ({
    user: await getUserDetailedPg(env, { userId: followeeId }, followerId, config, await getRootUserId(env)),
  }));
  await enqueueUserWebhook(env, followeeId, "followed", async () => {
    const u = (await getUsersByIdsPg(env, [followerId])).get(followerId);
    return { user: u ? packUserLite(u, config) : null };
  });
}

/** UserFollowingService.unfollow / block: `unfollow` to the (local) follower, followee as UserDetailedNotMe. */
export async function webhooksForUnfollow(env: ApiEnv, followerId: string, followeeId: string): Promise<void> {
  const { getUserDetailedPg, getRootUserId } = await import("./users-pg.js");
  const config = buildPackConfig(env);
  await enqueueUserWebhook(env, followerId, "unfollow", async () => ({
    user: await getUserDetailedPg(env, { userId: followeeId }, followerId, config, await getRootUserId(env)),
  }));
}

// ---------------------------------------------------------------- delivery

export function isSafeWebhookUrl(u: string): boolean {
  let url: URL;
  try {
    url = new URL(u);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  const h = url.hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return false;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h) || h.includes(":") || h.startsWith("[")) return false;
  return true;
}

export type WebhookOutcome = "delivered" | "dropped" | "retry";

export async function processWebhookDeliver(env: ApiEnv, msg: AnyWebhookDeliverMessage): Promise<WebhookOutcome> {
  const record = async (status: number) => {
    if (!env.HYPERDRIVE?.connectionString) return;
    await withHyperdriveClient(hd(env), (c) => c.query(`UPDATE ${msg.kind === "systemWebhook" ? "system_webhook" : "webhook"} SET "latestSentAt" = now(), "latestStatus" = $2 WHERE id = $1`, [msg.webhookId, status]));
  };
  if (!isSafeWebhookUrl(msg.to)) {
    await record(1);
    return "dropped";
  }
  let content = msg.content;
  if (msg.contentKey) {
    const obj = await env.MEDIA_BUCKET?.get(msg.contentKey);
    if (!obj) return "dropped";
    content = JSON.parse(new TextDecoder().decode(await obj.arrayBuffer()));
  }
  const config = buildPackConfig(env);
  let res: Response;
  try {
    res = await (env.AP_FETCH ?? fetch)(msg.to, {
      method: "POST",
      headers: {
        "User-Agent": "Misskey-Hooks",
        "X-Misskey-Host": config.host,
        "X-Misskey-Hook-Id": msg.webhookId,
        "X-Misskey-Hook-Secret": msg.secret,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        server: config.url,
        hookId: msg.webhookId,
        ...(msg.kind === "userWebhook" ? { userId: msg.userId } : {}),
        eventId: msg.eventId,
        createdAt: msg.createdAt,
        type: msg.type,
        body: content,
      }),
      redirect: "manual",
      signal: AbortSignal.timeout(REMOTE_FETCH_TIMEOUT_MS),
    });
  } catch {
    await record(1);
    return "retry";
  }
  await record(res.status);
  await res.body?.cancel().catch(() => {});
  if (res.ok) return "delivered";
  if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) return "dropped";
  return "retry";
}

// ---------------------------------------------------------------- registry

function pgOnly(h: WebhookHandler): WebhookHandler {
  return async (env, body, ctx) => {
    if (!env.HYPERDRIVE?.connectionString) {
      return apiErrorResponse({ message: "Hyperdrive required.", code: "HYPERDRIVE_UNBOUND", id: "00000000-0000-4000-8000-0000000000b1", kind: "server" }, 501);
    }
    return h(env, body, ctx);
  };
}

const RAW: Record<string, WebhookHandler> = {
  "i/webhooks/create": create,
  "i/webhooks/update": update,
  "i/webhooks/delete": del,
  "i/webhooks/list": list,
  "i/webhooks/show": show,
  "i/webhooks/test": test,
};

export const webhookHandlers: Record<string, WebhookHandler> = Object.fromEntries(Object.entries(RAW).map(([k, h]) => [k, pgOnly(h)]));

