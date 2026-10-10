/**
 * ActivityPub / discovery HTTP surface served by the API worker (it is the
 * public origin today). federation=none → 403 like upstream
 * ActivityPubServerService / WellKnownServerService.
 */

import {
  isActivityPubRequest,
  noteUri,
  parseAcctResource,
  renderAnnounce,
  renderCreate,
  renderDocument,
  renderEmoji,
  renderNote,
  renderPerson,
  userUri,
  withContext,
} from "../../../ap/src/index.js";
import { parseAidxTime } from "../../../id/src/index.js";
import type { ApiEnv } from "../env.js";
import { buildPackConfig } from "../meta-source.js";
import { getNotePg, getNotesByIdsPg, isPureRenote } from "../notes-pg.js";
import { withHyperdriveClient } from "../pg.js";
import { getQueueProducer, MK_INBOX } from "../queues/fanout.js";
import { getFederationPolicy, hostBlocked } from "./federation.js";
import { precheckIncoming } from "../../../ap/src/index.js";
import { toPuny } from "./instances.js";
import { describeInboxMessage, processInbox, type InboxMessage } from "./inbox.js";
import { FAST_PATH_BACKUP_DELAY_S, fastPathAvailable, runFastPath } from "./fast-path.js";
import { buildNodeInfo, nodeInfoHeaders, nodeInfoLinks } from "./nodeinfo.js";
import { getUserKeypair } from "./keys.js";
import { fromSimpleArray } from "../../../db/src/simple-array.js";
import { metaRowPg } from "../user-lite-pg.js";

/** upstream ActivityPubServerService / WellKnownServerService: on every AP and well-known response */
const CORS_HEADERS = {
  "access-control-allow-headers": "Accept",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-origin": "*",
  "access-control-expose-headers": "Vary",
};
const AP_HEADERS = { "content-type": "application/activity+json; charset=utf-8", vary: "Accept", ...CORS_HEADERS };
/** upstream: Person, Note, Note activity, WebFinger and the collection indexes */
const PUBLIC_CACHE = { "cache-control": "public, max-age=180" };
const INBOX_LIMIT = 64 * 1024;

function forbidden(): Response {
  return new Response(null, { status: 403 });
}

async function federationOff(env: ApiEnv): Promise<boolean> {
  return (await getFederationPolicy(env)).mode === "none";
}

// ServerService: with meta.allowExternalApRedirect off, a request that looks like an ActivityPub
// object lookup is not redirected to another server (406 with the canonical URL in a Link header)
const MAYBE_AP_LOOKUP = /application\/activity\+json|application\/ld\+json.+activitystreams/i;

async function allowExternalApRedirect(env: ApiEnv): Promise<boolean> {
  return withHyperdriveClient(env.HYPERDRIVE!, async (c) => (await metaRowPg(c)).allowExternalApRedirect === true);
}

/** ActivityPubServerService's redirect of a remote user / note to its uri, through the ServerService check. */
async function apRedirect(env: ApiEnv, request: Request, base: string, location: string, status: 301 | 302): Promise<Response> {
  if (!location.startsWith(`${base}/`) && MAYBE_AP_LOOKUP.test(request.headers.get("accept") ?? "") && !(await allowExternalApRedirect(env))) {
    return new Response(
      [
        "Refusing to relay remote ActivityPub object lookup.",
        "",
        `Please remove 'application/activity+json' and 'application/ld+json' from the Accept header or fetch using the authoritative URL at ${location}.`,
      ].join("\n"),
      { status: 406, headers: { "content-type": "text/plain; charset=utf-8", link: `<${encodeURI(location)}>; rel="canonical"`, vary: "Accept" } },
    );
  }
  return new Response(null, { status, headers: { location, vary: "Accept" } });
}

/** A remote user's uri for the redirect (`undefined`: no such user; `null`: no uri). */
async function findRemoteUserUri(env: ApiEnv, by: { id: string } | { username: string; host: string }): Promise<string | null | undefined> {
  if (!env.HYPERDRIVE?.connectionString) return undefined;
  return withHyperdriveClient(env.HYPERDRIVE, async (c) => {
    const r = "id" in by
      ? await c.query(`SELECT uri FROM "user" WHERE id = $1 AND host IS NOT NULL AND "isSuspended" = FALSE`, [by.id])
      : await c.query(`SELECT uri FROM "user" WHERE "usernameLower" = $1 AND host = $2 AND "isSuspended" = FALSE`, [by.username.toLowerCase(), by.host]);
    const row = r.rows[0];
    return row ? ((row.uri as string | null) ?? null) : undefined;
  });
}

type LocalUserRow = {
  id: string; username: string; name: string | null; isLocked: boolean; isBot: boolean; isCat: boolean; avatarUrl: string | null;
  bannerUrl: string | null; isExplorable: boolean; fields: { name: string; value: string }[];
  description: string | null; followersCount: number; followingCount: number; notesCount: number;
  movedToUri?: string | null; alsoKnownAs?: string[] | null;
};

async function findLocalUser(env: ApiEnv, by: { id?: string; username?: string }): Promise<LocalUserRow | null> {
  if (!env.HYPERDRIVE?.connectionString) return null;
  return withHyperdriveClient(env.HYPERDRIVE, async (c) => {
    const r = await c.query(
      `SELECT u.id, u.username, u.name, u."isLocked", u."isBot", u."isCat", u."avatarUrl", u."bannerUrl", u."isSuspended", u."isExplorable",
              u."followersCount", u."followingCount", u."notesCount", u."movedToUri", u."alsoKnownAs", p.description, p.fields
       FROM "user" u LEFT JOIN user_profile p ON p."userId" = u.id
       WHERE u.host IS NULL AND ${by.id ? "u.id = $1" : `u."usernameLower" = $1`} LIMIT 1`,
      [by.id ?? by.username!.toLowerCase()],
    );
    const row = r.rows[0];
    if (!row || row.isSuspended) return null;
    return {
      id: String(row.id),
      username: String(row.username),
      name: (row.name as string | null) ?? null,
      isLocked: Boolean(row.isLocked),
      isBot: Boolean(row.isBot),
      isCat: Boolean(row.isCat),
      avatarUrl: (row.avatarUrl as string | null) ?? null,
      bannerUrl: (row.bannerUrl as string | null) ?? null,
      isExplorable: row.isExplorable !== false,
      fields: Array.isArray(row.fields) ? (row.fields as { name: string; value: string }[]) : [],
      description: (row.description as string | null) ?? null,
      followersCount: Number(row.followersCount ?? 0),
      followingCount: Number(row.followingCount ?? 0),
      notesCount: Number(row.notesCount ?? 0),
      movedToUri: (row.movedToUri as string | null) ?? null,
      alsoKnownAs: fromSimpleArray(row.alsoKnownAs),
    };
  });
}

/** The local actor as a Person (null when the user or its keypair is missing). */
export async function renderLocalPerson(env: ApiEnv, userOrId: LocalUserRow | string): Promise<Record<string, unknown> | null> {
  const u = typeof userOrId === "string" ? await findLocalUser(env, { id: userOrId }) : userOrId;
  if (!u) return null;
  const kp = await getUserKeypair(env, u.id);
  if (!kp) return null;
  return renderPerson({
    base: buildPackConfig(env).url.replace(/\/$/, ""),
    id: u.id,
    username: u.username,
    name: u.name,
    summary: u.description,
    publicKeyPem: kp.publicKey,
    isLocked: u.isLocked,
    isBot: u.isBot,
    isCat: u.isCat,
    avatarUrl: u.avatarUrl,
    bannerUrl: u.bannerUrl,
    discoverable: u.isExplorable,
    fields: u.fields,
    movedToUri: u.movedToUri ?? null,
    alsoKnownAs: u.alsoKnownAs ?? null,
  });
}

/** Returns a Response when the path is an AP/discovery route, else null. */
/**
 * Whether an inbox POST is worth the fast path (one KV write each): everything but the bulk of
 * the shared inbox (posts, boosts and deletions from followed accounts and relays), which can
 * wait for the queue.
 */
function inboxFastPathWorthIt(path: string, body: string): boolean {
  if (path !== "/inbox") return true;
  let type: unknown;
  try {
    type = (JSON.parse(body) as { type?: unknown } | null)?.type;
  } catch {
    return false;
  }
  return !(type === "Create" || type === "Announce" || type === "Delete");
}

export async function handleApRoutes(request: Request, env: ApiEnv): Promise<Response | null> {
  const url = new URL(request.url);
  const p = url.pathname;
  const config = buildPackConfig(env);
  const base = config.url.replace(/\/$/, "");

  // --- NodeInfo (always available, like upstream) ---
  if (p === "/.well-known/nodeinfo") return Response.json(nodeInfoLinks(base), { headers: CORS_HEADERS });
  if (p === "/nodeinfo/2.0" || p === "/nodeinfo/2.1") {
    const version = p === "/nodeinfo/2.1" ? "2.1" : "2.0";
    const ni = await buildNodeInfo(env, version);
    // misskey-cf addition: the federation mode
    const policy = await getFederationPolicy(env);
    ni.metadata = { ...(ni.metadata as object), federation: policy.mode };
    return new Response(JSON.stringify(ni), { headers: nodeInfoHeaders(version) });
  }

  // --- WebFinger / host-meta ---
  if (p === "/.well-known/webfinger") {
    if (await federationOff(env)) return forbidden();
    const resource = url.searchParams.get("resource");
    let user: LocalUserRow | null = null;
    const acct = parseAcctResource(resource);
    if (acct) {
      if (acct.host.toLowerCase() !== config.host.toLowerCase()) return new Response(null, { status: 422 });
      user = await findLocalUser(env, { username: acct.user });
    } else if (resource?.startsWith(`${base}/users/`)) {
      user = await findLocalUser(env, { id: resource.slice(`${base}/users/`.length) });
    } else if (resource?.startsWith(`${base}/@`)) {
      user = await findLocalUser(env, { username: resource.slice(`${base}/@`.length) });
    }
    if (!user) return new Response(null, { status: 404 });
    const self = userUri(base, user.id);
    return new Response(
      JSON.stringify({
        subject: `acct:${user.username}@${config.host}`,
        aliases: [self, `${base}/@${user.username}`],
        links: [
          { rel: "self", type: "application/activity+json", href: self },
          { rel: "http://webfinger.net/rel/profile-page", type: "text/html", href: `${base}/@${user.username}` },
          { rel: "http://ostatus.org/schema/1.0/subscribe", template: `${base}/authorize-follow?acct={uri}` },
        ],
      }),
      { headers: { "content-type": "application/jrd+json; charset=utf-8", vary: "Accept", ...PUBLIC_CACHE, ...CORS_HEADERS } },
    );
  }
  if (p === "/.well-known/host-meta") {
    if (await federationOff(env)) return forbidden();
    return new Response(
      `<?xml version="1.0" encoding="UTF-8"?>\n<XRD xmlns="http://docs.oasis-open.org/ns/xri/xrd-1.0"><Link rel="lrdd" type="application/jrd+json" template="${base}/.well-known/webfinger?resource={uri}"/></XRD>`,
      { headers: { "content-type": "application/xrd+xml", ...CORS_HEADERS } },
    );
  }

  // --- Inbox ---
  if ((p === "/inbox" || /^\/users\/[0-9a-z]+\/inbox$/.test(p)) && request.method === "POST") {
    if (await federationOff(env)) return forbidden();
    // per IP, before anything is queued; senders retry a 429
    const { ipOverLimit, ipLimitedResponse } = await import("../rate-limit.js");
    if (await ipOverLimit(env.INBOX_RATE_LIMIT, request)) return ipLimitedResponse();
    const len = Number(request.headers.get("content-length") ?? "0");
    if (len > INBOX_LIMIT) return new Response(null, { status: 413 });
    const body = await request.text();
    if (body.length > INBOX_LIMIT) return new Response(null, { status: 413 });
    if (!request.headers.get("signature")) return new Response(null, { status: 401 });
    const headers: Record<string, string> = {};
    request.headers.forEach((v, k) => {
      const key = k.toLowerCase();
      if (key === "cookie" || key === "authorization" || key.startsWith("cf-")) return;
      headers[key] = v;
    });
    if (!headers.host) headers.host = url.host;
    const msg: InboxMessage = { kind: "inbox", method: "POST", path: p + url.search, headers, body, receivedAt: Date.now() };
    // before queueing: the signature header, date and digest checks the consumer repeats
    // (upstream's inbox route answers 401 for them too), and a signer on a blocked host (dropped,
    // as InboxProcessorService's "Blocked request"). `specified` is left to the consumer: a relay
    // outside the list may still carry an allowed author's LD-signed activity.
    const pre = await precheckIncoming({ method: "POST", headers, body, expectedHost: buildPackConfig(env).host, now: new Date(msg.receivedAt) });
    if (!pre.ok) return new Response(null, { status: 401 });
    let signerHost: string | null = null;
    try {
      signerHost = new URL(pre.keyId).host;
    } catch {
      return new Response(null, { status: 401 });
    }
    if (hostBlocked(await getFederationPolicy(env), signerHost)) return new Response(null, { status: 202 });
    if (!fastPathAvailable(env) || !inboxFastPathWorthIt(p, body)) {
      await getQueueProducer(env).send(MK_INBOX, msg);
      return new Response(null, { status: 202 });
    }
    // processed at once after the response; the queued copy is a backup (fast-path.ts)
    msg.fast = crypto.randomUUID();
    await getQueueProducer(env).send(MK_INBOX, msg, { delaySeconds: FAST_PATH_BACKUP_DELAY_S });
    runFastPath(env, msg.fast, "inbox", async () => {
      const r = await processInbox(env, msg);
      console.log(`inbox(fast) ${describeInboxMessage(msg)}: ${r.ok ? "" : "rejected "}${r.reason}`);
      return true;
    });
    return new Response(null, { status: 202 });
  }

  // --- AP GETs (actor / note / collections) ---
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  const wantsAp = isActivityPubRequest(request.headers.get("accept"));

  const atUser = /^\/@([\w.-]+)(?:@([^/@]+))?$/.exec(p);
  if (atUser && wantsAp) {
    if (await federationOff(env)) return forbidden();
    let host: string | null = null;
    if (atUser[2]) {
      try {
        host = toPuny(decodeURIComponent(atUser[2]));
      } catch {
        return new Response(null, { status: 404 });
      }
      if (host === toPuny(new URL(base).host)) host = null;
    }
    if (host != null) {
      // a remote user: redirect to its uri
      const uri = await findRemoteUserUri(env, { username: atUser[1]!, host });
      if (uri === undefined) return new Response(null, { status: 404 });
      if (uri === null) return new Response(null, { status: 500 });
      return apRedirect(env, request, base, uri, 301);
    }
    const u = await findLocalUser(env, { username: atUser[1]! });
    if (!u) return new Response(null, { status: 404 });
    return Response.redirect(userUri(base, u.id), 301);
  }

  const users = /^\/users\/([0-9a-z]+)(?:\/(outbox|followers|following|collections\/featured))?$/.exec(p);
  if (users && (wantsAp || users[2])) {
    if (await federationOff(env)) return forbidden();
    const u = await findLocalUser(env, { id: users[1]! });
    if (!u) {
      // a remote user's actor: redirect to its uri
      if (!users[2]) {
        const uri = await findRemoteUserUri(env, { id: users[1]! });
        if (uri === null) return new Response(null, { status: 500 });
        if (uri !== undefined) return apRedirect(env, request, base, uri, 301);
      }
      return new Response(null, { status: 404 });
    }
    if (!users[2]) {
      const person = await renderLocalPerson(env, u);
      if (!person) return new Response(null, { status: 404 });
      return new Response(JSON.stringify(withContext(person)), { headers: { ...AP_HEADERS, ...PUBLIC_CACHE } });
    }
    if (users[2] === "outbox") return outbox(env, u, url);
    if (users[2] === "collections/featured") return featured(env, u);
    return followCollection(env, u, users[2] as "followers" | "following", url);
  }

  const notes = /^\/notes\/([0-9a-z]+)(\/activity)?$/.exec(p);
  if (notes && (wantsAp || notes[2])) {
    if (await federationOff(env)) return forbidden();
    if (!env.HYPERDRIVE?.connectionString) return new Response(null, { status: 404 });
    const n = await getNotePg(env, notes[1]!);
    if (!n || (n.visibility !== "public" && n.visibility !== "home") || n.localOnly) {
      return new Response(null, { status: 404 });
    }
    if (n.userHost != null) {
      // a remote note: `/notes/:id` redirects to its uri, `/notes/:id/activity` is local only
      if (notes[2]) return new Response(null, { status: 404 });
      if (!n.uri) return new Response(null, { status: 500 });
      return apRedirect(env, request, base, n.uri, 302);
    }
    const obj = await renderLocalNote(env, n);
    const body = notes[2] ? renderCreate(obj, `${noteUri(base, n.id)}/activity`) : obj;
    return new Response(JSON.stringify(withContext(body)), { headers: { ...AP_HEADERS, ...PUBLIC_CACHE } });
  }

  return null;
}

/**
 * ActivityPubServerService.followers / following: 403 unless the profile's followersVisibility /
 * followingVisibility is public; the index links `first`; `page=true` lists 10 actor URIs per
 * page (newest following row first), continued by `cursor` (a following id).
 */
async function followCollection(env: ApiEnv, u: LocalUserRow, kind: "followers" | "following", url: URL): Promise<Response> {
  const base = buildPackConfig(env).url.replace(/\/$/, "");
  const partOf = `${userUri(base, u.id)}/${kind}`;
  const total = kind === "followers" ? u.followersCount : u.followingCount;
  const cursor = url.searchParams.get("cursor");
  if (env.HYPERDRIVE?.connectionString) {
    const vis = await withHyperdriveClient(env.HYPERDRIVE, async (c) =>
      (await c.query(
        `SELECT to_jsonb(p) ->> $2 AS v FROM user_profile p WHERE "userId" = $1`,
        [u.id, kind === "followers" ? "followersVisibility" : "followingVisibility"],
      )).rows[0]?.v as string | null | undefined,
    );
    if (vis === "private" || vis === "followers") return new Response(null, { status: 403, headers: { "cache-control": "public, max-age=30" } });
  }
  if (url.searchParams.get("page") !== "true") {
    const body = { id: partOf, type: "OrderedCollection", totalItems: total, first: `${partOf}?page=true` };
    return new Response(JSON.stringify(withContext(body)), { headers: { ...AP_HEADERS, ...PUBLIC_CACHE } });
  }
  const limit = 10;
  const rows = env.HYPERDRIVE?.connectionString
    ? await withHyperdriveClient(env.HYPERDRIVE, async (c) => {
        const [self, other] = kind === "followers" ? ['"followeeId"', '"followerId"'] : ['"followerId"', '"followeeId"'];
        const params: unknown[] = [u.id, limit + 1];
        const r = await c.query(
          `SELECT f.id, u.id AS "userId", u.uri FROM following f JOIN "user" u ON u.id = f.${other}
           WHERE f.${self} = $1 ${cursor ? `AND f.id < $${params.push(cursor)}` : ""} ORDER BY f.id DESC LIMIT $2`,
          params,
        );
        return r.rows;
      })
    : [];
  const inStock = rows.length === limit + 1;
  if (inStock) rows.pop();
  // ApRendererService.renderFollowUser: UserEntityService.getUserUri
  const items = rows.map((r) => (r.uri as string | null) ?? userUri(base, String(r.userId)));
  const q = (o: Record<string, string | null>) => new URLSearchParams(Object.entries(o).filter((e): e is [string, string] => e[1] != null)).toString();
  const page: Record<string, unknown> = {
    id: `${partOf}?${q({ page: "true", cursor })}`,
    partOf,
    type: "OrderedCollectionPage",
    totalItems: total,
    orderedItems: items,
  };
  if (inStock) page.next = `${partOf}?${q({ page: "true", cursor: String(rows.at(-1)!.id) })}`;
  return new Response(JSON.stringify(withContext(page)), { headers: AP_HEADERS });
}

/** ActivityPubServerService.featured: pinned public / home notes, newest pin first. */
async function featured(env: ApiEnv, u: LocalUserRow): Promise<Response> {
  const base = buildPackConfig(env).url.replace(/\/$/, "");
  const ids = env.HYPERDRIVE?.connectionString
    ? await withHyperdriveClient(env.HYPERDRIVE, async (c) =>
        (await c.query(`SELECT "noteId" FROM user_note_pining WHERE "userId" = $1 ORDER BY id DESC`, [u.id])).rows.map((r) => String(r.noteId)),
      )
    : [];
  const byId = new Map((ids.length ? await getNotesByIdsPg(env, ids) : []).map((n) => [n.id, n]));
  const items: Record<string, unknown>[] = [];
  for (const id of ids) {
    const n = byId.get(id);
    if (!n || n.localOnly || (n.visibility !== "public" && n.visibility !== "home")) continue;
    items.push(await renderLocalNote(env, n));
  }
  const body = { id: `${userUri(base, u.id)}/collections/featured`, type: "OrderedCollection", totalItems: items.length, orderedItems: items };
  return new Response(JSON.stringify(withContext(body)), { headers: { ...AP_HEADERS, ...PUBLIC_CACHE } });
}

/**
 * ActivityPubServerService.outbox: the index (first / last page links), or with `page=true`
 * an OrderedCollectionPage of 20 Create / Announce activities (public / home, not localOnly),
 * paginated by since_id / until_id (not both).
 */
async function outbox(env: ApiEnv, u: LocalUserRow, url: URL): Promise<Response> {
  const base = buildPackConfig(env).url.replace(/\/$/, "");
  const partOf = `${userUri(base, u.id)}/outbox`;
  const sinceId = url.searchParams.get("since_id");
  const untilId = url.searchParams.get("until_id");
  if (sinceId != null && untilId != null) return new Response(null, { status: 400 });
  if (url.searchParams.get("page") !== "true") {
    const body = { id: partOf, type: "OrderedCollection", totalItems: u.notesCount, first: `${partOf}?page=true`, last: `${partOf}?page=true&since_id=000000000000000000000000` };
    return new Response(JSON.stringify(withContext(body)), { headers: { ...AP_HEADERS, ...PUBLIC_CACHE } });
  }
  const ids = env.HYPERDRIVE?.connectionString
    ? await withHyperdriveClient(env.HYPERDRIVE, async (c) => {
        // QueryService.makePaginationQuery: since_id ascending, otherwise descending
        const params: unknown[] = [u.id];
        let cond = "";
        if (sinceId != null) cond = `AND id > $${params.push(sinceId)}`;
        else if (untilId != null) cond = `AND id < $${params.push(untilId)}`;
        const r = await c.query(
          `SELECT id FROM note WHERE "userId" = $1 AND visibility IN ('public', 'home') AND "localOnly" = FALSE ${cond}
           ORDER BY id ${sinceId != null ? "ASC" : "DESC"} LIMIT 20`,
          params,
        );
        return r.rows.map((x) => String(x.id));
      })
    : [];
  if (sinceId != null) ids.reverse();
  const byId = new Map((ids.length ? await getNotesByIdsPg(env, ids) : []).map((n) => [n.id, n]));
  const notes = ids.map((id) => byId.get(id)).filter((n): n is NonNullable<typeof n> => n != null);
  const activities: Record<string, unknown>[] = [];
  for (const n of notes) {
    if (isPureRenote(n)) {
      const target = await getNotePg(env, n.renoteId!);
      activities.push(renderAnnounce(target ? (target.uri ?? noteUri(base, target.id)) : noteUri(base, n.renoteId!), {
        base, noteId: n.id, userId: n.userId, createdAt: new Date(parseAidxMs(n.id)).toISOString(), visibility: n.visibility,
      }));
    } else {
      activities.push(renderCreate(await renderLocalNote(env, n), `${noteUri(base, n.id)}/activity`));
    }
  }
  const q = (o: Record<string, string | null>) => new URLSearchParams(Object.entries(o).filter((e): e is [string, string] => e[1] != null)).toString();
  const page: Record<string, unknown> = {
    id: `${partOf}?${q({ page: "true", since_id: sinceId, until_id: untilId })}`,
    partOf,
    type: "OrderedCollectionPage",
    totalItems: u.notesCount,
    orderedItems: activities,
  };
  if (notes.length) {
    page.prev = `${partOf}?${q({ page: "true", since_id: notes[0]!.id })}`;
    page.next = `${partOf}?${q({ page: "true", until_id: notes.at(-1)!.id })}`;
  }
  return new Response(JSON.stringify(withContext(page)), { headers: AP_HEADERS });
}

/** Render a local note (resolving reply/quote/mention URIs from PG). */
export async function renderLocalNote(env: ApiEnv, n: NonNullable<Awaited<ReturnType<typeof getNotePg>>>): Promise<Record<string, unknown>> {
  const base = buildPackConfig(env).url.replace(/\/$/, "");
  const uriOfNote = async (id: string | null) => {
    if (!id) return null;
    const t = await getNotePg(env, id);
    return t ? (t.uri ?? noteUri(base, t.id)) : null;
  };
  const mentionUris: string[] = [];
  const visibleUris: string[] = [];
  const ids = [...new Set([...n.mentions, ...n.visibleUserIds])];
  if (ids.length && env.HYPERDRIVE?.connectionString) {
    const rows = await withHyperdriveClient(env.HYPERDRIVE, async (c) => {
      const r = await c.query(`SELECT id, uri FROM "user" WHERE id = ANY($1::varchar[])`, [ids]);
      return r.rows;
    });
    const uriOf = new Map(rows.map((r) => [String(r.id), (r.uri as string | null) ?? userUri(base, String(r.id))]));
    for (const id of n.mentions) if (uriOf.has(id)) mentionUris.push(uriOf.get(id)!);
    for (const id of n.visibleUserIds) if (uriOf.has(id)) visibleUris.push(uriOf.get(id)!);
  }
  const isQuote = Boolean(n.renoteId && n.text);
  const extra = env.HYPERDRIVE?.connectionString ? await noteExtras(env, n) : { attachment: [], emojis: [], poll: null };
  return renderNote({
    base,
    id: n.id,
    userId: n.userId,
    text: n.text,
    cw: n.cw,
    createdAt: new Date(parseAidxMs(n.id)).toISOString(),
    visibility: n.visibility,
    inReplyTo: await uriOfNote(n.replyId),
    quoteUri: isQuote ? await uriOfNote(n.renoteId) : null,
    mentionUris,
    visibleUris,
    hashtags: n.tags,
    ...extra,
  });
}

/** ApRendererService.renderNote: files (renderDocument), local custom emojis (renderEmoji, not localOnly), poll (Question). */
async function noteExtras(env: ApiEnv, n: NonNullable<Awaited<ReturnType<typeof getNotePg>>>): Promise<{
  attachment: Record<string, unknown>[];
  emojis: Record<string, unknown>[];
  poll: { choices: string[]; votes: number[]; multiple: boolean; expiresAt: string | null } | null;
}> {
  const base = buildPackConfig(env).url.replace(/\/$/, "");
  return withHyperdriveClient(env.HYPERDRIVE!, async (c) => {
    let attachment: Record<string, unknown>[] = [];
    if (n.fileIds.length) {
      const rows = (await c.query(`SELECT to_jsonb(f) AS f FROM drive_file f WHERE id = ANY($1::varchar[])`, [n.fileIds])).rows.map((r) => r.f as Record<string, unknown>);
      const byId = new Map(rows.map((f) => [String(f.id), f]));
      attachment = n.fileIds
        .map((id) => byId.get(id))
        .filter((f): f is Record<string, unknown> => f != null)
        .map((f) => {
          const props = (f.properties ?? {}) as { width?: number; height?: number };
          return renderDocument({
            type: String(f.webpublicType ?? f.type),
            url: String(f.webpublicUrl ?? f.url), // DriveFileEntityService.getPublicUrl
            comment: (f.comment as string | null) ?? null,
            width: props.width,
            height: props.height,
            isSensitive: Boolean(f.isSensitive),
          });
        });
    }
    let emojis: Record<string, unknown>[] = [];
    if (n.emojis.length) {
      try {
        const rows = (await c.query(
          `SELECT to_jsonb(e) AS e FROM emoji e WHERE host IS NULL AND name = ANY($1::varchar[])`,
          [n.emojis],
        )).rows.map((r) => r.e as Record<string, unknown>);
        emojis = rows
          .filter((e) => e.localOnly !== true)
          .map((e) => renderEmoji(base, {
            name: String(e.name),
            type: (e.type as string | null) ?? null,
            url: String(e.publicUrl || e.originalUrl),
            updatedAt: e.updatedAt ? new Date(String(e.updatedAt)).toISOString() : null,
            license: (e.license as string | null) ?? null,
          }));
      } catch {
        /* no emoji table */
      }
    }
    let poll = null;
    if (n.hasPoll) {
      const p = (await c.query(`SELECT "expiresAt", multiple, choices, votes FROM poll WHERE "noteId" = $1`, [n.id])).rows[0];
      if (p) {
        poll = {
          choices: (p.choices as string[]) ?? [],
          votes: ((p.votes as number[]) ?? []).map(Number),
          multiple: Boolean(p.multiple),
          expiresAt: p.expiresAt == null ? null : new Date(p.expiresAt as string | Date).toISOString(),
        };
      }
    }
    return { attachment, emojis, poll };
  });
}

function parseAidxMs(id: string): number {
  return parseAidxTime(id)?.getTime() ?? Date.now();
}
