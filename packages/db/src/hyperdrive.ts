/**
 * Hyperdrive / pg helpers shared by the api and timeline Workers. Never log
 * connectionString.
 *
 * Request scope: inside `runWithPgScope` (the Worker's fetch / queue / scheduled entry points), every
 * `withHyperdriveClient` call shares one lazily opened connection, closed when the request and the
 * work it handed to `waitUntil` are done. Outside a scope (Durable Objects, tests) each call opens
 * and closes its own connection as before.
 *
 * Calls in a scope run on the same connection concurrently (pg queues the queries). A transaction
 * (`BEGIN` … `COMMIT` / `ROLLBACK`) holds the connection: queries from other callers wait until it
 * ends, so they never join it. A transaction's callback must therefore use its own client only and
 * not call helpers that open another `withHyperdriveClient`.
 */

import { AsyncLocalStorage } from "node:async_hooks";
/** A Hyperdrive binding (only its connection string is used). */
export type HyperdriveBinding = {
  connectionString: string;
};

export type PgQueryResult = { rows: Record<string, unknown>[]; rowCount: number | null };

export type PgQueryable = {
  query: (text: string, params?: unknown[]) => Promise<PgQueryResult>;
};

type RawClient = PgQueryable & { end(): Promise<void>; on?(event: "error", fn: (e: unknown) => void): unknown };

export type PgClientFactory = (connectionString: string) => Promise<RawClient>;

/**
 * pg's pipeline mode (pg 8.23+): queries issued while others are in flight go out at once instead
 * of each waiting for the previous answer, so independent queries started together (Promise.all)
 * cost one round trip. Off unless the Worker sets `PG_PIPELINE = "1"` (configurePg), until it is
 * confirmed to work through Hyperdrive. Transactions are unaffected: a scope holds the connection
 * for the transaction's owner (see PgScope).
 */
let pipeline = false;

/** Per-invocation settings from the Worker's env. */
export function configurePg(opts: { pipeline?: boolean }): void {
  pipeline = Boolean(opts.pipeline);
}

const defaultFactory: PgClientFactory = async (connectionString) => {
  const { Client } = await import("pg");
  const client = new Client({ connectionString, pipeline } as ConstructorParameters<typeof Client>[0]);
  await client.connect();
  return client as unknown as RawClient;
};

let clientFactory: PgClientFactory = defaultFactory;

/** Tests: replace how connections are opened (null restores `pg`). */
export function setPgClientFactoryForTest(factory: PgClientFactory | null): void {
  clientFactory = factory ?? defaultFactory;
}

const TX_BEGIN = /^\s*(BEGIN|START\s+TRANSACTION)\b/i;
const TX_END = /^\s*(COMMIT|ROLLBACK|END)\b/i;
const WRITE = /\b(INSERT\s+INTO|UPDATE\s+\S+\s+SET|DELETE\s+FROM|TRUNCATE)\b/i;

type Tx = { owner: Lease; ended: Promise<void>; end: () => void };

class PgScope {
  private conn: { connectionString: string; client: Promise<RawClient> } | null = null;
  private active = 0;
  private done = false;
  tx: Tx | null = null;
  /** Per-request reads, dropped on every write made through this scope. */
  readonly reads = new Map<string, Promise<unknown>>();
  /** Per-request values that writes do not invalidate (the caller's authentication). */
  readonly stable = new Map<string, Promise<unknown>>();

  async acquire(hd: HyperdriveBinding, injected: PgQueryable | undefined): Promise<Lease> {
    this.active++;
    try {
      if (injected) return new Lease(this, Promise.resolve(injected), cacheNamespace(hd));
      if (!this.conn || this.conn.connectionString !== hd.connectionString) {
        const client = clientFactory(hd.connectionString).then((c) => {
          c.on?.("error", () => {
            if (this.conn?.client === client) this.conn = null;
          });
          return c;
        });
        client.catch(() => {
          if (this.conn?.client === client) this.conn = null;
        });
        if (this.conn) void this.closeConn(this.conn.client);
        this.conn = { connectionString: hd.connectionString, client };
      }
      const client = this.conn.client;
      await client;
      return new Lease(this, client, cacheNamespace(hd));
    } catch (e) {
      await this.release();
      throw e;
    }
  }

  /** Keep the connection open while work outside a `withHyperdriveClient` call is pending. */
  hold(): void {
    this.active++;
  }

  async release(): Promise<void> {
    this.active--;
    if (this.active === 0 && this.done) await this.close();
  }

  async finish(): Promise<void> {
    this.done = true;
    if (this.active === 0) await this.close();
  }

  private async close(): Promise<void> {
    const conn = this.conn;
    this.conn = null;
    if (conn) await this.closeConn(conn.client);
  }

  private async closeConn(client: Promise<RawClient>): Promise<void> {
    try {
      await (await client).end();
    } catch {
      /* ignore */
    }
  }
}

/** One `withHyperdriveClient` call's view of the scope's shared connection. */
class Lease implements PgQueryable {
  constructor(
    private readonly scope: PgScope,
    private readonly client: Promise<PgQueryable>,
    /** isolate cache namespace (null: no isolate cache, e.g. offline tests) */
    readonly cacheNs: string | null,
  ) {}

  async query(text: string, params?: unknown[]): Promise<PgQueryResult> {
    const scope = this.scope;
    while (scope.tx && scope.tx.owner !== this) await scope.tx.ended;
    if (TX_BEGIN.test(text)) {
      let end!: () => void;
      const ended = new Promise<void>((r) => (end = r));
      scope.tx = { owner: this, ended, end };
    }
    let ok = false;
    try {
      const r = await (await this.client).query(text, params);
      ok = true;
      return r;
    } finally {
      if (TX_END.test(text) || (!ok && TX_BEGIN.test(text))) this.endTx();
      if (ok && WRITE.test(text)) {
        scope.reads.clear();
        invalidateOnWrite(this.cacheNs, text);
      }
    }
  }

  /** Called when the lease's callback returns: a transaction left open is rolled back. */
  async close(): Promise<void> {
    if (this.scope.tx?.owner !== this) return;
    try {
      await (await this.client).query("ROLLBACK");
    } catch {
      /* ignore */
    }
    this.endTx();
  }

  private endTx(): void {
    const tx = this.scope.tx;
    if (tx?.owner !== this) return;
    this.scope.tx = null;
    tx.end();
  }
}

// ---------------------------------------------------------------------------------------------
// Isolate cache: rarely changing rows shared by the requests of one isolate, for `ttlMs`.
// upstream keeps the same data in memory (MetaService, RoleService, the keypair cache) and clears
// it via Redis pub/sub; here a write through this isolate clears it at once and other isolates
// catch up within the TTL.

type CacheEntry = { at: number; value: Promise<unknown> };
const isolateCaches = new Map<string, Map<string, CacheEntry>>();

/** Tables whose writes clear isolate cache keys starting with `${table}:`. */
/** TTL of isolate-cached meta and role definitions. */
export const META_ISOLATE_TTL_MS = 30_000;

const CACHED_TABLES = /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM|TRUNCATE)\s+"?(meta|role|user_keypair|avatar_decoration)"?(?=[\s(;]|$)/i;

function cacheNamespace(hd: HyperdriveBinding): string | null {
  const t = hd as { __testClient?: unknown; __isolateCache?: boolean };
  // Offline tests share one connection string across fixtures and write rows directly
  if (t.__testClient && !t.__isolateCache) return null;
  return hd.connectionString;
}

function invalidateOnWrite(ns: string | null, text: string): void {
  if (ns == null) return;
  const m = CACHED_TABLES.exec(text);
  if (m) invalidateIsolateCache(ns, `${m[1]!.toLowerCase()}:`);
}

/** Drops cached keys starting with `prefix` (every namespace when `ns` is null). */
export function invalidateIsolateCache(ns: string | null, prefix: string): void {
  for (const [name, map] of isolateCaches) {
    if (ns != null && name !== ns) continue;
    for (const k of map.keys()) if (k.startsWith(prefix)) map.delete(k);
  }
}

/**
 * `load()` cached per isolate for `ttlMs` (keys must start with the table name, see
 * CACHED_TABLES). Only for connections handed out inside a request scope; others load directly.
 * `clone` hands every caller its own copy.
 */
export function isolateCached<T>(c: PgQueryable, key: string, ttlMs: number, load: () => Promise<T>, opts: { clone?: boolean } = {}): Promise<T> {
  const ns = c instanceof Lease ? c.cacheNs : null;
  if (ns == null) return load();
  let map = isolateCaches.get(ns);
  if (!map) isolateCaches.set(ns, (map = new Map()));
  const hit = map.get(key);
  let p: Promise<T>;
  if (hit && Date.now() - hit.at < ttlMs) {
    p = hit.value as Promise<T>;
  } else {
    const entry: CacheEntry = { at: Date.now(), value: load() };
    map.set(key, entry);
    entry.value.catch(() => {
      if (map!.get(key) === entry) map!.delete(key);
    });
    p = entry.value as Promise<T>;
  }
  return opts.clone ? p.then((v) => structuredClone(v)) : p;
}

const scopes = new AsyncLocalStorage<PgScope>();

/**
 * Runs `fn` with a request-scoped connection. The connection is closed once `fn` settles and
 * nothing in the scope still uses it; pass the request's `waitUntil` so closing (and calls made
 * from `waitUntil` work) does not hold the response.
 */
export async function runWithPgScope<T>(fn: () => Promise<T>, waitUntil?: (p: Promise<unknown>) => void): Promise<T> {
  const scope = new PgScope();
  try {
    return await scopes.run(scope, fn);
  } finally {
    const closing = scope.finish();
    if (waitUntil) waitUntil(closing);
    else await closing;
  }
}

/**
 * Work handed to `waitUntil` after the response (e.g. a note's notifications and deliveries):
 * the scope's connection stays open until `p` settles, so its queries do not reopen a connection
 * each. Returns `p` (no-op outside a scope).
 */
export function holdPgScope<T>(p: Promise<T>): Promise<T> {
  const scope = scopes.getStore();
  if (!scope) return p;
  scope.hold();
  return p.finally(() => scope.release());
}

/**
 * Memoizes `load` for the rest of the request (no-op outside a scope). `stable` values survive
 * writes; other values are dropped when the request writes through `withHyperdriveClient`.
 * `clone` hands every caller its own copy, for values callers may mutate.
 */
export function requestMemo<T>(key: string, load: () => Promise<T>, opts: { stable?: boolean; clone?: boolean } = {}): Promise<T> {
  const scope = scopes.getStore();
  if (!scope) return load();
  const map = opts.stable ? scope.stable : scope.reads;
  let p = map.get(key) as Promise<T> | undefined;
  if (!p) {
    const loading = load();
    p = loading;
    map.set(key, loading);
    loading.catch(() => {
      if (map.get(key) === loading) map.delete(key);
    });
  }
  return opts.clone ? p.then((v) => structuredClone(v)) : p;
}

export async function withHyperdriveClient<T>(
  hd: HyperdriveBinding | undefined,
  fn: (client: PgQueryable) => Promise<T>,
): Promise<T> {
  if (!hd || typeof hd.connectionString !== "string" || !hd.connectionString) {
    throw new Error("HYPERDRIVE_UNBOUND");
  }
  // Offline tests inject an in-process Postgres (PGlite); never set by a real binding.
  const injected = (hd as { __testClient?: PgQueryable }).__testClient;
  const scope = scopes.getStore();
  if (scope) {
    const lease = await scope.acquire(hd, injected);
    try {
      return await fn(lease);
    } finally {
      await lease.close();
      await scope.release();
    }
  }
  const ns = cacheNamespace(hd);
  const observe = (c: PgQueryable): PgQueryable => ({
    query: async (text, params) => {
      const r = await c.query(text, params);
      invalidateOnWrite(ns, text);
      return r;
    },
  });
  if (injected) return fn(observe(injected));
  const client = await clientFactory(hd.connectionString);
  try {
    return await fn(observe(client));
  } finally {
    try {
      await client.end();
    } catch {
      /* ignore */
    }
  }
}
