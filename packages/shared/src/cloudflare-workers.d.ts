/** Minimal typing for the Workers runtime module (no @cloudflare/workers-types dependency). */
declare module "cloudflare:workers" {
  export abstract class WorkerEntrypoint<Env = unknown> {
    protected readonly ctx: { waitUntil(p: Promise<unknown>): void };
    protected readonly env: Env;
    constructor(ctx: unknown, env: Env);
  }

  /** Base class that makes a Durable Object's public methods callable over RPC from its stubs. */
  export abstract class DurableObject<Env = unknown> {
    protected readonly ctx: unknown;
    protected readonly env: Env;
    constructor(ctx: unknown, env: Env);
  }
}
