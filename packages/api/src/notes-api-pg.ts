/**
 * notes/create, notes/delete, notes/show, the four timelines, notes/unrenote, notes/reactions
 * (+ create / delete) and users/notes on PG.
 */
import type { ApiEnv } from "./env.js";
import { apiErrorResponse, CREDENTIAL_REQUIRED, INVALID_PARAM, NO_SUCH_NOTE, YOU_HAVE_BEEN_BLOCKED } from "./errors.js";
import { authUserId, hd, requireHyperdrive } from "./handler-kit.js";
import { buildPackConfig } from "./meta-source.js";
import { deleteNotePg, getNotePg, packNoteFromPg, rowToPackNote } from "./notes-pg.js";
import { createNotePg, type NoteCreateError } from "./note-create-pg.js";
import { withHyperdriveClient } from "./pg.js";
import { isModeratorPg } from "./policies-pg.js";
import { metaRowPg } from "./user-lite-pg.js";
import { globalTimelinePg, homeTimelinePg, hybridTimelinePg, localTimelinePg, usersNotesPg } from "./timelines-pg.js";
import { createReactionPg, deleteReactionPg, listReactionsPg } from "./reactions-pg.js";
import { canViewNote } from "./visibility.js";

type Ctx = { hasCredential: boolean; request: Request; waitUntil?: (p: Promise<unknown>) => void };
type Handler = (env: ApiEnv, body: Record<string, unknown>, ctx: Ctx) => Promise<Response | unknown>;

const CREATE_ERRORS: Record<NoteCreateError, { message: string; code: string; id: string; kind: "client" }> = {
  NO_SUCH_RENOTE_TARGET: { message: "No such renote target.", code: "NO_SUCH_RENOTE_TARGET", id: "b5c90186-4ab0-49c8-9bba-a1f76c282ba4", kind: "client" },
  CANNOT_RENOTE_TO_A_PURE_RENOTE: { message: "You can not Renote a pure Renote.", code: "CANNOT_RENOTE_TO_A_PURE_RENOTE", id: "fd4cc33e-2a37-48dd-99cc-9b806eb2031a", kind: "client" },
  CANNOT_RENOTE_DUE_TO_VISIBILITY: { message: "You can not Renote due to target visibility.", code: "CANNOT_RENOTE_DUE_TO_VISIBILITY", id: "be9529e9-fe72-4de0-ae43-0b363c4938af", kind: "client" },
  NO_SUCH_REPLY_TARGET: { message: "No such reply target.", code: "NO_SUCH_REPLY_TARGET", id: "749ee0f6-d3da-459a-bf02-282e2da4292c", kind: "client" },
  CANNOT_REPLY_TO_AN_INVISIBLE_NOTE: { message: "You cannot reply to an invisible Note.", code: "CANNOT_REPLY_TO_AN_INVISIBLE_NOTE", id: "b98980fa-3780-406c-a935-b6d0eeee10d1", kind: "client" },
  CANNOT_REPLY_TO_A_PURE_RENOTE: { message: "You can not reply to a pure Renote.", code: "CANNOT_REPLY_TO_A_PURE_RENOTE", id: "3ac74a84-8fd5-4bb0-870f-01804f82ce15", kind: "client" },
  CANNOT_REPLY_TO_SPECIFIED_VISIBILITY_NOTE_WITH_EXTENDED_VISIBILITY: { message: "You cannot reply to a specified visibility note with extended visibility.", code: "CANNOT_REPLY_TO_SPECIFIED_VISIBILITY_NOTE_WITH_EXTENDED_VISIBILITY", id: "ed940410-535c-4d5e-bfa3-af798671e93c", kind: "client" },
  CANNOT_CREATE_ALREADY_EXPIRED_POLL: { message: "Poll is already expired.", code: "CANNOT_CREATE_ALREADY_EXPIRED_POLL", id: "04da457d-b083-4055-9082-955525eda5a5", kind: "client" },
  NO_SUCH_CHANNEL: { message: "No such channel.", code: "NO_SUCH_CHANNEL", id: "b1653923-5453-4edc-b786-7c4f39bb0bbb", kind: "client" },
  YOU_HAVE_BEEN_BLOCKED: { message: "You have been blocked by this user.", code: "YOU_HAVE_BEEN_BLOCKED", id: "b390d7e1-8a5e-46ed-b625-06271cafd3d3", kind: "client" },
  NO_SUCH_FILE: { message: "Some files are not found.", code: "NO_SUCH_FILE", id: "b6992544-63e7-67f0-fa7f-32444b1b5306", kind: "client" },
  CANNOT_RENOTE_OUTSIDE_OF_CHANNEL: { message: "Cannot renote outside of channel.", code: "CANNOT_RENOTE_OUTSIDE_OF_CHANNEL", id: "33510210-8452-094c-6227-4a6c05d99f00", kind: "client" },
  CONTAINS_PROHIBITED_WORDS: { message: "Cannot post because it contains prohibited words.", code: "CONTAINS_PROHIBITED_WORDS", id: "aa6e01d3-a85c-669d-758a-76aab43af334", kind: "client" },
  CONTAINS_TOO_MANY_MENTIONS: { message: "Cannot post because it exceeds the allowed number of mentions.", code: "CONTAINS_TOO_MANY_MENTIONS", id: "4de0363a-3046-481b-9b0f-feff3e211025", kind: "client" },
};

/** upstream notes/create (NoteCreateService.fetchAndCreate). */
export const notesCreate: Handler = async (env, body, ctx) => {
  const actorId = await authUserId(env, body, ctx);
  if (!actorId) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  const poll = body.poll as { choices: string[]; multiple?: boolean; expiresAt?: number | null; expiredAfter?: number | null } | null | undefined;
  const r = await createNotePg(env, actorId, {
    fileIds: (body.fileIds as string[] | undefined) ?? (body.mediaIds as string[] | undefined) ?? [],
    poll: poll ? {
      choices: poll.choices,
      multiple: poll.multiple ?? false,
      expiresAt: poll.expiredAfter ? new Date(Date.now() + poll.expiredAfter) : poll.expiresAt ? new Date(poll.expiresAt) : null,
    } : null,
    text: (body.text as string | null | undefined) ?? null,
    replyId: (body.replyId as string | null | undefined) ?? null,
    renoteId: (body.renoteId as string | null | undefined) ?? null,
    cw: (body.cw as string | null | undefined) ?? null,
    localOnly: body.localOnly === true,
    reactionAcceptance: (body.reactionAcceptance as string | null | undefined) ?? null,
    visibility: typeof body.visibility === "string" ? body.visibility : "public",
    visibleUserIds: (body.visibleUserIds as string[] | undefined) ?? [],
    channelId: (body.channelId as string | null | undefined) ?? null,
    noExtractMentions: body.noExtractMentions === true,
    noExtractHashtags: body.noExtractHashtags === true,
    noExtractEmojis: body.noExtractEmojis === true,
  }, ctx.waitUntil);
  if (typeof r === "string") return apiErrorResponse(CREATE_ERRORS[r], 400);
  return { createdNote: await packNoteFromPg(env, r.note, buildPackConfig(env), actorId) };
};

const DELETE_NO_SUCH_NOTE = { message: "No such note.", code: "NO_SUCH_NOTE", id: "490be23f-8c1f-4796-819f-94cb4f9d1630", kind: "client" as const };
const DELETE_ACCESS_DENIED = { message: "Access denied.", code: "ACCESS_DENIED", id: "fe8d7103-0ea8-4ec3-814d-f8b401dc69e9", kind: "client" as const };

/** upstream notes/delete: the author or a moderator. */
const notesDelete: Handler = async (env, body, ctx) => {
  const noteId = body.noteId;
  if (typeof noteId !== "string" || !noteId) return apiErrorResponse(INVALID_PARAM, 400);
  const actorId = await authUserId(env, body, ctx);
  if (!actorId) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  const existing = await getNotePg(env, noteId);
  if (!existing) return apiErrorResponse(DELETE_NO_SUCH_NOTE, 400);
  const isModerator = await withHyperdriveClient(hd(env), (c) => isModeratorPg(env, c, actorId));
  if (!isModerator && existing.userId !== actorId) return apiErrorResponse(DELETE_ACCESS_DENIED, 400);
  await deleteNotePg(env, existing, actorId);
  return null;
};

const CONTENT_RESTRICTED_BY_USER = { message: "Content restricted by user. Please sign in to view.", code: "CONTENT_RESTRICTED_BY_USER", id: "fbcc002d-37d9-4944-a6b0-d9e29f2d33ab", kind: "client" as const };
const CONTENT_RESTRICTED_BY_SERVER = { message: "Content restricted by server settings. Please sign in to view.", code: "CONTENT_RESTRICTED_BY_SERVER", id: "145f88d2-b03d-4087-8143-a78928883c4b", kind: "client" as const };

/**
 * upstream notes/show: NO_SUCH_NOTE, the sign-in requirements (author's
 * requireSigninToViewContents, meta.ugcVisibilityForVisitor), then NoteEntityService.pack
 * (detail) — notes the viewer may not see are returned hidden (`isHidden`), not refused.
 */
const notesShow: Handler = async (env, body, ctx) => {
  const viewerId = await authUserId(env, body, ctx);
  const note = await getNotePg(env, String(body.noteId));
  if (!note) return apiErrorResponse(NO_SUCH_NOTE, 400);
  if (viewerId == null) {
    const refused = await withHyperdriveClient(hd(env), async (c) => {
      const author = (await c.query(`SELECT "requireSigninToViewContents" FROM "user" WHERE id = $1`, [note.userId])).rows[0];
      if (author?.requireSigninToViewContents) return CONTENT_RESTRICTED_BY_USER;
      const ugc = (await metaRowPg(c)).ugcVisibilityForVisitor;
      if (ugc === "none") return CONTENT_RESTRICTED_BY_SERVER;
      if (ugc === "local" && note.userHost != null) return CONTENT_RESTRICTED_BY_SERVER;
      return null;
    });
    if (refused) return apiErrorResponse(refused, 400);
  }
  return packNoteFromPg(env, note, buildPackConfig(env), viewerId);
};

/** upstream notes/unrenote: every renote of the note by the caller goes through NoteDeleteService.delete. */
const notesUnrenote: Handler = async (env, body, ctx) => {
  const noteId = body.noteId;
  if (typeof noteId !== "string" || !noteId) return apiErrorResponse(INVALID_PARAM, 400);
  const me = await authUserId(env, body, ctx);
  if (!me) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  const note = await getNotePg(env, noteId);
  if (!note) return apiErrorResponse({ ...NO_SUCH_NOTE, id: "efd4a259-2442-496b-8dd7-b255aa1a160f" }, 400);
  const renotes = await withHyperdriveClient(hd(env), async (c) =>
    (await c.query(`SELECT * FROM note WHERE "userId" = $1 AND "renoteId" = $2`, [me, note.id])).rows.map(rowToPackNote),
  );
  for (const r of renotes) await deleteNotePg(env, r);
  return null;
};

const REACTIONS_NO_SUCH_NOTE = { ...NO_SUCH_NOTE, id: "263fff3d-d0e1-4af4-bea7-8408059b451a" };

const notesReactions: Handler = async (env, body, ctx) => {
  const noteId = body.noteId;
  if (typeof noteId !== "string" || !noteId) return apiErrorResponse(INVALID_PARAM, 400);
  const meId = await authUserId(env, body, ctx);
  const note = await getNotePg(env, noteId);
  if (!note || !(await canViewNote(env, note, meId))) return apiErrorResponse(REACTIONS_NO_SUCH_NOTE, 400);
  return listReactionsPg(env, { noteId, body, meId });
};

const REACT_ERRORS = {
  noSuchNote: { message: "No such note.", code: "NO_SUCH_NOTE", id: "033d0620-5bfe-4027-965d-980b0c85a3ea", kind: "client" as const },
  alreadyReacted: { message: "You are already reacting to that note.", code: "ALREADY_REACTED", id: "71efcf98-86d6-4e2b-b2ad-9d032369366b", kind: "client" as const },
  cannotReactToRenote: { message: "You cannot react to Renote.", code: "CANNOT_REACT_TO_RENOTE", id: "eaccdc08-ddef-43fe-908f-d108faad57f5", kind: "client" as const },
};

const reactionsCreate: Handler = async (env, body, ctx) => {
  const noteId = body.noteId;
  const reaction = body.reaction;
  if (typeof noteId !== "string" || !noteId || typeof reaction !== "string" || !reaction) return apiErrorResponse(INVALID_PARAM, 400);
  const actorId = await authUserId(env, body, ctx);
  if (!actorId) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  const target = await getNotePg(env, noteId);
  if (!target) return apiErrorResponse(REACT_ERRORS.noSuchNote, 400);
  const r = await createReactionPg(env, actorId, target, reaction, ctx.waitUntil);
  if (r === "ALREADY_REACTED") return apiErrorResponse(REACT_ERRORS.alreadyReacted, 400);
  if (r === "YOU_HAVE_BEEN_BLOCKED") return apiErrorResponse(YOU_HAVE_BEEN_BLOCKED, 400);
  if (r === "CANNOT_REACT_TO_RENOTE") return apiErrorResponse(REACT_ERRORS.cannotReactToRenote, 400);
  // upstream: the IdentifiableError "Note not accessible for you." is not mapped → INTERNAL_ERROR
  if (r === "NOT_ACCESSIBLE") throw new Error("Note not accessible for you.");
  return null;
};

const UNREACT_ERRORS = {
  noSuchNote: { message: "No such note.", code: "NO_SUCH_NOTE", id: "764d9fce-f9f2-4a0e-92b1-6ceac9a7ad37", kind: "client" as const },
  notReacted: { message: "You are not reacting to that note.", code: "NOT_REACTED", id: "92f4426d-4196-4125-aa5b-02943e2ec8fc", kind: "client" as const },
};

const reactionsDelete: Handler = async (env, body, ctx) => {
  const noteId = body.noteId;
  if (typeof noteId !== "string" || !noteId) return apiErrorResponse(INVALID_PARAM, 400);
  const actorId = await authUserId(env, body, ctx);
  if (!actorId) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  const note = await getNotePg(env, noteId);
  if (!note) return apiErrorResponse(UNREACT_ERRORS.noSuchNote, 400);
  if (!(await deleteReactionPg(env, actorId, note, ctx.waitUntil))) return apiErrorResponse(UNREACT_ERRORS.notReacted, 400);
  return null;
};

/** Home / hybrid need a credential (the PG timelines check the rest). */
const withCredential = (h: Handler): Handler => async (env, body, ctx) => {
  if (!ctx.hasCredential) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  return h(env, body, ctx);
};

export const notesApiHandlers: Record<string, Handler> = requireHyperdrive({
  "notes/create": notesCreate,
  "notes/delete": notesDelete,
  "notes/show": notesShow,
  "notes/timeline": withCredential(homeTimelinePg),
  "notes/hybrid-timeline": withCredential(hybridTimelinePg),
  "notes/local-timeline": localTimelinePg,
  "notes/global-timeline": globalTimelinePg,
  "notes/unrenote": notesUnrenote,
  "notes/reactions": notesReactions,
  "notes/reactions/create": reactionsCreate,
  "notes/reactions/delete": reactionsDelete,
  "users/notes": usersNotesPg,
});
