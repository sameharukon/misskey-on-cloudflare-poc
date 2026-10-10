/**
 * API Worker: POST /api/<endpoint> through the handler table (router.ts), ActivityPub, media,
 * streaming upgrades, queue consumers and the hourly cron.
 */
import type { ApiEnv } from "./env.js";
import { runHyperdriveSmoke } from "./db-smoke.js";
import { dispatchApi } from "./router.js";
import { handleStreamingUpgrade } from "./stream-publish.js";
import { handleApRoutes } from "./ap/routes.js";
import { describeInboxMessage, processInbox, type InboxMessage } from "./ap/inbox.js";
import { DELIVER_CONCURRENCY, deliverRetryDelaySeconds, processDeliver, type DeliverMessage } from "./ap/deliver.js";
import { processWebhookDeliver, releaseWebhookContent, type AnyWebhookDeliverMessage } from "./webhooks-pg.js";
import { runJobStep, type JobMessage } from "./jobs.js";
import { ApPermanentError } from "./ap/remote.js";
import { fastPathDone } from "./ap/fast-path.js";
import { recordOps, runWithOpsBackground } from "../../shared/src/ops.js";
import { CF_MAX_RETRIES, JOB_DATA_MAX, jobHostOf, queueTypeOf, type QueueJobEvent, type QueueTypeCounts } from "../../shared/src/queue-jobs.js";
import { cfProducer, getQueueControl, pausedDelaySeconds, pausedRoundsOf, withoutPausedRounds, withPausedRound } from "./queues/ops-jobs.js";
import { deleteExpiredMutes } from "./graph-pg.js";
import { postOverdueScheduledNotes } from "./drafts-pg.js";
import { aggregateRetentionPg } from "./misc-pg.js";
import { checkMiauthSessionPg } from "./miauth-pg.js";
import { packUserDetailedPg } from "./user-detailed-pg.js";
import { serveDriveFile } from "./drive-pg.js";
import { serveEmojiRedirect } from "./emojis-pg.js";
import { configurePg, runWithPgScope } from "./pg.js";
import { withEdgeCache } from "../../shared/src/edge-cache.js";
import { enqueueJob } from "./queues/jobs-queue.js";

export type { ApiEnv } from "./env.js";
export { dispatchApi, endpointNameFromPath } from "./router.js";
export { IMPLEMENTED_ENDPOINTS } from "./registry.js";
export { PollTimer } from "./polls-pg.js";
export { OnceGuard } from "./once-guard.js";
export { RateLimiter } from "./rate-limit.js";
export { Reversi } from "./reversi-pg.js";

export default {
  /** One Postgres connection per request (pg.ts runWithPgScope), shared by the request and its waitUntil work. */
  async fetch(request: Request, env: ApiEnv, ctx: ExecutionContext): Promise<Response> {
    const waitUntil = ctx ? (p: Promise<unknown>) => ctx.waitUntil(p) : undefined;
    configurePg({ pipeline: env.PG_PIPELINE === "1" });
    return runWithOpsBackground(waitUntil, () => runWithPgScope(() => handleFetch(request, env, ctx), waitUntil));
  },

  /** Cron: expired-mute cleanup (reads already ignore expired rows), overdue scheduled notes, daily clean, remote notes cleaning. */
  async scheduled(event: unknown, env: ApiEnv, ctx: ExecutionContext): Promise<void> {
    const waitUntil = (p: Promise<unknown>) => ctx.waitUntil(p);
    configurePg({ pipeline: env.PG_PIPELINE === "1" });
    return runWithOpsBackground(waitUntil, () => runWithPgScope(() => handleScheduled(event, env, ctx), waitUntil));
  },

  /**
   * mk-inbox / mk-deliver consumers (ActivityPub), mk-webhook-deliver and mk-jobs. OpsStats
   * bookkeeping runs in waitUntil so it never delays the batch's acks.
   */
  async queue(batch: QueueBatch, env: ApiEnv, ctx?: ExecutionContext): Promise<void> {
    const waitUntil = ctx ? (p: Promise<unknown>) => ctx.waitUntil(p) : undefined;
    configurePg({ pipeline: env.PG_PIPELINE === "1" });
    await runWithOpsBackground(waitUntil, () => runWithPgScope(() => handleApQueueBatch(batch, env)));
  },
};

async function handleFetch(request: Request, env: ApiEnv, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const waitUntil = ctx ? (p: Promise<unknown>) => ctx.waitUntil(p) : undefined;

  if (url.pathname === "/healthz") {
    return Response.json({ ok: true, service: "api" });
  }

  if (url.pathname === "/healthz/db") {
    // unauthenticated: a coarse state only; the details (meta name, root id, PG errors) go to the log
    const smoke = await runHyperdriveSmoke(env.HYPERDRIVE);
    const status = smoke.ok ? 200 : smoke.error === "HYPERDRIVE_UNBOUND" ? 503 : 500;
    if (!smoke.ok || smoke.metaError) console.warn(`healthz/db: ${smoke.error ?? smoke.metaError ?? "select failed"}`);
    const state = !smoke.ok
      ? smoke.error === "HYPERDRIVE_UNBOUND" ? "unbound" : "error"
      : smoke.metaExists === false
        ? "meta_missing" // run `pnpm db:migrate up`
        : smoke.metaRows === 0
          ? "meta_empty"
          : smoke.rootUserId == null
            ? "requires_setup" // create root via admin/accounts/create
            : "ok";
    return Response.json({ service: "api", hyperdrive: smoke.ok, state }, { status });
  }


  // Public media: GET/HEAD /files/:key → R2 (original / thumbnail-* / webpublic-*), memory offline.
  // The busiest path: answered before the other routes and from the edge cache when possible.
  const filesMatch = /^\/files\/([^/]+)$/.exec(url.pathname);
  if (filesMatch && (request.method === "GET" || request.method === "HEAD")) {
    return withEdgeCache(request, waitUntil, () => serveDriveFile(env, request, decodeURIComponent(filesMatch[1]!)));
  }

  // Custom emoji image (upstream ServerService /emoji/:path → media proxy; no proxy here, so redirect to the R2-backed file URL)
  if (url.pathname.startsWith("/emoji/") && (request.method === "GET" || request.method === "HEAD")) {
    return withEdgeCache(request, waitUntil, () => serveEmojiRedirect(env, url), { statuses: [301] });
  }

  // upstream ServerService /identicon/:x (default avatar of users without one)
  const identiconMatch = /^\/identicon\/([^/]+)$/.exec(url.pathname);
  if (identiconMatch && (request.method === "GET" || request.method === "HEAD")) {
    const { serveIdenticon } = await import("./identicon.js");
    let seed = identiconMatch[1]!;
    try {
      seed = decodeURIComponent(seed);
    } catch {
      /* keep the raw segment */
    }
    return withEdgeCache(request, waitUntil, () => serveIdenticon(env, seed), { statuses: [200, 302] });
  }

  // Streaming: authenticate here, socket lives in the user's StreamHub DO
  if (url.pathname === "/streaming") {
    return handleStreamingUpgrade(request, env);
  }

  // upstream FileServerService /proxy/:url* (media proxy)
  if (url.pathname.startsWith("/proxy/") && (request.method === "GET" || request.method === "HEAD")) {
    const { handleMediaProxy } = await import("./media-proxy.js");
    const { ipOverLimit, ipLimitedResponse } = await import("./rate-limit.js");
    // the limit counts misses only: they download
    return withEdgeCache(request, waitUntil, async () => ((await ipOverLimit(env.FETCH_RATE_LIMIT, request)) ? ipLimitedResponse() : handleMediaProxy(env, request)));
  }

  // upstream ClientServerService /url (UrlPreviewService)
  if (url.pathname === "/url" && (request.method === "GET" || request.method === "HEAD")) {
    const { handleUrlPreview } = await import("./url-preview/handler.js");
    const { ipOverLimit, ipLimitedResponse } = await import("./rate-limit.js");
    if (await ipOverLimit(env.FETCH_RATE_LIMIT, request)) return ipLimitedResponse();
    return handleUrlPreview(env, request);
  }

  // upstream ClientServerService /@:user.atom|rss|json (FeedService); before the AP `/@user` route
  const feedMatch = /^\/@([^/]+)\.(atom|rss|json)$/.exec(url.pathname);
  if (feedMatch && (request.method === "GET" || request.method === "HEAD")) {
    const { serveFeed } = await import("./feed-pg.js");
    return serveFeed(env, feedMatch[1]!, feedMatch[2] as "atom" | "rss" | "json");
  }

  // ActivityPub / WebFinger / NodeInfo (this worker is the public origin)
  const ap = await handleApRoutes(request, env);
  if (ap) return ap;


  // Upstream: POST /api/miauth/:session/check
  const miauthCheck = /^\/api\/miauth\/([^/]+)\/check$/.exec(url.pathname);
  if (miauthCheck) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "POST, GET, OPTIONS",
          "access-control-allow-headers": "content-type, authorization",
        },
      });
    }
    if (request.method !== "POST" && request.method !== "GET") {
      return new Response(null, { status: 405 });
    }
    const session = decodeURIComponent(miauthCheck[1]!);
    const hit = await checkMiauthSessionPg(env, session);
    if (!hit.ok) {
      return Response.json({ ok: false });
    }
    // upstream: userEntityService.pack(token.userId, null, { schema: 'UserDetailedNotMe' })
    const packed = await packUserDetailedPg(env, hit.userId, null, { schema: "UserDetailedNotMe" });
    return Response.json({ ok: true, token: hit.token, user: packed });
  }

  if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
    // Misskey is POST-first; allow GET for a few public endpoints
    if (request.method !== "POST" && request.method !== "GET" && request.method !== "OPTIONS") {
      return new Response(null, { status: 405 });
    }
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "POST, GET, OPTIONS",
          "access-control-allow-headers": "content-type, authorization",
        },
      });
    }
    return dispatchApi(request, env, ctx);
  }

  return new Response("misskey-cf api", {
    status: 200,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

async function handleScheduled(_event: unknown, env: ApiEnv, _ctx: ExecutionContext): Promise<void> {
  // awaited (not handed to waitUntil) so the tasks run inside the request's PG scope and share
  // its connection; each one logs its own failure
  const tasks: Promise<unknown>[] = [];
  tasks.push(
    deleteExpiredMutes(env).then(
      (n) => console.log(`expired mutes deleted: ${n}`),
      (e) => console.warn(`expired mute cleanup failed: ${e instanceof Error ? e.message : String(e)}`),
    ),
  );
  tasks.push(
    postOverdueScheduledNotes(env).then(
      (n) => n && console.log(`overdue scheduled notes posted: ${n}`),
      (e) => console.warn(`scheduled note sweep failed: ${e instanceof Error ? e.message : String(e)}`),
    ),
  );
  // upstream checkModeratorsActivity (hourly): inactiveModerators* system webhooks / invitation-only switch
  tasks.push(
    import("./maintenance-pg.js")
      .then((m) => m.checkModeratorsActivity(env))
      .then(
        (r) => r.action !== "ok" && r.action !== "unavailable" && console.log(`moderator activity check: ${r.action}`),
        (e) => console.warn(`moderator activity check failed: ${e instanceof Error ? e.message : String(e)}`),
      ),
  );
  // upstream cleanRemoteNotes runs daily at 4:00; the hourly cron starts it in the 4 UTC hour
  if (new Date().getUTCHours() === 4) {
    tasks.push(
      import("./clean-remote-notes-pg.js")
        .then((m) => m.startCleanRemoteNotes(env))
        .catch((e) => console.warn(`remote notes cleaning failed to start: ${e instanceof Error ? e.message : String(e)}`)),
    );
  }
  // upstream aggregateRetention / clean run daily at 0:00; the hourly cron runs them in the 0 UTC hour
  if (new Date().getUTCHours() === 0) {
    tasks.push(aggregateRetentionPg(env).catch((e) => console.warn(`retention aggregation failed: ${e instanceof Error ? e.message : String(e)}`)));
    tasks.push(
      import("./maintenance-pg.js")
        .then((m) => m.runCleanPg(env))
        .then(
          (r) => console.log(`clean: ${JSON.stringify(r)}`),
          (e) => console.warn(`clean failed: ${e instanceof Error ? e.message : String(e)}`),
        ),
    );
  }
  await Promise.allSettled(tasks);
}

type QueueBatch = {
  queue: string;
  messages: QueueBatchMessage[];
};
type QueueBatchMessage = {
  /** CF message id (stable across retries) and enqueue time */
  id?: string;
  timestamp?: Date;
  body: unknown;
  attempts?: number;
  ack(): void;
  retry(opts?: { delaySeconds?: number }): void;
};

type MessageOutcome = { result: string; acked: number; retried: number; dropped: number; error?: string };

export async function handleApQueueBatch(batch: QueueBatch, env: ApiEnv): Promise<{ queue: string; results: string[] }> {
  const results: string[] = new Array(batch.messages.length);
  const counts = { acked: 0, retried: 0, dropped: 0 };
  let lastError: string | undefined;
  // admin/queue/*: paused types / cancelled ids, per-type outcomes and the failed / delayed job ring
  const control = await getQueueControl(env);
  const types: QueueTypeCounts = {};
  const jobs: QueueJobEvent[] = [];

  const handle = async (orig: QueueBatchMessage, i: number): Promise<void> => {
    const type = queueTypeOf(batch.queue, orig.body);
    const msgId = orig.id ?? crypto.randomUUID();
    if (type && control?.cancelled.has(msgId)) {
      // removed (admin/queue/remove-job / clear) or promoted while delayed
      orig.ack();
      counts.dropped++;
      results[i] = "cancelled";
      return;
    }
    if (type && control?.paused.has(type)) {
      // admin/queue/pause: put the message back without consuming an attempt when possible
      const p = cfProducer(env, batch.queue);
      const rounds = pausedRoundsOf(orig.body);
      const delaySeconds = pausedDelaySeconds(rounds);
      const resent = p ? await p.send(withPausedRound(orig.body, rounds + 1), { delaySeconds }).then(() => true, () => false) : false;
      if (resent) orig.ack();
      else orig.retry({ delaySeconds: pausedDelaySeconds((orig.attempts ?? 1) - 1) });
      results[i] = "paused";
      return;
    }
    let retryDelay: number | undefined;
    let finalRetry = false;
    let msgError: string | undefined;
    const attempts = orig.attempts ?? 1;
    // explicit fields: CF Message properties are prototype getters, a spread would drop them
    const m: QueueBatchMessage = {
      id: orig.id,
      timestamp: orig.timestamp,
      body: withoutPausedRounds(orig.body),
      attempts: orig.attempts,
      ack: () => orig.ack(),
      retry: (opts) => {
        retryDelay = opts?.delaySeconds ?? 0;
        // past max_retries CF would drop the message silently: ack it and record it as failed
        if (attempts > (CF_MAX_RETRIES[batch.queue] ?? Infinity)) {
          finalRetry = true;
          orig.ack();
        } else orig.retry(opts);
      },
    };
    let out: MessageOutcome;
    try {
      out = await processQueueMessage(batch.queue, env, m);
    } catch (e) {
      const permanent = e instanceof ApPermanentError || e instanceof SyntaxError;
      console.warn(`${batch.queue} error: ${e instanceof Error ? e.message : String(e)}`);
      msgError = e instanceof Error ? e.message : String(e);
      out = { result: permanent ? "permanent_error" : "retry_error", acked: 0, retried: 0, dropped: 0, error: `${batch.queue}: ${msgError}` };
      if (permanent) {
        m.ack();
        out.dropped++;
      } else {
        m.retry({ delaySeconds: 60 });
        out.retried++;
      }
    }
    if (finalRetry && out.retried) {
      out.retried--;
      out.dropped++;
    }
    results[i] = out.result;
    counts.acked += out.acked;
    counts.retried += out.retried;
    counts.dropped += out.dropped;
    if (out.error) lastError = out.error;
    if (!type) return;
    const t = (types[type] ??= {});
    const reason = msgError ?? out.result;
    const ev = (state: QueueJobEvent["state"]): QueueJobEvent => {
      const body = m.body as Record<string, unknown> | null;
      const keep = state !== "completed" && JSON.stringify(m.body ?? null).length <= JOB_DATA_MAX;
      return {
        id: msgId,
        type,
        state,
        name: typeof body?.kind === "string" ? body.kind : type,
        ...(keep ? { data: m.body } : {}),
        timestamp: orig.timestamp ? new Date(orig.timestamp).getTime() : Date.now(),
        attempts,
        maxAttempts: typeof body?.maxAttempts === "number" ? body.maxAttempts : (CF_MAX_RETRIES[batch.queue] ?? 0) + 1,
        ...(state === "delayed" ? { delayMs: (retryDelay ?? 0) * 1000 } : {}),
        reason: finalRetry ? `max retries exceeded: ${reason}` : reason,
        host: jobHostOf(type, m.body),
      };
    };
    if (out.dropped) {
      t.failed = (t.failed ?? 0) + 1;
      jobs.push(ev("failed"));
    } else if (out.retried) {
      t.delayed = (t.delayed ?? 0) + 1;
      jobs.push(ev("delayed"));
    } else {
      t.completed = (t.completed ?? 0) + 1;
      if (attempts > 1) jobs.push(ev("completed"));
    }
  };

  if (batch.queue === "mk-deliver") {
    // one lane per inbox, at most DELIVER_CONCURRENCY lanes running
    const lanes = new Map<string, number[]>();
    batch.messages.forEach((msg, i) => {
      const inbox = (msg.body as Partial<DeliverMessage> | null)?.inbox;
      const key = typeof inbox === "string" ? inbox : `#${i}`;
      lanes.set(key, [...(lanes.get(key) ?? []), i]);
    });
    const queue = [...lanes.values()];
    const worker = async () => {
      for (let lane = queue.shift(); lane; lane = queue.shift()) {
        for (const i of lane) await handle(batch.messages[i]!, i);
      }
    };
    await Promise.all(Array.from({ length: Math.min(DELIVER_CONCURRENCY, queue.length) }, worker));
  } else {
    for (const [i, msg] of batch.messages.entries()) await handle(msg, i);
  }

  await recordOps(env.OPS_STATS, {
    queue: batch.queue,
    ...counts,
    error: lastError,
    ...(Object.keys(types).length ? { types } : {}),
    ...(jobs.length ? { jobs } : {}),
  });
  return { queue: batch.queue, results };
}

/** One message of an api-consumed queue; acks or retries it. Throws for the caller's error handling. */
async function processQueueMessage(queue: string, env: ApiEnv, m: QueueBatchMessage): Promise<MessageOutcome> {
  const out: MessageOutcome = { result: "", acked: 0, retried: 0, dropped: 0 };
  if ((queue === "mk-inbox" || queue === "mk-deliver") && (await fastPathDone(env, (m.body as { fast?: string } | null)?.fast))) {
    // already handled at once when it arrived / was sent (ap/fast-path.ts)
    out.result = "fast_done";
    m.ack();
    out.acked++;
  } else if (queue === "mk-inbox") {
    const r = await processInbox(env, m.body as InboxMessage);
    out.result = r.reason;
    console.log(`inbox ${describeInboxMessage(m.body as InboxMessage)}: ${r.ok ? "" : "rejected "}${r.reason}`);
    m.ack();
    if (r.ok) out.acked++;
    else out.dropped++;
  } else if (queue === "mk-deliver") {
    const r = await processDeliver(env, m.body as DeliverMessage);
    out.result = r;
    if (r === "retry") {
      m.retry({ delaySeconds: deliverRetryDelaySeconds(m.attempts ?? 1) });
      out.retried++;
      out.error = "deliver: retry";
    } else {
      m.ack();
      if (r === "delivered") out.acked++;
      else out.dropped++;
    }
  } else if (queue === "mk-webhook-deliver") {
    const msg = m.body as AnyWebhookDeliverMessage;
    const r = await processWebhookDeliver(env, msg);
    out.result = r;
    // upstream job attempts: 4, test sends 1
    if (r === "retry" && (m.attempts ?? 1) < (msg.maxAttempts ?? 4)) {
      m.retry({ delaySeconds: Math.min(3600, 60 * 2 ** Math.min(5, m.attempts ?? 1)) });
      out.retried++;
      out.error = "webhook: retry";
    } else {
      m.ack();
      await releaseWebhookContent(env, msg);
      if (r === "delivered") out.acked++;
      else out.dropped++;
    }
  } else if (queue === "mk-jobs") {
    const next = await runJobStep(env, m.body as JobMessage);
    if (next) {
      if (env.Q_JOBS) await enqueueJob(env, next);
      else {
        let n: JobMessage | null = next;
        while (n) n = await runJobStep(env, n);
      }
    }
    out.result = next ? `continued:${next.kind}` : "done";
    m.ack();
    out.acked++;
  } else {
    out.result = "unknown_queue";
    m.ack();
    out.dropped++;
  }
  return out;
}

type ExecutionContext = {
  waitUntil(p: Promise<unknown>): void;
  passThroughOnException(): void;
};
