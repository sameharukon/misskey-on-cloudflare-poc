/**
 * upstream QueryService for note queries, as SQL fragments over
 *   note JOIN "user" "user" LEFT JOIN note reply / renote LEFT JOIN "user" "replyUser" / "renoteUser"
 * (the joins upstream's timeline endpoints make). Endpoints build a NoteQuery, add the same
 * conditions upstream adds in the same order, and read PackNoteSource rows.
 */

import { genAidx } from "../../id/src/index.js";
import type { PackNoteSource } from "../../packers/src/index.js";
import type { PgQueryable } from "./pg.js";
import { rowToPackNote } from "./notes-pg.js";

export const NOTE_SELECT_COLS = `note.id, note."replyId", note."renoteId", note."threadId", note.text, note.name, note.cw, note."userId",
  note."localOnly", note."reactionAcceptance", note."renoteCount", note."repliesCount", note."clippedCount",
  note."pageCount", note.reactions, note.visibility, note.uri, note.url, note."fileIds", note."attachedFileTypes",
  note."visibleUserIds", note.mentions, note."mentionedRemoteUsers", note."reactionAndUserPairCache",
  note.emojis, note.tags, note."hasPoll", note."channelId", note."userHost", note."replyUserId", note."replyUserHost",
  note."renoteUserId", note."renoteUserHost", note."renoteChannelId"`;

export const NOTE_JOINS = `FROM note note
  INNER JOIN "user" "user" ON "user".id = note."userId"
  LEFT JOIN note reply ON reply.id = note."replyId"
  LEFT JOIN note renote ON renote.id = note."renoteId"
  LEFT JOIN "user" "replyUser" ON "replyUser".id = reply."userId"
  LEFT JOIN "user" "renoteUser" ON "renoteUser".id = renote."userId"`;

export class NoteQuery {
  where: string[] = [];
  params: unknown[] = [];
  order = `note.id DESC`;
  joins: string = NOTE_JOINS;

  constructor(public meta: Record<string, unknown> = {}) {}

  /** bind a parameter → `$n` */
  p(v: unknown): string {
    this.params.push(v);
    return `$${this.params.length}`;
  }

  and(cond: string): this {
    this.where.push(`(${cond})`);
    return this;
  }

  /** QueryService.makePaginationQuery (sinceId only → ascending, like upstream). */
  paginate(sinceId?: string | null, untilId?: string | null, sinceDate?: number | null, untilDate?: number | null, col = "note.id"): this {
    if (sinceId && untilId) {
      this.and(`${col} > ${this.p(sinceId)}`).and(`${col} < ${this.p(untilId)}`);
      this.order = `${col} DESC`;
    } else if (sinceId) {
      this.and(`${col} > ${this.p(sinceId)}`);
      this.order = `${col} ASC`;
    } else if (untilId) {
      this.and(`${col} < ${this.p(untilId)}`);
      this.order = `${col} DESC`;
    } else if (sinceDate && untilDate) {
      this.and(`${col} > ${this.p(genAidx(sinceDate))}`).and(`${col} < ${this.p(genAidx(untilDate))}`);
      this.order = `${col} DESC`;
    } else if (sinceDate) {
      this.and(`${col} > ${this.p(genAidx(sinceDate))}`);
      this.order = `${col} ASC`;
    } else if (untilDate) {
      this.and(`${col} < ${this.p(genAidx(untilDate))}`);
      this.order = `${col} DESC`;
    } else {
      this.order = `${col} DESC`;
    }
    return this;
  }

  /** QueryService.generateVisibilityQuery */
  visibility(meId: string | null): this {
    if (meId == null) {
      if (this.meta.ugcVisibilityForVisitor === "none") this.and("1=0");
      this.and(`note.visibility = 'public' OR note.visibility = 'home'`);
    } else {
      const me = this.p(meId);
      const meList = this.p([meId]);
      this.and(`(note.visibility = 'public' OR note.visibility = 'home')
        OR note."userId" = ${me}
        OR ${meList}::varchar[] <@ note."visibleUserIds"
        OR ${meList}::varchar[] <@ note.mentions
        OR (note.visibility = 'followers' AND (note."userId" IN (SELECT "followeeId" FROM following WHERE "followerId" = ${me}) OR note."replyUserId" = ${me}))`);
    }
    return this;
  }

  /** QueryService.generateUgcVisibilityQueryForVisitor */
  ugcVisibilityForVisitor(): this {
    if (this.meta.ugcVisibilityForVisitor === "none") this.and("1=0");
    else if (this.meta.ugcVisibilityForVisitor === "local") this.and(`note."userHost" IS NULL`);
    return this;
  }

  /** QueryService.generateBaseNoteFilteringQuery */
  baseFiltering(meId: string | null, opts: { excludeUserFromMute?: string; excludeAuthor?: boolean } = {}): this {
    this.blockedHost(opts.excludeAuthor);
    this.suspendedUser(opts.excludeAuthor);
    if (meId) {
      this.mutedUser(meId, { excludeUserFromMute: opts.excludeUserFromMute });
      this.blockedUser(meId);
      this.mutedUser(meId, { noteColumn: "renote", excludeUserFromMute: opts.excludeUserFromMute });
      this.blockedUser(meId, "renote");
    }
    return this;
  }

  /** QueryService.generateBlockedUserQueryForNotes (blocked *by* them) */
  blockedUser(meId: string, noteColumn = "note"): this {
    const sub = `SELECT "blockerId" FROM blocking WHERE "blockeeId" = ${this.p(meId)}`;
    for (const col of ["userId", "replyUserId", "renoteUserId"]) {
      this.and(`${noteColumn}."${col}" IS NULL OR ${noteColumn}."${col}" NOT IN (${sub})`);
    }
    return this;
  }

  /** QueryService.generateMutedUserQueryForNotes (+ mutedInstances) */
  mutedUser(meId: string, opts: { excludeUserFromMute?: string; noteColumn?: string } = {}): this {
    const col = opts.noteColumn ?? "note";
    const me = this.p(meId);
    let sub = `SELECT "muteeId" FROM muting WHERE "muterId" = ${me} AND ("expiresAt" IS NULL OR "expiresAt" > now())`;
    if (opts.excludeUserFromMute) sub += ` AND "muteeId" != ${this.p(opts.excludeUserFromMute)}`;
    for (const c of ["userId", "replyUserId", "renoteUserId"]) {
      this.and(`${col}."${c}" IS NULL OR ${col}."${c}" NOT IN (${sub})`);
    }
    // (to_jsonb: older / test schemas without the column read as [])
    const inst = `COALESCE((SELECT to_jsonb(up) -> 'mutedInstances' FROM user_profile up WHERE up."userId" = ${me}), '[]'::jsonb)`;
    this.and(`${col}."userHost" IS NULL OR NOT (${inst} ? ${col}."userHost")`);
    this.and(`${col}."replyUserHost" IS NULL OR NOT (${inst} ? ${col}."replyUserHost")`);
    this.and(`${col}."renoteUserHost" IS NULL OR NOT (${inst} ? ${col}."renoteUserHost")`);
    return this;
  }

  /** QueryService.generateMutedUserRenotesQueryForNotes */
  mutedUserRenotes(meId: string): this {
    const sub = `SELECT "muteeId" FROM renote_muting WHERE "muterId" = ${this.p(meId)}`;
    this.and(`(note."renoteId" IS NOT NULL AND note.text IS NULL AND note."userId" NOT IN (${sub})) OR note."renoteId" IS NULL OR note.text IS NOT NULL`);
    return this;
  }

  /** QueryService.generateMutedNoteThreadQuery */
  mutedNoteThread(meId: string): this {
    const sub = `SELECT "threadId" FROM note_thread_muting WHERE "userId" = ${this.p(meId)}`;
    this.and(`note.id NOT IN (${sub})`);
    this.and(`note."threadId" IS NULL OR note."threadId" NOT IN (${sub})`);
    return this;
  }

  /** QueryService.generateBlockedHostQueryForNote */
  blockedHost(excludeAuthor?: boolean): this {
    const blocked = Array.isArray(this.meta.blockedHosts) ? (this.meta.blockedHosts as string[]) : [];
    const nonBlocked = blocked.length === 0
      ? () => "1=1"
      : (() => {
          const arr = this.p(blocked.flatMap((x) => [x, `%.${x}`]));
          return (m: string) => `${m} NOT ILIKE ALL(${arr}::varchar[])`;
        })();
    const users = excludeAuthor ? ["replyUser", "renoteUser"] : ["user", "replyUser", "renoteUser"];
    for (const u of users) {
      const idCol = `note."${u}Id"`;
      const hostCol = `note."${u}Host"`;
      this.and(excludeAuthor
        ? `${idCol} IS NULL OR note."userId" = ${idCol} OR ${hostCol} IS NULL OR ${nonBlocked(hostCol)}`
        : `${idCol} IS NULL OR ${hostCol} IS NULL OR ${nonBlocked(hostCol)}`);
    }
    return this;
  }

  /** QueryService.generateSuspendedUserQueryForNote */
  suspendedUser(excludeAuthor?: boolean): this {
    if (!excludeAuthor) this.and(`"user"."isSuspended" = FALSE`);
    for (const u of ["replyUser", "renoteUser"]) {
      this.and(excludeAuthor
        ? `"${u}".id IS NULL OR "user".id = "${u}".id OR "${u}"."isSuspended" = FALSE`
        : `"${u}".id IS NULL OR "${u}"."isSuspended" = FALSE`);
    }
    return this;
  }

  /** `note.renoteChannelId` not in the viewer's muted channels (timelines' channel-mute brackets). */
  async excludeMutedRenoteChannels(c: PgQueryable, meId: string): Promise<this> {
    const ids = await mutedChannelIdsPg(c, meId);
    if (ids.length) this.and(`note."renoteChannelId" IS NULL OR note."renoteChannelId" != ALL(${this.p(ids)}::varchar[])`);
    return this;
  }

  /** "not a reply, or a reply to oneself" (timelines without withReplies) */
  notReplyToOthers(): this {
    return this.and(`note."replyId" IS NULL OR (note."replyId" IS NOT NULL AND note."replyUserId" = note."userId")`);
  }

  sql(limit: number | null, offset?: number | null): string {
    let s = `SELECT ${NOTE_SELECT_COLS} ${this.joins}${this.where.length ? ` WHERE ${this.where.join(" AND ")}` : ""} ORDER BY ${this.order}`;
    if (limit != null) s += ` LIMIT ${this.p(limit)}`;
    if (offset) s += ` OFFSET ${this.p(offset)}`;
    return s;
  }

  async run(c: PgQueryable, limit: number | null, offset?: number | null): Promise<PackNoteSource[]> {
    return (await c.query(this.sql(limit, offset), this.params)).rows.map(rowToPackNote);
  }
}

/** ChannelMutingService.list({ idOnly }) */
export async function mutedChannelIdsPg(c: PgQueryable, meId: string): Promise<string[]> {
  try {
    return (await c.query(`SELECT "channelId" FROM channel_muting WHERE "userId" = $1 AND ("expiresAt" IS NULL OR "expiresAt" > now())`, [meId])).rows.map((r) => String(r.channelId));
  } catch {
    return [];
  }
}

/** ChannelFollowingService.list({ idOnly }) */
export async function followingChannelIdsPg(c: PgQueryable, meId: string): Promise<string[]> {
  try {
    return (await c.query(`SELECT "followeeId" FROM channel_following WHERE "followerId" = $1`, [meId])).rows.map((r) => String(r.followeeId));
  } catch {
    return [];
  }
}

/** `untilId ?? gen(untilDate)` / `sinceId ?? gen(sinceDate)` as the timeline endpoints compute them. */
export function timelineCursor(body: Record<string, unknown>): { untilId: string | null; sinceId: string | null } {
  const untilId = typeof body.untilId === "string" ? body.untilId : body.untilDate ? genAidx(Number(body.untilDate)) : null;
  const sinceId = typeof body.sinceId === "string" ? body.sinceId : body.sinceDate ? genAidx(Number(body.sinceDate)) : null;
  return { untilId, sinceId };
}
