/**
 * Tests only: an in-memory Durable Object storage with the KV API (get / put / delete / list,
 * alarms) and `sql.exec` backed by Node's `node:sqlite`, like a SQLite-backed DO.
 */
import { DatabaseSync } from "node:sqlite";

type Row = Record<string, unknown>;

export type TestSqlCursor = { toArray(): Row[]; one(): Row; [Symbol.iterator](): Iterator<Row> };

export type TestDoStorage = {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string | string[]): Promise<boolean | number>;
  list<T = unknown>(opts?: { prefix?: string }): Promise<Map<string, T>>;
  getAlarm(): Promise<number | null>;
  setAlarm(t: number): Promise<void>;
  deleteAlarm(): Promise<void>;
  sql: { exec(query: string, ...bindings: unknown[]): TestSqlCursor };
  /** the raw KV map, for assertions */
  kv: Map<string, unknown>;
};

export function testDoStorage(): TestDoStorage {
  const kv = new Map<string, unknown>();
  let db: DatabaseSync | null = null;
  let alarm: number | null = null;
  return {
    kv,
    async get<T>(key: string) {
      return structuredClone(kv.get(key)) as T | undefined;
    },
    async put(key, value) {
      kv.set(key, structuredClone(value));
    },
    async delete(key) {
      if (Array.isArray(key)) return key.filter((k) => kv.delete(k)).length;
      return kv.delete(key);
    },
    async list<T>(opts: { prefix?: string } = {}) {
      const out = new Map<string, T>();
      for (const k of [...kv.keys()].sort()) if (!opts.prefix || k.startsWith(opts.prefix)) out.set(k, structuredClone(kv.get(k)) as T);
      return out;
    },
    async getAlarm() {
      return alarm;
    },
    async setAlarm(t) {
      alarm = t;
    },
    async deleteAlarm() {
      alarm = null;
    },
    sql: {
      exec(query, ...bindings) {
        db ??= new DatabaseSync(":memory:");
        const params = bindings.map((b) => (b === undefined ? null : typeof b === "boolean" ? Number(b) : b)) as (string | number | null)[];
        const rows = db.prepare(query).all(...params) as Row[];
        return {
          toArray: () => rows,
          one: () => {
            if (rows.length !== 1) throw new Error(`Expected exactly one result from SQL query, got ${rows.length}`);
            return rows[0]!;
          },
          [Symbol.iterator]: () => rows[Symbol.iterator](),
        };
      },
    },
  };
}
