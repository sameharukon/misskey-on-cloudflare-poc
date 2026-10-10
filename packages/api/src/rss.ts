/**
 * Small RSS 2.0 / RSS 1.0 (RDF) / Atom parser producing the subset of rss-parser's output that
 * upstream `fetch-rss` returns (title, link, description, image, feedUrl, paginationLinks, items
 * with title / link / guid / pubDate / isoDate / creator / author / content / contentSnippet /
 * summary / categories / enclosure). rss-parser (xml2js) does not run in Workers.
 */

type XmlNode = { name: string; attrs: Record<string, string>; children: XmlNode[]; text: string };

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (m, e: string) => {
    if (e[0] === "#") {
      const cp = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    }
    return ENTITIES[e] ?? m;
  });
}

/** Lenient XML → tree (no namespaces resolution: prefixed names are kept as `prefix:name`). */
export function parseXml(src: string): XmlNode {
  const root: XmlNode = { name: "#root", attrs: {}, children: [], text: "" };
  const stack = [root];
  let i = 0;
  const top = () => stack[stack.length - 1]!;
  while (i < src.length) {
    const lt = src.indexOf("<", i);
    if (lt < 0) {
      top().text += decodeEntities(src.slice(i));
      break;
    }
    if (lt > i) top().text += decodeEntities(src.slice(i, lt));
    if (src.startsWith("<!--", lt)) {
      const e = src.indexOf("-->", lt + 4);
      i = e < 0 ? src.length : e + 3;
    } else if (src.startsWith("<![CDATA[", lt)) {
      const e = src.indexOf("]]>", lt + 9);
      top().text += src.slice(lt + 9, e < 0 ? src.length : e);
      i = e < 0 ? src.length : e + 3;
    } else if (src.startsWith("<?", lt)) {
      const e = src.indexOf("?>", lt + 2);
      i = e < 0 ? src.length : e + 2;
    } else if (src.startsWith("<!", lt)) {
      // DOCTYPE (internal subsets with nested '>' are not supported)
      const e = src.indexOf(">", lt + 2);
      i = e < 0 ? src.length : e + 1;
    } else if (src[lt + 1] === "/") {
      const e = src.indexOf(">", lt + 2);
      const name = src.slice(lt + 2, e < 0 ? src.length : e).trim();
      // pop to the matching element (tolerates unclosed children)
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k]!.name === name) {
          stack.length = k;
          break;
        }
      }
      i = e < 0 ? src.length : e + 1;
    } else {
      // start tag: find the closing '>' outside attribute quotes
      let j = lt + 1;
      let q: string | null = null;
      for (; j < src.length; j++) {
        const ch = src[j]!;
        if (q) {
          if (ch === q) q = null;
        } else if (ch === '"' || ch === "'") q = ch;
        else if (ch === ">") break;
      }
      let inner = src.slice(lt + 1, j);
      const selfClose = inner.endsWith("/");
      if (selfClose) inner = inner.slice(0, -1);
      const m = /^([^\s/>]+)/.exec(inner);
      if (!m) {
        i = j + 1;
        continue;
      }
      const node: XmlNode = { name: m[1]!, attrs: {}, children: [], text: "" };
      for (const a of inner.slice(m[1]!.length).matchAll(/([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) {
        node.attrs[a[1]!] = decodeEntities(a[3] ?? a[4] ?? "");
      }
      top().children.push(node);
      if (!selfClose) stack.push(node);
      i = j + 1;
    }
  }
  return root;
}

const kids = (n: XmlNode | undefined, name: string) => (n ? n.children.filter((c) => c.name === name) : []);
const kid = (n: XmlNode | undefined, ...names: string[]) => {
  for (const name of names) {
    const c = n?.children.find((x) => x.name === name);
    if (c) return c;
  }
  return undefined;
};
const text = (n: XmlNode | undefined): string | undefined => {
  if (!n) return undefined;
  const t = (n.text + n.children.map((c) => (c.children.length ? "" : c.text)).join("")).trim();
  return t;
};
const val = (n: XmlNode | undefined, ...names: string[]) => text(kid(n, ...names));

/** rss-parser's contentSnippet: tags stripped, entities decoded, trimmed. */
function snippet(html: string | undefined): string | undefined {
  if (html == null) return undefined;
  return decodeEntities(html.replace(/<[^>]*>/g, "")).trim();
}

function isoDate(s: string | undefined): string | undefined {
  if (!s) return undefined;
  const t = Date.parse(s);
  return Number.isNaN(t) ? undefined : new Date(t).toISOString();
}

/** Inner markup of an element (Atom `type="xhtml"` / html content kept as text). */
function markup(n: XmlNode | undefined): string | undefined {
  if (!n) return undefined;
  const ser = (x: XmlNode): string =>
    `<${x.name}${Object.entries(x.attrs).map(([k, v]) => ` ${k}="${v.replace(/"/g, "&quot;")}"`).join("")}>${x.text}${x.children.map(ser).join("")}</${x.name}>`;
  return (n.text + n.children.map(ser).join("")).trim();
}

function prune<T extends Record<string, unknown>>(o: T): T {
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
  return o;
}

export function parseFeed(xml: string): Record<string, unknown> {
  const doc = parseXml(xml);
  const rss = kid(doc, "rss");
  const rdf = kid(doc, "rdf:RDF");
  const atom = kid(doc, "feed");
  if (rss || rdf) {
    const ch = rss ? kid(rss, "channel") : kid(rdf, "channel");
    const itemParent = rss ? ch : rdf;
    const img = kid(ch, "image") ?? kid(rdf, "image");
    const links = kids(ch, "atom:link");
    const pag: Record<string, string> = {};
    for (const l of links) if (l.attrs.rel && l.attrs.href) pag[l.attrs.rel] = l.attrs.href;
    const items = kids(itemParent, "item").map((it) => {
      const content = val(it, "description");
      const encl = kid(it, "enclosure");
      const creator = val(it, "dc:creator");
      return prune({
        creator,
        title: val(it, "title"),
        link: val(it, "link"),
        pubDate: val(it, "pubDate", "dc:date"),
        author: val(it, "author"),
        "content:encoded": val(it, "content:encoded"),
        "dc:creator": creator,
        content,
        contentSnippet: snippet(content),
        guid: val(it, "guid"),
        categories: kids(it, "category").length ? kids(it, "category").map((c) => text(c) ?? "") : undefined,
        isoDate: isoDate(val(it, "pubDate", "dc:date")),
        enclosure: encl ? prune({ url: encl.attrs.url, length: encl.attrs.length ? Number(encl.attrs.length) : undefined, type: encl.attrs.type }) : undefined,
      });
    });
    return prune({
      items,
      feedUrl: links.find((l) => l.attrs.rel === "self")?.attrs.href,
      image: img ? prune({ link: val(img, "link"), url: val(img, "url") ?? img.attrs["rdf:resource"], title: val(img, "title") }) : undefined,
      paginationLinks: Object.keys(pag).length ? pag : undefined,
      title: val(ch, "title"),
      description: val(ch, "description"),
      generator: val(ch, "generator"),
      link: val(ch, "link"),
      language: val(ch, "language", "dc:language"),
      lastBuildDate: val(ch, "lastBuildDate"),
    });
  }
  if (atom) {
    const linkOf = (n: XmlNode | undefined) => {
      const ls = kids(n, "link");
      return (ls.find((l) => !l.attrs.rel || l.attrs.rel === "alternate") ?? ls[0])?.attrs.href;
    };
    const pag: Record<string, string> = {};
    for (const l of kids(atom, "link")) if (l.attrs.rel && l.attrs.rel !== "alternate" && l.attrs.href) pag[l.attrs.rel] = l.attrs.href;
    const items = kids(atom, "entry").map((e) => {
      const contentNode = kid(e, "content");
      const content = contentNode?.children.length ? markup(contentNode) : text(contentNode);
      const summary = val(e, "summary");
      const author = val(kid(e, "author"), "name");
      return prune({
        title: val(e, "title"),
        link: linkOf(e),
        pubDate: val(e, "published", "updated"),
        author,
        content,
        contentSnippet: snippet(content ?? summary),
        summary,
        id: val(e, "id"),
        categories: kids(e, "category").length ? kids(e, "category").map((c) => c.attrs.term ?? text(c) ?? "") : undefined,
        isoDate: isoDate(val(e, "published", "updated")),
      });
    });
    const icon = val(atom, "logo", "icon");
    return prune({
      items,
      feedUrl: kids(atom, "link").find((l) => l.attrs.rel === "self")?.attrs.href,
      image: icon ? { url: icon } : undefined,
      paginationLinks: Object.keys(pag).length ? pag : undefined,
      title: val(atom, "title"),
      description: val(atom, "subtitle"),
      generator: val(atom, "generator"),
      link: linkOf(atom),
      lastBuildDate: val(atom, "updated"),
    });
  }
  throw new Error("Feed not recognized as RSS 1 or 2.");
}
