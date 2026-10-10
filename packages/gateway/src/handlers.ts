import type { GatewayEnv } from "./env.js";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

export function healthzResponse(): Response {
  return Response.json({ ok: true, service: "gateway" });
}

/** `/api/*` → API Worker (service binding). */
export async function handleApi(request: Request, env: GatewayEnv): Promise<Response> {
  return env.API.fetch(request);
}

/**
 * `/streaming` — WebSocket upgrades go to the API Worker, which authenticates and hands the socket
 * to the user's StreamHub DO. The stream Worker's own `fetch` does not accept upgrades, so the
 * gateway never forwards there.
 */
export async function handleStreaming(request: Request, env: GatewayEnv): Promise<Response> {
  const upgrade = request.headers.get("Upgrade")?.toLowerCase();
  if (upgrade === "websocket") return env.API.fetch(request);

  return new Response(
    JSON.stringify({
      error: "streaming_placeholder",
      message:
          "Connect with Upgrade: websocket. The API Worker authenticates /streaming and hands the socket to StreamHub.",
      protocol: ["main", "homeTimeline"],
      docs: "packages/stream/README.md",
    }),
    { status: 426, headers: { ...JSON_HEADERS, Connection: "Upgrade", Upgrade: "websocket" } },
  );
}
