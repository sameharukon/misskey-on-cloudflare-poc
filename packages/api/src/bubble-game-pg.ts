/**
 * Bubble game (upstream endpoints/bubble-game/*) on PG `bubble_game_record`:
 * bubble-game/register and bubble-game/ranking (top 10 of the last 7 days per gameMode).
 * register's rate limit (1h / 120, min interval 30s) is the generic limiter (router.ts
 * callGate, endpoint-meta.gen.ts); ranking's 60s response cache (upstream cacheSec) is the
 * router's anonymous-GET cache (response-cache.ts).
 */

import { genAidx } from "../../id/src/index.js";
import type { ApiEnv } from "./env.js";
import { apiErrorResponse, CREDENTIAL_REQUIRED, INTERNAL_ERROR, type ApiErrorBody } from "./errors.js";
import { withHyperdriveClient } from "./pg.js";
import { packUsers } from "./client-endpoints-pg.js";
import { authUserId as auth, hd, invalidParam as bad } from "./handler-kit.js";

type Ctx = { hasCredential: boolean; request: Request };
type Body = Record<string, unknown>;
type Handler = (env: ApiEnv, body: Body, ctx: Ctx) => Promise<Response | unknown>;

const INVALID_SEED: ApiErrorBody = { message: "Provided seed is invalid.", code: "INVALID_SEED", id: "eb627bc7-574b-4a52-a860-3c3eae772b88", kind: "client" };

const ranking: Handler = async (env, body) => {
  if (typeof body.gameMode !== "string") return bad();
  const rows = await withHyperdriveClient(hd(env), async (c) =>
    (await c.query(
      `SELECT r.id, r."userId", r.score FROM bubble_game_record r JOIN "user" u ON u.id = r."userId"
       WHERE r."gameMode" = $1 AND r."seededAt" > $2 ORDER BY r.score DESC LIMIT 10`,
      [body.gameMode, new Date(Date.now() - 1000 * 60 * 60 * 24 * 7)],
    )).rows,
  );
  const users = new Map(((await packUsers(env, [...new Set(rows.map((r) => String(r.userId)))], null, false)) as { id: string }[]).map((u) => [u.id, u]));
  return rows.map((r) => ({ id: r.id, score: Number(r.score), user: users.get(String(r.userId)) }));
};

const register: Handler = async (env, body, ctx) => {
  const me = await auth(env, body, ctx);
  if (!me) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  const { score, seed, logs, gameMode, gameVersion } = body;
  if (!Number.isInteger(score) || (score as number) < 0) return bad();
  if (typeof seed !== "string" || seed.length < 1 || seed.length > 1024) return bad();
  if (!Array.isArray(logs) || !logs.every((l) => Array.isArray(l) && l.every((x) => typeof x === "number"))) return bad();
  if (typeof gameMode !== "string" || !Number.isInteger(gameVersion)) return bad();

  const seedDate = new Date(parseInt(seed, 10));
  const now = new Date();
  // a future seed is impossible in normal play; a seed older than 5 hours is rejected too
  if (seedDate.getTime() > now.getTime() || seedDate.getTime() < now.getTime() - 1000 * 60 * 60 * 5) {
    return apiErrorResponse(INVALID_SEED, 400);
  }
  // a non-numeric seed passes both checks upstream (NaN comparisons) and fails inserting the invalid date → 500
  if (Number.isNaN(seedDate.getTime())) return apiErrorResponse(INTERNAL_ERROR, 500);
  await withHyperdriveClient(hd(env), (c) =>
    c.query(
      `INSERT INTO bubble_game_record (id, seed, "seededAt", "userId", score, logs, "gameMode", "gameVersion", "isVerified")
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, FALSE)`,
      [genAidx(now.getTime()), seed, seedDate, me, score, JSON.stringify(logs), gameMode, gameVersion],
    ),
  );
  return new Response(null, { status: 204 });
};

function pgOnly(h: Handler): Handler {
  return async (env, body, ctx) => {
    if (!env.HYPERDRIVE?.connectionString) {
      return apiErrorResponse({ message: "Hyperdrive required.", code: "HYPERDRIVE_UNBOUND", id: "00000000-0000-4000-8000-0000000000b1", kind: "server" }, 501);
    }
    return h(env, body, ctx);
  };
}

export const bubbleGameHandlers: Record<string, Handler> = {
  "bubble-game/ranking": pgOnly(ranking),
  "bubble-game/register": pgOnly(register),
};

