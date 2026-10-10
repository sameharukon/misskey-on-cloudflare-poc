/**
 * Small helpers the endpoint modules share (they used to define their own identical copies).
 */
import type { ApiEnv } from "./env.js";
import { apiErrorResponse, INVALID_PARAM, type ApiErrorBody } from "./errors.js";
import { authenticatePg, extractToken } from "./auth-pg.js";
import { holdPgScope } from "./pg.js";

/** The Hyperdrive binding of a PG-backed handler (callers run only when it is bound). */
export const hd = (env: ApiEnv) => env.HYPERDRIVE!;

/** An upstream ApiError of kind "client". */
export const clientError = (code: string, id: string, message: string): ApiErrorBody => ({ message, code, id, kind: "client" });

/** 400 INVALID_PARAM. */
export const invalidParam = () => apiErrorResponse(INVALID_PARAM, 400);

/** 501 for a PG-backed endpoint when the Worker has no Hyperdrive binding. */
export const hyperdriveUnbound = () =>
  apiErrorResponse({ message: "Hyperdrive required.", code: "HYPERDRIVE_UNBOUND", id: "00000000-0000-4000-8000-0000000000b1", kind: "server" }, 501);

/** The handlers with a 501 in front of them while Hyperdrive is unbound. */
export function requireHyperdrive<H extends (env: ApiEnv, ...rest: never[]) => Promise<unknown>>(table: Record<string, H>): Record<string, H> {
  return Object.fromEntries(
    Object.entries(table).map(([k, h]) => [k, (async (env: ApiEnv, ...rest: never[]) => (env.HYPERDRIVE?.connectionString ? h(env, ...rest) : hyperdriveUnbound())) as unknown as H]),
  );
}

/** 400 with the given error. */
export const errorResponse = (e: ApiErrorBody) => apiErrorResponse(e, 400);

type CallCtx = { hasCredential: boolean; request: Request };

/** The caller's user id, or null when the call carries no credential or it does not authenticate. */
export async function authUserId(env: ApiEnv, body: Record<string, unknown>, ctx: CallCtx): Promise<string | null> {
  if (!ctx.hasCredential) return null;
  const token = extractToken(ctx.request, body);
  return token ? ((await authenticatePg(env, token))?.user.id ?? null) : null;
}

/** As authUserId, but "invalid" when a credential was sent and did not authenticate. */
export async function optionalUserId(env: ApiEnv, body: Record<string, unknown>, ctx: CallCtx): Promise<string | null | "invalid"> {
  if (!ctx.hasCredential) return null;
  return (await authUserId(env, body, ctx)) ?? "invalid";
}

/**
 * Work that upstream does after answering (NoteCreateService's setImmediate postNoteCreated,
 * ReactionService's events): handed to `waitUntil` when the request has one, keeping the
 * request's PG connection open until it is done; awaited otherwise (offline, tests). A failure
 * is logged, as the response has already gone out.
 */
export async function afterResponse(waitUntil: ((p: Promise<unknown>) => void) | undefined, label: string, work: () => Promise<unknown>): Promise<void> {
  if (!waitUntil) {
    await work();
    return;
  }
  waitUntil(holdPgScope(work().catch((e) => console.warn(`${label} failed: ${e instanceof Error ? e.message : String(e)}`))));
}
