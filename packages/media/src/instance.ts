/**
 * Which MediaContainer instance serves a request.
 *
 * - `/alts` (a large upload's alternates: sharp on big images, ffmpeg on videos) go
 *   to `media-bulk`, so they never queue ahead of the requests a page is waiting for.
 * - `/proxy` (remote avatars, emojis, previews) and `/twemoji-badge` are spread over
 *   `media-0`..`media-{PROXY_INSTANCES - 1}`: by the hash of `key` (the source URL the api sends),
 *   so one URL lands on one instance, or at random without it.
 *
 * wrangler.toml's max_instances is PROXY_INSTANCES + 1 (bulk) + 1 (rollouts).
 */
export const PROXY_INSTANCES = 3;

/** FNV-1a (32 bit) */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function instanceFor(url: URL, random: () => number = Math.random): string {
  if (url.pathname === "/alts") return "media-bulk";
  const key = url.searchParams.get("key");
  const n = key ? hash(key) % PROXY_INSTANCES : Math.floor(random() * PROXY_INSTANCES) % PROXY_INSTANCES;
  return `media-${n}`;
}
