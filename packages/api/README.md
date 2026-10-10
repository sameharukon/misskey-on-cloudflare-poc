# api (`misskey-cf-api`)

The Misskey backend, reached only through the gateway (service binding) and other Workers.

- **API**: every upstream endpoint (`POST /api/<endpoint>`) through the handler table in `src/router.ts`, with upstream's parameter validation, rate limits (`RateLimiter` Durable Object) and error shapes. Per-endpoint status: [API-COMPAT.md](./API-COMPAT.md), generated from `compat-notes/*.json` by `pnpm gen-api-compat`.
- **Streaming**: authenticates `/streaming` and hands the socket to the user's `StreamHub` (stream Worker).
- **ActivityPub**: actor / note / collection routes, WebFinger and NodeInfo, the inbox (verified and processed from `mk-inbox`), signed delivery (`mk-deliver`), relays.
- **Drive and media**: R2 storage, `/files`, the media proxy (`/proxy`), thumbnails through the media Worker.
- **Queues consumed**: `mk-inbox`, `mk-deliver`, `mk-webhook-deliver`, `mk-jobs` (account deletion, imports / exports, remote files, push, mail and other jobs, one step per message).
- **Durable Objects**: `RateLimiter`, `PollTimer` (poll endings and scheduled notes), `OnceGuard`, `Reversi`.
- **Cron** (hourly): expired mutes, overdue scheduled notes, moderator inactivity, daily cleanups.
- `ApiInternal` (`src/worker.ts`) is the RPC entrypoint other Workers call.

PostgreSQL is reached through Hyperdrive with one connection per request (`packages/db`).
