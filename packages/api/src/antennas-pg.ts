/**
 * Antennas (W7.7) on PG (`antenna`; upstream schema): antennas/create|update|delete|list|show|
 * notes|remove-note. Matching runs in the fanout consumer (packages/timeline/src/antenna.ts),
 * which appends hits to the TimelineShard `antenna:{id}` (upstream: Redis
 * `antennaTimeline:{id}`, 200 entries); antennas/notes reads those ids back and packs them
 * with the usual visibility / mute / block filtering.
 */

import { genAidx, genAidxFromDate, parseAidxTime } from "../../id/src/index.js";
import { timelineDoId } from "../../shared/src/index.js";
import type { ApiEnv } from "./env.js";
import { apiErrorResponse, CREDENTIAL_REQUIRED } from "./errors.js";
import { withHyperdriveClient, type PgQueryable } from "./pg.js";
import { getUserPoliciesPg } from "./policies-pg.js";
import { NoteQuery, mutedChannelIdsPg } from "./note-query.js";
import { metaRowPg } from "./user-lite-pg.js";
import { buildPackConfig } from "./meta-source.js";
import { listTimelineIdsFromDo, packNotesFromPg } from "./notes-pg.js";
import { authUserId as auth, clientError as err, errorResponse as fail, hd, invalidParam as bad } from "./handler-kit.js";

type Ctx = { hasCredential: boolean; request: Request };
type Body = Record<string, unknown>;
export type AntennaHandler = (env: ApiEnv, body: Body, ctx: Ctx) => Promise<Response | unknown>;

const noSuchAntenna = (id: string) => err("NO_SUCH_ANTENNA", id, "No such antenna.");
const noSuchUserList = (id: string) => err("NO_SUCH_USER_LIST", id, "No such user list.");
const E = {
  createNoSuchUserList: noSuchUserList("95063e93-a283-4b8b-9aa5-bcdb8df69a7f"),
  tooManyAntennas: err("TOO_MANY_ANTENNAS", "faf47050-e8b5-438c-913c-db2b1576fde4", "You cannot create antenna any more."),
  createEmptyKeyword: err("EMPTY_KEYWORD", "53ee222e-1ddd-4f9a-92e5-9fb82ddb463a", "Either keywords or excludeKeywords is required."),
  deleteNoSuchAntenna: noSuchAntenna("b34dcf9d-348f-44bb-99d0-6c9314cfe2df"),
  notesNoSuchAntenna: noSuchAntenna("850926e0-fd3b-49b6-b69a-b28a5dbd82fe"),
  showNoSuchAntenna: noSuchAntenna("c06569fb-b025-4f23-b22d-1fcd20d2816b"),
  updateNoSuchAntenna: noSuchAntenna("10c673ac-8852-48eb-aa1f-f5b67f069290"),
  updateNoSuchUserList: noSuchUserList("1c6b35c9-943e-48c2-81e4-2844989407f7"),
  updateEmptyKeyword: err("EMPTY_KEYWORD", "721aaff6-4e1b-4d88-8de6-877fae9f68c4", "Either keywords or excludeKeywords is required."),
};

const str = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : undefined);
const noContent = () => new Response(null, { status: 204 });

const SRC = ["home", "all", "users", "list", "users_blacklist"];
const BOOLS = ["caseSensitive", "localOnly", "excludeBots", "withReplies", "withFile", "excludeNotesInSensitiveChannel"] as const;
const isKeywordGroups = (v: unknown) => Array.isArray(v) && v.every((g) => Array.isArray(g) && g.every((k) => typeof k === "string"));
const isStrArray = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === "string");

/** paramDef check; `required` lists the keys that must be present (create). */
function validParams(body: Body, required: boolean): boolean {
  if (body.name !== undefined || required) {
    if (typeof body.name !== "string" || body.name.length < 1 || body.name.length > 100) return false;
  }
  if (body.src !== undefined || required) {
    if (!SRC.includes(body.src as string)) return false;
  }
  if (body.userListId !== undefined && body.userListId !== null && typeof body.userListId !== "string") return false;
  for (const k of ["keywords", "excludeKeywords"]) {
    if ((body[k] !== undefined || required) && !isKeywordGroups(body[k])) return false;
  }
  if ((body.users !== undefined || required) && !isStrArray(body.users)) return false;
  for (const k of BOOLS) {
    const req = required && ["caseSensitive", "withReplies", "withFile"].includes(k);
    if ((body[k] !== undefined || req) && typeof body[k] !== "boolean") return false;
  }
  return true;
}

const allEmpty = (groups: unknown) => (groups as string[][]).flat().every((x) => x === "");

type AntennaRow = Record<string, unknown> & { id: string; userId: string };

async function getAntenna(c: PgQueryable, id: string, userId: string): Promise<AntennaRow | null> {
  const r = await c.query(`SELECT * FROM antenna WHERE id = $1 AND "userId" = $2`, [id, userId]);
  return (r.rows[0] as AntennaRow | undefined) ?? null;
}

async function ownList(c: PgQueryable, listId: string, userId: string): Promise<boolean> {
  return (await c.query(`SELECT 1 FROM user_list WHERE id = $1 AND "userId" = $2`, [listId, userId])).rows.length > 0;
}

/** AntennaEntityService.pack */
export function packAntenna(a: AntennaRow) {
  return {
    id: a.id,
    createdAt: (parseAidxTime(a.id) ?? new Date(0)).toISOString(),
    name: String(a.name),
    keywords: (a.keywords as string[][]) ?? [],
    excludeKeywords: (a.excludeKeywords as string[][]) ?? [],
    src: String(a.src),
    userListId: (a.userListId as string | null) ?? null,
    users: (a.users as string[]) ?? [],
    caseSensitive: Boolean(a.caseSensitive),
    localOnly: Boolean(a.localOnly),
    excludeBots: Boolean(a.excludeBots),
    withReplies: Boolean(a.withReplies),
    withFile: Boolean(a.withFile),
    excludeNotesInSensitiveChannel: Boolean(a.excludeNotesInSensitiveChannel),
    isActive: Boolean(a.isActive),
    hasUnreadNote: false,
    notify: false,
  };
}

const antennasCreate: AntennaHandler = async (env, body, ctx) => {
  const me = await auth(env, body, ctx);
  if (!me) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  if (!validParams(body, true)) return bad();
  if (allEmpty(body.keywords) && allEmpty(body.excludeKeywords)) return fail(E.createEmptyKeyword);
  return withHyperdriveClient(hd(env), async (c) => {
    const n = Number((await c.query(`SELECT count(*)::int AS n FROM antenna WHERE "userId" = $1`, [me])).rows[0]?.n ?? 0);
    if (n >= Number((await getUserPoliciesPg(env, c, me)).antennaLimit ?? 5)) return fail(E.tooManyAntennas);
    let userListId: string | null = null;
    if (body.src === "list" && typeof body.userListId === "string" && body.userListId) {
      if (!(await ownList(c, body.userListId, me))) return fail(E.createNoSuchUserList);
      userListId = body.userListId;
    }
    const now = Date.now();
    const id = genAidx(now);
    await c.query(
      `INSERT INTO antenna (id, "lastUsedAt", "userId", name, src, "userListId", keywords, "excludeKeywords", users,
         "caseSensitive", "localOnly", "excludeBots", "withReplies", "withFile", "excludeNotesInSensitiveChannel", "isActive")
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::varchar[], $10, $11, $12, $13, $14, $15, TRUE)`,
      [id, new Date(now).toISOString(), me, body.name, body.src, userListId, JSON.stringify(body.keywords), JSON.stringify(body.excludeKeywords), body.users,
        body.caseSensitive, body.localOnly === true, body.excludeBots === true, body.withReplies, body.withFile, body.excludeNotesInSensitiveChannel === true],
    );
    return packAntenna((await getAntenna(c, id, me))!);
  });
};

const antennasUpdate: AntennaHandler = async (env, body, ctx) => {
  const me = await auth(env, body, ctx);
  if (!me) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  const antennaId = str(body.antennaId);
  if (!antennaId || !validParams(body, false)) return bad();
  if (body.keywords !== undefined && body.excludeKeywords !== undefined && allEmpty(body.keywords) && allEmpty(body.excludeKeywords)) {
    return fail(E.updateEmptyKeyword);
  }
  return withHyperdriveClient(hd(env), async (c) => {
    const a = await getAntenna(c, antennaId, me);
    if (!a) return fail(E.updateNoSuchAntenna);
    let listOk = false;
    if ((body.src === "list" || a.src === "list") && typeof body.userListId === "string" && body.userListId) {
      if (!(await ownList(c, body.userListId, me))) return fail(E.updateNoSuchUserList);
      listOk = true;
    }
    const sets: string[] = [];
    const params: unknown[] = [];
    const set = (col: string, v: unknown, cast = "") => {
      params.push(v);
      sets.push(`"${col}" = $${params.length}${cast}`);
    };
    if (body.name !== undefined) set("name", body.name);
    if (body.src !== undefined) set("src", body.src);
    // upstream: `userListId: ps.userListId !== undefined ? userList ? userList.id : null : undefined`
    if (body.userListId !== undefined) set("userListId", listOk ? body.userListId : null);
    if (body.keywords !== undefined) set("keywords", JSON.stringify(body.keywords), "::jsonb");
    if (body.excludeKeywords !== undefined) set("excludeKeywords", JSON.stringify(body.excludeKeywords), "::jsonb");
    if (body.users !== undefined) set("users", body.users, "::varchar[]");
    for (const k of BOOLS) if (body[k] !== undefined) set(k, body[k]);
    set("isActive", true);
    set("lastUsedAt", new Date().toISOString());
    params.push(a.id);
    await c.query(`UPDATE antenna SET ${sets.join(", ")} WHERE id = $${params.length}`, params);
    return packAntenna((await getAntenna(c, a.id, me))!);
  });
};

const antennasDelete: AntennaHandler = async (env, body, ctx) => {
  const me = await auth(env, body, ctx);
  if (!me) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  const antennaId = str(body.antennaId);
  if (!antennaId) return bad();
  return withHyperdriveClient(hd(env), async (c) => {
    const a = await getAntenna(c, antennaId, me);
    if (!a) return fail(E.deleteNoSuchAntenna);
    await c.query(`DELETE FROM antenna WHERE id = $1`, [a.id]);
    return noContent();
  });
};

const antennasList: AntennaHandler = async (env, body, ctx) => {
  const me = await auth(env, body, ctx);
  if (!me) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  return withHyperdriveClient(hd(env), async (c) =>
    (await c.query(`SELECT * FROM antenna WHERE "userId" = $1 ORDER BY id`, [me])).rows.map((r) => packAntenna(r as AntennaRow)),
  );
};

const antennasShow: AntennaHandler = async (env, body, ctx) => {
  const me = await auth(env, body, ctx);
  if (!me) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  const antennaId = str(body.antennaId);
  if (!antennaId) return bad();
  return withHyperdriveClient(hd(env), async (c) => {
    const a = await getAntenna(c, antennaId, me);
    if (!a) return fail(E.showNoSuchAntenna);
    return packAntenna(a);
  });
};

const antennasNotes: AntennaHandler = async (env, body, ctx) => {
  const me = await auth(env, body, ctx);
  if (!me) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  const antennaId = str(body.antennaId);
  if (!antennaId) return bad();
  const limit = Math.max(1, Math.min(100, Math.floor(typeof body.limit === "number" ? body.limit : 10)));
  const a = await withHyperdriveClient(hd(env), async (c) => {
    const row = await getAntenna(c, antennaId, me);
    // upstream: reading an antenna re-activates it and bumps lastUsedAt
    if (row) await c.query(`UPDATE antenna SET "isActive" = TRUE, "lastUsedAt" = now() WHERE id = $1`, [row.id]);
    return row;
  });
  if (!a) return fail(E.notesNoSuchAntenna);
  // upstream: ps.untilId ?? (ps.untilDate ? idService.gen(untilDate) : null), likewise since
  const untilId = str(body.untilId) ?? (typeof body.untilDate === "number" && body.untilDate ? genAidx(body.untilDate) : null);
  const sinceId = str(body.sinceId) ?? (typeof body.sinceDate === "number" && body.sinceDate ? genAidx(body.sinceDate) : null);
  // FanoutTimelineService.get: the whole list in range, newest first (oldest first for a lone
  // sinceId), then the first `limit`
  const all = await listTimelineIdsFromDo(env, `antenna:${a.id}`, {
    limit: 1_000_000,
    untilId: untilId ?? undefined,
    sinceId: sinceId ?? undefined,
  });
  const ids = all
    ? [...all].sort((x, y) => (sinceId != null && untilId == null ? (x < y ? -1 : 1) : (x > y ? -1 : 1))).slice(0, limit)
    : null;
  if (!ids || ids.length === 0) return [];
  const notes = await withHyperdriveClient(hd(env), async (c) => {
    const q = new NoteQuery(await metaRowPg(c));
    q.and(`note.id = ANY(${q.p(ids)}::varchar[])`);
    // muted channels (the note's own channel and the renoted note's channel)
    const muted = await mutedChannelIdsPg(c, me);
    if (muted.length) {
      const m = q.p(muted);
      q.and(`note."channelId" IS NULL OR note."channelId" != ALL(${m}::varchar[])`);
      q.and(`note."renoteChannelId" IS NULL OR note."renoteChannelId" != ALL(${m}::varchar[])`);
    }
    // (sensitive-content exclusion is ignored here, as upstream)
    q.visibility(me);
    q.baseFiltering(me);
    return q.run(c, null);
  });
  if (sinceId != null && untilId == null) notes.sort((a, b) => (a.id < b.id ? -1 : 1));
  else notes.sort((a, b) => (a.id > b.id ? -1 : 1));
  return packNotesFromPg(env, notes, buildPackConfig(env), me);
};

const antennasRemoveNote: AntennaHandler = async (env, body, ctx) => {
  const me = await auth(env, body, ctx);
  if (!me) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  const antennaId = str(body.antennaId);
  const noteId = str(body.noteId);
  if (!antennaId || !noteId) return bad();
  const a = await withHyperdriveClient(hd(env), (c) => getAntenna(c, antennaId, me));
  if (!a) return fail(E.notesNoSuchAntenna);
  const ns = env.TIMELINE_SHARD;
  if (ns) {
    await ns.get(ns.idFromName(timelineDoId(`antenna:${a.id}`))).remove(noteId);
  }
  return noContent();
};

// ---------------------------------------------------------------- registry

function pgOnly(h: AntennaHandler): AntennaHandler {
  return async (env, body, ctx) => {
    if (!env.HYPERDRIVE?.connectionString) {
      return apiErrorResponse({ message: "Hyperdrive required.", code: "HYPERDRIVE_UNBOUND", id: "00000000-0000-4000-8000-0000000000b1", kind: "server" }, 501);
    }
    return h(env, body, ctx);
  };
}

const RAW: Record<string, AntennaHandler> = {
  "antennas/create": antennasCreate,
  "antennas/update": antennasUpdate,
  "antennas/delete": antennasDelete,
  "antennas/list": antennasList,
  "antennas/show": antennasShow,
  "antennas/notes": antennasNotes,
  "antennas/remove-note": antennasRemoveNote,
};

export const antennaHandlers: Record<string, AntennaHandler> = Object.fromEntries(Object.entries(RAW).map(([k, h]) => [k, pgOnly(h)]));

