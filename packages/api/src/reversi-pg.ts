/**
 * Reversi on PG (`reversi_game`, upstream schema), following upstream ReversiService /
 * ReversiGameEntityService / endpoints/reversi/*: reversi/match|cancel-match|invitations|games|
 * show-game|surrender|verify, plus the realtime `reversiGame` channel operations (ready,
 * updateSettings, cancel, putStone, claimTimeIsUp) driven by the `Reversi` Durable Object.
 *
 * Where upstream uses Redis:
 * - Matchmaking (`reversi:matchSpecific:{userId}` / `reversi:matchAny` sorted sets) lives in the
 *   `Reversi` DO instance `match` (`applyMatchOp`, atomic per request). Without the binding an
 *   in-memory store of this isolate is used (offline / tests).
 * - The game cache (`reversi:game:cache:{id}`) is replaced by the row itself: ready flags,
 *   settings and every move are written to PG as they happen (upstream only bakes them at
 *   start / end), so show-game / verify always read PG.
 * - Turn timers (`reversi:game:turnTimer:{id}:{color}` with a TTL) become a deadline computed
 *   from the last move's time (or `startedAt`) + `timeLimitForEachTurn`.
 * - The 3-second "both ready → start" `setTimeout` is a DO alarm on `game:{id}`.
 * - `reversiStream:{userId}` → the user's StreamHub, channel `reversi`;
 *   `reversiGameStream:{gameId}` → every online user subscribed to `reversiGame:{gameId}`
 *   (presence `subscribers`, then each hub).
 */

import { genAidx, genAidxFromDate, parseAidxTime } from "../../id/src/index.js";
import type { ApiEnv } from "./env.js";
import { apiErrorResponse, CREDENTIAL_REQUIRED, INTERNAL_ERROR } from "./errors.js";
import { withHyperdriveClient, type PgQueryable } from "./pg.js";
import { packUsers, pagination } from "./client-endpoints-pg.js";
import { publishToUserStream } from "./stream-publish.js";
import { EIGHTEIGHT, Game, deserializeLogs, restoreGame, serializeLogs } from "./reversi/engine.js";
import { authUserId as auth, clientError as err, errorResponse as fail, hd, invalidParam as bad } from "./handler-kit.js";

type Ctx = { hasCredential: boolean; request: Request };
type Body = Record<string, unknown>;
type Handler = (env: ApiEnv, body: Body, ctx: Ctx) => Promise<Response | unknown>;
type Row = Record<string, unknown>;

const E = {
  matchNoSuchUser: err("NO_SUCH_USER", "0b4f0559-b484-4e31-9581-3f73cee89b28", "No such user."),
  matchYourself: err("TARGET_IS_YOURSELF", "96fd7bd6-d2bc-426c-a865-d055dcd2828e", "Target user is yourself."),
  showNoSuchGame: err("NO_SUCH_GAME", "f13a03db-fae1-46c9-87f3-43c8165419e1", "No such game."),
  surrenderNoSuchGame: err("NO_SUCH_GAME", "ace0b11f-e0a6-4076-a30d-e8284c81b2df", "No such game."),
  surrenderAlreadyEnded: err("ALREADY_ENDED", "6c2ad4a6-cbf1-4a5b-b187-b772826cfc6d", "That game has already ended."),
  surrenderAccessDenied: err("ACCESS_DENIED", "6e04164b-a992-4c93-8489-2123069973e1", "Access denied."),
};

const noContent = () => new Response(null, { status: 204 });

const INVITATION_TIMEOUT_MS = 20_000;
/** `expire reversi:matchSpecific:{id} 120 NX`: the whole key, from its first entry */
const INVITATION_KEEP_MS = 120_000;
/** `expire reversi:matchAny 15 NX`: the whole queue, from its first entry */
const MATCH_ANY_KEEP_MS = 15_000;
const START_DELAY_MS = 3000;

const isoOf = (v: unknown): string | null => (v == null ? null : new Date(v as string).toISOString());

// ---------------------------------------------------------------- matchmaking store

export type MatchState = {
  /** target → invitor → invited at (ms) */
  specific: Record<string, Record<string, number>>;
  /** `userId` or `userId:noIrregularRules` → queued at (ms) */
  any: Record<string, number>;
  /** Redis key TTLs (`expire … NX`): when `reversi:matchAny` / `reversi:matchSpecific:{target}` expire */
  ttl?: { any?: number; specific?: Record<string, number> };
};
export type MatchOp =
  | { op: "specific"; me: string; target: string }
  | { op: "any"; me: string; noIrregularRules: boolean }
  | { op: "cancelSpecific"; me: string; target: string }
  | { op: "cancelAny"; me: string }
  | { op: "invitations"; me: string };
export type MatchResult = { matchedWith?: string; noIrregularRules?: boolean; ids?: string[] };

export const emptyMatchState = (): MatchState => ({ specific: {}, any: {} });

/**
 * One Redis-equivalent step of ReversiService.match* (mutates `s`). Expiry follows Redis: a sorted
 * set's TTL is set by `expire NX` when the key is created (not extended by later entries) and the
 * whole key, with every entry, goes when it runs out; a key emptied by ZREM is deleted with its TTL.
 */
export function applyMatchOp(s: MatchState, op: MatchOp, now = Date.now()): MatchResult {
  const ttl = (s.ttl ??= {});
  const specTtl = (ttl.specific ??= {});
  if (ttl.any != null && now >= ttl.any) {
    s.any = {};
    delete ttl.any;
  }
  for (const t of Object.keys(s.specific)) {
    specTtl[t] ??= now + INVITATION_KEEP_MS; // state saved before TTLs were tracked
    if (now >= specTtl[t]!) {
      delete s.specific[t];
      delete specTtl[t];
    }
  }
  const dropEmptyKeys = () => {
    if (!Object.keys(s.any).length) delete ttl.any;
    for (const t of Object.keys(specTtl)) {
      if (!s.specific[t] || !Object.keys(s.specific[t]!).length) {
        delete s.specific[t];
        delete specTtl[t];
      }
    }
  };
  const r = matchStep(s, op, now);
  if (op.op === "specific" && !r.matchedWith) specTtl[op.target] ??= now + INVITATION_KEEP_MS;
  if (op.op === "any" && !r.matchedWith && Object.keys(s.any).length) ttl.any ??= now + MATCH_ANY_KEEP_MS;
  dropEmptyKeys();
  return r;
}

function matchStep(s: MatchState, op: MatchOp, now: number): MatchResult {
  const invitationsOf = (me: string) =>
    Object.entries(s.specific[me] ?? {})
      .filter(([, at]) => at >= now - INVITATION_TIMEOUT_MS)
      .sort((a, b) => a[1] - b[1])
      .map(([u]) => u);
  const takeInvitation = (me: string, from: string) => {
    delete s.specific[me]?.[from];
    if (s.specific[me] && !Object.keys(s.specific[me]!).length) delete s.specific[me];
  };
  switch (op.op) {
    case "invitations":
      return { ids: invitationsOf(op.me) };
    case "cancelSpecific":
      takeInvitation(op.target, op.me);
      return {};
    case "cancelAny":
      delete s.any[op.me];
      delete s.any[`${op.me}:noIrregularRules`];
      return {};
    case "specific": {
      if (invitationsOf(op.me).includes(op.target)) {
        takeInvitation(op.me, op.target);
        return { matchedWith: op.target, noIrregularRules: false };
      }
      (s.specific[op.target] ??= {})[op.me] = now;
      return {};
    }
    case "any": {
      const inv = invitationsOf(op.me);
      if (inv.length > 0) {
        const invitor = inv[Math.floor(Math.random() * inv.length)]!;
        takeInvitation(op.me, invitor);
        return { matchedWith: invitor, noIrregularRules: false };
      }
      // zrange 0 2 REV: newest three, skipping my own entries
      const items = Object.entries(s.any)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([k]) => k)
        .filter((k) => !k.startsWith(op.me));
      if (items.length > 0) {
        const [other, option] = items[0]!.split(":") as [string, string | undefined];
        for (const k of [op.me, other, `${op.me}:noIrregularRules`, `${other}:noIrregularRules`]) delete s.any[k];
        return { matchedWith: other, noIrregularRules: op.noIrregularRules || option === "noIrregularRules" };
      }
      s.any[op.noIrregularRules ? `${op.me}:noIrregularRules` : op.me] = now;
      return {};
    }
  }
}

const memoryMatch = emptyMatchState();

async function matchStore(env: ApiEnv, op: MatchOp): Promise<MatchResult> {
  const ns = env.REVERSI;
  if (!ns) return applyMatchOp(memoryMatch, op);
  const r = await ns.get(ns.idFromName("match")).fetch("https://reversi.internal/match", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(op),
  });
  if (!r.ok) throw new Error(`reversi match store: ${r.status}`);
  return (await r.json()) as MatchResult;
}

/**
 * A `reversiGame` channel frame from misskey-cf-stream (StreamHub → `ApiInternal.reversiFrame`),
 * handed to the `game:{gameId}` DO that serializes that game. Dropped without the binding.
 */
export async function forwardReversiFrame(env: ApiEnv, gameId: string, userId: string, type: string, body: unknown): Promise<void> {
  const ns = env.REVERSI;
  if (!ns) return;
  await ns.get(ns.idFromName(`game:${gameId}`)).fetch("https://reversi.internal/frame", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ gameId, userId, type, body }),
  });
}

// ---------------------------------------------------------------- publish

/** upstream publishReversiGameStream: everyone online subscribed to `reversiGame:{gameId}`. */
export async function publishReversiGame(env: ApiEnv, gameId: string, type: string, body: unknown): Promise<number> {
  const ns = env.STREAM_PRESENCE;
  if (!ns || !env.STREAM_HUB) return 0;
  const key = `reversiGame:${gameId}`;
  const n = Math.max(1, Number(env.STREAM_SHARD_COUNT) || 16);
  const lists = await Promise.all(
    Array.from({ length: n }, async (_, i) => {
      try {
        return Object.keys(await ns.get(ns.idFromName(`stream:${i}`)).subscribers([key]));
      } catch {
        return [];
      }
    }),
  );
  const users = [...new Set(lists.flat())];
  const delivered = await Promise.all(users.map((u) => publishToUserStream(env, u, key, type, body)));
  return delivered.reduce((a, b) => a + b, 0);
}

// ---------------------------------------------------------------- pack

const BW = new Set(["random", "1", "2"]);

async function packGames(env: ApiEnv, games: Row[], detail: boolean): Promise<Record<string, unknown>[]> {
  if (!games.length) return [];
  const ids = [...new Set(games.flatMap((g) => [String(g.user1Id), String(g.user2Id)]))];
  const users = new Map(((await packUsers(env, ids, null, false)) as { id: string }[]).map((u) => [u.id, u]));
  return games.map((g) => {
    const user1 = users.get(String(g.user1Id)) ?? null;
    const user2 = users.get(String(g.user2Id)) ?? null;
    const base: Record<string, unknown> = {
      id: g.id,
      createdAt: (parseAidxTime(String(g.id)) ?? new Date(0)).toISOString(),
      startedAt: isoOf(g.startedAt),
      endedAt: isoOf(g.endedAt),
      isStarted: Boolean(g.isStarted),
      isEnded: Boolean(g.isEnded),
    };
    if (detail) Object.assign(base, { form1: g.form1 ?? null, form2: g.form2 ?? null, user1Ready: Boolean(g.user1Ready), user2Ready: Boolean(g.user2Ready) });
    Object.assign(base, {
      user1Id: g.user1Id,
      user2Id: g.user2Id,
      user1,
      user2,
      winnerId: g.winnerId ?? null,
      winner: g.winnerId ? ([user1, user2].find((u) => u?.id === g.winnerId) ?? null) : null,
      surrenderedUserId: g.surrenderedUserId ?? null,
      timeoutUserId: g.timeoutUserId ?? null,
      black: g.black == null ? null : Number(g.black),
      bw: BW.has(String(g.bw)) ? g.bw : "random",
      isLlotheo: Boolean(g.isLlotheo),
      canPutEverywhere: Boolean(g.canPutEverywhere),
      loopedBoard: Boolean(g.loopedBoard),
      timeLimitForEachTurn: Number(g.timeLimitForEachTurn ?? 90),
      noIrregularRules: Boolean(g.noIrregularRules),
    });
    if (detail) Object.assign(base, { logs: g.logs ?? [], map: g.map ?? [] });
    return base;
  });
}

export const packGameDetail = async (env: ApiEnv, g: Row) => (await packGames(env, [g], true))[0]!;

async function getGame(c: PgQueryable, id: unknown): Promise<Row | null> {
  if (typeof id !== "string") return null;
  return (await c.query(`SELECT g.* FROM reversi_game g WHERE g.id = $1`, [id])).rows[0] ?? null;
}

const gameOf = (env: ApiEnv, id: string) => withHyperdriveClient(hd(env), (c) => getGame(c, id));

// ---------------------------------------------------------------- service (ReversiService)

async function matched(env: ApiEnv, parentId: string, childId: string, noIrregularRules: boolean): Promise<Row> {
  const game = await withHyperdriveClient(hd(env), async (c) =>
    (await c.query(
      `INSERT INTO reversi_game (id, "user1Id", "user2Id", "user1Ready", "user2Ready", "isStarted", "isEnded", logs, map, bw, "isLlotheo", "noIrregularRules")
       VALUES ($1, $2, $3, FALSE, FALSE, FALSE, FALSE, '[]'::jsonb, $4, 'random', FALSE, $5) RETURNING *`,
      [genAidx(Date.now()), parentId, childId, EIGHTEIGHT, noIrregularRules],
    )).rows[0]!,
  );
  await publishToUserStream(env, parentId, "reversi", "matched", { game: await packGameDetail(env, game) });
  return game;
}

/** Unstarted game of mine (with `other`, if given) created within 3 minutes, newest first. */
async function recentUnstarted(env: ApiEnv, me: string, other: string | null): Promise<Row | null> {
  const since = genAidxFromDate(new Date(Date.now() - 1000 * 60 * 3));
  return withHyperdriveClient(hd(env), async (c) => {
    const pair = other
      ? `((g."user1Id" = $1 AND g."user2Id" = $3) OR (g."user1Id" = $3 AND g."user2Id" = $1))`
      : `(g."user1Id" = $1 OR g."user2Id" = $1)`;
    const r = await c.query(
      `SELECT g.* FROM reversi_game g WHERE g.id > $2 AND g."isStarted" = FALSE AND ${pair} ORDER BY g.id DESC LIMIT 1`,
      other ? [me, since, other] : [me, since],
    );
    return r.rows[0] ?? null;
  });
}

export async function matchSpecificUser(env: ApiEnv, me: string, target: string, multiple = false): Promise<Row | null> {
  if (!multiple) {
    const g = await recentUnstarted(env, me, target);
    if (g) return g;
  }
  const r = await matchStore(env, { op: "specific", me, target });
  if (r.matchedWith) return matched(env, target, me, false);
  const user = ((await packUsers(env, [me], target, false)) as unknown[])[0];
  await publishToUserStream(env, target, "reversi", "invited", { user });
  return null;
}

export async function matchAnyUser(env: ApiEnv, me: string, noIrregularRules: boolean, multiple = false): Promise<Row | null> {
  if (!multiple) {
    const g = await recentUnstarted(env, me, null);
    if (g) return g;
  }
  const r = await matchStore(env, { op: "any", me, noIrregularRules });
  return r.matchedWith ? matched(env, r.matchedWith, me, Boolean(r.noIrregularRules)) : null;
}

async function setGame(env: ApiEnv, id: string, set: Record<string, unknown>): Promise<Row | null> {
  const cols = Object.keys(set);
  return withHyperdriveClient(hd(env), async (c) =>
    (await c.query(
      `UPDATE reversi_game SET ${cols.map((k, i) => `"${k}" = $${i + 2}`).join(", ")} WHERE id = $1 RETURNING *`,
      [id, ...cols.map((k) => (k === "logs" || k === "form1" || k === "form2" ? JSON.stringify(set[k]) : set[k]))],
    )).rows[0] ?? null,
  );
}

/** Returns true when both players are now ready (the caller schedules the start after 3s). */
export async function gameReady(env: ApiEnv, gameId: string, userId: string, ready: boolean): Promise<boolean> {
  const game = await gameOf(env, gameId);
  if (!game || game.isStarted) return false;
  const slot = game.user1Id === userId ? 1 : game.user2Id === userId ? 2 : 0;
  if (!slot) return false;
  await setGame(env, gameId, { [`user${slot}Ready`]: ready });
  const user1 = slot === 1 ? ready : Boolean(game.user1Ready);
  const user2 = slot === 2 ? ready : Boolean(game.user2Ready);
  await publishReversiGame(env, gameId, "changeReadyStates", { user1, user2 });
  return user1 && user2;
}

const winnerOf = (game: Row, engine: Game, black: number): string | null =>
  engine.winner === true ? String(black === 1 ? game.user1Id : game.user2Id) : engine.winner === false ? String(black === 1 ? game.user2Id : game.user1Id) : null;

const engineOf = (g: Row) =>
  restoreGame({
    map: (g.map as string[]) ?? [],
    isLlotheo: Boolean(g.isLlotheo),
    canPutEverywhere: Boolean(g.canPutEverywhere),
    loopedBoard: Boolean(g.loopedBoard),
    logs: (g.logs as number[][]) ?? [],
  });

/** The DO alarm 3s after both became ready (upstream gameReady's setTimeout). */
export async function startGameIfReady(env: ApiEnv, gameId: string): Promise<void> {
  const game = await gameOf(env, gameId);
  if (!game || game.isStarted || game.isEnded || !game.user1Ready || !game.user2Ready) return;
  const bw = game.bw === "random" ? (Math.random() > 0.5 ? 1 : 2) : parseInt(String(game.bw), 10);
  let engine: Game;
  try {
    engine = new Game((game.map as string[]) ?? [], { isLlotheo: Boolean(game.isLlotheo), canPutEverywhere: Boolean(game.canPutEverywhere), loopedBoard: Boolean(game.loopedBoard) });
  } catch {
    return; // empty / malformed map
  }
  const updated = await setGame(env, gameId, { startedAt: new Date(), isStarted: true, black: bw, crc32: engine.calcCrc32().toString() });
  if (!updated) return;
  // a map may be decided the moment it starts
  if (engine.isEnded) {
    await endGame(env, updated, winnerOf(updated, engine, bw), null);
    return;
  }
  await publishReversiGame(env, gameId, "started", { game: await packGameDetail(env, updated) });
}

async function endGame(env: ApiEnv, game: Row, winnerId: string | null, reason: "surrender" | "timeout" | null): Promise<void> {
  const loser = winnerId === game.user1Id ? game.user2Id : game.user1Id;
  const updated = await setGame(env, String(game.id), {
    isEnded: true,
    endedAt: new Date(),
    winnerId,
    surrenderedUserId: reason === "surrender" ? loser : null,
    timeoutUserId: reason === "timeout" ? loser : null,
  });
  if (!updated) return;
  await publishReversiGame(env, String(game.id), "ended", { winnerId, game: await packGameDetail(env, updated) });
}

export const REVERSI_UPDATE_KEYS = ["map", "bw", "isLlotheo", "canPutEverywhere", "loopedBoard", "timeLimitForEachTurn"] as const;
type UpdateKey = (typeof REVERSI_UPDATE_KEYS)[number];

/** upstream isValidReversiUpdateKey / isValidReversiUpdateValue. */
export function isValidUpdate(key: unknown, value: unknown): key is UpdateKey {
  switch (key) {
    case "map":
      return Array.isArray(value) && value.every((row) => typeof row === "string");
    case "bw":
      return typeof value === "string" && BW.has(value);
    case "isLlotheo":
    case "canPutEverywhere":
    case "loopedBoard":
      return typeof value === "boolean";
    case "timeLimitForEachTurn":
      return typeof value === "number" && value >= 0;
    default:
      return false;
  }
}

/**
 * Whether the value can be stored in its `reversi_game` column (`map` varchar(64)[],
 * `timeLimitForEachTurn` smallint). Upstream keeps settings in the Redis game cache and bakes them
 * into the row at start, where such a value makes the UPDATE fail and the game never starts.
 */
export function fitsColumn(key: UpdateKey, value: unknown): boolean {
  if (key === "map") return (value as string[]).every((row) => row.length <= 64);
  if (key === "timeLimitForEachTurn") return Number.isInteger(value) && (value as number) <= 32767;
  return true;
}

/**
 * upstream updateSettings. Returns the key's "unbakeable" state when it changed (the Reversi DO
 * keeps it: while any key is unbakeable the game does not start, as upstream's failing bake).
 */
export async function updateSettings(env: ApiEnv, gameId: string, userId: string, key: UpdateKey, value: unknown): Promise<{ key: UpdateKey; unfit: boolean } | null> {
  const game = await gameOf(env, gameId);
  if (!game || game.isStarted) return null;
  if (game.user1Id !== userId && game.user2Id !== userId) return null;
  if (game.user1Id === userId && game.user1Ready) return null;
  if (game.user2Id === userId && game.user2Ready) return null;
  const unfit = !fitsColumn(key, value);
  // the row stands in for the game cache; a value it cannot hold is only broadcast (as upstream's cache-only update)
  if (!unfit) await setGame(env, gameId, { [key]: value });
  await publishReversiGame(env, gameId, "updateSettings", { userId, key, value });
  return { key, unfit };
}

export async function putStone(env: ApiEnv, gameId: string, userId: string, pos: number, id: string | null): Promise<void> {
  const game = await gameOf(env, gameId);
  if (!game || !game.isStarted || game.isEnded) return;
  if (game.user1Id !== userId && game.user2Id !== userId) return;
  const black = Number(game.black);
  const myColor = (game.user1Id === userId && black === 1) || (game.user2Id === userId && black === 2);
  const engine = engineOf(game);
  if (engine.turn !== myColor) return;
  if (!engine.canPut(myColor, pos)) return;
  engine.putStone(pos);
  const log = { time: Date.now(), player: myColor, operation: "put", pos } as const;
  const logs = serializeLogs([...deserializeLogs((game.logs as number[][]) ?? []), log]);
  const updated = await setGame(env, gameId, { logs, crc32: engine.calcCrc32().toString() });
  if (!updated) return;
  await publishReversiGame(env, gameId, "log", { ...log, id: id ?? null });
  if (engine.isEnded) await endGame(env, updated, winnerOf(updated, engine, black), null);
}

export async function surrender(env: ApiEnv, gameId: string, userId: string): Promise<void> {
  const game = await gameOf(env, gameId);
  if (!game || game.isEnded) return;
  if (game.user1Id !== userId && game.user2Id !== userId) return;
  await endGame(env, game, String(game.user1Id === userId ? game.user2Id : game.user1Id), "surrender");
}

/**
 * upstream checkTimeout: the player to move loses once their turn timer (Redis key with a TTL,
 * set at start and after each move) is gone. Before the start there is no timer at all, so, as
 * upstream, a claim on an unstarted game ends it (`black` is still null: user1 wins).
 */
export async function checkTimeout(env: ApiEnv, gameId: string, now = Date.now()): Promise<void> {
  const game = await gameOf(env, gameId);
  if (!game || game.isEnded) return;
  let engine: Game;
  try {
    engine = engineOf(game);
  } catch {
    return; // upstream's restore throws on a malformed map (the claim is dropped)
  }
  if (engine.turn == null) return;
  if (game.isStarted) {
    const logs = deserializeLogs((game.logs as number[][]) ?? []);
    const turnStarted = logs.length ? logs[logs.length - 1]!.time : new Date(game.startedAt as string).getTime();
    if (now < turnStarted + Number(game.timeLimitForEachTurn ?? 90) * 1000) return;
  }
  const black = Number(game.black);
  const winnerId = engine.turn ? (black === 1 ? game.user2Id : game.user1Id) : black === 1 ? game.user1Id : game.user2Id;
  await endGame(env, game, String(winnerId), "timeout");
}

export async function cancelGame(env: ApiEnv, gameId: string, userId: string): Promise<void> {
  const game = await gameOf(env, gameId);
  if (!game || game.isStarted) return;
  if (game.user1Id !== userId && game.user2Id !== userId) return;
  await withHyperdriveClient(hd(env), (c) => c.query(`DELETE FROM reversi_game WHERE id = $1`, [gameId]));
  await publishReversiGame(env, gameId, "canceled", { userId });
}

/**
 * A `reversiGame` channel frame (upstream ReversiGameChannel.onMessage). Returns `{ startAt }`
 * when both players became ready, so the DO can set its alarm.
 */
export async function handleGameFrame(env: ApiEnv, gameId: string, userId: string, type: string, body: unknown): Promise<{ startAt?: number; setting?: { key: UpdateKey; unfit: boolean } }> {
  const obj = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  switch (type) {
    case "ready":
      if (typeof body !== "boolean") return {};
      return (await gameReady(env, gameId, userId, body)) ? { startAt: Date.now() + START_DELAY_MS } : {};
    case "updateSettings": {
      if (!obj || !isValidUpdate(obj.key, obj.value)) return {};
      const setting = await updateSettings(env, gameId, userId, obj.key, obj.value);
      return setting ? { setting } : {};
    }
    case "cancel":
      await cancelGame(env, gameId, userId);
      return {};
    case "putStone":
      if (!obj || typeof obj.pos !== "number" || typeof obj.id !== "string") return {};
      await putStone(env, gameId, userId, obj.pos, obj.id);
      return {};
    case "claimTimeIsUp":
      await checkTimeout(env, gameId);
      return {};
    default:
      return {};
  }
}

// ---------------------------------------------------------------- Durable Object

type ReversiDoState = {
  storage: {
    get<T = unknown>(key: string): Promise<T | undefined>;
    put(key: string, value: unknown): Promise<void>;
    setAlarm(t: number): Promise<void>;
  };
};

/**
 * `Reversi` Durable Object (this worker). Instance `match`: the matchmaking store
 * (POST /match MatchOp → MatchResult). Instance `game:{id}`: serializes that game's operations
 * (POST /frame {gameId, userId, type, body} from StreamHub, POST /surrender {gameId, userId}),
 * and starts the game from its alarm.
 */
export class Reversi {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly state: ReversiDoState,
    private readonly env: ApiEnv,
  ) {}

  /** Run game operations one at a time (PG I/O would otherwise interleave requests). */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn, fn);
    this.tail = run.catch(() => undefined);
    return run;
  }

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    const b = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    if (path === "/match") {
      const s = (await this.state.storage.get<MatchState>("match")) ?? emptyMatchState();
      const r = applyMatchOp(s, b as unknown as MatchOp);
      await this.state.storage.put("match", s);
      return Response.json(r);
    }
    if (typeof b.gameId !== "string" || typeof b.userId !== "string") return Response.json({ error: "bad_request" }, { status: 400 });
    const gameId = b.gameId;
    const userId = b.userId;
    if (path === "/frame") {
      if (typeof b.type !== "string") return Response.json({ error: "bad_request" }, { status: 400 });
      const r = await this.serial(() => handleGameFrame(this.env, gameId, userId, b.type as string, b.body));
      if (r.setting) {
        const unfit = new Set((await this.state.storage.get<string[]>("unfit")) ?? []);
        if (r.setting.unfit) unfit.add(r.setting.key);
        else unfit.delete(r.setting.key);
        await this.state.storage.put("unfit", [...unfit]);
      }
      if (r.startAt) {
        await this.state.storage.put("gameId", gameId);
        await this.state.storage.setAlarm(r.startAt);
      }
      return Response.json({ ok: true });
    }
    if (path === "/surrender") {
      await this.serial(() => surrender(this.env, gameId, userId));
      return Response.json({ ok: true });
    }
    return Response.json({ error: "unknown" }, { status: 404 });
  }

  async alarm(): Promise<void> {
    const gameId = await this.state.storage.get<string>("gameId");
    // upstream's start bakes the cached settings into the row; a value the row cannot hold fails it
    if (((await this.state.storage.get<string[]>("unfit")) ?? []).length) return;
    if (gameId) await this.serial(() => startGameIfReady(this.env, gameId));
  }
}

// ---------------------------------------------------------------- endpoints

const optBool = (v: unknown) => v === undefined || typeof v === "boolean";

const match: Handler = async (env, body, ctx) => {
  const me = await auth(env, body, ctx);
  if (!me) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  if ((body.userId != null && typeof body.userId !== "string") || !optBool(body.noIrregularRules) || !optBool(body.multiple)) return bad();
  const target = (body.userId as string | null | undefined) || null;
  if (body.userId === me) return fail(E.matchYourself);
  if (target) {
    const exists = await withHyperdriveClient(hd(env), async (c) => (await c.query(`SELECT id FROM "user" WHERE id = $1`, [target])).rows.length > 0);
    if (!exists) return fail(E.matchNoSuchUser);
  }
  const game = target
    ? await matchSpecificUser(env, me, target, body.multiple === true)
    : await matchAnyUser(env, me, body.noIrregularRules === true, body.multiple === true);
  return game ? packGameDetail(env, game) : noContent();
};

const cancelMatch: Handler = async (env, body, ctx) => {
  const me = await auth(env, body, ctx);
  if (!me) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  if (body.userId != null && typeof body.userId !== "string") return bad();
  if (body.userId) await matchStore(env, { op: "cancelSpecific", me, target: body.userId as string });
  else await matchStore(env, { op: "cancelAny", me });
  return noContent();
};

const invitations: Handler = async (env, body, ctx) => {
  const me = await auth(env, body, ctx);
  if (!me) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  const { ids = [] } = await matchStore(env, { op: "invitations", me });
  return packUsers(env, ids, me, false);
};

const games: Handler = async (env, body, ctx) => {
  let me: string | null = null;
  if (ctx.hasCredential) {
    me = await auth(env, body, ctx);
    if (!me) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  }
  const limit = body.limit === undefined ? 10 : body.limit;
  if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > 100 || !optBool(body.my)) return bad();
  for (const k of ["sinceId", "untilId"]) if (body[k] !== undefined && typeof body[k] !== "string") return bad();
  for (const k of ["sinceDate", "untilDate"]) if (body[k] !== undefined && !Number.isInteger(body[k])) return bad();
  const rows = await withHyperdriveClient(hd(env), async (c) => {
    const params: unknown[] = [];
    const p = pagination(body, params, "g.id");
    const where = [...p.where];
    if (body.my === true && me) where.push(`(g."user1Id" = $${params.push(me)} OR g."user2Id" = $${params.length})`);
    else where.push(`g."isStarted" = TRUE`);
    params.push(limit);
    return (await c.query(
      `SELECT g.* FROM reversi_game g JOIN "user" u1 ON u1.id = g."user1Id" JOIN "user" u2 ON u2.id = g."user2Id"
       WHERE ${where.join(" AND ")} ORDER BY g.id ${p.order} LIMIT $${params.length}`,
      params,
    )).rows;
  });
  return packGames(env, rows, false);
};

const showGame: Handler = async (env, body) => {
  if (typeof body.gameId !== "string") return bad();
  const game = await gameOf(env, body.gameId);
  return game ? packGameDetail(env, game) : fail(E.showNoSuchGame);
};

const surrenderEndpoint: Handler = async (env, body, ctx) => {
  const me = await auth(env, body, ctx);
  if (!me) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  if (typeof body.gameId !== "string") return bad();
  const game = await gameOf(env, body.gameId);
  if (!game) return fail(E.surrenderNoSuchGame);
  if (game.isEnded) return fail(E.surrenderAlreadyEnded);
  if (game.user1Id !== me && game.user2Id !== me) return fail(E.surrenderAccessDenied);
  const ns = env.REVERSI;
  if (ns) {
    await ns.get(ns.idFromName(`game:${game.id}`)).fetch("https://reversi.internal/surrender", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ gameId: game.id, userId: me }),
    });
  } else {
    await surrender(env, String(game.id), me);
  }
  return noContent();
};

const verify: Handler = async (env, body) => {
  if (typeof body.gameId !== "string" || typeof body.crc32 !== "string") return bad();
  const game = await gameOf(env, body.gameId);
  // as upstream: checkCrc throws a plain Error for a missing game (the declared NO_SUCH_GAME is never used)
  if (!game) return apiErrorResponse(INTERNAL_ERROR, 500);
  if (body.crc32 !== game.crc32) return { desynced: true, game: await packGameDetail(env, game) };
  return { desynced: false };
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
  "reversi/cancel-match": cancelMatch,
  "reversi/games": games,
  "reversi/invitations": invitations,
  "reversi/match": match,
  "reversi/show-game": showGame,
  "reversi/surrender": surrenderEndpoint,
  "reversi/verify": verify,
};

export const reversiHandlers: Record<string, Handler> = Object.fromEntries(Object.entries(RAW).map(([k, h]) => [k, pgOnly(h)]));

