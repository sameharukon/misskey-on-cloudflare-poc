/**
 * Antenna matching in the fanout consumer (upstream AntennaService.addNoteToAntennas).
 *
 * Upstream matches every active antenna in the request process after a note is created and
 * pushes hits to Redis `antennaTimeline:{id}` (200 entries). Here the first fanout page does
 * the same: active antennas are loaded from PG (cached per isolate for ANTENNA_CACHE_MS),
 * checked with `checkHitAntenna`, and hits are appended to the TimelineShard `antenna:{id}`
 * and returned so the stream step can push `note` to owners watching `antenna:{id}`.
 */

import { withHyperdriveClient, type PgQueryable } from "../../db/src/hyperdrive.js";

export type AntennaRow = {
  id: string;
  userId: string;
  src: "home" | "all" | "users" | "list" | "users_blacklist";
  userListId: string | null;
  keywords: string[][];
  excludeKeywords: string[][];
  users: string[];
  caseSensitive: boolean;
  localOnly: boolean;
  excludeBots: boolean;
  withReplies: boolean;
  withFile: boolean;
  excludeNotesInSensitiveChannel: boolean;
};

export type AntennaNote = {
  userId: string;
  text: string | null;
  cw: string | null;
  replyId: string | null;
  visibility: string;
  visibleUserIds: string[];
  fileIds: string[];
  channelIsSensitive: boolean;
};

export type AntennaNoteUser = { username: string; host: string | null; isBot: boolean };

/** Facts that need PG, looked up once per note for the candidate antennas. */
export type AntennaFacts = {
  /** antenna owners following the note author */
  ownersFollowingAuthor: Set<string>;
  /** lists (by id) the note author belongs to */
  listsWithAuthor: Set<string>;
};

export const ANTENNA_TIMELINE_MAX = 200;
const ANTENNA_CACHE_MS = 30_000;

/** `@user`, `user`, `@user@host` → lower-cased "user@host" with the local host filled in. */
function fullAcct(username: string, host: string | null, localHost: string): string {
  return `${username}@${host ?? localHost}`.toLowerCase();
}

function parseAcct(s: string): { username: string; host: string | null } {
  const [username = "", host] = (s.startsWith("@") ? s.slice(1) : s).split("@");
  return { username, host: host ?? null };
}

function keywordGroups(groups: string[][]): string[][] {
  return (Array.isArray(groups) ? groups : []).map((xs) => (Array.isArray(xs) ? xs : []).filter((x) => x !== "")).filter((xs) => xs.length > 0);
}

function matchesAny(groups: string[][], text: string, caseSensitive: boolean): boolean {
  return groups.some((and) => and.every((k) => (caseSensitive ? text.includes(k) : text.toLowerCase().includes(k.toLowerCase()))));
}

/** Pure port of upstream AntennaService.checkHitAntenna (same order of checks). */
export function checkHitAntenna(antenna: AntennaRow, note: AntennaNote, user: AntennaNoteUser, facts: AntennaFacts, localHost: string): boolean {
  if (antenna.excludeNotesInSensitiveChannel && note.channelIsSensitive) return false;
  if (antenna.excludeBots && user.isBot) return false;
  if (antenna.localOnly && user.host != null) return false;
  if (!antenna.withReplies && note.replyId != null) return false;
  if (note.visibility === "specified" && note.userId !== antenna.userId && !note.visibleUserIds.includes(antenna.userId)) return false;
  if (note.visibility === "followers" && antenna.userId !== note.userId && !facts.ownersFollowingAuthor.has(antenna.userId)) return false;

  if (antenna.src === "list") {
    if (antenna.userListId == null || !facts.listsWithAuthor.has(antenna.userListId)) return false;
  } else if (antenna.src === "users" || antenna.src === "users_blacklist") {
    const accts = antenna.users.map((x) => {
      const a = parseAcct(x);
      return fullAcct(a.username, a.host, localHost);
    });
    const hit = accts.includes(fullAcct(user.username, user.host, localHost));
    if (antenna.src === "users" ? !hit : hit) return false;
  }
  // src "home" has no filter upstream (TODO there)

  const text = `${note.text ?? ""}\n${note.cw ?? ""}`;
  const keywords = keywordGroups(antenna.keywords);
  if (keywords.length > 0) {
    if (note.text == null && note.cw == null) return false;
    if (!matchesAny(keywords, text, antenna.caseSensitive)) return false;
  }
  const exclude = keywordGroups(antenna.excludeKeywords);
  if (exclude.length > 0) {
    if (note.text == null && note.cw == null) return false;
    if (matchesAny(exclude, text, antenna.caseSensitive)) return false;
  }
  if (antenna.withFile && note.fileIds.length === 0) return false;
  return true;
}

function withPg<T>(hd: { connectionString: string }, fn: (c: PgQueryable) => Promise<T>): Promise<T> {
  return withHyperdriveClient(hd, fn);
}

let cache: { at: number; rows: AntennaRow[] } | null = null;

export function resetAntennaCacheForTest(): void {
  cache = null;
}

function rowToAntenna(r: Record<string, unknown>): AntennaRow {
  return {
    id: String(r.id),
    userId: String(r.userId),
    src: String(r.src) as AntennaRow["src"],
    userListId: (r.userListId as string | null) ?? null,
    keywords: (r.keywords as string[][]) ?? [],
    excludeKeywords: (r.excludeKeywords as string[][]) ?? [],
    users: (r.users as string[]) ?? [],
    caseSensitive: Boolean(r.caseSensitive),
    localOnly: Boolean(r.localOnly),
    excludeBots: Boolean(r.excludeBots),
    withReplies: Boolean(r.withReplies),
    withFile: Boolean(r.withFile),
    excludeNotesInSensitiveChannel: Boolean(r.excludeNotesInSensitiveChannel),
  };
}

export type AntennaHit = { antennaId: string; ownerId: string };

/**
 * Match one created note against every active antenna. PG work: the antenna list (cached),
 * the note + author when the message carries no packed note, and one query for follow / list
 * facts when a candidate needs them.
 */
export async function matchAntennas(
  hd: { connectionString: string },
  noteId: string,
  packed: unknown,
  localHost: string,
): Promise<AntennaHit[]> {
  return withPg(hd, async (c) => {
    if (!cache || Date.now() - cache.at > ANTENNA_CACHE_MS) {
      const r = await c.query(`SELECT * FROM antenna WHERE "isActive" = TRUE`);
      cache = { at: Date.now(), rows: (r.rows as Record<string, unknown>[]).map(rowToAntenna) };
    }
    const antennas = cache.rows;
    if (!antennas.length) return [];

    let note: AntennaNote;
    let user: AntennaNoteUser;
    const p = packed as Record<string, any> | null | undefined;
    if (p && p.user) {
      note = {
        userId: String(p.userId),
        text: p.text ?? null,
        cw: p.cw ?? null,
        replyId: p.replyId ?? null,
        visibility: String(p.visibility),
        visibleUserIds: Array.isArray(p.visibleUserIds) ? p.visibleUserIds : [],
        fileIds: Array.isArray(p.fileIds) ? p.fileIds : [],
        channelIsSensitive: Boolean(p.channel?.isSensitive),
      };
      user = { username: String(p.user.username), host: p.user.host ?? null, isBot: Boolean(p.user.isBot) };
    } else {
      const r = await c.query(
        `SELECT n."userId", n.text, n.cw, n."replyId", n.visibility, n."visibleUserIds", n."fileIds",
           u.username, u.host, u."isBot", COALESCE(ch."isSensitive", FALSE) AS "channelIsSensitive"
         FROM note n JOIN "user" u ON u.id = n."userId" LEFT JOIN channel ch ON ch.id = n."channelId" WHERE n.id = $1`,
        [noteId],
      );
      const row = r.rows[0] as Record<string, any> | undefined;
      if (!row) return [];
      note = {
        userId: String(row.userId), text: row.text ?? null, cw: row.cw ?? null, replyId: row.replyId ?? null,
        visibility: String(row.visibility), visibleUserIds: row.visibleUserIds ?? [], fileIds: row.fileIds ?? [],
        channelIsSensitive: Boolean(row.channelIsSensitive),
      };
      user = { username: String(row.username), host: row.host ?? null, isBot: Boolean(row.isBot) };
    }

    const facts: AntennaFacts = { ownersFollowingAuthor: new Set(), listsWithAuthor: new Set() };
    const owners = note.visibility === "followers" ? [...new Set(antennas.map((a) => a.userId))] : [];
    const lists = [...new Set(antennas.filter((a) => a.src === "list" && a.userListId).map((a) => a.userListId!))];
    if (owners.length || lists.length) {
      const r = await c.query(
        `SELECT 'f' AS k, "followerId" AS v FROM following WHERE "followeeId" = $1 AND "followerId" = ANY($2::varchar[])
         UNION ALL SELECT 'l' AS k, "userListId" AS v FROM user_list_membership WHERE "userId" = $1 AND "userListId" = ANY($3::varchar[])`,
        [note.userId, owners, lists],
      );
      for (const x of r.rows as { k: string; v: string }[]) (x.k === "f" ? facts.ownersFollowingAuthor : facts.listsWithAuthor).add(String(x.v));
    }
    return antennas.filter((a) => checkHitAntenna(a, note, user, facts, localHost)).map((a) => ({ antennaId: a.id, ownerId: a.userId }));
  });
}
