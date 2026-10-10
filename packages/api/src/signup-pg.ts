/**
 * Minimal local signup via Hyperdrive (admin/accounts/create / first root).
 * Mirrors SignupService essentials: user + keypair + profile + used_username + meta.rootUserId.
 */

import { genRsaPem } from "./ap/rsa.js";
import bcrypt from "bcryptjs";
import { genAidxFromDate } from "../../id/src/index.js";
import type { ApiEnv } from "./env.js";
import { withHyperdriveClient, type PgQueryable } from "./pg.js";
import { authenticateWithClient, type AuthUser } from "./auth-pg.js";
import { FORK_REPOSITORY_URL } from "./meta-defaults.js";

const USERNAME_RE = /^[a-zA-Z0-9_]{1,20}$/;

export function generateNativeUserToken(): string {
  const chars = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < 16; i++) out += chars[bytes[i]! % chars.length]!;
  return out;
}

function validateUsername(username: unknown): username is string {
  return typeof username === "string" && USERNAME_RE.test(username);
}

function validatePassword(password: unknown): boolean {
  return typeof password === "string" && password.length >= 1;
}

export type SignupResult =
  | {
      ok: true;
      user: AuthUser;
      secret: string;
      wasFirstRoot: boolean;
    }
  | { ok: false; code: string; message: string };

export async function signupLocal(
  client: PgQueryable,
  /** `passwordHash` (bcrypt) instead of `password`: signup-pending (upstream SignupService). */
  /**
   * `allowFirstRoot`: only the initial setup (admin/accounts/create with the setup password) may
   * create the first account, which becomes root. Every other signup is refused until then.
   */
  opts: { username: string; password?: string | null; passwordHash?: string | null; ignorePreserved?: boolean; allowFirstRoot?: boolean },
): Promise<SignupResult> {
  const username = opts.username;
  if (!validateUsername(username)) {
    return { ok: false, code: "INVALID_USERNAME", message: "Invalid username." };
  }
  // upstream: a password is validated and hashed only when given (no password → null hash)
  if (opts.password != null && opts.passwordHash == null && !validatePassword(opts.password)) {
    return { ok: false, code: "INVALID_PASSWORD", message: "Invalid password." };
  }

  // to_jsonb: tolerant of older / partial meta schemas
  const meta = (await client.query(`SELECT to_jsonb(m) AS j FROM meta m ORDER BY id DESC LIMIT 1`)).rows[0]?.j as Record<string, unknown> | undefined;
  const wasFirstRoot = meta == null || meta.rootUserId == null;
  if (wasFirstRoot && !opts.allowFirstRoot) {
    return { ok: false, code: "SETUP_REQUIRED", message: "The instance is not set up yet." };
  }

  const dup = await client.query(
    `SELECT id FROM "user" WHERE "usernameLower" = $1 AND host IS NULL LIMIT 1`,
    [username.toLowerCase()],
  );
  if (dup.rows[0]) {
    return { ok: false, code: "DUPLICATED_USERNAME", message: "Duplicated username." };
  }

  const used = await client.query(
    `SELECT username FROM used_username WHERE username = $1 LIMIT 1`,
    [username.toLowerCase()],
  );
  if (used.rows[0]) {
    return { ok: false, code: "USED_USERNAME", message: "Username is not available." };
  }

  // preserved usernames / prohibited words only once a root exists (upstream SignupService)
  if (!opts.ignorePreserved && !wasFirstRoot) {
    const preserved = ((meta?.preservedUsernames as string[] | undefined) ?? []).map((x) => x.toLowerCase());
    const prohibited = (meta?.prohibitedWordsForNameOfUser as string[] | undefined) ?? [];
    const { isKeyWordIncluded } = await import("./search-pg.js");
    if (preserved.includes(username.toLowerCase()) || isKeyWordIncluded(username.toLowerCase(), prohibited)) {
      return { ok: false, code: "USED_USERNAME", message: "Username is not available." };
    }
  }

  const secret = generateNativeUserToken();
  const passwordHash = opts.password != null && opts.passwordHash == null ? await bcrypt.hash(opts.password, await bcrypt.genSalt(8)) : (opts.passwordHash ?? null);
  const [publicKey, privateKey] = await genRsaPem();
  const id = genAidxFromDate(new Date());

  await client.query("BEGIN");
  try {
    await client.query(
      `INSERT INTO "user" (id, username, "usernameLower", token, host)
       VALUES ($1, $2, $3, $4, NULL)`,
      [id, username, username.toLowerCase(), secret],
    );
    await client.query(
      `INSERT INTO user_keypair ("userId", "publicKey", "privateKey")
       VALUES ($1, $2, $3)`,
      [id, publicKey, privateKey],
    );
    await client.query(
      `INSERT INTO user_profile ("userId", password, "autoAcceptFollowed")
       VALUES ($1, $2, TRUE)`,
      [id, passwordHash],
    );
    await client.query(
      `INSERT INTO used_username (username, "createdAt") VALUES ($1, now())`,
      [username.toLowerCase()],
    );
    if (wasFirstRoot) {
      // ensure meta row exists then set root
      const m = await client.query(`SELECT id FROM meta ORDER BY id DESC LIMIT 1`);
      if (!m.rows[0]) {
        await client.query(
          `INSERT INTO meta (id, name, "shortName", description, "repositoryUrl", federation, "disableRegistration", "rootUserId")
           VALUES ('x', 'misskey-cf', 'mk-cf', 'Misskey on Cloudflare Workers (staging)',
                   $2, 'none', TRUE, $1)`,
          [id, FORK_REPOSITORY_URL],
        );
      } else {
        await client.query(`UPDATE meta SET "rootUserId" = $1 WHERE id = $2`, [
          id,
          m.rows[0].id,
        ]);
      }
    }
    await client.query("COMMIT");
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* ignore */
    }
    return {
      ok: false,
      code: "SIGNUP_FAILED",
      message: e instanceof Error ? e.message : String(e),
    };
  }

  const auth = await authenticateWithClient(client, secret);
  if (!auth) {
    return { ok: false, code: "SIGNUP_FAILED", message: "User created but auth lookup failed." };
  }
  return { ok: true, user: auth.user, secret, wasFirstRoot };
}

export async function signupLocalViaHyperdrive(
  env: ApiEnv,
  opts: { username: string; password?: string | null; passwordHash?: string | null; ignorePreserved?: boolean; allowFirstRoot?: boolean },
): Promise<SignupResult> {
  if (!env.HYPERDRIVE?.connectionString) {
    return { ok: false, code: "HYPERDRIVE_UNBOUND", message: "Hyperdrive not bound." };
  }
  const result = await withHyperdriveClient(env.HYPERDRIVE, (c) => signupLocal(c, opts));
  if (result.ok) {
    // SignupService → UserService.notifySystemWebhook(account, 'userCreated')
    const { notifyUserCreatedSystemWebhook } = await import("./system-webhooks-pg.js");
    await notifyUserCreatedSystemWebhook(env, result.user.id);
  }
  return result;
}
