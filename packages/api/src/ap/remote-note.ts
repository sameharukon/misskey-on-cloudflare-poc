/**
 * Parts of an incoming post that upstream ApNoteService.createNote resolves before
 * NoteCreateService: attachments (ApImageService.createImage), custom emojis (extractEmojis),
 * hashtags (extractApHashtags), the poll of a Question (ApQuestionService.extractPollFromQuestion),
 * plus ApQuestionService.updateQuestion and the AP vote (PollService.vote).
 *
 * Attachments are registered as links (`isLink`) at once, typed by `mediaType` with the
 * Document's width / height; the `remoteFile` job (remote-file.ts) then downloads them to fill
 * md5 / type / properties / blurhash, and caches them in R2 when meta.cacheRemoteFiles is on.
 */

import { genAidx } from "../../../id/src/index.js";
import { getApId, getApType, toArray, type ApObject } from "../../../ap/src/index.js";
import type { PackNoteSource } from "../../../packers/src/index.js";
import type { ApiEnv } from "../env.js";
import { withHyperdriveClient, type PgQueryable } from "../pg.js";
import { toPuny } from "./instances.js";
import { ApPermanentError, type RemoteUser } from "./remote.js";

type Row = Record<string, unknown>;

/** upstream checkHttps (production: https only) */
function isHttps(u: unknown): u is string {
  if (typeof u !== "string") return false;
  try {
    return new URL(u).protocol === "https:";
  } catch {
    return false;
  }
}

/** upstream validDocumentTypes */
const DOCUMENT_TYPES = ["Audio", "Document", "Image", "Page", "Video"];
const DB_MAX_IMAGE_COMMENT_LENGTH = 512;

function fileNameOf(url: string): string {
  try {
    const last = decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "");
    return last && last.length <= 256 ? last : "untitled";
  } catch {
    return "untitled";
  }
}

/**
 * ApImageService.createImage for each attachment (sensitive defaults to the note's). Existing
 * link rows of the same uri and owner are reused. Returns the files in attachment order.
 */
/**
 * A remote URL as a link drive file of `actor` (DriveService.uploadFromUrl with isLink): reused per
 * uri + owner. `created` tells the caller to queue the `remoteFile` download.
 */
export async function linkDriveFile(
  c: PgQueryable,
  actor: { id: string; host: string },
  url: string,
  opts: { type?: string | null; properties?: Record<string, number>; comment?: string | null; sensitive?: boolean },
): Promise<{ id: string; type: string; created: boolean }> {
  const hit = (await c.query(`SELECT id, type FROM drive_file WHERE uri = $1 AND "userId" = $2 LIMIT 1`, [url, actor.id])).rows[0];
  if (hit) return { id: String(hit.id), type: String(hit.type), created: false };
  const type = opts.type && /^[\w-]+\/[\w.+-]+$/.test(opts.type) ? opts.type.toLowerCase() : "application/octet-stream";
  const name = fileNameOf(url);
  const id = genAidx(Date.now());
  await c.query(
    `INSERT INTO drive_file (id, "userId", "userHost", md5, name, type, size, comment, properties, "storedInternal", url,
       "accessKey", "thumbnailAccessKey", "webpublicAccessKey", uri, src, "isSensitive", "isLink")
     VALUES ($1, $2, $3, '', $4, $5, 0, $6, $7::jsonb, FALSE, $8, $9, $10, $11, $8, $8, $12, TRUE)`,
    [
      id, actor.id, actor.host, name, type, opts.comment ?? null, JSON.stringify(opts.properties ?? {}), url,
      crypto.randomUUID(), `thumbnail-${crypto.randomUUID()}`, `webpublic-${crypto.randomUUID()}`, opts.sensitive === true,
    ],
  );
  return { id, type, created: true };
}

export async function resolveAttachments(env: ApiEnv, actor: RemoteUser, note: ApObject): Promise<{ id: string; type: string }[]> {
  const out: { id: string; type: string }[] = [];
  const created: string[] = [];
  const attachments = toArray(note.attachment).filter((a): a is ApObject => a != null && typeof a === "object");
  if (!attachments.length) return out;
  await withHyperdriveClient(env.HYPERDRIVE!, async (c) => {
    for (const a of attachments) {
      if (!DOCUMENT_TYPES.includes(getApType(a) ?? "")) continue;
      const url = a.url;
      if (typeof url !== "string" || !isHttps(url)) continue;
      const sensitive = typeof a.sensitive === "boolean" ? a.sensitive : note.sensitive === true;
      const props: Record<string, number> = {};
      if (Number.isInteger(a.width) && (a.width as number) > 0) props.width = a.width as number;
      if (Number.isInteger(a.height) && (a.height as number) > 0) props.height = a.height as number;
      const name = fileNameOf(url);
      const comment = typeof a.name === "string" && a.name.length > 0 && a.name !== name ? a.name.slice(0, DB_MAX_IMAGE_COMMENT_LENGTH) : null;
      const f = await linkDriveFile(c, actor, url, { type: typeof a.mediaType === "string" ? a.mediaType : null, properties: props, comment, sensitive });
      out.push({ id: f.id, type: f.type });
      if (f.created) created.push(f.id);
    }
  });
  // the download (md5, detected type, properties, blurhash; cached when meta says so) runs as a job
  const { enqueueRemoteFile } = await import("./remote-file.js");
  for (const id of created) await enqueueRemoteFile(env, id);
  if (created.length && !env.Q_JOBS) {
    // run inline: the detected types are already known
    const types = await withHyperdriveClient(env.HYPERDRIVE!, async (c) =>
      new Map((await c.query(`SELECT id, type FROM drive_file WHERE id = ANY($1::varchar[])`, [created])).rows.map((r) => [String(r.id), String(r.type)])),
    );
    for (const f of out) f.type = types.get(f.id) ?? f.type;
  }
  return out;
}

/** upstream extractApHashtags: `#name` of Hashtag tags. */
export function extractApHashtags(tags: unknown): string[] {
  return toArray(tags)
    .filter((t): t is ApObject => getApType(t) === "Hashtag" && typeof (t as ApObject).name === "string")
    .map((t) => /^#(.+)/.exec(String(t.name))?.[1] ?? null)
    .filter((x): x is string => x != null);
}

/** ApNoteService.extractEmojis: upsert the host's Emoji tags; returns their names. */
export async function extractEmojis(env: ApiEnv, tags: unknown, host: string): Promise<string[]> {
  const h = toPuny(host);
  // upstream isEmoji: a single icon with a url
  const emojiTags = toArray(tags).filter((t): t is ApObject => {
    if (getApType(t) !== "Emoji") return false;
    const o = t as ApObject;
    const icon = o.icon as ApObject | undefined;
    return typeof o.name === "string" && icon != null && typeof icon === "object" && !Array.isArray(icon) && typeof icon.url === "string";
  });
  if (!emojiTags.length) return [];
  return withHyperdriveClient(env.HYPERDRIVE!, async (c) => {
    const names: string[] = [];
    for (const tag of emojiTags) {
      const name = String(tag.name).replaceAll(":", "");
      if (!name) continue;
      const iconUrl = String((tag.icon as ApObject).url);
      const uri = getApId(tag);
      const license = ((tag._misskey_license as ApObject | undefined)?.freeText as string | undefined) ?? null;
      const ex = (await c.query(`SELECT id, uri, "originalUrl", "updatedAt" FROM emoji WHERE host = $1 AND name = $2`, [h, name])).rows[0];
      if (ex) {
        const updated = Date.parse(typeof tag.updated === "string" ? tag.updated : "");
        if (
          ex.updatedAt == null ||
          (uri != null && ex.uri == null) ||
          (Number.isFinite(updated) && updated > new Date(String(ex.updatedAt)).getTime()) ||
          iconUrl !== ex.originalUrl
        ) {
          await c.query(
            `UPDATE emoji SET uri = $3, "originalUrl" = $4, "publicUrl" = $4, "updatedAt" = now(), license = $5 WHERE host = $1 AND name = $2`,
            [h, name, uri, iconUrl, license],
          );
        }
      } else {
        await c.query(
          `INSERT INTO emoji (id, host, name, uri, "originalUrl", "publicUrl", "updatedAt", aliases, license)
           VALUES ($1, $2, $3, $4, $5, $5, now(), '{}', $6) ON CONFLICT DO NOTHING`,
          [genAidx(Date.now()), h, name, uri, iconUrl, license],
        );
      }
      names.push(name);
    }
    return names;
  });
}

export type ApPoll = { choices: string[]; votes: number[]; multiple: boolean; expiresAt: Date | null };

/** upstream isQuestion: a Note or a Question */
const isQuestion = (o: unknown) => getApType(o) === "Note" || getApType(o) === "Question";

/** ApQuestionService.extractPollFromQuestion (null when not a valid Question). */
export function extractPollFromQuestion(q: ApObject): ApPoll | null {
  if (!isQuestion(q)) return null;
  const multiple = q.oneOf === undefined;
  if (multiple && q.anyOf === undefined) return null;
  const end = typeof q.endTime === "string" ? q.endTime : typeof q.closed === "string" ? q.closed : null;
  const expiresAt = end && Number.isFinite(Date.parse(end)) ? new Date(end) : null;
  const opts = toArray(multiple ? q.anyOf : q.oneOf).filter((x): x is ApObject => x != null && typeof x === "object");
  const choices = opts.map((x) => x.name).filter((x): x is string => typeof x === "string");
  const votes = opts.map((x) => Number((x.replies as ApObject | undefined)?.totalItems ?? x._misskey_votes ?? 0));
  return { choices, votes, multiple, expiresAt };
}

/**
 * ApQuestionService.updateQuestion: the registered remote poll's counts from a Question.
 * Throws (permanently) as upstream when the poll is unknown or the update is not by its author.
 */
export async function updateQuestion(env: ApiEnv, question: ApObject, actor: RemoteUser): Promise<boolean> {
  const uri = getApId(question);
  if (!uri) throw new ApPermanentError("uri is null");
  if (!isQuestion(question)) throw new ApPermanentError("object is not a Question");
  return withHyperdriveClient(env.HYPERDRIVE!, async (c) => {
    const p = (await c.query(
      `SELECT p."noteId", p.choices, p.votes, u.uri AS "userUri"
       FROM note n JOIN poll p ON p."noteId" = n.id JOIN "user" u ON u.id = p."userId" WHERE n.uri = $1 LIMIT 1`,
      [uri],
    )).rows[0];
    if (!p) throw new ApPermanentError("Question is not registered");
    const attribution = question.attributedTo != null ? getApId(toArray(question.attributedTo)[0]) : p.userUri;
    if (attribution !== p.userUri || attribution !== actor.uri) throw new ApPermanentError("Refusing to ingest update for poll by different user");
    const apChoices = toArray(question.oneOf ?? question.anyOf).filter((x): x is ApObject => x != null && typeof x === "object");
    if (!apChoices.length && question.oneOf == null && question.anyOf == null) throw new ApPermanentError("invalid apChoices");
    const choices = (p.choices as string[]) ?? [];
    const votes = ((p.votes as number[]) ?? []).map(Number);
    let changed = false;
    choices.forEach((choice, i) => {
      const n = (apChoices.find((x) => x.name === choice)?.replies as ApObject | undefined)?.totalItems;
      if (n == null || !(Number.isInteger(n) && (n as number) >= 0)) throw new ApPermanentError(`invalid newCount: ${String(n)}`);
      if (votes[i] !== n) {
        changed = true;
        votes[i] = n as number;
      }
    });
    await c.query(`UPDATE poll SET votes = $2::int[] WHERE "noteId" = $1`, [p.noteId, votes]);
    return changed;
  });
}

/**
 * ApNoteService.createNote's vote branch → PollService.vote by a remote user: expired polls and
 * unknown choices are ignored, a repeat / blocked vote throws (permanently). Returns the choice index or null.
 */
export async function voteFromAp(env: ApiEnv, actor: RemoteUser, reply: PackNoteSource, name: string): Promise<number | null> {
  const r = await withHyperdriveClient(env.HYPERDRIVE!, async (c) => {
    const poll = (await c.query(`SELECT "expiresAt", multiple, choices FROM poll WHERE "noteId" = $1`, [reply.id])).rows[0] as Row | undefined;
    if (!poll) throw new ApPermanentError("poll not found");
    if (poll.expiresAt != null && Date.now() > new Date(String(poll.expiresAt)).getTime()) return null;
    const choice = ((poll.choices as string[]) ?? []).findIndex((x) => x === name);
    if (choice < 0) return null;
    if (reply.userId !== actor.id) {
      const b = await c.query(`SELECT 1 AS ok FROM blocking WHERE "blockerId" = $1 AND "blockeeId" = $2 LIMIT 1`, [reply.userId, actor.id]);
      if (b.rows.length) throw new ApPermanentError("blocked");
    }
    const ex = await c.query(`SELECT choice FROM poll_vote WHERE "noteId" = $1 AND "userId" = $2`, [reply.id, actor.id]);
    if (poll.multiple ? ex.rows.some((x) => Number(x.choice) === choice) : ex.rows.length !== 0) throw new ApPermanentError("already voted");
    await c.query(`INSERT INTO poll_vote (id, "userId", "noteId", choice) VALUES ($1, $2, $3, $4)`, [genAidx(Date.now()), actor.id, reply.id, choice]);
    await c.query(`UPDATE poll SET votes[$1] = votes[$1] + 1 WHERE "noteId" = $2`, [choice + 1, reply.id]);
    return choice;
  });
  if (r == null) return null;
  const { publishNoteUpdated } = await import("../note-stream.js");
  await publishNoteUpdated(env, reply, "pollVoted", { choice: r, userId: actor.id });
  return r;
}
