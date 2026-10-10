/**
 * notes/translate (upstream endpoints/notes/translate.ts). The pinned upstream supports one
 * provider, DeepL: `meta.deeplAuthKey` (null = unavailable) and `meta.deeplIsPro`
 * (api.deepl.com vs api-free.deepl.com). The caller needs the `canUseTranslator` role policy,
 * the note must be visible to them (NoteEntityService.isVisibleForMe) and not hidden by the
 * author's makeNotesHiddenBefore / makeNotesFollowersOnlyBefore (pack().isHidden). An empty
 * text (after the `cw\n-----\n` prefix) answers 204 as upstream. The DeepL request goes through
 * `env.AP_FETCH ?? fetch` (mockable in tests).
 */

import { parseAidxTime } from "../../id/src/index.js";
import type { PackNoteSource } from "../../packers/src/index.js";
import type { ApiEnv } from "./env.js";
import { apiErrorResponse, CREDENTIAL_REQUIRED, INTERNAL_ERROR, INVALID_PARAM } from "./errors.js";
import { authenticatePg, extractToken } from "./auth-pg.js";
import { withHyperdriveClient } from "./pg.js";
import { getNotePg } from "./notes-pg.js";
import { canViewNote } from "./visibility.js";
import { policiesForPg } from "./policies-pg.js";
import { clientError as err } from "./handler-kit.js";
import { metaRowPg } from "./user-lite-pg.js";

type Ctx = { hasCredential: boolean; request: Request };
type Body = Record<string, unknown>;
type Handler = (env: ApiEnv, body: Body, ctx: Ctx) => Promise<Response | unknown>;

export const TRANSLATE_ERRORS = {
  unavailable: err("UNAVAILABLE", "50a70314-2d8a-431b-b433-efa5cc56444c", "Translate of notes unavailable."),
  noSuchNote: err("NO_SUCH_NOTE", "bea9b03f-36e0-49c5-a4db-627a029f8971", "No such note."),
  cannotTranslateInvisibleNote: err("CANNOT_TRANSLATE_INVISIBLE_NOTE", "ea29f2ca-c368-43b3-aaf1-5ac3e74bbe5d", "Cannot translate invisible note."),
};
const E = TRANSLATE_ERRORS;

/** upstream misc/should-hide-note-by-time.ts */
export function shouldHideNoteByTime(hiddenBefore: number | null | undefined, createdAt: Date): boolean {
  if (hiddenBefore == null) return false;
  if (hiddenBefore <= 0) return (Date.now() - createdAt.getTime()) / 1000 >= Math.abs(hiddenBefore);
  return createdAt.getTime() / 1000 <= hiddenBefore;
}

/** The translator settings of the meta row (DeepL only in the pinned upstream). */
export async function translatorConfig(env: ApiEnv): Promise<{ deeplAuthKey: string | null; deeplIsPro: boolean }> {
  const m = await withHyperdriveClient(env.HYPERDRIVE!, (c) => metaRowPg(c));
  return { deeplAuthKey: (m.deeplAuthKey as string | null | undefined) ?? null, deeplIsPro: m.deeplIsPro === true };
}

/** NoteEntityService.pack(note, me).isHidden for an already visible note (author-side time rules). */
async function isHiddenForMe(env: ApiEnv, note: PackNoteSource, meId: string): Promise<boolean> {
  if (note.userId === meId) return false;
  const createdAt = parseAidxTime(note.id);
  if (!createdAt) return false;
  const u = await withHyperdriveClient(env.HYPERDRIVE!, async (c) =>
    (await c.query(
      `SELECT to_jsonb(u) -> 'makeNotesHiddenBefore' AS hb, to_jsonb(u) -> 'makeNotesFollowersOnlyBefore' AS fb FROM "user" u WHERE id = $1`,
      [note.userId],
    )).rows[0],
  );
  const num = (v: unknown) => (typeof v === "number" ? v : v == null ? null : Number(v));
  if (shouldHideNoteByTime(num(u?.hb), createdAt)) return true;
  // treatVisibility: public / home notes older than makeNotesFollowersOnlyBefore pack as followers-only
  if ((note.visibility === "public" || note.visibility === "home") && shouldHideNoteByTime(num(u?.fb), createdAt)) {
    return !(await canViewNote(env, { ...note, visibility: "followers" }, meId, false));
  }
  return false;
}

const translate: Handler = async (env, body, ctx) => {
  const token = ctx.hasCredential ? extractToken(ctx.request, body) : null;
  const me = token ? ((await authenticatePg(env, token))?.user.id ?? null) : null;
  if (!me) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  if (typeof body.noteId !== "string" || !body.noteId || typeof body.targetLang !== "string") return apiErrorResponse(INVALID_PARAM, 400);

  const policies = await policiesForPg(env, me);
  if (!(policies as { canUseTranslator?: boolean }).canUseTranslator) return apiErrorResponse(E.unavailable, 400);

  const note = await getNotePg(env, body.noteId);
  if (!note) return apiErrorResponse(E.noSuchNote, 400);
  if (!(await canViewNote(env, note, me, false))) return apiErrorResponse(E.cannotTranslateInvisibleNote, 400);
  if (await isHiddenForMe(env, note, me)) return apiErrorResponse(E.cannotTranslateInvisibleNote, 400);

  let text = note.text ?? "";
  if (note.cw != null) text = `${note.cw}\n-----\n${text}`;
  if (text.trim() === "") return new Response(null, { status: 204 });

  const cfg = await translatorConfig(env);
  if (cfg.deeplAuthKey == null) return apiErrorResponse(E.unavailable, 400);

  let targetLang = body.targetLang;
  if (targetLang.includes("-")) targetLang = targetLang.split("-")[0]!;
  const params = new URLSearchParams();
  params.append("text", text);
  params.append("target_lang", targetLang);
  const endpoint = cfg.deeplIsPro ? "https://api.deepl.com/v2/translate" : "https://api-free.deepl.com/v2/translate";

  let json: { translations?: { detected_source_language: string; text: string }[] };
  try {
    const res = await (env.AP_FETCH ?? fetch)(endpoint, {
      method: "POST",
      headers: {
        Authorization: `DeepL-Auth-Key ${cfg.deeplAuthKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json, */*",
      },
      body: params.toString(),
      signal: AbortSignal.timeout(10_000),
    });
    // HttpRequestService.send throws on a non-2xx status → upstream answers INTERNAL_ERROR
    if (!res.ok) throw new Error(`DeepL ${res.status}`);
    json = (await res.json()) as typeof json;
  } catch (e) {
    console.warn(`notes/translate failed: ${e instanceof Error ? e.message : String(e)}`);
    return apiErrorResponse(INTERNAL_ERROR, 500);
  }
  const t = json.translations?.[0];
  if (!t) return apiErrorResponse(INTERNAL_ERROR, 500);
  return { sourceLang: t.detected_source_language, text: t.text };
};

function pgOnly(h: Handler): Handler {
  return async (env, body, ctx) => {
    if (!env.HYPERDRIVE?.connectionString) {
      return apiErrorResponse({ message: "Hyperdrive required.", code: "HYPERDRIVE_UNBOUND", id: "00000000-0000-4000-8000-0000000000b1", kind: "server" }, 501);
    }
    return h(env, body, ctx);
  };
}

export const translateHandlers: Record<string, Handler> = {
  "notes/translate": pgOnly(translate),
};

