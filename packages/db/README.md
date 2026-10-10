# db

PostgreSQL access shared by the Workers.

- `src/hyperdrive.ts`: one `pg` connection per request (`runWithPgScope`), transactions, per-request memos and short-lived per-isolate caches invalidated by writes to their tables.
- `migrations/`: upstream's TypeORM migrations converted to SQL (`pnpm gen-migrations`); `pnpm db:migrate up | status | sql` applies them using TypeORM's `migrations` table.
- `src/schema.gen.ts`: table types generated from the migrations (`pnpm db:gen-types`), used by Kysely.
- `src/role-cond.ts`: role resolution and conditional-role evaluation (`RoleService.getUserRoles`).
