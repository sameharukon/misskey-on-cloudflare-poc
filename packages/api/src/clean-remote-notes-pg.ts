/**
 * Remote notes cleaning (upstream queue/processors/CleanRemoteNotesProcessorService, cron
 * `0 4 * * *`; here the api worker's hourly cron in the 4 UTC hour), as `cleanRemoteNotes`
 * mk-jobs steps.
 *
 * Same rules as upstream: with `meta.enableRemoteNotesCleaning` on, delete remote note trees
 * (a root note that is neither a reply nor a renote, with its replies / renotes) older than
 * `remoteNotesCleaningExpiryDaysForEachNotes` days, unless a note in the tree is clipped, used in a
 * page, pinned, favorited or reacted to by a local user. A run stops after
 * `remoteNotesCleaningMaxProcessingDurationInMinutes` (counted from the cron start) or when the
 * setting is turned off; the batch size adapts to the query time.
 *
 * The walk position (upstream's Redis `cleanRemoteNotes:cursor`) is kept in META_CACHE under
 * the same key, saved after each batch, so the next day's run resumes there; it is dropped when
 * the walk reaches the end so the following run starts over. Without KV every run starts from
 * the beginning, as upstream after a Redis loss.
 *
 * Each step runs batches for up to STEP_BUDGET_MS, pausing min(5 s, query time) between them as
 * upstream, then returns its follow-up message.
 */

import { genAidx, parseAidxTime } from "../../id/src/index.js";
import type { ApiEnv } from "./env.js";
import { withHyperdriveClient, type PgQueryable } from "./pg.js";
import { hd } from "./handler-kit.js";
import { enqueueJob } from "./queues/jobs-queue.js";
import { metaRowPg } from "./user-lite-pg.js";

export type CleanRemoteNotesJob = {
  kind: "cleanRemoteNotes";
  /** run start (ms): the max duration counts from here */
  startAt: number;
  /** current batch size (adjusted from the query time, as upstream's currentLimit) */
  limit?: number;
  /** set by the first step: the oldest candidate root note, for the progress log */
  minId?: string;
  cursor?: string;
};

export const CURSOR_KEY = "cleanRemoteNotes:cursor";
const CURSOR_ORIGIN = "0";
const MINIMUM_LIMIT = 10;
const INITIAL_LIMIT = 100;
const MAXIMUM_LIMIT = 5000;
const STEP_BUDGET_MS = 60_000;
const DAY_MS = 1000 * 60 * 60 * 24;

type Config = { enabled: boolean; maxDuration: number; newestLimit: string };

async function readConfig(c: PgQueryable, now: number): Promise<Config> {
  const m = await metaRowPg(c);
  return {
    enabled: m.enableRemoteNotesCleaning === true,
    maxDuration: Number(m.remoteNotesCleaningMaxProcessingDurationInMinutes ?? 60) * 60 * 1000,
    // all notes newer than this are always kept
    newestLimit: genAidx(now - DAY_MS * Number(m.remoteNotesCleaningExpiryDaysForEachNotes ?? 90)),
  };
}

// The note must be old enough, remote, not clipped, not in a page, not pinned, not favorited
// and not reacted to by a local user.
const REMOVAL_CRITERIA = [
  `note."id" < $1`,
  `note."clippedCount" = 0`,
  `note."pageCount" = 0`,
  `note."userHost" IS NOT NULL`,
  `NOT EXISTS (SELECT 1 FROM user_note_pining WHERE "noteId" = note."id")`,
  `NOT EXISTS (SELECT 1 FROM note_favorite WHERE "noteId" = note."id")`,
  `NOT EXISTS (SELECT 1 FROM note_reaction INNER JOIN "user" ON note_reaction."userId" = "user".id WHERE note_reaction."noteId" = note."id" AND "user"."host" IS NULL)`,
].join(" AND ");

// Walk down the trees of up to $3 root notes after the cursor; a tree can be deleted when none
// of its rows is unremovable (the LEFT JOIN anti-joins trees with an unremovable row).
const CANDIDATES_SQL = `
WITH RECURSIVE candidate_notes AS (
  (SELECT base.* FROM (
    SELECT note."id" AS "id", note."replyId" AS "replyId", note."renoteId" AS "renoteId", note."id" AS "rootId",
      TRUE AS "isRemovable", TRUE AS "isBase"
    FROM note
    WHERE note."id" > $2 AND ${REMOVAL_CRITERIA} AND note."replyId" IS NULL AND note."renoteId" IS NULL
    ORDER BY note."id" ASC LIMIT $3
  ) AS base)
  UNION
  SELECT note."id", note."replyId", note."renoteId", parent."rootId", (${REMOVAL_CRITERIA}), FALSE
  FROM note INNER JOIN candidate_notes parent ON parent."id" = note."replyId" OR parent."id" = note."renoteId"
  WHERE parent."isRemovable" = TRUE
)
SELECT candidate_notes."id" AS id, unremovable."id" IS NULL AS "isRemovable", BOOL_OR(candidate_notes."isBase") AS "isBase"
FROM candidate_notes
LEFT JOIN candidate_notes unremovable ON unremovable."rootId" = candidate_notes."rootId" AND unremovable."isRemovable" = FALSE
GROUP BY candidate_notes."id", unremovable."id" IS NULL`;

const errCode = (e: unknown): string => String((e as { code?: unknown })?.code ?? "");

async function getCursor(env: ApiEnv): Promise<string | null> {
  try {
    return (await env.META_CACHE?.get(CURSOR_KEY)) ?? null;
  } catch {
    return null;
  }
}

async function setCursor(env: ApiEnv, cursor: string | null): Promise<void> {
  try {
    if (cursor == null || cursor === CURSOR_ORIGIN) await env.META_CACHE?.delete?.(CURSOR_KEY);
    else await env.META_CACHE?.put?.(CURSOR_KEY, cursor);
  } catch (e) {
    console.warn(`cleanRemoteNotes: cursor save failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

const timeOf = (id: string) => parseAidxTime(id)?.getTime() ?? 0;

function progressOf(minId: string, maxId: string, cursor: string): number {
  const min = timeOf(minId);
  const max = timeOf(maxId);
  const at = timeOf(cursor > minId ? cursor : minId);
  return max > min ? ((at - min) / (max - min)) * 100 : 100;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The cron's entry: start a run when the setting is on (queued on mk-jobs, inline without the queue). */
export async function startCleanRemoteNotes(env: ApiEnv, now = Date.now()): Promise<"started" | "disabled" | "unavailable"> {
  if (!env.HYPERDRIVE?.connectionString) return "unavailable";
  const enabled = await withHyperdriveClient(hd(env), async (c) => (await readConfig(c, now)).enabled);
  if (!enabled) {
    console.log("Remote notes cleaning is disabled, skipping...");
    return "disabled";
  }
  const job: CleanRemoteNotesJob = { kind: "cleanRemoteNotes", startAt: now };
  if (env.Q_JOBS) await enqueueJob(env, job);
  else {
    let next: CleanRemoteNotesJob | null = job;
    while (next) next = await runCleanRemoteNotesStep(env, next);
  }
  return "started";
}

/** One mk-jobs step (CleanRemoteNotesProcessorService.process, split into steps). */
export async function runCleanRemoteNotesStep(
  env: ApiEnv,
  job: CleanRemoteNotesJob,
  opts: { now?: () => number; pause?: (ms: number) => Promise<unknown> } = {},
): Promise<CleanRemoteNotesJob | null> {
  const now = opts.now ?? Date.now;
  const pause = opts.pause ?? sleep;
  return withHyperdriveClient(hd(env), async (c) => {
    let minId = job.minId;
    let cursor: string = job.cursor ?? CURSOR_ORIGIN;
    let limit = job.limit ?? INITIAL_LIMIT;

    if (minId == null) {
      // first step of a run
      const { enabled, newestLimit } = await readConfig(c, job.startAt);
      if (!enabled) {
        console.log("Remote notes cleaning is disabled, skipping...");
        return null;
      }
      console.log("cleaning remote notes...");
      minId = ((await c.query(
        `SELECT MIN(note.id) AS "minId" FROM note WHERE note.id < $1 AND note."userHost" IS NOT NULL AND note."replyId" IS NULL AND note."renoteId" IS NULL`,
        [newestLimit],
      )).rows[0]?.minId as string | null | undefined) ?? undefined;
      if (!minId) {
        console.log("No notes can possibly be deleted, skipping...");
        await setCursor(env, null);
        return null;
      }
      const stored = await getCursor(env);
      cursor = stored != null && stored < newestLimit ? stored : CURSOR_ORIGIN;
      if (cursor !== CURSOR_ORIGIN) console.log(`cleanRemoteNotes: resuming from the cursor left by a previous run: ${cursor}`);
    }
    const runMinId: string = minId;

    const stepBegin = now();
    let deleted = 0;
    for (;;) {
      const batchBeginAt = now();
      const { enabled, maxDuration, newestLimit } = await readConfig(c, batchBeginAt);
      if (!enabled) {
        console.log("Remote notes cleaning is disabled, processing stopped...");
        return null;
      }
      const elapsed = batchBeginAt - job.startAt;
      if (elapsed >= maxDuration) {
        console.log(`cleanRemoteNotes: reached maximum duration of ${maxDuration}ms, stopping... (last cursor: ${cursor}, final progress ${progressOf(runMinId, newestLimit, cursor)}%)`);
        return null;
      }
      if (batchBeginAt - stepBegin >= STEP_BUDGET_MS) {
        if (deleted) console.log(`cleanRemoteNotes: deleted ${deleted} notes in this step`);
        return { kind: "cleanRemoteNotes", startAt: job.startAt, minId: runMinId, cursor, limit };
      }

      const queryBegin = now();
      let rows: { id: string; isRemovable: boolean; isBase: boolean }[];
      try {
        rows = (await c.query(CANDIDATES_SQL, [newestLimit, cursor, limit])).rows as typeof rows;
      } catch (e) {
        if (errCode(e) !== "57014") throw e;
        // statement timeout (maybe a large note tree): reduce the limit and retry, or skip the
        // root notes at the cursor when already at the minimum
        if (limit > MINIMUM_LIMIT) {
          limit = Math.max(MINIMUM_LIMIT, Math.floor(limit * 0.25));
          continue;
        }
        console.log("cleanRemoteNotes: note tree complexity is too high, finding next root note...");
        // without the NOT EXISTS subqueries of the removal criteria, which would time out again;
        // the next batch re-evaluates them
        const skipWindow: string[] = (await c.query(
          `SELECT id FROM note WHERE note.id > $1 AND note."id" < $2 AND note."userHost" IS NOT NULL
             AND note."replyId" IS NULL AND note."renoteId" IS NULL ORDER BY note.id ASC LIMIT $3`,
          [cursor, newestLimit, MINIMUM_LIMIT + 1],
        )).rows.map((r) => String(r.id));
        console.log(`cleanRemoteNotes: skipped note IDs: ${skipWindow.slice(0, MINIMUM_LIMIT).join(", ")}`);
        const lastId = skipWindow[MINIMUM_LIMIT];
        if (!lastId) {
          console.log("cleanRemoteNotes: no more notes to clean. The next run will start from the beginning.");
          await setCursor(env, null);
          return null;
        }
        cursor = lastId;
        await setCursor(env, cursor);
        continue;
      }

      if (rows.length === 0) {
        console.log("cleanRemoteNotes: no more notes to clean. The next run will start from the beginning.");
        await setCursor(env, null);
        return null;
      }

      // aim at 1–5 s per query and at most 5000 rows
      const queryDuration = now() - queryBegin;
      if (queryDuration > 5000 || rows.length > 5000) limit = Math.floor(limit * 0.5);
      else if (queryDuration < 1000 && rows.length < 1000) limit = Math.floor(limit * 1.5);
      limit = Math.min(Math.max(limit, MINIMUM_LIMIT), MAXIMUM_LIMIT);

      const deletable = rows.filter((r) => r.isRemovable).map((r) => String(r.id));
      if (deletable.length) {
        try {
          deleted += (await c.query(`DELETE FROM note WHERE id = ANY($1::varchar[])`, [deletable])).rowCount ?? 0;
        } catch (e) {
          // integrity violation (class 23) from a change between the check and the delete: next batch
          if (!errCode(e).startsWith("23")) throw e;
          console.warn(`cleanRemoteNotes: error deleting notes: ${e instanceof Error ? e.message : String(e)} (transient race condition?)`);
        }
      }

      cursor = rows.filter((r) => r.isBase).reduce<string>((max, { id }) => (String(id) > max ? String(id) : max), cursor);
      await setCursor(env, cursor);

      await pause(Math.min(5000, queryDuration));
    }
  });
}
