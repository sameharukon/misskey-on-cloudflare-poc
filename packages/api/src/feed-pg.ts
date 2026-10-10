/**
 * `/@:user.atom`, `/@:user.rss`, `/@:user.json` (upstream ClientServerService getFeed +
 * FeedService.packFeed, with the same `feed` package): the latest 20 public / home notes that are
 * not renotes, hidden by makeNotesHiddenBefore / makeNotesFollowersOnlyBefore as upstream.
 * Served by this worker; the gateway forwards these paths here.
 */

import { Feed } from "feed";
import * as mfm from "mfm-js";
import { parseAidxTime } from "../../id/src/index.js";
import type { ApiEnv } from "./env.js";
import { buildPackConfig } from "./meta-source.js";
import { withHyperdriveClient } from "./pg.js";
import { metaRowPg } from "./user-lite-pg.js";
import { shouldHideNoteByTime } from "./translate-pg.js";
import { mfmToHtml, parseMentionedRemoteUsers } from "./mfm-html.js";

type Row = Record<string, unknown>;

const num = (v: unknown) => (v == null ? null : Number(v));
const dateOf = (id: string) => parseAidxTime(id) ?? new Date(0);

/** upstream Acct.parse */
function parseAcct(acct: string): { username: string; host: string | null } {
  const a = acct.startsWith("@") ? acct.slice(1) : acct;
  const [username, host] = a.split("@", 2);
  return { username: username!, host: host ?? null };
}

/** getFeed + packFeed; null when the user is missing / hidden from visitors. */
export async function buildFeed(env: ApiEnv, acct: string): Promise<Feed | null> {
  const config = buildPackConfig(env);
  const base = config.url.replace(/\/$/, "");
  const { username, host } = parseAcct(acct);
  const data = await withHyperdriveClient(env.HYPERDRIVE!, async (c) => {
    const user = (await c.query(
      `SELECT to_jsonb(u) AS u FROM "user" u
       WHERE u."usernameLower" = $1 AND ${host == null ? "u.host IS NULL" : "u.host = $2"} AND u."isSuspended" = FALSE
         AND COALESCE((to_jsonb(u) ->> 'requireSigninToViewContents')::boolean, FALSE) = FALSE LIMIT 1`,
      host == null ? [username.toLowerCase()] : [username.toLowerCase(), host],
    )).rows[0]?.u as Row | undefined;
    if (!user) return null;
    const meta = await metaRowPg(c);
    const ugc = (meta.ugcVisibilityForVisitor as string | undefined) ?? "local";
    if (ugc === "none" || (ugc === "local" && user.host != null)) return null;
    const profile = ((await c.query(`SELECT to_jsonb(p) AS p FROM user_profile p WHERE "userId" = $1`, [user.id])).rows[0]?.p ?? {}) as Row;
    const notes = (await c.query(
      `SELECT id, text, cw, "fileIds", "mentionedRemoteUsers" FROM note
       WHERE "userId" = $1 AND "renoteId" IS NULL AND visibility IN ('public', 'home') ORDER BY id DESC LIMIT 20`,
      [user.id],
    )).rows.filter((n) => {
      const createdAt = dateOf(String(n.id));
      return !shouldHideNoteByTime(num(user.makeNotesHiddenBefore), createdAt) && !shouldHideNoteByTime(num(user.makeNotesFollowersOnlyBefore), createdAt);
    });
    const fileIds = [...new Set(notes.flatMap((n) => (n.fileIds as string[] | null) ?? []))];
    const files = fileIds.length
      ? (await c.query(`SELECT id, type, url, "webpublicUrl" FROM drive_file WHERE id = ANY($1::varchar[])`, [fileIds])).rows
      : [];
    return { user, profile, notes, files };
  });
  if (!data) return null;
  const { user, profile, notes, files } = data;

  const uname = String(user.username);
  const author = { link: `${base}/@${uname}`, name: (user.name as string | null) ?? uname };
  const avatar = user.avatarId == null ? null : ((user.avatarUrl as string | null) ?? null);
  const identicon = `${base}/identicon/${uname.toLowerCase()}@${(user.host as string | null) ?? config.host}`;
  const feed = new Feed({
    id: author.link,
    title: `${author.name} (@${uname}@${config.host})`,
    updated: notes.length !== 0 ? dateOf(String(notes[0]!.id)) : undefined,
    generator: "Misskey",
    description: `${Number(user.notesCount ?? 0)} Notes, ${profile.followingVisibility === "public" ? Number(user.followingCount ?? 0) : "?"} Following, ${profile.followersVisibility === "public" ? Number(user.followersCount ?? 0) : "?"} Followers${profile.description ? ` · ${String(profile.description)}` : ""}`,
    link: author.link,
    image: avatar ?? identicon,
    feedLinks: { json: `${author.link}.json`, atom: `${author.link}.atom` },
    author,
    copyright: author.name,
  });
  for (const note of notes) {
    const ids = (note.fileIds as string[] | null) ?? [];
    // upstream: findBy({ id: In(fileIds) }) then the first image (DB order, not the note's)
    const file = files.find((f) => ids.includes(String(f.id)) && String(f.type).startsWith("image/"));
    const text = (note.text as string | null) ?? null;
    feed.addItem({
      title: `New note by ${author.name}`,
      link: `${base}/notes/${note.id}`,
      date: dateOf(String(note.id)),
      description: (note.cw as string | null) ?? undefined,
      content: text ? (mfmToHtml(mfm.parse(text), base, parseMentionedRemoteUsers(note.mentionedRemoteUsers)) ?? undefined) : undefined,
      // DriveFileEntityService.getPublicUrl: webpublic when there is one
      image: file ? String(file.webpublicUrl ?? file.url) : undefined,
    });
  }
  return feed;
}

/** GET /@user.atom|rss|json → the feed with upstream's content types, 404 otherwise. */
export async function serveFeed(env: ApiEnv, acct: string, kind: "atom" | "rss" | "json"): Promise<Response> {
  const feed = env.HYPERDRIVE?.connectionString ? await buildFeed(env, decodeURIComponent(acct)) : null;
  if (!feed) return new Response(null, { status: 404 });
  if (kind === "atom") return new Response(feed.atom1(), { headers: { "content-type": "application/atom+xml; charset=utf-8" } });
  if (kind === "rss") return new Response(feed.rss2(), { headers: { "content-type": "application/rss+xml; charset=utf-8" } });
  return new Response(feed.json1(), { headers: { "content-type": "application/json; charset=utf-8" } });
}
