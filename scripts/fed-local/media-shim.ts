/**
 * Local stand-in for misskey-cf-media in the fed-local environments: forwards every request to
 * the media container server (packages/media-container) running on the host, instead of the
 * Cloudflare Container that the real Worker starts (`MEDIA_URL`, default http://127.0.0.1:8090).
 */
interface Env {
  MEDIA_URL?: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/healthz-worker") return Response.json({ ok: true, service: "media-shim" });
    const target = `${(env.MEDIA_URL ?? "http://127.0.0.1:8090").replace(/\/$/, "")}${url.pathname}${url.search}`;
    return fetch(target, { method: request.method, headers: request.headers, body: request.body });
  },
};
