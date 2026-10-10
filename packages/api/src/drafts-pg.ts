/**
 * Note drafts and scheduled notes on PG, following upstream NoteDraftService / NoteDraftEntityService:
 * notes/drafts/create|update|delete|list|count.
 *
 * Scheduling: upstream adds a delayed `postScheduledNote` BullMQ job (removed again on update /
 * delete). Here the draft's timer is a PollTimer Durable Object instance named `draft:<id>` whose
 * alarm (re-set on every update, cleared on delete) sends a `postScheduledNote` `mk-jobs` message
 * at scheduledAt. Without that binding the message goes straight to `mk-jobs` with a delay. The job
 * re-reads the draft, so a stale timer or message is harmless; the hourly cron also posts drafts
 * whose time has passed (missed timers).
 */

import { genAidx, parseAidxTime } from "../../id/src/index.js";
import type { ApiEnv } from "./env.js";
import { apiErrorResponse, CREDENTIAL_REQUIRED, type ApiErrorBody } from "./errors.js";
import { authenticatePg, extractToken } from "./auth-pg.js";
import { withHyperdriveClient, type PgQueryable } from "./pg.js";
import { getUserPoliciesPg } from "./policies-pg.js";
import { packUsers, pagination } from "./client-endpoints-pg.js";
import { buildPackConfig } from "./meta-source.js";
import { getNotesByIdsPg, isPureRenote, packNotesFromPg, rowToPackNote } from "./notes-pg.js";
import { canViewNote } from "./visibility.js";
import { packDriveFile } from "./drive/pack.js";
import { createNotification } from "./notifications-do.js";
import { clientError as err, hd, invalidParam as bad } from "./handler-kit.js";
import { enqueueJob } from "./queues/jobs-queue.js";

type Ctx = { hasCredential: boolean; request: Request };
type Body = Record<string, unknown>;
type Handler = (env: ApiEnv, body: Body, ctx: Ctx) => Promise<Response | unknown>;
type Row = Record<string, unknown>;

/** Failures of NoteDraftService.validate / create / update (keys), mapped per endpoint below. */
type Fail =
  | "noSuchDraft" | "tooManyDrafts" | "tooManyScheduled" | "scheduledAtRequired" | "scheduledAtInPast" | "expiredPoll" | "noSuchFile"
  | "noSuchRenote" | "pureRenote" | "blocked" | "renoteVisibility" | "noSuchChannel" | "renoteToExternal"
  | "noSuchReply" | "replyToPureRenote" | "replyToInvisible" | "replyToSpecified";

const COMMON = {
  expiredPoll: err("CANNOT_CREATE_ALREADY_EXPIRED_POLL", "04da457d-b083-4055-9082-955525eda5a5", "Poll is already expired."),
  noSuchFile: err("NO_SUCH_FILE", "b6992544-63e7-67f0-fa7f-32444b1b5306", "Some files are not found."),
  blocked: err("YOU_HAVE_BEEN_BLOCKED", "b390d7e1-8a5e-46ed-b625-06271cafd3d3", "You have been blocked by this user."),
  renoteVisibility: err("CANNOT_RENOTE_DUE_TO_VISIBILITY", "be9529e9-fe72-4de0-ae43-0b363c4938af", "You can not Renote due to target visibility."),
  noSuchChannel: err("NO_SUCH_CHANNEL", "b1653923-5453-4edc-b786-7c4f39bb0bbb", "No such channel."),
  renoteToExternal: err("CANNOT_RENOTE_TO_EXTERNAL", "ed1952ac-2d26-4957-8b30-2deda76bedf7", "Cannot Renote to External."),
  replyToPureRenote: err("CANNOT_REPLY_TO_A_PURE_RENOTE", "3ac74a84-8fd5-4bb0-870f-01804f82ce15", "You can not reply to a pure Renote."),
  replyToInvisible: err("CANNOT_REPLY_TO_AN_INVISIBLE_NOTE", "b98980fa-3780-406c-a935-b6d0eeee10d1", "You cannot reply to an invisible Note."),
  noSuchDraft: err("NO_SUCH_NOTE_DRAFT", "49cd6b9d-848e-41ee-b0b9-adaca711a6b1", "No such note draft."),
};

const CREATE_ERR: Partial<Record<Fail, ApiErrorBody>> = {
  ...COMMON,
  tooManyDrafts: err("TOO_MANY_DRAFTS", "9ee33bbe-fde3-4c71-9b51-e50492c6b9c8", "You cannot create drafts any more."),
  tooManyScheduled: err("TOO_MANY_SCHEDULED_NOTES", "22ae69eb-09e3-4541-a850-773cfa45e693", "You cannot create scheduled notes any more."),
  scheduledAtRequired: err("SCHEDULED_AT_REQUIRED", "15e28a55-e74c-4d65-89b7-8880cdaaa87d", "scheduledAt is required when isActuallyScheduled is true."),
  scheduledAtInPast: err("SCHEDULED_AT_MUST_BE_IN_FUTURE", "e4bed6c9-017e-4934-aed0-01c22cc60ec1", "scheduledAt must be in the future."),
  noSuchRenote: err("NO_SUCH_RENOTE_TARGET", "b5c90186-4ab0-49c8-9bba-a1f76c282ba4", "No such renote target."),
  pureRenote: err("CANNOT_RENOTE_TO_A_PURE_RENOTE", "fd4cc33e-2a37-48dd-99cc-9b806eb2031a", "You can not Renote a pure Renote."),
  noSuchReply: err("NO_SUCH_REPLY_TARGET", "749ee0f6-d3da-459a-bf02-282e2da4292c", "No such reply target."),
  replyToSpecified: err("CANNOT_REPLY_TO_SPECIFIED_VISIBILITY_NOTE_WITH_EXTENDED_VISIBILITY", "ed940410-535c-4d5e-bfa3-af798671e93c", "You cannot reply to a specified visibility note with extended visibility."),
};

const UPDATE_ERR: Partial<Record<Fail, ApiErrorBody>> = {
  ...COMMON,
  tooManyScheduled: err("TOO_MANY_SCHEDULED_NOTES", "02f5df79-08ae-4a33-8524-f1503c8f6212", "You cannot create scheduled notes any more."),
  scheduledAtRequired: err("SCHEDULED_AT_REQUIRED", "fe9737d5-cc41-498c-af9d-149207307530", "scheduledAt is required when isActuallyScheduled is true."),
  scheduledAtInPast: err("SCHEDULED_AT_MUST_BE_IN_FUTURE", "ed1a6673-d0d1-4364-aaae-9bf3f139cbc5", "scheduledAt must be in the future."),
  noSuchRenote: err("NO_SUCH_RENOTE", "64929870-2540-4d11-af41-3b484d78c956", "No such renote."),
  pureRenote: err("CANNOT_RENOTE", "76cc5583-5a14-4ad3-8717-0298507e32db", "Cannot renote."),
  noSuchReply: err("NO_SUCH_REPLY", "c4721841-22fc-4bb7-ad3d-897ef1d375b5", "No such reply."),
  // upstream update maps the service's 215dbc76 to its `cannotReplyToSpecifiedNoteWithExtendedVisibility`
  replyToSpecified: err("CANNOT_REPLY_TO_SPECIFIED_NOTE_WITH_EXTENDED_VISIBILITY", "ed940410-535c-4d5e-bfa3-af798671e93c", "You cannot reply to a specified visibility note with extended visibility."),
};

const DELETE_ERR = {
  noSuchDraft: COMMON.noSuchDraft,
  accessDenied: err("ACCESS_DENIED", "56f35758-7dd5-468b-8439-5d6fb8ec9b8e", "Access denied."),
};

const noContent = () => new Response(null, { status: 204 });
const MAX_NOTE_TEXT_LENGTH = 3000;
const VISIBILITIES = ["public", "home", "followers", "specified"];
const ACCEPTANCES = [null, "likeOnly", "likeOnlyForRemote", "nonSensitiveOnly", "nonSensitiveOnlyForLocalLikeOnlyForRemote"];

const ACCOUNT_MOVED: ApiErrorBody = { message: "You have moved your account.", code: "YOUR_ACCOUNT_MOVED", id: "56f20ec9-fd06-4fa5-841b-edd6d7d4fa31", kind: "permission" };

/** requireCredential + `prohibitMoved` (every notes/drafts/* endpoint; checked before the params, as ApiCallService). */
async function auth(env: ApiEnv, body: Body, ctx: Ctx): Promise<string | Response> {
  const token = ctx.hasCredential ? extractToken(ctx.request, body) : null;
  const a = token ? await authenticatePg(env, token) : null;
  if (!a) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  const moved = await withHyperdriveClient(hd(env), async (c) =>
    (await c.query(`SELECT "movedToUri" FROM "user" WHERE id = $1`, [a.user.id])).rows[0]?.movedToUri);
  if (moved) return apiErrorResponse(ACCOUNT_MOVED, 403);
  return a.user.id;
}

// ---------------------------------------------------------------- params

/** Draft columns set from the request (only the keys present; `create` fills defaults). */
type DraftData = {
  text?: string | null; cw?: string | null; hashtag?: string | null; visibility?: string; visibleUserIds?: string[];
  localOnly?: boolean; reactionAcceptance?: string | null; replyId?: string | null; renoteId?: string | null; channelId?: string | null;
  fileIds?: string[]; hasPoll?: boolean; pollChoices?: string[]; pollMultiple?: boolean; pollExpiresAt?: Date | null; pollExpiredAfter?: number | null;
  scheduledAt?: Date | null; isActuallyScheduled?: boolean;
};

/** timestamptz column value → Date (`String(date)` would drop the milliseconds). */
const toDate = (v: unknown) => (v instanceof Date ? v : new Date(String(v)));
const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);
const nullableStr = (v: unknown, max: number, min = 0) => v === null || (typeof v === "string" && v.length >= min && v.length <= max);
const uniqueStrings = (v: unknown, max = Infinity) => Array.isArray(v) && v.length <= max && v.every((x) => typeof x === "string") && new Set(v).size === v.length;

/** paramDef of drafts/create and drafts/update (create: defaults applied; update: keys present only). */
function parseDraftParams(body: Body, mode: "create" | "update"): DraftData | null {
  const d: DraftData = {};
  const has = (k: string) => body[k] !== undefined;
  if (has("visibility")) {
    if (!VISIBILITIES.includes(body.visibility as string)) return null;
    d.visibility = body.visibility as string;
  }
  if (has("visibleUserIds")) {
    if (!uniqueStrings(body.visibleUserIds)) return null;
    d.visibleUserIds = body.visibleUserIds as string[];
  }
  if (has("cw")) {
    if (!nullableStr(body.cw, 100, 1)) return null;
    d.cw = body.cw as string | null;
  }
  if (has("hashtag")) {
    if (!nullableStr(body.hashtag, 200)) return null;
    d.hashtag = body.hashtag as string | null;
  }
  if (has("localOnly")) {
    if (typeof body.localOnly !== "boolean") return null;
    d.localOnly = body.localOnly;
  }
  if (has("reactionAcceptance")) {
    if (!ACCEPTANCES.includes(body.reactionAcceptance as string | null)) return null;
    d.reactionAcceptance = body.reactionAcceptance as string | null;
  }
  for (const k of ["replyId", "renoteId", "channelId"] as const) {
    if (!has(k)) continue;
    if (body[k] !== null && typeof body[k] !== "string") return null;
    d[k] = body[k] as string | null;
  }
  if (has("text")) {
    if (!nullableStr(body.text, MAX_NOTE_TEXT_LENGTH)) return null;
    d.text = body.text as string | null;
  }
  if (has("fileIds")) {
    if (!uniqueStrings(body.fileIds, 16)) return null;
    d.fileIds = body.fileIds as string[];
  }
  if (has("poll")) {
    const p = body.poll as Record<string, unknown> | null;
    if (p !== null) {
      if (typeof p !== "object" || Array.isArray(p)) return null;
      if (!uniqueStrings(p.choices, 10) || !(p.choices as string[]).every((c) => c.length >= 1 && c.length <= 50)) return null;
      if (p.multiple !== undefined && typeof p.multiple !== "boolean") return null;
      if (p.expiresAt != null && !isInt(p.expiresAt)) return null;
      if (p.expiredAfter != null && (!isInt(p.expiredAfter) || p.expiredAfter < 1)) return null;
    }
    d.pollExpiresAt = p?.expiresAt ? new Date(p.expiresAt as number) : null;
    if (mode === "create") {
      d.hasPoll = p != null;
      d.pollChoices = (p?.choices as string[] | undefined) ?? [];
      d.pollMultiple = (p?.multiple as boolean | undefined) ?? false;
      d.pollExpiredAfter = (p?.expiredAfter as number | null | undefined) ?? null;
    } else {
      // upstream update: `pollChoices: ps.poll?.choices`, `pollMultiple: ps.poll?.multiple`,
      // `pollExpiredAfter: ps.poll?.expiredAfter` (undefined keys are not written) and no `hasPoll`
      // at all, so `poll: null` keeps the stored poll and a new poll on a poll-less draft stays hidden
      if (p?.choices !== undefined) d.pollChoices = p.choices as string[];
      if (p?.multiple !== undefined) d.pollMultiple = p.multiple as boolean;
      if (p?.expiredAfter !== undefined) d.pollExpiredAfter = p.expiredAfter as number | null;
    }
  } else if (mode === "update") {
    // upstream update always writes pollExpiresAt (null when no poll is given)
    d.pollExpiresAt = null;
  }
  if (has("scheduledAt") && body.scheduledAt !== null && !isInt(body.scheduledAt)) return null;
  // upstream: `ps.scheduledAt ? new Date(...) : null` on both create and update
  d.scheduledAt = body.scheduledAt ? new Date(body.scheduledAt as number) : null;
  if (has("isActuallyScheduled")) {
    if (typeof body.isActuallyScheduled !== "boolean") return null;
    d.isActuallyScheduled = body.isActuallyScheduled;
  }
  if (mode === "create") {
    return {
      text: null, cw: null, hashtag: null, visibility: "public", visibleUserIds: [], localOnly: false, reactionAcceptance: null,
      replyId: null, renoteId: null, channelId: null, fileIds: [], hasPoll: false, pollChoices: [], pollMultiple: false,
      pollExpiresAt: null, pollExpiredAfter: null, isActuallyScheduled: false,
      ...d,
    };
  }
  return d;
}

// ---------------------------------------------------------------- validation (NoteDraftService.validate)

async function validate(env: ApiEnv, c: PgQueryable, me: string, d: DraftData): Promise<Fail | null> {
  if (d.isActuallyScheduled) {
    if (d.scheduledAt == null) return "scheduledAtRequired";
    if (d.scheduledAt.getTime() < Date.now()) return "scheduledAtInPast";
  }
  if (d.pollExpiresAt != null && d.pollExpiresAt.getTime() < Date.now()) return "expiredPoll";
  if (d.fileIds?.length) {
    const n = (await c.query(`SELECT count(*)::int AS n FROM drive_file WHERE "userId" = $1 AND id = ANY($2::varchar[])`, [me, d.fileIds])).rows[0]?.n;
    if (Number(n) !== d.fileIds.length) return "noSuchFile";
  }
  const blockedBy = async (userId: string) =>
    userId !== me && (await c.query(`SELECT 1 AS ok FROM blocking WHERE "blockerId" = $1 AND "blockeeId" = $2`, [userId, me])).rows.length > 0;
  if (d.renoteId != null) {
    const r = (await c.query(`SELECT * FROM note WHERE id = $1`, [d.renoteId])).rows[0];
    if (!r) return "noSuchRenote";
    const renote = rowToPackNote(r);
    if (isPureRenote(renote)) return "pureRenote";
    if (await blockedBy(renote.userId)) return "blocked";
    if ((renote.visibility === "followers" && renote.userId !== me) || renote.visibility === "specified") return "renoteVisibility";
    if (renote.channelId && renote.channelId !== d.channelId) {
      const ch = (await c.query(`SELECT "allowRenoteToExternal" FROM channel WHERE id = $1`, [renote.channelId])).rows[0];
      if (!ch) return "noSuchChannel";
      if (!ch.allowRenoteToExternal) return "renoteToExternal";
    }
  }
  if (d.replyId != null) {
    const r = (await c.query(`SELECT * FROM note WHERE id = $1`, [d.replyId])).rows[0];
    if (!r) return "noSuchReply";
    const reply = rowToPackNote(r);
    if (isPureRenote(reply)) return "replyToPureRenote";
    if (!(await canViewNote(env, reply, me, false))) return "replyToInvisible";
    if (reply.visibility === "specified" && d.visibility !== "specified") return "replyToSpecified";
    if (await blockedBy(reply.userId)) return "blocked";
  }
  if (d.channelId != null) {
    const ch = (await c.query(`SELECT 1 AS ok FROM channel WHERE id = $1 AND "isArchived" = false`, [d.channelId])).rows[0];
    if (!ch) return "noSuchChannel";
  }
  return null;
}

// ---------------------------------------------------------------- pack (NoteDraftEntityService)

export async function packDrafts(env: ApiEnv, c: PgQueryable, drafts: Row[], me: string): Promise<Record<string, unknown>[]> {
  if (!drafts.length) return [];
  const users = new Map(((await packUsers(env, [...new Set(drafts.map((d) => String(d.userId)))], me, false)) as { id: string }[]).map((u) => [u.id, u]));
  const fileIds = [...new Set(drafts.flatMap((d) => (d.fileIds as string[] | null) ?? []))];
  const files = fileIds.length
    ? new Map((await c.query(`SELECT * FROM drive_file WHERE id = ANY($1::varchar[])`, [fileIds])).rows.map((f) => [String(f.id), packDriveFile(f)]))
    : new Map();
  const channelIds = [...new Set(drafts.map((d) => d.channelId).filter((x): x is string => typeof x === "string"))];
  const channels = channelIds.length
    ? new Map((await c.query(`SELECT id, name, color, "isSensitive", "allowRenoteToExternal", "userId" FROM channel WHERE id = ANY($1::varchar[])`, [channelIds])).rows.map((ch) => [String(ch.id), ch]))
    : new Map<string, Row>();
  const noteIds = [...new Set(drafts.flatMap((d) => [d.replyId, d.renoteId]).filter((x): x is string => typeof x === "string"))];
  const notes = new Map<string, unknown>();
  if (noteIds.length) {
    const rows = await getNotesByIdsPg(env, noteIds);
    for (const n of await packNotesFromPg(env, rows, buildPackConfig(env), me)) notes.set(String((n as { id: string }).id), n);
  }
  // upstream packs the reply with `detail: false` (no clippedCount / reply / renote / poll / myReaction)
  const lite = (n: unknown) => {
    if (n == null) return null;
    const { clippedCount, reply, renote, poll, myReaction, ...rest } = n as Record<string, unknown>;
    void [clippedCount, reply, renote, poll, myReaction];
    return rest;
  };
  return drafts.map((d) => {
    const ch = d.channelId ? channels.get(String(d.channelId)) : undefined;
    const out: Record<string, unknown> = {
      id: d.id,
      createdAt: (parseAidxTime(String(d.id)) ?? new Date(0)).toISOString(),
      scheduledAt: d.scheduledAt ? toDate(d.scheduledAt).getTime() : null,
      isActuallyScheduled: Boolean(d.isActuallyScheduled),
      userId: d.userId,
      user: users.get(String(d.userId)) ?? null,
      text: d.text ?? null,
      cw: d.cw ?? null,
      visibility: d.visibility,
      localOnly: Boolean(d.localOnly),
      reactionAcceptance: d.reactionAcceptance ?? null,
      visibleUserIds: d.visibleUserIds ?? [],
      hashtag: d.hashtag ?? null,
      fileIds: d.fileIds ?? [],
      files: ((d.fileIds as string[] | null) ?? []).map((id) => files.get(id)).filter((f) => f != null),
      replyId: d.replyId ?? null,
      renoteId: d.renoteId ?? null,
      channelId: d.channelId ?? null,
      channel: ch ? { id: ch.id, name: ch.name, color: ch.color, isSensitive: ch.isSensitive, allowRenoteToExternal: ch.allowRenoteToExternal, userId: ch.userId } : undefined,
      poll: d.hasPoll
        ? {
            choices: d.pollChoices ?? [],
            multiple: Boolean(d.pollMultiple),
            expiresAt: d.pollExpiresAt ? toDate(d.pollExpiresAt).toISOString() : undefined,
            expiredAfter: d.pollExpiredAfter == null ? null : Number(d.pollExpiredAfter),
          }
        : null,
    };
    // detail: reply / renote (null when the target was deleted, absent when there is none)
    if (d.replyId) out.reply = lite(notes.get(String(d.replyId)));
    if (d.renoteId) out.renote = notes.get(String(d.renoteId)) ?? null;
    if (out.channel === undefined) delete out.channel;
    return out;
  });
}

// ---------------------------------------------------------------- scheduling

/** Arm (or re-arm) the draft's timer; `null` clears it. Best-effort. */
export async function scheduleDraft(env: ApiEnv, draftId: string, at: Date | null): Promise<void> {
  try {
    const ns = env.POLL_TIMER;
    if (ns) {
      const stub = ns.get(ns.idFromName(`draft:${draftId}`));
      await stub.fetch("https://poll.internal/" + (at ? "schedule" : "cancel"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(at ? { job: { kind: "postScheduledNote", draftId }, at: at.getTime() } : {}),
      });
    } else if (at && env.Q_JOBS) {
      // CF Queues delay is capped (12 h); later drafts are picked up by the cron sweep
      const delaySeconds = Math.min(43_200, Math.max(0, Math.ceil((at.getTime() - Date.now()) / 1000)));
      await enqueueJob(env, { kind: "postScheduledNote", draftId }, { delaySeconds });
    }
  } catch (e) {
    console.warn(`draft schedule failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export type PostScheduledNoteJob = { kind: "postScheduledNote"; draftId: string };

/** PostScheduledNoteProcessorService: post the draft as its author, then delete it. */
export async function runPostScheduledNote(env: ApiEnv, job: PostScheduledNoteJob): Promise<"posted" | "skipped" | "failed"> {
  const row = await withHyperdriveClient(hd(env), async (c) =>
    (await c.query(
      `SELECT d.*, u.token AS "_token" FROM note_draft d JOIN "user" u ON u.id = d."userId" WHERE d.id = $1`,
      [job.draftId],
    )).rows[0],
  );
  if (!row || row.scheduledAt == null || !row.isActuallyScheduled) return "skipped";
  // a timer from before scheduledAt was moved later: the newer timer posts it
  if (toDate(row.scheduledAt).getTime() > Date.now() + 60_000) return "skipped";
  const userId = String(row.userId);
  const body: Body = {
    text: row.text ?? null,
    cw: row.cw ?? null,
    visibility: row.visibility,
    visibleUserIds: row.visibleUserIds ?? [],
    localOnly: Boolean(row.localOnly),
    reactionAcceptance: row.reactionAcceptance ?? null,
    replyId: row.replyId ?? null,
    renoteId: row.renoteId ?? null,
    channelId: row.channelId ?? null,
    fileIds: row.fileIds ?? [],
  };
  if (row.hasPoll) {
    body.poll = {
      choices: row.pollChoices ?? [],
      multiple: Boolean(row.pollMultiple),
      ...(row.pollExpiredAfter != null ? { expiredAfter: Number(row.pollExpiredAfter) } : row.pollExpiresAt ? { expiresAt: toDate(row.pollExpiresAt).getTime() } : {}),
    };
  }
  let noteId: string | null = null;
  try {
    if (typeof row._token !== "string") throw new Error("no native token");
    const { notesCreate: handle } = await import("./notes-api-pg.js");
    const req = new Request("https://api.internal/api/notes/create", { method: "POST", headers: { authorization: `Bearer ${row._token}` } });
    const r = await handle(env, body, { hasCredential: true, request: req });
    if (r instanceof Response) throw new Error(`notes/create ${r.status}: ${await r.text()}`);
    noteId = String((r as { createdNote: { id: string } }).createdNote.id);
  } catch (e) {
    console.warn(`scheduled note ${job.draftId} failed: ${e instanceof Error ? e.message : String(e)}`);
    await createNotification(env, userId, { type: "scheduledNotePostFailed", notifierId: null, noteDraftId: job.draftId });
    return "failed";
  }
  await withHyperdriveClient(hd(env), (c) => c.query(`DELETE FROM note_draft WHERE id = $1`, [job.draftId]));
  await createNotification(env, userId, { type: "scheduledNotePosted", notifierId: null, noteId });
  return "posted";
}

/** Cron backstop: post scheduled drafts whose time has passed (lost timer / queue message). */
export async function postOverdueScheduledNotes(env: ApiEnv, limit = 50): Promise<number> {
  if (!env.HYPERDRIVE?.connectionString) return 0;
  const ids = await withHyperdriveClient(hd(env), async (c) =>
    (await c.query(
      `SELECT id FROM note_draft WHERE "isActuallyScheduled" = true AND "scheduledAt" < now() - interval '5 minutes' ORDER BY "scheduledAt" LIMIT $1`,
      [limit],
    )).rows.map((r) => String(r.id)),
  );
  let n = 0;
  for (const draftId of ids) {
    // a failed draft keeps isActuallyScheduled; clear it so the sweep does not retry forever
    if ((await runPostScheduledNote(env, { kind: "postScheduledNote", draftId })) === "failed") {
      await withHyperdriveClient(hd(env), (c) => c.query(`UPDATE note_draft SET "isActuallyScheduled" = false WHERE id = $1`, [draftId]));
    } else n++;
  }
  return n;
}

// ---------------------------------------------------------------- endpoints

/** Dates as ISO strings (some drivers drop the milliseconds of a Date parameter). */
const colValue = (d: DraftData, k: keyof DraftData) => {
  const v = d[k] ?? null;
  return v instanceof Date ? v.toISOString() : v;
};

const COLS: (keyof DraftData)[] = [
  "text", "cw", "hashtag", "visibility", "visibleUserIds", "localOnly", "reactionAcceptance", "replyId", "renoteId", "channelId",
  "fileIds", "hasPoll", "pollChoices", "pollMultiple", "pollExpiresAt", "pollExpiredAfter", "scheduledAt", "isActuallyScheduled",
];

const create: Handler = async (env, body, ctx) => {
  const me = await auth(env, body, ctx);
  if (me instanceof Response) return me;
  const d = parseDraftParams(body, "create");
  if (!d) return bad();
  const r = await withHyperdriveClient(hd(env), async (c) => {
    const policies = await getUserPoliciesPg(env, c, me);
    const count = async (extra = "") =>
      Number((await c.query(`SELECT count(*)::int AS n FROM note_draft WHERE "userId" = $1 ${extra}`, [me])).rows[0]?.n ?? 0);
    if ((await count()) >= Number(policies.noteDraftLimit)) return "tooManyDrafts" as Fail;
    if (d.isActuallyScheduled && (await count(`AND "isActuallyScheduled" = true`)) >= Number(policies.scheduledNoteLimit)) return "tooManyScheduled" as Fail;
    const fail = await validate(env, c, me, d);
    if (fail) return fail;
    const id = genAidx(Date.now());
    const cols = ["id", "userId", ...COLS];
    const vals = [id, me, ...COLS.map((k) => colValue(d, k))];
    await c.query(`INSERT INTO note_draft (${cols.map((k) => `"${k}"`).join(", ")}) VALUES (${vals.map((_, i) => `$${i + 1}`).join(", ")})`, vals);
    const row = (await c.query(`SELECT * FROM note_draft WHERE id = $1`, [id])).rows[0]!;
    return { row, packed: (await packDrafts(env, c, [row], me))[0] };
  });
  if (typeof r === "string") return apiErrorResponse(CREATE_ERR[r]!, 400);
  if (d.isActuallyScheduled && d.scheduledAt) await scheduleDraft(env, String(r.row.id), d.scheduledAt);
  return { createdDraft: r.packed };
};

const update: Handler = async (env, body, ctx) => {
  const me = await auth(env, body, ctx);
  if (me instanceof Response) return me;
  if (typeof body.draftId !== "string") return bad();
  const d = parseDraftParams(body, "update");
  if (!d) return bad();
  const r = await withHyperdriveClient(hd(env), async (c) => {
    const draft = (await c.query(`SELECT * FROM note_draft WHERE id = $1 AND "userId" = $2`, [body.draftId, me])).rows[0];
    if (!draft) return "noSuchDraft" as Fail;
    const policies = await getUserPoliciesPg(env, c, me);
    if (!draft.isActuallyScheduled && d.isActuallyScheduled) {
      const n = Number((await c.query(`SELECT count(*)::int AS n FROM note_draft WHERE "userId" = $1 AND "isActuallyScheduled" = true`, [me])).rows[0]?.n ?? 0);
      if (n >= Number(policies.scheduledNoteLimit)) return "tooManyScheduled" as Fail;
    }
    // upstream validates only the given fields (visibility check of a reply uses the new value)
    const fail = await validate(env, c, me, d);
    if (fail) return fail;
    const keys = COLS.filter((k) => d[k] !== undefined);
    const vals = keys.map((k) => colValue(d, k));
    if (keys.length) await c.query(`UPDATE note_draft SET ${keys.map((k, i) => `"${k}" = $${i + 2}`).join(", ")} WHERE id = $1`, [draft.id, ...vals]);
    const row = (await c.query(`SELECT * FROM note_draft WHERE id = $1`, [draft.id])).rows[0]!;
    return { row, packed: (await packDrafts(env, c, [row], me))[0] };
  });
  if (typeof r === "string") return apiErrorResponse(UPDATE_ERR[r]!, 400);
  const at = r.row.isActuallyScheduled && r.row.scheduledAt != null ? toDate(r.row.scheduledAt) : null;
  await scheduleDraft(env, String(r.row.id), at);
  return { updatedDraft: r.packed };
};

const del: Handler = async (env, body, ctx) => {
  const me = await auth(env, body, ctx);
  if (me instanceof Response) return me;
  if (typeof body.draftId !== "string") return bad();
  const r = await withHyperdriveClient(hd(env), async (c) => {
    const draft = (await c.query(`SELECT id, "userId" FROM note_draft WHERE id = $1 AND "userId" = $2`, [body.draftId, me])).rows[0];
    if (!draft) return DELETE_ERR.noSuchDraft;
    await c.query(`DELETE FROM note_draft WHERE id = $1`, [draft.id]);
    return null;
  });
  if (r) return apiErrorResponse(r, 400);
  await scheduleDraft(env, String(body.draftId), null);
  return noContent();
};

const list: Handler = async (env, body, ctx) => {
  const me = await auth(env, body, ctx);
  if (me instanceof Response) return me;
  const limit = body.limit === undefined ? 30 : body.limit;
  if (!isInt(limit) || limit < 1 || limit > 100) return bad();
  if (body.scheduled !== undefined && body.scheduled !== null && typeof body.scheduled !== "boolean") return bad();
  return withHyperdriveClient(hd(env), async (c) => {
    const params: unknown[] = [me];
    const p = pagination(body, params, "d.id");
    const where = [`d."userId" = $1`, ...p.where];
    if (body.scheduled === true) where.push(`d."isActuallyScheduled" = true`);
    else if (body.scheduled === false) where.push(`d."isActuallyScheduled" = false`);
    params.push(limit);
    const rows = (await c.query(`SELECT d.* FROM note_draft d WHERE ${where.join(" AND ")} ORDER BY d.id ${p.order} LIMIT $${params.length}`, params)).rows;
    return packDrafts(env, c, rows, me);
  });
};

const count: Handler = async (env, body, ctx) => {
  const me = await auth(env, body, ctx);
  if (me instanceof Response) return me;
  return withHyperdriveClient(hd(env), async (c) =>
    Number((await c.query(`SELECT count(*)::int AS n FROM note_draft WHERE "userId" = $1`, [me])).rows[0]?.n ?? 0),
  );
};

// ---------------------------------------------------------------- registry

function pgOnly(h: Handler): Handler {
  return async (env, body, ctx) => {
    if (!env.HYPERDRIVE?.connectionString) {
      return apiErrorResponse({ message: "Hyperdrive required.", code: "HYPERDRIVE_UNBOUND", id: "00000000-0000-4000-8000-0000000000b1", kind: "server" }, 501);
    }
    return h(env, body, ctx);
  };
}

const RAW: Record<string, Handler> = {
  "notes/drafts/create": create,
  "notes/drafts/update": update,
  "notes/drafts/delete": del,
  "notes/drafts/list": list,
  "notes/drafts/count": count,
};

export const draftHandlers: Record<string, Handler> = Object.fromEntries(Object.entries(RAW).map(([k, h]) => [k, pgOnly(h)]));

