/**
 * i/update on PG (W7.10), following upstream endpoints/i/update.ts: profile fields, privacy and
 * notification settings, word mutes (wordMuteLimit, regex check), avatar / banner from the
 * caller's drive (canUpdateBioMedia), avatar decorations (role-limited, avatarDecorationLimit),
 * pinned page, fields, alsoKnownAs (users already known here), name prohibited words, custom
 * emoji + hashtag extraction, then `meUpdated` on `main`, follow-request auto-accept on unlock
 * and Update(Person) to remote followers.
 *
 * Differences: `lang` accepts any string up to 32 chars (no langmap); regexes are checked with
 * JS RegExp instead of RE2; avatar URLs are not routed through a media proxy; rel=me link
 * verification is not run (verifiedLinks is cleared, as upstream does before verifying).
 */

import { authUserId } from "./handler-kit.js";
import * as mfm from "mfm-js";
import type { ApiEnv } from "./env.js";
import { apiErrorResponse, CREDENTIAL_REQUIRED, INVALID_PARAM, type ApiErrorBody } from "./errors.js";
import { withHyperdriveClient, type PgQueryable } from "./pg.js";
import { getUserPoliciesPg, getUserRolesPg, isModeratorPg } from "./policies-pg.js";
import { isKeyWordIncluded, updateUserTagsPg } from "./search-pg.js";
import { publishToUserStream } from "./stream-publish.js";
import { createNotification } from "./notifications-do.js";
import * as g from "./graph-pg.js";
import * as O from "./ap/outbound.js";
import { packMe } from "./client-endpoints-pg.js";
import { buildPackConfig } from "./meta-source.js";
import { toSimpleArray } from "../../db/src/simple-array.js";
import { metaRowPg } from "./user-lite-pg.js";

type Ctx = { hasCredential: boolean; request: Request };
type Body = Record<string, unknown>;

const err = (code: string, id: string, message: string, httpStatus = 400): ApiErrorBody & { httpStatus: number } => ({ message, code, id, kind: "client", httpStatus });
export const I_UPDATE_ERRORS = {
  noSuchAvatar: err("NO_SUCH_AVATAR", "539f3a45-f215-4f81-a9a8-31293640207f", "No such avatar file."),
  noSuchBanner: err("NO_SUCH_BANNER", "0d8f5629-f210-41c2-9433-735831a58595", "No such banner file."),
  avatarNotAnImage: err("AVATAR_NOT_AN_IMAGE", "f419f9f8-2f4d-46b1-9fb4-49d3a2fd7191", "The file specified as an avatar is not an image."),
  bannerNotAnImage: err("BANNER_NOT_AN_IMAGE", "75aedb19-2afd-4e6d-87fc-67941256fa60", "The file specified as a banner is not an image."),
  noSuchPage: err("NO_SUCH_PAGE", "8e01b590-7eb9-431b-a239-860e086c408e", "No such page."),
  invalidRegexp: err("INVALID_REGEXP", "0d786918-10df-41cd-8f33-8dec7d9a89a5", "Invalid Regular Expression."),
  tooManyMutedWords: err("TOO_MANY_MUTED_WORDS", "010665b1-a211-42d2-bc64-8f6609d79785", "Too many muted words."),
  noSuchUser: err("NO_SUCH_USER", "fcd2eef9-a9b2-4c4f-8624-038099e90aa5", "No such user."),
  uriNull: err("URI_NULL", "bf326f31-d430-4f97-9933-5d61e4d48a23", "User ActivityPup URI is null."),
  forbiddenToSetYourself: err("FORBIDDEN_TO_SET_YOURSELF", "25c90186-4ab0-49c8-9bba-a1fa6c202ba4", "You can't set yourself as your own alias."),
  restrictedByRole: err("RESTRICTED_BY_ROLE", "8feff0ba-5ab5-585b-31f4-4df816663fad", "This feature is restricted by your role."),
  nameContainsProhibitedWords: err("YOUR_NAME_CONTAINS_PROHIBITED_WORDS", "0b3f9f6a-2f4d-4b1f-9fb4-49d3a2fd7191", "Your new name contains prohibited words.", 422),
  accountMoved: { ...err("YOUR_ACCOUNT_MOVED", "56f20ec9-fd06-4fa5-841b-edd6d7d4fa31", "You have moved your account.", 403), kind: "permission" as const },
};
const E = I_UPDATE_ERRORS;

class ApiErr extends Error {
  constructor(readonly e: ApiErrorBody & { httpStatus: number }) {
    super(e.code);
  }
}
class BadParam extends Error {}

const len = (s: string) => [...s].length;
const VISIBILITY = ["public", "followers", "private"];
const CHAT_SCOPE = ["everyone", "followers", "following", "mutual", "none"];
const RECIEVE_TYPES = ["all", "following", "follower", "mutualFollow", "followingOrFollower", "never", "list"];
const RECIEVE_KEYS = [
  "note", "follow", "mention", "reply", "renote", "quote", "reaction", "pollEnded", "scheduledNotePosted", "scheduledNotePostFailed",
  "receiveFollowRequest", "followRequestAccepted", "roleAssigned", "chatRoomInvitationReceived", "achievementEarned", "app", "test",
];
const BOOL_USER = ["isLocked", "isExplorable", "hideOnlineStatus", "isBot", "isCat", "requireSigninToViewContents"];
const BOOL_PROFILE = ["publicReactions", "carefulBot", "autoAcceptFollowed", "noCrawle", "preventAiLearning", "injectFeaturedNote", "receiveAnnouncementEmail", "autoSensitive"];

/** paramDef checks (ajv in upstream); throws BadParam. */
function validate(b: Body): void {
  const strOrNull = (k: string, max: number, pattern?: RegExp) => {
    const v = b[k];
    if (v === undefined || v === null) return;
    if (typeof v !== "string" || len(v) < 1 || len(v) > max || (pattern && !pattern.test(v))) throw new BadParam(k);
  };
  strOrNull("name", 50);
  strOrNull("description", 1500);
  strOrNull("followedMessage", 256);
  strOrNull("location", 50);
  strOrNull("birthday", Infinity, /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/);
  strOrNull("lang", 32);
  for (const k of ["avatarId", "bannerId", "pinnedPageId"]) if (b[k] !== undefined && b[k] !== null && typeof b[k] !== "string") throw new BadParam(k);
  for (const k of [...BOOL_USER, ...BOOL_PROFILE, "alwaysMarkNsfw"]) if (b[k] !== undefined && typeof b[k] !== "boolean") throw new BadParam(k);
  for (const k of ["makeNotesFollowersOnlyBefore", "makeNotesHiddenBefore"]) {
    if (b[k] !== undefined && b[k] !== null && !Number.isInteger(b[k])) throw new BadParam(k);
  }
  for (const k of ["followingVisibility", "followersVisibility"]) if (b[k] !== undefined && !VISIBILITY.includes(b[k] as string)) throw new BadParam(k);
  if (b.chatScope !== undefined && !CHAT_SCOPE.includes(b.chatScope as string)) throw new BadParam("chatScope");
  for (const k of ["mutedWords", "hardMutedWords"]) {
    const v = b[k];
    if (v === undefined) continue;
    if (!Array.isArray(v) || !v.every((x) => typeof x === "string" || (Array.isArray(x) && x.every((y) => typeof y === "string")))) throw new BadParam(k);
  }
  for (const k of ["mutedInstances", "emailNotificationTypes"]) {
    if (b[k] !== undefined && !(Array.isArray(b[k]) && (b[k] as unknown[]).every((x) => typeof x === "string"))) throw new BadParam(k);
  }
  if (b.notificationRecieveConfig !== undefined) {
    const c = b.notificationRecieveConfig;
    if (!c || typeof c !== "object" || Array.isArray(c)) throw new BadParam("notificationRecieveConfig");
    for (const [k, v] of Object.entries(c as Record<string, unknown>)) {
      if (!RECIEVE_KEYS.includes(k)) continue;
      const t = (v as { type?: unknown } | null)?.type;
      if (!v || typeof v !== "object" || !RECIEVE_TYPES.includes(t as string)) throw new BadParam(k);
      if (t === "list" && typeof (v as { userListId?: unknown }).userListId !== "string") throw new BadParam(k);
    }
  }
  if (b.fields !== undefined) {
    const f = b.fields;
    if (!Array.isArray(f) || f.length > 16 || !f.every((x) => x && typeof x === "object" && typeof x.name === "string" && typeof x.value === "string")) throw new BadParam("fields");
  }
  if (b.avatarDecorations !== undefined) {
    const d = b.avatarDecorations;
    const inRange = (v: unknown, m: number) => v === undefined || v === null || (typeof v === "number" && v >= -m && v <= m);
    if (!Array.isArray(d) || d.length > 16) throw new BadParam("avatarDecorations");
    for (const x of d) {
      if (!x || typeof x !== "object" || typeof x.id !== "string") throw new BadParam("avatarDecorations");
      if (!inRange(x.angle, 0.5) || !inRange(x.offsetX, 0.25) || !inRange(x.offsetY, 0.25)) throw new BadParam("avatarDecorations");
      if (x.flipH !== undefined && x.flipH !== null && typeof x.flipH !== "boolean") throw new BadParam("avatarDecorations");
    }
  }
  if (b.alsoKnownAs !== undefined) {
    const a = b.alsoKnownAs;
    if (!Array.isArray(a) || a.length > 10 || !a.every((x) => typeof x === "string") || new Set(a).size !== a.length) throw new BadParam("alsoKnownAs");
  }
}

/** Word count as upstream checkMuteWordCount (sum of string lengths). */
function muteWordLength(words: (string | string[])[]): number {
  let n = 0;
  for (const w of words) {
    if (typeof w === "string") n += w.length;
    else for (const s of w) n += s.length;
  }
  return n;
}

function validateMuteWordRegex(words: (string | string[])[]): void {
  for (const w of words) {
    if (typeof w !== "string") continue;
    const m = /^\/(.+)\/(.*)$/.exec(w);
    if (!m) throw new ApiErr(E.invalidRegexp);
    try {
      new RegExp(m[1]!, m[2]);
    } catch {
      throw new ApiErr(E.invalidRegexp);
    }
  }
}

/** extractCustomEmojisFromMfm: unique emoji codes. */
function emojiCodes(nodes: mfm.MfmNode[]): string[] {
  return mfm.extract(nodes, (n) => n.type === "emojiCode").map((n) => (n as mfm.MfmEmojiCode).props.name);
}

/** Acct.parse */
function parseAcct(s: string): { username: string; host: string | null } {
  const t = s.startsWith("@") ? s.slice(1) : s;
  const i = t.indexOf("@");
  return i < 0 ? { username: t, host: null } : { username: t.slice(0, i), host: t.slice(i + 1) || null };
}

async function prohibitedNameWords(c: PgQueryable): Promise<string[]> {
  // a missing column (older schema) reads as none
  return ((await metaRowPg(c)).prohibitedWordsForNameOfUser as string[] | null | undefined) ?? [];
}

type Updates = Record<string, { v: unknown; cast?: string }>;

function setClause(u: Updates, params: unknown[]): string[] {
  return Object.entries(u).map(([k, { v, cast }]) => {
    params.push(v);
    return `"${k}" = $${params.length}${cast ?? ""}`;
  });
}

export async function iUpdatePg(env: ApiEnv, body: Body, ctx: Ctx): Promise<Response | unknown> {
  const me = await authUserId(env, body, ctx);
  if (!me) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  try {
    validate(body);
  } catch (e) {
    if (e instanceof BadParam) return apiErrorResponse(INVALID_PARAM, 400);
    throw e;
  }
  const config = buildPackConfig(env);
  let wasLocked = false;
  try {
    const done = await withHyperdriveClient(env.HYPERDRIVE!, async (c) => {
      const user = (await c.query(`SELECT * FROM "user" WHERE id = $1`, [me])).rows[0];
      const profile = (await c.query(`SELECT * FROM user_profile WHERE "userId" = $1`, [me])).rows[0];
      if (!user || !profile) throw new ApiErr(E.noSuchUser);
      wasLocked = Boolean(user.isLocked);
      let policies: Record<string, unknown> | null = null;
      const pol = async () => (policies ??= await getUserPoliciesPg(env, c, me));
      const u: Updates = {};
      const p: Updates = {};

      if (body.name !== undefined) {
        const t = body.name === null ? "" : String(body.name).trim();
        u.name = { v: t === "" ? null : t };
      }
      for (const k of ["description", "followedMessage", "lang", "location", "birthday", "followingVisibility", "followersVisibility"]) {
        if (body[k] !== undefined) p[k] = { v: body[k] };
      }
      if (body.chatScope !== undefined) u.chatScope = { v: body.chatScope };
      for (const k of ["mutedWords", "hardMutedWords"] as const) {
        if (body[k] === undefined) continue;
        const words = body[k] as (string | string[])[];
        if (muteWordLength(words) > Number((await pol()).wordMuteLimit)) throw new ApiErr(E.tooManyMutedWords);
        validateMuteWordRegex(words);
        p[k] = { v: JSON.stringify(words), cast: "::jsonb" };
        if (k === "mutedWords") p.enableWordMute = { v: words.length > 0 };
      }
      if (body.mutedInstances !== undefined) p.mutedInstances = { v: JSON.stringify(body.mutedInstances), cast: "::jsonb" };
      if (body.notificationRecieveConfig !== undefined) p.notificationRecieveConfig = { v: JSON.stringify(body.notificationRecieveConfig), cast: "::jsonb" };
      for (const k of BOOL_USER) if (typeof body[k] === "boolean") u[k] = { v: body[k] };
      for (const k of BOOL_PROFILE) if (typeof body[k] === "boolean") p[k] = { v: body[k] };
      for (const k of ["makeNotesFollowersOnlyBefore", "makeNotesHiddenBefore"]) {
        if (typeof body[k] === "number" || body[k] === null) u[k] = { v: body[k] };
      }
      if (typeof body.alwaysMarkNsfw === "boolean") {
        if ((await pol()).alwaysMarkNsfw) throw new ApiErr(E.restrictedByRole);
        p.alwaysMarkNsfw = { v: body.alwaysMarkNsfw };
      }
      if (body.emailNotificationTypes !== undefined) p.emailNotificationTypes = { v: JSON.stringify(body.emailNotificationTypes), cast: "::jsonb" };

      for (const kind of ["avatar", "banner"] as const) {
        const id = body[`${kind}Id`];
        if (id) {
          if (!(await pol()).canUpdateBioMedia) throw new ApiErr(E.restrictedByRole);
          const f = (await c.query(`SELECT id, "userId", type, url, "webpublicUrl", blurhash FROM drive_file WHERE id = $1`, [id])).rows[0];
          if (!f || f.userId !== me) throw new ApiErr(kind === "avatar" ? E.noSuchAvatar : E.noSuchBanner);
          if (!String(f.type).startsWith("image/")) throw new ApiErr(kind === "avatar" ? E.avatarNotAnImage : E.bannerNotAnImage);
          u[`${kind}Id`] = { v: f.id };
          u[`${kind}Url`] = { v: (f.webpublicUrl as string | null) ?? f.url };
          u[`${kind}Blurhash`] = { v: f.blurhash ?? null };
        } else if (id === null) {
          u[`${kind}Id`] = { v: null };
          u[`${kind}Url`] = { v: null };
          u[`${kind}Blurhash`] = { v: null };
        }
      }

      if (Array.isArray(body.avatarDecorations)) {
        const decos = body.avatarDecorations as { id: string; angle?: number | null; flipH?: boolean | null; offsetX?: number | null; offsetY?: number | null }[];
        if (decos.length > Number((await pol()).avatarDecorationLimit)) throw new ApiErr(E.restrictedByRole);
        const all = (await c.query(`SELECT id, "roleIdsThatCanBeUsedThisDecoration" AS roles FROM avatar_decoration`)).rows;
        const roleIds = new Set((await c.query(`SELECT id FROM role`)).rows.map((r) => String(r.id)));
        const mine = new Set((await getUserRolesPg(c, me)).map((r) => r.id));
        const usable = new Set(
          all.filter((d) => {
            const rs = ((d.roles as string[] | null) ?? []).filter((r) => roleIds.has(r));
            return rs.length === 0 || rs.some((r) => mine.has(r));
          }).map((d) => String(d.id)),
        );
        const v = decos.filter((d) => usable.has(d.id)).map((d) => ({ id: d.id, angle: d.angle ?? 0, flipH: d.flipH ?? false, offsetX: d.offsetX ?? 0, offsetY: d.offsetY ?? 0 }));
        u.avatarDecorations = { v: JSON.stringify(v), cast: "::jsonb" };
      }

      if (body.pinnedPageId) {
        let page: Record<string, unknown> | undefined;
        try {
          page = (await c.query(`SELECT id, "userId" FROM page WHERE id = $1`, [body.pinnedPageId])).rows[0];
        } catch {
          page = undefined; // no page table
        }
        if (!page || page.userId !== me) throw new ApiErr(E.noSuchPage);
        p.pinnedPageId = { v: page.id };
      } else if (body.pinnedPageId === null) {
        p.pinnedPageId = { v: null };
      }

      if (Array.isArray(body.fields)) {
        const fields = (body.fields as { name: string; value: string }[])
          .filter((x) => x.name.trim() !== "" && x.value.trim() !== "")
          .map((x) => ({ name: x.name.trim(), value: x.value.trim() }));
        p.fields = { v: JSON.stringify(fields), cast: "::jsonb" };
      }

      if (Array.isArray(body.alsoKnownAs)) {
        if (user.movedToUri) throw new ApiErr(E.accountMoved);
        const aka = new Set<string>();
        for (const line of body.alsoKnownAs as string[]) {
          if (!line) throw new ApiErr(E.noSuchUser);
          const { username, host } = parseAcct(line);
          const local = host == null || host.toLowerCase() === config.host.toLowerCase();
          // upstream resolves remote accounts over WebFinger; here only users already known
          const known = (await c.query(
            `SELECT id, host, uri FROM "user" WHERE "usernameLower" = $1 AND ${local ? "host IS NULL" : "host = $2"}`,
            local ? [username.toLowerCase()] : [username.toLowerCase(), host!.toLowerCase()],
          )).rows[0];
          if (!known) throw new ApiErr(E.noSuchUser);
          if (known.id === me) throw new ApiErr(E.forbiddenToSetYourself);
          const uri = known.host == null ? `${config.url}/users/${known.id}` : ((known.uri as string | null) ?? null);
          if (!uri) throw new ApiErr(E.uriNull);
          aka.add(uri);
        }
        u.alsoKnownAs = { v: toSimpleArray(aka.size ? [...aka] : null) };
      }

      // emojis (tags are recomputed by updateUserTagsPg below)
      const newName = u.name ? (u.name.v as string | null) : ((user.name as string | null) ?? null);
      const newDescription = p.description ? (p.description.v as string | null) : ((profile.description as string | null) ?? null);
      const newFields = p.fields ? (JSON.parse(p.fields.v as string) as { name: string; value: string }[]) : (((profile.fields as unknown[]) ?? []) as { name: string; value: string }[]);
      const newFollowed = p.followedMessage ? (p.followedMessage.v as string | null) : ((profile.followedMessage as string | null) ?? null);
      let emojis: string[] = [];
      if (newName != null) {
        if (!(await isModeratorPg(env, c, me)) && isKeyWordIncluded(newName, await prohibitedNameWords(c))) throw new ApiErr(E.nameContainsProhibitedWords);
        emojis = emojis.concat(emojiCodes(mfm.parseSimple(newName)));
      }
      if (newDescription != null) emojis = emojis.concat(emojiCodes(mfm.parse(newDescription)));
      for (const f of newFields) emojis = emojis.concat(emojiCodes(mfm.parseSimple(f.name)), emojiCodes(mfm.parseSimple(f.value)));
      if (newFollowed != null) emojis = emojis.concat(emojiCodes(mfm.parse(newFollowed)));
      u.emojis = { v: [...new Set(emojis)], cast: "::varchar[]" };

      const up: unknown[] = [me];
      const us = setClause({ ...u, updatedAt: { v: new Date().toISOString() } }, up);
      await c.query(`UPDATE "user" SET ${us.join(", ")} WHERE id = $1`, up);
      const pp: unknown[] = [me];
      const ps = setClause({ ...p, verifiedLinks: { v: [], cast: "::varchar[]" } }, pp);
      await c.query(`UPDATE user_profile SET ${ps.join(", ")} WHERE "userId" = $1`, pp);
      return true;
    });
    void done;
  } catch (e) {
    if (e instanceof ApiErr) {
      const { httpStatus, ...rest } = e.e;
      return apiErrorResponse(rest, httpStatus);
    }
    throw e;
  }

  // HashtagService.updateUsertags (also recomputes user.tags)
  try {
    await updateUserTagsPg(env, me, body.description as string | null | undefined);
  } catch (e) {
    console.warn(`user tags update failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  // unlocking accepts every pending follow request
  if (wasLocked && body.isLocked === false) {
    const { acceptAllFollowRequestsPg } = await import("./user-relations-pg.js");
    await acceptAllFollowRequestsPg(env, me);
  }
  // upstream: includeSecrets: isSecure (the native token, not an app's access token)
  const { authenticatePg, extractToken } = await import("./auth-pg.js");
  const token = extractToken(ctx.request, body);
  const isSecure = token != null && (await authenticatePg(env, token))?.accessTokenId === null;
  const iObj = await packMe(env, me, { includeSecrets: isSecure });
  if (iObj instanceof Response) return iObj;
  await publishToUserStream(env, me, "main", "meUpdated", iObj);
  await O.deliverPersonUpdate(env, me);
  return iObj;
}
