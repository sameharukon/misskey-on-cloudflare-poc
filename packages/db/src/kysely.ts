/**
 * Kysely over an already-open Postgres client (a `pg` Client from Hyperdrive, or PGlite in
 * tests). One Kysely instance per client: it never opens or pools connections itself, so it
 * fits `withHyperdriveClient` (one client per request) on Workers.
 *
 * Column types come from schema.gen.ts (generated from the vendored migrations). PostgreSQL
 * only — the schema relies on jsonb, arrays and enums, so D1 / SQLite is not a target.
 */
import {
  CompiledQuery,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type DatabaseConnection,
  type Dialect,
  type Driver,
  type QueryResult,
  type TransactionSettings,
} from "kysely";
import type { DB } from "./schema.gen.js";

/** `pg` Client / PoolClient, or any wrapper with the same `query` shape. */
export type PgQueryable = {
  query: (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[]; rowCount?: number | null }>;
};

class QueryableConnection implements DatabaseConnection {
  constructor(private readonly client: PgQueryable) {}

  async executeQuery<R>(q: CompiledQuery): Promise<QueryResult<R>> {
    const r = await this.client.query(q.sql, [...q.parameters]);
    return {
      rows: r.rows as R[],
      ...(r.rowCount != null && q.query.kind !== "SelectQueryNode" ? { numAffectedRows: BigInt(r.rowCount) } : {}),
    };
  }

  // eslint-disable-next-line require-yield
  async *streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
    throw new Error("kysely: streaming is not supported over a single Hyperdrive client");
  }
}

class QueryableDriver implements Driver {
  private readonly connection: QueryableConnection;

  constructor(client: PgQueryable) {
    this.connection = new QueryableConnection(client);
  }

  async init(): Promise<void> {}
  async acquireConnection(): Promise<DatabaseConnection> {
    return this.connection;
  }
  async beginTransaction(conn: DatabaseConnection, settings: TransactionSettings): Promise<void> {
    const mode = [
      settings.isolationLevel ? `isolation level ${settings.isolationLevel}` : "",
      settings.accessMode ?? "",
    ].filter(Boolean);
    await conn.executeQuery(CompiledQuery.raw(mode.length > 0 ? `start transaction ${mode.join(", ")}` : "begin"));
  }
  async commitTransaction(conn: DatabaseConnection): Promise<void> {
    await conn.executeQuery(CompiledQuery.raw("commit"));
  }
  async rollbackTransaction(conn: DatabaseConnection): Promise<void> {
    await conn.executeQuery(CompiledQuery.raw("rollback"));
  }
  async releaseConnection(): Promise<void> {}
  async destroy(): Promise<void> {}
}

class QueryableDialect implements Dialect {
  constructor(private readonly client: PgQueryable) {}
  createAdapter() {
    return new PostgresAdapter();
  }
  createDriver() {
    return new QueryableDriver(this.client);
  }
  createQueryCompiler() {
    return new PostgresQueryCompiler();
  }
  createIntrospector(db: Kysely<unknown>) {
    return new PostgresIntrospector(db);
  }
}

export type Db = Kysely<DB>;

/** Typed query builder over `client`. Cheap; create one per client. */
export function createKysely(client: PgQueryable): Db {
  return new Kysely<DB>({ dialect: new QueryableDialect(client) });
}

/** jsonb values are written as JSON text (`pg` would turn a JS array into a Postgres array). */
export function jsonb(value: unknown): string {
  return JSON.stringify(value);
}
