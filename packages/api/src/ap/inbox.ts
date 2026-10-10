/**
 * mk-inbox consumer (subset of upstream InboxProcessorService + ApInboxService).
 * Verifies HTTP Signature (key owner must be the activity actor; otherwise an RsaSignature2017
 * LD signature by the actor, as relays forward others' activities), then applies
 * Follow/Accept/Reject/Undo/Like/Create/Announce/Delete/Block/Update/Move to PG,
 * notifications, timeline fanout, and Accept/Reject replies.
 */

import { genAidx } from "../../../id/src/index.js";
import {
  getApId,
  getApType,
  idList,
  importSpkiPem,
  isActor,
  isPost,
  likeReaction,
  noteText,
  parseActivity,
  parseVisibility,
  precheckIncoming,
  renderAccept,
  renderReject,
  sameHost,
  verifyRequest,
  type ApObject,
  type InboxActivity,
} from "../../../ap/src/index.js";
import type { ApiEnv } from "../env.js";
import { buildPackConfig } from "../meta-source.js";
import { createNoteRow, defaultTimelineKeysForCreate } from "../notes/row.js";
import { deleteNotePg, getNotePg, insertNotePg, packNoteFromPg } from "../notes-pg.js";
import { withHyperdriveClient } from "../pg.js";
import { buildFanoutMessage, getQueueProducer, MK_TIMELINE_FANOUT, streamExtras } from "../queues/fanout.js";
import { reactPg, unreactPg } from "../reactions-pg.js";
import * as g from "../graph-pg.js";
import { createNotification } from "../notifications-do.js";
import { enqueueDeliver, localActorUri } from "./deliver.js";
import { getFederationPolicy, hostAllowed, hostOf } from "./federation.js";
import { bumpInstance, instanceRequestReceived } from "./instances.js";
import { isRelayActor, relayAnswered, relayIdOfFollow } from "./relay.js";
import { JsonLd, JsonLdError } from "./ld-signature.js";
import { onFeaturedChange } from "./featured.js";
import { extractApHashtags, extractEmojis, extractPollFromQuestion, resolveAttachments, updateQuestion, voteFromAp } from "./remote-note.js";
import { normalizeForSearch, updateHashtagsPg } from "../search-pg.js";
import {
  ApPermanentError,
  apGet,
  findRemoteUserByUri,
  getPublicKeyByKeyId,
  type SigningKey,
  parseLocalNoteUri,
  parseLocalUserUri,
  resolveRemoteUser,
  type RemoteUser,
} from "./remote.js";

/** One-line description of an inbox message for logs: activity type (and the object's type), actor host. */
export function describeInboxMessage(msg: InboxMessage): string {
  try {
    const a = JSON.parse(msg.body) as { type?: unknown; actor?: unknown; object?: unknown };
    const obj = a.object && typeof a.object === "object" ? (a.object as { type?: unknown }).type : null;
    const actor = typeof a.actor === "string" ? a.actor : a.actor && typeof a.actor === "object" ? (a.actor as { id?: unknown }).id : null;
    let host = "?";
    try {
      host = new URL(String(actor)).host;
    } catch {
      /* keep ? */
    }
    return `${String(a.type)}${typeof obj === "string" ? `(${obj})` : ""} from ${host}`;
  } catch {
    return "unparsable";
  }
}

export type InboxMessage = {
  kind: "inbox";
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
  receivedAt: number;
  /** Set when the activity was also processed at once (fast-path.ts): the queued copy is a backup. */
  fast?: string;
};

export type InboxOutcome = { ok: boolean; reason: string };

/** Verify signature; returns the signing remote user. `fatal` errors rule out an LD-signature fallback. */
export async function verifyInbox(env: ApiEnv, msg: InboxMessage): Promise<{ user: RemoteUser } | { error: string; fatal?: boolean }> {
  const expectedHost = buildPackConfig(env).host;
  const pre = await precheckIncoming({
    method: msg.method,
    headers: msg.headers,
    body: msg.body,
    expectedHost,
    now: new Date(msg.receivedAt),
  });
  if (!pre.ok) return { error: pre.reason, fatal: true };
  const check = async (refresh: boolean) => {
    const k = await getPublicKeyByKeyId(env, pre.keyId, refresh);
    if (!k) return null;
    const key = await importSpkiPem(k.keyPem);
    const ok = await verifyRequest({
      publicKey: key,
      method: msg.method,
      pathWithQuery: msg.path,
      headers: msg.headers,
      signatureHeader: msg.headers["signature"] ?? "",
    });
    // the signer is stored only now that the signature holds
    return ok ? k.confirm() : null;
  };
  // key rotation: one refresh retry
  const user = (await check(false)) ?? (await check(true));
  if (!user) return { error: "signature_invalid" };
  return { user };
}

export async function processInbox(env: ApiEnv, msg: InboxMessage): Promise<InboxOutcome> {
  const policy = await getFederationPolicy(env);
  if (policy.mode === "none") return { ok: false, reason: "federation_none" };
  let json: unknown;
  try {
    json = JSON.parse(msg.body);
  } catch {
    return { ok: false, reason: "bad_json" };
  }
  let activity = parseActivity(json);
  if (!activity) return { ok: false, reason: "bad_activity" };
  if (!hostAllowed(policy, hostOf(activity.actor))) return { ok: false, reason: "host_blocked" };
  const v = await verifyInbox(env, msg);
  if ("error" in v && v.fatal) return { ok: false, reason: v.error };
  let signer = "user" in v ? v.user : null;
  // upstream InboxProcessorService: the HTTP signer must be the actor; otherwise an LD signature may vouch for it
  if (!signer || signer.uri !== activity.actor) {
    const ld = (json as ApObject).signature;
    if (!ld || typeof ld !== "object") return { ok: false, reason: signer ? "actor_signer_mismatch" : "error" in v ? v.error : "signature_invalid" };
    // a relayed copy of a post already stored: processing it after the LD signature (JSON-LD
    // compaction and two normalizations) would only find the note. Nothing is trusted from
    // the unverified copy; it is just not processed.
    if (activity.type === "Create") {
      const objectId = getApId(activity.object);
      if (objectId && sameHost(objectId, activity.actor) && (await findNoteIdByUri(env, objectId))) return { ok: true, reason: "create_known" };
    }
    const r = await verifyLdSignature(env, json as ApObject);
    if ("error" in r) return { ok: false, reason: r.error };
    if (!hostAllowed(policy, r.user.host)) return { ok: false, reason: "host_blocked" };
    signer = r.user;
    activity = parseActivity(r.activity);
    if (!activity) return { ok: false, reason: "bad_activity" };
  }
  if (activity.id && !sameHost(activity.id, activity.actor)) return { ok: false, reason: "activity_id_host_mismatch" };
  await instanceRequestReceived(env, signer.host); // InboxProcessorService: instance stats / metadata
  return applyActivity(env, signer, activity);
}

/**
 * InboxProcessorService LD-signature branch: RsaSignature2017 only; the creator key's owner is
 * resolved, the activity (without `signature`) compacted with upstream's context and checked for
 * forbidden directives, the context cache frozen, the signature verified, and the owner must be
 * the (compacted) activity's actor. Returns the compacted activity.
 */
export async function verifyLdSignature(env: ApiEnv, raw: ApObject): Promise<{ user: RemoteUser; activity: ApObject } | { error: string }> {
  const ld = raw.signature as Record<string, unknown>;
  if (ld.type !== "RsaSignature2017") return { error: `ld_unsupported_type_${String(ld.type)}` };
  const creator = typeof ld.creator === "string" ? ld.creator : null;
  if (!creator) return { error: "ld_no_creator" };
  let auth: SigningKey | null = null;
  try {
    auth = await getPublicKeyByKeyId(env, creator);
  } catch {
    auth = null;
  }
  if (!auth) return { error: "ld_user_unresolved" };
  const jsonLd = new JsonLd(env.AP_FETCH ?? fetch);
  let activity: ApObject;
  try {
    const { signature: _drop, ...rest } = raw;
    activity = await jsonLd.compact(rest);
    jsonLd.checkForForbiddenDirectives(activity);
  } catch (e) {
    return { error: `ld_compact_failed: ${e instanceof Error ? e.message : String(e)}` };
  }
  activity.signature = ld;
  jsonLd.freeze();
  try {
    if (!(await jsonLd.verifyRsaSignature2017(activity, auth.keyPem))) return { error: "ld_signature_invalid" };
  } catch (e) {
    if (e instanceof JsonLdError) return { error: `ld_error: ${e.message}` };
    throw e;
  }
  // the creator is stored only now that the signature holds
  const signer = await auth.confirm();
  if (!signer) return { error: "ld_user_unresolved" };
  if (signer.uri !== getApId(activity.actor)) return { error: "ld_actor_mismatch" };
  delete activity.signature;
  return { user: signer, activity };
}

/** Dispatch a verified activity. Exported for tests. */
export async function applyActivity(env: ApiEnv, actor: RemoteUser, a: InboxActivity): Promise<InboxOutcome> {
  switch (a.type) {
    case "Follow":
      return onFollow(env, actor, a);
    case "Accept":
      return onAccept(env, actor, a);
    case "Reject":
      return onReject(env, actor, a);
    case "Undo":
      return onUndo(env, actor, a);
    case "Like":
    case "EmojiReact":
      return onLike(env, actor, a);
    case "Create":
      return onCreate(env, actor, a);
    case "Announce":
      return onAnnounce(env, actor, a);
    case "Delete":
      return onDelete(env, actor, a);
    case "Block":
      return onBlock(env, actor, a);
    case "Move":
      return onMove(env, actor, a);
    case "Update":
      return onUpdate(env, actor, a);
    case "Add":
    case "Remove":
      return onFeaturedChange(env, actor, a);
    default:
      return { ok: true, reason: `unsupported_${a.type}` };
  }
}

function localUserFromUri(env: ApiEnv, uri: string | null): string | null {
  return uri ? parseLocalUserUri(env, uri) : null;
}

async function onFollow(env: ApiEnv, actor: RemoteUser, a: InboxActivity): Promise<InboxOutcome> {
  const followeeId = localUserFromUri(env, getApId(a.object));
  if (!followeeId) return { ok: false, reason: "follow_target_not_local" };
  const followeeUri = localActorUri(env, followeeId);
  const followObj = { id: a.id, type: "Follow", actor: actor.uri, object: followeeUri };
  const inbox = actor.inbox ?? actor.sharedInbox;
  const r = await g.followWithPolicy(env, actor.id, followeeId, { requestId: a.id });
  if (r === "blocking" || r === "blocked") {
    await enqueueDeliver(env, followeeId, [inbox], renderReject(followObj, followeeUri));
    return { ok: true, reason: "follow_rejected_block" };
  }
  if (r === "no_such_user") return { ok: false, reason: "no_such_user" };
  if (r === "requested") {
    await createNotification(env, followeeId, { type: "receiveFollowRequest", notifierId: actor.id });
    return { ok: true, reason: "follow_requested" };
  }
  if (r === "already_requested") return { ok: true, reason: "follow_already_requested" };
  if (r === "followed") {
    await createNotification(env, followeeId, { type: "follow", notifierId: actor.id });
    const { webhooksForFollow } = await import("../webhooks-pg.js");
    await webhooksForFollow(env, actor.id, followeeId);
  }
  // followed or already_following → (re-)Accept
  await enqueueDeliver(env, followeeId, [inbox], renderAccept(followObj, followeeUri));
  return { ok: true, reason: r === "followed" ? "followed" : "already_following" };
}

/** Follow object (embedded or id) → local follower id for Accept/Reject. */
function localFollowerFromFollowObject(env: ApiEnv, obj: unknown): string | null {
  if (obj && typeof obj === "object") {
    const id = localUserFromUri(env, getApId((obj as ApObject).actor));
    if (id) return id;
  }
  const id = getApId(obj);
  if (id) {
    // our Follow ids: {base}/follows/{followerId}/{followeeId}
    const m = /\/follows\/([0-9a-z]+)\/([0-9a-z]+)$/.exec(id);
    if (m) return m[1]!;
  }
  return null;
}

async function onAccept(env: ApiEnv, actor: RemoteUser, a: InboxActivity): Promise<InboxOutcome> {
  const relayId = relayIdOfFollow(env, a.object);
  if (relayId) return { ok: true, reason: (await relayAnswered(env, relayId, actor, "accepted")) ? "relay_accepted" : "relay_noop" };
  const followerId = localFollowerFromFollowObject(env, a.object);
  if (!followerId) return { ok: false, reason: "accept_unknown_follow" };
  const ok = await g.acceptRequest(env, actor.id, followerId);
  if (ok) await createNotification(env, followerId, { type: "followRequestAccepted", notifierId: actor.id });
  return { ok: true, reason: ok ? "follow_accepted" : "accept_noop" };
}

async function onReject(env: ApiEnv, actor: RemoteUser, a: InboxActivity): Promise<InboxOutcome> {
  const relayId = relayIdOfFollow(env, a.object);
  if (relayId) return { ok: true, reason: (await relayAnswered(env, relayId, actor, "rejected")) ? "relay_rejected" : "relay_noop" };
  const followerId = localFollowerFromFollowObject(env, a.object);
  if (!followerId) return { ok: false, reason: "reject_unknown_follow" };
  await g.deleteRequest(env, followerId, actor.id);
  await g.unfollow(env, followerId, actor.id);
  return { ok: true, reason: "follow_rejected" };
}

async function findNoteIdByUri(env: ApiEnv, uri: string): Promise<string | null> {
  const local = parseLocalNoteUri(env, uri);
  if (local) return local;
  return withHyperdriveClient(env.HYPERDRIVE!, async (c) => {
    const r = await c.query(`SELECT id FROM note WHERE uri = $1 LIMIT 1`, [uri]);
    return r.rows[0] ? String(r.rows[0].id) : null;
  });
}

async function onUndo(env: ApiEnv, actor: RemoteUser, a: InboxActivity): Promise<InboxOutcome> {
  let obj = a.object;
  if (typeof obj === "string") {
    // Bare id: only Follow ids are resolvable without fetching; try following/requests by actor
    obj = { id: obj, type: null };
  }
  const o = obj as ApObject;
  const t = getApType(o);
  if (t === "Follow" || (t == null && getApId(o.object))) {
    const followeeId = localUserFromUri(env, getApId(o.object));
    if (!followeeId) return { ok: false, reason: "undo_follow_target_not_local" };
    const a1 = await g.unfollow(env, actor.id, followeeId);
    const a2 = await g.deleteRequest(env, actor.id, followeeId);
    return { ok: true, reason: a1 || a2 ? "unfollowed" : "undo_follow_noop" };
  }
  if (t === "Like" || t === "EmojiReact") {
    const noteUri = getApId(o.object);
    const noteId = noteUri ? await findNoteIdByUri(env, noteUri) : null;
    if (!noteId) return { ok: true, reason: "undo_like_unknown_note" };
    await unreactPg(env, { noteId, userId: actor.id });
    return { ok: true, reason: "unreacted" };
  }
  if (t === "Announce") {
    const id = getApId(o);
    if (!id) return { ok: false, reason: "undo_announce_no_id" };
    const noteId = await findNoteIdByUri(env, id);
    if (!noteId) return { ok: true, reason: "undo_announce_unknown" };
    await deleteRemoteNote(env, noteId, actor);
    return { ok: true, reason: "unrenoted" };
  }
  if (t === "Block") {
    const blockeeId = localUserFromUri(env, getApId(o.object));
    if (blockeeId) await g.unblock(env, actor.id, blockeeId);
    return { ok: true, reason: "unblocked" };
  }
  return { ok: true, reason: `undo_unsupported_${t}` };
}

async function onLike(env: ApiEnv, actor: RemoteUser, a: InboxActivity): Promise<InboxOutcome> {
  const noteUri = getApId(a.object);
  const noteId = noteUri ? await findNoteIdByUri(env, noteUri) : null;
  if (!noteId) return { ok: true, reason: "like_unknown_note" };
  const note = await getNotePg(env, noteId);
  if (!note) return { ok: true, reason: "like_unknown_note" };
  if (await g.isBlocking(env, note.userId, actor.id)) return { ok: true, reason: "like_blocked" };
  const reaction = likeReaction(a.raw, actor.host);
  const r = await reactPg(env, { noteId, userId: actor.id, reaction });
  if (!r.ok) return { ok: true, reason: `like_${r.code}` };
  if (note.userHost == null) {
    await createNotification(env, note.userId, { type: "reaction", notifierId: actor.id, noteId, reaction });
  }
  return { ok: true, reason: "reacted" };
}

/**
 * insertNotePg for an inbound note: a value too long for its column (SQLSTATE 22001, e.g. a
 * summary over 512 characters) fails the same way on every retry, so it is not retried.
 */
async function storeRemoteNote(env: ApiEnv, note: Parameters<typeof insertNotePg>[1], opts?: Parameters<typeof insertNotePg>[2]) {
  try {
    return await insertNotePg(env, note, opts);
  } catch (e) {
    if ((e as { code?: unknown })?.code === "22001") throw new ApPermanentError(`note not storable: ${e instanceof Error ? e.message : String(e)}`);
    throw e;
  }
}

async function fanoutNote(env: ApiEnv, note: NonNullable<Awaited<ReturnType<typeof insertNotePg>>>): Promise<void> {
  let packed: unknown;
  try {
    packed = await packNoteFromPg(env, note, buildPackConfig(env));
  } catch {
    packed = undefined; // streaming is best-effort
  }
  await getQueueProducer(env).send(
    MK_TIMELINE_FANOUT,
    buildFanoutMessage(note.id, defaultTimelineKeysForCreate(note), "create", {
      authorId: note.userId,
      visibility: note.visibility,
      visibleUserIds: note.visibleUserIds,
      packed,
      ...streamExtras(note),
    }),
  );
}

async function deleteRemoteNote(env: ApiEnv, noteId: string, actor: RemoteUser): Promise<boolean> {
  const note = await getNotePg(env, noteId);
  if (!note || note.userId !== actor.id) return false;
  // NoteDeleteService.delete (stream + row + timeline fanout delete)
  await deleteNotePg(env, note);
  await bumpInstance(env, actor.host, "notesCount", -1);
  return true;
}

/**
 * Store a remote post (idempotent by uri). Resolves a reply parent up to
 * `depth` hops. Returns the local note id.
 */
export async function createRemoteNote(env: ApiEnv, obj: ApObject, author: RemoteUser, depth = 2, out: { voted?: boolean } = {}): Promise<string | null> {
  const uri = getApId(obj);
  if (!uri || !isPost(obj)) return null;
  if (!sameHost(uri, author.uri)) throw new ApPermanentError("note id host mismatch");
  if (getApId(obj.attributedTo) !== author.uri) throw new ApPermanentError("attributedTo mismatch");
  const existing = await findNoteIdByUri(env, uri);
  if (existing) return existing;

  let replyId: string | null = null;
  const inReplyTo = getApId(obj.inReplyTo);
  if (inReplyTo) {
    replyId = await findNoteIdByUri(env, inReplyTo);
    if (!replyId && depth > 0) replyId = await resolveNoteByUri(env, inReplyTo, depth - 1);
  }
  const quoteUri = getApId(obj._misskey_quote) ?? getApId(obj.quoteUrl) ?? getApId(obj.quoteUri);
  let renoteId: string | null = null;
  if (quoteUri) {
    renoteId = await findNoteIdByUri(env, quoteUri);
    if (!renoteId && depth > 0) renoteId = await resolveNoteByUri(env, quoteUri, depth - 1);
  }

  // vote: a reply carrying `name` to a poll (ApNoteService.createNote → PollService.vote)
  if (replyId && typeof obj.name === "string") {
    const reply = await getNotePg(env, replyId);
    if (reply?.hasPoll) {
      const choice = await voteFromAp(env, author, reply, obj.name);
      out.voted = choice != null;
      // PollService.deliverQuestionUpdate: the local poll's new counts to its remote followers
      if (choice != null && reply.userHost == null) {
        const { deliverQuestionUpdate } = await import("./outbound.js");
        await deliverQuestionUpdate(env, reply);
      }
      return null;
    }
  }

  const visibility = parseVisibility(obj, author.followersUri);
  const addressed = [...idList(obj.to), ...idList(obj.cc)];
  const mentionHrefs = (Array.isArray(obj.tag) ? obj.tag : [])
    .filter((t) => getApType(t) === "Mention")
    .map((t) => getApId((t as ApObject).href))
    .filter((x): x is string => Boolean(x));
  const mentions = [...new Set(mentionHrefs.map((h) => localUserFromUri(env, h)).filter((x): x is string => Boolean(x)))];
  const visibleUserIds =
    visibility === "specified"
      ? [...new Set(addressed.map((h) => localUserFromUri(env, h)).filter((x): x is string => Boolean(x)))]
      : [];

  const poll = extractPollFromQuestion(obj);
  const files = await resolveAttachments(env, author, obj);
  const emojis = await extractEmojis(env, obj.tag, author.host).catch((e) => {
    console.log(`extractEmojis: ${e instanceof Error ? e.message : String(e)}`);
    return [] as string[];
  });
  // NoteCreateService: ≤128 chars each, first 32, stored normalized
  const tags = extractApHashtags(obj.tag).filter((t) => Array.from(t).length <= 128).splice(0, 32);

  const published = Date.parse(typeof obj.published === "string" ? obj.published : "");
  const t = Number.isFinite(published) ? Math.min(published, Date.now()) : Date.now();
  const note = createNoteRow(author.id, { text: noteText(obj) ?? "", visibility }, genAidx(t));
  note.text = noteText(obj);
  note.name = typeof obj.name === "string" ? obj.name : null;
  note.cw = typeof obj.summary === "string" && obj.summary.length > 0 ? obj.summary : null;
  note.uri = uri;
  note.url = getApId(obj.url);
  note.userHost = author.host;
  note.replyId = replyId;
  note.renoteId = renoteId;
  note.mentions = mentions;
  note.visibleUserIds = visibleUserIds;
  note.localOnly = false;
  note.fileIds = files.map((f) => f.id);
  note.emojis = emojis;
  note.tags = tags.map(normalizeForSearch);
  note.hasPoll = poll != null;
  const created = await storeRemoteNote(env, note, {
    attachedFileTypes: files.map((f) => f.type),
    poll: poll ? { choices: poll.choices, multiple: poll.multiple, expiresAt: poll.expiresAt } : null,
  });
  // stored meanwhile by another copy of the activity (ApNoteService: the existing note, no side effects)
  if (!created) return findNoteIdByUri(env, uri);
  await bumpInstance(env, note.userHost, "notesCount", 1); // NoteCreateService: instance stats
  if (visibility === "public" || visibility === "home") {
    try {
      await updateHashtagsPg(env, { id: author.id, host: author.host }, tags);
    } catch (e) {
      console.warn(`hashtag update failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  await fanoutNote(env, note);

  // notifications: reply to a local note, mentions of local users
  const notified = new Set<string>();
  if (note.replyUserId && note.replyUserHost == null) {
    notified.add(note.replyUserId);
    await createNotification(env, note.replyUserId, { type: "reply", notifierId: author.id, noteId: note.id });
  }
  if (renoteId && note.renoteUserId && note.renoteUserHost == null && !notified.has(note.renoteUserId)) {
    notified.add(note.renoteUserId);
    await createNotification(env, note.renoteUserId, { type: "quote", notifierId: author.id, noteId: note.id });
  }
  for (const uid of mentions) {
    if (notified.has(uid)) continue;
    notified.add(uid);
    await createNotification(env, uid, { type: "mention", notifierId: author.id, noteId: note.id });
  }
  return note.id;
}

/** Fetch a post by URI and store it (author resolved first). */
export async function resolveNoteByUri(env: ApiEnv, uri: string, depth = 1, prefetched?: ApObject): Promise<string | null> {
  const known = await findNoteIdByUri(env, uri);
  if (known) return known;
  // `prefetched`: an embedded object the caller already checked to be on the uri's host
  const obj = prefetched ?? (await apGet(env, uri));
  if (!isPost(obj) || getApId(obj) !== uri) return null;
  const authorUri = getApId(obj.attributedTo);
  if (!authorUri) return null;
  const policy = await getFederationPolicy(env);
  if (!hostAllowed(policy, hostOf(authorUri))) return null;
  const author = await resolveRemoteUser(env, authorUri);
  return createRemoteNote(env, obj, author, depth);
}

async function onCreate(env: ApiEnv, actor: RemoteUser, a: InboxActivity): Promise<InboxOutcome> {
  let obj = a.object;
  if (typeof obj === "string") {
    if (!sameHost(obj, actor.uri)) return { ok: false, reason: "create_object_host_mismatch" };
    obj = await apGet(env, obj);
  }
  if (!obj || typeof obj !== "object" || !isPost(obj)) return { ok: true, reason: "create_unsupported_object" };
  const out: { voted?: boolean } = {};
  const id = await createRemoteNote(env, obj as ApObject, actor, 2, out);
  if (out.voted != null) return { ok: true, reason: out.voted ? "voted" : "vote_ignored" };
  return { ok: Boolean(id), reason: id ? "note_created" : "create_skipped" };
}

async function onAnnounce(env: ApiEnv, actor: RemoteUser, a: InboxActivity): Promise<InboxOutcome> {
  const activityId = a.id;
  const targetUri = getApId(a.object);
  if (!activityId || !targetUri) return { ok: false, reason: "announce_bad" };
  if (await isRelayActor(env, actor)) {
    // ApInboxService.announceNote: a relay's Announce stores the note itself, no renote
    if (await findNoteIdByUri(env, targetUri)) return { ok: true, reason: "relay_announce_known" };
    // the target is fetched by id (an embedded copy is not trusted)
    return { ok: true, reason: (await resolveNoteByUri(env, targetUri, 1)) ? "relay_announce_published" : "announce_unresolvable" };
  }
  if (await findNoteIdByUri(env, activityId)) return { ok: true, reason: "announce_duplicate" };
  const targetId = (await findNoteIdByUri(env, targetUri)) ?? (await resolveNoteByUri(env, targetUri, 1));
  if (!targetId) return { ok: true, reason: "announce_unresolvable" };
  const target = await getNotePg(env, targetId);
  if (!target) return { ok: true, reason: "announce_unresolvable" };
  if (target.visibility !== "public" && target.visibility !== "home") return { ok: true, reason: "announce_not_public" };
  if (await g.isBlocking(env, target.userId, actor.id)) return { ok: true, reason: "announce_blocked" };
  const visibility = parseVisibility(a.raw, actor.followersUri);
  const published = Date.parse(typeof a.raw.published === "string" ? a.raw.published : "");
  const note = createNoteRow(actor.id, { renoteId: targetId, visibility }, genAidx(Number.isFinite(published) ? Math.min(published, Date.now()) : Date.now()));
  note.text = null;
  note.uri = activityId;
  note.userHost = actor.host;
  note.visibility = visibility === "specified" ? "followers" : visibility;
  if (!(await storeRemoteNote(env, note))) return { ok: true, reason: "announce_duplicate" };
  await bumpInstance(env, note.userHost, "notesCount", 1); // NoteCreateService: instance stats
  await fanoutNote(env, note);
  if (target.userHost == null) {
    await createNotification(env, target.userId, { type: "renote", notifierId: actor.id, noteId: note.id });
  }
  return { ok: true, reason: "renoted" };
}

/**
 * ApInboxService.delete: the former type (Tombstone formerType, the embedded type, Person when the
 * object is the actor itself, otherwise Note) picks deleteNote or deleteActor.
 */
async function onDelete(env: ApiEnv, actor: RemoteUser, a: InboxActivity): Promise<InboxOutcome> {
  const id = getApId(a.object);
  if (!id) return { ok: false, reason: "delete_bad" };
  let formerType: string | null = null;
  if (a.object && typeof a.object === "object") {
    const o = a.object as ApObject;
    formerType = getApType(o) === "Tombstone" ? (typeof o.formerType === "string" ? o.formerType : getApType({ type: o.formerType })) : getApType(o);
  }
  if (!formerType && id === actor.uri) formerType = "Person";
  formerType ??= "Note";
  if (["Person", "Service", "Organization", "Group", "Application"].includes(formerType)) return deleteActor(env, actor, id);
  if (!["Note", "Question", "Article", "Audio", "Document", "Image", "Page", "Video", "Event"].includes(formerType)) {
    return { ok: true, reason: `delete_unknown_type_${formerType}` };
  }
  const noteId = await findNoteIdByUri(env, id);
  if (!noteId) return { ok: true, reason: "delete_unknown" };
  const ok = await deleteRemoteNote(env, noteId, actor);
  return { ok: true, reason: ok ? "note_deleted" : "delete_not_owner" };
}

/** ApInboxService.deleteActor: mark the remote user deleted once and queue its account deletion. */
async function deleteActor(env: ApiEnv, actor: RemoteUser, uri: string): Promise<InboxOutcome> {
  if (actor.uri !== uri) return { ok: true, reason: "delete_actor_mismatch" };
  const marked = await withHyperdriveClient(env.HYPERDRIVE!, async (c) =>
    (await c.query(`UPDATE "user" SET "isDeleted" = TRUE WHERE id = $1 AND "isDeleted" = FALSE RETURNING id`, [actor.id])).rows.length > 0,
  );
  if (!marked) return { ok: true, reason: "actor_already_deleted" };
  const { enqueueDeleteAccountJob } = await import("../account-delete-pg.js");
  await enqueueDeleteAccountJob(env, actor.id); // QueueService.createDeleteAccountJob(actor): not soft
  return { ok: true, reason: "actor_deleted" };
}

/**
 * ApInboxService.update: Person → ApPersonService.updatePerson, Question →
 * ApQuestionService.updateQuestion (counts of a registered remote poll), anything else skipped.
 * An embedded object is used as is (the resolver does not refetch it); a bare id is fetched.
 */
async function onUpdate(env: ApiEnv, actor: RemoteUser, a: InboxActivity): Promise<InboxOutcome> {
  const id = getApId(a.object);
  if (!id) return { ok: true, reason: "update_bad" };
  if (id === actor.uri) {
    // ApInboxService.update → updatePerson(actor.uri, resolver, object): an embedded Person is used
    // as is (the activity is signed by that actor); refetching could return a cached older copy
    // (Mastodon caches actor documents for a few minutes)
    const embedded = typeof a.object === "object" && a.object != null && isActor(a.object) ? (a.object as ApObject) : undefined;
    await resolveRemoteUser(env, actor.uri, { refresh: true, object: embedded });
    return { ok: true, reason: "actor_updated" };
  }
  if (!sameHost(id, actor.uri)) return { ok: true, reason: "update_host_mismatch" };
  const obj = typeof a.object === "object" && a.object != null ? (a.object as ApObject) : await apGet(env, id);
  if (getApType(obj) !== "Question") return { ok: true, reason: `update_unsupported_${getApType(obj)}` };
  try {
    return { ok: true, reason: (await updateQuestion(env, obj, actor)) ? "question_updated" : "question_unchanged" };
  } catch (e) {
    // upstream: .catch(err => console.error(err))
    console.warn(`updateQuestion: ${e instanceof Error ? e.message : String(e)}`);
    return { ok: true, reason: "question_update_failed" };
  }
}

/** ApInboxService.move: re-fetch the actor; ApPersonService then processes its movedTo. */
async function onMove(env: ApiEnv, actor: RemoteUser, a: InboxActivity): Promise<InboxOutcome> {
  const t = a.raw.target;
  const targetUri = typeof t === "string" ? t : t && typeof t === "object" && typeof (t as ApObject).href === "string" ? String((t as ApObject).href) : null;
  if (!targetUri) return { ok: true, reason: "move_invalid_target" };
  // already moved there by the Update(Person) that precedes a Mastodon Move: refetching now could
  // return a cached actor document without movedTo (Mastodon keeps it 3 minutes) and clear it
  if (actor.movedToUri === targetUri) return { ok: true, reason: "move_already_processed" };
  await resolveRemoteUser(env, actor.uri, { refresh: true });
  return { ok: true, reason: "move_processed" };
}

async function onBlock(env: ApiEnv, actor: RemoteUser, a: InboxActivity): Promise<InboxOutcome> {
  const blockeeId = localUserFromUri(env, getApId(a.object));
  if (!blockeeId) return { ok: false, reason: "block_target_not_local" };
  await g.block(env, actor.id, blockeeId);
  return { ok: true, reason: "blocked" };
}

export { findRemoteUserByUri };
