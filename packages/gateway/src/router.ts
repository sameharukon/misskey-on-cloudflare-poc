/**
 * Pure routing decisions for the gateway Worker (unit-testable).
 * Client-side routes follow upstream ClientServerService.
 */

export type RouteKind =
  | "healthz"
  | "api"
  | "streaming"
  | "wellknown"
  | "nodeinfo"
  | "ap"
  | "inbox"
  | "media"
  | "static"
  | "manifest"
  | "robots"
  | "opensearch"
  | "flush"
  | "embed"
  | "feed"
  | "bios"
  | "cli"
  | "urlPreview"
  | "twemojiBadge"
  | "infoCard"
  | "spa";

export interface RouteMatch {
  kind: RouteKind;
  /** Path retained for handlers */
  pathname: string;
}

/** Static Assets prefixes (upstream ClientServerService fastifyStatic roots). */
export const STATIC_PREFIXES = [
  "/vite/",
  "/embed_vite/",
  "/assets/",
  "/static-assets/",
  "/client-assets/",
  "/fluent-emoji/",
  "/twemoji/",
  "/tarball/",
];
export const STATIC_EXACT = new Set([
  "/favicon.ico",
  "/apple-touch-icon.png",
  "/sw.js",
  "/embed.js",
]);

/** Paths served by the API Worker (drive files, custom emoji redirect, media proxy, identicons). */
const MEDIA_PREFIXES = ["/files/", "/emoji/", "/proxy/", "/identicon/"];

export function matchRoute(pathname: string): RouteMatch {
  if (pathname === "/healthz") return { kind: "healthz", pathname };

  if (pathname === "/api" || pathname.startsWith("/api/")) {
    return { kind: "api", pathname };
  }

  if (pathname === "/streaming" || pathname.startsWith("/streaming/")) {
    return { kind: "streaming", pathname };
  }

  if (pathname.startsWith("/.well-known/")) {
    return { kind: "wellknown", pathname };
  }

  if (pathname === "/nodeinfo" || pathname.startsWith("/nodeinfo/")) {
    return { kind: "nodeinfo", pathname };
  }

  if (pathname === "/inbox") return { kind: "inbox", pathname };

  // ActivityPub actor / outbox / inbox (W5); HTML → SPA / redirect
  if (/^\/users\/[^/]+(?:\/(?:outbox|inbox))?\/?$/.test(pathname)) {
    return { kind: "ap", pathname };
  }

  if (MEDIA_PREFIXES.some((p) => pathname.startsWith(p))) {
    return { kind: "media", pathname };
  }

  if (STATIC_EXACT.has(pathname) || STATIC_PREFIXES.some((p) => pathname.startsWith(p))) {
    return { kind: "static", pathname };
  }

  if (pathname === "/manifest.json") return { kind: "manifest", pathname };
  if (pathname === "/robots.txt") return { kind: "robots", pathname };
  if (pathname === "/opensearch.xml") return { kind: "opensearch", pathname };
  if (pathname === "/flush") return { kind: "flush", pathname };
  if (pathname === "/bios") return { kind: "bios", pathname };
  if (pathname === "/cli") return { kind: "cli", pathname };
  if (pathname === "/url") return { kind: "urlPreview", pathname };
  if (pathname === "/_info_card_") return { kind: "infoCard", pathname };
  if (pathname.startsWith("/twemoji-badge/")) return { kind: "twemojiBadge", pathname };

  if (pathname === "/embed" || pathname.startsWith("/embed/")) {
    return { kind: "embed", pathname };
  }

  // upstream `/@:user.atom` / `.rss` / `.json` feeds
  if (/^\/@[^/]+\.(?:atom|rss|json)$/.test(pathname)) {
    return { kind: "feed", pathname };
  }

  return { kind: "spa", pathname };
}

/** Cache-Control for a Static Assets path (upstream fastifyStatic maxAge values). */
export function staticCacheControl(pathname: string): string {
  if (
    (pathname.startsWith("/vite/") || pathname.startsWith("/embed_vite/")) &&
    !/^\/(?:embed_)?vite\/(?:loader\/|manifest\.json$)/.test(pathname)
  ) {
    // content-hashed file names
    return "public, max-age=2592000, immutable";
  }
  if (pathname.startsWith("/twemoji/") || pathname.startsWith("/fluent-emoji/") || pathname.startsWith("/tarball/")) {
    return "public, max-age=2592000";
  }
  if (
    pathname.startsWith("/assets/") ||
    pathname.startsWith("/static-assets/") ||
    pathname.startsWith("/client-assets/")
  ) {
    return "public, max-age=604800";
  }
  if (pathname === "/sw.js") return "public, max-age=600";
  if (pathname === "/embed.js") return "public, max-age=86400";
  return "public, max-age=3600";
}
