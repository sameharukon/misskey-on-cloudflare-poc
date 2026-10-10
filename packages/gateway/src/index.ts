/**
 * Gateway Worker: web client (upstream ClientServerService), static assets,
 * /api /streaming / ActivityPub / well-known routing.
 */
import type { GatewayEnv } from "./env.js";
import { handleApi, handleStreaming, healthzResponse } from "./handlers.js";
import {
  handleEmbed,
  handleFeed,
  handleFlush,
  handleInfoCard,
  handleManifest,
  handleMedia,
  handleOpenSearch,
  handleRobots,
  handleSpa,
  handleStatic,
  handleToolPage,
  handleTwemojiBadge,
  redirectUserIdToAcct,
} from "./client.js";
import { matchRoute } from "./router.js";
import { isActivityPubRequest } from "../../ap/src/index.js";
import { withEdgeCache } from "../../shared/src/edge-cache.js";

export {
  injectMisskeyMeta,
  renderShellHtml,
  renderBaseHtml,
  renderEmbedHtml,
  extractMisskeyMeta,
  safeJsonForScript,
} from "./html.js";
export { matchRoute } from "./router.js";
export { collectViteAssetFiles } from "./client-build.js";
export type { GatewayEnv } from "./env.js";

function isApRequest(request: Request): boolean {
  return isActivityPubRequest(request.headers.get("accept"));
}

export default {
  async fetch(request: Request, env: GatewayEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const route = matchRoute(url.pathname);
    const waitUntil = ctx ? (p: Promise<unknown>) => ctx.waitUntil(p) : undefined;
    // The shell and SSR pages carry only public data (meta, the entity): one copy per colo for
    // their Cache-Control lifetime (30 s / 15 s), so a burst of visits renders once.
    const spa = () => withEdgeCache(request, waitUntil, () => handleSpa(request, env));

    switch (route.kind) {
      case "healthz":
        return healthzResponse();
      case "api":
        return handleApi(request, env);
      case "streaming":
        return handleStreaming(request, env);
      // The API Worker is the federating origin.
      case "wellknown":
      case "nodeinfo":
      case "inbox":
        return env.API.fetch(request);
      case "ap": {
        const isPage =
          (request.method === "GET" || request.method === "HEAD") &&
          !isApRequest(request) &&
          !/\/(?:outbox|inbox)\/?$/.test(route.pathname) &&
          !(request.headers.get("accept") ?? "").includes("application/json");
        if (!isPage) return env.API.fetch(request);
        const id = decodeURIComponent(route.pathname.split("/")[2] ?? "");
        const redirect = await redirectUserIdToAcct(request, env, id);
        if (redirect) return redirect;
        return spa();
      }
      case "media":
        return handleMedia(request, env);
      case "static":
        return handleStatic(request, env);
      case "manifest":
        return handleManifest(request, env);
      case "robots":
        return handleRobots(request, env);
      case "opensearch":
        return handleOpenSearch(request, env);
      case "flush":
        return handleFlush(request, env);
      case "infoCard":
        return handleInfoCard(request, env);
      case "twemojiBadge":
        return handleTwemojiBadge(request, env, route.pathname, waitUntil);
      case "urlPreview":
        // upstream UrlPreviewService needs meta (preview settings): the API Worker serves it
        return env.API.fetch(request);
      case "bios":
      case "cli":
        return handleToolPage(request, env, route.kind);
      case "embed":
        return handleEmbed(request, env);
      case "feed":
        return handleFeed(request, env);
      case "spa":
      default:
        // `/notes/:id`, `/@user` etc. with an AP Accept header → API Worker (upstream ActivityPubServerService)
        if (isApRequest(request)) return env.API.fetch(request);
        return spa();
    }
  },
};

type ExecutionContext = {
  waitUntil(p: Promise<unknown>): void;
  passThroughOnException(): void;
};
