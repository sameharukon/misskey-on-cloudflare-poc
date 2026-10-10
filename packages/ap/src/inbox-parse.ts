/**
 * Inbound activity normalization (subset of upstream ApInboxService / type.ts).
 */

import { AS_PUBLIC } from "./renderer.js";

export type ApObject = Record<string, unknown>;

export function getApId(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (v && typeof v === "object" && typeof (v as ApObject).id === "string") return (v as ApObject).id as string;
  return null;
}

export function getApType(v: unknown): string | null {
  if (v && typeof v === "object") {
    const t = (v as ApObject).type;
    if (typeof t === "string") return t;
    if (Array.isArray(t) && typeof t[0] === "string") return t[0];
  }
  return null;
}

export function toArray(v: unknown): unknown[] {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

export function idList(v: unknown): string[] {
  return toArray(v).map(getApId).filter((x): x is string => Boolean(x));
}

const PUBLIC_IDS = new Set([AS_PUBLIC, "as:Public", "Public"]);

/** upstream ApAudienceService.parseAudience visibility rule (simplified). */
export function parseVisibility(
  obj: ApObject,
  actorFollowersUri: string | null,
): "public" | "home" | "followers" | "specified" {
  const to = idList(obj.to);
  const cc = idList(obj.cc);
  if (to.some((x) => PUBLIC_IDS.has(x))) return "public";
  if (cc.some((x) => PUBLIC_IDS.has(x))) return "home";
  if (actorFollowersUri && [...to, ...cc].includes(actorFollowersUri)) return "followers";
  if ([...to, ...cc].some((x) => /\/followers\/?$/.test(x))) return "followers";
  return "specified";
}

/** Very small HTML → text (upstream uses MfmService.fromHtml). */
export function htmlToText(html: string | null | undefined): string | null {
  if (html == null) return null;
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>\s*<p[^>]*>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();
}

/** Note text: `_misskey_content` > source(misskeymarkdown) > HTML content. */
export function noteText(obj: ApObject): string | null {
  if (typeof obj._misskey_content === "string") return obj._misskey_content;
  const src = obj.source as ApObject | undefined;
  if (src && typeof src.content === "string" && typeof src.mediaType === "string" && src.mediaType.startsWith("text/x.misskeymarkdown")) {
    return src.content;
  }
  return htmlToText(typeof obj.content === "string" ? obj.content : null);
}

export function isPost(obj: unknown): boolean {
  const t = getApType(obj);
  return t === "Note" || t === "Question" || t === "Article" || t === "Page";
}

export function isActor(obj: unknown): boolean {
  const t = getApType(obj);
  return t === "Person" || t === "Service" || t === "Organization" || t === "Group" || t === "Application";
}

/** Reaction from Like: `_misskey_reaction` > content > default. */
export function likeReaction(obj: ApObject, remoteHost: string): string {
  let r = typeof obj._misskey_reaction === "string" ? obj._misskey_reaction : typeof obj.content === "string" ? obj.content : "";
  r = r.trim();
  if (!r) return "❤";
  // remote custom emoji :name: → :name@host:
  const m = /^:([\w+-]+)(?:@[\w.-]+)?:$/.exec(r);
  if (m) return `:${m[1]}@${remoteHost}:`;
  return r;
}

export type InboxActivity = {
  id: string | null;
  type: string;
  actor: string;
  object: unknown;
  raw: ApObject;
};

/** Validate the top-level activity shape. */
export function parseActivity(json: unknown): InboxActivity | null {
  if (!json || typeof json !== "object") return null;
  const o = json as ApObject;
  const type = getApType(o);
  const actor = getApId(o.actor);
  if (!type || !actor) return null;
  return { id: getApId(o), type, actor, object: o.object, raw: o };
}

/** Same-origin check: URIs must share host with the actor. */
export function sameHost(a: string, b: string): boolean {
  try {
    return new URL(a).host.toLowerCase() === new URL(b).host.toLowerCase();
  } catch {
    return false;
  }
}

/** SSRF guard for outbound fetches/delivery targets. */
export function isSafeRemoteUrl(u: string): boolean {
  let url: URL;
  try {
    url = new URL(u);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  const h = url.hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return false;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) return false; // IPv4 literal
  if (h.includes(":") || h.startsWith("[")) return false; // IPv6 literal
  return true;
}
