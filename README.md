# misskey-cf

A rewrite of the Misskey backend for the Cloudflare stack (Workers, Durable Objects, Queues, R2, Containers), keeping PostgreSQL. It serves upstream Misskey's web client, API, streaming and ActivityPub with the same database schema, and drops NestJS, Redis, BullMQ and Meilisearch.

> **Experimental proof of concept.** The test suite passes, but misskey-cf is not optimized for production use and its compatibility with future Misskey releases is not maintained or guaranteed. If you consider running it, fork it and take over its maintenance.

Licensed under [AGPL-3.0](./LICENSE); see [COPYING](./COPYING) for the copyright notices (Misskey and the bundled third-party code).

## Compatibility

What ordinary users or third-party clients can observe stays compatible with upstream Misskey; what they cannot (admin features, infrastructure) may be changed to fit Cloudflare.

| Area | Policy |
|---|---|
| User-facing API and streaming | Strictly compatible. Third-party clients (Miria and others) must keep working |
| Web client | Upstream's, built from the pinned commit and served as-is |
| ActivityPub | Federates in the same format as upstream |
| Database | The same PostgreSQL schema; upstream's migrations are authoritative and Workers never issue DDL. Cloudflare D1 cannot be used |
| IDs | aidx, as upstream. Never change the scheme on an existing database |
| Admin API and admin UI | May be optimized, changed or removed where third-party clients do not use them |
| Infrastructure-specific features | S3, SMTP and job-queue settings may be changed or removed |
| New features | Not added, as a rule |

Per-endpoint status: [packages/api/API-COMPAT.md](./packages/api/API-COMPAT.md) (generated, see below).

Main differences from upstream:

| Item | misskey-cf |
|---|---|
| Full-text search | SQL substring match only (`LIKE` / `ILIKE`). On a large database consider `pg_trgm` GIN indexes on `lower(note.text)`, `"user".name` and `user_profile.description` (not for terms under 3 characters) |
| Charts | Computed from the source tables on request; decrements and event-based series (federation, requests) are 0 |
| Rankings, timelines | Same results from PostgreSQL queries instead of Redis; timeline length caps are not reproduced |
| Settings changes | Reach other isolates up to 30 seconds later |
| Upload limit | 100 MB by default (the zone plan's request body limit) |
| Mail | Cloudflare Email Service; SMTP settings are not used |
| Sensitive-media detection, reaction buffering | Not available |
| Job queue admin UI | Failed and delayed jobs only |
| Admin settings with no effect | Shown as "未対応" (unsupported) and read-only in the admin UI |
| Server info | Fixed machine values |
| Initial setup | `SETUP_PASSWORD` is required |

## Architecture

Only the gateway is public; the other Workers are reached through service bindings, Durable Objects and Queues.

| Worker | Role |
|---|---|
| [gateway](./packages/gateway) | Public entry: web client assets, HTML (SSR / OGP), forwards API, streaming, ActivityPub and media to api |
| [api](./packages/api) | Every API endpoint, ActivityPub in and out, drive, mail, Web Push, queue consumers, hourly cron |
| [timeline](./packages/timeline) | Timeline fanout consumer (streaming, antennas, roles), notifications, queue stats |
| [stream](./packages/stream) | Per-user WebSocket hub, presence shards, note subscriptions |
| [media](./packages/media) | Routes to the sharp / ffmpeg [media-container](./packages/media-container) instances |

What replaces Redis and BullMQ:

| Upstream | misskey-cf |
|---|---|
| Caches (meta, roles, ...) | Per-isolate memory with short lifetimes, KV; no cross-process invalidation |
| Streaming pub/sub | Direct calls to a per-user Durable Object |
| Home / list / channel timelines | PostgreSQL queries returning the same results |
| Antenna / role timelines, notifications, rate limits | Durable Objects |
| AP delivery and inbox, webhooks, long jobs | Queues (long jobs one step per message) |
| Poll endings, scheduled notes | Durable Object alarms |
| Repeatable jobs | Cron Trigger |
| Chart recording | None (computed on request) |

### Workers constraints

| Constraint | Approach |
|---|---|
| No long-lived process or cross-isolate pub/sub | Shared state lives in Durable Objects, KV or PostgreSQL; rarely changing data is cached briefly |
| CPU, subrequest and 128 MB memory limits | Long jobs re-enqueue their next step; the upload limit defaults to 100 MB |
| Queue delays of at most 12 hours | Scheduled notes and poll endings use Durable Object alarms |
| Workers cannot list or delete queue messages | Failed / delayed jobs are recorded in a Durable Object for the admin UI |
| No DNS and no peer IP | SSRF checks by host name on every redirect |
| No SMTP, no native modules | Email Service; sharp / ffmpeg run in Containers (uploads still succeed without them) |
| PostgreSQL through Hyperdrive | One connection per request; Hyperdrive's query cache is disabled; Workers placed near the database |
| Cross-Worker Durable Object bindings | Deploy in order: stream → timeline → media → api → gateway |
| workers.dev URLs | Disabled; only the gateway's custom domain is public |

## Repository layout

```
packages/
  gateway/ api/ timeline/ stream/ media/   # Workers (each has a README)
  media-container/   # Docker image: sharp + ffmpeg
  db/                # Hyperdrive scope, migrations, generated types
  packers/           # Note / User / Meta packers
  ap/                # ActivityPub, HTTP Signatures
  id/                # aidx IDs
  shared/            # Code shared by the Workers (shards, DO RPC types, queue jobs, ops stats)
  contract-tests/    # misskey-js type contracts
  misskey-js-types/  # upstream misskey-js generated types
upstream/misskey/    # Misskey submodule (pinned)
scripts/             # upstream sync, code generation, frontend build, deploy
```

## Development

There is intentionally no CI in the repository; run the checks locally.

| Command | Purpose |
|---|---|
| `pnpm test` | Unit tests of all packages (PGlite and in-memory Durable Objects) |
| `pnpm typecheck` | Type check |
| `pnpm sync-upstream` | Generated files and bundled migrations match the upstream pin |
| `pnpm check-endpoints` | Every upstream endpoint has a handler |
| `pnpm gen-api-compat` (`--check`) | Regenerate (or check) `packages/api/API-COMPAT.md` from `packages/api/compat-notes/*.json`; every entry that is not "compatible" needs a `summaryEn` |
| `node scripts/gen-disposable-domains.mjs` (`--check`) | Regenerate (or check) `packages/api/src/disposable-domains.txt` after updating `disposable-email-domains` (`pnpm test` also checks it) |

- Do not commit secrets (`.dev.vars` / `.env` are ignored).
- No TypeORM in Workers. New queries use Kysely (types generated from the migrations).

### Upstream

```bash
git submodule update --init upstream/misskey
pnpm sync-upstream && pnpm check-endpoints && pnpm test
```

Advance the submodule pin, review, and regenerate the endpoint definitions and migrations.

### Database migrations

Upstream's migrations are bundled as SQL in `packages/db/migrations/`; applying them needs neither the submodule nor TypeORM. They use TypeORM's `migrations` table, so a database migrated by upstream can be carried over either way.

```bash
DATABASE_URL='postgres://…' pnpm db:migrate up    # also: status / sql
```

## Deployment

- Create the queues once: `wrangler queues create mk-webhook-deliver`, `wrangler queues create mk-jobs` (and the others named in the `wrangler.toml` files).
- `pnpm deploy:all` deploys stream → timeline → media → api → gateway. Bindings are defined in each `packages/*/wrangler.toml`.
- The committed `wrangler.toml` files hold placeholders (`__MISSKEY_CF_*__`) instead of deployment-specific values. `pnpm deploy:all` fills them from the environment into `packages/*/wrangler.deploy.toml` (git-ignored, removed afterwards) and refuses to deploy anything when a variable is missing:

  | Variable | Value |
  |---|---|
  | `MISSKEY_CF_DOMAIN` | The instance's host name (the gateway's custom domain), e.g. `misskey.example.com` |
  | `MISSKEY_CF_HYPERDRIVE_ID` | Hyperdrive configuration id (api, timeline) |
  | `MISSKEY_CF_META_CACHE_KV_ID` | KV namespace id of `META_CACHE` (api) |
  | `MISSKEY_CF_ACCOUNT_ID` | Cloudflare account id of the media container image registry (defaults to `CLOUDFLARE_ACCOUNT_ID`) |

  Running `wrangler dev` or `wrangler deploy` on a single package needs the same values filled in by hand.
- Replace `FORK_REPOSITORY_URL` in `packages/api/src/meta-defaults.ts` with your fork's URL (or set the repository URL in the admin settings): AGPL-3.0 §13 requires offering the modified source to the instance's users.
- Database migrations are not applied automatically; apply them before deploying a schema change.

### Web client build (kept in R2)

The web client (`packages/gateway/public`) is built from the upstream pin plus `scripts/frontend-patches/` and stored in the R2 bucket `misskey-cf-build` (`MISSKEY_CF_BUILD_BUCKET`), keyed by `scripts/frontend-stamp.sh`. Create the bucket once with `wrangler r2 bucket create misskey-cf-build`. After changing the pin or the patches, before merging to main:

```bash
pnpm build-frontend    # with the embed client (do not set MISSKEY_CF_SKIP_EMBED)
pnpm frontend:upload
```

`pnpm deploy:all` refuses to deploy anything when the build for the commit is missing.

### Automatic deploys (Workers Builds)

Connect Workers Builds to the gateway (`misskey-cf-gateway`) only; its deploy command deploys all five Workers in order.

| Setting | Value |
|---|---|
| Repository / branch | this repository / `main` |
| Root directory | `/` |
| Build variables | `SKIP_DEPENDENCY_INSTALL=1`, `PNPM_VERSION=9.15.0` (as `packageManager`), and the `MISSKEY_CF_*` variables above |
| Build command | `pnpm install --frozen-lockfile` |
| Deploy command | `pnpm deploy:all` |
| Non-production branch builds | Off |

- The API token Workers Builds creates covers all five Workers (Queues, Hyperdrive, Containers) and the R2 build bucket.
- Update dependencies (`wrangler` is pinned exactly) in a dedicated PR with `pnpm-lock.yaml`.
- The submodule is not checked out there; the pin is read from the git tree.
