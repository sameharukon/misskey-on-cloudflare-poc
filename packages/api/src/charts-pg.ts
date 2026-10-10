/**
 * Charts (W7.12): charts/notes|users|drive|federation|ap-request|active-users|instance and
 * charts/user/notes|following|drive|pv|reactions, in upstream's response shape (Chart.getChart:
 * nested fields of arrays, newest first, buckets aligned to UTC hours / days, `offset` cursor).
 *
 * Upstream reads `__chart__*` tables that its Node process fills from in-memory counters. Nothing
 * here writes those, so series are computed from the source tables instead: rows are bucketed by
 * the creation time in their aidx id (`width_bucket` over id prefixes), `inc` = rows created in
 * the bucket, `total` = rows created before the bucket's end. Consequences:
 * - deletions are not known: `dec` is 0 and totals count surviving rows only;
 * - ids must be aidx (the upstream default `id` setting);
 * - series that need events nobody records here are zero: federation, ap-request, user/pv,
 *   instance `requests.*`. active-users uses note authors (write; read and readWrite are the
 *   same lower bound).
 */

import { genAidxFromDate } from "../../id/src/index.js";
import type { ApiEnv } from "./env.js";
import { apiErrorResponse, INVALID_PARAM } from "./errors.js";
import { withHyperdriveClient, type PgQueryable } from "./pg.js";
import { readThroughJson } from "./cache-resolve.js";

type Body = Record<string, unknown>;
type Ctx = { hasCredential: boolean; request: Request };
type Handler = (env: ApiEnv, body: Body, ctx: Ctx) => Promise<Response | unknown>;
type Span = "day" | "hour";

const HOUR = 3600_000;
const DAY = 24 * HOUR;
const spanMs = (s: Span) => (s === "day" ? DAY : HOUR);
const prefix = (ms: number) => genAidxFromDate(new Date(ms)).slice(0, 8);

/** Bucket starts, oldest first (Chart.getChartRaw alignment), plus the end of the newest bucket. */
export function chartBuckets(span: Span, limit: number, offset: number | null, now = Date.now()): { starts: number[]; end: number } {
  const ms = spanMs(span);
  // with a cursor upstream takes the bucket of (cursor + span - 1ms); without, the current one
  const latest = Math.floor((offset != null ? offset + ms - 1 : now) / ms) * ms;
  const starts = Array.from({ length: limit }, (_, i) => latest - (limit - 1 - i) * ms);
  return { starts, end: latest + ms };
}

type Series = { base: Record<string, number>; perBucket: Record<string, number[]> };

/**
 * Sum `exprs` per bucket over `from` rows (`idCol` = the aidx id whose time decides the bucket).
 * `base` = sums over rows older than the first bucket (for accumulating totals); with
 * `incOnly` the chart has no totals, so rows older than the first bucket are not read.
 *
 * The id bounds compare in the column's own collation (aidx is fixed-length [0-9a-z], which every
 * collation orders the same way): `COLLATE "C"` there would keep the primary key from serving
 * the range. Inside width_bucket it does not matter for the index and keeps the bucketing exact.
 */
async function bucketSums(
  c: PgQueryable,
  q: { from: string; idCol: string; where?: string; params?: unknown[]; exprs: Record<string, string>; incOnly?: boolean },
  b: { starts: number[]; end: number },
): Promise<Series> {
  const params = [...(q.params ?? [])];
  params.push(b.starts.map(prefix));
  const th = `$${params.length}::text[]`;
  params.push(prefix(b.end));
  const endP = `$${params.length}`;
  let lower = "";
  if (q.incOnly) {
    params.push(prefix(b.starts[0]!));
    lower = ` AND ${q.idCol} >= $${params.length}`;
  }
  const names = Object.keys(q.exprs);
  const sql = `SELECT width_bucket(${q.idCol} COLLATE "C", ${th}) AS b, ${names.map((n, i) => `COALESCE(${q.exprs[n]}, 0)::float8 AS s${i}`).join(", ")}
    FROM ${q.from} WHERE ${q.where ? `(${q.where}) AND ` : ""}${q.idCol} < ${endP}${lower} GROUP BY 1`;
  const rows = (await c.query(sql, params)).rows;
  const base: Record<string, number> = Object.fromEntries(names.map((n) => [n, 0]));
  const perBucket: Record<string, number[]> = Object.fromEntries(names.map((n) => [n, b.starts.map(() => 0)]));
  for (const r of rows) {
    const i = Number(r.b);
    names.forEach((n, k) => {
      const v = Number(r[`s${k}`] ?? 0);
      if (i === 0) base[n] += v;
      else if (i >= 1 && i <= b.starts.length) perBucket[n]![i - 1] += v;
    });
  }
  return { base, perBucket };
}

/** Oldest-first per-bucket values → newest-first, optionally accumulated from `base`. */
function out(values: number[], accumulateFrom?: number): number[] {
  let v = values;
  if (accumulateFrom !== undefined) {
    let t = accumulateFrom;
    v = values.map((x) => (t += x));
  }
  return [...v].reverse();
}

const zeros = (n: number) => Array.from({ length: n }, () => 0);

/** Build `{ a: { b: [...] } }` from dotted keys. */
function nest(flat: Record<string, number[]>): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(flat)) {
    const parts = k.split(".");
    let cur = o;
    for (const p of parts.slice(0, -1)) cur = (cur[p] ??= {}) as Record<string, unknown>;
    cur[parts.at(-1)!] = v;
  }
  return o;
}

// ---------------------------------------------------------------- per-chart builders

const NOTE_DIFFS = {
  inc: "count(*)",
  normal: `count(*) FILTER (WHERE n."replyId" IS NULL AND n."renoteId" IS NULL)`,
  reply: `count(*) FILTER (WHERE n."replyId" IS NOT NULL)`,
  renote: `count(*) FILTER (WHERE n."renoteId" IS NOT NULL)`,
  withFile: `count(*) FILTER (WHERE cardinality(n."fileIds") > 0)`,
};

function noteFields(s: Series, p: string, n: number): Record<string, number[]> {
  return {
    [`${p}total`]: out(s.perBucket.inc!, s.base.inc),
    [`${p}inc`]: out(s.perBucket.inc!),
    [`${p}dec`]: zeros(n),
    [`${p}diffs.normal`]: out(s.perBucket.normal!),
    [`${p}diffs.reply`]: out(s.perBucket.reply!),
    [`${p}diffs.renote`]: out(s.perBucket.renote!),
    [`${p}diffs.withFile`]: out(s.perBucket.withFile!),
  };
}

type Builder = (c: PgQueryable, b: { starts: number[]; end: number }, body: Body) => Promise<Record<string, number[]>>;

const builders: Record<string, { group?: string; build: Builder }> = {
  notes: {
    build: async (c, b) => {
      const n = b.starts.length;
      const local = await bucketSums(c, { from: "note n", idCol: "n.id", where: `n."userHost" IS NULL`, exprs: NOTE_DIFFS }, b);
      const remote = await bucketSums(c, { from: "note n", idCol: "n.id", where: `n."userHost" IS NOT NULL`, exprs: NOTE_DIFFS }, b);
      return { ...noteFields(local, "local.", n), ...noteFields(remote, "remote.", n) };
    },
  },
  users: {
    build: async (c, b) => {
      const n = b.starts.length;
      const s = await bucketSums(c, {
        from: `"user" u`, idCol: "u.id",
        exprs: { local: `count(*) FILTER (WHERE u.host IS NULL)`, remote: `count(*) FILTER (WHERE u.host IS NOT NULL)` },
      }, b);
      return {
        "local.total": out(s.perBucket.local!, s.base.local), "local.inc": out(s.perBucket.local!), "local.dec": zeros(n),
        "remote.total": out(s.perBucket.remote!, s.base.remote), "remote.inc": out(s.perBucket.remote!), "remote.dec": zeros(n),
      };
    },
  },
  drive: {
    build: async (c, b) => {
      const n = b.starts.length;
      const s = await bucketSums(c, {
        from: "drive_file f", idCol: "f.id", incOnly: true,
        exprs: {
          lc: `count(*) FILTER (WHERE f."userHost" IS NULL)`, ls: `sum(f.size) FILTER (WHERE f."userHost" IS NULL) / 1000.0`,
          rc: `count(*) FILTER (WHERE f."userHost" IS NOT NULL)`, rs: `sum(f.size) FILTER (WHERE f."userHost" IS NOT NULL) / 1000.0`,
        },
      }, b);
      return {
        "local.incCount": out(s.perBucket.lc!), "local.incSize": out(s.perBucket.ls!), "local.decCount": zeros(n), "local.decSize": zeros(n),
        "remote.incCount": out(s.perBucket.rc!), "remote.incSize": out(s.perBucket.rs!), "remote.decCount": zeros(n), "remote.decSize": zeros(n),
      };
    },
  },
  federation: {
    build: async (_c, b) => {
      const n = b.starts.length;
      return Object.fromEntries(["deliveredInstances", "inboxInstances", "stalled", "sub", "pub", "pubsub", "subActive", "pubActive"].map((k) => [k, zeros(n)]));
    },
  },
  "ap-request": {
    build: async (_c, b) => Object.fromEntries(["deliverFailed", "deliverSucceeded", "inboxReceived"].map((k) => [k, zeros(b.starts.length)])),
  },
  "active-users": {
    build: async (c, b) => {
      const n = b.starts.length;
      const ms = b.starts.length > 1 ? b.starts[1]! - b.starts[0]! : DAY;
      // distinct local note authors per bucket, split by account age at the bucket start
      const thresholds = b.starts.map(prefix);
      const r = (await c.query(
        `SELECT width_bucket(n.id COLLATE "C", $1::text[]) AS b, n."userId", min(u.id) AS uid
         FROM note n JOIN "user" u ON u.id = n."userId"
         WHERE n."userHost" IS NULL AND n.id >= $2 AND n.id < $3 GROUP BY 1, 2`,
        [thresholds, thresholds[0], prefix(b.end)],
      )).rows;
      const keys = ["write", "registeredWithinWeek", "registeredWithinMonth", "registeredWithinYear", "registeredOutsideWeek", "registeredOutsideMonth", "registeredOutsideYear"];
      const per: Record<string, number[]> = Object.fromEntries(keys.map((k) => [k, zeros(n)]));
      const { parseAidxTime } = await import("../../id/src/index.js");
      for (const row of r) {
        const i = Number(row.b) - 1;
        if (i < 0 || i >= n) continue;
        per.write![i]++;
        const age = b.starts[i]! + ms - (parseAidxTime(String(row.uid))?.getTime() ?? 0);
        for (const [k, lim] of [["Week", 7 * DAY], ["Month", 30 * DAY], ["Year", 365 * DAY]] as const) {
          per[`registered${age < lim ? "Within" : "Outside"}${k}`]![i]++;
        }
      }
      return {
        readWrite: out(per.write!), read: out(per.write!), write: out(per.write!),
        ...Object.fromEntries(keys.slice(1).map((k) => [k, out(per[k]!)])),
      };
    },
  },
  instance: {
    group: "host",
    build: async (c, b, body) => {
      const n = b.starts.length;
      const host = String(body.host).toLowerCase();
      const notes = await bucketSums(c, { from: "note n", idCol: "n.id", where: `n."userHost" = $1`, params: [host], exprs: NOTE_DIFFS }, b);
      const users = await bucketSums(c, { from: `"user" u`, idCol: "u.id", where: `u.host = $1`, params: [host], exprs: { inc: "count(*)" } }, b);
      // following: remote users of this host following locals; followers: locals following them
      const fol = await bucketSums(c, {
        from: "following f", idCol: "f.id", where: `f."followerHost" = $1 OR f."followeeHost" = $1`, params: [host],
        exprs: {
          following: `count(*) FILTER (WHERE f."followerHost" = $1 AND f."followeeHost" IS NULL)`,
          followers: `count(*) FILTER (WHERE f."followeeHost" = $1 AND f."followerHost" IS NULL)`,
        },
      }, b);
      const drive = await bucketSums(c, { from: "drive_file f", idCol: "f.id", where: `f."userHost" = $1`, params: [host], exprs: { files: "count(*)", usage: "sum(f.size) / 1000.0" } }, b);
      return {
        "requests.failed": zeros(n), "requests.succeeded": zeros(n), "requests.received": zeros(n),
        ...noteFields(notes, "notes.", n),
        "users.total": out(users.perBucket.inc!, users.base.inc), "users.inc": out(users.perBucket.inc!), "users.dec": zeros(n),
        "following.total": out(fol.perBucket.following!, fol.base.following), "following.inc": out(fol.perBucket.following!), "following.dec": zeros(n),
        "followers.total": out(fol.perBucket.followers!, fol.base.followers), "followers.inc": out(fol.perBucket.followers!), "followers.dec": zeros(n),
        "drive.totalFiles": out(drive.perBucket.files!, drive.base.files), "drive.incFiles": out(drive.perBucket.files!), "drive.decFiles": zeros(n),
        "drive.incUsage": out(drive.perBucket.usage!), "drive.decUsage": zeros(n),
      };
    },
  },
  "user/notes": {
    group: "userId",
    build: async (c, b, body) => {
      const s = await bucketSums(c, { from: "note n", idCol: "n.id", where: `n."userId" = $1`, params: [body.userId], exprs: NOTE_DIFFS }, b);
      return noteFields(s, "", b.starts.length);
    },
  },
  "user/following": {
    group: "userId",
    build: async (c, b, body) => {
      const n = b.starts.length;
      const host = (await c.query(`SELECT host FROM "user" WHERE id = $1`, [body.userId])).rows[0]?.host ?? null;
      const s = await bucketSums(c, {
        from: "following f", idCol: "f.id", where: `f."followerId" = $1 OR f."followeeId" = $1`, params: [body.userId],
        exprs: { followings: `count(*) FILTER (WHERE f."followerId" = $1)`, followers: `count(*) FILTER (WHERE f."followeeId" = $1)` },
      }, b);
      // upstream prefixes each group by the charted user's own locality
      const p = host == null ? "local" : "remote";
      const q = host == null ? "remote" : "local";
      return {
        [`${p}.followings.total`]: out(s.perBucket.followings!, s.base.followings), [`${p}.followings.inc`]: out(s.perBucket.followings!), [`${p}.followings.dec`]: zeros(n),
        [`${p}.followers.total`]: out(s.perBucket.followers!, s.base.followers), [`${p}.followers.inc`]: out(s.perBucket.followers!), [`${p}.followers.dec`]: zeros(n),
        [`${q}.followings.total`]: zeros(n), [`${q}.followings.inc`]: zeros(n), [`${q}.followings.dec`]: zeros(n),
        [`${q}.followers.total`]: zeros(n), [`${q}.followers.inc`]: zeros(n), [`${q}.followers.dec`]: zeros(n),
      };
    },
  },
  "user/drive": {
    group: "userId",
    build: async (c, b, body) => {
      const n = b.starts.length;
      const s = await bucketSums(c, { from: "drive_file f", idCol: "f.id", where: `f."userId" = $1`, params: [body.userId], exprs: { count: "count(*)", size: "sum(f.size) / 1000.0" } }, b);
      return {
        totalCount: out(s.perBucket.count!, s.base.count), totalSize: out(s.perBucket.size!, s.base.size),
        incCount: out(s.perBucket.count!), incSize: out(s.perBucket.size!), decCount: zeros(n), decSize: zeros(n),
      };
    },
  },
  "user/pv": {
    group: "userId",
    build: async (_c, b) => Object.fromEntries(["upv.user", "pv.user", "upv.visitor", "pv.visitor"].map((k) => [k, zeros(b.starts.length)])),
  },
  "user/reactions": {
    group: "userId",
    build: async (c, b, body) => {
      // reactions received on the user's notes, split by the reacting user's locality
      const s = await bucketSums(c, {
        from: `note_reaction r JOIN note n ON n.id = r."noteId" JOIN "user" ru ON ru.id = r."userId"`, idCol: "r.id", where: `n."userId" = $1`, params: [body.userId], incOnly: true,
        exprs: { local: `count(*) FILTER (WHERE ru.host IS NULL)`, remote: `count(*) FILTER (WHERE ru.host IS NOT NULL)` },
      }, b);
      return { "local.count": out(s.perBucket.local!), "remote.count": out(s.perBucket.remote!) };
    },
  },
};

// ---------------------------------------------------------------- endpoints

function chartHandler(name: string): Handler {
  const def = builders[name]!;
  return async (env, body) => {
    if (!env.HYPERDRIVE?.connectionString) {
      return apiErrorResponse({ message: "Hyperdrive required.", code: "HYPERDRIVE_UNBOUND", id: "00000000-0000-4000-8000-0000000000b1", kind: "server" }, 501);
    }
    const span = body.span;
    const limit = body.limit === undefined ? 30 : body.limit;
    const offset = body.offset === undefined || body.offset === null ? null : body.offset;
    if ((span !== "day" && span !== "hour") || !Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > 500) return apiErrorResponse(INVALID_PARAM, 400);
    if (offset !== null && !Number.isInteger(offset)) return apiErrorResponse(INVALID_PARAM, 400);
    if (def.group && typeof body[def.group] !== "string") return apiErrorResponse(INVALID_PARAM, 400);
    const b = chartBuckets(span, limit as number, offset as number | null);
    const compute = () => withHyperdriveClient(env.HYPERDRIVE!, async (c) => nest(await def.build(c, b, body)));
    // per-user charts read the user's rows by index; the others aggregate whole tables (or a
    // host's rows), so their result is kept for CHART_CACHE_TTL_SEC. The key holds the newest
    // bucket's end rather than the raw offset, so a cached result never spans a bucket boundary.
    if (def.group === "userId") return compute();
    const group = def.group ? `:${String(body[def.group]).toLowerCase()}` : "";
    return readThroughJson(env, `chart:v1:${name}:${span}:${limit}${group}:${b.end}`, CHART_CACHE_TTL_SEC, compute);
  };
}

/** How long an instance-wide / per-host chart result is kept (upstream saves charts every 20 minutes). */
export const CHART_CACHE_TTL_SEC = 10 * 60;

export const CHART_NAMES = Object.keys(builders);

export const chartHandlers: Record<string, Handler> = Object.fromEntries(CHART_NAMES.map((n) => [`charts/${n}`, chartHandler(n)]));

