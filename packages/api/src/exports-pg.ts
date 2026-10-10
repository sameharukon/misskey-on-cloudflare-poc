/**
 * Data exports (W7.10): i/export-following|mute|blocking|user-lists|antennas|favorites|clips|notes.
 *
 * Upstream queues one job per export; the processor writes a CSV / JSON file into the user's
 * drive and sends an `exportCompleted` notification with the file id. Here the endpoint enqueues
 * an `export` job on `mk-jobs`, and the consumer builds the file in memory and stores it with
 * addFilePg (R2 + drive_file). File names, line / object formats and the notification follow the
 * upstream processors. Each export is built in a single invocation, so very large accounts
 * (notes in particular) are bounded by Worker memory and CPU limits.
 */

import { parseAidxTime } from "../../id/src/index.js";
import type { ApiEnv } from "./env.js";
import { apiErrorResponse, CREDENTIAL_REQUIRED, INVALID_PARAM } from "./errors.js";
import { authenticatePg, extractToken } from "./auth-pg.js";
import { withHyperdriveClient, type PgQueryable } from "./pg.js";
import { buildPackConfig } from "./meta-source.js";
import { addFilePg } from "./drive-pg.js";
import { packDriveFile } from "./drive/pack.js";
import { createNotification } from "./notifications-do.js";
import { visibilitySql } from "./client-endpoints-pg.js";
import { hd } from "./handler-kit.js";
import { enqueueJob } from "./queues/jobs-queue.js";

type Ctx = { hasCredential: boolean; request: Request };
type Body = Record<string, unknown>;
type Handler = (env: ApiEnv, body: Body, ctx: Ctx) => Promise<Response | unknown>;
type Row = Record<string, unknown>;

export const EXPORT_ENTITIES = {
  following: { endpoint: "i/export-following", file: "following", ext: "csv", notify: "following" },
  muting: { endpoint: "i/export-mute", file: "mute", ext: "csv", notify: "muting" },
  blocking: { endpoint: "i/export-blocking", file: "blocking", ext: "csv", notify: "blocking" },
  userList: { endpoint: "i/export-user-lists", file: "user-lists", ext: "csv", notify: "userList" },
  antenna: { endpoint: "i/export-antennas", file: "antennas", ext: "json", notify: "antenna" },
  favorite: { endpoint: "i/export-favorites", file: "favorites", ext: "json", notify: "favorite" },
  clip: { endpoint: "i/export-clips", file: "clips", ext: "json", notify: "clip" },
  note: { endpoint: "i/export-notes", file: "notes", ext: "json", notify: "note" },
} as const;
export type ExportEntity = keyof typeof EXPORT_ENTITIES;

export type ExportJob = { kind: "export"; entity: ExportEntity; userId: string; excludeMuting?: boolean; excludeInactive?: boolean };

const iso = (id: string) => (parseAidxTime(id) ?? new Date(0)).toISOString();
const isoOrNull = (v: unknown) => (v ? new Date(String(v)).toISOString() : null);

/** dateFormat(new Date(), 'yyyy-MM-dd-HH-mm-ss') */
function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

/** UtilityService.getFullApAccount */
function acct(env: ApiEnv, username: unknown, host: unknown): string {
  return `${String(username)}@${host ? String(host) : buildPackConfig(env).host}`;
}

/** MiPoll as upstream serializes the entity. */
function rawPoll(p: Row | undefined): Row | null {
  if (!p) return null;
  return {
    noteId: p.noteId,
    expiresAt: isoOrNull(p.expiresAt),
    multiple: Boolean(p.multiple),
    choices: p.choices ?? [],
    votes: p.votes ?? [],
    noteVisibility: p.noteVisibility ?? null,
    userId: p.userId ?? null,
    userHost: p.userHost ?? null,
    channelId: p.channelId ?? null,
  };
}

async function pollsOf(c: PgQueryable, noteIds: string[]): Promise<Map<string, Row>> {
  if (!noteIds.length) return new Map();
  const r = await c.query(`SELECT * FROM poll WHERE "noteId" = ANY($1::varchar[])`, [noteIds]);
  return new Map(r.rows.map((p) => [String(p.noteId), p]));
}

/** The note part shared by the favorites and clips exports. */
function noteWithUser(n: Row, poll: Row | undefined): Row {
  return {
    id: n.id,
    text: n.text ?? null,
    createdAt: iso(String(n.id)),
    fileIds: n.fileIds ?? [],
    replyId: n.replyId ?? null,
    renoteId: n.renoteId ?? null,
    poll: rawPoll(poll),
    cw: n.cw ?? null,
    visibility: n.visibility,
    visibleUserIds: n.visibleUserIds ?? [],
    localOnly: Boolean(n.localOnly),
    reactionAcceptance: n.reactionAcceptance ?? null,
    uri: n.uri ?? null,
    url: n.url ?? null,
    user: { id: n.uId, name: n.uName ?? null, username: n.uUsername, host: n.uHost ?? null, uri: n.uUri ?? null },
  };
}

const NOTE_USER_COLS = `n.*, u.id AS "uId", u.name AS "uName", u.username AS "uUsername", u.host AS "uHost", u.uri AS "uUri"`;

async function buildContent(env: ApiEnv, c: PgQueryable, job: ExportJob): Promise<string> {
  const me = job.userId;
  switch (job.entity) {
    case "following": {
      const r = await c.query(
        `SELECT f."withReplies", u.username, u.host, u."updatedAt"
         FROM following f JOIN "user" u ON u.id = f."followeeId"
         WHERE f."followerId" = $1
           ${job.excludeMuting ? `AND f."followeeId" NOT IN (SELECT "muteeId" FROM muting WHERE "muterId" = $1)` : ""}
         ORDER BY f.id`,
        [me],
      );
      const cutoff = Date.now() - 1000 * 60 * 60 * 24 * 90;
      return r.rows
        .filter((x) => !(job.excludeInactive && x.updatedAt && new Date(String(x.updatedAt)).getTime() < cutoff))
        .map((x) => `${acct(env, x.username, x.host)},withReplies=${Boolean(x.withReplies)}\n`)
        .join("");
    }
    case "muting":
    case "blocking": {
      const [table, me_, other] = job.entity === "muting" ? ["muting", "muterId", "muteeId"] : ["blocking", "blockerId", "blockeeId"];
      const r = await c.query(
        `SELECT u.username, u.host FROM ${table} m JOIN "user" u ON u.id = m."${other}"
         WHERE m."${me_}" = $1 ${job.entity === "muting" ? `AND m."expiresAt" IS NULL` : ""} ORDER BY m.id`,
        [me],
      );
      return r.rows.map((x) => `${acct(env, x.username, x.host)}\n`).join("");
    }
    case "userList": {
      const r = await c.query(
        `SELECT l.name, u.username, u.host, m."withReplies"
         FROM user_list l JOIN user_list_membership m ON m."userListId" = l.id JOIN "user" u ON u.id = m."userId"
         WHERE l."userId" = $1 ORDER BY l.id, m.id`,
        [me],
      );
      return r.rows.map((x) => `${x.name},${acct(env, x.username, x.host)},withReplies=${Boolean(x.withReplies)}\n`).join("");
    }
    case "antenna": {
      const antennas = (await c.query(`SELECT * FROM antenna WHERE "userId" = $1 ORDER BY id`, [me])).rows;
      const out: string[] = [];
      for (const a of antennas) {
        let userListAccts: string[] | null = null;
        if (a.userListId) {
          userListAccts = (await c.query(
            `SELECT u.username, u.host FROM user_list_membership m JOIN "user" u ON u.id = m."userId" WHERE m."userListId" = $1`,
            [a.userListId],
          )).rows.map((x) => acct(env, x.username, x.host));
        }
        out.push(JSON.stringify({
          name: a.name,
          src: a.src,
          keywords: a.keywords,
          excludeKeywords: a.excludeKeywords,
          users: a.users,
          userListAccts,
          caseSensitive: Boolean(a.caseSensitive),
          localOnly: Boolean(a.localOnly),
          excludeBots: Boolean(a.excludeBots),
          withReplies: Boolean(a.withReplies),
          withFile: Boolean(a.withFile),
          excludeNotesInSensitiveChannel: Boolean(a.excludeNotesInSensitiveChannel),
        }));
      }
      return `[${out.join(", ")}]`;
    }
    case "favorite": {
      const r = await c.query(
        `SELECT fav.id AS "favId", ${NOTE_USER_COLS}
         FROM note_favorite fav JOIN note n ON n.id = fav."noteId" JOIN "user" u ON u.id = n."userId"
         WHERE fav."userId" = $1 ORDER BY fav.id`,
        [me],
      );
      const polls = await pollsOf(c, r.rows.filter((n) => n.hasPoll).map((n) => String(n.id)));
      return `[${r.rows.map((n) => JSON.stringify({ id: n.favId, createdAt: iso(String(n.favId)), note: noteWithUser(n, polls.get(String(n.id))) })).join(",\n")}]`;
    }
    case "clip": {
      const clips = (await c.query(`SELECT * FROM clip WHERE "userId" = $1 ORDER BY id`, [me])).rows;
      const out: string[] = [];
      for (const cl of clips) {
        const notes = (await c.query(
          `SELECT cn.id AS "cnId", ${NOTE_USER_COLS}
           FROM clip_note cn JOIN note n ON n.id = cn."noteId" JOIN "user" u ON u.id = n."userId"
           WHERE cn."clipId" = $2 AND ${visibilitySql("$1")} ORDER BY cn.id`,
          [me, cl.id],
        )).rows;
        const polls = await pollsOf(c, notes.filter((n) => n.hasPoll).map((n) => String(n.id)));
        out.push(JSON.stringify({
          id: cl.id,
          name: cl.name,
          description: cl.description ?? null,
          lastClippedAt: cl.lastClippedAt ? new Date(String(cl.lastClippedAt)).toISOString() : undefined,
          clipNotes: notes.map((n) => ({ id: n.cnId, createdAt: iso(String(n.cnId)), note: noteWithUser(n, polls.get(String(n.id))) })),
        }));
      }
      return `[${out.join(",\n")}]`;
    }
    case "note": {
      const out: string[] = [];
      let cursor = "";
      for (;;) {
        const notes = (await c.query(`SELECT * FROM note WHERE "userId" = $1 AND id > $2 ORDER BY id LIMIT 100`, [me, cursor])).rows;
        if (!notes.length) break;
        cursor = String(notes.at(-1)!.id);
        const polls = await pollsOf(c, notes.filter((n) => n.hasPoll).map((n) => String(n.id)));
        const fileIds = [...new Set(notes.flatMap((n) => (n.fileIds as string[] | null) ?? []))];
        const files = fileIds.length
          ? new Map((await c.query(`SELECT * FROM drive_file WHERE id = ANY($1::varchar[])`, [fileIds])).rows.map((f) => [String(f.id), packDriveFile(f)]))
          : new Map<string, unknown>();
        for (const n of notes) {
          out.push(JSON.stringify({
            id: n.id,
            text: n.text ?? null,
            createdAt: iso(String(n.id)),
            fileIds: n.fileIds ?? [],
            files: ((n.fileIds as string[] | null) ?? []).map((id) => files.get(id)).filter(Boolean),
            replyId: n.replyId ?? null,
            renoteId: n.renoteId ?? null,
            poll: rawPoll(polls.get(String(n.id))),
            cw: n.cw ?? null,
            visibility: n.visibility,
            visibleUserIds: n.visibleUserIds ?? [],
            localOnly: Boolean(n.localOnly),
            reactionAcceptance: n.reactionAcceptance ?? null,
          }));
        }
      }
      return `[${out.join(",")}]`;
    }
  }
}

/** Export processor: build the file, store it in the drive, notify `exportCompleted`. */
export async function runExport(env: ApiEnv, job: ExportJob): Promise<string | null> {
  const def = EXPORT_ENTITIES[job.entity];
  if (!def) return null;
  const content = await withHyperdriveClient(hd(env), async (c) => {
    const exists = (await c.query(`SELECT 1 AS ok FROM "user" WHERE id = $1`, [job.userId])).rows.length > 0;
    return exists ? buildContent(env, c, job) : null;
  });
  if (content == null) return null;
  const row = await addFilePg(env, {
    userId: job.userId,
    bytes: new TextEncoder().encode(content),
    name: `${def.file}-${stamp()}.${def.ext}`,
    force: true,
    typeHint: def.ext === "csv" ? { mime: "text/csv", ext: "csv" } : { mime: "application/json", ext: "json" },
  });
  const fileId = String(row.id);
  await createNotification(env, job.userId, { type: "exportCompleted", notifierId: null, exportedEntity: def.notify, fileId });
  return fileId;
}

// ---------------------------------------------------------------- endpoints

async function enqueueExport(env: ApiEnv, job: ExportJob): Promise<void> {
  if (env.Q_JOBS) await enqueueJob(env, job);
  else await runExport(env, job);
}

function exportHandler(entity: ExportEntity): Handler {
  return async (env, body, ctx) => {
    if (!env.HYPERDRIVE?.connectionString) {
      return apiErrorResponse({ message: "Hyperdrive required.", code: "HYPERDRIVE_UNBOUND", id: "00000000-0000-4000-8000-0000000000b1", kind: "server" }, 501);
    }
    if (!ctx.hasCredential) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
    const token = extractToken(ctx.request, body);
    const me = token ? ((await authenticatePg(env, token))?.user.id ?? null) : null;
    if (!me) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
    const job: ExportJob = { kind: "export", entity, userId: me };
    if (entity === "following") {
      for (const k of ["excludeMuting", "excludeInactive"] as const) {
        if (body[k] !== undefined && typeof body[k] !== "boolean") return apiErrorResponse(INVALID_PARAM, 400);
        job[k] = body[k] === true;
      }
    }
    await enqueueExport(env, job);
    return new Response(null, { status: 204 });
  };
}

export const exportHandlers: Record<string, Handler> = Object.fromEntries(
  (Object.keys(EXPORT_ENTITIES) as ExportEntity[]).map((e) => [EXPORT_ENTITIES[e].endpoint, exportHandler(e)]),
);

