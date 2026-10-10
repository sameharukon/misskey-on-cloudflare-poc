/**
 * ActivityPub renderers (subset of upstream ApRendererService).
 * Pure functions: callers pass URIs already resolved.
 */

export const AS_PUBLIC = "https://www.w3.org/ns/activitystreams#Public";

export const MISSKEY_CONTEXT = [
  "https://www.w3.org/ns/activitystreams",
  "https://w3id.org/security/v1",
  {
    Key: "sec:Key",
    manuallyApprovesFollowers: "as:manuallyApprovesFollowers",
    sensitive: "as:sensitive",
    Hashtag: "as:Hashtag",
    quoteUrl: "as:quoteUrl",
    toot: "http://joinmastodon.org/ns#",
    Emoji: "toot:Emoji",
    featured: "toot:featured",
    misskey: "https://misskey-hub.net/ns#",
    _misskey_content: "misskey:_misskey_content",
    _misskey_quote: "misskey:_misskey_quote",
    _misskey_reaction: "misskey:_misskey_reaction",
    _misskey_summary: "misskey:_misskey_summary",
    _misskey_votes: "misskey:_misskey_votes",
    _misskey_license: "misskey:_misskey_license",
    freeText: { "@id": "misskey:freeText", "@type": "schema:text" },
    schema: "http://schema.org#",
    isCat: "misskey:isCat",
  },
];

export function withContext<T extends Record<string, unknown>>(o: T): T & { "@context": unknown } {
  return { "@context": MISSKEY_CONTEXT, ...o };
}

export function userUri(base: string, userId: string): string {
  return `${base.replace(/\/$/, "")}/users/${userId}`;
}
export function noteUri(base: string, noteId: string): string {
  return `${base.replace(/\/$/, "")}/notes/${noteId}`;
}

/**
 * A profile field value that starts with a URL, as upstream renderPerson (tryRewriteUrl): the URL
 * part becomes `<a rel="me">` (Mastodon's link verification reads it), the rest stays as text.
 */
export function fieldValueLink(value: string): string {
  const urlSafe = /^(?:http[s]?:\/\/.)?(?:www\.)?[-a-zA-Z0-9@%._\+~#=]{2,256}\.[a-z]{2,6}\b(?:[-a-zA-Z0-9@:%_\+.~#?&\/\/=]*)/;
  try {
    const m = value.match(urlSafe);
    if (!m) return value;
    const href = new URL(m[0]).href;
    return `<a href="${href}" rel="me nofollow noopener" target="_blank">${m[0]}</a>${value.slice(m[0].length)}`;
  } catch {
    return value;
  }
}

export function renderPerson(opts: {
  base: string;
  id: string;
  username: string;
  name: string | null;
  summary: string | null;
  publicKeyPem: string;
  isLocked: boolean;
  isBot: boolean;
  isCat?: boolean;
  avatarUrl?: string | null;
  bannerUrl?: string | null;
  discoverable?: boolean;
  /** profile fields → PropertyValue attachments */
  fields?: { name: string; value: string }[];
  /** account migration (upstream renderPerson: movedTo / alsoKnownAs when set) */
  movedToUri?: string | null;
  alsoKnownAs?: string[] | null;
}): Record<string, unknown> {
  const id = userUri(opts.base, opts.id);
  const base = opts.base.replace(/\/$/, "");
  return {
    ...(opts.movedToUri ? { movedTo: opts.movedToUri } : {}),
    ...(opts.alsoKnownAs ? { alsoKnownAs: opts.alsoKnownAs } : {}),
    type: opts.isBot ? "Service" : "Person",
    id,
    inbox: `${id}/inbox`,
    outbox: `${id}/outbox`,
    followers: `${id}/followers`,
    following: `${id}/following`,
    featured: `${id}/collections/featured`,
    sharedInbox: `${base}/inbox`,
    endpoints: { sharedInbox: `${base}/inbox` },
    url: `${base}/@${opts.username}`,
    preferredUsername: opts.username,
    name: opts.name,
    summary: opts.summary,
    _misskey_summary: opts.summary,
    icon: opts.avatarUrl ? { type: "Image", url: opts.avatarUrl } : null,
    image: opts.bannerUrl ? { type: "Image", url: opts.bannerUrl } : null,
    tag: [],
    attachment: (opts.fields ?? []).map((f) => ({
      type: "PropertyValue",
      name: f.name,
      value: f.value.startsWith("http://") || f.value.startsWith("https://") ? fieldValueLink(f.value) : f.value,
    })),
    manuallyApprovesFollowers: opts.isLocked,
    discoverable: opts.discoverable ?? true,
    isCat: Boolean(opts.isCat),
    publicKey: { id: `${id}#main-key`, type: "Key", owner: id, publicKeyPem: opts.publicKeyPem },
  };
}

export type RenderNoteInput = {
  base: string;
  id: string;
  userId: string;
  text: string | null;
  cw: string | null;
  createdAt: string;
  visibility: "public" | "home" | "followers" | "specified";
  /** URI of the reply target (local or remote) */
  inReplyTo: string | null;
  /** URI of quoted note */
  quoteUri?: string | null;
  /** actor URIs of mentioned users */
  mentionUris: string[];
  /** actor URIs of visibleUserIds (specified) */
  visibleUris?: string[];
  /** attached files, rendered with renderDocument */
  attachment?: Record<string, unknown>[];
  /** note.tags (hashtags without `#`) */
  hashtags?: string[];
  /** custom emojis, rendered with renderEmoji */
  emojis?: Record<string, unknown>[];
  /** the note's poll → Question */
  poll?: { choices: string[]; votes: number[]; multiple: boolean; expiresAt: string | null } | null;
};

/** ApRendererService.renderDocument */
export function renderDocument(f: { type: string; url: string; comment: string | null; width?: number; height?: number; isSensitive: boolean }): Record<string, unknown> {
  return { type: "Document", mediaType: f.type, url: f.url, name: f.comment, width: f.width, height: f.height, sensitive: f.isSensitive };
}

/** ApRendererService.renderHashtag */
export function renderHashtag(base: string, tag: string): Record<string, unknown> {
  return { type: "Hashtag", href: `${base.replace(/\/$/, "")}/tags/${encodeURIComponent(tag)}`, name: `#${tag}` };
}

/** ApRendererService.renderEmoji */
export function renderEmoji(base: string, e: { name: string; type: string | null; url: string; updatedAt: string | null; license: string | null }): Record<string, unknown> {
  return {
    id: `${base.replace(/\/$/, "")}/emojis/${e.name}`,
    type: "Emoji",
    name: `:${e.name}:`,
    updated: e.updatedAt ?? new Date().toISOString(),
    icon: { type: "Image", mediaType: e.type ?? "image/png", url: e.url },
    _misskey_license: { freeText: e.license },
  };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Plain text → minimal HTML (upstream renders MFM → HTML); `extraHtml` is appended inside the paragraph. */
export function textToHtml(text: string | null, extraHtml: string | null = null): string | null {
  if (text == null && extraHtml == null) return null;
  return `<p>${escapeHtml(text ?? "").replace(/\r?\n/g, "<br>")}${extraHtml ?? ""}</p>`;
}

export function audienceFor(base: string, userId: string, visibility: RenderNoteInput["visibility"], mentionUris: string[], visibleUris: string[] = []): { to: string[]; cc: string[] } {
  const followers = `${userUri(base, userId)}/followers`;
  switch (visibility) {
    case "public":
      return { to: [AS_PUBLIC], cc: [followers, ...mentionUris] };
    case "home":
      return { to: [followers], cc: [AS_PUBLIC, ...mentionUris] };
    case "followers":
      return { to: [followers], cc: [...mentionUris] };
    default:
      return { to: [...new Set([...visibleUris, ...mentionUris])], cc: [] };
  }
}

export function renderNote(n: RenderNoteInput): Record<string, unknown> {
  const { to, cc } = audienceFor(n.base, n.userId, n.visibility, n.mentionUris, n.visibleUris);
  const o: Record<string, unknown> = {
    id: noteUri(n.base, n.id),
    type: "Note",
    attributedTo: userUri(n.base, n.userId),
    summary: n.cw,
    // upstream renderNote: a quote ends with `RE: <link>` in `quote-inline` (non-Misskey servers show it)
    content: textToHtml(
      n.text,
      n.quoteUri ? `<br><br><span class="quote-inline">RE: <a href="${escapeHtml(n.quoteUri)}">${escapeHtml(n.quoteUri)}</a></span>` : null,
    ),
    _misskey_content: n.text,
    source: n.text != null ? { content: n.text, mediaType: "text/x.misskeymarkdown" } : undefined,
    published: n.createdAt,
    to,
    cc,
    inReplyTo: n.inReplyTo,
    attachment: n.attachment ?? [],
    sensitive: n.cw != null || (n.attachment ?? []).some((a) => a.sensitive === true),
    tag: [
      ...(n.hashtags ?? []).map((t) => renderHashtag(n.base, t)),
      ...n.mentionUris.map((href) => ({ type: "Mention", href })),
      ...(n.emojis ?? []),
    ],
  };
  if (n.quoteUri) {
    o._misskey_quote = n.quoteUri;
    o.quoteUrl = n.quoteUri;
  }
  if (n.poll) {
    // asPoll: closed once expired, endTime otherwise; per-choice counts as replies.totalItems
    const p = n.poll;
    o.type = "Question";
    o[p.expiresAt && Date.parse(p.expiresAt) < Date.now() ? "closed" : "endTime"] = p.expiresAt;
    o[p.multiple ? "anyOf" : "oneOf"] = p.choices.map((name, i) => ({ type: "Note", name, replies: { type: "Collection", totalItems: p.votes[i] ?? 0 } }));
  }
  return o;
}

export function renderCreate(note: Record<string, unknown>, activityId: string): Record<string, unknown> {
  return {
    id: activityId,
    actor: note.attributedTo,
    type: "Create",
    published: note.published,
    object: note,
    to: note.to,
    cc: note.cc,
  };
}

export function renderDelete(objectUri: string, actorUri: string): Record<string, unknown> {
  return {
    type: "Delete",
    actor: actorUri,
    object: { id: objectUri, type: "Tombstone" },
    published: new Date().toISOString(),
  };
}

export function renderAnnounce(objectUri: string, opts: { base: string; noteId: string; userId: string; createdAt: string; visibility: RenderNoteInput["visibility"] }): Record<string, unknown> {
  const { to, cc } = audienceFor(opts.base, opts.userId, opts.visibility, []);
  return {
    id: `${noteUri(opts.base, opts.noteId)}/activity`,
    actor: userUri(opts.base, opts.userId),
    type: "Announce",
    published: opts.createdAt,
    to,
    cc,
    object: objectUri,
  };
}

export function renderFollow(opts: { id: string; actor: string; object: string }): Record<string, unknown> {
  return { id: opts.id, type: "Follow", actor: opts.actor, object: opts.object };
}

export function renderAccept(object: unknown, actorUri: string): Record<string, unknown> {
  return { type: "Accept", actor: actorUri, object };
}

export function renderReject(object: unknown, actorUri: string): Record<string, unknown> {
  return { type: "Reject", actor: actorUri, object };
}

export function renderUndo(object: Record<string, unknown>, actorUri: string): Record<string, unknown> {
  const id = typeof object.id === "string" ? `${object.id}/undo` : undefined;
  return { type: "Undo", ...(id ? { id } : {}), actor: actorUri, object, published: new Date().toISOString() };
}

/** Like with Misskey reaction extension (upstream renderLike). */
export function renderLike(opts: { id: string; actor: string; noteUri: string; reaction: string }): Record<string, unknown> {
  return {
    type: "Like",
    id: opts.id,
    actor: opts.actor,
    object: opts.noteUri,
    content: opts.reaction,
    _misskey_reaction: opts.reaction,
  };
}

export function renderBlock(opts: { id: string; actor: string; object: string }): Record<string, unknown> {
  return { type: "Block", id: opts.id, actor: opts.actor, object: opts.object };
}

/** upstream ApRendererService.renderMove: `{url}/moves/{srcId}/{dstId}`. */
export function renderMove(opts: { base: string; srcId: string; dstId: string; actor: string; target: string }): Record<string, unknown> {
  return { id: `${opts.base.replace(/\/$/, "")}/moves/${opts.srcId}/${opts.dstId}`, actor: opts.actor, type: "Move", object: opts.actor, target: opts.target };
}
