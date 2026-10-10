/**
 * Polls (W7.3) on PG (`poll`, `poll_vote`; upstream schema, no DDL).
 *
 * - notes/create `poll` param → validatePollParam + insertPollPg (same tx client)
 * - notes/polls/vote, notes/polls/recommendation (upstream shapes + error ids)
 * - note packer `poll` field (fetchPollsForPack)
 * - Poll end: upstream enqueues a delayed `endedPollNotification` job; here a
 *   per-note PollTimer Durable Object (on this worker) sets an alarm at
 *   expiresAt and sends `pollEnded` to the author + local voters.
 */

import { genAidx } from "../../id/src/index.js";
import type { PackNoteSource } from "../../packers/src/index.js";
import type { ApiEnv } from "./env.js";
import { publishNoteUpdated } from "./note-stream.js";
import { apiErrorResponse, CREDENTIAL_REQUIRED, INVALID_PARAM, type ApiErrorBody } from "./errors.js";
import { authenticatePg, extractToken } from "./auth-pg.js";
import { buildPackConfig } from "./meta-source.js";
import { withHyperdriveClient, type PgQueryable } from "./pg.js";
import { getNotePg, getNotesByIdsPg, packNotesFromPg } from "./notes-pg.js";
import { canViewNote } from "./visibility.js";
import { isBlocking } from "./graph-pg.js";
import { createNotification } from "./notifications-do.js";

type Ctx = { hasCredential: boolean; request: Request };
type Body = Record<string, unknown>;
export type PollHandler = (env: ApiEnv, body: Body, ctx: Ctx) => Promise<Response | unknown>;

export const CANNOT_CREATE_ALREADY_EXPIRED_POLL = err("CANNOT_CREATE_ALREADY_EXPIRED_POLL", "04da457d-b083-4055-9082-955525eda5a5", "Poll is already expired.");

const VOTE_ERR = {
  noSuchNote: err("NO_SUCH_NOTE", "ecafbd2e-c283-4d6d-aecb-1a0a33b75396", "No such note."),
  noPoll: err("NO_POLL", "5f979967-52d9-4314-a911-1c673727f92f", "The note does not attach a poll."),
  invalidChoice: err("INVALID_CHOICE", "e0cc9a04-f2e8-41e4-a5f1-4127293260cc", "Choice ID is invalid."),
  alreadyVoted: err("ALREADY_VOTED", "0963fc77-efac-419b-9424-b391608dc6d8", "You have already voted."),
  alreadyExpired: err("ALREADY_EXPIRED", "1022a357-b085-4054-9083-8f8de358337e", "The poll is already expired."),
  youHaveBeenBlocked: err("YOU_HAVE_BEEN_BLOCKED", "85a5377e-b1e9-4617-b0b9-5bea73331e49", "You cannot vote this poll because you have been blocked by this user."),
};

/**
 * notes/create `poll` (upstream paramDef: choices unique 2..10, each 1..50 chars;
 * multiple?; expiresAt? (ms epoch); expiredAfter? (ms, >= 1)).
 * Returns null when absent, an error body when invalid.
 */
export function validatePollParam(v: unknown, now = Date.now()): PollInput | ApiErrorBody | null {
  if (v == null) return null;
  if (typeof v !== "object" || Array.isArray(v)) return INVALID_PARAM;
  const p = v as Record<string, unknown>;
  const choices = p.choices;
  if (!Array.isArray(choices) || choices.length < 2 || choices.length > 10) return INVALID_PARAM;
  if (!choices.every((c) => typeof c === "string" && c.length >= 1 && c.length <= 50)) return INVALID_PARAM;
  if (new Set(choices).size !== choices.length) return INVALID_PARAM;
  if (p.multiple != null && typeof p.multiple !== "boolean") return INVALID_PARAM;
  const int = (x: unknown) => typeof x === "number" && Number.isInteger(x);
  if (p.expiresAt != null && !int(p.expiresAt)) return INVALID_PARAM;
  if (p.expiredAfter != null && (!int(p.expiredAfter) || (p.expiredAfter as number) < 1)) return INVALID_PARAM;
  const expiresAt = p.expiredAfter ? new Date(now + (p.expiredAfter as number)) : p.expiresAt ? new Date(p.expiresAt as number) : null;
  // NoteCreateService: 'Poll expiration must be future time'
  if (expiresAt && expiresAt.getTime() < now) return CANNOT_CREATE_ALREADY_EXPIRED_POLL;
  return { choices: choices as string[], multiple: (p.multiple as boolean | undefined) ?? false, expiresAt };
}

export function isPollError(v: PollInput | ApiErrorBody | null): v is ApiErrorBody {
  return v != null && "code" in v;
}

export { fetchPollsForPack, insertPollPg, type PackedPoll, type PollInput } from "./polls/pack.js";
import type { PollInput } from "./polls/pack.js";
import { clientError as err } from "./handler-kit.js";
import { enqueueJob } from "./queues/jobs-queue.js";

async function auth(env: ApiEnv, body: Body, ctx: Ctx): Promise<string | null> {
  if (!ctx.hasCredential) return null;
  const token = extractToken(ctx.request, body);
  if (!token) return null;
  const a = await authenticatePg(env, token);
  return a?.user.id ?? null;
}

const pollsVote: PollHandler = async (env, body, ctx) => {
  const me = await auth(env, body, ctx);
  if (!me) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  if (typeof body.noteId !== "string" || typeof body.choice !== "number" || !Number.isInteger(body.choice)) return apiErrorResponse(INVALID_PARAM, 400);
  const choice = body.choice;
  const note = await getNotePg(env, body.noteId);
  if (!note || !(await canViewNote(env, note, me, false))) return apiErrorResponse(VOTE_ERR.noSuchNote, 400);
  if (!note.hasPoll) return apiErrorResponse(VOTE_ERR.noPoll, 400);
  if (note.userId !== me && (await isBlocking(env, note.userId, me))) return apiErrorResponse(VOTE_ERR.youHaveBeenBlocked, 400);
  const res = await withHyperdriveClient(env.HYPERDRIVE!, async (c) => {
    const pr = await c.query(`SELECT "expiresAt", multiple, choices FROM poll WHERE "noteId" = $1`, [note.id]);
    const poll = pr.rows[0];
    if (!poll) throw new Error("EntityNotFoundError: poll"); // findOneByOrFail
    if (poll.expiresAt != null && new Date(poll.expiresAt as string | Date).getTime() < Date.now()) return VOTE_ERR.alreadyExpired;
    if ((poll.choices as string[])[choice] == null) return VOTE_ERR.invalidChoice;
    const ex = await c.query(`SELECT choice FROM poll_vote WHERE "noteId" = $1 AND "userId" = $2`, [note.id, me]);
    if (ex.rows.length) {
      if (!poll.multiple || ex.rows.some((x) => Number(x.choice) === choice)) return VOTE_ERR.alreadyVoted;
    }
    const voteId = genAidx(Date.now());
    const ins = await c.query(
      `INSERT INTO poll_vote (id, "userId", "noteId", choice) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING RETURNING id`,
      [voteId, me, note.id, choice],
    );
    if (!ins.rows.length) return VOTE_ERR.alreadyVoted;
    await c.query(`UPDATE poll SET votes[$1] = votes[$1] + 1 WHERE "noteId" = $2`, [choice + 1, note.id]);
    return { voteId, choiceName: String((poll.choices as string[])[choice]) };
  });
  if ("code" in res) return apiErrorResponse(res, 400);
  // upstream publishNoteStream(note, 'pollVoted')
  await publishNoteUpdated(env, note, "pollVoted", { choice, userId: me });
  const { deliverPollVote, deliverQuestionUpdate } = await import("./ap/outbound.js");
  // a vote on a remote poll is sent to its owner; the (local) poll's new counts go to remote followers
  if (note.userHost != null) await deliverPollVote(env, me, res.voteId, note, res.choiceName);
  await deliverQuestionUpdate(env, note);
  return new Response(null, { status: 204 });
};

const pollsRecommendation: PollHandler = async (env, body, ctx) => {
  const me = await auth(env, body, ctx);
  if (!me) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  const limit = Math.max(1, Math.min(100, typeof body.limit === "number" ? Math.floor(body.limit) : 10));
  const offset = Math.max(0, typeof body.offset === "number" ? Math.floor(body.offset) : 0);
  const ids = await withHyperdriveClient(env.HYPERDRIVE!, async (c) =>
    (
      await c.query(
        `SELECT p."noteId" FROM poll p
         WHERE p."userHost" IS NULL AND p."userId" != $1 AND p."noteVisibility" = 'public'
           AND (p."expiresAt" IS NULL OR p."expiresAt" > now())
           AND p."noteId" NOT IN (SELECT v."noteId" FROM poll_vote v WHERE v."userId" = $1)
           AND p."userId" NOT IN (SELECT m."muteeId" FROM muting m WHERE m."muterId" = $1)
           ${body.excludeChannels === true ? `AND p."channelId" IS NULL` : ""}
         ORDER BY p."noteId" DESC LIMIT $2 OFFSET $3`,
        [me, limit, offset],
      )
    ).rows.map((r) => String(r.noteId)),
  );
  if (!ids.length) return [];
  const notes = (await getNotesByIdsPg(env, ids)).sort((a, b) => (a.id < b.id ? 1 : -1));
  return packNotesFromPg(env, notes, buildPackConfig(env), me);
};

/** Upstream EndedPollNotificationProcessorService: author + local voters get `pollEnded`. */
export async function notifyPollEnded(env: ApiEnv, noteId: string): Promise<string[]> {
  const note = await getNotePg(env, noteId);
  if (!note || !note.hasPoll) return [];
  const voters = await withHyperdriveClient(env.HYPERDRIVE!, async (c) =>
    (
      await c.query(
        `SELECT DISTINCT v."userId" FROM poll_vote v JOIN "user" u ON u.id = v."userId" WHERE v."noteId" = $1 AND u.host IS NULL`,
        [noteId],
      )
    ).rows.map((r) => String(r.userId)),
  );
  const targets = [...new Set([...(note.userHost == null ? [note.userId] : []), ...voters])];
  for (const uid of targets) await createNotification(env, uid, { type: "pollEnded", notifierId: null, noteId });
  return targets;
}

/** Schedule the PollTimer alarm (best-effort; returns false when unbound). */
export async function schedulePollEnd(env: ApiEnv, noteId: string, expiresAt: Date): Promise<boolean> {
  const ns = env.POLL_TIMER;
  if (!ns) return false;
  const stub = ns.get(ns.idFromName(`poll:${noteId}`));
  const r = await stub.fetch("https://poll.internal/schedule", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ noteId, expiresAt: expiresAt.getTime() }),
  });
  return r.ok;
}

type PollTimerState = {
  storage: {
    get<T = unknown>(key: string): Promise<T | undefined>;
    put(key: string, value: unknown): Promise<void>;
    deleteAll(): Promise<void>;
    setAlarm(t: number): Promise<void>;
    getAlarm(): Promise<number | null>;
    deleteAlarm?(): Promise<void>;
  };
};

/**
 * One instance per poll note (`poll:<noteId>`); fires once at expiresAt.
 * Also used as a generic one-shot timer for an `mk-jobs` message (`{ job, at }`; `draft:<id>` for
 * scheduled notes): re-scheduling moves the alarm, `POST /cancel` clears it.
 */
export class PollTimer {
  constructor(private readonly state: PollTimerState, private readonly env: ApiEnv) {}

  async fetch(request: Request): Promise<Response> {
    if (request.method === "GET") {
      return Response.json({ noteId: (await this.state.storage.get<string>("noteId")) ?? null, job: (await this.state.storage.get("job")) ?? null, alarm: await this.state.storage.getAlarm() });
    }
    if (new URL(request.url).pathname === "/cancel") {
      await this.state.storage.deleteAll();
      await this.state.storage.deleteAlarm?.();
      return Response.json({ ok: true });
    }
    const b = (await request.json().catch(() => ({}))) as { noteId?: string; expiresAt?: number; job?: { kind?: string }; at?: number };
    if (b.job && typeof b.job.kind === "string" && typeof b.at === "number") {
      await this.state.storage.put("job", b.job);
      await this.state.storage.setAlarm(Math.max(Date.now(), b.at));
      return Response.json({ ok: true });
    }
    if (typeof b.noteId !== "string" || typeof b.expiresAt !== "number") return Response.json({ error: "bad_request" }, { status: 400 });
    await this.state.storage.put("noteId", b.noteId);
    await this.state.storage.setAlarm(Math.max(Date.now(), b.expiresAt));
    return Response.json({ ok: true });
  }

  async alarm(): Promise<void> {
    const noteId = await this.state.storage.get<string>("noteId");
    if (noteId) await notifyPollEnded(this.env, noteId);
    const job = await this.state.storage.get<{ kind: string }>("job");
    if (job) {
      if (this.env.Q_JOBS) await enqueueJob(this.env, job);
      else {
        const { runJobStep } = await import("./jobs.js");
        let next = await runJobStep(this.env, job as never);
        while (next) next = await runJobStep(this.env, next);
      }
    }
    await this.state.storage.deleteAll();
  }
}

function pgOnly(h: PollHandler): PollHandler {
  return async (env, body, ctx) => {
    if (!env.HYPERDRIVE?.connectionString) {
      return apiErrorResponse({ message: "Hyperdrive required.", code: "HYPERDRIVE_UNBOUND", id: "00000000-0000-4000-8000-0000000000b1", kind: "server" }, 501);
    }
    return h(env, body, ctx);
  };
}

export const pollHandlers: Record<string, PollHandler> = {
  "notes/polls/vote": pgOnly(pollsVote),
  "notes/polls/recommendation": pgOnly(pollsRecommendation),
};

