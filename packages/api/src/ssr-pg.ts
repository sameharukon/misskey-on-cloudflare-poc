/**
 * Data for the gateway's server-rendered pages (upstream ClientServerService `/@:user/:sub?` and
 * `/notes/:note`): the packed entity (also the page's `clientCtx`) and the profile fields the
 * page uses that are not in the packed form (noCrawle, preventAiLearning, fields, url).
 * Reached through the `ApiInternal` RPC entrypoint (worker.ts), never from the internet.
 */

import type { ApiEnv } from "./env.js";
import { buildPackConfig } from "./meta-source.js";
import { withHyperdriveClient } from "./pg.js";
import { metaRowPg } from "./user-lite-pg.js";
import { getUserDetailedPg } from "./users-pg.js";
import { getNotePg, packNoteFromPg } from "./notes-pg.js";

type Row = Record<string, unknown>;

export type SsrProfile = {
  noCrawle: boolean;
  preventAiLearning: boolean;
  fields: { name: string; value: string }[];
  url: string | null;
};

export type SsrUser = { user: Row; profile: SsrProfile; federationEnabled: boolean };
export type SsrNote = { note: Row; profile: SsrProfile; federationEnabled: boolean };

function profileOf(p: Row | undefined): SsrProfile {
  return {
    noCrawle: p?.noCrawle === true,
    preventAiLearning: p?.preventAiLearning !== false, // MiUserProfile default: true
    fields: Array.isArray(p?.fields) ? (p!.fields as SsrProfile["fields"]) : [],
    url: typeof p?.url === "string" ? p.url : null,
  };
}

/** meta.ugcVisibilityForVisitor (default `local`) for a user on `host`. */
function visibleToVisitor(meta: Row, host: unknown): boolean {
  const ugc = (meta.ugcVisibilityForVisitor as string | undefined) ?? "local";
  return ugc === "all" || (ugc === "local" && host == null);
}

/** upstream Acct.parse */
function parseAcct(acct: string): { username: string; host: string | null } {
  const a = acct.startsWith("@") ? acct.slice(1) : acct;
  const [username, host] = a.split("@", 2);
  return { username: username!, host: host ?? null };
}

/** `/@:user/:sub?`: null when the page falls back to the base HTML (missing, suspended, hidden from visitors). */
export async function ssrUser(env: ApiEnv, acct: string): Promise<SsrUser | null> {
  if (!env.HYPERDRIVE?.connectionString) return null;
  const { username, host } = parseAcct(acct);
  const found = await withHyperdriveClient(env.HYPERDRIVE, async (c) => {
    const u = (await c.query(
      `SELECT id, host FROM "user" WHERE "usernameLower" = $1 AND ${host == null ? "host IS NULL" : "host = $2"} AND "isSuspended" = FALSE LIMIT 1`,
      host == null ? [username.toLowerCase()] : [username.toLowerCase(), host.toLowerCase()],
    )).rows[0];
    if (!u) return null;
    const meta = await metaRowPg(c);
    if (!visibleToVisitor(meta, u.host)) return null;
    const p = (await c.query(`SELECT to_jsonb(p) AS p FROM user_profile p WHERE "userId" = $1`, [u.id])).rows[0]?.p as Row | undefined;
    return { id: String(u.id), profile: profileOf(p), federationEnabled: (meta.federation ?? "none") !== "none" };
  });
  if (!found) return null;
  const user = await getUserDetailedPg(env, { userId: found.id }, null, buildPackConfig(env));
  if (!user) return null;
  return { user, profile: found.profile, federationEnabled: found.federationEnabled };
}

/** `/notes/:note`: public / home notes whose author does not require sign-in and is visible to visitors. */
export async function ssrNote(env: ApiEnv, noteId: string): Promise<SsrNote | null> {
  if (!env.HYPERDRIVE?.connectionString) return null;
  const note = await getNotePg(env, noteId);
  if (!note || (note.visibility !== "public" && note.visibility !== "home")) return null;
  const ctx = await withHyperdriveClient(env.HYPERDRIVE, async (c) => {
    const u = (await c.query(
      `SELECT COALESCE((to_jsonb(u) ->> 'requireSigninToViewContents')::boolean, FALSE) AS rs FROM "user" u WHERE id = $1`,
      [note.userId],
    )).rows[0];
    if (!u || u.rs === true) return null;
    const meta = await metaRowPg(c);
    if (!visibleToVisitor(meta, note.userHost)) return null;
    const p = (await c.query(`SELECT to_jsonb(p) AS p FROM user_profile p WHERE "userId" = $1`, [note.userId])).rows[0]?.p as Row | undefined;
    return { profile: profileOf(p), federationEnabled: (meta.federation ?? "none") !== "none" };
  });
  if (!ctx) return null;
  const packed = (await packNoteFromPg(env, note, buildPackConfig(env), null)) as unknown as Row;
  return { note: packed, ...ctx };
}

// ---------------------------------------------------------------- other SSR pages and embeds

type Entity = { entity: Row; profile?: SsrProfile; visibility?: string };

async function profileFor(c: import("./pg.js").PgQueryable, userId: unknown): Promise<SsrProfile> {
  return profileOf((await c.query(`SELECT to_jsonb(p) AS p FROM user_profile p WHERE "userId" = $1`, [userId])).rows[0]?.p as Row | undefined);
}

/**
 * The entity behind an upstream SSR page or embed (null → base HTML / plain embed):
 * `page` (`/@:user/pages/:page`, acct + page name), `flash`, `clip` (public only), `galleryPost`,
 * `channel`, `reversiGame` (packDetail), `announcement` (global ones only),
 * `embedUser` (local users, UserLite), `embedNote` (local, not followers / specified, detailed),
 * `embedClip` (any clip, as upstream).
 */
export async function ssrEntity(env: ApiEnv, kind: string, key: string, sub?: string): Promise<Entity | null> {
  if (!env.HYPERDRIVE?.connectionString) return null;
  return withHyperdriveClient(env.HYPERDRIVE, async (c) => {
    switch (kind) {
      case "page": {
        const { username, host } = parseAcct(key);
        const u = (await c.query(
          `SELECT id FROM "user" WHERE "usernameLower" = $1 AND ${host == null ? "host IS NULL" : "host = $2"} LIMIT 1`,
          host == null ? [username.toLowerCase()] : [username.toLowerCase(), host.toLowerCase()],
        )).rows[0];
        if (!u || !sub) return null;
        const p = (await c.query(`SELECT id, visibility FROM page WHERE name = $1 AND "userId" = $2 LIMIT 1`, [sub, u.id])).rows[0];
        if (!p) return null;
        const { packPageById } = await import("./pages-pg.js");
        const entity = await packPageById(env, c, String(p.id), null);
        return entity ? { entity, profile: await profileFor(c, u.id), visibility: String(p.visibility) } : null;
      }
      case "flash": {
        const row = (await c.query(`SELECT * FROM flash WHERE id = $1`, [key])).rows[0];
        if (!row) return null;
        const { packFlashes } = await import("./flash-pg.js");
        const [entity] = await packFlashes(env, c, [row], null);
        return entity ? { entity, profile: await profileFor(c, row.userId) } : null;
      }
      case "clip":
      case "embedClip": {
        const row = (await c.query(`SELECT id, "userId", name, description, "isPublic", "lastClippedAt" FROM clip WHERE id = $1`, [key])).rows[0];
        if (!row || (kind === "clip" && !row.isPublic)) return null;
        const { packClips } = await import("./clips-pg.js");
        const [entity] = await packClips(env, c, [row as never], null, true);
        return entity ? { entity, profile: kind === "clip" ? await profileFor(c, row.userId) : undefined } : null;
      }
      case "galleryPost": {
        const row = (await c.query(`SELECT * FROM gallery_post WHERE id = $1`, [key])).rows[0];
        if (!row) return null;
        const { packPosts } = await import("./gallery-pg.js");
        const [entity] = await packPosts(env, c, [row], null);
        return entity ? { entity, profile: await profileFor(c, row.userId) } : null;
      }
      case "channel": {
        const { getChannelPg, packChannels } = await import("./channels-pg.js");
        const ch = await getChannelPg(c, key);
        if (!ch) return null;
        const [entity] = await packChannels(env, c, [ch], null);
        return entity ? { entity } : null;
      }
      case "reversiGame": {
        const g = (await c.query(
          `SELECT g.id, u1.username AS u1, u2.username AS u2 FROM reversi_game g
           JOIN "user" u1 ON u1.id = g."user1Id" JOIN "user" u2 ON u2.id = g."user2Id" WHERE g.id = $1`,
          [key],
        )).rows[0];
        // the page only reads the two usernames (ReversiGameEntityService.packDetail has more)
        return g ? { entity: { id: String(g.id), user1: { username: String(g.u1) }, user2: { username: String(g.u2) } } } : null;
      }
      case "announcement": {
        const a = (await c.query(`SELECT * FROM announcement WHERE id = $1 AND "userId" IS NULL`, [key])).rows[0];
        if (!a) return null;
        const { packAnnouncement } = await import("./client-endpoints-pg.js");
        return { entity: packAnnouncement(a, null, undefined) };
      }
      case "embedUser": {
        const u = (await c.query(`SELECT id, host FROM "user" WHERE id = $1`, [key])).rows[0];
        if (!u || u.host != null) return null;
        const { packUsers } = await import("./client-endpoints-pg.js");
        const [entity] = (await packUsers(env, [String(u.id)], null, false)) as Row[];
        return entity ? { entity } : null;
      }
      case "embedNote": {
        const note = await getNotePg(env, key);
        if (!note || note.visibility === "specified" || note.visibility === "followers" || note.userHost != null) return null;
        return { entity: (await packNoteFromPg(env, note, buildPackConfig(env), null)) as unknown as Row };
      }
      default:
        return null;
    }
  });
}
