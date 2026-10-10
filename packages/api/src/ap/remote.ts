/**
 * Remote actor / object resolution (subset of ApPersonService / ApResolverService).
 * SSRF-guarded fetch; GETs are signed by the instance actor (authorized fetch).
 */

import { BodyTooLargeError, fetchChecked, readCappedText, REMOTE_FETCH_TIMEOUT_MS, UnsafeUrlError } from "../safe-fetch.js";
import { genAidx } from "../../../id/src/index.js";
import {
  getApId,
  getApType,
  htmlToText,
  isActor,
  isSafeRemoteUrl,
  signedGetHeaders,
  toArray,
  userUri,
  type ApObject,
} from "../../../ap/src/index.js";
import type { ApiEnv } from "../env.js";
import { buildPackConfig } from "../meta-source.js";
import { withHyperdriveClient, type PgQueryable } from "../pg.js";
import { getUserKeypair } from "./keys.js";
import { bumpInstanceC } from "./instances.js";
import { toSimpleArray } from "../../../db/src/simple-array.js";
import { metaRowPg } from "../user-lite-pg.js";

export class ApPermanentError extends Error {}

const MAX_BYTES = 1024 * 1024;
/** upstream HttpRequestService.getJson (WebFinger): 256 KiB */
const WEBFINGER_MAX_BYTES = 256 * 1024;

function fetcher(env: ApiEnv): typeof fetch {
  return env.AP_FETCH ?? fetch;
}

export function localBase(env: ApiEnv): string {
  return buildPackConfig(env).url.replace(/\/$/, "");
}

/** `${base}/users/{id}` → id (local actor URI). */
export function parseLocalUserUri(env: ApiEnv, uri: string): string | null {
  const base = localBase(env);
  const m = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/users/([0-9a-z]+)(?:#.*)?$`).exec(uri);
  return m ? m[1]! : null;
}

export function parseLocalNoteUri(env: ApiEnv, uri: string): string | null {
  const base = localBase(env);
  const m = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/notes/([0-9a-z]+)$`).exec(uri);
  return m ? m[1]! : null;
}

let actorCache = new WeakMap<object, { id: string | null; sign: boolean; at: number }>();

/** Forget the cached signToActivityPubGet / instance actor (this isolate), on a meta update. */
export function resetInstanceActorCache(): void {
  actorCache = new WeakMap();
}

/**
 * ApResolverService: GETs are signed by the instance actor (SystemAccountService `actor`,
 * `system.actor`, created with its keypair on first use) unless meta.signToActivityPubGet is
 * false. Cached per env for 5 minutes.
 */
async function instanceActorForGet(env: ApiEnv): Promise<string | null> {
  if (!env.HYPERDRIVE?.connectionString) return null;
  const hit = actorCache.get(env);
  if (hit && Date.now() - hit.at < 300_000) return hit.sign ? hit.id : null;
  const r = await withHyperdriveClient(env.HYPERDRIVE, async (c) => {
    if ((await metaRowPg(c)).signToActivityPubGet === false) return { id: null, sign: false };
    const { fetchSystemAccountC } = await import("./relay.js");
    return { id: await fetchSystemAccountC(c, "actor"), sign: true };
  });
  actorCache.set(env, { ...r, at: Date.now() });
  return r.id;
}

/** GET an AP object, signed by the instance actor (see instanceActorForGet). */
export async function apGet(env: ApiEnv, url: string): Promise<ApObject> {
  if (!isSafeRemoteUrl(url)) throw new ApPermanentError(`unsafe url`);
  const accept = 'application/activity+json, application/ld+json; profile="https://www.w3.org/ns/activitystreams"';
  const actorId = await instanceActorForGet(env);
  const kp = actorId ? await getUserKeypair(env, actorId) : null;
  const headers: Record<string, string> = actorId && kp
    ? await signedGetHeaders({ privateKeyPem: kp.privateKey, keyId: `${userUri(localBase(env), actorId)}#main-key`, url })
    : { Accept: accept };
  const { res } = await fetchChecked(fetcher(env), url, { headers: { ...headers, "User-Agent": "misskey-cf" }, signal: AbortSignal.timeout(REMOTE_FETCH_TIMEOUT_MS) }, { check: (u) => isSafeRemoteUrl(u.href) }).catch((e) => {
    throw e instanceof UnsafeUrlError ? new ApPermanentError("unsafe url") : e;
  });
  if (res.status >= 400 && res.status < 500) throw new ApPermanentError(`GET ${res.status}`);
  if (!res.ok) throw new Error(`GET ${res.status}`);
  const text = await readCappedText(res, MAX_BYTES).catch((e) => {
    throw e instanceof BodyTooLargeError ? new ApPermanentError("too large") : e;
  });
  const json = JSON.parse(text) as ApObject;
  if (!json || typeof json !== "object") throw new ApPermanentError("not an object");
  return json;
}

export type RemoteUser = {
  id: string;
  uri: string;
  host: string;
  username: string;
  inbox: string | null;
  sharedInbox: string | null;
  followersUri: string | null;
  isLocked: boolean;
  /** account migration (set by resolveRemoteUser) */
  movedToUri?: string | null;
  alsoKnownAs?: string[] | null;
};

function rowToRemote(r: Record<string, unknown>): RemoteUser {
  return {
    id: String(r.id),
    uri: String(r.uri),
    host: String(r.host),
    username: String(r.username),
    inbox: (r.inbox as string | null) ?? null,
    sharedInbox: (r.sharedInbox as string | null) ?? null,
    followersUri: (r.followersUri as string | null) ?? null,
    isLocked: Boolean(r.isLocked),
    movedToUri: (r.movedToUri as string | null) ?? null,
  };
}

const REMOTE_COLS = `id, uri, host, username, inbox, "sharedInbox", "followersUri", "isLocked", "movedToUri", "lastFetchedAt"`;

export async function findRemoteUserByUri(env: ApiEnv, uri: string): Promise<(RemoteUser & { lastFetchedAt: Date | null }) | null> {
  return withHyperdriveClient(env.HYPERDRIVE!, async (c) => {
    const r = await c.query(`SELECT ${REMOTE_COLS} FROM "user" WHERE uri = $1 LIMIT 1`, [uri]);
    const row = r.rows[0];
    return row ? { ...rowToRemote(row), lastFetchedAt: row.lastFetchedAt ? new Date(String(row.lastFetchedAt)) : null } : null;
  });
}

/** Remote user by id (for delivery targets). Null for local users. */
export async function getRemoteUserById(env: ApiEnv, id: string): Promise<RemoteUser | null> {
  return withHyperdriveClient(env.HYPERDRIVE!, async (c) => {
    const r = await c.query(`SELECT ${REMOTE_COLS} FROM "user" WHERE id = $1 AND host IS NOT NULL LIMIT 1`, [id]);
    return r.rows[0] ? rowToRemote(r.rows[0]) : null;
  });
}

/**
 * Profile fields from the actor's PropertyValue attachments (ApPersonService.analyzeAttachments:
 * an array only, `name` and `value` strings, the value converted from HTML).
 */
export function analyzeAttachments(attachments: unknown): { name: string; value: string }[] {
  if (!Array.isArray(attachments)) return [];
  const fields: { name: string; value: string }[] = [];
  for (const a of attachments as ApObject[]) {
    if (getApType(a) !== "PropertyValue" || typeof a.name !== "string" || typeof a.value !== "string") continue;
    fields.push({ name: a.name, value: htmlToText(a.value) ?? "" });
  }
  return fields;
}

/** The first image of an `icon` / `image` property and its URL (ApImageService.resolveImage). */
function imageOf(v: unknown): { url: string; type: string | null; sensitive: boolean } | null {
  const img = toArray(v).find((x): x is ApObject => x != null && typeof x === "object") ?? null;
  if (!img) return null;
  const url = typeof img.url === "string" ? img.url : getApId(img.url);
  if (!url || !isSafeRemoteUrl(url)) return null;
  return { url, type: typeof img.mediaType === "string" ? img.mediaType : null, sensitive: img.sensitive === true };
}

/**
 * ApPersonService.resolveAvatarAndBanner + DriveFileEntityService.getPublicUrl: the avatar and the
 * banner become link drive files of the user; the avatar is served through the media proxy
 * (`{mediaProxy}/avatar.webp?url=…&avatar=1`), the banner through `/files/{webpublicAccessKey}`
 * (`proxyRemoteFiles`, the default) or its own URL. Blurhashes come later from the `remoteFile` job.
 */
async function resolveAvatarAndBannerC(
  c: PgQueryable,
  env: ApiEnv,
  user: { id: string; host: string },
  icon: unknown,
  image: unknown,
): Promise<{ created: string[] }> {
  const { linkDriveFile } = await import("./remote-note.js");
  const config = buildPackConfig(env);
  const proxyRemoteFiles = (await metaRowPg(c)).proxyRemoteFiles !== false;
  const created: string[] = [];
  const cols: unknown[] = [];
  for (const [kind, v] of [["avatar", icon], ["banner", image]] as const) {
    const img = imageOf(v);
    if (!img) {
      cols.push(null, null, null);
      continue;
    }
    const f = await linkDriveFile(c, user, img.url, { type: img.type, sensitive: img.sensitive });
    if (f.created) created.push(f.id);
    const row = (await c.query(`SELECT blurhash, "webpublicAccessKey" FROM drive_file WHERE id = $1`, [f.id])).rows[0] ?? {};
    const url = kind === "avatar"
      ? `${config.mediaProxy.replace(/\/$/, "")}/avatar.webp?${new URLSearchParams({ url: img.url, avatar: "1" })}`
      : proxyRemoteFiles && row.webpublicAccessKey ? `${config.url.replace(/\/$/, "")}/files/${row.webpublicAccessKey}` : img.url;
    cols.push(f.id, url, (row.blurhash as string | null) ?? null);
  }
  await c.query(
    `UPDATE "user" SET "avatarId" = $2, "avatarUrl" = $3, "avatarBlurhash" = $4, "bannerId" = $5, "bannerUrl" = $6, "bannerBlurhash" = $7 WHERE id = $1`,
    [user.id, ...cols],
  );
  return { created };
}

/**
 * Resolve + upsert a remote actor (user, user_profile, user_publickey).
 * Refreshes when lastFetchedAt is older than 1 day or `refresh`.
 */
export async function resolveRemoteUser(
  env: ApiEnv,
  uri: string,
  opts: { refresh?: boolean; object?: ApObject; movePreventUris?: string[] } = {},
): Promise<RemoteUser> {
  if (parseLocalUserUri(env, uri)) throw new ApPermanentError("local uri");
  const existing = await findRemoteUserByUri(env, uri);
  if (existing && !opts.refresh && existing.lastFetchedAt && Date.now() - existing.lastFetchedAt.getTime() < 86400_000) {
    return existing;
  }
  const actor = opts.object && getApId(opts.object) === uri ? opts.object : await apGet(env, uri);
  if (!isActor(actor)) throw new ApPermanentError("not an actor");
  const id = getApId(actor);
  if (!id || new URL(id).host !== new URL(uri).host) throw new ApPermanentError("actor id host mismatch");
  const username = typeof actor.preferredUsername === "string" ? actor.preferredUsername : null;
  if (!username || !/^[\w.-]{1,128}$/.test(username)) throw new ApPermanentError("bad preferredUsername");
  const host = new URL(id).host.toLowerCase();
  const endpoints = (actor.endpoints ?? {}) as ApObject;
  const sharedInbox = (typeof endpoints.sharedInbox === "string" ? endpoints.sharedInbox : null) ?? (typeof actor.sharedInbox === "string" ? actor.sharedInbox : null);
  const inbox = typeof actor.inbox === "string" ? actor.inbox : null;
  if (!inbox || !isSafeRemoteUrl(inbox)) throw new ApPermanentError("bad inbox");
  const pk = (actor.publicKey ?? {}) as ApObject;
  const icon = actor.icon as ApObject | undefined;
  const fields = {
    name: typeof actor.name === "string" ? actor.name.slice(0, 128) : null,
    inbox,
    sharedInbox: sharedInbox && isSafeRemoteUrl(sharedInbox) ? sharedInbox : null,
    featured: getApId(actor.featured),
    followersUri: getApId(actor.followers),
    isBot: getApType(actor) === "Service" || getApType(actor) === "Application",
    isLocked: actor.manuallyApprovesFollowers === true,
    isCat: actor.isCat === true,
    avatarUrl: icon && typeof icon.url === "string" ? icon.url : null,
    description: htmlToText(typeof actor._misskey_summary === "string" ? actor._misskey_summary : typeof actor.summary === "string" ? actor.summary : null),
    url: getApId(actor.url),
    fields: analyzeAttachments(actor.attachment),
    // ApPersonService: movedTo / alsoKnownAs as given
    movedToUri: typeof actor.movedTo === "string" ? actor.movedTo : null,
    alsoKnownAs: actor.alsoKnownAs != null ? toArray(actor.alsoKnownAs).filter((x): x is string => typeof x === "string") : null,
  };
  let startMove = false;
  let images: { created: string[] } = { created: [] };
  const out = await withHyperdriveClient(env.HYPERDRIVE!, async (c) => {
    let userId: string;
    const found = await c.query(
      `SELECT id, "movedToUri", to_jsonb(u) ->> 'movedAt' AS "movedAt" FROM "user" u
       WHERE uri = $1 OR ("usernameLower" = $2 AND host = $3) LIMIT 1`,
      [id, username.toLowerCase(), host],
    );
    if (found.rows[0]) {
      userId = String(found.rows[0].id);
      const prevMovedTo = (found.rows[0].movedToUri as string | null) ?? null;
      const prevMovedAt = found.rows[0].movedAt ? Date.parse(String(found.rows[0].movedAt)) : null;
      // updatePerson: none → some, or some → another one, is a move (some → none is ignored)
      const moving = (prevMovedTo === null && Boolean(fields.movedToUri)) || (prevMovedTo !== null && fields.movedToUri !== null && prevMovedTo !== fields.movedToUri);
      await c.query(
        `UPDATE "user" SET name=$2, inbox=$3, "sharedInbox"=$4, featured=$5, "followersUri"=$6, "isBot"=$7,
           "isLocked"=$8, "isCat"=$9, "avatarUrl"=$10, uri=$11, "movedToUri"=$12, "alsoKnownAs"=$13,
           "lastFetchedAt"=now(), "updatedAt"=now() WHERE id=$1`,
        [userId, fields.name, fields.inbox, fields.sharedInbox, fields.featured, fields.followersUri, fields.isBot, fields.isLocked, fields.isCat, fields.avatarUrl, id, fields.movedToUri, toSimpleArray(fields.alsoKnownAs)],
      );
      if (moving) await c.query(`UPDATE "user" SET "movedAt" = now() WHERE id = $1`, [userId]);
      await c.query(`UPDATE user_profile SET description=$2, url=$3, fields=$4 WHERE "userId"=$1`, [userId, fields.description, fields.url, JSON.stringify(fields.fields)]);
      // the move is processed on the first move, or when the previous one is over 14 days old
      startMove = moving && (prevMovedAt == null || prevMovedAt + 14 * 86400_000 < Date.now());
    } else {
      userId = genAidx(Date.now());
      await c.query(
        `INSERT INTO "user" (id, username, "usernameLower", host, name, inbox, "sharedInbox", featured, uri,
           "followersUri", "isBot", "isLocked", "isCat", "avatarUrl", "movedToUri", "alsoKnownAs", "lastFetchedAt")
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,now())`,
        [userId, username, username.toLowerCase(), host, fields.name, fields.inbox, fields.sharedInbox, fields.featured, id, fields.followersUri, fields.isBot, fields.isLocked, fields.isCat, fields.avatarUrl, fields.movedToUri, toSimpleArray(fields.alsoKnownAs)],
      );
      // createPerson: movedAt when it already has a movedTo (no move processing)
      if (fields.movedToUri) await c.query(`UPDATE "user" SET "movedAt" = now() WHERE id = $1`, [userId]);
      await c.query(
        `INSERT INTO user_profile ("userId", description, url, fields, "userHost") VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
        [userId, fields.description, fields.url, JSON.stringify(fields.fields), host],
      );
      await bumpInstanceC(c, host, "usersCount", 1); // ApPersonService.createPerson: instance stats
    }
    // ApPersonService.resolveAvatarAndBanner: icon / image as link drive files
    images = await resolveAvatarAndBannerC(c, env, { id: userId, host }, actor.icon, actor.image);
    if (typeof pk.id === "string" && typeof pk.publicKeyPem === "string") {
      await c.query(
        `INSERT INTO user_publickey ("userId", "keyId", "keyPem") VALUES ($1,$2,$3)
         ON CONFLICT ("userId") DO UPDATE SET "keyId" = EXCLUDED."keyId", "keyPem" = EXCLUDED."keyPem"`,
        [userId, pk.id, pk.publicKeyPem],
      );
    }
    return {
      id: userId,
      uri: id,
      host,
      username,
      inbox: fields.inbox,
      sharedInbox: fields.sharedInbox,
      followersUri: fields.followersUri,
      isLocked: fields.isLocked,
      movedToUri: fields.movedToUri,
      alsoKnownAs: fields.alsoKnownAs,
    };
  });
  if (images.created.length) {
    // md5 / type / blurhash of the new avatar and banner files (the job copies the blurhash to the user)
    const { enqueueRemoteFile } = await import("./remote-file.js");
    for (const id of images.created) await enqueueRemoteFile(env, id).catch(() => undefined);
  }
  // ApPersonService.createPerson / updatePerson: refresh the pinned notes (mk-jobs, errors logged)
  if (fields.featured) {
    const { enqueueUpdateFeatured } = await import("./featured.js");
    await enqueueUpdateFeatured(env, out.id).catch((e) => console.warn(`featured ${out.id}: ${e instanceof Error ? e.message : String(e)}`));
  }
  if (startMove) {
    // ApPersonService.processRemoteMove (errors are logged, as upstream)
    try {
      const { processRemoteMove } = await import("../account-move-pg.js");
      const r = await processRemoteMove(env, out.id, opts.movePreventUris ?? []);
      console.log(`Processing Move Finished [${r}] @${out.username}@${out.host}`);
    } catch (e) {
      console.warn(`Processing Move Failed @${out.username}@${out.host}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return out;
}

/**
 * WebfingerService.webfinger + RemoteUserResolveService.resolveSelf: the `self` link (rel only,
 * case-insensitive), with checks upstream does not make:
 * - redirects are followed only to another safe WebFinger URL for the same `resource` (a domain
 *   that serves WebFinger from another host, e.g. Mastodon's WEB_DOMAIN, still works);
 * - an `acct:` subject must be the account asked for;
 * - `self` must be on the asked host or on the host that answered, and never this server
 *   (upstream maps a link back here to the local user).
 */
export async function webfingerSelf(env: ApiEnv, acctLower: string): Promise<string> {
  const host = acctLower.slice(acctLower.indexOf("@") + 1);
  const resource = `acct:${acctLower}`;
  const url = `https://${host}/.well-known/webfinger?resource=${encodeURIComponent(resource)}`;
  const isWebfinger = (u: URL) => isSafeRemoteUrl(u.href) && u.pathname === "/.well-known/webfinger" && u.searchParams.get("resource")?.toLowerCase() === resource;
  const { res, url: answered } = await fetchChecked(fetcher(env), url, { headers: { Accept: "application/jrd+json, application/json", "User-Agent": "misskey-cf" }, signal: AbortSignal.timeout(REMOTE_FETCH_TIMEOUT_MS) }, { check: isWebfinger }).catch((e) => {
    throw e instanceof UnsafeUrlError ? new ApPermanentError(`Failed to WebFinger for ${acctLower}: unsafe url`) : e;
  });
  if (!res.ok) throw new Error(`Failed to WebFinger for ${acctLower}: ${res.status}`);
  const text = await readCappedText(res, WEBFINGER_MAX_BYTES).catch((e) => {
    throw e instanceof BodyTooLargeError ? new ApPermanentError(`Failed to WebFinger for ${acctLower}: too large`) : e;
  });
  const jrd = JSON.parse(text) as { subject?: unknown; links?: { rel?: string; href?: string }[] };
  if (typeof jrd.subject === "string" && jrd.subject.toLowerCase().startsWith("acct:") && jrd.subject.toLowerCase() !== resource) {
    throw new ApPermanentError(`Failed to WebFinger for ${acctLower}: subject mismatch`);
  }
  const self = (jrd.links ?? []).find((l) => l.rel != null && l.rel.toLowerCase() === "self");
  if (!self || typeof self.href !== "string") throw new Error("self link not found");
  if (!isSafeRemoteUrl(self.href) || parseLocalUserUri(env, self.href)) throw new ApPermanentError(`Failed to WebFinger for ${acctLower}: bad self link`);
  const selfHost = new URL(self.href).hostname.toLowerCase();
  if (selfHost !== host && selfHost !== new URL(answered).hostname.toLowerCase()) {
    throw new ApPermanentError(`Failed to WebFinger for ${acctLower}: self link on another host`);
  }
  return self.href;
}

/**
 * RemoteUserResolveService.resolveUser for a remote acct: an unknown account is found over
 * WebFinger ({@link webfingerSelf}), a known one is returned as is unless it was
 * last fetched over a day ago, in which case WebFinger is asked again, a changed `self` URI on the
 * same host is written back, and the person is re-fetched.
 */
export async function resolveRemoteAcct(env: ApiEnv, username: string, host: string): Promise<{ id: string; local: boolean }> {
  const usernameLower = username.toLowerCase();
  host = host.toLowerCase();
  const acctLower = `${usernameLower}@${host}`;
  const known = await withHyperdriveClient(env.HYPERDRIVE!, async (c) =>
    (await c.query(`SELECT id, uri, "lastFetchedAt" FROM "user" WHERE "usernameLower" = $1 AND host = $2 LIMIT 1`, [usernameLower, host])).rows[0],
  );
  if (!known) {
    const href = await webfingerSelf(env, acctLower);
    return { id: (await resolveRemoteUser(env, href)).id, local: false };
  }
  const last = known.lastFetchedAt ? new Date(String(known.lastFetchedAt)).getTime() : null;
  if (last == null || Date.now() - last > 86400_000) {
    await withHyperdriveClient(env.HYPERDRIVE!, (c) => c.query(`UPDATE "user" SET "lastFetchedAt" = now() WHERE id = $1`, [known.id]));
    const href = await webfingerSelf(env, acctLower);
    if (known.uri !== href) {
      if (new URL(href).hostname !== host) throw new Error("Invalid uri");
      await withHyperdriveClient(env.HYPERDRIVE!, (c) => c.query(`UPDATE "user" SET uri = $3 WHERE "usernameLower" = $1 AND host = $2`, [usernameLower, host, href]));
    }
    await resolveRemoteUser(env, href, { refresh: true });
    const row = await withHyperdriveClient(env.HYPERDRIVE!, async (c) => (await c.query(`SELECT id FROM "user" WHERE uri = $1 LIMIT 1`, [href])).rows[0]);
    if (!row) throw new Error("user not found");
    return { id: String(row.id), local: false };
  }
  return { id: String(known.id), local: false };
}

/**
 * A signing key: its PEM, and `confirm()` for the signer once the signature has been verified with
 * it. A key already stored answers with its user. An unknown key (or `refresh`) is read from the
 * owner actor without saving anything; `confirm()` saves the actor, so a request whose signature
 * fails leaves no user behind.
 */
export type SigningKey = { keyPem: string; confirm(): Promise<RemoteUser | null> };

/**
 * keyId → its key. null when it is unknown and the owner actor cannot be read (any failure: an
 * unknown key's fetch is not retried) or does not publish that key.
 */
export async function getPublicKeyByKeyId(env: ApiEnv, keyId: string, refresh = false): Promise<SigningKey | null> {
  if (!refresh) {
    const cached = signingKeys.get(keyId);
    if (cached && Date.now() - cached.at < SIGNING_KEY_TTL_MS) return { keyPem: cached.keyPem, confirm: async () => cached.user };
    const hit = await withHyperdriveClient(env.HYPERDRIVE!, async (c) => {
      const r = await c.query(
        `SELECT k."keyPem", u.id, u.uri, u.host, u.username, u.inbox, u."sharedInbox", u."followersUri", u."isLocked", u."movedToUri"
         FROM user_publickey k JOIN "user" u ON u.id = k."userId" WHERE k."keyId" = $1 LIMIT 1`,
        [keyId],
      );
      return r.rows[0] ?? null;
    });
    if (hit) {
      const user = rowToRemote(hit);
      rememberSigningKey(keyId, user, String(hit.keyPem));
      return { keyPem: String(hit.keyPem), confirm: async () => user };
    }
  }
  signingKeys.delete(keyId);
  const actorUri = keyId.split("#")[0]!;
  let actor: ApObject;
  try {
    actor = await apGet(env, actorUri);
  } catch (e) {
    console.warn(`signing key ${keyId}: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
  const pk = (actor.publicKey ?? {}) as ApObject;
  if (pk.id !== keyId || typeof pk.publicKeyPem !== "string") return null;
  return {
    keyPem: pk.publicKeyPem,
    confirm: async () => {
      // the same checks and upsert as any other fetch of the actor, from the object already read
      const user = await resolveRemoteUser(env, actorUri, { refresh: true, object: actor }).catch((e) => {
        if (e instanceof ApPermanentError) return null;
        throw e;
      });
      if (!user) return null;
      const row = await withHyperdriveClient(env.HYPERDRIVE!, async (c) =>
        (await c.query(`SELECT "keyId" FROM user_publickey WHERE "userId" = $1`, [user.id])).rows[0] ?? null,
      );
      if (!row || String(row.keyId) !== keyId) return null;
      rememberSigningKey(keyId, user, String(pk.publicKeyPem));
      return user;
    },
  };
}

/**
 * Stored signing keys per isolate: a busy sender's every activity looked its key up in
 * PostgreSQL. Kept briefly: a rotated key fails verification and is read again with `refresh`,
 * and changes to the signer (moves, deletions) are seen within the minute.
 */
const SIGNING_KEY_TTL_MS = 60_000;
const SIGNING_KEY_MAX = 5000;
const signingKeys = new Map<string, { user: RemoteUser; keyPem: string; at: number }>();

function rememberSigningKey(keyId: string, user: RemoteUser, keyPem: string): void {
  signingKeys.delete(keyId);
  if (signingKeys.size >= SIGNING_KEY_MAX) signingKeys.delete(signingKeys.keys().next().value!);
  signingKeys.set(keyId, { user, keyPem, at: Date.now() });
}

/** Tests: forget the cached signing keys. */
export function resetSigningKeyCache(): void {
  signingKeys.clear();
}
