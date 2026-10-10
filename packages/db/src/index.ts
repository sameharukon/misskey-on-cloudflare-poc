/**
 * DB layer: Hyperdrive + typed row inventory.
 * Schema authority = upstream Misskey migrations, vendored as SQL in ../migrations and applied
 * with `pnpm db:migrate` (./migrate.ts, Node only). Workers never issue DDL.
 * Queries: Kysely over the request's pg client (./kysely.ts) with types generated from the
 * migrations (./schema.gen.ts). PostgreSQL only (no D1 / SQLite); no TypeORM on Workers.
 */

export { createKysely, jsonb, type Db, type PgQueryable } from "./kysely.js";
export type { DB } from "./schema.gen.js";
export type * as Schema from "./schema.gen.js";

export type { NoteRow, NoteVisibility, NoteReactionAcceptance } from "./tables/note.js";
export type { UserRow } from "./tables/user.js";
export type { MetaRow } from "./tables/meta.js";
export type {
  UserProfileRow,
  FollowingRow,
  BlockingRow,
  MutingRow,
  DriveFileRow,
  NotificationRow,
  EmojiRow,
  AccessTokenRow,
} from "./tables/supporting.js";

export type DbClient = {
  query: <T = unknown>(sql: string, params?: unknown[]) => Promise<T[]>;
};

/** Hyperdrive smoke — requires live binding (not available in unit tests). */
export async function smokeMeta(db: DbClient): Promise<unknown> {
  const rows = await db.query("SELECT id, name FROM meta LIMIT 1");
  return rows[0] ?? null;
}

export async function smokeNote(db: DbClient): Promise<unknown> {
  const rows = await db.query("SELECT id, \"userId\", visibility FROM note LIMIT 1");
  return rows[0] ?? null;
}
