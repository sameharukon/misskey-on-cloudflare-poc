# shared

Code used by more than one Worker:

- Shard helpers (timeline and stream shard names, `STREAM_SHARD_COUNT`).
- Durable Object RPC interfaces (`do-rpc.ts`) and in-memory Durable Object namespaces for tests (`testing/`).
- Queue job typing and retry limits (`queue-jobs.ts`), OpsStats recording (`ops.ts`).
- The edge cache wrapper (`edge-cache.ts`).
