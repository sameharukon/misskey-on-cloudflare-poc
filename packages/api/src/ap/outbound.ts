/**
 * Local action → outbound activities (subset of upstream ApDeliverManager use).
 * Every function is best-effort: failures never break the API call, and
 * federation=none short-circuits before any recipient lookup.
 */

import type { PackNoteSource } from "../../../packers/src/index.js";
import { parseAidxTime } from "../../../id/src/index.js";
import {
  noteUri,
  renderAccept,
  renderAnnounce,
  renderBlock,
  renderCreate,
  renderDelete,
  renderFollow,
  renderLike,
  renderMove,
  renderReject,
  renderUndo,
} from "../../../ap/src/index.js";
import type { ApiEnv } from "../env.js";
import { getNotePg } from "../notes-pg.js";
import { getFederationPolicy } from "./federation.js";
import { enqueueDeliver, localActorUri, remoteFollowerInboxes, remoteInboxOf, type EnqueueResult } from "./deliver.js";
import { deliverToRelays } from "./relay.js";
import { getRemoteUserById, localBase } from "./remote.js";
import { renderLocalNote, renderLocalPerson } from "./routes.js";

async function enabled(env: ApiEnv): Promise<boolean> {
  if (!env.HYPERDRIVE?.connectionString) return false;
  try {
    return (await getFederationPolicy(env)).mode !== "none";
  } catch {
    return false;
  }
}

async function safe(fn: () => Promise<EnqueueResult | void>): Promise<EnqueueResult | null> {
  try {
    return (await fn()) ?? null;
  } catch (e) {
    console.warn("ap outbound failed", e instanceof Error ? e.message : String(e));
    return null;
  }
}

async function noteRecipients(env: ApiEnv, note: PackNoteSource): Promise<string[]> {
  const inboxes: string[] = [];
  if (note.visibility !== "specified") inboxes.push(...(await remoteFollowerInboxes(env, note.userId)));
  const direct = new Set<string>([...note.mentions, ...note.visibleUserIds]);
  if (note.replyUserId && note.replyUserHost) direct.add(note.replyUserId);
  if (note.renoteUserId && note.renoteUserHost) direct.add(note.renoteUserId);
  for (const id of direct) {
    const inbox = await remoteInboxOf(env, id);
    if (inbox) inboxes.push(inbox);
  }
  return inboxes;
}

function isPureRenote(n: PackNoteSource): boolean {
  return Boolean(n.renoteId && !n.text && n.fileIds.length === 0 && !n.hasPoll);
}

export async function deliverNoteCreate(env: ApiEnv, note: PackNoteSource): Promise<EnqueueResult | null> {
  if (note.userHost != null || note.localOnly || !(await enabled(env))) return null;
  return safe(async () => {
    const base = localBase(env);
    let activity: Record<string, unknown>;
    if (isPureRenote(note)) {
      const target = await getNotePg(env, note.renoteId!);
      if (!target) return;
      activity = renderAnnounce(target.uri ?? noteUri(base, target.id), {
        base,
        noteId: note.id,
        userId: note.userId,
        createdAt: new Date().toISOString(),
        visibility: note.visibility,
      });
    } else {
      activity = renderCreate(await renderLocalNote(env, note), `${noteUri(base, note.id)}/activity`);
    }
    // NoteCreateService: public notes also go to the accepted relays
    if (note.visibility === "public") await deliverToRelays(env, note.userId, activity);
    return enqueueDeliver(env, note.userId, await noteRecipients(env, note), activity);
  });
}

export async function deliverNoteDelete(env: ApiEnv, note: PackNoteSource): Promise<EnqueueResult | null> {
  if (note.userHost != null || note.localOnly || !(await enabled(env))) return null;
  return safe(async () => {
    const base = localBase(env);
    const actor = localActorUri(env, note.userId);
    let activity: Record<string, unknown>;
    if (isPureRenote(note)) {
      // NoteDeleteService: Undo of the original Announce (renderAnnounce(renote.uri ?? local uri, note))
      const target = await getNotePg(env, note.renoteId!);
      const announce = renderAnnounce(target?.uri ?? noteUri(base, note.renoteId!), {
        base,
        noteId: note.id,
        userId: note.userId,
        createdAt: (parseAidxTime(note.id) ?? new Date()).toISOString(),
        visibility: note.visibility,
      });
      activity = renderUndo(announce, actor);
    } else {
      activity = renderDelete(noteUri(base, note.id), actor);
    }
    await deliverToRelays(env, note.userId, activity); // NoteDeleteService.deliverToConcerned
    return enqueueDeliver(env, note.userId, await noteRecipients(env, note), activity);
  });
}

function followId(env: ApiEnv, followerId: string, followeeId: string): string {
  return `${localBase(env)}/follows/${followerId}/${followeeId}`;
}

/** Local follower → remote followee: Follow. */
export async function deliverFollow(env: ApiEnv, followerId: string, followeeId: string): Promise<EnqueueResult | null> {
  if (!(await enabled(env))) return null;
  return safe(async () => {
    const followee = await getRemoteUserById(env, followeeId);
    if (!followee) return;
    const act = renderFollow({ id: followId(env, followerId, followeeId), actor: localActorUri(env, followerId), object: followee.uri });
    return enqueueDeliver(env, followerId, [followee.inbox ?? followee.sharedInbox], act);
  });
}

/** Local follower → remote followee: Undo(Follow) (unfollow or cancel request). */
export async function deliverUndoFollow(env: ApiEnv, followerId: string, followeeId: string): Promise<EnqueueResult | null> {
  if (!(await enabled(env))) return null;
  return safe(async () => {
    const followee = await getRemoteUserById(env, followeeId);
    if (!followee) return;
    const actor = localActorUri(env, followerId);
    const act = renderUndo(renderFollow({ id: followId(env, followerId, followeeId), actor, object: followee.uri }), actor);
    return enqueueDeliver(env, followerId, [followee.inbox ?? followee.sharedInbox], act);
  });
}

/** Local followee answers a remote follower's request. */
export async function deliverFollowAnswer(
  env: ApiEnv,
  kind: "accept" | "reject",
  followeeId: string,
  followerId: string,
  requestId: string | null,
): Promise<EnqueueResult | null> {
  if (!(await enabled(env))) return null;
  return safe(async () => {
    const follower = await getRemoteUserById(env, followerId);
    if (!follower) return;
    const me = localActorUri(env, followeeId);
    const follow = { id: requestId ?? undefined, type: "Follow", actor: follower.uri, object: me };
    const act = kind === "accept" ? renderAccept(follow, me) : renderReject(follow, me);
    return enqueueDeliver(env, followeeId, [follower.inbox ?? follower.sharedInbox], act);
  });
}

export async function deliverBlock(env: ApiEnv, blockerId: string, blockeeId: string, undo = false): Promise<EnqueueResult | null> {
  if (!(await enabled(env))) return null;
  return safe(async () => {
    const blockee = await getRemoteUserById(env, blockeeId);
    if (!blockee) return;
    const actor = localActorUri(env, blockerId);
    const block = renderBlock({ id: `${localBase(env)}/blocks/${blockerId}/${blockeeId}`, actor, object: blockee.uri });
    return enqueueDeliver(env, blockerId, [blockee.inbox ?? blockee.sharedInbox], undo ? renderUndo(block, actor) : block);
  });
}

/**
 * A local user's reaction → Like (or Undo Like), as ReactionService.create / delete: to the remote
 * author, plus the reacter's remote followers (public / home / followers notes; for an Undo,
 * always) or the remote visible users of a specified note.
 */
export async function deliverReaction(env: ApiEnv, userId: string, note: PackNoteSource, reaction: string, undo = false, reactionId?: string): Promise<EnqueueResult | null> {
  if (note.localOnly || !(await enabled(env))) return null;
  return safe(async () => {
    const base = localBase(env);
    const actor = localActorUri(env, userId);
    const inboxes: string[] = [];
    if (note.userHost != null) {
      const inbox = await remoteInboxOf(env, note.userId);
      if (inbox) inboxes.push(inbox);
    }
    if (undo || ["public", "home", "followers"].includes(note.visibility)) {
      inboxes.push(...(await remoteFollowerInboxes(env, userId)));
    } else if (note.visibility === "specified") {
      for (const id of note.visibleUserIds) {
        const inbox = await remoteInboxOf(env, id);
        if (inbox) inboxes.push(inbox);
      }
    }
    if (!inboxes.length) return;
    const like = renderLike({
      id: reactionId ? `${base}/likes/${reactionId}` : `${base}/likes/${note.id}/${userId}`,
      actor,
      noteUri: note.uri ?? `${base}/notes/${note.id}`,
      reaction,
    });
    return enqueueDeliver(env, userId, [...new Set(inboxes)], undo ? renderUndo(like, actor) : like);
  });
}

/** i/update → Update(Person) to remote followers (upstream AccountUpdateService.publishToFollowers). */
export async function deliverPersonUpdate(env: ApiEnv, userId: string): Promise<EnqueueResult | null> {
  if (!(await enabled(env))) return null;
  return safe(async () => {
    const person = await renderLocalPerson(env, userId);
    if (!person) return;
    const actor = localActorUri(env, userId);
    const activity = {
      type: "Update",
      id: `${localBase(env)}/users/${userId}#updates/${Date.now()}`,
      actor,
      object: person,
      to: ["https://www.w3.org/ns/activitystreams#Public"],
      cc: [`${actor}/followers`],
    };
    await deliverToRelays(env, userId, activity); // AccountUpdateService.publishToFollowers
    return enqueueDeliver(env, userId, await remoteFollowerInboxes(env, userId), activity);
  });
}


/** AccountMoveService.moveFromLocal: Move to the remote followers of the old account. */
export async function deliverMove(env: ApiEnv, srcId: string, dst: { id: string; uri: string }): Promise<EnqueueResult | null> {
  if (!(await enabled(env))) return null;
  return safe(async () => {
    const actor = localActorUri(env, srcId);
    const activity = renderMove({ base: localBase(env), srcId, dstId: dst.id, actor, target: dst.uri });
    return enqueueDeliver(env, srcId, await remoteFollowerInboxes(env, srcId), activity);
  });
}

/**
 * i/pin, i/unpin → Add / Remove on the featured collection to remote followers
 * and the accepted relays (upstream NotePiningService.deliverPinnedChange).
 */
export async function deliverPinnedChange(env: ApiEnv, userId: string, noteId: string, isAddition: boolean): Promise<EnqueueResult | null> {
  if (!(await enabled(env))) return null;
  return safe(async () => {
    const base = localBase(env);
    const actor = localActorUri(env, userId);
    const activity = { type: isAddition ? "Add" : "Remove", actor, target: `${base}/users/${userId}/collections/featured`, object: `${base}/notes/${noteId}` };
    await deliverToRelays(env, userId, activity);
    return enqueueDeliver(env, userId, await remoteFollowerInboxes(env, userId), activity);
  });
}

/** notes/polls/vote on a remote poll → Create(Note{name: choice}) to the poll owner (ApRendererService.renderVote). */
export async function deliverPollVote(env: ApiEnv, userId: string, voteId: string, note: PackNoteSource, choiceName: string): Promise<EnqueueResult | null> {
  if (note.userHost == null || !(await enabled(env))) return null;
  return safe(async () => {
    const owner = await getRemoteUserById(env, note.userId);
    if (!owner) return;
    const base = localBase(env);
    const actor = localActorUri(env, userId);
    const activity = {
      id: `${base}/users/${userId}#votes/${voteId}/activity`,
      actor,
      type: "Create",
      to: [owner.uri],
      published: new Date().toISOString(),
      object: { id: `${base}/users/${userId}#votes/${voteId}`, type: "Note", attributedTo: actor, to: [owner.uri], inReplyTo: note.uri, name: choiceName },
    };
    return enqueueDeliver(env, userId, [owner.inbox ?? owner.sharedInbox], activity);
  });
}

/** PollService.deliverQuestionUpdate: Update(Question) of a local poll note to remote followers (no relays). */
export async function deliverQuestionUpdate(env: ApiEnv, note: PackNoteSource): Promise<EnqueueResult | null> {
  if (note.localOnly || note.userHost != null || !(await enabled(env))) return null;
  return safe(async () => {
    const actor = localActorUri(env, note.userId);
    const activity = {
      id: `${localBase(env)}/users/${note.userId}#updates/${Date.now()}`,
      actor,
      type: "Update",
      to: ["https://www.w3.org/ns/activitystreams#Public"],
      object: await renderLocalNote(env, note),
      published: new Date().toISOString(),
    };
    await deliverToRelays(env, note.userId, activity); // PollService.deliverQuestionUpdate
    return enqueueDeliver(env, note.userId, await remoteFollowerInboxes(env, note.userId), activity);
  });
}
