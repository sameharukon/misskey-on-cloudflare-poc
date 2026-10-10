/**
 * Federated instance rows (`instance`): upstream FederatedInstanceService.fetchOrRegister,
 * the instance stats kept by ApPersonService / NoteCreateService / UserFollowingService /
 * InboxProcessorService, and FetchInstanceMetadataService (nodeinfo + manifest + HTML).
 *
 * Every hook is best-effort (never breaks the caller) and honours
 * meta.enableStatsForFederatedInstances like upstream.
 */

import { fetchChecked, readCappedText, REMOTE_FETCH_TIMEOUT_MS } from "../safe-fetch.js";
import { genAidx } from "../../../id/src/index.js";
import { isSafeRemoteUrl } from "../../../ap/src/index.js";
import type { ApiEnv } from "../env.js";
import { withHyperdriveClient, type PgQueryable } from "../pg.js";
import { metaRowPg } from "../user-lite-pg.js";

type Row = Record<string, unknown>;

/** UtilityService.toPuny: lower-case + IDNA (via URL). */
export function toPuny(host: string): string {
  const h = host.trim().toLowerCase();
  try {
    return new URL(`https://${h}`).host || h;
  } catch {
    return h;
  }
}

const INSTANCE_COLS = `id, "firstRetrievedAt", host, "usersCount", "notesCount", "followingCount", "followersCount",
  "latestRequestReceivedAt", "isNotResponding", "suspensionState", "softwareName", "softwareVersion", "openRegistrations",
  name, description, "maintainerName", "maintainerEmail", "iconUrl", "faviconUrl", "themeColor", "infoUpdatedAt", "moderationNote"`;

export async function findInstanceC(c: PgQueryable, host: string): Promise<Row | null> {
  return (await c.query(`SELECT ${INSTANCE_COLS} FROM instance WHERE host = $1`, [toPuny(host)])).rows[0] ?? null;
}

export async function fetchOrRegisterInstanceC(c: PgQueryable, host: string): Promise<Row> {
  const h = toPuny(host);
  const hit = await findInstanceC(c, h);
  if (hit) return hit;
  await c.query(`INSERT INTO instance (id, host, "firstRetrievedAt") VALUES ($1, $2, now()) ON CONFLICT (host) DO NOTHING`, [genAidx(Date.now()), h]);
  return (await findInstanceC(c, h))!;
}

async function statsEnabled(c: PgQueryable): Promise<boolean> {
  return (await metaRowPg(c)).enableStatsForFederatedInstances !== false;
}

export type InstanceCounter = "usersCount" | "notesCount" | "followingCount" | "followersCount";

/** fetchOrRegister(host) + increment / decrement a counter (when stats are enabled). */
export async function bumpInstanceC(c: PgQueryable, host: string | null | undefined, col: InstanceCounter, delta: number): Promise<void> {
  if (!host) return;
  try {
    if (!(await statsEnabled(c))) return;
    const i = await fetchOrRegisterInstanceC(c, host);
    await c.query(`UPDATE instance SET "${col}" = GREATEST("${col}" + $2, 0) WHERE id = $1`, [i.id, delta]);
  } catch (e) {
    console.warn("instance stats failed", e instanceof Error ? e.message : String(e));
  }
}

export async function bumpInstance(env: ApiEnv, host: string | null | undefined, col: InstanceCounter, delta: number): Promise<void> {
  if (!host || !env.HYPERDRIVE?.connectionString) return;
  await withHyperdriveClient(env.HYPERDRIVE, (c) => bumpInstanceC(c, host, col, delta));
}

/** Following row inserted / deleted: UserFollowingService instance stats. */
export async function followingInstanceStatsC(c: PgQueryable, followerHost: unknown, followeeHost: unknown, delta: 1 | -1): Promise<void> {
  if (followerHost && !followeeHost) await bumpInstanceC(c, String(followerHost), "followingCount", delta);
  else if (!followerHost && followeeHost) await bumpInstanceC(c, String(followeeHost), "followersCount", delta);
}

const REQUEST_SEEN_INTERVAL_MS = 60_000;
const requestSeenAt = new Map<string, number>();

/** Tests: forget which hosts were seen. */
export function resetInstanceRequestCache(): void {
  requestSeenAt.clear();
}

/**
 * InboxProcessorService: a verified activity from `host` → latestRequestReceivedAt,
 * un-suspend autoSuspendedForNotResponding, then refresh metadata when older than a day.
 */
export async function instanceRequestReceived(env: ApiEnv, host: string): Promise<void> {
  if (!env.HYPERDRIVE?.connectionString) return;
  // at most once a minute per host in this isolate: the update locked the same row for every
  // activity a busy server sent
  const key = toPuny(host);
  const last = requestSeenAt.get(key);
  if (last && Date.now() - last < REQUEST_SEEN_INTERVAL_MS) return;
  requestSeenAt.delete(key);
  if (requestSeenAt.size >= 10_000) requestSeenAt.delete(requestSeenAt.keys().next().value!);
  requestSeenAt.set(key, Date.now());
  try {
    const i = await withHyperdriveClient(env.HYPERDRIVE, async (c) => {
      const row = (await statsEnabled(c)) ? await fetchOrRegisterInstanceC(c, host) : await findInstanceC(c, host);
      if (!row) return null;
      await c.query(
        `UPDATE instance SET "latestRequestReceivedAt" = now(), "isNotResponding" = FALSE, "notRespondingSince" = NULL,
           "suspensionState" = CASE WHEN "suspensionState" = 'autoSuspendedForNotResponding' THEN 'none' ELSE "suspensionState" END
         WHERE id = $1`,
        [row.id],
      );
      return row;
    });
    if (i) await fetchInstanceMetadata(env, i, false);
  } catch (e) {
    console.warn("instance update failed", e instanceof Error ? e.message : String(e));
  }
}

// ---------------------------------------------------------------- FetchInstanceMetadataService

const MAX_BYTES = 1024 * 1024;

async function getText(env: ApiEnv, url: string, accept: string): Promise<string> {
  if (!isSafeRemoteUrl(url)) throw new Error("unsafe url");
  const { res } = await fetchChecked(env.AP_FETCH ?? fetch, url, { headers: { Accept: accept, "User-Agent": "misskey-cf" }, signal: AbortSignal.timeout(REMOTE_FETCH_TIMEOUT_MS) }, { check: (u) => isSafeRemoteUrl(u.href) });
  if (!res.ok) throw new Error(`GET ${res.status}`);
  return readCappedText(res, MAX_BYTES);
}

const getJson = async (env: ApiEnv, url: string) => JSON.parse(await getText(env, url, "application/json, */*")) as Record<string, any>;

type NodeInfo = Record<string, any>;

async function fetchNodeinfo(env: ApiEnv, host: string): Promise<NodeInfo> {
  const wellknown = await getJson(env, `https://${host}/.well-known/nodeinfo`);
  if (wellknown.links == null || !Array.isArray(wellknown.links)) throw new Error("No wellknown links");
  const links = wellknown.links as { rel: string; href: string }[];
  const find = (v: string) => links.find((l) => l.rel === `http://nodeinfo.diaspora.software/ns/schema/${v}`);
  const link = find("2.1") ?? find("2.0") ?? find("1.0");
  if (link == null) throw new Error("No nodeinfo link provided");
  return getJson(env, link.href);
}

/** Tiny HTML reader (upstream uses node-html-parser): <link> / <meta> attributes only. */
type Tag = Record<string, string>;
function parseTags(html: string, name: "link" | "meta"): Tag[] {
  const out: Tag[] = [];
  const re = new RegExp(`<${name}\\b([^>]*)>`, "gi");
  for (const m of html.matchAll(re)) {
    const attrs: Tag = {};
    for (const a of m[1]!.matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
      attrs[a[1]!.toLowerCase()] = (a[2] ?? a[3] ?? a[4] ?? "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
    }
    out.push(attrs);
  }
  return out;
}

type Dom = { links: Tag[]; metas: Tag[] };
const metaContent = (dom: Dom | null, key: "name" | "property", value: string) => dom?.metas.find((m) => m[key] === value)?.content ?? null;

async function fetchFaviconUrl(env: ApiEnv, host: string, dom: Dom | null): Promise<string | null> {
  const url = `https://${host}`;
  if (dom) {
    const href = [...dom.links].reverse().find((l) => l.rel === "icon")?.href;
    if (href) return new URL(href, url).href;
  }
  const faviconUrl = `${url}/favicon.ico`;
  const { res } = await fetchChecked(env.AP_FETCH ?? fetch, faviconUrl, { method: "HEAD", headers: { "User-Agent": "misskey-cf" }, signal: AbortSignal.timeout(REMOTE_FETCH_TIMEOUT_MS) }, { check: (u) => isSafeRemoteUrl(u.href) });
  return res.ok ? faviconUrl : null;
}

function iconUrlOf(host: string, dom: Dom | null, manifest: Record<string, any> | null): string | null {
  const url = `https://${host}`;
  if (manifest && Array.isArray(manifest.icons) && manifest.icons.length > 0 && manifest.icons[0].src) return new URL(manifest.icons[0].src, url).href;
  if (dom) {
    const links = [...dom.links].reverse();
    const has = (l: Tag, r: string) => (l.rel ?? "").split(/\s+/).includes(r);
    const href = [
      links.find((l) => has(l, "apple-touch-icon-precomposed"))?.href,
      links.find((l) => has(l, "apple-touch-icon"))?.href,
      links.find((l) => has(l, "icon"))?.href,
    ].find((h) => h);
    if (href) return new URL(href, url).href;
  }
  return null;
}

/** tinycolor(…).isValid() → toHexString(), for the hex / rgb() forms instances use. */
export function normalizeColor(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim().toLowerCase();
  let m = /^#?([0-9a-f]{3,4})$/.exec(s);
  if (m) return "#" + m[1]!.slice(0, 3).split("").map((x) => x + x).join("");
  m = /^#?([0-9a-f]{6})(?:[0-9a-f]{2})?$/.exec(s);
  if (m) return "#" + m[1]!;
  m = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*[\d.]+\s*)?\)$/.exec(s);
  if (m) return "#" + [m[1], m[2], m[3]].map((x) => Math.min(255, Number(x)).toString(16).padStart(2, "0")).join("");
  return null;
}

/**
 * FetchInstanceMetadataService.fetchInstanceMetadata. Without `force`, skips when the info
 * is younger than a day (upstream also takes a 30 s Redis lock; here the day check alone).
 */
export async function fetchInstanceMetadata(env: ApiEnv, instance: Row, force: boolean): Promise<void> {
  const host = String(instance.host);
  try {
    if (!force && instance.infoUpdatedAt && Date.now() - new Date(String(instance.infoUpdatedAt)).getTime() < 86400_000) return;
    // one refresh at a time (upstream holds a 30 s lock): claim it by moving infoUpdatedAt, which
    // the refresh sets anyway, so concurrent inbox / deliver jobs for the host skip it
    if (!force && env.HYPERDRIVE?.connectionString) {
      const claimed = await withHyperdriveClient(env.HYPERDRIVE, async (c) =>
        (await c.query(
          `UPDATE instance SET "infoUpdatedAt" = now() WHERE id = $1 AND ("infoUpdatedAt" IS NULL OR "infoUpdatedAt" < now() - interval '1 day') RETURNING id`,
          [instance.id],
        )).rows.length > 0,
      );
      if (!claimed) return;
    }
    const [info, dom, manifest] = await Promise.all([
      fetchNodeinfo(env, host).catch(() => null),
      getText(env, `https://${host}`, "text/html, */*")
        .then((html) => ({ links: parseTags(html, "link"), metas: parseTags(html, "meta") }) as Dom)
        .catch(() => null),
      getJson(env, `https://${host}/manifest.json`).catch(() => null),
    ]);
    const favicon = await fetchFaviconUrl(env, host, dom).catch(() => null);
    let icon: string | null = null;
    try {
      icon = iconUrlOf(host, dom, manifest);
    } catch {
      icon = null;
    }
    const themeColor = normalizeColor(info?.metadata?.themeColor ?? metaContent(dom, "name", "theme-color") ?? manifest?.theme_color);
    let name: string | null = null;
    let description: string | null = null;
    if (info?.metadata && typeof info.metadata.nodeName === "string") name = info.metadata.nodeName;
    else if (info?.metadata && typeof info.metadata.name === "string") name = info.metadata.name;
    else name = metaContent(dom, "property", "og:title") ?? (manifest ? (manifest.name ?? manifest.short_name ?? null) : null);
    if (info?.metadata && typeof info.metadata.nodeDescription === "string") description = info.metadata.nodeDescription;
    else if (info?.metadata && typeof info.metadata.description === "string") description = info.metadata.description;
    else description = metaContent(dom, "name", "description") ?? metaContent(dom, "property", "og:description") ?? (manifest ? (manifest.name ?? manifest.short_name ?? null) : null);

    const sets: string[] = [`"infoUpdatedAt" = now()`];
    const params: unknown[] = [instance.id];
    const set = (col: string, v: unknown) => {
      params.push(v);
      sets.push(`"${col}" = $${params.length}`);
    };
    const cut = (v: unknown, n: number) => (typeof v === "string" ? v.slice(0, n) : null);
    if (info) {
      set("softwareName", typeof info.software?.name === "string" ? info.software.name.toLowerCase().slice(0, 64) : "?");
      set("softwareVersion", cut(info.software?.version, 64));
      set("openRegistrations", typeof info.openRegistrations === "boolean" ? info.openRegistrations : null);
      set("maintainerName", cut(info.metadata?.maintainer?.name, 128));
      set("maintainerEmail", cut(info.metadata?.maintainer?.email, 256));
    }
    if (name) set("name", cut(name, 256));
    if (description) set("description", cut(description, 4096));
    if (icon ?? favicon) set("iconUrl", cut(icon && !icon.includes("data:image/png;base64") ? icon : favicon, 256));
    if (favicon) set("faviconUrl", cut(favicon, 256));
    if (themeColor) set("themeColor", themeColor);
    await withHyperdriveClient(env.HYPERDRIVE!, (c) => c.query(`UPDATE instance SET ${sets.join(", ")} WHERE id = $1`, params));
  } catch (e) {
    console.warn(`Failed to update metadata of ${host}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ---------------------------------------------------------------- deliverSuspendedSoftware (semver subset)

type Ver = [number, number, number, string[]];

function parseVer(v: string): Ver | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3]), m[4] ? m[4].split(".") : []] : null;
}

function cmp(a: Ver, b: Ver): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return (a[i] as number) < (b[i] as number) ? -1 : 1;
  const pa = a[3], pb = b[3];
  if (!pa.length || !pb.length) return pa.length === pb.length ? 0 : pa.length ? -1 : 1;
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i], y = pb[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const nx = /^\d+$/.test(x), ny = /^\d+$/.test(y);
    if (nx && ny) return Number(x) < Number(y) ? -1 : 1;
    if (nx !== ny) return nx ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

type Cmp = { op: "<" | "<=" | ">" | ">=" | "="; v: Ver };

/** One comparator token (^ ~ x-ranges included) → plain comparators. */
function expand(tok: string): Cmp[] | null {
  const m = /^(\^|~|>=|<=|>|<|=)?v?(\d+|[xX*])?(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(tok);
  if (!m) return null;
  const op = m[1] ?? "";
  const part = (s: string | undefined) => (s === undefined || /^[xX*]$/.test(s) ? null : Number(s));
  const [M, mi, p] = [part(m[2]), part(m[3]), part(m[4])];
  const pre = m[5] ? m[5].split(".") : [];
  const lo = (a: number, b: number, c: number, pr: string[] = []): Ver => [a, b, c, pr];
  const zero = ["0"];
  if (M === null) return op === "<" || op === ">" ? [{ op: "<", v: lo(0, 0, 0, zero) }] : [];
  if (op === "^") {
    const from = lo(M, mi ?? 0, p ?? 0, pre);
    const to = M > 0 || mi === null ? lo(M + 1, 0, 0, zero) : mi > 0 || p === null ? lo(0, mi + 1, 0, zero) : lo(0, 0, p + 1, zero);
    return [{ op: ">=", v: from }, { op: "<", v: to }];
  }
  if (op === "~") {
    const from = lo(M, mi ?? 0, p ?? 0, pre);
    return [{ op: ">=", v: from }, { op: "<", v: mi === null ? lo(M + 1, 0, 0, zero) : lo(M, mi + 1, 0, zero) }];
  }
  const partial = mi === null || p === null;
  const upper = mi === null ? lo(M + 1, 0, 0, zero) : lo(M, mi + 1, 0, zero);
  const exact = lo(M, mi ?? 0, p ?? 0, pre);
  if (!partial) return [{ op: (op || "=") as Cmp["op"], v: exact }];
  switch (op) {
    case "":
    case "=":
      return [{ op: ">=", v: exact }, { op: "<", v: upper }];
    case ">=":
      return [{ op: ">=", v: exact }];
    case ">":
      return [{ op: ">=", v: upper }];
    case "<":
      return [{ op: "<", v: lo(M, mi ?? 0, 0, zero) }];
    case "<=":
      return [{ op: "<", v: upper }];
  }
  return null;
}

/** semver.satisfies(version, range, { includePrerelease: true }) for the common range forms. */
export function semverSatisfies(version: string, range: string): boolean {
  const v = parseVer(version);
  if (!v) return false;
  return range.split("||").some((set) => {
    const s = set.trim().replace(/(>=|<=|>|<|=|\^|~)\s+/g, "$1");
    let toks: string[];
    const hy = /^(\S+)\s+-\s+(\S+)$/.exec(s);
    if (hy) toks = [`>=${hy[1]}`, `<=${hy[2]}`];
    else toks = s.length ? s.split(/\s+/) : [];
    const cmps: Cmp[] = [];
    for (const t of toks) {
      const e = expand(t);
      if (!e) return false;
      cmps.push(...e);
    }
    return cmps.every(({ op, v: w }) => {
      const r = cmp(v, w);
      return op === "<" ? r < 0 : op === "<=" ? r <= 0 : op === ">" ? r > 0 : op === ">=" ? r >= 0 : r === 0;
    });
  });
}

/** UtilityService.isDeliverSuspendedSoftware */
export function isDeliverSuspendedSoftware(list: { software: string; versionRange: string }[], i: { softwareName: unknown; softwareVersion: unknown }): boolean {
  if (i.softwareName == null) return false;
  if (i.softwareVersion == null) return list.some((x) => x.software === i.softwareName && x.versionRange.trim() === "*");
  return list.some((x) => x.software === i.softwareName && semverSatisfies(String(i.softwareVersion), x.versionRange));
}

// ---------------------------------------------------------------- DeliverProcessorService

/**
 * Before a delivery: suspended instances (any suspensionState but none) and software listed
 * in meta.deliverSuspendedSoftware are skipped. The instance is fetchOrRegister'ed when stats
 * are enabled, otherwise only looked up. Never throws.
 */
export async function deliverPrecheck(env: ApiEnv, host: string): Promise<{ skip: "suspended" | "software suspended" | null; instance: Row | null }> {
  if (!env.HYPERDRIVE?.connectionString) return { skip: null, instance: null };
  try {
    return await withHyperdriveClient(env.HYPERDRIVE, async (c) => {
      const found = await findInstanceC(c, host);
      if (found && String(found.suspensionState ?? "none") !== "none") return { skip: "suspended" as const, instance: found };
      const s = (await metaRowPg(c)).deliverSuspendedSoftware;
      const list = (Array.isArray(s) ? s : []).filter(
        (x: unknown): x is { software: string; versionRange: string } =>
          x != null && typeof (x as Row).software === "string" && typeof (x as Row).versionRange === "string",
      );
      const i = found ?? ((await statsEnabled(c)) ? await fetchOrRegisterInstanceC(c, host) : null);
      if (i && isDeliverSuspendedSoftware(list, i as { softwareName: unknown; softwareVersion: unknown })) return { skip: "software suspended" as const, instance: i };
      return { skip: null, instance: i };
    });
  } catch (e) {
    console.warn("deliver precheck failed", e instanceof Error ? e.message : String(e));
    return { skip: null, instance: null };
  }
}

/** A delivery succeeded: clear isNotResponding, then refresh metadata when stats are enabled. */
export async function deliverSucceeded(env: ApiEnv, instance: Row | null): Promise<void> {
  if (!instance || !env.HYPERDRIVE?.connectionString) return;
  try {
    const stats = await withHyperdriveClient(env.HYPERDRIVE, async (c) => {
      if (instance.isNotResponding) await c.query(`UPDATE instance SET "isNotResponding" = FALSE, "notRespondingSince" = NULL WHERE id = $1`, [instance.id]);
      return statsEnabled(c);
    });
    if (stats) await fetchInstanceMetadata(env, instance, false);
  } catch (e) {
    console.warn("instance update failed", e instanceof Error ? e.message : String(e));
  }
}

/**
 * A delivery failed: the first failure sets isNotResponding + notRespondingSince; once it has
 * not responded for 7 days it becomes autoSuspendedForNotResponding (an inbound request clears
 * both, see instanceRequestReceived).
 */
export async function deliverFailed(env: ApiEnv, host: string): Promise<void> {
  if (!env.HYPERDRIVE?.connectionString) return;
  try {
    await withHyperdriveClient(env.HYPERDRIVE, async (c) => {
      const i = await fetchOrRegisterInstanceC(c, host);
      const since = (await c.query(`SELECT "notRespondingSince" FROM instance WHERE id = $1`, [i.id])).rows[0]?.notRespondingSince;
      if (!i.isNotResponding) {
        await c.query(`UPDATE instance SET "isNotResponding" = TRUE, "notRespondingSince" = now() WHERE id = $1`, [i.id]);
      } else if (since) {
        if (String(i.suspensionState ?? "none") === "none" && new Date(String(since)).getTime() <= Date.now() - 7 * 86400_000) {
          await c.query(`UPDATE instance SET "suspensionState" = 'autoSuspendedForNotResponding' WHERE id = $1`, [i.id]);
        }
      } else {
        await c.query(`UPDATE instance SET "notRespondingSince" = now() WHERE id = $1`, [i.id]);
      }
    });
  } catch (e) {
    console.warn("instance update failed", e instanceof Error ? e.message : String(e));
  }
}

/**
 * DeliverProcessorService: a shared inbox answering 410 has declared the server closed, so the
 * instance becomes goneSuspended. A delivery counts as to a shared inbox when the inbox is some
 * remote user's `sharedInbox` (upstream passes the flag along with the job).
 */
export async function deliverGone(env: ApiEnv, host: string, inbox: string): Promise<boolean> {
  if (!env.HYPERDRIVE?.connectionString) return false;
  try {
    return await withHyperdriveClient(env.HYPERDRIVE, async (c) => {
      const shared = (await c.query(`SELECT 1 AS ok FROM "user" WHERE "sharedInbox" = $1 AND host IS NOT NULL LIMIT 1`, [inbox])).rows.length > 0;
      if (!shared) return false;
      const i = await fetchOrRegisterInstanceC(c, host);
      await c.query(`UPDATE instance SET "suspensionState" = 'goneSuspended' WHERE id = $1`, [i.id]);
      return true;
    });
  } catch (e) {
    console.warn("instance update failed", e instanceof Error ? e.message : String(e));
    return false;
  }
}
