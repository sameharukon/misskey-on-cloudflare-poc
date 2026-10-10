import type { ApiEnv } from "../env.js";
import { signinFlow } from "../signin-pg.js";
import { ipActor, rateLimit } from "../rate-limit.js";

export const name = "signin-flow";

/**
 * Upstream special route POST /api/signin-flow (misskey-js SigninFlow*).
 * Errors use `{ error: { id } }` shape (legacy SigninApiService).
 */
export async function handle(
  env: ApiEnv,
  body: Record<string, unknown>,
  ctx: { hasCredential: boolean; request: Request },
): Promise<Response | unknown> {
  // upstream SigninApiService: at most 1 attempt per second and 10 per hour per IP (/64)
  const actor = ipActor(env, ctx.request);
  if (actor && (await rateLimit(env, { key: "signin", duration: 60 * 60 * 1000, max: 10, minInterval: 1000 }, actor))) {
    return Response.json(
      { error: { message: "Too many failed attempts to sign in. Try again later.", code: "TOO_MANY_AUTHENTICATION_FAILURES", id: "22d05606-fbcf-421a-a2db-b32610dcfd1b" } },
      { status: 429 },
    );
  }
  try {
    const result = await signinFlow(env, body, ctx.request);
    if (!result.ok) {
      return Response.json({ error: result.error }, { status: result.status });
    }
    return result.body;
  } catch (e) {
    return Response.json(
      {
        error: {
          // a WebAuthn IdentifiableError keeps its id (unknown key, missing challenge, …)
          id: (e as { id?: unknown })?.id && typeof (e as { id?: unknown }).id === "string" ? (e as { id: string }).id : "4e30e80c-e338-45a0-8c8f-44455efa3b76",
          message: e instanceof Error ? e.message : String(e),
        },
      },
      { status: 500 },
    );
  }
}
