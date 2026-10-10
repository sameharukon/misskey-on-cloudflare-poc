/**
 * Note read endpoints ported from upstream: notes/state, notes/children, notes/replies,
 * notes/renotes, notes/conversation, notes/mentions, notes/featured, notes/show-partial-bulk.
 */

import type { PackNoteSource } from "../../packers/src/index.js";
import { convertLegacyReactions, decodeReactionKey } from "../../packers/src/note.js";
import type { ApiEnv } from "./env.js";
import { apiErrorResponse } from "./errors.js";
import { authenticatePg, extractToken } from "./auth-pg.js";
import { buildPackConfig } from "./meta-source.js";
import { withHyperdriveClient } from "./pg.js";
import { packNotesFromPg, rowToPackNote } from "./notes-pg.js";
import { NoteQuery } from "./note-query.js";
import { metaRowPg, populateEmojisPg } from "./user-lite-pg.js";
import { canViewNote } from "./visibility.js";
import { notesRankingPg } from "./featured-pg.js";
import { withCredentialGuard } from "./social-api-pg.js";
import { clientError as err, hd } from "./handler-kit.js";

type Body = Record<string, unknown>;
type Ctx = { hasCredential: boolean; request: Request };
type Handler = (env: ApiEnv, body: Body, ctx: Ctx) => Promise<Response | unknown>;

const num = (v: unknown) => (typeof v === "number" ? v : null);
const str = (v: unknown) => (typeof v === "string" ? v : null);

async function viewer(env: ApiEnv, body: Body, ctx: Ctx): Promise<string | null> {
  const token = extractToken(ctx.request, body);
  return token ? ((await authenticatePg(env, token))?.user.id ?? null) : null;
}

const pack = (env: ApiEnv, notes: PackNoteSource[], meId: string | null) => packNotesFromPg(env, notes, buildPackConfig(env), meId);

// ---------------------------------------------------------------- notes/state

const notesState: Handler = async (env, body, ctx) => {
  const meId = (await viewer(env, body, ctx))!;
  return withHyperdriveClient(hd(env), async (c) => {
    const note = (await c.query(`SELECT id, "threadId" FROM note WHERE id = $1`, [body.noteId])).rows[0];
    // upstream: findOneByOrFail → EntityNotFoundError → INTERNAL_ERROR
    if (!note) throw Object.assign(new Error(`Could not find any entity of type "MiNote" matching the query`), { name: "EntityNotFoundError" });
    const fav = await c.query(`SELECT 1 AS x FROM note_favorite WHERE "userId" = $1 AND "noteId" = $2 LIMIT 1`, [meId, note.id]);
    const tm = await c.query(`SELECT 1 AS x FROM note_thread_muting WHERE "userId" = $1 AND "threadId" = $2 LIMIT 1`, [meId, note.threadId ?? note.id]);
    return { isFavorited: fav.rows.length !== 0, isMutedThread: tm.rows.length !== 0 };
  });
};

// ---------------------------------------------------------------- children / replies / renotes

function listOf(kind: "children" | "replies" | "renotes"): Handler {
  return async (env, body, ctx) => {
    const meId = await viewer(env, body, ctx);
    const res = await withHyperdriveClient(hd(env), async (c) => {
      if (kind === "renotes") {
        const note = (await c.query(`SELECT id FROM note WHERE id = $1`, [body.noteId])).rows[0];
        if (!note) return err("NO_SUCH_NOTE", "12908022-2e21-46cd-ba6a-3edaf6093f46", "No such note.");
      }
      const q = new NoteQuery(await metaRowPg(c)).paginate(str(body.sinceId), str(body.untilId), num(body.sinceDate), num(body.untilDate));
      const id = q.p(body.noteId);
      if (kind === "children") q.and(`note."replyId" = ${id} OR (note."renoteId" = ${id} AND (note.text IS NOT NULL OR note."fileIds" != '{}' OR note."hasPoll" = TRUE))`);
      else if (kind === "replies") q.and(`note."replyId" = ${id}`);
      else q.and(`note."renoteId" = ${id}`);
      q.visibility(meId);
      q.baseFiltering(meId);
      return q.run(c, typeof body.limit === "number" ? body.limit : 10);
    });
    if (!Array.isArray(res)) return apiErrorResponse(res, 400);
    return pack(env, res, meId);
  };
}

// ---------------------------------------------------------------- notes/conversation

const notesConversation: Handler = async (env, body, ctx) => {
  const meId = await viewer(env, body, ctx);
  const limit = typeof body.limit === "number" ? body.limit : 10;
  const offset = typeof body.offset === "number" ? body.offset : 0;
  const conversation = await withHyperdriveClient(hd(env), async (c) => {
    if (meId == null && (await metaRowPg(c)).ugcVisibilityForVisitor === "none") return [];
    const note = (await c.query(`SELECT id, "replyId" FROM note WHERE id = $1`, [body.noteId])).rows[0];
    if (!note) return null;
    const out: PackNoteSource[] = [];
    let i = 0;
    let next = (note.replyId as string | null) ?? null;
    while (next) {
      i++;
      const row = (await c.query(`SELECT * FROM note WHERE id = $1`, [next])).rows[0];
      if (!row) break;
      const p = rowToPackNote(row);
      if (i > offset) out.push(p);
      if (out.length === limit) break;
      next = p.replyId;
    }
    return out;
  });
  if (conversation == null) return apiErrorResponse(err("NO_SUCH_NOTE", "e1035875-9551-45ec-afa8-1ded1fcb53c8", "No such note."), 400);
  return pack(env, conversation, meId);
};

// ---------------------------------------------------------------- notes/mentions

const notesMentions: Handler = async (env, body, ctx) => {
  const meId = (await viewer(env, body, ctx))!;
  const notes = await withHyperdriveClient(hd(env), async (c) => {
    const q = new NoteQuery(await metaRowPg(c)).paginate(str(body.sinceId), str(body.untilId), num(body.sinceDate), num(body.untilDate));
    const meList = q.p([meId]);
    q.and(`${meList}::varchar[] <@ note.mentions OR ${meList}::varchar[] <@ note."visibleUserIds"`);
    // "Avoid scanning primary key index"
    q.order = `CONCAT(note.id) ${body.sinceDate || body.sinceId ? "ASC" : "DESC"}`;
    q.visibility(meId);
    q.baseFiltering(meId);
    q.mutedNoteThread(meId);
    if (body.visibility) q.and(`note.visibility = ${q.p(body.visibility)}`);
    if (body.following === true) {
      const me = q.p(meId);
      q.and(`(note."userId" IN (SELECT "followeeId" FROM following WHERE "followerId" = ${me})) OR (note."userId" = ${me})`);
    }
    return q.run(c, typeof body.limit === "number" ? body.limit : 10);
  });
  return pack(env, notes, meId);
};

// ---------------------------------------------------------------- notes/featured

let globalRankingCache: { at: number; ids: string[] } | null = null;

const rankingFailed = (e: unknown): string[] => {
  console.warn(`notes ranking failed: ${e instanceof Error ? e.message : String(e)}`);
  return [];
};

const notesFeatured: Handler = async (env, body, ctx) => {
  const meId = await viewer(env, body, ctx);
  const notes = await withHyperdriveClient(hd(env), async (c) => {
    let noteIds: string[];
    if (body.channelId) {
      noteIds = await notesRankingPg(c, { kind: "channel", channelId: String(body.channelId) }, 50).catch(rankingFailed);
    } else if (globalRankingCache && Date.now() - globalRankingCache.at < 1000 * 60 * 30) {
      noteIds = globalRankingCache.ids;
    } else {
      // a failed ranking answers empty but is not kept for the 30 minutes
      noteIds = await notesRankingPg(c, { kind: "global" }, 100).then((ids) => {
        globalRankingCache = { at: Date.now(), ids };
        return ids;
      }, rankingFailed);
    }
    noteIds = [...noteIds].sort((a, b) => (a > b ? -1 : 1));
    if (typeof body.untilId === "string") noteIds = noteIds.filter((id) => id < (body.untilId as string));
    if (noteIds.length === 0) return [];
    const q = new NoteQuery(await metaRowPg(c));
    q.and(`note.id = ANY(${q.p(noteIds)}::varchar[])`);
    q.blockedHost();
    q.suspendedUser();
    if (meId == null) q.ugcVisibilityForVisitor();
    if (meId) {
      // isUserRelated(note, blocking me / muted by me)
      const me = q.p(meId);
      for (const set of [
        `(SELECT "blockerId" FROM blocking WHERE "blockeeId" = ${me})`,
        `(SELECT "muteeId" FROM muting WHERE "muterId" = ${me} AND ("expiresAt" IS NULL OR "expiresAt" > now()))`,
      ]) {
        q.and(`NOT (note."userId" IN ${set}
          OR (COALESCE(note."replyUserId", reply."userId") IS DISTINCT FROM note."userId" AND COALESCE(note."replyUserId", reply."userId") IN ${set})
          OR (COALESCE(note."renoteUserId", renote."userId") IS DISTINCT FROM note."userId" AND COALESCE(note."renoteUserId", renote."userId") IN ${set}))`);
      }
    }
    q.order = "note.id DESC";
    return q.run(c, null);
  });
  return pack(env, notes.slice(0, typeof body.limit === "number" ? body.limit : 10), meId);
};

export function resetFeaturedCacheForTest(): void {
  globalRankingCache = null;
}

// ---------------------------------------------------------------- notes/show-partial-bulk

/** NoteEntityService.fetchDiffs */
const notesShowPartialBulk: Handler = async (env, body, ctx) => {
  const meId = await viewer(env, body, ctx);
  const ids = body.noteIds as string[];
  if (ids.length === 0) return [];
  return withHyperdriveClient(hd(env), async (c) => {
    if (meId == null && (await metaRowPg(c)).ugcVisibilityForVisitor === "none") return [];
    const rows = (await c.query(
      `SELECT id, "userId", "userHost", visibility, "visibleUserIds", mentions, "replyUserId", reactions, "reactionAndUserPairCache" FROM note WHERE id = ANY($1::varchar[])`,
      [ids],
    )).rows;
    const notes = [];
    for (const r of rows) {
      const n = { ...rowToPackNote(r) };
      if (await canViewNote(env, n, meId)) notes.push(n);
    }
    const reactionsOf = notes.map((n) => convertLegacyReactions(n.reactions));
    const emojis = await populateEmojisPg(
      c,
      notes.map((n, i) => ({
        names: Object.keys(reactionsOf[i]!).filter((x) => x.startsWith(":") && x.includes("@") && !x.includes("@.")).map((x) => decodeReactionKey(x).replaceAll(":", "")),
        host: n.userHost,
      })),
      buildPackConfig(env).host?.toLowerCase() ?? null,
    );
    return notes.map((n, i) => ({ id: n.id, reactions: reactionsOf[i], reactionEmojis: Object.fromEntries(emojis[i]!) }));
  });
};

const RAW: Record<string, Handler> = {
  "notes/state": notesState,
  "notes/children": listOf("children"),
  "notes/replies": listOf("replies"),
  "notes/renotes": listOf("renotes"),
  "notes/conversation": notesConversation,
  "notes/mentions": notesMentions,
  "notes/featured": notesFeatured,
  "notes/show-partial-bulk": notesShowPartialBulk,
};

export const notesReadHandlers: Record<string, Handler> = Object.fromEntries(Object.entries(RAW).map(([k, h]) => [k, withCredentialGuard(k, h)]));
