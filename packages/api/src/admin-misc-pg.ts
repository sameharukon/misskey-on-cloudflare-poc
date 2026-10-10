/**
 * Remaining admin endpoints on PG: accounts (delete / find-by-email), drive administration
 * (files / show-file / cleanup / clean-remote-files / delete-all-files-of-a-user), unset-mfa /
 * unset-user-avatar / unset-user-banner, update-proxy-account, DB statistics (get-index-stats /
 * get-table-stats) and captcha settings (captcha/current / captcha/save).
 *
 * Bulk drive deletions go through `mk-jobs` as `driveCleanup` jobs (bounded steps that
 * re-enqueue themselves); without the queue binding the steps run inline. Captcha tokens are
 * verified against the provider's siteverify API with `env.AP_FETCH ?? fetch`, as upstream
 * CaptchaService does.
 */

import { genAidx, parseAidxTime } from "../../id/src/index.js";
import type { ApiEnv } from "./env.js";
import { apiErrorResponse, INTERNAL_ERROR } from "./errors.js";
import { authenticatePg, extractToken } from "./auth-pg.js";
import { withHyperdriveClient, type PgQueryable } from "./pg.js";
import { isAdministratorPg, isModeratorPg, moderationLogPg } from "./policies-pg.js";
import { packMe, packUsers, pagination } from "./client-endpoints-pg.js";
import { deleteObjects, packFileDetail } from "./drive-pg.js";
import { deleteAccount } from "./account-delete-pg.js";
import { publishToUserStream } from "./stream-publish.js";
import { invalidateMetaCache, setMetaOverlay } from "./meta-runtime.js";
import { fetchMetaFromPg } from "./meta-pg.js";
import { adminGate } from "./admin-gate.js";
import { clientError as err, hd, invalidParam as bad } from "./handler-kit.js";
import { enqueueJob } from "./queues/jobs-queue.js";

type Ctx = { hasCredential: boolean; request: Request };
type Body = Record<string, unknown>;
type Row = Record<string, unknown>;
export type AdminMiscHandler = (env: ApiEnv, body: Body, ctx: Ctx) => Promise<Response | unknown>;

const E = {
  userNotFound: err("USER_NOT_FOUND", "cb865949-8af5-4062-a88c-ef55e8786d1d", "No such user who has the email address."),
  noSuchFile: err("NO_SUCH_FILE", "caf3ca38-c6e5-472e-a30c-b05377dcc240", "No such file."),
  mfaNoSuchUser: err("NO_SUCH_USER", "ccafc7fe-5074-4edd-9dc0-8ef9ef6a701d", "No such user."),
  mfaAccessDenied: err("ACCESS_DENIED", "cda8f8ce-89a6-4f92-8055-33bbe0c1464d", "Access denied."),
};

const str = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : undefined);
const optStr = (v: unknown) => v === undefined || v === null || typeof v === "string";
const internal = () => apiErrorResponse(INTERNAL_ERROR, 500);
const noContent = () => new Response(null, { status: 204 });
const iso = (id: string) => (parseAidxTime(id) ?? new Date(0)).toISOString();

async function gate(env: ApiEnv, body: Body, ctx: Ctx, level: "moderator" | "admin"): Promise<{ denied: Response } | { me: string | null }> {
  const denied = await adminGate(ctx.request, env as never, body, level);
  if (denied) return { denied };
  const token = extractToken(ctx.request, body);
  return { me: token ? ((await authenticatePg(env, token))?.user.id ?? null) : null };
}

type UserRow = { id: string; username: string; host: string | null; avatarId: string | null; bannerId: string | null };

async function getUser(c: PgQueryable, id: string): Promise<UserRow | null> {
  const r = (await c.query(`SELECT id, username, host, "avatarId", "bannerId" FROM "user" WHERE id = $1`, [id])).rows[0];
  return r
    ? { id: String(r.id), username: String(r.username), host: (r.host as string | null) ?? null, avatarId: (r.avatarId as string | null) ?? null, bannerId: (r.bannerId as string | null) ?? null }
    : null;
}

const who = (u: UserRow) => ({ userId: u.id, userUsername: u.username, userHost: u.host });

// ---------------------------------------------------------------- accounts

const accountsDelete: AdminMiscHandler = async (env, body, ctx) => {
  const g = await gate(env, body, ctx, "admin");
  if ("denied" in g) return g.denied;
  const userId = str(body.userId);
  if (!userId) return bad();
  const exists = await withHyperdriveClient(hd(env), async (c) => (await getUser(c, userId)) !== null);
  if (!exists) return internal(); // upstream: Error('user not found')
  // DeleteAccountService.deleteAccount (root / system accounts throw → 500)
  return (await deleteAccount(env, userId, g.me)) === "ok" ? noContent() : internal();
};

const accountsFindByEmail: AdminMiscHandler = async (env, body, ctx) => {
  const g = await gate(env, body, ctx, "admin");
  if ("denied" in g) return g.denied;
  if (typeof body.email !== "string") return bad();
  const userId = await withHyperdriveClient(hd(env), async (c) =>
    (await c.query(`SELECT "userId" FROM user_profile WHERE email = $1 LIMIT 1`, [body.email])).rows[0]?.userId as string | undefined,
  );
  if (!userId) return apiErrorResponse(E.userNotFound, 400);
  // UserDetailedNotMe, packed for an anonymous viewer (upstream pack(user, null))
  const [u] = await packUsers(env, [String(userId)], null, true);
  return u ?? apiErrorResponse(E.userNotFound, 400);
};

// ---------------------------------------------------------------- unset-mfa / avatar / banner

const unsetMfa: AdminMiscHandler = async (env, body, ctx) => {
  const g = await gate(env, body, ctx, "moderator");
  if ("denied" in g) return g.denied;
  const userId = str(body.userId);
  if (!userId) return bad();
  return withHyperdriveClient(hd(env), async (c) => {
    const user = await getUser(c, userId);
    if (!user) return apiErrorResponse(E.mfaNoSuchUser, 400);
    if (g.me !== user.id && (await isAdministratorPg(env, c, user.id))) return apiErrorResponse(E.mfaAccessDenied, 400);
    await c.query("BEGIN");
    try {
      await c.query(`DELETE FROM user_security_key WHERE "userId" = $1`, [user.id]);
      await c.query(
        `UPDATE user_profile SET "twoFactorSecret" = NULL, "twoFactorBackupSecret" = NULL, "twoFactorEnabled" = FALSE, "usePasswordLessLogin" = FALSE WHERE "userId" = $1`,
        [user.id],
      );
      await c.query("COMMIT");
    } catch (e) {
      await c.query("ROLLBACK").catch(() => undefined);
      throw e;
    }
    if (g.me) await moderationLogPg(c, g.me, "unsetMfa", who(user), genAidx(Date.now()));
    return noContent();
  });
};

function unsetUserImage(kind: "avatar" | "banner"): AdminMiscHandler {
  const cols = kind === "avatar" ? ["avatarId", "avatarUrl", "avatarBlurhash"] : ["bannerId", "bannerUrl", "bannerBlurhash"];
  const logType = kind === "avatar" ? "unsetUserAvatar" : "unsetUserBanner";
  return async (env, body, ctx) => {
    const g = await gate(env, body, ctx, "moderator");
    if ("denied" in g) return g.denied;
    const userId = str(body.userId);
    if (!userId) return bad();
    return withHyperdriveClient(hd(env), async (c) => {
      const user = await getUser(c, userId);
      if (!user) return internal(); // upstream: Error('user not found')
      const fileId = kind === "avatar" ? user.avatarId : user.bannerId;
      if (fileId == null) return noContent();
      await c.query(`UPDATE "user" SET ${cols.map((k) => `"${k}" = NULL`).join(", ")} WHERE id = $1`, [user.id]);
      if (g.me) await moderationLogPg(c, g.me, logType, { ...who(user), fileId }, genAidx(Date.now()));
      return noContent();
    });
  };
}

// ---------------------------------------------------------------- update-proxy-account

const updateProxyAccount: AdminMiscHandler = async (env, body, ctx) => {
  const g = await gate(env, body, ctx, "moderator");
  if ("denied" in g) return g.denied;
  const d = body.description;
  if (d !== undefined && d !== null && (typeof d !== "string" || d.length < 1 || d.length > 1500)) return bad();
  const { fetchSystemAccountC } = await import("./ap/relay.js");
  const proxyId = await withHyperdriveClient(hd(env), async (c) => {
    const id = await fetchSystemAccountC(c, "proxy");
    // SystemAccountService.updateCorrespondingUserProfile('proxy', { description })
    if (d !== undefined) await c.query(`UPDATE user_profile SET description = $2 WHERE "userId" = $1`, [id, d]);
    if (d !== undefined && g.me) {
      await moderationLogPg(c, g.me, "updateProxyAccountDescription", { before: null, after: d }, genAidx(Date.now()));
    }
    return id;
  });
  return packMe(env, proxyId); // upstream: pack(proxy, { schema: 'MeDetailed' })
};

// ---------------------------------------------------------------- drive: files / show-file

const ORIGINS = ["combined", "local", "remote"];

const driveFiles: AdminMiscHandler = async (env, body, ctx) => {
  const g = await gate(env, body, ctx, "moderator");
  if ("denied" in g) return g.denied;
  if (body.limit !== undefined && (typeof body.limit !== "number" || !Number.isInteger(body.limit) || body.limit < 1 || body.limit > 100)) return bad();
  if (!optStr(body.userId) || !optStr(body.hostname) || !optStr(body.type)) return bad();
  if (typeof body.type === "string" && !/^[a-zA-Z0-9/\-*]+$/.test(body.type)) return bad();
  if (body.origin !== undefined && !ORIGINS.includes(body.origin as string)) return bad();
  const limit = typeof body.limit === "number" ? body.limit : 10;
  const origin = (body.origin as string | undefined) ?? "local";
  return withHyperdriveClient(hd(env), async (c) => {
    const params: unknown[] = [];
    const pg = pagination(body, params, "f.id");
    const w = [...pg.where];
    if (str(body.userId)) {
      params.push(body.userId);
      w.push(`f."userId" = $${params.length}`);
    } else {
      if (origin === "local") w.push(`f."userHost" IS NULL`);
      else if (origin === "remote") w.push(`f."userHost" IS NOT NULL`);
      if (str(body.hostname)) {
        params.push(body.hostname);
        w.push(`f."userHost" = $${params.length}`);
      }
    }
    if (str(body.type)) {
      const t = body.type as string;
      params.push(t.endsWith("/*") ? t.replace("/*", "/") + "%" : t);
      w.push(t.endsWith("/*") ? `f.type LIKE $${params.length}` : `f.type = $${params.length}`);
    }
    params.push(limit);
    const rows = (await c.query(
      `SELECT f.* FROM drive_file f ${w.length ? `WHERE ${w.join(" AND ")}` : ""} ORDER BY f.id ${pg.order} LIMIT $${params.length}`,
      params,
    )).rows;
    const out: unknown[] = [];
    for (const r of rows) out.push(await packFileDetail(env, c, r, true)); // detail, withUser, self
    return out;
  });
};

const driveShowFile: AdminMiscHandler = async (env, body, ctx) => {
  const g = await gate(env, body, ctx, "moderator");
  if ("denied" in g) return g.denied;
  const fileId = typeof body.fileId === "string" ? body.fileId : undefined;
  const url = typeof body.url === "string" ? body.url : undefined;
  if (fileId === undefined && url === undefined) return bad();
  return withHyperdriveClient(hd(env), async (c) => {
    const r = fileId !== undefined
      ? (await c.query(`SELECT to_jsonb(f) AS f FROM drive_file f WHERE id = $1`, [fileId])).rows[0]
      : (await c.query(
        `SELECT to_jsonb(f) AS f FROM drive_file f WHERE url = $1 OR "thumbnailUrl" = $1 OR "webpublicUrl" = $1 LIMIT 1`,
        [url],
      )).rows[0];
    const file = r?.f as Row | undefined;
    if (!file) return apiErrorResponse(E.noSuchFile, 400);
    const ownerId = (file.userId as string | null) ?? null;
    if (ownerId && !(await getUser(c, ownerId))) return internal(); // findOneByOrFail
    const iAmModerator = g.me ? await isModeratorPg(env, c, g.me) : true;
    const ownerIsModerator = ownerId ? await isModeratorPg(env, c, ownerId) : false;
    const n = (k: string) => (file[k] ?? null);
    return {
      id: String(file.id),
      userId: ownerId,
      userHost: n("userHost"),
      isLink: Boolean(file.isLink),
      maybePorn: Boolean(file.maybePorn),
      maybeSensitive: Boolean(file.maybeSensitive),
      isSensitive: Boolean(file.isSensitive),
      folderId: n("folderId"),
      src: n("src"),
      uri: n("uri"),
      webpublicAccessKey: n("webpublicAccessKey"),
      thumbnailAccessKey: n("thumbnailAccessKey"),
      accessKey: n("accessKey"),
      webpublicType: n("webpublicType"),
      webpublicUrl: n("webpublicUrl"),
      thumbnailUrl: n("thumbnailUrl"),
      url: n("url"),
      storedInternal: n("storedInternal"),
      properties: file.properties ?? {},
      blurhash: n("blurhash"),
      comment: n("comment"),
      size: Number(file.size ?? 0),
      type: String(file.type ?? ""),
      name: String(file.name ?? ""),
      md5: String(file.md5 ?? ""),
      createdAt: iso(String(file.id)),
      requestIp: iAmModerator ? n("requestIp") : null,
      requestHeaders: iAmModerator && !ownerIsModerator ? n("requestHeaders") : null,
    };
  });
};

// ---------------------------------------------------------------- drive: bulk deletion (mk-jobs)

/**
 * `user`: every file of a user (admin/delete-all-files-of-a-user); `system`: files without an
 * owner (admin/drive/cleanup); `remote`: cached remote files become links to their `uri`
 * (CleanRemoteFilesProcessorService → DriveService.deleteFileSync(file, isExpired = true)).
 */
export type DriveCleanupJob = { kind: "driveCleanup"; target: "user" | "system" | "remote"; userId?: string; cursor?: string };

export const DRIVE_CLEANUP_BATCH = 50;

async function enqueueDriveCleanup(env: ApiEnv, job: DriveCleanupJob): Promise<void> {
  if (env.Q_JOBS) await enqueueJob(env, job);
  else {
    // offline / tests: run every step now
    let next: DriveCleanupJob | null = job;
    while (next) next = await runDriveCleanupStep(env, next);
  }
}

/** One bounded step (≤ DRIVE_CLEANUP_BATCH files); returns the follow-up job or null when done. */
export async function runDriveCleanupStep(env: ApiEnv, job: DriveCleanupJob): Promise<DriveCleanupJob | null> {
  if (job.target === "remote") {
    const rows = await withHyperdriveClient(hd(env), async (c) => {
      const params: unknown[] = [DRIVE_CLEANUP_BATCH];
      if (job.cursor) params.push(job.cursor);
      const rows = (await c.query(
        `SELECT * FROM drive_file WHERE "userHost" IS NOT NULL AND "isLink" = FALSE ${job.cursor ? `AND id > $2` : ""} ORDER BY id LIMIT $1`,
        params,
      )).rows;
      for (const f of rows) {
        if (f.uri != null) {
          await c.query(
            `UPDATE drive_file SET "isLink" = TRUE, url = uri, "thumbnailUrl" = NULL, "webpublicUrl" = NULL, "storedInternal" = FALSE,
               "accessKey" = $2, "thumbnailAccessKey" = $3, "webpublicAccessKey" = $4 WHERE id = $1`,
            [f.id, crypto.randomUUID(), `thumbnail-${crypto.randomUUID()}`, `webpublic-${crypto.randomUUID()}`],
          );
        } else {
          await c.query(`DELETE FROM drive_file WHERE id = $1`, [f.id]);
        }
      }
      return rows;
    });
    for (const f of rows) {
      await deleteObjects(env, f);
      if (f.userId) await publishToUserStream(env, String(f.userId), "drive", "fileDeleted", String(f.id));
    }
    return rows.length === DRIVE_CLEANUP_BATCH ? { ...job, cursor: String(rows[rows.length - 1]!.id) } : null;
  }
  const rows = await withHyperdriveClient(hd(env), async (c) =>
    job.target === "user"
      ? (await c.query(
        `DELETE FROM drive_file WHERE id IN (SELECT id FROM drive_file WHERE "userId" = $1 ORDER BY id LIMIT $2) RETURNING *`,
        [job.userId, DRIVE_CLEANUP_BATCH],
      )).rows
      : (await c.query(
        `DELETE FROM drive_file WHERE id IN (SELECT id FROM drive_file WHERE "userId" IS NULL ORDER BY id LIMIT $1) RETURNING *`,
        [DRIVE_CLEANUP_BATCH],
      )).rows,
  );
  for (const f of rows) {
    if (!f.isLink) await deleteObjects(env, f);
    if (f.userId) await publishToUserStream(env, String(f.userId), "drive", "fileDeleted", String(f.id));
  }
  return rows.length === DRIVE_CLEANUP_BATCH ? job : null;
}

const deleteAllFilesOfAUser: AdminMiscHandler = async (env, body, ctx) => {
  const g = await gate(env, body, ctx, "admin");
  if ("denied" in g) return g.denied;
  const userId = str(body.userId);
  if (!userId) return bad();
  await enqueueDriveCleanup(env, { kind: "driveCleanup", target: "user", userId });
  return noContent();
};

const driveCleanup: AdminMiscHandler = async (env, body, ctx) => {
  const g = await gate(env, body, ctx, "moderator");
  if ("denied" in g) return g.denied;
  await enqueueDriveCleanup(env, { kind: "driveCleanup", target: "system" });
  return noContent();
};

const driveCleanRemoteFiles: AdminMiscHandler = async (env, body, ctx) => {
  const g = await gate(env, body, ctx, "moderator");
  if ("denied" in g) return g.denied;
  await enqueueDriveCleanup(env, { kind: "driveCleanup", target: "remote" });
  return noContent();
};

// ---------------------------------------------------------------- DB statistics

const getIndexStats: AdminMiscHandler = async (env, body, ctx) => {
  const g = await gate(env, body, ctx, "admin");
  if ("denied" in g) return g.denied;
  return withHyperdriveClient(hd(env), async (c) => {
    try {
      return (await c.query(`SELECT * FROM pg_indexes`)).rows;
    } catch {
      return []; // pg_catalog not readable (e.g. restricted role)
    }
  });
};

const getTableStats: AdminMiscHandler = async (env, body, ctx) => {
  const g = await gate(env, body, ctx, "admin");
  if ("denied" in g) return g.denied;
  return withHyperdriveClient(hd(env), async (c) => {
    const res: Record<string, { count: number; size: number }> = {};
    try {
      const rows = (await c.query(
        `SELECT relname AS "table", reltuples AS "count", pg_total_relation_size(C.oid) AS "size"
         FROM pg_class C LEFT JOIN pg_namespace N ON (N.oid = C.relnamespace)
         WHERE nspname NOT IN ('pg_catalog', 'information_schema') AND C.relkind <> 'i' AND nspname !~ '^pg_toast'`,
      )).rows;
      for (const r of rows) res[String(r.table)] = { count: Math.trunc(Number(r.count)), size: Math.trunc(Number(r.size)) };
    } catch {
      /* pg_catalog not readable */
    }
    return res;
  });
};

// ---------------------------------------------------------------- captcha

export const SUPPORTED_CAPTCHA_PROVIDERS = ["none", "hcaptcha", "mcaptcha", "recaptcha", "turnstile", "testcaptcha"] as const;
type CaptchaProvider = (typeof SUPPORTED_CAPTCHA_PROVIDERS)[number];

const CAPTCHA_ERR = {
  invalidProvider: { ...err("INVALID_PROVIDER", "14bf7ae1-80cc-4363-acb2-4fd61d086af0", "Invalid provider."), status: 400 },
  invalidParameters: { ...err("INVALID_PARAMETERS", "26654194-410e-44e2-b42e-460ff6f92476", "Invalid parameters."), status: 400 },
  noResponseProvided: { ...err("NO_RESPONSE_PROVIDED", "40acbba8-0937-41fb-bb3f-474514d40afe", "No response provided."), status: 400 },
  requestFailed: { ...err("REQUEST_FAILED", "0f4fe2f1-2c15-4d6e-b714-efbfcde231cd", "Request failed."), status: 500 },
  verificationFailed: { ...err("VERIFICATION_FAILED", "c41c067f-24f3-4150-84b2-b5a3ae8c2214", "Verification failed."), status: 400 },
  unknown: { ...err("UNKNOWN", "f868d509-e257-42a9-99c1-42614b031a97", "unknown"), status: 500 },
};
export type CaptchaErrorCode = keyof typeof CAPTCHA_ERR;

export class CaptchaError extends Error {
  constructor(readonly code: CaptchaErrorCode, message: string) {
    super(message);
  }
}

async function getCaptchaResponse(env: ApiEnv, url: string, secret: string, response: string): Promise<{ success: boolean; "error-codes"?: string[] }> {
  const res = await (env.AP_FETCH ?? fetch)(url, {
    method: "POST",
    body: new URLSearchParams({ secret, response }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
  if (!res.ok) throw new Error(`${res.status}`);
  return (await res.json()) as { success: boolean; "error-codes"?: string[] };
}

/** CaptchaService.verifyHcaptcha / verifyRecaptcha / verifyTurnstile */
export async function verifySiteverify(env: ApiEnv, name: string, url: string, secret: string, response: string | null | undefined): Promise<void> {
  if (response == null) throw new CaptchaError("noResponseProvided", `${name}-failed: no response provided`);
  const result = await getCaptchaResponse(env, url, secret, response).catch((e) => {
    throw new CaptchaError("requestFailed", `${name}-request-failed: ${e}`);
  });
  if (result.success !== true) {
    const codes = result["error-codes"] ? result["error-codes"].join(", ") : "";
    throw new CaptchaError("verificationFailed", `${name}-failed: ${codes}`);
  }
}

/** CaptchaService.verifyMcaptcha */
export async function verifyMcaptcha(env: ApiEnv, secret: string, siteKey: string, instanceHost: string, response: string | null | undefined): Promise<void> {
  if (response == null) throw new CaptchaError("noResponseProvided", "mcaptcha-failed: no response provided");
  const endpointUrl = new URL("/api/v1/pow/siteverify", instanceHost);
  const result = await (env.AP_FETCH ?? fetch)(endpointUrl.toString(), {
    method: "POST",
    body: JSON.stringify({ key: siteKey, secret, token: response }),
    headers: { "Content-Type": "application/json" },
  });
  if (result.status !== 200) throw new CaptchaError("requestFailed", "mcaptcha-failed: mcaptcha didn't return 200 OK");
  const resp = (await result.json()) as { valid: boolean };
  if (!resp.valid) throw new CaptchaError("verificationFailed", "mcaptcha-request-failed");
}

export function verifyTestcaptcha(response: string | null | undefined): void {
  if (response == null) throw new CaptchaError("noResponseProvided", "testcaptcha-failed: no response provided");
  if (response !== "testcaptcha-passed") throw new CaptchaError("verificationFailed", "testcaptcha-failed");
}

type CaptchaParams = { sitekey?: string | null; secret?: string | null; instanceUrl?: string | null; captchaResult?: string | null };

/** CaptchaService.updateMeta */
async function updateCaptchaMeta(env: ApiEnv, provider: CaptchaProvider, p: CaptchaParams): Promise<void> {
  const patch: Record<string, unknown> = {
    enableHcaptcha: provider === "hcaptcha",
    enableMcaptcha: provider === "mcaptcha",
    enableRecaptcha: provider === "recaptcha",
    enableTurnstile: provider === "turnstile",
    enableTestcaptcha: provider === "testcaptcha",
  };
  const set = (k: string, v: unknown) => {
    if (v !== undefined) patch[k] = v;
  };
  switch (provider) {
    case "hcaptcha": set("hcaptchaSiteKey", p.sitekey); set("hcaptchaSecretKey", p.secret); break;
    case "mcaptcha": set("mcaptchaSitekey", p.sitekey); set("mcaptchaSecretKey", p.secret); set("mcaptchaInstanceUrl", p.instanceUrl); break;
    case "recaptcha": set("recaptchaSiteKey", p.sitekey); set("recaptchaSecretKey", p.secret); break;
    case "turnstile": set("turnstileSiteKey", p.sitekey); set("turnstileSecretKey", p.secret); break;
  }
  const keys = Object.keys(patch);
  await withHyperdriveClient(hd(env), async (c) => {
    const id = (await c.query(`SELECT id FROM meta ORDER BY id DESC LIMIT 1`)).rows[0]?.id;
    if (!id) throw new Error("no meta");
    await c.query(`UPDATE meta SET ${keys.map((k, i) => `"${k}" = $${i + 2}`).join(", ")} WHERE id = $1`, [id, ...keys.map((k) => patch[k])]);
    try {
      const fresh = await fetchMetaFromPg(c);
      if (fresh) setMetaOverlay(env, fresh);
    } catch {
      /* partial schema (tests) */
    }
  });
  await invalidateMetaCache(env);
}

/** CaptchaService.save */
export async function saveCaptcha(env: ApiEnv, provider: CaptchaProvider, p: CaptchaParams): Promise<{ success: true } | { success: false; error: CaptchaError }> {
  if (!SUPPORTED_CAPTCHA_PROVIDERS.includes(provider)) {
    return { success: false, error: new CaptchaError("invalidProvider", `Invalid captcha provider: ${provider}`) };
  }
  const op: Record<CaptchaProvider, () => Promise<void>> = {
    none: async () => updateCaptchaMeta(env, provider, p),
    hcaptcha: async () => {
      if (!p.secret || !p.captchaResult) throw new CaptchaError("invalidParameters", "hcaptcha-failed: secret and captureResult are required");
      await verifySiteverify(env, "hcaptcha", "https://hcaptcha.com/siteverify", p.secret, p.captchaResult);
      await updateCaptchaMeta(env, provider, p);
    },
    mcaptcha: async () => {
      if (!p.secret || !p.sitekey || !p.instanceUrl || !p.captchaResult) {
        throw new CaptchaError("invalidParameters", "mcaptcha-failed: secret, sitekey, instanceUrl and captureResult are required");
      }
      await verifyMcaptcha(env, p.secret, p.sitekey, p.instanceUrl, p.captchaResult);
      await updateCaptchaMeta(env, provider, p);
    },
    recaptcha: async () => {
      if (!p.secret || !p.captchaResult) throw new CaptchaError("invalidParameters", "recaptcha-failed: secret and captureResult are required");
      await verifySiteverify(env, "recaptcha", "https://www.recaptcha.net/recaptcha/api/siteverify", p.secret, p.captchaResult);
      await updateCaptchaMeta(env, provider, p);
    },
    turnstile: async () => {
      if (!p.secret || !p.captchaResult) throw new CaptchaError("invalidParameters", "turnstile-failed: secret and captureResult are required");
      await verifySiteverify(env, "turnstile", "https://challenges.cloudflare.com/turnstile/v0/siteverify", p.secret, p.captchaResult);
      await updateCaptchaMeta(env, provider, p);
    },
    testcaptcha: async () => {
      if (!p.captchaResult) throw new CaptchaError("invalidParameters", "turnstile-failed: captureResult are required");
      verifyTestcaptcha(p.captchaResult);
      await updateCaptchaMeta(env, provider, p);
    },
  };
  try {
    await op[provider]();
    return { success: true };
  } catch (e) {
    return { success: false, error: e instanceof CaptchaError ? e : new CaptchaError("unknown", `unknown error: ${e}`) };
  }
}

const captchaCurrent: AdminMiscHandler = async (env, body, ctx) => {
  const g = await gate(env, body, ctx, "admin");
  if ("denied" in g) return g.denied;
  // uncached, as upstream (metaService.fetch(true)): the admin view must show the latest save
  const m = await withHyperdriveClient(hd(env), async (c) =>
    ((await c.query(`SELECT to_jsonb(m) AS m FROM meta m ORDER BY id DESC LIMIT 1`)).rows[0]?.m as Row | undefined) ?? {},
  );
  const v = (k: string) => (m[k] as string | null | undefined) ?? null;
  const provider: CaptchaProvider = m.enableHcaptcha ? "hcaptcha"
    : m.enableMcaptcha ? "mcaptcha"
    : m.enableRecaptcha ? "recaptcha"
    : m.enableTurnstile ? "turnstile"
    : m.enableTestcaptcha ? "testcaptcha"
    : "none";
  return {
    provider,
    hcaptcha: { siteKey: v("hcaptchaSiteKey"), secretKey: v("hcaptchaSecretKey") },
    mcaptcha: { siteKey: v("mcaptchaSitekey"), secretKey: v("mcaptchaSecretKey"), instanceUrl: v("mcaptchaInstanceUrl") },
    recaptcha: { siteKey: v("recaptchaSiteKey"), secretKey: v("recaptchaSecretKey") },
    turnstile: { siteKey: v("turnstileSiteKey"), secretKey: v("turnstileSecretKey") },
  };
};

const captchaSave: AdminMiscHandler = async (env, body, ctx) => {
  const g = await gate(env, body, ctx, "admin");
  if ("denied" in g) return g.denied;
  if (!SUPPORTED_CAPTCHA_PROVIDERS.includes(body.provider as CaptchaProvider)) return bad();
  for (const k of ["captchaResult", "sitekey", "secret", "instanceUrl"]) if (!optStr(body[k])) return bad();
  const result = await saveCaptcha(env, body.provider as CaptchaProvider, {
    sitekey: body.sitekey as string | null | undefined,
    secret: body.secret as string | null | undefined,
    instanceUrl: body.instanceUrl as string | null | undefined,
    captchaResult: body.captchaResult as string | null | undefined,
  });
  if (result.success) return noContent();
  const { status, ...e } = CAPTCHA_ERR[result.error.code];
  // upstream replaces the message with the CaptchaError's, except for unknown errors
  return apiErrorResponse(result.error.code === "unknown" ? e : { ...e, message: result.error.message }, status);
};

// ---------------------------------------------------------------- registry

function pgOnly(h: AdminMiscHandler): AdminMiscHandler {
  return async (env, body, ctx) => {
    if (!env.HYPERDRIVE?.connectionString) {
      return apiErrorResponse({ message: "Hyperdrive required.", code: "HYPERDRIVE_UNBOUND", id: "00000000-0000-4000-8000-0000000000b1", kind: "server" }, 501);
    }
    return h(env, body, ctx);
  };
}

const RAW: Record<string, AdminMiscHandler> = {
  "admin/accounts/delete": accountsDelete,
  "admin/accounts/find-by-email": accountsFindByEmail,
  "admin/delete-all-files-of-a-user": deleteAllFilesOfAUser,
  "admin/drive/clean-remote-files": driveCleanRemoteFiles,
  "admin/drive/cleanup": driveCleanup,
  "admin/drive/files": driveFiles,
  "admin/drive/show-file": driveShowFile,
  "admin/unset-mfa": unsetMfa,
  "admin/unset-user-avatar": unsetUserImage("avatar"),
  "admin/unset-user-banner": unsetUserImage("banner"),
  "admin/update-proxy-account": updateProxyAccount,
  "admin/get-index-stats": getIndexStats,
  "admin/get-table-stats": getTableStats,
  "admin/captcha/current": captchaCurrent,
  "admin/captcha/save": captchaSave,
};

export const adminMiscHandlers: Record<string, AdminMiscHandler> = Object.fromEntries(Object.entries(RAW).map(([k, h]) => [k, pgOnly(h)]));

