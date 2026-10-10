/**
 * A small HTML tree builder for the queries summaly makes with cheerio: the first element by tag
 * and exact attribute values, `#id`, attributes (entity-decoded) and `.text()` (descendant text,
 * entity-decoded). Script / style contents are skipped, title / textarea are RCDATA, void
 * elements never take children, and an end tag closes up to the nearest open element of its name.
 */

import { decode } from "html-entities";

export type HtmlElement = {
  name: string;
  attrs: Record<string, string>;
  children: HtmlNode[];
  parent: HtmlElement | null;
};
export type HtmlNode = HtmlElement | { text: string };

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
const RAW_TEXT = new Set(["script", "style"]);
const RCDATA = new Set(["title", "textarea"]);

function parseAttrs(src: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  for (const m of src.matchAll(re)) {
    const key = m[1]!.toLowerCase();
    if (key in attrs) continue; // the first occurrence wins, as in browsers
    attrs[key] = decode(m[2] ?? m[3] ?? m[4] ?? "");
  }
  return attrs;
}

/** Parse a document into a tree rooted at a synthetic `#root` element. */
export function parseHtml(html: string): HtmlElement {
  const root: HtmlElement = { name: "#root", attrs: {}, children: [], parent: null };
  let cur = root;
  let i = 0;
  const pushText = (t: string) => {
    if (t) cur.children.push({ text: decode(t) });
  };
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt < 0) {
      pushText(html.slice(i));
      break;
    }
    pushText(html.slice(i, lt));
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      i = end < 0 ? html.length : end + 3;
      continue;
    }
    if (html[lt + 1] === "!" || html[lt + 1] === "?") {
      const end = html.indexOf(">", lt);
      i = end < 0 ? html.length : end + 1;
      continue;
    }
    const close = /^<\/([a-zA-Z][\w:-]*)\s*>/.exec(html.slice(lt, lt + 256));
    if (close) {
      const name = close[1]!.toLowerCase();
      for (let e: HtmlElement | null = cur; e && e !== root; e = e.parent) {
        if (e.name === name) {
          cur = e.parent!;
          break;
        }
      }
      i = lt + close[0].length;
      continue;
    }
    const open = /^<([a-zA-Z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/.exec(html.slice(lt));
    if (!open) {
      pushText("<");
      i = lt + 1;
      continue;
    }
    const name = open[1]!.toLowerCase();
    const el: HtmlElement = { name, attrs: parseAttrs(open[2]!.replace(/\/\s*$/, "")), children: [], parent: cur };
    cur.children.push(el);
    i = lt + open[0].length;
    if (VOID.has(name) || /\/\s*$/.test(open[2]!)) continue;
    if (RAW_TEXT.has(name) || RCDATA.has(name)) {
      const endRe = new RegExp(`</${name}\\s*>`, "i");
      const m = endRe.exec(html.slice(i));
      const body = m ? html.slice(i, i + m.index) : html.slice(i);
      if (RCDATA.has(name)) el.children.push({ text: decode(body) });
      i = m ? i + m.index + m[0].length : html.length;
      continue;
    }
    cur = el;
  }
  return root;
}

function* walk(el: HtmlElement): Generator<HtmlElement> {
  for (const c of el.children) {
    if ("name" in c) {
      yield c;
      yield* walk(c);
    }
  }
}

/** Every element named `tag` whose attributes equal `attrs`, in document order. */
export function findAll(root: HtmlElement, tag: string | null, attrs: Record<string, string> = {}): HtmlElement[] {
  const out: HtmlElement[] = [];
  for (const el of walk(root)) {
    if (tag != null && el.name !== tag) continue;
    if (Object.entries(attrs).every(([k, v]) => el.attrs[k] === v)) out.push(el);
  }
  return out;
}

/** cheerio `$(sel).attr(name)`: the attribute of the first match. */
export function attrOf(root: HtmlElement, tag: string | null, attrs: Record<string, string>, name: string): string | undefined {
  return findAll(root, tag, attrs)[0]?.attrs[name];
}

/** Descendant text of one element. */
export function textOf(el: HtmlElement): string {
  return el.children.map((c) => ("name" in c ? textOf(c) : c.text)).join("");
}

/** cheerio `$(sel).text()`: the text of every match, concatenated. */
export function textAll(root: HtmlElement, tag: string | null, attrs: Record<string, string> = {}): string {
  return findAll(root, tag, attrs).map(textOf).join("");
}
