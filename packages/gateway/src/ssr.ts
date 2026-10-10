/**
 * Server-rendered entity pages (upstream ClientServerService `/@:user/:sub?` → views/user.tsx,
 * `/notes/:note` → views/note.tsx): per-entity title / description / og / twitter tags, robots
 * hints, ActivityPub alternates and `#misskey_clientCtx` with the packed user / note, so the
 * client starts without fetching it. The data comes from the API Worker's `ApiInternal` RPC
 * entrypoint (`API_INTERNAL`); without it, or when it answers null, the base HTML is served.
 */

import { escapeHtml, type BasePageProps } from "./html.js";

type Row = Record<string, any>;

export type SsrProfile = {
  noCrawle: boolean;
  preventAiLearning: boolean;
  fields: { name: string; value: string }[];
  url: string | null;
};

export type SsrEntity = { entity: Row; profile?: SsrProfile; visibility?: string };

/** `ApiInternal` methods the gateway calls (misskey-cf-api `worker.ts`). */
export type ApiInternalSsr = {
  ssrUser(acct: string): Promise<{ user: Row; profile: SsrProfile; federationEnabled: boolean } | null>;
  ssrNote(noteId: string): Promise<{ note: Row; profile: SsrProfile; federationEnabled: boolean } | null>;
  /** page / flash / clip / galleryPost / channel / reversiGame / announcement / embedUser / embedNote / embedClip */
  ssrEntity(kind: string, key: string, sub?: string): Promise<SsrEntity | null>;
  /** packed MetaDetailed for `#misskey_meta` (same as `POST /api/meta { detail: true }`) */
  getMeta?(): Promise<Record<string, unknown>>;
};

export type EntityKind = "page" | "flash" | "clip" | "galleryPost" | "channel" | "reversiGame" | "announcement";
export type SsrTarget =
  | { kind: "user"; acct: string; sub: string | null }
  | { kind: "note"; id: string }
  | { kind: EntityKind; key: string; sub?: string };

const ENTITY_ROUTES: [RegExp, EntityKind][] = [
  [/^\/play\/([^/]+)\/?$/, "flash"],
  [/^\/clips\/([^/]+)\/?$/, "clip"],
  [/^\/gallery\/([^/]+)\/?$/, "galleryPost"],
  [/^\/channels\/([^/]+)\/?$/, "channel"],
  [/^\/reversi\/g\/([^/]+)\/?$/, "reversiGame"],
  [/^\/announcements\/([^/]+)\/?$/, "announcement"],
];

/** Paths with an SSR page (upstream ClientServerService's SSR region; feeds are routed before). */
export function ssrTarget(pathname: string): SsrTarget | null {
  const page = /^\/@([^/]+)\/pages\/([^/]+)\/?$/.exec(pathname);
  if (page) return { kind: "page", key: decodeURIComponent(page[1]!), sub: decodeURIComponent(page[2]!) };
  const user = /^\/@([^/]+)(?:\/([^/]+))?\/?$/.exec(pathname);
  if (user) return { kind: "user", acct: decodeURIComponent(user[1]!), sub: user[2] != null ? decodeURIComponent(user[2]) : null };
  const note = /^\/notes\/([^/]+)\/?$/.exec(pathname);
  if (note) return { kind: "note", id: decodeURIComponent(note[1]!) };
  for (const [re, kind] of ENTITY_ROUTES) {
    const m = re.exec(pathname);
    if (m) return { kind, key: decodeURIComponent(m[1]!) };
  }
  return null;
}

/** Embeds with an `embedCtx` (`/embed/user-timeline/:user`, `/embed/notes/:note`, `/embed/clips/:clip`). */
export function embedTarget(pathname: string): { kind: "embedUser" | "embedNote" | "embedClip"; key: string; ctxKey: "user" | "note" | "clip" } | null {
  const m = /^\/embed\/(user-timeline|notes|clips)\/([^/]+)\/?$/.exec(pathname);
  if (!m) return null;
  const key = decodeURIComponent(m[2]!);
  if (m[1] === "user-timeline") return { kind: "embedUser", key, ctxKey: "user" };
  if (m[1] === "notes") return { kind: "embedNote", key, ctxKey: "note" };
  return { kind: "embedClip", key, ctxKey: "clip" };
}

const attr = (v: unknown) => escapeHtml(String(v));
const meta = (k: "name" | "property", key: string, content: unknown) => `<meta ${k}="${key}" content="${attr(content)}">`;

function robots(noindex: boolean, preventAiLearning: boolean): string[] {
  return [
    noindex ? `<meta name="robots" content="noindex">` : "",
    ...(preventAiLearning ? [`<meta name="robots" content="noimageai">`, `<meta name="robots" content="noai">`] : []),
  ];
}

const acctOf = (u: Row) => `@${u.username}${u.host ? `@${u.host}` : ""}`;
const displayTitle = (u: Row) => (u.name ? `${u.name} (${acctOf(u)})` : acctOf(u));
const join = (xs: string[]) => xs.filter(Boolean).join("\n\t\t");

/** views/user.tsx */
export function userPageProps(
  base: BasePageProps,
  data: { user: Row; profile: SsrProfile; federationEnabled: boolean },
  sub: string | null,
): Partial<BasePageProps> {
  const { user, profile } = data;
  const url = base.instanceUrl.replace(/\/$/, "");
  const me = profile.fields.filter((f) => f.value != null && /^https?:/.test(f.value)).map((f) => f.value);
  const og = join([
    meta("property", "og:type", "blog"),
    meta("property", "og:title", displayTitle(user)),
    user.description != null ? meta("property", "og:description", user.description) : "",
    meta("property", "og:url", `${url}/@${user.username}`),
    meta("property", "og:image", user.avatarUrl),
    meta("property", "twitter:card", "summary"),
  ]);
  const metaSlot = join([
    ...robots(user.host != null || profile.noCrawle, profile.preventAiLearning),
    meta("name", "misskey:user-username", user.username),
    meta("name", "misskey:user-id", user.id),
    ...(sub == null && data.federationEnabled
      ? [
          user.host == null ? `<link rel="alternate" type="application/activity+json" href="${attr(`${url}/users/${user.id}`)}">` : "",
          user.uri != null ? `<link rel="alternate" type="application/activity+json" href="${attr(user.uri)}">` : "",
          profile.url != null ? `<link rel="alternate" type="text/html" href="${attr(profile.url)}">` : "",
        ]
      : []),
    ...me.map((href) => `<link rel="me" href="${attr(href)}">`),
  ]);
  return {
    title: `${user.name || user.username} (@${user.username}) | ${base.instanceName ?? "Misskey"}`,
    desc: (user.description as string | null) ?? "",
    metaSlot,
    ogSlot: og,
    clientCtx: { user },
  };
}

/** misskey-js isRenotePacked */
const isRenote = (n: Row) => n.renoteId != null;

/** upstream misc/get-note-summary */
export function getNoteSummary(note: Row): string {
  if (note.deletedAt) return "(❌⛔)";
  if (note.isHidden) return "(⛔)";
  let summary = note.cw != null ? String(note.cw) : note.text ? String(note.text) : "";
  if ((note.files ?? []).length !== 0) summary += ` (📎${note.files.length})`;
  if (note.poll) summary += " (📊)";
  if (note.replyId) summary += note.reply ? `\n\nRE: ${getNoteSummary(note.reply)}` : "\n\nRE: ...";
  if (note.renoteId) summary += note.renote ? `\n\nRN: ${getNoteSummary(note.renote)}` : "\n\nRN: ...";
  return summary.trim();
}

/** views/note.tsx */
export function notePageProps(base: BasePageProps, data: { note: Row; profile: SsrProfile; federationEnabled: boolean }): Partial<BasePageProps> {
  const { note, profile } = data;
  const url = base.instanceUrl.replace(/\/$/, "");
  const title = displayTitle(note.user);
  const files = (note.files ?? []) as Row[];
  const images = files.filter((f) => String(f.type).startsWith("image/"));
  const videos = files.filter((f) => String(f.type).startsWith("video/"));
  const summary = getNoteSummary(note);
  const og = join([
    meta("property", "og:type", "article"),
    meta("property", "og:title", title),
    meta("property", "og:description", summary),
    meta("property", "og:url", `${url}/notes/${note.id}`),
    ...videos.flatMap((v) => [
      meta("property", "og:video:url", v.url),
      meta("property", "og:video:secure_url", v.url),
      meta("property", "og:video:type", v.type),
      v.thumbnailUrl ? meta("property", "og:video:image", v.thumbnailUrl) : "",
      v.properties?.width != null ? meta("property", "og:video:width", v.properties.width) : "",
      v.properties?.height != null ? meta("property", "og:video:height", v.properties.height) : "",
    ]),
    ...(images.length > 0
      ? [
          meta("property", "twitter:card", "summary_large_image"),
          ...images.flatMap((i) => [
            meta("property", "og:image", i.url),
            i.properties?.width != null ? meta("property", "og:image:width", i.properties.width) : "",
            i.properties?.height != null ? meta("property", "og:image:height", i.properties.height) : "",
          ]),
        ]
      : [meta("property", "twitter:card", "summary"), meta("property", "og:image", note.user.avatarUrl)]),
  ]);
  const metaSlot = join([
    ...robots(note.user.host != null || isRenote(note) || profile.noCrawle, profile.preventAiLearning),
    meta("name", "misskey:user-username", note.user.username),
    meta("name", "misskey:user-id", note.user.id),
    meta("name", "misskey:note-id", note.id),
    ...(data.federationEnabled
      ? [
          note.user.host == null ? `<link rel="alternate" type="application/activity+json" href="${attr(`${url}/notes/${note.id}`)}">` : "",
          note.uri != null ? `<link rel="alternate" type="application/activity+json" href="${attr(note.uri)}">` : "",
        ]
      : []),
  ]);
  return { title: `${title} | ${base.instanceName ?? "Misskey"}`, desc: summary, metaSlot, ogSlot: og, clientCtx: { note } };
}

// ---------------------------------------------------------------- other entity pages

/** The robots + misskey:user-* block the page / flash / clip / gallery views share. */
function ownerMeta(profile: SsrProfile | undefined, user: Row, idName: string, id: unknown): string {
  return join([
    ...robots(profile?.noCrawle === true, profile?.preventAiLearning === true),
    meta("name", "misskey:user-username", user.username),
    meta("name", "misskey:user-id", user.id),
    meta("name", idName, id),
  ]);
}

/** views/page.tsx, flash.tsx, clip.tsx, gallery-post.tsx, channel.tsx, reversi-game.tsx, announcement.tsx */
export function entityPageProps(base: BasePageProps, kind: EntityKind, data: SsrEntity): Partial<BasePageProps> {
  const url = base.instanceUrl.replace(/\/$/, "");
  const name = base.instanceName ?? "Misskey";
  const e = data.entity;
  switch (kind) {
    case "page": {
      const eye = e.eyeCatchingImage as Row | null;
      return {
        title: `${e.title} | ${name}`,
        desc: e.summary ?? "",
        metaSlot: ownerMeta(data.profile, e.user, "misskey:page-id", e.id),
        ogSlot: join([
          meta("property", "og:type", "article"),
          meta("property", "og:title", e.title),
          e.summary != null ? meta("property", "og:description", e.summary) : "",
          meta("property", "og:url", `${url}/pages/${e.id}`),
          ...(eye != null
            ? [meta("property", "og:image", eye.thumbnailUrl ?? eye.url), meta("property", "twitter:card", "summary_large_image")]
            : e.user.avatarUrl
              ? [meta("property", "og:image", e.user.avatarUrl), meta("property", "twitter:card", "summary")]
              : []),
        ]),
      };
    }
    case "flash":
      return {
        title: `${e.title} | ${name}`,
        desc: e.summary,
        metaSlot: ownerMeta(data.profile, e.user, "misskey:flash-id", e.id),
        ogSlot: join([
          meta("property", "og:type", "article"),
          meta("property", "og:title", e.title),
          meta("property", "og:description", e.summary),
          meta("property", "og:url", `${url}/play/${e.id}`),
          ...(e.user.avatarUrl ? [meta("property", "og:image", e.user.avatarUrl), meta("property", "twitter:card", "summary")] : []),
        ]),
      };
    case "clip":
      return {
        title: `${e.name} | ${name}`,
        desc: e.description ?? "",
        metaSlot: ownerMeta(data.profile, e.user, "misskey:clip-id", e.id),
        ogSlot: join([
          meta("property", "og:type", "article"),
          meta("property", "og:title", e.name),
          e.description != null ? meta("property", "og:description", e.description) : "",
          meta("property", "og:url", `${url}/clips/${e.id}`),
          ...(e.user.avatarUrl ? [meta("property", "og:image", e.user.avatarUrl), meta("property", "twitter:card", "summary")] : []),
        ]),
        clientCtx: { clip: e },
      };
    case "galleryPost": {
      const first = ((e.files ?? []) as Row[])[0];
      return {
        title: `${e.title} | ${name}`,
        desc: e.description ?? "",
        metaSlot: ownerMeta(data.profile, e.user, "misskey:gallery-post-id", e.id),
        ogSlot: join([
          meta("property", "og:type", "article"),
          meta("property", "og:title", e.title),
          e.description != null ? meta("property", "og:description", e.description) : "",
          meta("property", "og:url", `${url}/gallery/${e.id}`),
          ...(e.isSensitive && e.user.avatarUrl ? [meta("property", "og:image", e.user.avatarUrl), meta("property", "twitter:card", "summary")] : []),
          // upstream reads files[0] unguarded (a post without files would throw); skipped here
          ...(!e.isSensitive && first ? [meta("property", "og:image", first.thumbnailUrl ?? first.url), meta("property", "twitter:card", "summary_large_image")] : []),
        ]),
      };
    }
    case "channel":
      return {
        title: `${e.name} | ${name}`,
        desc: e.description ?? undefined,
        ogSlot: join([
          meta("property", "og:type", "website"),
          meta("property", "og:title", e.name),
          e.description != null ? meta("property", "og:description", e.description) : "",
          meta("property", "og:url", `${url}/channels/${e.id}`),
          ...(e.bannerUrl ? [meta("property", "og:image", e.bannerUrl), meta("property", "twitter:card", "summary")] : []),
        ]),
      };
    case "reversiGame": {
      const title = `${e.user1.username} vs ${e.user2.username}`;
      const description = "⚫⚪Misskey Reversi⚪⚫";
      return {
        title: `${title} | ${name}`,
        desc: description,
        ogSlot: join([
          meta("property", "og:type", "article"),
          meta("property", "og:title", title),
          meta("property", "og:description", description),
          meta("property", "og:url", `${url}/reversi/g/${e.id}`),
          meta("property", "twitter:card", "summary"),
        ]),
      };
    }
    case "announcement": {
      const text = String(e.text ?? "");
      const description = text.length > 100 ? `${text.slice(0, 100)}…` : text;
      return {
        title: `${e.title} | ${name}`,
        desc: description,
        ogSlot: join([
          meta("property", "og:type", "article"),
          meta("property", "og:title", e.title),
          meta("property", "og:description", description),
          meta("property", "og:url", `${url}/announcements/${e.id}`),
          ...(e.imageUrl ? [meta("property", "og:image", e.imageUrl), meta("property", "twitter:card", "summary_large_image")] : []),
        ]),
      };
    }
  }
}

/** Cache-Control of each upstream SSR route. */
export function entityCacheControl(kind: EntityKind, data: SsrEntity): string {
  if (kind === "page") return data.visibility === "public" ? "public, max-age=15" : "private, max-age=0, must-revalidate";
  if (kind === "reversiGame" || kind === "announcement") return "public, max-age=3600";
  return "public, max-age=15";
}
