/**
 * Channels (W7.7) on PG (`channel`, `channel_following`, `channel_favorite`, `channel_muting`;
 * upstream schema): channels/create|show|update|follow|unfollow|followed|owned|featured|search|
 * favorite|unfavorite|my-favorites|timeline and channels/mute/create|delete|list.
 *
 * Posting into a channel is handled by notes/create (validation, public + localOnly, stats);
 * the fanout consumer delivers channel notes to the channel's followers' home timelines and to
 * `channel:<id>` stream subscribers. channels/timeline reads PG (`note."channelId"`).
 */

import { genAidx, parseAidxTime } from "../../id/src/index.js";
import type { ApiEnv } from "./env.js";
import { apiErrorResponse, CREDENTIAL_REQUIRED, type ApiErrorBody } from "./errors.js";
import { authenticatePg, extractToken } from "./auth-pg.js";
import { buildPackConfig } from "./meta-source.js";
import { withHyperdriveClient, type PgQueryable } from "./pg.js";
import { hasRolePolicyPg, isModeratorPg } from "./policies-pg.js";
import { listNotes, pagination } from "./client-endpoints-pg.js";
import { likeEscape } from "./clips-pg.js";
import { ROLE_PERMISSION_DENIED } from "./emojis-pg.js";
import { getNotesByIdsPg, packNotesFromPg } from "./notes-pg.js";
import { clientError as err, errorResponse as fail, hd, invalidParam as bad } from "./handler-kit.js";

type Ctx = { hasCredential: boolean; request: Request };
type Body = Record<string, unknown>;
export type ChannelHandler = (env: ApiEnv, body: Body, ctx: Ctx) => Promise<Response | unknown>;

const noSuchChannel = (id: string, message = "No such channel.") => err("NO_SUCH_CHANNEL", id, message);
const E = {
  createNoSuchFile: err("NO_SUCH_FILE", "cd1e9f3e-5a12-4ab4-96f6-5d0a2cc32050", "No such file."),
  favorite: noSuchChannel("4938f5f3-6167-4c04-9149-6607b7542861"),
  follow: noSuchChannel("c0031718-d573-4e85-928e-10039f1fbb68"),
  alreadyFollowing: err("ALREADY_FOLLOWING", "7db31665-651e-40c1-8e6e-28e9ad829a2d", "You are already following that channel."),
  show: noSuchChannel("6f6c314b-7486-4897-8966-c04a66a02923"),
  timeline: noSuchChannel("4d0eeeba-a02c-4c3c-9966-ef60d38d2e7f"),
  unfavorite: noSuchChannel("353c68dd-131a-476c-aa99-88a345e83668"),
  unfollow: noSuchChannel("19959ee9-0153-4c51-bbd9-a98c49dc59d6"),
  update: noSuchChannel("f9c5467f-d492-4c3c-9a8d-a70dacc86512"),
  accessDenied: err("ACCESS_DENIED", "1fb7cb09-d46a-4fdf-b8df-057788cce513", "You do not have edit privilege of the channel."),
  updateNoSuchFile: err("NO_SUCH_FILE", "e86c14a4-0da2-4032-8df3-e737a04c7f3b", "No such file."),
  muteNoSuchChannel: noSuchChannel("7174361e-d58f-31d6-2e7c-6fb830786a3f", "No such Channel."),
  alreadyMuting: err("ALREADY_MUTING_CHANNEL", "5a251978-769a-da44-3e89-3931e43bb592", "You are already muting that user."),
  expiresAtIsPast: err("EXPIRES_AT_IS_PAST", "42b32236-df2c-a45f-fdbf-def67268f749", 'Cannot set past date to "expiresAt".'),
  unmuteNoSuchChannel: noSuchChannel("e7998769-6e94-d9c2-6b8f-94a527314aba", "No such Channel."),
  notMuting: err("NOT_MUTING_CHANNEL", "14d55962-6ea8-d990-1333-d6bef78dc2ab", "You are not muting that channel."),
};

async function auth(env: ApiEnv, body: Body, ctx: Ctx): Promise<string | null | "invalid"> {
  if (!ctx.hasCredential) return null;
  const token = extractToken(ctx.request, body);
  if (!token) return null;
  return (await authenticatePg(env, token))?.user.id ?? "invalid";
}
/** requireCredential: true */
async function authReq(env: ApiEnv, body: Body, ctx: Ctx): Promise<string | null> {
  const me = await auth(env, body, ctx);
  return me === "invalid" ? null : me;
}

const str = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : undefined);
const noContent = () => new Response(null, { status: 204 });
const limitOf = (body: Body, def: number) => Math.max(1, Math.min(100, Math.floor(typeof body.limit === "number" ? body.limit : def)));
const nullableBool = (v: unknown) => v === undefined || v === null || typeof v === "boolean";
const validColor = (v: unknown) => typeof v === "string" && v.length >= 1 && v.length <= 16;

export type ChannelRow = {
  id: string;
  lastNotedAt: string | Date | null;
  userId: string | null;
  name: string;
  description: string | null;
  bannerId: string | null;
  notesCount: number;
  usersCount: number;
  pinnedNoteIds: string[];
  color: string;
  isArchived: boolean;
  isSensitive: boolean;
  allowRenoteToExternal: boolean;
};

const CHANNEL_COLS = `id, "lastNotedAt", "userId", name, description, "bannerId", "notesCount", "usersCount", "pinnedNoteIds", color, "isArchived", "isSensitive", "allowRenoteToExternal"`;

export async function getChannelPg(c: PgQueryable, id: string, opts: { activeOnly?: boolean } = {}): Promise<ChannelRow | null> {
  const r = await c.query(
    `SELECT ${CHANNEL_COLS} FROM channel WHERE id = $1${opts.activeOnly ? ` AND "isArchived" = FALSE` : ""}`,
    [id],
  );
  return (r.rows[0] as ChannelRow | undefined) ?? null;
}

/** ChannelMutingService.list: unexpired mutes of the user. */
export async function mutedChannelIds(c: PgQueryable, userId: string): Promise<string[]> {
  const r = await c.query(
    `SELECT "channelId" FROM channel_muting WHERE "userId" = $1 AND ("expiresAt" IS NULL OR "expiresAt" > now())`,
    [userId],
  );
  return r.rows.map((x) => String(x.channelId));
}

/** ChannelEntityService.packMany (keeps the input order; `packMany` callers sort by id themselves). */
export async function packChannels(env: ApiEnv, c: PgQueryable, channels: ChannelRow[], me: string | null, detailed = false): Promise<Record<string, unknown>[]> {
  if (!channels.length) return [];
  const ids = channels.map((x) => x.id);
  const banners = new Map<string, string>();
  const bannerIds = channels.map((x) => x.bannerId).filter((x): x is string => Boolean(x));
  if (bannerIds.length) {
    const r = await c.query(`SELECT id, url, "webpublicUrl" FROM drive_file WHERE id = ANY($1::varchar[])`, [bannerIds]);
    for (const row of r.rows) banners.set(String(row.id), String(row.webpublicUrl ?? row.url));
  }
  const following = new Set<string>();
  const favorited = new Set<string>();
  const muting = new Set<string>();
  if (me) {
    for (const r of (await c.query(`SELECT "followeeId" AS id FROM channel_following WHERE "followerId" = $1 AND "followeeId" = ANY($2::varchar[])`, [me, ids])).rows) following.add(String(r.id));
    for (const r of (await c.query(`SELECT "channelId" AS id FROM channel_favorite WHERE "userId" = $1 AND "channelId" = ANY($2::varchar[])`, [me, ids])).rows) favorited.add(String(r.id));
    for (const r of (await c.query(`SELECT "channelId" AS id FROM channel_muting WHERE "userId" = $1 AND "channelId" = ANY($2::varchar[])`, [me, ids])).rows) muting.add(String(r.id));
  }
  let pinned = new Map<string, unknown>();
  if (detailed) {
    const pinIds = [...new Set(channels.flatMap((x) => x.pinnedNoteIds ?? []))];
    if (pinIds.length) {
      const notes = await getNotesByIdsPg(env, pinIds);
      const packed = await packNotesFromPg(env, notes, buildPackConfig(env), me);
      pinned = new Map(packed.map((n) => [n.id, n]));
    }
  }
  return channels.map((ch) => ({
    id: ch.id,
    createdAt: (parseAidxTime(ch.id) ?? new Date(0)).toISOString(),
    lastNotedAt: ch.lastNotedAt ? new Date(ch.lastNotedAt).toISOString() : null,
    name: ch.name,
    description: ch.description ?? null,
    userId: ch.userId ?? null,
    bannerUrl: ch.bannerId ? (banners.get(ch.bannerId) ?? null) : null,
    bannerId: ch.bannerId ?? null,
    pinnedNoteIds: ch.pinnedNoteIds ?? [],
    color: ch.color,
    isArchived: Boolean(ch.isArchived),
    usersCount: Number(ch.usersCount ?? 0),
    notesCount: Number(ch.notesCount ?? 0),
    isSensitive: Boolean(ch.isSensitive),
    allowRenoteToExternal: Boolean(ch.allowRenoteToExternal),
    ...(me ? { isFollowing: following.has(ch.id), isFavorited: favorited.has(ch.id), isMuting: muting.has(ch.id), hasUnreadNote: false } : {}),
    // upstream sorts by position in pinnedNoteIds; ids that no longer resolve are dropped
    ...(detailed ? { pinnedNotes: (ch.pinnedNoteIds ?? []).map((id) => pinned.get(id)).filter(Boolean) } : {}),
  }));
}

async function packOne(env: ApiEnv, c: PgQueryable, ch: ChannelRow, me: string | null, detailed = false) {
  return (await packChannels(env, c, [ch], me, detailed))[0];
}

async function ownFile(c: PgQueryable, fileId: string, userId: string): Promise<boolean> {
  return (await c.query(`SELECT 1 FROM drive_file WHERE id = $1 AND "userId" = $2`, [fileId, userId])).rows.length > 0;
}

// ---------------------------------------------------------------- create / show / update

const channelsCreate: ChannelHandler = async (env, body, ctx) => {
  const me = await authReq(env, body, ctx);
  if (!me) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  if (typeof body.name !== "string" || body.name.length < 1 || body.name.length > 128) return bad();
  if (body.description != null && (typeof body.description !== "string" || body.description.length > 2048)) return bad();
  if (body.bannerId != null && typeof body.bannerId !== "string") return bad();
  if (body.color !== undefined && !validColor(body.color)) return bad();
  if (!nullableBool(body.isSensitive) || !nullableBool(body.allowRenoteToExternal)) return bad();
  return withHyperdriveClient(hd(env), async (c) => {
    if (!(await hasRolePolicyPg(env, c, me, "canCreateChannel"))) return apiErrorResponse(ROLE_PERMISSION_DENIED, 403);
    if (typeof body.bannerId === "string" && !(await ownFile(c, body.bannerId, me))) return fail(E.createNoSuchFile);
    const id = genAidx(Date.now());
    await c.query(
      `INSERT INTO channel (id, "userId", name, description, "bannerId", "isSensitive", color, "allowRenoteToExternal")
       VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, '#86b300'), $8)`,
      [id, me, body.name, (body.description as string | null | undefined) ?? null, (body.bannerId as string | null | undefined) ?? null,
        body.isSensitive ?? false, (body.color as string | undefined) ?? null, body.allowRenoteToExternal ?? true],
    );
    return packOne(env, c, (await getChannelPg(c, id))!, me);
  });
};

const channelsShow: ChannelHandler = async (env, body, ctx) => {
  const me = await auth(env, body, ctx);
  if (me === "invalid") return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  const channelId = str(body.channelId);
  if (!channelId) return bad();
  return withHyperdriveClient(hd(env), async (c) => {
    const ch = await getChannelPg(c, channelId);
    if (!ch) return fail(E.show);
    return packOne(env, c, ch, me, true);
  });
};

const channelsUpdate: ChannelHandler = async (env, body, ctx) => {
  const me = await authReq(env, body, ctx);
  if (!me) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  const channelId = str(body.channelId);
  if (!channelId) return bad();
  if (body.name !== undefined && (typeof body.name !== "string" || body.name.length < 1 || body.name.length > 128)) return bad();
  if (body.description != null && (typeof body.description !== "string" || body.description.length > 2048)) return bad();
  if (body.bannerId != null && typeof body.bannerId !== "string") return bad();
  if (body.color !== undefined && !validColor(body.color)) return bad();
  if (body.pinnedNoteIds !== undefined && !(Array.isArray(body.pinnedNoteIds) && body.pinnedNoteIds.every((x) => typeof x === "string"))) return bad();
  if (!nullableBool(body.isArchived) || !nullableBool(body.isSensitive) || !nullableBool(body.allowRenoteToExternal)) return bad();
  return withHyperdriveClient(hd(env), async (c) => {
    const ch = await getChannelPg(c, channelId);
    if (!ch) return fail(E.update);
    if (ch.userId !== me && !(await isModeratorPg(env, c, me))) return fail(E.accessDenied);
    if (typeof body.bannerId === "string" && !(await ownFile(c, body.bannerId, me))) return fail(E.updateNoSuchFile);
    const sets: string[] = [];
    const params: unknown[] = [];
    const set = (col: string, v: unknown, cast = "") => {
      params.push(v);
      sets.push(`"${col}" = $${params.length}${cast}`);
    };
    if (body.name !== undefined) set("name", body.name);
    if (body.description !== undefined) set("description", body.description);
    if (body.pinnedNoteIds !== undefined) set("pinnedNoteIds", body.pinnedNoteIds, "::varchar[]");
    if (body.color !== undefined) set("color", body.color);
    if (typeof body.isArchived === "boolean") set("isArchived", body.isArchived);
    // upstream only writes bannerId when a new banner is given (bannerId: null leaves it as is)
    if (typeof body.bannerId === "string") set("bannerId", body.bannerId);
    if (typeof body.isSensitive === "boolean") set("isSensitive", body.isSensitive);
    if (typeof body.allowRenoteToExternal === "boolean") set("allowRenoteToExternal", body.allowRenoteToExternal);
    if (sets.length) {
      params.push(ch.id);
      await c.query(`UPDATE channel SET ${sets.join(", ")} WHERE id = $${params.length}`, params);
    }
    return packOne(env, c, (await getChannelPg(c, ch.id))!, me);
  });
};

// ---------------------------------------------------------------- follow / favorite

function simple(errNoSuch: ApiErrorBody, run: (c: PgQueryable, me: string, ch: ChannelRow) => Promise<Response | null>): ChannelHandler {
  return async (env, body, ctx) => {
    const me = await authReq(env, body, ctx);
    if (!me) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
    const channelId = str(body.channelId);
    if (!channelId) return bad();
    return withHyperdriveClient(hd(env), async (c) => {
      const ch = await getChannelPg(c, channelId);
      if (!ch) return fail(errNoSuch);
      return (await run(c, me, ch)) ?? noContent();
    });
  };
}

const channelsFollow = simple(E.follow, async (c, me, ch) => {
  const r = await c.query(
    `INSERT INTO channel_following (id, "followerId", "followeeId") VALUES ($1, $2, $3) ON CONFLICT ("followerId", "followeeId") DO NOTHING RETURNING id`,
    [genAidx(Date.now()), me, ch.id],
  );
  return r.rows.length ? null : fail(E.alreadyFollowing);
});

const channelsUnfollow = simple(E.unfollow, async (c, me, ch) => {
  await c.query(`DELETE FROM channel_following WHERE "followerId" = $1 AND "followeeId" = $2`, [me, ch.id]);
  return null;
});

// upstream inserts without a duplicate check: a second favorite is a unique-key error (INTERNAL_ERROR)
const channelsFavorite = simple(E.favorite, async (c, me, ch) => {
  await c.query(`INSERT INTO channel_favorite (id, "userId", "channelId") VALUES ($1, $2, $3)`, [genAidx(Date.now()), me, ch.id]);
  return null;
});

const channelsUnfavorite = simple(E.unfavorite, async (c, me, ch) => {
  await c.query(`DELETE FROM channel_favorite WHERE "userId" = $1 AND "channelId" = $2`, [me, ch.id]);
  return null;
});

// ---------------------------------------------------------------- lists

const SELECT_CH = (alias: string) => CHANNEL_COLS.split(", ").map((col) => `${alias}.${col}`).join(", ");

const channelsFollowed: ChannelHandler = async (env, body, ctx) => {
  const me = await authReq(env, body, ctx);
  if (!me) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  return withHyperdriveClient(hd(env), async (c) => {
    const params: unknown[] = [me];
    // upstream paginates channel_following on followeeId (the channel id)
    const pg = pagination(body, params, `f."followeeId"`);
    params.push(limitOf(body, 5));
    const r = await c.query(
      `SELECT ${SELECT_CH("ch")} FROM channel_following f JOIN channel ch ON ch.id = f."followeeId"
       WHERE ${[`f."followerId" = $1`, ...pg.where].join(" AND ")} ORDER BY f."followeeId" ${pg.order} LIMIT $${params.length}`,
      params,
    );
    return packChannels(env, c, r.rows as ChannelRow[], me);
  });
};

const channelsOwned: ChannelHandler = async (env, body, ctx) => {
  const me = await authReq(env, body, ctx);
  if (!me) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  return withHyperdriveClient(hd(env), async (c) => {
    const params: unknown[] = [me];
    const pg = pagination(body, params, "ch.id");
    params.push(limitOf(body, 5));
    const r = await c.query(
      `SELECT ${SELECT_CH("ch")} FROM channel ch
       WHERE ${[`ch."userId" = $1`, `ch."isArchived" = FALSE`, ...pg.where].join(" AND ")} ORDER BY ch.id ${pg.order} LIMIT $${params.length}`,
      params,
    );
    return packChannels(env, c, r.rows as ChannelRow[], me);
  });
};

const channelsFeatured: ChannelHandler = async (env, body, ctx) => {
  const me = await auth(env, body, ctx);
  if (me === "invalid") return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  return withHyperdriveClient(hd(env), async (c) => {
    const r = await c.query(
      `SELECT ${CHANNEL_COLS} FROM channel WHERE "lastNotedAt" IS NOT NULL AND "isArchived" = FALSE ORDER BY "lastNotedAt" DESC LIMIT 10`,
    );
    return packChannels(env, c, r.rows as ChannelRow[], me);
  });
};

const channelsSearch: ChannelHandler = async (env, body, ctx) => {
  const me = await auth(env, body, ctx);
  if (me === "invalid") return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  if (typeof body.query !== "string") return bad();
  if (body.type !== undefined && body.type !== "nameAndDescription" && body.type !== "nameOnly") return bad();
  return withHyperdriveClient(hd(env), async (c) => {
    const params: unknown[] = [];
    const pg = pagination(body, params, "ch.id");
    const w = [`ch."isArchived" = FALSE`, ...pg.where];
    if (body.query !== "") {
      params.push(`%${likeEscape(body.query as string)}%`);
      const q = `$${params.length}`;
      w.push(body.type === "nameOnly" ? `ch.name ILIKE ${q}` : `(ch.name ILIKE ${q} OR ch.description ILIKE ${q})`);
    }
    params.push(limitOf(body, 5));
    const r = await c.query(
      `SELECT ${SELECT_CH("ch")} FROM channel ch WHERE ${w.join(" AND ")} ORDER BY ch.id ${pg.order} LIMIT $${params.length}`,
      params,
    );
    return packChannels(env, c, r.rows as ChannelRow[], me);
  });
};

const channelsMyFavorites: ChannelHandler = async (env, body, ctx) => {
  const me = await authReq(env, body, ctx);
  if (!me) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  return withHyperdriveClient(hd(env), async (c) => {
    const r = await c.query(
      `SELECT ${SELECT_CH("ch")} FROM channel_favorite f JOIN channel ch ON ch.id = f."channelId" WHERE f."userId" = $1 ORDER BY f.id`,
      [me],
    );
    return packChannels(env, c, r.rows as ChannelRow[], me);
  });
};

// ---------------------------------------------------------------- timeline

/** upstream channels/timeline (timelines-pg.ts) */
const channelsTimeline: ChannelHandler = async (env, body, ctx) => {
  const { channelTimelinePg } = await import("./timelines-pg.js");
  return channelTimelinePg(env, body, ctx);
};

// ---------------------------------------------------------------- mute

const muteCreate: ChannelHandler = async (env, body, ctx) => {
  const me = await authReq(env, body, ctx);
  if (!me) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  const channelId = str(body.channelId);
  if (!channelId || (body.expiresAt != null && typeof body.expiresAt !== "number")) return bad();
  return withHyperdriveClient(hd(env), async (c) => {
    const ch = await getChannelPg(c, channelId);
    if (!ch) return fail(E.muteNoSuchChannel);
    if ((await mutedChannelIds(c, me)).includes(ch.id)) return fail(E.alreadyMuting);
    const expiresAt = typeof body.expiresAt === "number" && body.expiresAt ? body.expiresAt : null;
    if (expiresAt != null && expiresAt <= Date.now()) return fail(E.expiresAtIsPast);
    // an expired row may still be there; replace it
    await c.query(`DELETE FROM channel_muting WHERE "userId" = $1 AND "channelId" = $2`, [me, ch.id]);
    await c.query(`INSERT INTO channel_muting (id, "userId", "channelId", "expiresAt") VALUES ($1, $2, $3, $4)`, [
      genAidx(Date.now()), me, ch.id, expiresAt != null ? new Date(expiresAt).toISOString() : null,
    ]);
    return noContent();
  });
};

const muteDelete: ChannelHandler = async (env, body, ctx) => {
  const me = await authReq(env, body, ctx);
  if (!me) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  const channelId = str(body.channelId);
  if (!channelId) return bad();
  return withHyperdriveClient(hd(env), async (c) => {
    const ch = await getChannelPg(c, channelId);
    if (!ch) return fail(E.unmuteNoSuchChannel);
    if (!(await mutedChannelIds(c, me)).includes(ch.id)) return fail(E.notMuting);
    await c.query(`DELETE FROM channel_muting WHERE "userId" = $1 AND "channelId" = $2`, [me, ch.id]);
    return noContent();
  });
};

const muteList: ChannelHandler = async (env, body, ctx) => {
  const me = await authReq(env, body, ctx);
  if (!me) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  return withHyperdriveClient(hd(env), async (c) => {
    const ids = await mutedChannelIds(c, me);
    if (!ids.length) return [];
    // upstream packMany sorts by id
    const r = await c.query(`SELECT ${CHANNEL_COLS} FROM channel WHERE id = ANY($1::varchar[]) ORDER BY id`, [ids]);
    return packChannels(env, c, r.rows as ChannelRow[], me);
  });
};

// ---------------------------------------------------------------- registry

function pgOnly(h: ChannelHandler): ChannelHandler {
  return async (env, body, ctx) => {
    if (!env.HYPERDRIVE?.connectionString) {
      return apiErrorResponse({ message: "Hyperdrive required.", code: "HYPERDRIVE_UNBOUND", id: "00000000-0000-4000-8000-0000000000b1", kind: "server" }, 501);
    }
    return h(env, body, ctx);
  };
}

const RAW: Record<string, ChannelHandler> = {
  "channels/create": channelsCreate,
  "channels/show": channelsShow,
  "channels/update": channelsUpdate,
  "channels/follow": channelsFollow,
  "channels/unfollow": channelsUnfollow,
  "channels/favorite": channelsFavorite,
  "channels/unfavorite": channelsUnfavorite,
  "channels/followed": channelsFollowed,
  "channels/owned": channelsOwned,
  "channels/featured": channelsFeatured,
  "channels/search": channelsSearch,
  "channels/my-favorites": channelsMyFavorites,
  "channels/timeline": channelsTimeline,
  "channels/mute/create": muteCreate,
  "channels/mute/delete": muteDelete,
  "channels/mute/list": muteList,
};

export const channelHandlers: Record<string, ChannelHandler> = Object.fromEntries(Object.entries(RAW).map(([k, h]) => [k, pgOnly(h)]));

