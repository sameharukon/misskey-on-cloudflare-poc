/**
 * Clips (W7.4) on PG (`clip`, `clip_note`, `clip_favorite`; upstream schema).
 * clips/create|update|delete|list|show|notes|add-note|remove-note|favorite|
 * unfavorite|my-favorites, notes/clips, users/clips. Shapes follow upstream
 * ClipEntityService.pack; limits come from role policies (clipLimit,
 * noteEachClipsLimit).
 */

import { genAidx, parseAidxTime } from "../../id/src/index.js";
import { packUserLite } from "../../packers/src/index.js";
import type { ApiEnv } from "./env.js";
import { apiErrorResponse, CREDENTIAL_REQUIRED } from "./errors.js";
import { buildPackConfig } from "./meta-source.js";
import { withHyperdriveClient, type PgQueryable } from "./pg.js";
import { getNotePg, getUsersByIdsPg } from "./notes-pg.js";
import { getUserPoliciesPg } from "./policies-pg.js";
import { pagination } from "./client-endpoints-pg.js";
import { NoteQuery } from "./note-query.js";
import { metaRowPg } from "./user-lite-pg.js";
import { packNotesFromPg } from "./notes-pg.js";
import { authUserId as auth, clientError as err, errorResponse as fail, hd, invalidParam as bad } from "./handler-kit.js";

type Ctx = { hasCredential: boolean; request: Request };
type Body = Record<string, unknown>;
export type ClipHandler = (env: ApiEnv, body: Body, ctx: Ctx) => Promise<Response | unknown>;

const noSuchClip = (id: string) => err("NO_SUCH_CLIP", id, "No such clip.");
const E = {
  tooManyClips: err("TOO_MANY_CLIPS", "920f7c2d-6208-4b76-8082-e632020f5883", "You cannot create clip any more."),
  update: noSuchClip("b4d92d70-b216-46fa-9a3f-a8c811699257"),
  delete: noSuchClip("70ca08ba-6865-4630-b6fb-8494759aa754"),
  show: noSuchClip("c3c5fe33-d62c-44d2-9ea5-d997703f5c20"),
  notes: noSuchClip("1d7645e6-2b6d-4635-b0fe-fe22b0e72e00"),
  addNoSuchClip: noSuchClip("d6e76cc0-a1b5-4c7c-a287-73fa9c716dcf"),
  addNoSuchNote: err("NO_SUCH_NOTE", "fc8c0b49-c7a3-4664-a0a6-b418d386bb8b", "No such note."),
  alreadyClipped: err("ALREADY_CLIPPED", "734806c4-542c-463a-9311-15c512803965", "The note has already been clipped."),
  tooManyClipNotes: err("TOO_MANY_CLIP_NOTES", "f0dba960-ff73-4615-8df4-d6ac5d9dc118", "You cannot add notes to the clip any more."),
  removeNoSuchClip: noSuchClip("b80525c6-97f7-49d7-a42d-ebccd49cfd52"),
  removeNoSuchNote: err("NO_SUCH_NOTE", "aff017de-190e-434b-893e-33a9ff5049d8", "No such note."),
  favNoSuchClip: noSuchClip("4c2aaeae-80d8-4250-9606-26cb1fdb77a5"),
  alreadyFavorited: err("ALREADY_FAVORITED", "92658936-c625-4273-8326-2d790129256e", "The clip has already been favorited."),
  unfavNoSuchClip: noSuchClip("2603966e-b865-426c-94a7-af4a01241dc1"),
  notFavorited: err("NOT_FAVORITED", "90c3a9e8-b321-4dae-bf57-2bf79bbcc187", "You have not favorited the clip."),
  notesClipsNoSuchNote: err("NO_SUCH_NOTE", "47db1a1c-b0af-458d-8fb4-986e4efafe1e", "No such note."),
};

const str = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : undefined);
const limitOf = (body: Body, def = 10) => Math.max(1, Math.min(100, Math.floor(typeof body.limit === "number" ? body.limit : def)));
const noContent = () => new Response(null, { status: 204 });

type ClipRow = { id: string; userId: string; name: string; description: string | null; isPublic: boolean; lastClippedAt: string | Date | null };

async function getClip(c: PgQueryable, id: string): Promise<ClipRow | null> {
  const r = await c.query(`SELECT id, "userId", name, description, "isPublic", "lastClippedAt" FROM clip WHERE id = $1`, [id]);
  return (r.rows[0] as ClipRow | undefined) ?? null;
}

/** ClipEntityService.packMany (`single`: ClipEntityService.pack, whose user is packed without a viewer) */
export async function packClips(env: ApiEnv, c: PgQueryable, clips: ClipRow[], meId: string | null, single = false): Promise<Record<string, unknown>[]> {
  if (!clips.length) return [];
  const ids = clips.map((x) => x.id);
  const users = await getUsersByIdsPg(env, clips.map((x) => x.userId), single ? null : meId);
  const config = buildPackConfig(env);
  const favs = new Map<string, number>();
  for (const r of (await c.query(`SELECT "clipId", count(*)::int AS n FROM clip_favorite WHERE "clipId" = ANY($1::varchar[]) GROUP BY "clipId"`, [ids])).rows) favs.set(String(r.clipId), Number(r.n));
  const mine = new Set<string>();
  const counts = new Map<string, number>();
  if (meId) {
    for (const r of (await c.query(`SELECT "clipId" FROM clip_favorite WHERE "userId" = $1 AND "clipId" = ANY($2::varchar[])`, [meId, ids])).rows) mine.add(String(r.clipId));
    const own = clips.filter((x) => x.userId === meId).map((x) => x.id);
    if (own.length) {
      for (const r of (await c.query(`SELECT "clipId", count(*)::int AS n FROM clip_note WHERE "clipId" = ANY($1::varchar[]) GROUP BY "clipId"`, [own])).rows) counts.set(String(r.clipId), Number(r.n));
    }
  }
  const out: Record<string, unknown>[] = [];
  for (const clip of clips) {
    const u = users.get(clip.userId);
    if (!u) continue;
    const packed: Record<string, unknown> = {
      id: clip.id,
      createdAt: (parseAidxTime(clip.id) ?? new Date(0)).toISOString(),
      lastClippedAt: clip.lastClippedAt ? new Date(clip.lastClippedAt).toISOString() : null,
      userId: clip.userId,
      user: packUserLite(u, config),
      name: clip.name,
      description: clip.description ?? null,
      isPublic: Boolean(clip.isPublic),
      favoritedCount: favs.get(clip.id) ?? 0,
    };
    if (meId) packed.isFavorited = mine.has(clip.id);
    if (meId === clip.userId) packed.notesCount = counts.get(clip.id) ?? 0;
    out.push(packed);
  }
  return out;
}

async function packOne(env: ApiEnv, c: PgQueryable, clip: ClipRow, meId: string | null) {
  return (await packClips(env, c, [clip], meId, true))[0];
}

function validName(v: unknown) {
  return typeof v === "string" && v.length >= 1 && v.length <= 100;
}
function validDesc(v: unknown) {
  return v === undefined || v === null || (typeof v === "string" && v.length <= 2048);
}

const clipsCreate: ClipHandler = async (env, body, ctx) => {
  const me = await auth(env, body, ctx);
  if (!me) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  if (!validName(body.name) || !validDesc(body.description) || (body.isPublic !== undefined && typeof body.isPublic !== "boolean")) return bad();
  return withHyperdriveClient(hd(env), async (c) => {
    const n = Number((await c.query(`SELECT count(*)::int AS n FROM clip WHERE "userId" = $1`, [me])).rows[0]?.n ?? 0);
    const policies = await getUserPoliciesPg(env, c, me);
    if (n >= Number(policies.clipLimit ?? 10)) return fail(E.tooManyClips);
    const id = genAidx(Date.now());
    // upstream: `ps.description || null`
    await c.query(`INSERT INTO clip (id, "userId", name, "isPublic", description) VALUES ($1, $2, $3, $4, $5)`, [id, me, body.name, body.isPublic === true, (body.description as string | null | undefined) || null]);
    return packOne(env, c, { id, userId: me, name: body.name as string, isPublic: body.isPublic === true, description: (body.description as string | null) || null, lastClippedAt: null }, me);
  });
};

const clipsUpdate: ClipHandler = async (env, body, ctx) => {
  const me = await auth(env, body, ctx);
  if (!me) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  const clipId = str(body.clipId);
  if (!clipId || (body.name !== undefined && !validName(body.name)) || !validDesc(body.description) || (body.isPublic !== undefined && typeof body.isPublic !== "boolean")) return bad();
  return withHyperdriveClient(hd(env), async (c) => {
    const clip = await getClip(c, clipId);
    if (!clip || clip.userId !== me) return fail(E.update);
    const sets: string[] = [];
    const params: unknown[] = [];
    if (body.name !== undefined) { params.push(body.name); sets.push(`name = $${params.length}`); }
    if (body.isPublic !== undefined) { params.push(body.isPublic); sets.push(`"isPublic" = $${params.length}`); }
    // upstream passes `ps.description || null`; TypeORM skips undefined only
    params.push((body.description as string | null | undefined) || null);
    sets.push(`description = $${params.length}`);
    params.push(clip.id);
    await c.query(`UPDATE clip SET ${sets.join(", ")} WHERE id = $${params.length}`, params);
    return packOne(env, c, (await getClip(c, clip.id))!, me);
  });
};

const clipsDelete: ClipHandler = async (env, body, ctx) => {
  const me = await auth(env, body, ctx);
  if (!me) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  const clipId = str(body.clipId);
  if (!clipId) return bad();
  return withHyperdriveClient(hd(env), async (c) => {
    const clip = await getClip(c, clipId);
    if (!clip || clip.userId !== me) return fail(E.delete);
    // clip_note / clip_favorite cascade (FK); upstream leaves note.clippedCount as is
    await c.query(`DELETE FROM clip WHERE id = $1`, [clip.id]);
    return noContent();
  });
};

const clipsList: ClipHandler = async (env, body, ctx) => {
  const me = await auth(env, body, ctx);
  if (!me) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  return listClips(env, body, me, (p) => { p.push(me); return `c."userId" = $${p.length}`; });
};

async function listClips(env: ApiEnv, body: Body, me: string | null, where: (p: unknown[]) => string) {
  const params: unknown[] = [];
  const w = where(params);
  const pg = pagination(body, params, "c.id");
  params.push(limitOf(body));
  return withHyperdriveClient(hd(env), async (c) => {
    const rows = (await c.query(
      `SELECT c.id, c."userId", c.name, c.description, c."isPublic", c."lastClippedAt" FROM clip c WHERE ${[w, ...pg.where].join(" AND ")} ORDER BY c.id ${pg.order} LIMIT $${params.length}`,
      params,
    )).rows as ClipRow[];
    return packClips(env, c, rows, me);
  });
}

const clipsShow: ClipHandler = async (env, body, ctx) => {
  const clipId = str(body.clipId);
  if (!clipId) return bad();
  const me = await auth(env, body, ctx);
  return withHyperdriveClient(hd(env), async (c) => {
    const clip = await getClip(c, clipId);
    if (!clip || (!clip.isPublic && clip.userId !== me)) return fail(E.show);
    return packOne(env, c, clip, me);
  });
};

const numOrNull = (v: unknown): number | null => (typeof v === "number" ? v : null);

const clipsNotes: ClipHandler = async (env, body, ctx) => {
  const clipId = str(body.clipId);
  if (!clipId) return bad();
  if (body.search != null && (typeof body.search !== "string" || body.search.length < 1 || body.search.length > 100)) return bad();
  const me = await auth(env, body, ctx);
  const clip = await withHyperdriveClient(hd(env), (c) => getClip(c, clipId));
  if (!clip || (!clip.isPublic && clip.userId !== me)) return fail(E.notes);
  // upstream: pagination + clip join, visibility, blocked hosts (suspended users are not filtered),
  // mutes / blocks for the note and its renote, then the search words
  const notes = await withHyperdriveClient(hd(env), async (c) => {
    const q = new NoteQuery(await metaRowPg(c)).paginate(str(body.sinceId), str(body.untilId), numOrNull(body.sinceDate), numOrNull(body.untilDate));
    q.joins += ` INNER JOIN clip_note "clipNote" ON "clipNote"."noteId" = note.id`;
    q.and(`"clipNote"."clipId" = ${q.p(clip.id)}`);
    q.visibility(me);
    q.blockedHost();
    if (me) {
      q.mutedUser(me);
      q.blockedUser(me);
      q.mutedUser(me, { noteColumn: "renote" });
      q.blockedUser(me, "renote");
    }
    if (typeof body.search === "string") {
      for (const word of body.search.trim().split(" ")) {
        const w = q.p(`%${likeEscape(word)}%`);
        q.and(`note.text ILIKE ${w} OR note.cw ILIKE ${w}`);
      }
    }
    return q.run(c, limitOf(body));
  });
  return packNotesFromPg(env, notes, buildPackConfig(env), me);
};

/** upstream sqlLikeEscape */
export function likeEscape(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}

const clipsAddNote: ClipHandler = async (env, body, ctx) => {
  const me = await auth(env, body, ctx);
  if (!me) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  const clipId = str(body.clipId);
  const noteId = str(body.noteId);
  if (!clipId || !noteId) return bad();
  return withHyperdriveClient(hd(env), async (c) => {
    const clip = await getClip(c, clipId);
    if (!clip || clip.userId !== me) return fail(E.addNoSuchClip);
    const n = Number((await c.query(`SELECT count(*)::int AS n FROM clip_note WHERE "clipId" = $1`, [clip.id])).rows[0]?.n ?? 0);
    if (n >= Number((await getUserPoliciesPg(env, c, me)).noteEachClipsLimit ?? 200)) return fail(E.tooManyClipNotes);
    // upstream relies on the FK for NO_SUCH_NOTE (no visibility check)
    const note = (await c.query(`SELECT id FROM note WHERE id = $1`, [noteId])).rows[0];
    if (!note) return fail(E.addNoSuchNote);
    const ins = await c.query(`INSERT INTO clip_note (id, "noteId", "clipId") VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING id`, [genAidx(Date.now()), noteId, clip.id]);
    if (!ins.rows.length) return fail(E.alreadyClipped);
    await c.query(`UPDATE clip SET "lastClippedAt" = now() WHERE id = $1`, [clip.id]);
    await c.query(`UPDATE note SET "clippedCount" = "clippedCount" + 1 WHERE id = $1`, [noteId]);
    return noContent();
  });
};

const clipsRemoveNote: ClipHandler = async (env, body, ctx) => {
  const me = await auth(env, body, ctx);
  if (!me) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  const clipId = str(body.clipId);
  const noteId = str(body.noteId);
  if (!clipId || !noteId) return bad();
  return withHyperdriveClient(hd(env), async (c) => {
    const clip = await getClip(c, clipId);
    if (!clip || clip.userId !== me) return fail(E.removeNoSuchClip);
    const del = await c.query(`DELETE FROM clip_note WHERE "noteId" = $1 AND "clipId" = $2 RETURNING id`, [noteId, clip.id]);
    if (!del.rows.length) return fail(E.removeNoSuchNote);
    await c.query(`UPDATE note SET "clippedCount" = "clippedCount" - 1 WHERE id = $1`, [noteId]);
    return noContent();
  });
};

const clipsFavorite: ClipHandler = async (env, body, ctx) => {
  const me = await auth(env, body, ctx);
  if (!me) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  const clipId = str(body.clipId);
  if (!clipId) return bad();
  return withHyperdriveClient(hd(env), async (c) => {
    const clip = await getClip(c, clipId);
    if (!clip || (clip.userId !== me && !clip.isPublic)) return fail(E.favNoSuchClip);
    const ex = await c.query(`SELECT 1 AS ok FROM clip_favorite WHERE "clipId" = $1 AND "userId" = $2`, [clip.id, me]);
    if (ex.rows.length) return fail(E.alreadyFavorited);
    const ins = await c.query(`INSERT INTO clip_favorite (id, "userId", "clipId") VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING id`, [genAidx(Date.now()), me, clip.id]);
    if (!ins.rows.length) return fail(E.alreadyFavorited);
    return noContent();
  });
};

const clipsUnfavorite: ClipHandler = async (env, body, ctx) => {
  const me = await auth(env, body, ctx);
  if (!me) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  const clipId = str(body.clipId);
  if (!clipId) return bad();
  return withHyperdriveClient(hd(env), async (c) => {
    const clip = await getClip(c, clipId);
    if (!clip) return fail(E.unfavNoSuchClip);
    const del = await c.query(`DELETE FROM clip_favorite WHERE "clipId" = $1 AND "userId" = $2 RETURNING id`, [clip.id, me]);
    if (!del.rows.length) return fail(E.notFavorited);
    return noContent();
  });
};

const clipsMyFavorites: ClipHandler = async (env, body, ctx) => {
  const me = await auth(env, body, ctx);
  if (!me) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  return withHyperdriveClient(hd(env), async (c) => {
    const rows = (await c.query(
      `SELECT c.id, c."userId", c.name, c.description, c."isPublic", c."lastClippedAt"
       FROM clip_favorite f JOIN clip c ON c.id = f."clipId" WHERE f."userId" = $1 ORDER BY f.id`, // (upstream: no ORDER BY)
      [me],
    )).rows as ClipRow[];
    return packClips(env, c, rows, me);
  });
};

const notesClips: ClipHandler = async (env, body, ctx) => {
  const noteId = str(body.noteId);
  if (!noteId) return bad();
  const me = await auth(env, body, ctx);
  const note = await getNotePg(env, noteId);
  // upstream GetterService.getNote only checks existence
  if (!note) return fail(E.notesClipsNoSuchNote);
  return withHyperdriveClient(hd(env), async (c) => {
    const rows = (await c.query(
      `SELECT c.id, c."userId", c.name, c.description, c."isPublic", c."lastClippedAt"
       FROM clip c WHERE c."isPublic" = TRUE AND c.id IN (SELECT "clipId" FROM clip_note WHERE "noteId" = $1)`,
      [noteId],
    )).rows as ClipRow[];
    return packClips(env, c, rows, me);
  });
};

const usersClips: ClipHandler = async (env, body, ctx) => {
  const userId = str(body.userId);
  if (!userId) return bad();
  const me = await auth(env, body, ctx);
  return listClips(env, body, me, (p) => { p.push(userId); return `c."userId" = $${p.length} AND c."isPublic" = TRUE`; });
};

function pgOnly(h: ClipHandler): ClipHandler {
  return async (env, body, ctx) => {
    if (!env.HYPERDRIVE?.connectionString) {
      return apiErrorResponse({ message: "Hyperdrive required.", code: "HYPERDRIVE_UNBOUND", id: "00000000-0000-4000-8000-0000000000b1", kind: "server" }, 501);
    }
    return h(env, body, ctx);
  };
}

const RAW: Record<string, ClipHandler> = {
  "clips/create": clipsCreate,
  "clips/update": clipsUpdate,
  "clips/delete": clipsDelete,
  "clips/list": clipsList,
  "clips/show": clipsShow,
  "clips/notes": clipsNotes,
  "clips/add-note": clipsAddNote,
  "clips/remove-note": clipsRemoveNote,
  "clips/favorite": clipsFavorite,
  "clips/unfavorite": clipsUnfavorite,
  "clips/my-favorites": clipsMyFavorites,
  "notes/clips": notesClips,
  "users/clips": usersClips,
};

export const clipHandlers: Record<string, ClipHandler> = Object.fromEntries(Object.entries(RAW).map(([k, h]) => [k, pgOnly(h)]));

