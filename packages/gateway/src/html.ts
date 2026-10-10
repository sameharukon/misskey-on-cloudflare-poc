/**
 * HTML shell — port of upstream server-side rendering for the web client.
 * @see upstream packages/backend/src/server/web/views/base.tsx (BasePage)
 * @see upstream packages/backend/src/server/web/views/base-embed.tsx (BaseEmbed)
 * @see upstream packages/backend/src/server/web/views/_splash.tsx, flush.tsx
 * @see upstream packages/backend/src/server/web/ClientServerService.ts (manifest / robots / opensearch)
 * @see upstream packages/frontend/src/instance.ts (reads #misskey_meta)
 */
import type { ClientBundle } from "./client-build.js";
import { DEFAULT_LANGS } from "./client-build.js";

/** upstream views/_.ts */
export const DEFAULT_DESCRIPTION = "✨🌎✨ A interplanetary communication platform ✨🚀✨";
const DEFAULT_THEME_COLOR = "#86b300";

const COMMENT = `<!--
  _____ _         _
 |     |_|___ ___| |_ ___ _ _
 | | | | |_ -|_ -| '_| -_| | |
 |_|_|_|_|___|___|_,_|___|_  |
                         |___|
 Thank you for using Misskey!
 If you are reading this message... how about joining the development?
 https://github.com/misskey-dev/misskey
 (served by misskey-cf gateway)
-->`;

/**
 * JSON safe inside `<script>` (upstream misc/json-stringify-html-safe.ts:
 * escapes `<`, `>`, `&`, U+2028, U+2029).
 */
export function safeJsonForScript(value: unknown): string {
  return JSON.stringify(value ?? null)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(new RegExp("\\u2028", "g"), "\\u2028")
    .replace(new RegExp("\\u2029", "g"), "\\u2029");
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** `</style>` cannot appear inside an inline style element. */
function safeInlineCss(css: string): string {
  return css.replace(/<\/style/gi, "<\\/style");
}

/** `</script>` cannot appear inside an inline classic script. */
function safeInlineJs(js: string): string {
  return js.replace(/<\/script/gi, "<\\/script");
}

/**
 * Build or patch an HTML document so it contains:
 * `<script type="application/json" id="misskey_meta" data-generated-at="...">...</script>`
 */
export function injectMisskeyMeta(
  html: string,
  meta: unknown,
  generatedAt: number = Date.now(),
): string {
  const json = safeJsonForScript(meta);
  const tag = `<script type="application/json" id="misskey_meta" data-generated-at="${generatedAt}">${json}</script>`;
  if (/id=["']misskey_meta["']/.test(html)) {
    return html.replace(
      /<script\b[^>]*\bid=["']misskey_meta["'][^>]*>[\s\S]*?<\/script>/i,
      () => tag,
    );
  }
  if (/<\/head>/i.test(html)) {
    return html.replace(/<\/head>/i, () => `  ${tag}\n  </head>`);
  }
  return `${tag}\n${html}`;
}

/** Parse `#misskey_meta` out of HTML (for tests). */
export function extractMisskeyMeta(html: string): { meta: unknown; generatedAt: number | null } | null {
  const m = html.match(/<script\b[^>]*\bid=["']misskey_meta["'][^>]*>([\s\S]*?)<\/script>/i);
  if (!m) return null;
  const tag = m[0];
  const at = tag.match(/data-generated-at=["'](\d+)["']/i);
  return {
    meta: JSON.parse(m[1]!),
    generatedAt: at ? Number(at[1]) : null,
  };
}

export interface BasePageProps {
  /** upstream config.version (root package.json version of the built client) */
  version: string;
  /** i18n `languages` → `LANGS` */
  langs?: string[];
  /** config.url */
  instanceUrl: string;
  instanceName?: string | null;
  icon?: string | null;
  appleTouchIcon?: string | null;
  themeColor?: string | null;
  serverErrorImageUrl?: string | null;
  infoImageUrl?: string | null;
  notFoundImageUrl?: string | null;
  title?: string | null;
  desc?: string | null;
  img?: string | null;
  noindex?: boolean;
  /** MetaDetailed for `#misskey_meta`; omitted when undefined */
  meta?: unknown;
  /** `data-generated-at` (0 = "stale", lets the client refetch `meta`) */
  metaGeneratedAt?: number;
  /** Built client (vite files + boot loader). null = no frontend mounted. */
  client: ClientBundle | null;
  /** upstream Layout `metaSlot`: extra head tags (already escaped HTML) */
  metaSlot?: string;
  /** upstream Layout `ogSlot`: replaces the default og / twitter tags (already escaped HTML) */
  ogSlot?: string;
  /** `#misskey_clientCtx` (upstream clientCtxJson); omitted when undefined */
  clientCtx?: unknown;
}

function splash(icon: string | null | undefined): string {
  return `<div id="splash">
		<img id="splashIcon" src="${escapeHtml(icon || "/static-assets/splash.png")}">
		<div id="splashSpinner">
			<svg class="spinner bg" viewBox="0 0 152 152" xmlns="http://www.w3.org/2000/svg">
				<g transform="matrix(1,0,0,1,12,12)">
					<circle cx="64" cy="64" r="64" style="fill:none;stroke:currentColor;stroke-width:24px;"/>
				</g>
			</svg>
			<svg class="spinner fg" viewBox="0 0 152 152" xmlns="http://www.w3.org/2000/svg">
				<g transform="matrix(1,0,0,1,12,12)">
					<path d="M128,64C128,28.654 99.346,0 64,0C99.346,0 128,28.654 128,64Z" style="fill:none;stroke:currentColor;stroke-width:24px;"/>
				</g>
			</svg>
		</div>
	</div>`;
}

const NOT_MOUNTED_NOTICE = `<div id="misskey_app"><p style="font-family:system-ui;padding:2rem">misskey-cf gateway — frontend assets not mounted yet. Run <code>pnpm build-frontend</code> (see README.md).</p></div>`;

function bootSection(
  props: BasePageProps,
  base: "/vite/" | "/embed_vite/",
  extraJson: string,
): string {
  const client = props.client;
  const now = props.metaGeneratedAt ?? Date.now();
  const entry = client?.viteFiles?.entryJs ?? null;
  const css = (client?.viteFiles?.css ?? [])
    .map((href) => `<link rel="stylesheet" href="${escapeHtml(base + href)}">`)
    .join("\n\t\t");
  const bootCss = client
    ? client.bootCss != null
      ? `<style>${safeInlineCss(client.bootCss)}</style>`
      : `<link rel="stylesheet" href="${base}loader/style.css">`
    : "";
  const consts = `<script>
			const VERSION = ${safeJsonForScript(props.version)};
			const CLIENT_ENTRY = ${safeJsonForScript(entry)};
			const LANGS = ${safeJsonForScript(props.langs ?? DEFAULT_LANGS)};
		</script>`;
  const meta =
    props.meta !== undefined
      ? `<script type="application/json" id="misskey_meta" data-generated-at="${now}">${safeJsonForScript(props.meta)}</script>`
      : "";
  const bootJs = client
    ? client.bootJs != null
      ? `<script>${safeInlineJs(client.bootJs)}</script>`
      : `<script src="${base}loader/boot.js"></script>`
    : "";
  return [css, bootCss, consts, meta, extraJson, bootJs].filter(Boolean).join("\n\t\t");
}

function commonHead(props: BasePageProps): string {
  const theme = props.themeColor || DEFAULT_THEME_COLOR;
  return `<meta charset="UTF-8">
		<meta name="application-name" content="Misskey">
		<meta name="referer" content="origin">
		<meta name="theme-color" content="${escapeHtml(theme)}">
		<meta name="theme-color-orig" content="${escapeHtml(theme)}">
		<meta property="og:site_name" content="${escapeHtml(props.instanceName || "Misskey")}">
		<meta property="instance_url" content="${escapeHtml(props.instanceUrl)}">
		<meta name="viewport" content="width=device-width, initial-scale=1, minimum-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">
		<meta name="format-detection" content="telephone=no,date=no,address=no,email=no,url=no">
		<link rel="icon" href="${escapeHtml(props.icon || "/favicon.ico")}">
		<link rel="apple-touch-icon" href="${escapeHtml(props.appleTouchIcon || "/apple-touch-icon.png")}">`;
}

const NOSCRIPT = `<noscript>
		<p>
			JavaScriptを有効にしてください<br>
			Please turn on your JavaScript
		</p>
	</noscript>`;

/** Port of upstream views/base.tsx (BasePage). */
export function renderBaseHtml(props: BasePageProps): string {
  const title = props.title || "Misskey";
  const desc = props.desc;
  const prefetch = [props.serverErrorImageUrl, props.infoImageUrl, props.notFoundImageUrl]
    .filter((u): u is string => typeof u === "string" && u.length > 0)
    .map((u) => `<link rel="prefetch" as="image" href="${escapeHtml(u)}">`)
    .join("\n\t\t");
  const head = [
    commonHead(props),
    `<link rel="manifest" href="/manifest.json">`,
    `<link rel="search" type="application/opensearchdescription+xml" title="${escapeHtml(title)}" href="${escapeHtml(props.instanceUrl.replace(/\/$/, ""))}/opensearch.xml">`,
    prefetch,
    `<title>${escapeHtml(title)}</title>`,
    props.noindex ? `<meta name="robots" content="noindex">` : "",
    desc != null ? `<meta name="description" content="${escapeHtml(desc || DEFAULT_DESCRIPTION)}">` : "",
    props.metaSlot ?? "",
    props.ogSlot ??
      [
        `<meta property="og:title" content="${escapeHtml(title)}">`,
        `<meta property="og:description" content="${escapeHtml(desc || DEFAULT_DESCRIPTION)}">`,
        props.img ? `<meta property="og:image" content="${escapeHtml(props.img)}">` : "",
        `<meta property="twitter:card" content="summary">`,
      ]
        .filter(Boolean)
        .join("\n\t\t"),
    bootSection(
      props,
      "/vite/",
      props.clientCtx !== undefined
        ? `<script type="application/json" id="misskey_clientCtx" data-generated-at="${props.metaGeneratedAt ?? Date.now()}">${safeJsonForScript(props.clientCtx)}</script>`
        : "",
    ),
  ]
    .filter(Boolean)
    .join("\n\t\t");

  return `<!DOCTYPE html>
${COMMENT}
<html>
	<head>
		${head}
	</head>
	<body>
	${NOSCRIPT}
	${splash(props.icon)}
	${props.client ? "" : NOT_MOUNTED_NOTICE}
	</body>
</html>`;
}

/** Port of upstream views/base-embed.tsx (BaseEmbed). `embedCtx` is optional (the embed client fetches itself). */
export function renderEmbedHtml(props: BasePageProps & { embedCtx?: unknown }): string {
  const title = props.title || "Misskey";
  const embedCtx =
    props.embedCtx !== undefined
      ? `<script type="application/json" id="misskey_embedCtx" data-generated-at="${props.metaGeneratedAt ?? Date.now()}">${safeJsonForScript(props.embedCtx)}</script>`
      : "";
  const head = [
    commonHead(props),
    `<title>${escapeHtml(title)}</title>`,
    `<meta name="robots" content="noindex">`,
    bootSection(props, "/embed_vite/", embedCtx),
  ].join("\n\t\t");
  return `<!DOCTYPE html>
${COMMENT}
<html>
	<head>
		${head}
	</head>
	<body>
	${NOSCRIPT}
	${splash(props.icon)}
	${props.client ? "" : NOT_MOUNTED_NOTICE}
	</body>
</html>`;
}

/** Port of upstream views/flush.tsx. */
export function renderFlushHtml(): string {
  return `<!DOCTYPE html>
<html>
	<head>
		<meta charset="UTF-8">
		<meta name="application-name" content="Misskey">
		<title>Clear preferences and cache</title>
	</head>
	<body>
		<div id="msg"></div>
		<script src="/static-assets/misc/flush.js"></script>
	</body>
</html>`;
}

/** Port of upstream views/info-card.tsx (`description` unescaped, as upstream's `safeDescription`). */
export function renderInfoCardHtml(o: { url: string; name: string | null; description: string | null; bannerUrl: string | null }): string {
  const title = escapeHtml(o.name ?? o.url);
  const style = o.bannerUrl != null ? ` style="${escapeHtml(`background-image: url(${o.bannerUrl});`)}"` : ` style=""`;
  return `<!DOCTYPE html>
${COMMENT}
<html>
	<head>
		<meta charset="UTF-8">
		<meta name="application-name" content="Misskey">
		<meta name="viewport" content="width=device-width, initial-scale=1.0">
		<title>${title}</title>
		<link rel="stylesheet" href="/static-assets/misc/info-card.css">
	</head>
	<body>
		<a id="a" href="${escapeHtml(o.url)}" target="_blank" rel="noopener noreferrer">
			<header id="banner"${style}>
				<div id="title">${title}</div>
			</header>
		</a>
		<div id="content">
			<div id="description">${o.description ?? ""}</div>
		</div>
	</body>
</html>`;
}

/** Port of upstream views/bios.tsx (the repair tool; `version` is escaped as `<h1 safe>`). */
export function renderBiosHtml(version: string): string {
  return `<!DOCTYPE html>
<html>
	<head>
		<meta charset="UTF-8">
		<meta name="application-name" content="Misskey">
		<title>Misskey Repair Tool</title>
		<link rel="stylesheet" href="/static-assets/misc/bios.css">
	</head>
	<body>
		<header>
			<h1>Misskey Repair Tool ${escapeHtml(version)}</h1>
		</header>
		<main>
			<div class="tabs">
				<button id="ls">edit local storage</button>
			</div>
			<div id="content"></div>
		</main>
		<script src="/static-assets/misc/bios.js"></script>
	</body>
</html>`;
}

/** Port of upstream views/cli.tsx. */
export function renderCliHtml(version: string): string {
  return `<!DOCTYPE html>
<html>
	<head>
		<meta charset="UTF-8">
		<meta name="application-name" content="Misskey">
		<title>Misskey CLI Tool</title>
		<link rel="stylesheet" href="/static-assets/misc/cli.css">
	</head>
	<body>
		<header>
			<h1>Misskey CLI ${escapeHtml(version)}</h1>
		</header>
		<main>
			<div id="form">
				<textarea id="text"></textarea>
				<button id="submit">Submit</button>
			</div>
			<div id="tl"></div>
		</main>
		<script src="/static-assets/misc/cli.js"></script>
	</body>
</html>`;
}

export interface ShellOptions {
  title?: string;
  themeColor?: string;
  instanceName?: string;
  instanceUrl?: string;
  iconHref?: string;
  /** Serialized MetaDetailed (or MetaLite) object */
  meta: unknown;
  /** epoch ms for data-generated-at */
  generatedAt?: number;
  /** Client entry (vite manifest entry file) when a frontend build is mounted */
  clientEntry?: string | null;
  version?: string;
}

/** Minimal shell (kept for callers/tests); see renderBaseHtml for the full port. */
export function renderShellHtml(opts: ShellOptions): string {
  return renderBaseHtml({
    version: opts.version ?? "0.0.0",
    instanceUrl: opts.instanceUrl ?? "",
    instanceName: opts.instanceName,
    title: opts.title ?? opts.instanceName,
    themeColor: opts.themeColor,
    icon: opts.iconHref,
    meta: opts.meta,
    metaGeneratedAt: opts.generatedAt ?? Date.now(),
    client: opts.clientEntry
      ? { viteFiles: { entryJs: opts.clientEntry, css: [], modulePreloads: [] }, bootJs: null, bootCss: null }
      : null,
  });
}

type MetaLike = Record<string, unknown>;

function str(meta: MetaLike, key: string): string | null {
  const v = meta[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** Port of upstream ClientServerService.manifestHandler. */
export function buildWebManifest(meta: MetaLike, host: string): Record<string, unknown> {
  let manifest: Record<string, unknown> = {
    short_name: str(meta, "shortName") ?? str(meta, "name") ?? host,
    name: str(meta, "name") ?? host,
    start_url: "/",
    display: "standalone",
    background_color: "#313a42",
    theme_color: str(meta, "themeColor") ?? DEFAULT_THEME_COLOR,
    icons: [
      {
        src: str(meta, "app192IconUrl") ?? "/static-assets/icons/192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "maskable",
      },
      {
        src: str(meta, "app512IconUrl") ?? "/static-assets/icons/512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
      {
        src: "/static-assets/splash.png",
        sizes: "300x300",
        type: "image/png",
        purpose: "any",
      },
    ],
    share_target: {
      action: "/share/",
      method: "GET",
      enctype: "application/x-www-form-urlencoded",
      params: { title: "title", text: "text", url: "url" },
    },
    shortcuts: [{ name: "Safemode", url: "/?safemode=true" }],
  };
  const override = str(meta, "manifestJsonOverride");
  if (override) {
    try {
      const parsed = JSON.parse(override) as unknown;
      if (parsed && typeof parsed === "object") manifest = { ...manifest, ...(parsed as MetaLike) };
    } catch {
      /* upstream would throw; ignore a broken override */
    }
  }
  return manifest;
}

/** Port of upstream `/robots.txt`. */
export function renderRobotsTxt(meta: MetaLike): string {
  const disallowed = [
    "/settings",
    "/admin",
    "/custom-emojis-manager",
    "/avatar-decorations",
    "/share",
    "/my",
    "/api",
    "/inbox",
    "/oauth",
    "/proxy",
    "/url",
  ];
  if (meta.ugcVisibilityForVisitor === "none") disallowed.push("/@", "/notes");
  return (
    "User-agent: *\n" +
    disallowed.map((p) => `Disallow: ${p}`).join("\n") +
    "\n" +
    "Allow: /\n" +
    "\n# todo: sitemap\n"
  );
}

/** Port of upstream `/opensearch.xml` (values escaped, unlike upstream). */
export function renderOpenSearchXml(meta: MetaLike, instanceUrl: string): string {
  const name = escapeHtml(str(meta, "name") ?? "Misskey");
  const url = escapeHtml(instanceUrl.replace(/\/$/, ""));
  return (
    '<OpenSearchDescription xmlns="http://a9.com/-/spec/opensearch/1.1/" xmlns:moz="http://www.mozilla.org/2006/browser/search/">' +
    `<ShortName>${name}</ShortName>` +
    `<Description>${name} Search</Description>` +
    "<InputEncoding>UTF-8</InputEncoding>" +
    `<Image width="16" height="16" type="image/x-icon">${url}/favicon.ico</Image>` +
    `<Url type="text/html" template="${url}/search?q={searchTerms}"/>` +
    "</OpenSearchDescription>"
  );
}
