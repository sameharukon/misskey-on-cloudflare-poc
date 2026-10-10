/**
 * `pnpm db:migrate <command>` — apply the vendored Misskey schema migrations (packages/db/migrations)
 * without the upstream submodule or TypeORM. See README.md "DB migration".
 *
 *   status              list applied / pending migrations         (needs DATABASE_URL)
 *   up [--allow-unknown] apply every pending migration            (needs DATABASE_URL)
 *   sql [--after NAME]  print a re-runnable SQL script to stdout   (no database access)
 */
import pg from "pg";
import { appliedMigrations, loadMigrations, migrate, planMigrations, renderMigrationScript, type Migration } from "../src/migrate.js";

const [command = "status", ...rest] = process.argv.slice(2);

function usage(code: number): never {
  console.error("usage: pnpm db:migrate status | up [--allow-unknown] | sql [--after <name>]");
  process.exit(code);
}

async function withClient<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set (postgres://user:pass@host:5432/db; add ?sslmode=require for hosted Postgres)");
    process.exit(2);
  }
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

const all = loadMigrations();

try {
  switch (command) {
    case "status": {
      await withClient(async (client) => {
        const plan = planMigrations(all, await appliedMigrations(client));
        console.log(`vendored: ${all.length}  applied: ${plan.applied.length}  pending: ${plan.pending.length}`);
        const last = plan.applied[plan.applied.length - 1];
        if (last) console.log(`last applied: ${last.name}`);
        for (const m of plan.pending) console.log(`  pending  ${m.name}${plan.outOfOrder.includes(m) ? "  (older than the last applied)" : ""}`);
        for (const a of plan.unknown) console.log(`  unknown  ${a.name}  (applied, not in packages/db/migrations)`);
        if (plan.unknown.length > 0) process.exitCode = 1;
      });
      break;
    }
    case "up": {
      const allowUnknown = rest.includes("--allow-unknown");
      await withClient(async (client) => {
        const done = await migrate(client, all, {
          allowUnknown,
          onApply: (m) => console.log(`applying ${m.name}`),
        });
        console.log(done.length === 0 ? "nothing to apply" : `applied ${done.length} migration(s)`);
      });
      break;
    }
    case "sql": {
      let list: Migration[] = all;
      const i = rest.indexOf("--after");
      if (i >= 0) {
        const name = rest[i + 1];
        const at = all.findIndex((m) => m.name === name);
        if (!name || at < 0) {
          console.error(`unknown migration: ${name ?? "(missing)"}`);
          process.exit(2);
        }
        list = all.slice(at + 1);
      }
      process.stdout.write(renderMigrationScript(list));
      break;
    }
    default:
      usage(command === "help" || command === "--help" ? 0 : 2);
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}
