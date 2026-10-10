/**
 * Port of @misskey-dev/summaly 5.5.1 (what upstream's UrlPreviewService uses) for Workers: `fetch`
 * instead of got, the small HTML tree in html.ts instead of cheerio, chardet + TextDecoder for the
 * page encoding, html-entities to decode as summaly does. The general summarizer, the oEmbed
 * player and the amazon / bluesky / wikipedia / branch.io plugins follow summaly.
 *
 * summaly rejects responses from non-unicast IPs after the connection; a Worker cannot see the
 * peer address (and cannot reach private networks), so hosts that are IP literals in private
 * ranges, `localhost` and `.local` / `.internal` names are refused before fetching instead.
 */

import { fetchChecked, UnsafeUrlError } from "../safe-fetch.js";
import { decode } from "html-entities";
import { detect } from "chardet";
import { attrOf, findAll, parseHtml, textAll, textOf, type HtmlElement } from "./html.js";

export const SUMMALY_VERSION = "5.5.1";
const DEFAULT_BOT_UA = `SummalyBot/${SUMMALY_VERSION} (+https://github.com/misskey-dev/summaly/blob/master/README.md)`;

export type SummalyResult = {
  title: string | null;
  icon: string | null;
  description: string | null;
  thumbnail: string | null;
  thumbnailStyle?: "summary_large_image" | "summary" | null;
  player: { url: string | null; width: number | null; height: number | null; allow: string[] };
  sitename: string | null;
  sensitive?: boolean;
  activityPub: string | null;
  fediverseCreator: string | null;
  url: string;
};

export type SummalyOptions = {
  lang?: string | null;
  followRedirects?: boolean;
  userAgent?: string;
  responseTimeout?: number;
  operationTimeout?: number;
  contentLengthLimit?: number;
  contentLengthRequired?: boolean;
  fetch?: typeof fetch;
};

export class StatusError extends Error {
  constructor(message: string, public statusCode: number) {
    super(message);
    this.name = "StatusError";
  }
}

// ---------------------------------------------------------------- utils

const nullOrEmpty = (v: string | null | undefined) => v == null || v.trim() === "";

function clip(s: string, max: number): string {
  if (nullOrEmpty(s)) return s;
  s = s.trim();
  return s.length > max ? `${s.substr(0, max)}...` : s;
}

const escapeRegExp = (s: string) => s.replace(/[-[\]/{}()*+?.\\^$|]/g, "\\$&");

function cleanupTitle(title: string, siteName: string | null): string {
  title = title.trim();
  if (siteName) {
    const m = new RegExp(`^(.+?)\\s?[\\-\\|:・]\\s?${escapeRegExp(siteName.trim())}$`).exec(title);
    if (m?.[1]) return m[1];
  }
  return title;
}

function toUtf8(body: Uint8Array): string {
  let encoding = "utf-8";
  const detected = detect(body);
  if (detected != null) encoding = detected.toLowerCase();
  else {
    const m = /charset\s*=\s*["']?([\w-]+)/i.exec(new TextDecoder("utf-8").decode(body));
    if (m?.[1]) encoding = m[1].toLowerCase();
  }
  try {
    return new TextDecoder(encoding === "utf-8" ? "utf-8" : encoding, { fatal: encoding !== "utf-8" }).decode(body);
  } catch {
    return new TextDecoder("utf-8").decode(body);
  }
}

/** The pre-fetch stand-in for summaly's non-unicast IP rejection (see the module comment). */
export { isPrivateHost } from "../safe-fetch.js";

type Fetched = { status: number; url: string; headers: Headers; body: Uint8Array };

type GetArgs = {
  url: string;
  method: "GET" | "HEAD";
  headers: Record<string, string | undefined>;
  typeFilter?: RegExp;
  followRedirects?: boolean;
  responseTimeout?: number;
  operationTimeout?: number;
  contentLengthLimit?: number;
  contentLengthRequired?: boolean;
  fetch?: typeof fetch;
};

/** summaly getResponse / receiveResponse over fetch (4xx / 5xx throw StatusError, as got's HTTPError). */
async function getResponse(args: GetArgs): Promise<Fetched> {
  const target = new URL(args.url);
  if (target.protocol !== "http:" && target.protocol !== "https:") throw new Error(`unsupported protocol ${target.protocol}`);
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(args.headers)) if (v != null) headers[k] = v;
  // every redirect hop is checked too
  const { res, url: finalUrl } = await fetchChecked(args.fetch ?? fetch, args.url, {
    method: args.method,
    headers,
    signal: AbortSignal.timeout(args.operationTimeout ?? 60_000),
  }, { maxRedirects: args.followRedirects === false ? 0 : 10 }).catch((e) => {
    throw e instanceof UnsafeUrlError ? new StatusError(`Private IP rejected ${e.url}`, 400) : e;
  });
  if (res.status >= 400) throw new StatusError(`${res.status} ${res.statusText}`, res.status);
  const contentType = res.headers.get("content-type");
  if (args.typeFilter && !contentType?.match(args.typeFilter)) throw new Error(`Rejected by type filter ${contentType}`);
  const maxSize = args.contentLengthLimit ?? 10485760;
  const contentLength = res.headers.get("content-length");
  if (contentLength) {
    const size = Number(contentLength);
    if (size > maxSize) throw new Error(`maxSize exceeded (${size} > ${maxSize}) on response`);
  } else if (args.contentLengthRequired) {
    throw new Error("content-length required");
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (res.body && args.method !== "HEAD") {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxSize) {
        await reader.cancel();
        throw new Error(`maxSize exceeded (${total} > ${maxSize}) on response`);
      }
      chunks.push(value);
    }
  }
  const body = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    body.set(c, off);
    off += c.byteLength;
  }
  return { status: res.status, url: finalUrl, headers: res.headers, body };
}

type ScrapeOpts = Omit<SummalyOptions, "lang"> & { lang?: string };

function gotOptions(url: string, opts: ScrapeOpts): Omit<GetArgs, "method"> {
  return {
    url,
    headers: { accept: "text/html,application/xhtml+xml", "user-agent": opts.userAgent ?? DEFAULT_BOT_UA, "accept-language": opts.lang ?? undefined },
    typeFilter: /^(text\/html|application\/xhtml\+xml)/,
    followRedirects: opts.followRedirects,
    responseTimeout: opts.responseTimeout,
    operationTimeout: opts.operationTimeout,
    contentLengthLimit: opts.contentLengthLimit,
    contentLengthRequired: opts.contentLengthRequired,
    fetch: opts.fetch,
  };
}

type Scraped = { body: string; $: HtmlElement; response: Fetched };

async function scraping(url: string, opts: ScrapeOpts): Promise<Scraped> {
  const response = await getResponse({ ...gotOptions(url, opts), method: "GET" });
  const body = toUtf8(response.body);
  return { body, $: parseHtml(body), response };
}

const get = async (url: string, f?: typeof fetch) =>
  new TextDecoder().decode((await getResponse({ url, method: "GET", headers: { accept: "*/*" }, fetch: f })).body);
const head = (url: string, f?: typeof fetch) => getResponse({ url, method: "HEAD", headers: { accept: "*/*" }, fetch: f });

// shorthand for `$('meta[name="x"]').attr('content')` / `$('meta[property="x"]').attr('content')`
const metaName = ($: HtmlElement, name: string) => attrOf($, "meta", { name }, "content");
const metaProp = ($: HtmlElement, property: string) => attrOf($, "meta", { property }, "content");

// ---------------------------------------------------------------- general

/** summaly getOEmbedPlayer: a single safe https iframe from the page's JSON oEmbed. */
async function getOEmbedPlayer($: HtmlElement, pageUrl: string, f?: typeof fetch): Promise<SummalyResult["player"] | null> {
  const href = attrOf($, "link", { type: "application/json+oembed" }, "href");
  if (!href) return null;
  let oEmbedUrl: URL;
  try {
    oEmbedUrl = new URL(href, pageUrl);
  } catch {
    return null;
  }
  const oEmbed = await get(oEmbedUrl.href, f).catch(() => null);
  if (!oEmbed) return null;
  let body: any;
  try {
    body = JSON.parse(oEmbed);
  } catch {
    return null;
  }
  if (!body || body.version !== "1.0" || !["rich", "video"].includes(body.type)) return null;
  if (typeof body.html !== "string" || !body.html.startsWith("<iframe ") || !body.html.endsWith("</iframe>")) return null;
  const frag = parseHtml(body.html);
  const iframes = findAll(frag, "iframe");
  // cheerio wraps a fragment in html / body: the iframe must be their direct child
  if (iframes.length !== 1 || iframes[0]!.parent !== frag) return null;
  const iframe = iframes[0]!;
  const url = iframe.attrs.src;
  if (!url) return null;
  try {
    if (new URL(url).protocol !== "https:") return null;
  } catch {
    return null;
  }
  let width: number | null = Number(iframe.attrs.width ?? body.width);
  if (Number.isNaN(width)) width = null;
  const height = Math.min(Number(iframe.attrs.height ?? body.height), 1024);
  if (Number.isNaN(height)) return null;
  const safeList = ["autoplay", "clipboard-write", "fullscreen", "encrypted-media", "picture-in-picture", "web-share"];
  const ignoredList = ["gyroscope", "accelerometer"];
  const allow = (iframe.attrs.allow ?? "").split(/\s*;\s*/g).filter((s) => s).filter((s) => !ignoredList.includes(s));
  if (iframe.attrs.allowfullscreen === "") allow.push("fullscreen");
  if (allow.some((a) => !safeList.includes(a))) return null;
  return { url, width, height, allow };
}

function headerEqualValueContains(search: string, headerValue: string | null): boolean {
  if (!headerValue) return false;
  return headerValue.toLowerCase() === search.toLowerCase();
}

async function parseGeneral(url: URL, res: Scraped, f?: typeof fetch): Promise<Omit<SummalyResult, "url"> | null> {
  const $ = res.$;
  const twitterCard = metaName($, "twitter:card") || metaProp($, "twitter:card");
  let title: string | null | undefined = metaProp($, "og:title") || metaName($, "twitter:title") || metaProp($, "twitter:title") || textAll($, "title");
  if (title === undefined || title === null) return null;
  title = clip(decode(title), 100);
  let image: string | null | undefined =
    metaProp($, "og:image") || metaName($, "twitter:image") || metaProp($, "twitter:image") ||
    attrOf($, "link", { rel: "image_src" }, "href") || attrOf($, "link", { rel: "apple-touch-icon" }, "href") || attrOf($, "link", { rel: "apple-touch-icon image_src" }, "href");
  image = image ? new URL(image, url.href).href : null;
  const thumbnailStyle = twitterCard === "summary_large_image" ? "summary_large_image" : twitterCard === "summary" ? "summary" : null;
  const playerUrl =
    (twitterCard !== "summary_large_image" && metaName($, "twitter:player")) ||
    (twitterCard !== "summary_large_image" && metaProp($, "twitter:player")) ||
    metaProp($, "og:video") || metaProp($, "og:video:secure_url") || metaProp($, "og:video:url");
  const playerWidth = parseInt(metaName($, "twitter:player:width") || metaProp($, "twitter:player:width") || metaProp($, "og:video:width") || "");
  const playerHeight = parseInt(metaName($, "twitter:player:height") || metaProp($, "twitter:player:height") || metaProp($, "og:video:height") || "");
  let description: string | null | undefined = metaProp($, "og:description") || metaName($, "twitter:description") || metaProp($, "twitter:description") || metaName($, "description");
  description = description ? clip(decode(description), 300) : null;
  if (title === description) description = null;
  const siteName = decode(metaProp($, "og:site_name") || metaName($, "application-name") || url.host);
  const favicon = attrOf($, "link", { rel: "shortcut icon" }, "href") || attrOf($, "link", { rel: "icon" }, "href") || "/favicon.ico";
  const activityPub = attrOf($, "link", { rel: "alternate", type: "application/activity+json" }, "href") || null;
  const fediverseCreator = metaName($, "fediverse:creator") || null;
  const rating = metaName($, "rating");
  const sensitive =
    metaProp($, "mixi:content-rating") === "1" ||
    headerEqualValueContains("adult", res.response.headers.get("rating")) ||
    headerEqualValueContains("RTA-5042-1996-1400-1577-RTA", res.response.headers.get("rating")) ||
    rating === "adult" ||
    rating?.toUpperCase() === "RTA-5042-1996-1400-1577-RTA";
  const find = async (path: string) => {
    try {
      const target = new URL(path, url.href);
      await head(target.href, f);
      return target;
    } catch {
      return null;
    }
  };
  const [icon, oEmbed] = await Promise.all([find(favicon), getOEmbedPlayer($, url.href, f)]);
  title = cleanupTitle(title, siteName);
  if (title === "") title = siteName;
  return {
    title: title || null,
    icon: icon?.href || null,
    description: description || null,
    thumbnail: image || null,
    thumbnailStyle,
    player: oEmbed ?? {
      url: playerUrl || null,
      width: Number.isNaN(playerWidth) ? null : playerWidth,
      height: Number.isNaN(playerHeight) ? null : playerHeight,
      allow: ["autoplay", "encrypted-media", "fullscreen"],
    },
    sitename: siteName || null,
    sensitive,
    activityPub,
    fediverseCreator,
  };
}

async function general(url: URL, opts: SummalyOptions): Promise<Omit<SummalyResult, "url"> | null> {
  let lang = opts.lang;
  if (lang && !/^[\w-]+(\s*,\s*[\w-]+)*$/.test(lang)) lang = null;
  return parseGeneral(url, await scraping(url.href, { ...opts, lang: lang || undefined }), opts.fetch);
}

// ---------------------------------------------------------------- plugins

type Plugin = { test(url: URL): boolean; summarize(url: URL, opts: SummalyOptions): Promise<Omit<SummalyResult, "url"> | null> };

const AMAZON_HOSTS = ["www.amazon.com", "www.amazon.co.jp", "www.amazon.ca", "www.amazon.com.br", "www.amazon.com.mx", "www.amazon.co.uk", "www.amazon.de", "www.amazon.fr", "www.amazon.it", "www.amazon.es", "www.amazon.nl", "www.amazon.cn", "www.amazon.in", "www.amazon.au"];

const byId = ($: HtmlElement, id: string) => findAll($, null, { id })[0];

const amazon: Plugin = {
  test: (url) => AMAZON_HOSTS.includes(url.hostname),
  async summarize(url, opts) {
    const { $ } = await scraping(url.href, { fetch: opts.fetch });
    const titleEl = byId($, "title");
    const title = titleEl ? textOf(titleEl) : "";
    const descEl = byId($, "productDescription");
    const description = (descEl ? textOf(descEl) : "") || metaName($, "description");
    const thumbnail = byId($, "landingImage")?.attrs.src;
    const playerUrl = metaProp($, "twitter:player") || metaName($, "twitter:player");
    const playerWidth = metaProp($, "twitter:player:width") || metaName($, "twitter:player:width");
    const playerHeight = metaProp($, "twitter:player:height") || metaName($, "twitter:player:height");
    return {
      title: title ? title.trim() : null,
      icon: "https://www.amazon.com/favicon.ico",
      description: description ? description.trim() : null,
      thumbnail: thumbnail ? thumbnail.trim() : null,
      player: {
        url: playerUrl || null,
        width: playerWidth ? parseInt(playerWidth) : null,
        height: playerHeight ? parseInt(playerHeight) : null,
        allow: playerUrl ? ["fullscreen", "encrypted-media"] : [],
      },
      sitename: "Amazon",
      activityPub: null,
      fediverseCreator: null,
    };
  },
};

const bluesky: Plugin = {
  test: (url) => url.hostname === "bsky.app",
  async summarize(url, opts) {
    // summaly reads the body as is here (no encoding detection)
    const res = await getResponse({ ...gotOptions(url.href, { ...opts, lang: opts.lang ?? undefined }), method: "GET" });
    const body = new TextDecoder().decode(res.body);
    return parseGeneral(url, { body, $: parseHtml(body), response: res }, opts.fetch);
  },
};

const wikipedia: Plugin = {
  test: (url) => Boolean(url.hostname) && /\.wikipedia\.org$/.test(url.hostname),
  async summarize(url, opts) {
    const lang = url.host ? url.host.split(".")[0] : null;
    const body = JSON.parse(await get(`https://${lang}.wikipedia.org/w/api.php?format=json&action=query&prop=extracts&exintro=&explaintext=&titles=${url.pathname ? url.pathname.split("/")[2] : null}`, opts.fetch)) as any;
    if (!("query" in body) || !("pages" in body.query)) throw new Error("fetch failed");
    const info = body.query.pages[Object.keys(body.query.pages)[0]!];
    return {
      title: info.title,
      icon: "https://wikipedia.org/static/favicon/wikipedia.ico",
      description: clip(info.extract, 300),
      thumbnail: `https://wikipedia.org/static/images/project-logos/${lang}wiki.png`,
      player: { url: null, width: null, height: null, allow: [] },
      sitename: "Wikipedia",
      activityPub: null,
      fediverseCreator: null,
    };
  },
};

const branchio: Plugin = {
  test: (url) => /^[a-zA-Z0-9]+\.app\.link$/.test(url.hostname) || url.hostname === "spotify.link",
  async summarize(url, opts) {
    url.searchParams.append("$web_only", "true");
    return general(url, opts);
  },
};

const PLUGINS = [amazon, bluesky, wikipedia, branchio];

// ---------------------------------------------------------------- summaly

/** summaly(url, options) with summalyDefaultOptions (followRedirects true). */
export async function summaly(url: string, options: SummalyOptions = {}): Promise<SummalyResult> {
  const opts: SummalyOptions = { lang: null, followRedirects: true, ...options };
  let actualUrl = url;
  if (opts.followRedirects) {
    try {
      actualUrl = (
        await getResponse({
          url,
          method: "HEAD",
          headers: { accept: "text/html,application/xhtml+xml", "user-agent": opts.userAgent ?? DEFAULT_BOT_UA, "accept-language": opts.lang ?? undefined },
          operationTimeout: opts.operationTimeout,
          contentLengthLimit: Number.MAX_SAFE_INTEGER,
          fetch: opts.fetch,
        })
      ).url;
    } catch {
      actualUrl = url;
    }
  }
  const target = new URL(actualUrl);
  const match = PLUGINS.find((p) => p.test(target));
  const summary = await (match ? match.summarize(target, opts) : general(target, opts));
  if (summary == null) throw new Error("failed summarize");
  return Object.assign(summary, { url: actualUrl });
}
