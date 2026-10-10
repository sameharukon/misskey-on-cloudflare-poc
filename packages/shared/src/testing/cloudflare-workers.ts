/**
 * Tests only: a stand-in for the `cloudflare:workers` module under Node (scripts/test-hooks.mjs
 * resolves the specifier here). The runtime classes only keep `ctx` / `env`, which is all the
 * Durable Object and entrypoint classes read from their base class.
 */

export class DurableObject<Env = unknown> {
  constructor(
    readonly ctx: unknown,
    readonly env: Env,
  ) {}
}

export class WorkerEntrypoint<Env = unknown> {
  constructor(
    readonly ctx: unknown,
    readonly env: Env,
  ) {}
}
