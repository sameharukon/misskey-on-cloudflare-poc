/// <reference path="../../shared/src/cloudflare-workers.d.ts" />
/**
 * Deployed entry module of misskey-cf-api (wrangler `main`): the default handler and DO classes
 * from `index.ts`, plus `ApiInternal`, a Workers RPC entrypoint for the other misskey-cf workers.
 * Kept out of `index.ts` because `cloudflare:workers` only resolves inside the Workers runtime
 * (the offline tests import `index.ts` under Node).
 */
import { WorkerEntrypoint } from "cloudflare:workers";
import api, { type ApiEnv } from "./index.js";
import { touchLastActiveDate } from "./maintenance-pg.js";
import { ssrEntity, ssrNote, ssrUser, type SsrNote, type SsrUser } from "./ssr-pg.js";
import { runWithPgScope } from "./pg.js";
import { runWithOpsBackground } from "../../shared/src/ops.js";
import { packInstanceMeta } from "./meta-source.js";
import { forwardReversiFrame } from "./reversi-pg.js";

export * from "./index.js";
export default api;

/**
 * Bound into misskey-cf-stream and misskey-cf-gateway as a service binding with
 * `entrypoint = "ApiInternal"`, so it is only callable from bound workers (a named entrypoint is
 * never routed from the internet).
 */
export class ApiInternal extends WorkerEntrypoint<ApiEnv> {
  /** One Postgres connection per RPC call, as for the fetch handler. */
  private scoped<T>(fn: () => Promise<T>): Promise<T> {
    const waitUntil = (p: Promise<unknown>) => this.ctx.waitUntil(p);
    return runWithOpsBackground(waitUntil, () => runWithPgScope(fn, waitUntil));
  }

  /** upstream UserService.updateLastActiveDate (StreamingApiServerService's 5-minute interval). */
  async touchLastActiveDate(userId: string): Promise<void> {
    if (typeof userId !== "string" || !userId) return;
    await this.scoped(() => touchLastActiveDate(this.env, userId));
  }

  /**
   * StreamHub's `reversiGame` channel frames, forwarded to the Reversi DO `game:{gameId}`. Going
   * through this entrypoint instead of a stream → api DO binding keeps misskey-cf-stream free of
   * DO bindings into this worker (the api Worker binds stream's DO classes, so the reverse would
   * be a deploy-order cycle).
   */
  async reversiFrame(gameId: string, userId: string, type: string, body: unknown): Promise<void> {
    if (typeof gameId !== "string" || !gameId || typeof userId !== "string" || !userId || typeof type !== "string") return;
    await forwardReversiFrame(this.env, gameId, userId, type, body);
  }

  /** Gateway SSR `/@:user/:sub?` (upstream ClientServerService UserPage): null → base HTML. */
  async ssrUser(acct: string): Promise<SsrUser | null> {
    if (typeof acct !== "string" || !acct) return null;
    return this.scoped(() => ssrUser(this.env, acct));
  }

  /** Gateway SSR `/notes/:note` (upstream NotePage): null → base HTML. */
  async ssrNote(noteId: string): Promise<SsrNote | null> {
    if (typeof noteId !== "string" || !noteId) return null;
    return this.scoped(() => ssrNote(this.env, noteId));
  }

  /** Gateway `#misskey_meta`: packed MetaDetailed, as `POST /api/meta { detail: true }` (KV-cached). */
  async getMeta(): Promise<Record<string, unknown>> {
    return this.scoped(async () => (await packInstanceMeta(this.env, true)) as Record<string, unknown>);
  }

  /** Gateway SSR of the other entity pages and the embeds' `embedCtx` (ssr-pg.ts ssrEntity). */
  async ssrEntity(kind: string, key: string, sub?: string): Promise<Awaited<ReturnType<typeof ssrEntity>>> {
    if (typeof kind !== "string" || typeof key !== "string" || !key) return null;
    return this.scoped(() => ssrEntity(this.env, kind, key, typeof sub === "string" ? sub : undefined));
  }
}
