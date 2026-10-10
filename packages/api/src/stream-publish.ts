/**
 * Publish events to a user's StreamHub DO (misskey-cf-stream) and accept
 * `/streaming` WebSocket upgrades (token auth here, socket lives in the DO).
 */

import type { ApiEnv } from "./env.js";
import { authenticatePg } from "./auth-pg.js";

export function streamHubFor(env: ApiEnv, userId: string) {
  const ns = env.STREAM_HUB;
  if (!ns) return null;
  return ns.get(ns.idFromName(`user:${userId}`));
}

/** Best-effort publish; returns delivered frame count (0 when unbound/failed). */
export async function publishToUserStream(
  env: ApiEnv,
  userId: string,
  channel: string,
  type: string,
  body: unknown,
): Promise<number> {
  const hub = streamHubFor(env, userId);
  if (!hub) return 0;
  try {
    return (await hub.publish([{ channel, type, body }])).delivered;
  } catch {
    return 0;
  }
}

/** Several events to one user's hub in one call (best-effort, as publishToUserStream). */
export async function publishEventsToUserStream(env: ApiEnv, userId: string, events: { channel: string; type: string; body: unknown }[]): Promise<number> {
  const hub = events.length ? streamHubFor(env, userId) : null;
  if (!hub) return 0;
  try {
    return (await hub.publish(events)).delivered;
  } catch {
    return 0;
  }
}

/**
 * upstream GlobalEventService.publishBroadcastStream: every online user's hub gets a top-level
 * {type, body} frame. Each presence shard publishes to its own online users (users with at least
 * one subscribed channel), so this makes one call per shard whatever the number of users.
 */
export async function broadcastStream(env: ApiEnv, type: string, body: unknown): Promise<number> {
  const ns = env.STREAM_PRESENCE;
  if (!ns || !env.STREAM_HUB) return 0;
  const n = Math.max(1, Number(env.STREAM_SHARD_COUNT) || 16);
  const counts = await Promise.all(
    Array.from({ length: n }, async (_, i) => {
      try {
        return await ns.get(ns.idFromName(`stream:${i}`)).broadcast(type, body);
      } catch {
        return 0;
      }
    }),
  );
  return counts.reduce((a, b) => a + b, 0);
}

/** GET /streaming?i=<token> (Upgrade: websocket) → user's StreamHub. */
export async function handleStreamingUpgrade(request: Request, env: ApiEnv): Promise<Response> {
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return new Response("Expected WebSocket upgrade", { status: 426 });
  }
  if (!env.STREAM_HUB) return new Response("streaming unavailable", { status: 503 });
  const url = new URL(request.url);
  const bearer = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? null;
  const token = url.searchParams.get("i") ?? bearer;
  if (!token) return new Response("credential required", { status: 401 });
  const auth = await authenticatePg(env, token);
  // upstream StreamingApiServerService: unknown token or an app without read:account → 401,
  // suspended user → 403
  if (!auth || (auth.accessTokenId && !auth.permission.includes("read:account"))) {
    return new Response(null, { status: 401, headers: { "WWW-Authenticate": 'Bearer realm="Misskey", error="invalid_token", error_description="Failed to authenticate"' } });
  }
  if (auth.user.isSuspended) return new Response(null, { status: 403 });
  const hub = streamHubFor(env, auth.user.id)!;
  const headers = new Headers(request.headers);
  headers.set("x-mk-user-id", auth.user.id);
  headers.delete("authorization");
  // upstream StreamingApiServerService: updateLastActiveDate on connect
  const touched = import("./maintenance-pg.js").then((m) => m.touchLastActiveDate(env, auth.user.id), () => {});
  // strip token from the forwarded URL
  const res = await hub.fetch(new Request("https://stream.internal/connect", { method: "GET", headers }));
  await touched;
  return res;
}
