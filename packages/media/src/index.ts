/**
 * misskey-cf-media: fronts the media Container (sharp + ffmpeg, see
 * packages/media-container). Not on workers.dev; the API worker reaches it via
 * the `MEDIA` service binding:  POST /alts?type=<mime>&web=0|1  (raw bytes), and the
 * gateway for  POST /twemoji-badge  (SVG bytes → PNG).
 */
import { Container, getContainer } from "@cloudflare/containers";
import { instanceFor } from "./instance.js";

export class MediaContainer extends Container {
  defaultPort = 8080;
  sleepAfter = "5m";
  enableInternet = false;
}

interface Env {
  MEDIA_CONTAINER: DurableObjectNamespace<MediaContainer>;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/healthz-worker") return Response.json({ ok: true, service: "media" });
    return getContainer(env.MEDIA_CONTAINER, instanceFor(url)).fetch(request);
  },
};
