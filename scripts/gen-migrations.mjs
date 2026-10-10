#!/usr/bin/env node
/**
 * Vendor the pinned upstream TypeORM migrations as plain SQL into packages/db/migrations/,
 * so the schema can be created / upgraded with `pnpm db:migrate` without the upstream
 * submodule, its build, or TypeORM. Re-run after bumping upstream.
 *
 * Each upstream `migration/*.js` is imported and its `up()` is run against a recording
 * queryRunner: every statement is captured in order. SELECTs return no rows, so a migration
 * whose `up()` reads data (backfills, data conversions) cannot be captured faithfully — those
 * are listed in HANDLED below with hand-written SQL, and any other migration that issues a
 * SELECT or a parameterised statement fails the run until it is added there.
 *
 * Output: one `<timestamp>-<file>.sql` per migration, with a `-- name:` header holding the
 * TypeORM migration name (what `migrations.name` records).
 *
 * Usage: node scripts/gen-migrations.mjs [--check]
 *   --check: exit 1 when the committed files are stale.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const src = resolve(root, "upstream/misskey/packages/backend/migration");
const out = resolve(root, "packages/db/migrations");
const check = process.argv.includes("--check");

if (!existsSync(src)) {
  console.error("gen-migrations: upstream migrations not found (git submodule update --init upstream/misskey)");
  process.exit(2);
}

/**
 * Migrations whose `up()` depends on existing rows. `importable: false` = the module imports
 * packages from the upstream backend (not installed here), so it is not executed at all.
 * `sql(recorded)` returns the full statement list; `recorded` is what the recording run
 * captured (DDL only, since SELECTs returned nothing).
 */
const HANDLED = {
  // Rewrites user_profile.mutedWords with RE2 validation of /regex/ entries. Not expressible
  // in SQL; refuse on a database that has local mute words to convert.
  convertHardMutes1644010796173: {
    importable: false,
    sql: () => [
      `DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM "user_profile" WHERE "userHost" IS NULL AND "mutedWords" <> '[]'::jsonb) THEN
    RAISE EXCEPTION 'convertHardMutes1644010796173 needs to convert existing mute words: run upstream Misskey''s migrations up to this one first';
  END IF;
END $$`,
    ],
  },
  // Normalises instance/meta themeColor with tinycolor2. Same treatment.
  uniformThemecolor1652859567549: {
    importable: false,
    sql: () => [
      `DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM "instance" WHERE "themeColor" IS NOT NULL) OR EXISTS (SELECT 1 FROM "meta" WHERE "themeColor" IS NOT NULL) THEN
    RAISE EXCEPTION 'uniformThemecolor1652859567549 needs to normalise existing theme colors: run upstream Misskey''s migrations up to this one first';
  END IF;
END $$`,
    ],
  },
  // Backfills user_list_membership.userListUserId from user_list.userId.
  UserListUserId1696807733453: {
    sql: (recorded) => [
      ...recorded,
      `UPDATE "user_list_membership" SET "userListUserId" = "user_list"."userId" FROM "user_list" WHERE "user_list"."id" = "user_list_membership"."userListId"`,
    ],
  },
  // Registers the existing instance.actor / relay.actor users as system accounts. (The
  // upstream proxy-account branch is unreachable: `!meta && …` is never true.)
  SystemAccounts1740121393164: {
    sql: (recorded) => [
      ...recorded,
      `INSERT INTO "system_account" ("id", "userId", "type") SELECT "id", "id", 'actor' FROM "user" WHERE "username" = 'instance.actor' ORDER BY "host" IS NULL DESC LIMIT 1`,
      `INSERT INTO "system_account" ("id", "userId", "type") SELECT "id", "id", 'relay' FROM "user" WHERE "username" = 'relay.actor' ORDER BY "host" IS NULL DESC LIMIT 1`,
    ],
  },
  // Copies the root user into meta.rootUserId.
  SystemAccounts31740133121105: {
    sql: (recorded) => [
      ...recorded,
      `UPDATE "meta" SET "rootUserId" = (SELECT "id" FROM "user" WHERE "isRoot" = true LIMIT 1) WHERE EXISTS (SELECT 1 FROM "user" WHERE "isRoot" = true)`,
    ],
  },
  // Points the actor / relay system accounts at the local users of that name.
  SystemAccounts1741279404074: {
    sql: (recorded) => [
      ...recorded,
      ...["actor:instance.actor", "relay:relay.actor"].map((pair) => {
        const [type, username] = pair.split(":");
        return `UPDATE "system_account" SET "id" = "u"."id", "userId" = "u"."id" FROM (SELECT "id" FROM "user" WHERE "username" = '${username}' AND "host" IS NULL AND "id" NOT IN (SELECT "userId" FROM "system_account" WHERE "type" = '${type}') LIMIT 1) AS "u" WHERE "system_account"."type" = '${type}'`;
      }),
    ],
  },
};

/** TypeORM: `migration.name || migration.constructor.name`, timestamp = last 13 digits. */
function typeormName(Cls) {
  const inst = new Cls();
  return inst.name || Cls.name;
}

async function record(file) {
  const mod = await import(pathToFileURL(resolve(src, file)).href);
  const classes = Object.values(mod).filter((v) => typeof v === "function");
  if (classes.length !== 1) throw new Error(`gen-migrations: ${file} exports ${classes.length} classes`);
  const name = typeormName(classes[0]);
  const statements = [];
  const selects = [];
  const queryRunner = {
    async query(sql, params) {
      if (/^\s*SELECT\b/i.test(sql)) {
        selects.push(sql);
        return [];
      }
      if (params !== undefined && params.length > 0) throw new Error(`gen-migrations: ${name} runs a parameterised statement; add it to HANDLED`);
      statements.push(sql);
      return [];
    },
    get connection() {
      throw new Error(`gen-migrations: ${name} uses queryRunner.connection; add it to HANDLED`);
    },
  };
  await new classes[0]().up(queryRunner);
  return { name, statements, selects };
}

/** Class name declared in a module that is not imported (see HANDLED.importable). */
function declaredName(file) {
  const text = readFileSync(resolve(src, file), "utf8");
  const m = /name\s*=\s*['"]([A-Za-z0-9_]+)['"]/.exec(text) ?? /export class ([A-Za-z0-9_]+)/.exec(text);
  if (!m) throw new Error(`gen-migrations: cannot find the migration name in ${file}`);
  return m[1];
}

function render(file, name, statements) {
  const body = statements.map((s) => {
    const t = s.trim();
    return t.endsWith(";") ? t : `${t};`;
  });
  return [
    `-- Generated by scripts/gen-migrations.mjs from upstream packages/backend/migration/${file}. Do not edit.`,
    `-- name: ${name}`,
    "",
    ...body,
    "",
  ].join("\n");
}

const files = readdirSync(src).filter((f) => f.endsWith(".js")).sort();
const rendered = new Map();
const seen = new Map();
const used = new Set();
for (const file of files) {
  const stem = file.slice(0, -3);
  const declared = declaredName(file);
  const handled = HANDLED[declared];
  let name;
  let statements;
  if (handled && handled.importable === false) {
    name = declared;
    statements = handled.sql([]);
  } else {
    const r = await record(file);
    name = r.name;
    if (HANDLED[name]) statements = HANDLED[name].sql(r.statements);
    else if (r.selects.length > 0) throw new Error(`gen-migrations: ${name} reads rows during up(); add it to HANDLED:\n  ${r.selects.join("\n  ")}`);
    else statements = r.statements;
  }
  if (HANDLED[name]) used.add(name);
  if (!/\d{13}$/.test(name)) throw new Error(`gen-migrations: ${name} does not end in a 13-digit timestamp`);
  if (seen.has(name)) throw new Error(`gen-migrations: duplicate migration name ${name} (${seen.get(name)}, ${file})`);
  seen.set(name, file);
  rendered.set(`${stem}.sql`, render(file, name, statements));
}
for (const key of Object.keys(HANDLED)) {
  if (!used.has(key)) throw new Error(`gen-migrations: HANDLED.${key} matches no upstream migration`);
}

if (check) {
  const committed = existsSync(out) ? readdirSync(out).filter((f) => f.endsWith(".sql")) : [];
  const stale = [];
  for (const [f, text] of rendered) {
    const p = resolve(out, f);
    if (!existsSync(p) || readFileSync(p, "utf8") !== text) stale.push(f);
  }
  for (const f of committed) if (!rendered.has(f)) stale.push(`${f} (removed upstream)`);
  if (stale.length > 0) {
    console.error(`gen-migrations: packages/db/migrations is stale (${stale.length} file(s)):\n  ${stale.slice(0, 20).join("\n  ")}`);
    process.exit(1);
  }
  console.log(`gen-migrations: ${rendered.size} migrations up to date`);
} else {
  mkdirSync(out, { recursive: true });
  for (const f of readdirSync(out)) if (f.endsWith(".sql") && !rendered.has(f)) rmSync(resolve(out, f));
  for (const [f, text] of rendered) writeFileSync(resolve(out, f), text);
  console.log(`gen-migrations: wrote ${rendered.size} migrations to packages/db/migrations`);
}
