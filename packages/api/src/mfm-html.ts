/**
 * upstream MfmService.toHtml: MFM nodes → the HTML other software reads (feeds, ActivityPub
 * `content`). Pure string building, as upstream.
 */

import type * as mfm from "mfm-js";

/** A link target for the HTML (ActivityPub content, feeds): http(s) only, anything else throws. */
function httpUrl(s: string): URL {
  const url = new URL(s);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new TypeError(`unsupported scheme ${url.protocol}`);
  return url;
}

export type MentionedRemoteUsers = { uri: string; url?: string; username: string; host: string }[];

/** upstream misc/escape-html */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

/** `note.mentionedRemoteUsers` (a JSON string column) → the list, [] when unreadable. */
export function parseMentionedRemoteUsers(v: unknown): MentionedRemoteUsers {
  if (Array.isArray(v)) return v as MentionedRemoteUsers;
  if (typeof v !== "string") return [];
  try {
    const parsed = JSON.parse(v) as unknown;
    return Array.isArray(parsed) ? (parsed as MentionedRemoteUsers) : [];
  } catch {
    return [];
  }
}

/** MfmService.toHtml (`baseUrl` = config.url). */
export function mfmToHtml(nodes: mfm.MfmNode[] | null, baseUrl: string, mentionedRemoteUsers: MentionedRemoteUsers = [], extraHtml: string | null = null): string | null {
  if (nodes == null) return null;

  const toHtml = (children?: mfm.MfmNode[]): string => (children == null ? "" : children.map((x) => handle(x)).join(""));
  const fnDefault = (node: mfm.MfmFn) => `<i>${toHtml(node.children)}</i>`;

  const handle = (node: mfm.MfmNode): string => {
    switch (node.type) {
      case "bold":
        return `<b>${toHtml(node.children)}</b>`;
      case "small":
        return `<small>${toHtml(node.children)}</small>`;
      case "strike":
        return `<del>${toHtml(node.children)}</del>`;
      case "italic":
        return `<i>${toHtml(node.children)}</i>`;
      case "fn": {
        switch (node.props.name) {
          case "unixtime": {
            const first = node.children[0];
            const text = first?.type === "text" ? first.props.text : "";
            try {
              const date = new Date(parseInt(text, 10) * 1000);
              return `<time datetime="${escapeHtml(date.toISOString())}">${escapeHtml(date.toISOString())}</time>`;
            } catch {
              return fnDefault(node);
            }
          }
          case "ruby": {
            if (node.children.length === 1) {
              const child = node.children[0]!;
              const text = child.type === "text" ? child.props.text : "";
              return `<ruby>${escapeHtml(text.split(" ")[0]!)}<rp>(</rp><rt>${escapeHtml(text.split(" ")[1] ?? "undefined")}</rt><rp>)</rp></ruby>`;
            }
            const rt = node.children.at(-1);
            if (!rt) return fnDefault(node);
            const text = rt.type === "text" ? rt.props.text : "";
            return `<ruby>${toHtml(node.children.slice(0, node.children.length - 1))}<rp>(</rp><rt>${escapeHtml(text.trim())}</rt><rp>)</rp></ruby>`;
          }
          default:
            return fnDefault(node);
        }
      }
      case "blockCode":
        return `<pre><code>${escapeHtml(node.props.code)}</code></pre>`;
      case "center":
        return `<div style="text-align: center;">${toHtml(node.children)}</div>`;
      case "emojiCode":
        return `​:${escapeHtml(node.props.name)}:​`;
      case "unicodeEmoji":
        return node.props.emoji;
      case "hashtag":
        return `<a href="${escapeHtml(`${baseUrl}/tags/${encodeURIComponent(node.props.hashtag)}`)}" rel="tag">#${escapeHtml(node.props.hashtag)}</a>`;
      case "inlineCode":
        return `<code>${escapeHtml(node.props.code)}</code>`;
      case "mathInline":
        return `<code>${escapeHtml(node.props.formula)}</code>`;
      case "mathBlock":
        return `<pre><code>${escapeHtml(node.props.formula)}</code></pre>`;
      case "link":
        try {
          const url = httpUrl(node.props.url);
          return `<a href="${escapeHtml(url.href)}">${toHtml(node.children)}</a>`;
        } catch {
          return `[${toHtml(node.children)}](${escapeHtml(node.props.url)})`;
        }
      case "mention": {
        const { username, host, acct } = node.props;
        const remote = mentionedRemoteUsers.find((u) => u.username.toLowerCase() === username.toLowerCase() && u.host?.toLowerCase() === host?.toLowerCase());
        // upstream compares with `@${config.url}` (kept as is)
        const href = remote ? (remote.url ? remote.url : remote.uri) : `${baseUrl}/${acct.endsWith(`@${baseUrl}`) ? acct.substring(0, acct.length - baseUrl.length - 1) : acct}`;
        try {
          const url = httpUrl(href);
          return `<a href="${escapeHtml(url.href)}" class="u-url mention">${escapeHtml(acct)}</a>`;
        } catch {
          return escapeHtml(acct);
        }
      }
      case "quote":
        return `<blockquote>${toHtml(node.children)}</blockquote>`;
      case "text": {
        if (!/[\r\n]/.test(node.props.text)) return escapeHtml(node.props.text);
        return node.props.text.split(/\r\n|\r|\n/).map((x) => escapeHtml(x)).join("<br />");
      }
      case "url":
        try {
          const url = httpUrl(node.props.url);
          return `<a href="${escapeHtml(url.href)}">${escapeHtml(node.props.url)}</a>`;
        } catch {
          return escapeHtml(node.props.url);
        }
      case "search":
        return `<a href="${escapeHtml(`https://www.google.com/search?q=${encodeURIComponent(node.props.query)}`)}">${escapeHtml(node.props.content)}</a>`;
      case "plain":
        return `<span>${toHtml(node.children)}</span>`;
      default:
        return "";
    }
  };

  return `${toHtml(nodes)}${extraHtml ?? ""}`;
}
