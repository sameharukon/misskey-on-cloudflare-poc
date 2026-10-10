/**
 * Shared PGlite fixture for the API tests: the real schema (every vendored upstream migration,
 * as `pnpm db:migrate` applies it), three users (a, b, c) with native tokens, and a `call()` that
 * goes through the router's call gate and the real handler table.
 */
import { ENDPOINT_PARAM_DEFS } from "./endpoint-params.gen.js";
import { validateParams, type ParamSchema } from "./param-validate.js";
import { INVALID_PARAM } from "./errors.js";
import { PGlite } from "@electric-sql/pglite";
import { genAidx } from "../../id/src/index.js";
import { fixtureMeta } from "../../packers/src/fixtures.js";
import type { ApiEnv } from "./env.js";
import { runWithPgScope, type PgQueryable } from "./pg.js";
import { handlers } from "./endpoints/index.js";
import { testDoStorage, type TestDoStorage } from "../../shared/src/test-do-storage.js";
import { rpcStub } from "../../shared/src/testing/do-namespace.js";
import { loadMigrations, migrate } from "../../db/src/migrate.js";
import { NotificationBox } from "../../timeline/src/index.js";

/** The real schema: every vendored upstream migration (packages/db/migrations). */
export async function applyMigrations(db: PGlite): Promise<void> {
  await migrate(
    {
      async query(text, params) {
        if (params === undefined) {
          const rs = await db.exec(text);
          return { rows: (rs[rs.length - 1]?.rows ?? []) as Record<string, unknown>[] };
        }
        return { rows: (await db.query<Record<string, unknown>>(text, params)).rows };
      },
    },
    loadMigrations(),
  );
}


/**
 * A fetch that answers DNS-over-HTTPS MX queries (deep-email-validator's MX check, email.ts):
 * every domain has an MX except those in `noMx`. Other requests go to `next` (404 without it).
 */
export function withDohMx(next?: typeof fetch, noMx: string[] = []): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(input));
    if (u.origin + u.pathname === "https://cloudflare-dns.com/dns-query") {
      const name = u.searchParams.get("name") ?? "";
      const has = !noMx.includes(name);
      return Response.json({ Status: has ? 0 : 3, Answer: has ? [{ name, type: 15, TTL: 300, data: `10 mx.${name}.` }] : undefined });
    }
    return next ? next(input, init) : new Response("not found", { status: 404 });
  }) as typeof fetch;
}

/** Fake Durable Object namespace: one instance of `make(name)` per name, kept in memory. */
export function fakeDoNamespace<T extends object>(make: (state: { id: { toString(): string }; storage: TestDoStorage }) => T) {
  const inst = new Map<string, T>();
  return {
    idFromName: (n: string) => ({ toString: () => n }),
    get(id: { toString(): string }) {
      const name = id.toString();
      if (!inst.has(name)) {
        inst.set(name, make({ id: { toString: () => name }, storage: testDoStorage() }));
      }
      return rpcStub(inst.get(name)!);
    },
  };
}

export const TOK = { a: "aaaaaaaaaaaaaaaa", b: "bbbbbbbbbbbbbbbb", c: "cccccccccccccccc" };
export type Who = keyof typeof TOK;

export type Fixture = {
  db: PGlite;
  env: ApiEnv;
  ids: Record<Who, string>;
  call(name: string, body: Record<string, unknown>, who?: Who): Promise<{ status: number; data: any }>;
  /** Insert a note row directly (returns its id). */
  note(userId: string, fields?: Record<string, unknown>): Promise<string>;
  /** Assign the user a priority-2 role that pins one policy value (replaces an earlier one for the same key). */
  setPolicy(userId: string, key: string, value: unknown): Promise<void>;
};

let seq = 0;
const policyRoles = new Map<string, string>();

export async function makeFixture(name: string, extraEnv: Partial<ApiEnv> = {}): Promise<Fixture> {
  const db = new PGlite();
  const client: PgQueryable = {
    async query(text, params = []) {
      const r = await db.query(text, params as unknown[]);
      return { rows: r.rows as Record<string, unknown>[], rowCount: r.affectedRows ?? r.rows.length };
    },
  };
  const env: ApiEnv = {
    INSTANCE_URL: "https://misskey.example.com",
    BOOTSTRAP_META_JSON: JSON.stringify(fixtureMeta({ name })),
    HYPERDRIVE: { connectionString: "postgres://test", __testClient: client } as unknown as ApiEnv["HYPERDRIVE"],
    // the real NotificationBox on in-memory storage (notifications live only in that DO)
    NOTIFICATION_BOX: fakeDoNamespace((st) => new NotificationBox(st as never)) as unknown as ApiEnv["NOTIFICATION_BOX"],
    ...extraEnv,
  };
  const base = Date.now() - 1_000_000;
  const ids = { a: genAidx(base), b: genAidx(base + 1000), c: genAidx(base + 2000) } as Record<Who, string>;
  await applyMigrations(db);
  for (const [k, id] of Object.entries(ids)) {
    await db.query(`INSERT INTO "user" (id, username, "usernameLower", token) VALUES ($1, $2, $3, $4)`, [id, `user_${k}`, `user_${k}`, TOK[k as Who]]);
    await db.query(`INSERT INTO user_profile ("userId") VALUES ($1)`, [id]);
  }
  await db.query(`INSERT INTO meta (id, "rootUserId") VALUES ('x', $1)`, [ids.a]);
  const callInScope: Fixture["call"] = async (endpoint, body, who) => {
    const b: Record<string, unknown> = who ? { ...body, i: TOK[who] } : { ...body };
    // the router's call gate (upstream ApiCallService order: auth → secure → rate limit →
    // credential → moved → roles → app permission → paramDef validation), then the handler;
    // an exception from the handler is an INTERNAL_ERROR
    const request = new Request("https://api.test/api/" + endpoint, { method: "POST" });
    const { callGate } = await import("./router.js");
    const refused = await callGate(env, endpoint, request, b);
    if (refused) return { status: refused.status, data: refused.status === 204 || !refused.headers.get("content-type") ? null : await refused.json() };
    let r: unknown;
    try {
      r = await handlers[endpoint]!(env, b, { hasCredential: Boolean(who), request });
    } catch (e) {
      return { status: 500, data: { error: { code: "INTERNAL_ERROR", message: e instanceof Error ? e.message : String(e) } } };
    }
    if (r instanceof Response) return { status: r.status, data: r.status === 204 ? null : await r.json() };
    return { status: 200, data: r };
  };
  return {
    db,
    env,
    ids,
    call(endpoint, body, who) {
      // one request scope per call, as the Worker's fetch handler (pg.ts runWithPgScope)
      return runWithPgScope(() => callInScope(endpoint, body, who));
    },
    async note(userId, fields = {}) {
      const id = genAidx(Date.now() + seq++);
      // note.visibility is NOT NULL without a default in the real schema
      const row = { visibility: "public", ...fields };
      const cols = ["id", "userId", ...Object.keys(row)];
      const vals = [id, userId, ...Object.values(row)];
      await db.query(`INSERT INTO note (${cols.map((c) => `"${c}"`).join(", ")}) VALUES (${vals.map((_, i) => `$${i + 1}`).join(", ")})`, vals);
      return id;
    },
    async setPolicy(userId, key, value) {
      // role ids are varchar(32): one short id per (user, policy key)
      const roleId = policyRoles.get(`${userId}:${key}`) ?? `pr${policyRoles.size}`;
      policyRoles.set(`${userId}:${key}`, roleId);
      await db.query(`DELETE FROM role_assignment WHERE "roleId" = $1`, [roleId]);
      await db.query(`DELETE FROM role WHERE id = $1`, [roleId]);
      await db.query(`INSERT INTO role (id, name, description, policies, "updatedAt", "lastUsedAt") VALUES ($1, $1, '', $2::jsonb, now(), now())`, [roleId, JSON.stringify({ [key]: { useDefault: false, priority: 2, value } })]);
      await db.query(`INSERT INTO role_assignment (id, "userId", "roleId") VALUES ($1, $2, $1)`, [roleId, userId]);
    },
  };
}
