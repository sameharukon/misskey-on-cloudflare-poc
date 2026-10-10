/**
 * The parts of upstream UserEntityService.pack (schema UserLite) that need the database:
 * avatar decorations resolved against the catalog, `makeNotes*Before`, the remote `instance`
 * summary, the remote custom `emojis` map, `onlineStatus` inputs and `badgeRoles`.
 * Sources are filled in place (`PackUserSource.lite`) and packUserLite emits them.
 * Newer columns are read through `to_jsonb(u)` so older / test schemas still work.
 */

import type { PackUserSource } from "../../packers/src/index.js";
import type { ApiEnv } from "./env.js";
import { isolateCached, META_ISOLATE_TTL_MS, type PgQueryable } from "./pg.js";
import { conditionalRoles, evalCond, type CondUser } from "./role-cond.js";

/** Columns for a UserLite source; `u` is the `"user"` alias. */
export const USER_LITE_COLS = `u.id, u.username, u.name, u.host, u."avatarId", u."avatarUrl", u."avatarBlurhash",
  u."isBot", u."isCat", u."requireSigninToViewContents", u."hideOnlineStatus", u."lastActiveDate", u."isSuspended", to_jsonb(u) AS _u`;

/** The raw meta row (newer columns included), or {} when unreadable. */
export async function metaRowPg(c: PgQueryable): Promise<Record<string, unknown>> {
  try {
    return await isolateCached(
      c,
      "meta:row",
      META_ISOLATE_TTL_MS,
      async () => ((await c.query(`SELECT to_jsonb(m) AS j FROM meta m ORDER BY id DESC LIMIT 1`)).rows[0]?.j as Record<string, unknown> | undefined) ?? {},
      { clone: true },
    );
  } catch {
    return {};
  }
}

const parseEmojiStr = (s: string, ownerHost: string | null, selfHost: string | null): { name: string | null; host: string | null } => {
  const m = /^([-\w]+)(?:@([\w.-]+))?$/.exec(s);
  if (!m) return { name: null, host: null };
  const src = m[2];
  const host = src === "." ? null : src === undefined ? ownerHost : selfHost && src.toLowerCase() === selfHost ? null : src || ownerHost;
  return { name: m[1]!, host: host ? host.toLowerCase() : null };
};

/**
 * upstream CustomEmojiService.populateEmojis: names (`name` or `name@host`) of remote custom
 * emojis → url (publicUrl || originalUrl); local and unknown emojis are left out.
 */
export async function populateEmojisPg(
  c: PgQueryable,
  requests: { names: string[]; host: string | null }[],
  selfHost: string | null = null,
): Promise<Map<string, string>[]> {
  const parsed = requests.map((r) => r.names.map((n) => ({ n, ...parseEmojiStr(n, r.host, selfHost) })));
  const keys = new Set<string>();
  for (const list of parsed) for (const e of list) if (e.name && e.host) keys.add(`${e.name} ${e.host}`);
  const urls = new Map<string, string>();
  if (keys.size) {
    const names = [...keys].map((k) => k.split(" ")[0]!);
    const hosts = [...keys].map((k) => k.split(" ")[1]!);
    try {
      const r = await c.query(
        `SELECT e.name, e.host, e."publicUrl", e."originalUrl" FROM emoji e
         JOIN unnest($1::varchar[], $2::varchar[]) AS q(name, host) ON q.name = e.name AND q.host = e.host`,
        [names, hosts],
      );
      for (const row of r.rows) urls.set(`${row.name} ${row.host}`, String(row.publicUrl || row.originalUrl || ""));
    } catch {
      /* no emoji table */
    }
  }
  return parsed.map((list) => {
    const out = new Map<string, string>();
    for (const e of list) {
      const u = e.name && e.host ? urls.get(`${e.name} ${e.host}`) : undefined;
      if (u != null) out.set(e.n, u);
    }
    return out;
  });
}

/** row (USER_LITE_COLS or a plain user row) → PackUserSource, keeping the jsonb extras. */
export function rowToUserSource(row: Record<string, unknown>): PackUserSource {
  const ux = (row._u && typeof row._u === "object" ? row._u : row) as Record<string, unknown>;
  const lad = row.lastActiveDate ?? ux.lastActiveDate;
  return {
    id: String(row.id),
    username: String(row.username),
    name: (row.name as string | null) ?? null,
    host: (row.host as string | null) ?? null,
    avatarId: (row.avatarId as string | null) ?? null,
    avatarUrl: (row.avatarUrl as string | null) ?? null,
    avatarBlurhash: (row.avatarBlurhash as string | null) ?? null,
    isBot: Boolean(row.isBot),
    isCat: Boolean(row.isCat),
    requireSigninToViewContents: Boolean(row.requireSigninToViewContents ?? ux.requireSigninToViewContents),
    hideOnlineStatus: Boolean(row.hideOnlineStatus ?? ux.hideOnlineStatus),
    lastActiveDate: lad ? new Date(String(lad)) : null,
    isSuspended: Boolean(row.isSuspended ?? ux.isSuspended),
    avatarDecorations: Array.isArray(ux.avatarDecorations) ? (ux.avatarDecorations as PackUserSource["avatarDecorations"]) : [],
    emojis: Array.isArray(ux.emojis) ? (ux.emojis as string[]) : [],
    makeNotesFollowersOnlyBefore: typeof ux.makeNotesFollowersOnlyBefore === "number" ? ux.makeNotesFollowersOnlyBefore : null,
    makeNotesHiddenBefore: typeof ux.makeNotesHiddenBefore === "number" ? ux.makeNotesHiddenBefore : null,
    condUser: {
      id: String(row.id),
      host: (row.host as string | null) ?? null,
      isSuspended: Boolean(ux.isSuspended),
      isLocked: Boolean(ux.isLocked),
      isBot: Boolean(ux.isBot),
      isCat: Boolean(ux.isCat),
      isExplorable: ux.isExplorable !== false,
      followersCount: Number(ux.followersCount ?? 0),
      followingCount: Number(ux.followingCount ?? 0),
      notesCount: Number(ux.notesCount ?? 0),
    },
  } as PackUserSource;
}

/** Assigned roles read along with a user row (getUserSourcesPg), for enrichUserSourcesPg's badges. */
const assignedRolesOf = new WeakMap<PackUserSource, Record<string, unknown>[]>();

type InstanceSummary = Record<string, unknown>;
const INSTANCE_SUMMARY_TTL_MS = 60_000;
const instanceSummaries = new Map<string, { summary: InstanceSummary | null; at: number }>();

function rememberInstance(host: string, summary: InstanceSummary | null): void {
  instanceSummaries.delete(host);
  if (instanceSummaries.size >= 5000) instanceSummaries.delete(instanceSummaries.keys().next().value!);
  instanceSummaries.set(host, { summary, at: Date.now() });
}

/** Tests: forget the cached instance summaries. */
export function resetInstanceSummaryCache(): void {
  instanceSummaries.clear();
}

/**
 * Fill `lite` (the database-backed UserLite fields) of every source. `meId` decides whether
 * non-public badge roles are shown (upstream: iAmModerator).
 */
export async function enrichUserSourcesPg(
  env: ApiEnv,
  c: PgQueryable,
  users: PackUserSource[],
  meId: string | null | undefined,
  meta?: Record<string, unknown>,
): Promise<void> {
  if (!users.length) return;
  const m = meta ?? (await metaRowPg(c));
  const selfHost = env.INSTANCE_URL ? new URL(env.INSTANCE_URL).host.toLowerCase() : null;

  // avatar decorations (AvatarDecorationService.getAll)
  const decoIds = [...new Set(users.flatMap((u) => (u.avatarDecorations ?? []).map((d) => d.id)))];
  const decoUrls = new Map<string, string>();
  if (decoIds.length) {
    try {
      // the whole catalog, cached per isolate as upstream's AvatarDecorationService cache
      const all = await isolateCached(c, "avatar_decoration:all", META_ISOLATE_TTL_MS, async () =>
        (await c.query(`SELECT id, url FROM avatar_decoration`)).rows.map((r) => [String(r.id), String(r.url)] as const));
      const wanted = new Set(decoIds);
      for (const [id, url] of all) if (wanted.has(id)) decoUrls.set(id, url);
    } catch {
      /* no table */
    }
  }

  const hosts = [...new Set(users.map((u) => u.host).filter((h): h is string => Boolean(h)))];
  const instances = new Map<string, Record<string, unknown>>();
  // remote instance summaries (FederatedInstanceService.federatedInstanceCache), kept per isolate
  // for a minute
  const now = Date.now();
  for (const h of hosts) {
    const hit = instanceSummaries.get(h);
    if (hit && now - hit.at < INSTANCE_SUMMARY_TTL_MS) {
      if (hit.summary) instances.set(h, hit.summary);
    }
  }
  const missing = hosts.filter((h) => {
    const hit = instanceSummaries.get(h);
    return !hit || now - hit.at >= INSTANCE_SUMMARY_TTL_MS;
  });
  if (missing.length) {
    try {
      for (const h of missing) rememberInstance(h, null);
      for (const r of (await c.query(`SELECT host, to_jsonb(i) AS j FROM instance i WHERE host = ANY($1::varchar[])`, [missing])).rows) {
        const j = r.j as Record<string, unknown>;
        rememberInstance(String(r.host), {
          name: j.name ?? null,
          softwareName: j.softwareName ?? null,
          softwareVersion: j.softwareVersion ?? null,
          iconUrl: j.iconUrl ?? null,
          faviconUrl: j.faviconUrl ?? null,
          themeColor: j.themeColor ?? null,
        });
        instances.set(String(r.host), instanceSummaries.get(String(r.host))!.summary!);
      }
    } catch {
      /* no table */
    }
  }

  const emojiMaps = await populateEmojisPg(c, users.map((u) => ({ names: u.emojis ?? [], host: u.host })), selfHost);

  // badge roles (RoleService.getUserBadgeRoles), local users unless showRoleBadgesOfRemoteUsers
  const showRemote = m.showRoleBadgesOfRemoteUsers === true;
  const badgeTargets = users.filter((u) => showRemote || u.host == null).map((u) => u.id);
  const badges = new Map<string, { name: string; iconUrl: string | null; displayOrder: number; isPublic: boolean }[]>();
  let iAmModerator = false;
  if (badgeTargets.length) {
    try {
      // read with the user rows when getUserSourcesPg could (`assignedRoles`), else here
      const preloaded = users.filter((u) => badgeTargets.includes(u.id));
      const assignedRows: Record<string, unknown>[] = preloaded.every((u) => assignedRolesOf.has(u))
        ? preloaded.flatMap((u) => assignedRolesOf.get(u)!.map((r) => ({ ...r, userId: u.id })))
        : (await c.query(
            `SELECT ra."userId", r.id, r.name, r."iconUrl", r."displayOrder", r."isPublic", r."asBadge"
             FROM role_assignment ra JOIN role r ON r.id = ra."roleId"
             WHERE ra."userId" = ANY($1::varchar[]) AND (ra."expiresAt" IS NULL OR ra."expiresAt" > now())`,
            [badgeTargets],
          )).rows;
      const assignedIds = new Map<string, string[]>();
      for (const r of assignedRows) {
        const uid = String(r.userId);
        assignedIds.set(uid, [...(assignedIds.get(uid) ?? []), String(r.id)]);
        if (!r.asBadge) continue;
        badges.set(uid, [...(badges.get(uid) ?? []), { name: String(r.name ?? ""), iconUrl: (r.iconUrl as string | null) ?? null, displayOrder: Number(r.displayOrder ?? 0), isPublic: Boolean(r.isPublic) }]);
      }
      // the isolate-cached conditional roles, not a query per pack
      const cond = (await conditionalRoles(c)).filter((r) => r.asBadge === true);
      if (cond.length) {
        for (const u of users) {
          if (!badgeTargets.includes(u.id)) continue;
          const cu = (u as { condUser?: CondUser }).condUser;
          if (!cu) continue;
          for (const r of cond) {
            if (evalCond(cu, assignedIds.get(u.id) ?? [], (r.condFormula ?? {}) as Parameters<typeof evalCond>[2])) {
              badges.set(u.id, [...(badges.get(u.id) ?? []), { name: String(r.name ?? ""), iconUrl: (r.iconUrl as string | null) ?? null, displayOrder: Number(r.displayOrder ?? 0), isPublic: Boolean(r.isPublic) }]);
            }
          }
        }
      }
      if (meId && [...badges.values()].some((bs) => bs.some((b) => !b.isPublic))) {
        const { isModeratorPg } = await import("./policies-pg.js");
        iAmModerator = await isModeratorPg(env, c, meId);
      }
    } catch {
      /* no role tables */
    }
  }

  users.forEach((u, i) => {
    u.lite = {
      // `x || undefined` upstream: falsy values are left out of the JSON
      avatarDecorations: (u.avatarDecorations ?? []).filter((d) => decoUrls.has(d.id)).map((d) => ({
        id: d.id,
        ...(d.angle ? { angle: d.angle } : {}),
        ...(d.flipH ? { flipH: d.flipH } : {}),
        ...(d.offsetX ? { offsetX: d.offsetX } : {}),
        ...(d.offsetY ? { offsetY: d.offsetY } : {}),
        url: decoUrls.get(d.id)!,
      })),
      makeNotesFollowersOnlyBefore: u.makeNotesFollowersOnlyBefore ?? undefined,
      makeNotesHiddenBefore: u.makeNotesHiddenBefore ?? undefined,
      instance: u.host ? instances.get(u.host) : undefined,
      emojis: Object.fromEntries(emojiMaps[i]!),
      badgeRoles: showRemote || u.host == null
        ? (badges.get(u.id) ?? [])
            .filter((b) => b.isPublic || iAmModerator)
            .sort((a, b) => b.displayOrder - a.displayOrder)
            .map((b) => ({ name: b.name, iconUrl: b.iconUrl, displayOrder: b.displayOrder }))
        : undefined,
    };
  });
}

/** SELECT + enrich users by id (Map by id; unknown ids are absent). */
export async function getUserSourcesPg(env: ApiEnv, c: PgQueryable, ids: string[], meId: string | null | undefined): Promise<Map<string, PackUserSource>> {
  const uniq = [...new Set(ids.filter(Boolean))];
  const out = new Map<string, PackUserSource>();
  if (!uniq.length) return out;
  // the users' assigned roles come along for the badges (one round trip less per pack);
  // schemas without the role tables (some tests) read the users alone
  const r = await c.query(
    `SELECT ${USER_LITE_COLS},
       (SELECT COALESCE(json_agg(json_build_object('id', r.id, 'name', r.name, 'iconUrl', r."iconUrl", 'displayOrder', r."displayOrder", 'isPublic', r."isPublic", 'asBadge', r."asBadge")), '[]'::json)
        FROM role_assignment ra JOIN role r ON r.id = ra."roleId"
        WHERE ra."userId" = u.id AND (ra."expiresAt" IS NULL OR ra."expiresAt" > now())) AS "_assignedRoles"
     FROM "user" u WHERE u.id = ANY($1::varchar[])`,
    [uniq],
  ).catch(() => c.query(`SELECT ${USER_LITE_COLS} FROM "user" u WHERE u.id = ANY($1::varchar[])`, [uniq]));
  const users = r.rows.map((row) => {
    const u = rowToUserSource(row);
    if (Array.isArray(row._assignedRoles)) assignedRolesOf.set(u, row._assignedRoles as Record<string, unknown>[]);
    return u;
  });
  await enrichUserSourcesPg(env, c, users, meId);
  for (const u of users) out.set(u.id, u);
  return out;
}
