/**
 * Data imports (W7.10): i/import-following|muting|blocking|user-lists|antennas.
 *
 * Endpoints follow upstream: `canImport*` role policy, the caller's own drive file, EMPTY_FILE /
 * TOO_BIG_FILE (64 KiB for the CSV imports, 32 MiB right after an account move to the caller)
 * with each endpoint's error ids, antennaLimit for antennas. The work runs as an `import` job on
 * `mk-jobs` (inline without the binding): the file is read from R2 and each line handled like the
 * upstream processors (Import*ProcessorService): accounts resolved like RemoteUserResolveService
 * (WebFinger for unknown remote ones), follows / blocks as silent UserFollowingService /
 * UserBlockingService calls, a failing line logged and skipped.
 */

import { genAidx } from "../../id/src/index.js";
import type { ApiEnv } from "./env.js";
import { apiErrorResponse, CREDENTIAL_REQUIRED, INVALID_PARAM } from "./errors.js";
import { authenticatePg, extractToken } from "./auth-pg.js";
import { withHyperdriveClient, type PgQueryable } from "./pg.js";
import { buildPackConfig } from "./meta-source.js";
import { getUserPoliciesPg, hasRolePolicyPg } from "./policies-pg.js";
import { ROLE_PERMISSION_DENIED } from "./emojis-pg.js";
import * as g from "./graph-pg.js";
import * as O from "./ap/outbound.js";
import { createNotification } from "./notifications-do.js";
import { webhooksForFollow, webhooksForUnfollow } from "./webhooks-pg.js";
import { clientError as err, hd } from "./handler-kit.js";
import { fromSimpleArray } from "../../db/src/simple-array.js";
import { enqueueJob } from "./queues/jobs-queue.js";

type Ctx = { hasCredential: boolean; request: Request };
type Body = Record<string, unknown>;
type Handler = (env: ApiEnv, body: Body, ctx: Ctx) => Promise<Response | unknown>;

const ERRS = (noSuchFile: string, tooBig: string, empty: string) => ({
  noSuchFile: err("NO_SUCH_FILE", noSuchFile, "No such file."),
  tooBigFile: err("TOO_BIG_FILE", tooBig, "That file is too big."),
  emptyFile: err("EMPTY_FILE", empty, "That file is empty."),
});

export const IMPORT_ENTITIES = {
  following: { endpoint: "i/import-following", policy: "canImportFollowing", errors: ERRS("b98644cf-a5ac-4277-a502-0b8054a709a3", "dee9d4ed-ad07-43ed-8b34-b2856398bc60", "31a1b42c-06f7-42ae-8a38-a661c5c9f691") },
  muting: { endpoint: "i/import-muting", policy: "canImportMuting", errors: ERRS("e674141e-bd2a-ba85-e616-aefb187c9c2a", "9b4ada6d-d7f7-0472-0713-4f558bd1ec9c", "d2f12af1-e7b4-feac-86a3-519548f2728e") },
  blocking: { endpoint: "i/import-blocking", policy: "canImportBlocking", errors: ERRS("ebb53e5f-6574-9c0c-0b92-7ca6def56d7e", "b7fbf0b1-aeef-3b21-29ef-fadd4cb72ccf", "6f3a4dcc-f060-a707-4950-806fbdbe60d6") },
  userList: { endpoint: "i/import-user-lists", policy: "canImportUserLists", errors: ERRS("ea9cc34f-c415-4bc6-a6fe-28ac40357049", "ae6e7a22-971b-4b52-b2be-fc0b9b121fe9", "99efe367-ce6e-4d44-93f8-5fae7b040356") },
  antenna: { endpoint: "i/import-antennas", policy: "canImportAntennas", errors: ERRS("3b71d086-c3fa-431c-b01d-ded65a777172", "", "7f60115d-8d93-4b0f-bd0e-3815dcbb389f") },
} as const;
export type ImportEntity = keyof typeof IMPORT_ENTITIES;

const TOO_MANY_ANTENNAS = err("TOO_MANY_ANTENNAS", "600917d4-a4cb-4cc5-8ba8-7ac8ea3c7779", "You cannot create antenna any more.");
const CSV_MAX = 64 * 1024;

export type ImportJob = { kind: "import"; entity: ImportEntity; userId: string; fileId: string; withReplies?: boolean };

async function readFileText(env: ApiEnv, c: PgQueryable, fileId: string, userId: string): Promise<string | null> {
  const f = (await c.query(`SELECT "accessKey" FROM drive_file WHERE id = $1 AND "userId" = $2`, [fileId, userId])).rows[0];
  if (!f?.accessKey || !env.MEDIA_BUCKET) return null;
  const obj = await env.MEDIA_BUCKET.get(`drive/${f.accessKey}`);
  return obj ? new TextDecoder().decode(await obj.arrayBuffer()) : null;
}

/** Acct.parse */
function parseAcct(s: string): { username: string; host: string | null } {
  const t = s.startsWith("@") ? s.slice(1) : s;
  const [username, host] = t.split("@", 2);
  return { username: username ?? "", host: host ?? null };
}

/** `key=value` pairs from index 2 (Import*ProcessorService) */
function withRepliesOf(parts: string[]): boolean | null {
  let v: boolean | null = null;
  for (const kv of parts.slice(2)) {
    const [k, val] = kv.split("=");
    if (k === "withReplies") v = val === "true";
  }
  return v;
}

/** UserListService.addMember (also used by users/lists/push): limit, insert, userAdded, proxy follow for remote members. */
export async function addListMemberPg(env: ApiEnv, targetId: string, list: { id: string; userId: string }, meId: string, withReplies = false): Promise<"ok" | "tooManyUsers"> {
  const r = await withHyperdriveClient(hd(env), async (c) => {
    const n = Number((await c.query(`SELECT count(*)::int AS n FROM user_list_membership WHERE "userListId" = $1`, [list.id])).rows[0]?.n ?? 0);
    if (n >= Number((await getUserPoliciesPg(env, c, meId)).userEachUserListsLimit)) return "tooManyUsers" as const;
    await c.query(`INSERT INTO user_list_membership (id, "userId", "userListId", "userListUserId", "withReplies") VALUES ($1, $2, $3, $4, $5)`, [
      genAidx(Date.now()), targetId, list.id, list.userId, withReplies,
    ]);
    const host = (await c.query(`SELECT host FROM "user" WHERE id = $1`, [targetId])).rows[0]?.host ?? null;
    return { host: host as string | null };
  });
  if (r === "tooManyUsers") return r;
  try {
    const { packUsers } = await import("./client-endpoints-pg.js");
    const { publishToUserStream } = await import("./stream-publish.js");
    const [user] = await packUsers(env, [targetId], null, false);
    if (user) await publishToUserStream(env, list.userId, `userList:${list.id}`, "userAdded", user);
  } catch {
    /* streaming is best-effort */
  }
  if (r.host != null) {
    // so that the remote member's notes arrive even with no local follower (the proxy account follows)
    const { fetchSystemAccountC } = await import("./ap/relay.js");
    const proxyId = await withHyperdriveClient(hd(env), (c) => fetchSystemAccountC(c, "proxy"));
    const { followPg } = await import("./user-relations-pg.js");
    await followPg(env, proxyId, targetId).catch(() => undefined);
  }
  return "ok";
}

/** RemoteUserResolveService.resolveUser via the processors' lookup (throws when unresolvable). */
async function resolveTarget(env: ApiEnv, username: string, host: string | null): Promise<string> {
  const { resolveUserIdByAcct } = await import("./remote-user-resolve.js");
  return resolveUserIdByAcct(env, username, host);
}

export async function runImport(env: ApiEnv, job: ImportJob): Promise<{ done: number; skipped: number }> {
  const me = job.userId;
  const text = await withHyperdriveClient(hd(env), async (c) => {
    if (!(await c.query(`SELECT 1 AS ok FROM "user" WHERE id = $1`, [me])).rows.length) return null;
    return readFileText(env, c, job.fileId, me);
  });
  const stat = { done: 0, skipped: 0 };
  if (text == null) return stat;

  if (job.entity === "antenna") {
    // ImportAntennasProcessorService: one try around the loop (an error stops the rest)
    const now = Date.now();
    try {
      const list = JSON.parse(text) as Record<string, unknown>[];
      await withHyperdriveClient(hd(env), async (c) => {
        for (const a of list) {
          const kw = a.keywords as string[][];
          if (kw.length === 0 || kw[0]!.every((x) => x === "")) { stat.skipped++; continue; }
          if (!validAntenna(a)) { stat.skipped++; continue; }
          const users = ((a.src === "list" && a.userListAccts !== null ? a.userListAccts : a.users) as string[]).filter(Boolean);
          await c.query(
            `INSERT INTO antenna (id, "lastUsedAt", "userId", name, src, "userListId", keywords, "excludeKeywords", users,
               "caseSensitive", "localOnly", "excludeBots", "withReplies", "withFile", "excludeNotesInSensitiveChannel", "isActive")
             VALUES ($1, $2, $3, $4, $5, NULL, $6::jsonb, $7::jsonb, $8::varchar[], $9, $10, $11, $12, $13, $14, TRUE)`,
            [
              genAidx(now), new Date(now).toISOString(), me, a.name, a.src === "list" && a.userListAccts ? "users" : a.src,
              JSON.stringify(a.keywords), JSON.stringify(a.excludeKeywords), users,
              a.caseSensitive, a.localOnly ?? false, a.excludeBots ?? false, a.withReplies, a.withFile, a.excludeNotesInSensitiveChannel ?? false,
            ],
          );
          stat.done++;
        }
      });
    } catch (e) {
      console.warn(`import antenna failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    return stat;
  }

  for (const line of text.trim().split("\n")) {
    try {
      const parts = line.split(",");
      if (job.entity === "userList") {
        const listName = parts[0]!.trim();
        const { username, host } = parseAcct(parts[1]!.trim());
        const withReplies = withRepliesOf(parts) === true;
        // the list is created before the account is resolved
        const list = await withHyperdriveClient(hd(env), async (c) => {
          const found = (await c.query(`SELECT id, "userId" FROM user_list WHERE "userId" = $1 AND name = $2 LIMIT 1`, [me, listName])).rows[0];
          if (found) return { id: String(found.id), userId: String(found.userId) };
          const id = genAidx(Date.now());
          await c.query(`INSERT INTO user_list (id, "userId", name) VALUES ($1, $2, $3)`, [id, me, listName]);
          return { id, userId: me };
        });
        const target = await resolveTarget(env, username, host);
        const exists = await withHyperdriveClient(hd(env), async (c) =>
          (await c.query(`SELECT 1 AS ok FROM user_list_membership WHERE "userListId" = $1 AND "userId" = $2`, [list.id, target])).rows.length > 0,
        );
        if (exists) { stat.skipped++; continue; }
        if ((await addListMemberPg(env, target, list, me, withReplies)) !== "ok") throw new Error("Too many users");
        stat.done++;
        continue;
      }
      const { username, host } = parseAcct(parts[0]!.trim());
      if (!host) { stat.skipped++; continue; }
      const target = await resolveTarget(env, username, host);
      if (target === me) { stat.skipped++; continue; }
      if (job.entity === "following") {
        const { followPg } = await import("./user-relations-pg.js");
        await followPg(env, me, target, { silent: true, withReplies: withRepliesOf(parts) ?? job.withReplies === true });
      } else if (job.entity === "muting") {
        // UserMutingService.mute: a plain insert (a second mute of the same user fails that line)
        if ((await g.mute(env, me, target)) !== "muted") throw new Error("already muting");
      } else {
        const { blockPg } = await import("./user-relations-pg.js");
        await blockPg(env, me, target, true);
      }
      stat.done++;
    } catch (e) {
      stat.skipped++;
      console.warn(`import ${job.entity} line failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return stat;
}

/**
 * AccountMoveService.validateAlsoKnownAs(me, src moved within 2 hours, instant): one of the
 * caller's alsoKnownAs accounts known here has moved to the caller in the last two hours.
 */
async function movedHereRecently(env: ApiEnv, c: PgQueryable, me: string): Promise<boolean> {
  const u = (await c.query(`SELECT to_jsonb(u) AS j FROM "user" u WHERE id = $1`, [me])).rows[0]?.j as Record<string, unknown> | undefined;
  const aka = fromSimpleArray(u?.alsoKnownAs) ?? [];
  if (!aka.length) return false;
  const base = buildPackConfig(env).url;
  const dstUri = `${base}/users/${me}`;
  const rows = (await c.query(
    `SELECT to_jsonb(s) AS j FROM "user" s WHERE s.uri = ANY($1::varchar[]) OR ($2 || '/users/' || s.id) = ANY($1::varchar[])`,
    [aka, base],
  )).rows;
  return rows.some((r) => {
    const s = r.j as Record<string, unknown>;
    return s.movedToUri === dstUri && s.movedAt != null && new Date(String(s.movedAt)).getTime() + 2 * 3600_000 > Date.now();
  });
}

const isStrArr = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === "string");
const isKw = (v: unknown) => Array.isArray(v) && v.every(isStrArr);
const optBool = (v: unknown) => v === undefined || typeof v === "boolean";

/** exportedAntennaSchema */
function validAntenna(a: Record<string, unknown>): boolean {
  return (
    typeof a.name === "string" && a.name.length >= 1 && [...a.name].length <= 100 &&
    ["home", "all", "users", "list", "users_blacklist"].includes(a.src as string) &&
    (a.userListAccts === undefined || a.userListAccts === null || isStrArr(a.userListAccts)) &&
    isKw(a.keywords) && isKw(a.excludeKeywords) && isStrArr(a.users) &&
    typeof a.caseSensitive === "boolean" && typeof a.withReplies === "boolean" && typeof a.withFile === "boolean" &&
    optBool(a.localOnly) && optBool(a.excludeBots) && optBool(a.excludeNotesInSensitiveChannel)
  );
}

// ---------------------------------------------------------------- endpoints

function importHandler(entity: ImportEntity): Handler {
  const def = IMPORT_ENTITIES[entity];
  return async (env, body, ctx) => {
    if (!env.HYPERDRIVE?.connectionString) {
      return apiErrorResponse({ message: "Hyperdrive required.", code: "HYPERDRIVE_UNBOUND", id: "00000000-0000-4000-8000-0000000000b1", kind: "server" }, 501);
    }
    if (!ctx.hasCredential) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
    const token = extractToken(ctx.request, body);
    const me = token ? ((await authenticatePg(env, token))?.user.id ?? null) : null;
    if (!me) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
    if (typeof body.fileId !== "string") return apiErrorResponse(INVALID_PARAM, 400);
    if (entity === "following" && body.withReplies !== undefined && typeof body.withReplies !== "boolean") return apiErrorResponse(INVALID_PARAM, 400);
    const res = await withHyperdriveClient(hd(env), async (c) => {
      if (!(await hasRolePolicyPg(env, c, me, def.policy))) return apiErrorResponse(ROLE_PERMISSION_DENIED, 403);
      const file = (await c.query(`SELECT id, size FROM drive_file WHERE id = $1 AND "userId" = $2`, [body.fileId, me])).rows[0];
      if (!file) return apiErrorResponse(def.errors.noSuchFile, 400);
      if (Number(file.size) === 0) return apiErrorResponse(def.errors.emptyFile, 400);
      if (entity === "antenna") {
        let antennas: unknown;
        // (upstream: a JSON.parse error propagates → INTERNAL_ERROR)
        antennas = JSON.parse((await readFileText(env, c, String(file.id), me)) ?? "");
        const n = Number((await c.query(`SELECT count(*)::int AS n FROM antenna WHERE "userId" = $1`, [me])).rows[0]?.n ?? 0);
        if (n + (Array.isArray(antennas) ? antennas.length : 0) >= Number((await getUserPoliciesPg(env, c, me)).antennaLimit)) return apiErrorResponse(TOO_MANY_ANTENNAS, 400);
      } else if (Number(file.size) > ((await movedHereRecently(env, c, me)) ? 32 * 1024 * 1024 : CSV_MAX)) {
        return apiErrorResponse(def.errors.tooBigFile, 400);
      }
      return null;
    });
    if (res) return res;
    const job: ImportJob = { kind: "import", entity, userId: me, fileId: body.fileId, ...(entity === "following" ? { withReplies: body.withReplies === true } : {}) };
    if (env.Q_JOBS) await enqueueJob(env, job);
    else await runImport(env, job);
    return new Response(null, { status: 204 });
  };
}

export const importHandlers: Record<string, Handler> = Object.fromEntries(
  (Object.keys(IMPORT_ENTITIES) as ImportEntity[]).map((e) => [IMPORT_ENTITIES[e].endpoint, importHandler(e)]),
);

