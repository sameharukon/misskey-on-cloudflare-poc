/**
 * Streaming pushes from the fanout consumer.
 *
 * Shard-aware: StreamPresence shards (`stream:{n}`) say which users are online
 * and on which channels, so a note only wakes hubs with a matching live socket.
 * - followers page → `homeTimeline` (+ `hybridTimeline`) for online followers
 * - first page → specified recipients, and public-channel subscribers
 *   (`localTimeline`/`hybridTimeline` for local public, `globalTimeline` for public)
 * - first page → `userList:<listId>` for online owners of lists containing the author
 *   (upstream UserListChannel rules: visibility, withReplies), and `antenna:<id>` for
 *   owners of antennas the note matched (see antenna.ts)
 * - channel notes: the follower pages are the channel's followers, and the first page also
 *   reaches every `channel:<id>` subscriber
 * - public notes: every `roleTimeline:<roleId>` subscriber of the author's explorable public
 *   roles (see role-timeline.ts)
 * Recipients that mute/block (either way) the author or related users, or
 * renote-mute a pure renote's author, are dropped (one PG query per batch).
 * Each StreamHub then applies its sockets' timeline options (withRenotes / withFiles /
 * withReplies) and upstream's reply rules, using the follow facts sent with a reply.
 */

import { streamShardId } from "@misskey-cf/shared";
import { withHyperdriveClient, type PgQueryable } from "../../db/src/hyperdrive.js";
import type { DoNs, NoteTarget, StreamHubRpc, StreamPresenceRpc } from "../../shared/src/do-rpc.js";

export type StreamFanoutEnv = {
  STREAM_HUB?: DoNs<StreamHubRpc>;
  STREAM_PRESENCE?: DoNs<StreamPresenceRpc>;
  STREAM_SHARD_COUNT?: string;
  HYPERDRIVE?: { connectionString: string };
  FANOUT_CONCURRENCY?: string;
};

export type StreamFanoutInput = {
  noteId: string;
  authorId?: string;
  visibility?: string;
  visibleUserIds?: string[];
  timelineKeys: string[];
  packed?: unknown;
  renoteOf?: string | null;
  relatedUserIds?: string[];
  /** antennas this note matched (first page only) */
  antennaHits?: { antennaId: string; ownerId: string }[];
  /** channel note: followers are the channel's; `channel:<id>` subscribers also get it */
  channelId?: string;
  /** the author's explorable public roles (public notes, first page only) */
  roleIds?: string[];
};

type Recipients = Map<string, Set<string>>;

function shardCount(env: StreamFanoutEnv): number {
  return Math.max(1, Number(env.STREAM_SHARD_COUNT) || 16);
}

async function presenceCall(env: StreamFanoutEnv, shard: string, call: (p: StreamPresenceRpc) => Promise<Record<string, string[]> | void>): Promise<Record<string, string[]>> {
  const ns = env.STREAM_PRESENCE!;
  try {
    return (await call(ns.get(ns.idFromName(shard)))) ?? {};
  } catch {
    return {};
  }
}

/** Online subset of userIds (grouped per presence shard, parallel). */
export async function lookupOnline(env: StreamFanoutEnv, userIds: string[]): Promise<Record<string, string[]>> {
  const byShard = new Map<string, string[]>();
  for (const id of userIds) {
    const s = streamShardId(id, shardCount(env));
    (byShard.get(s) ?? byShard.set(s, []).get(s)!).push(id);
  }
  const parts = await Promise.all([...byShard].map(([s, ids]) => presenceCall(env, s, (p) => p.lookup(ids))));
  return Object.assign({}, ...parts);
}

/** Subscribers of any channel across all presence shards. */
export async function channelSubscribers(env: StreamFanoutEnv, channels: string[]): Promise<Record<string, string[]>> {
  const n = shardCount(env);
  const parts = await Promise.all(
    Array.from({ length: n }, (_, i) => presenceCall(env, `stream:${i}`, (p) => p.subscribers(channels))),
  );
  return Object.assign({}, ...parts);
}

function add(r: Recipients, userId: string, channel: string) {
  (r.get(userId) ?? r.set(userId, new Set()).get(userId)!).add(channel);
}

function withPg<T>(env: StreamFanoutEnv, fn: (c: PgQueryable) => Promise<T>): Promise<T> {
  return withHyperdriveClient(env.HYPERDRIVE, fn);
}

/** Fields of the packed note the list rules need. */
type PackedLite = {
  userId?: string;
  channelId?: string | null;
  visibility?: string;
  visibleUserIds?: string[];
  reply?: { userId?: string; visibility?: string } | null;
  renote?: { reply?: { userId?: string; visibility?: string } | null } | null;
};

/** Per-recipient follow facts the hub's timeline filters need (stream NoteRelation). */
export type NoteRelation = { followsAuthorWithReplies?: boolean; follows?: string[] };

/**
 * For a reply (or a renote of one): each recipient's following rows towards the author
 * (withReplies) and the reply / renoted reply authors. Empty for other notes.
 */
async function noteRelations(env: StreamFanoutEnv, recipients: string[], note: PackedLite, authorId: string | undefined): Promise<Map<string, NoteRelation>> {
  const out = new Map<string, NoteRelation>();
  const related = [note.reply?.userId, note.renote?.reply?.userId].filter((x): x is string => typeof x === "string");
  if (!related.length || !recipients.length || !env.HYPERDRIVE?.connectionString) return out;
  const followees = [...new Set([...(authorId ? [authorId] : []), ...related])];
  const rows = await withPg(env, async (c) =>
    (await c.query(
      `SELECT "followerId", "followeeId", "withReplies" FROM following
       WHERE "followerId" = ANY($1::varchar[]) AND "followeeId" = ANY($2::varchar[])`,
      [recipients, followees],
    )).rows as { followerId: string; followeeId: string; withReplies: boolean }[],
  );
  for (const r of rows) {
    const rel = out.get(r.followerId) ?? { follows: [] };
    if (r.followeeId === authorId && r.withReplies) rel.followsAuthorWithReplies = true;
    if (related.includes(r.followeeId)) rel.follows!.push(r.followeeId);
    out.set(r.followerId, rel);
  }
  return out;
}

export type ListMembershipRow = {
  listId: string;
  ownerId: string;
  withReplies: boolean;
  /** owner follows the note author */
  followsAuthor: boolean;
  /** owner follows the reply target's author */
  followsReplyUser: boolean;
};

/**
 * Pure: which lists (and owners) should get a live `note` for this note.
 * Mirrors upstream pushToTl (userListTimeline) + UserListChannel.onNote.
 */
export function planListTargets(note: PackedLite, authorId: string, rows: ListMembershipRow[]): { ownerId: string; listId: string }[] {
  if (note.channelId) return [];
  const out: { ownerId: string; listId: string }[] = [];
  for (const m of rows) {
    const isMe = m.ownerId === authorId;
    if (note.visibility === "followers" && !isMe && !m.followsAuthor) continue;
    if (note.visibility === "specified" && !isMe && !(note.visibleUserIds ?? []).includes(m.ownerId)) continue;
    const reply = note.reply;
    if (reply) {
      if (m.withReplies) {
        if (reply.visibility === "followers" && reply.userId !== m.ownerId && !m.followsReplyUser) continue;
      } else if (reply.userId !== m.ownerId && !isMe && reply.userId !== authorId) {
        continue;
      }
    }
    out.push({ ownerId: m.ownerId, listId: m.listId });
  }
  return out;
}

async function listMemberships(env: StreamFanoutEnv, authorId: string, replyUserId: string | null): Promise<ListMembershipRow[]> {
  if (!env.HYPERDRIVE?.connectionString) return [];
  return withPg(env, async (c) => {
    const r = await c.query(
      `SELECT m."userListId" AS "listId", m."userListUserId" AS "ownerId", m."withReplies",
         EXISTS (SELECT 1 FROM following f WHERE f."followerId" = m."userListUserId" AND f."followeeId" = $1) AS "followsAuthor",
         EXISTS (SELECT 1 FROM following f WHERE f."followerId" = m."userListUserId" AND f."followeeId" = $2) AS "followsReplyUser"
       FROM user_list_membership m WHERE m."userId" = $1`,
      [authorId, replyUserId ?? ""],
    );
    return (r.rows as Record<string, unknown>[]).map((x) => ({
      listId: String(x.listId),
      ownerId: String(x.ownerId),
      withReplies: Boolean(x.withReplies),
      followsAuthor: Boolean(x.followsAuthor),
      followsReplyUser: Boolean(x.followsReplyUser),
    }));
  });
}

/** Pure: which channels each online user should get for this note. */
export function planRecipients(
  input: StreamFanoutInput,
  firstPage: boolean,
  onlineFollowers: Record<string, string[]>,
  publicSubs: Record<string, string[]>,
  onlineSpecified: Record<string, string[]>,
): Recipients {
  const r: Recipients = new Map();
  const keys = new Set(input.timelineKeys);
  const isLocalPublic = keys.has("local");
  if (firstPage && input.channelId) {
    // ChannelChannel: everyone watching this channel, the author included
    const key = `channel:${input.channelId}`;
    for (const [id, chans] of Object.entries(publicSubs)) if (chans.includes(key)) add(r, id, key);
  }
  if (firstPage && input.visibility === "public") {
    // RoleTimelineChannel: everyone watching one of the author's roles, the author included
    for (const roleId of input.roleIds ?? []) {
      const key = `roleTimeline:${roleId}`;
      for (const [id, chans] of Object.entries(publicSubs)) if (chans.includes(key)) add(r, id, key);
    }
  }
  for (const [id, chans] of Object.entries(onlineFollowers)) {
    if (id === input.authorId) continue; // author gets own note from the API
    if (chans.includes("homeTimeline")) add(r, id, "homeTimeline");
    if (chans.includes("hybridTimeline")) add(r, id, "hybridTimeline");
  }
  if (firstPage) {
    for (const [id, chans] of Object.entries(onlineSpecified)) {
      if (id !== input.authorId && chans.includes("homeTimeline")) add(r, id, "homeTimeline");
    }
    for (const [id, chans] of Object.entries(publicSubs)) {
      // the author's own home / hybrid / local / global come from the API at once
      if (id === input.authorId) continue;
      if (keys.has("global") && chans.includes("globalTimeline")) add(r, id, "globalTimeline");
      if (isLocalPublic && chans.includes("localTimeline")) add(r, id, "localTimeline");
      if (isLocalPublic && chans.includes("hybridTimeline")) add(r, id, "hybridTimeline");
    }
  }
  return r;
}

/**
 * Users among `ids` who mute/block (or are blocked by) any of `authors`, plus
 * (pure renotes only) users who renote-mute the renoter (`renoteMutee`).
 */
async function excludedRecipients(env: StreamFanoutEnv, ids: string[], authors: string[], renoteMutee: string | null | undefined): Promise<Set<string>> {
  if (!env.HYPERDRIVE?.connectionString || ids.length === 0 || authors.length === 0) return new Set();
  return withPg(env, async (client) => {
    const r = await client.query(
      `SELECT "muterId" AS id FROM muting
         WHERE "muterId" = ANY($1::varchar[]) AND "muteeId" = ANY($2::varchar[])
           AND ("expiresAt" IS NULL OR "expiresAt" > now())
       UNION SELECT "blockerId" AS id FROM blocking
         WHERE "blockerId" = ANY($1::varchar[]) AND "blockeeId" = ANY($2::varchar[])
       UNION SELECT "blockeeId" AS id FROM blocking
         WHERE "blockeeId" = ANY($1::varchar[]) AND "blockerId" = ANY($2::varchar[])
       ${renoteMutee ? `UNION SELECT "muterId" AS id FROM renote_muting WHERE "muterId" = ANY($1::varchar[]) AND "muteeId" = $3` : ""}`,
      renoteMutee ? [ids, authors, renoteMutee] : [ids, authors],
    );
    return new Set((r.rows as { id: string }[]).map((x) => String(x.id)));
  });
}


export type StreamFanoutResult = { recipients: number; delivered: number; pruned: number };

/** Run streaming pushes for one fanout page. */
export async function streamFanout(
  env: StreamFanoutEnv,
  input: StreamFanoutInput,
  followerIds: string[],
  firstPage: boolean,
): Promise<StreamFanoutResult> {
  const none = { recipients: 0, delivered: 0, pruned: 0 };
  if (!env.STREAM_HUB || !env.STREAM_PRESENCE || input.packed == null) return none;
  const onlineFollowers = followerIds.length ? await lookupOnline(env, followerIds) : {};
  let publicSubs: Record<string, string[]> = {};
  let onlineSpecified: Record<string, string[]> = {};
  if (firstPage) {
    const keys = new Set(input.timelineKeys);
    const chans = [
      ...(keys.has("global") ? ["globalTimeline"] : []),
      ...(keys.has("local") ? ["localTimeline", "hybridTimeline"] : []),
      ...(input.channelId ? [`channel:${input.channelId}`] : []),
      ...(input.visibility === "public" ? (input.roleIds ?? []).map((id) => `roleTimeline:${id}`) : []),
    ];
    if (chans.length) publicSubs = await channelSubscribers(env, chans);
    if (input.visibility === "specified" && input.visibleUserIds?.length) onlineSpecified = await lookupOnline(env, input.visibleUserIds);
  }
  const plan = planRecipients(input, firstPage, onlineFollowers, publicSubs, onlineSpecified);
  if (firstPage && input.authorId) {
    // userList: owners of lists that contain the author; antenna: owners of matched antennas.
    // Either only if the owner watches that exact list / antenna right now.
    const note = input.packed as PackedLite;
    const targets = [
      ...planListTargets(note, input.authorId, await listMemberships(env, input.authorId, note.reply?.userId ?? null)).map((t) => ({ ownerId: t.ownerId, key: `userList:${t.listId}` })),
      ...(input.antennaHits ?? []).map((h) => ({ ownerId: h.ownerId, key: `antenna:${h.antennaId}` })),
    ];
    if (targets.length) {
      const online = await lookupOnline(env, [...new Set(targets.map((t) => t.ownerId))]);
      for (const t of targets) if (online[t.ownerId]?.includes(t.key)) add(plan, t.ownerId, t.key);
    }
  }
  if (plan.size === 0) return none;
  const authors = [...new Set([input.authorId, ...(input.relatedUserIds ?? [])].filter((x): x is string => Boolean(x)))];
  // renote mute targets the renoter (upstream: renoteMuting.has(note.userId) for pure renotes)
  const excluded = await excludedRecipients(env, [...plan.keys()], authors, input.renoteOf ? input.authorId : null);
  const targets = [...plan].filter(([id]) => !excluded.has(id));
  // the hub applies each subscription's withReplies / withRenotes / withFiles (upstream channel onNote)
  const lite = input.packed as PackedLite;
  const needsRel = Boolean(lite.reply || lite.renote?.reply);
  const rels = await noteRelations(env, targets.map(([id]) => id), lite, input.authorId);
  // one call per presence shard: the shard publishes to its users' hubs (and drops the ones with
  // no socket left), so this invocation's subrequests do not grow with the number of recipients
  const byShard = new Map<string, NoteTarget[]>();
  for (const [id, ch] of targets) {
    const s = streamShardId(id, shardCount(env));
    (byShard.get(s) ?? byShard.set(s, []).get(s)!).push({ userId: id, channels: [...ch], ...(needsRel ? { rel: rels.get(id) ?? {} } : {}) });
  }
  const ns = env.STREAM_PRESENCE;
  const res = await Promise.all([...byShard].map(async ([s, list]) => {
    try {
      return await ns.get(ns.idFromName(s)).deliverNote(input.packed, list);
    } catch {
      return { delivered: 0, pruned: 0 };
    }
  }));
  return { recipients: targets.length, delivered: res.reduce((a, r) => a + r.delivered, 0), pruned: res.reduce((a, r) => a + r.pruned, 0) };
}
