/**
 * User lists (W7.7) on PG (`user_list`, `user_list_membership`, `user_list_favorite`; upstream schema).
 * users/lists/create|create-from-public|delete|list|show|update|push|pull|favorite|unfavorite|
 * get-memberships|update-membership and notes/user-list-timeline.
 *
 * The list timeline is read from PG with upstream's DB query (`getFromDb`, used upstream when
 * fanout timelines are off); live `userList` stream pushes come from the fanout consumer
 * (packages/timeline/src/stream-fanout.ts). userAdded / userRemoved go to the list owner's hub.
 */

import { genAidx, parseAidxTime } from "../../id/src/index.js";
import type { ApiEnv } from "./env.js";
import { apiErrorResponse, CREDENTIAL_REQUIRED, INVALID_PARAM } from "./errors.js";
import { withHyperdriveClient, type PgQueryable } from "./pg.js";
import { getUserPoliciesPg } from "./policies-pg.js";
import { listNotes, packUsers, pagination } from "./client-endpoints-pg.js";
import { publishToUserStream } from "./stream-publish.js";
import { authUserId as auth, clientError as err, errorResponse as fail, hd, invalidParam as bad } from "./handler-kit.js";

type Ctx = { hasCredential: boolean; request: Request };
type Body = Record<string, unknown>;
export type ListHandler = (env: ApiEnv, body: Body, ctx: Ctx) => Promise<Response | unknown>;

const noSuchList = (id: string) => err("NO_SUCH_LIST", id, "No such list.");
const noSuchUser = (id: string) => err("NO_SUCH_USER", id, "No such user.");
const E = {
  createTooMany: err("TOO_MANY_USERLISTS", "0cf21a28-7715-4f39-a20d-777bfdb8d138", "You cannot create user list any more."),
  cfpTooMany: err("TOO_MANY_USERLISTS", "e9c105b2-c595-47de-97fb-7f7c2c33e92f", "You cannot create user list any more."),
  cfpNoSuchList: noSuchList("9292f798-6175-4f7d-93f4-b6742279667d"),
  cfpNoSuchUser: noSuchUser("13c457db-a8cb-4d88-b70a-211ceeeabb5f"),
  cfpAlreadyAdded: err("ALREADY_ADDED", "c3ad6fdb-692b-47ee-a455-7bd12c7af615", "That user has already been added to that list."),
  cfpBlocked: err("YOU_HAVE_BEEN_BLOCKED", "a2497f2a-2389-439c-8626-5298540530f4", "You cannot push this user because you have been blocked by this user."),
  cfpTooManyUsers: err("TOO_MANY_USERS", "1845ea77-38d1-426e-8e4e-8b83b24f5bd7", "You can not push users any more."),
  deleteNoSuchList: noSuchList("78436795-db79-42f5-b1e2-55ea2cf19166"),
  favNoSuchList: err("NO_SUCH_USER_LIST", "7dbaf3cf-7b42-4b8f-b431-b3919e580dbe", "No such user list."),
  alreadyFavorited: err("ALREADY_FAVORITED", "6425bba0-985b-461e-af1b-518070e72081", "The list has already been favorited."),
  unfavNoSuchList: err("NO_SUCH_USER_LIST", "baedb33e-76b8-4b0c-86a8-9375c0a7b94b", "No such user list."),
  // upstream reuses the ALREADY_FAVORITED code here
  notFavorited: err("ALREADY_FAVORITED", "835c4b27-463d-4cfa-969b-a9058678d465", "You have not favorited the list."),
  showNoSuchList: noSuchList("7bc05c21-1d7a-41ae-88f1-66820f4dc686"),
  listNoSuchUser: noSuchUser("a8af4a82-0980-4cc4-a6af-8b0ffd54465e"),
  listRemoteUser: err("REMOTE_USER_NOT_ALLOWED", "53858f1b-3315-4a01-81b7-db9b48d4b79a", "Not allowed to load the remote user's list"),
  listInvalidParam: err("INVALID_PARAM", "ab36de0e-29e9-48cb-9732-d82f1281620d", "Invalid param."),
  pullNoSuchList: noSuchList("7f44670e-ab16-43b8-b4c1-ccd2ee89cc02"),
  pullNoSuchUser: noSuchUser("588e7f72-c744-4a61-b180-d354e912bda2"),
  pushNoSuchList: noSuchList("2214501d-ac96-4049-b717-91e42272a711"),
  pushNoSuchUser: noSuchUser("a89abd3d-f0bc-4cce-beb1-2f446f4f1e6a"),
  pushAlreadyAdded: err("ALREADY_ADDED", "1de7c884-1595-49e9-857e-61f12f4d4fc5", "That user has already been added to that list."),
  pushBlocked: err("YOU_HAVE_BEEN_BLOCKED", "990232c5-3f9d-4d83-9f3f-ef27b6332a4b", "You cannot push this user because you have been blocked by this user."),
  pushTooManyUsers: err("TOO_MANY_USERS", "2dd9752e-a338-413d-8eec-41814430989b", "You can not push users any more."),
  updateNoSuchList: noSuchList("796666fe-3dff-4d39-becb-8a5932c1d5b7"),
  // update-membership shares pull's error ids upstream
  timelineNoSuchList: noSuchList("8fb1fbd5-e476-4c37-9fb0-43d55b63a2ff"),
};

const str = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : undefined);
const noContent = () => new Response(null, { status: 204 });
const validName = (v: unknown) => typeof v === "string" && v.length >= 1 && v.length <= 100;
const optBool = (v: unknown) => v === undefined || typeof v === "boolean";

type ListRow = { id: string; userId: string; name: string; isPublic: boolean };

async function getList(c: PgQueryable, id: string, where: { userId?: string; isPublic?: boolean } = {}): Promise<ListRow | null> {
  const r = await c.query(`SELECT id, "userId", name, "isPublic" FROM user_list WHERE id = $1`, [id]);
  const row = r.rows[0] as ListRow | undefined;
  if (!row) return null;
  if (where.userId !== undefined && row.userId !== where.userId) return null;
  if (where.isPublic !== undefined && Boolean(row.isPublic) !== where.isPublic) return null;
  return row;
}

/** upstream `findOneBy(!forPublic && me ? {id, userId: me} : {id, isPublic: true})` */
function ownerOrPublic(forPublic: boolean, me: string | null) {
  return !forPublic && me !== null ? { userId: me } : { isPublic: true };
}

/** UserListEntityService.pack */
export async function packLists(c: PgQueryable, lists: ListRow[]): Promise<Record<string, unknown>[]> {
  if (!lists.length) return [];
  const members = new Map<string, string[]>();
  const r = await c.query(
    `SELECT "userListId", "userId" FROM user_list_membership WHERE "userListId" = ANY($1::varchar[]) ORDER BY id`,
    [lists.map((l) => l.id)],
  );
  for (const m of r.rows) (members.get(String(m.userListId)) ?? members.set(String(m.userListId), []).get(String(m.userListId))!).push(String(m.userId));
  return lists.map((l) => ({
    id: l.id,
    createdAt: (parseAidxTime(l.id) ?? new Date(0)).toISOString(),
    name: l.name,
    userIds: members.get(l.id) ?? [],
    isPublic: Boolean(l.isPublic),
  }));
}

async function userExists(c: PgQueryable, id: string): Promise<boolean> {
  return (await c.query(`SELECT 1 FROM "user" WHERE id = $1`, [id])).rows.length > 0;
}

async function isBlockedBy(c: PgQueryable, blockerId: string, blockeeId: string): Promise<boolean> {
  return (await c.query(`SELECT 1 FROM blocking WHERE "blockerId" = $1 AND "blockeeId" = $2`, [blockerId, blockeeId])).rows.length > 0;
}

async function isMember(c: PgQueryable, listId: string, userId: string): Promise<boolean> {
  return (await c.query(`SELECT 1 FROM user_list_membership WHERE "userListId" = $1 AND "userId" = $2`, [listId, userId])).rows.length > 0;
}

/** UserListService.addMember (limit, insert, userAdded stream, proxy follow of a remote member). false when the list is full. */
async function addMember(env: ApiEnv, _c: PgQueryable, list: ListRow, userId: string, me: string): Promise<boolean> {
  const { addListMemberPg } = await import("./imports-pg.js");
  return (await addListMemberPg(env, userId, list, me)) === "ok";
}

/** publishUserListStream(listId, userAdded|userRemoved, packed user) → the owner's `userList:<id>` subscriptions. */
async function publishListEvent(env: ApiEnv, list: ListRow, type: "userAdded" | "userRemoved", userId: string): Promise<void> {
  try {
    const [user] = await packUsers(env, [userId], null, false);
    if (user) await publishToUserStream(env, list.userId, `userList:${list.id}`, type, user);
  } catch {
    /* streaming is best-effort */
  }
}

// ---------------------------------------------------------------- CRUD

const listsCreate: ListHandler = async (env, body, ctx) => {
  const me = await auth(env, body, ctx);
  if (!me) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  if (!validName(body.name)) return bad();
  return withHyperdriveClient(hd(env), async (c) => {
    const n = Number((await c.query(`SELECT count(*)::int AS n FROM user_list WHERE "userId" = $1`, [me])).rows[0]?.n ?? 0);
    if (n >= Number((await getUserPoliciesPg(env, c, me)).userListLimit ?? 10)) return fail(E.createTooMany);
    const list: ListRow = { id: genAidx(Date.now()), userId: me, name: body.name as string, isPublic: false };
    await c.query(`INSERT INTO user_list (id, "userId", name, "isPublic") VALUES ($1, $2, $3, false)`, [list.id, me, list.name]);
    return (await packLists(c, [list]))[0];
  });
};

const listsCreateFromPublic: ListHandler = async (env, body, ctx) => {
  const me = await auth(env, body, ctx);
  if (!me) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  const listId = str(body.listId);
  if (!validName(body.name) || !listId) return bad();
  const out = await withHyperdriveClient(hd(env), async (c) => {
    const src = await getList(c, listId, { isPublic: true });
    if (!src) return fail(E.cfpNoSuchList);
    const n = Number((await c.query(`SELECT count(*)::int AS n FROM user_list WHERE "userId" = $1`, [me])).rows[0]?.n ?? 0);
    if (n >= Number((await getUserPoliciesPg(env, c, me)).userListLimit ?? 10)) return fail(E.cfpTooMany);
    const list: ListRow = { id: genAidx(Date.now()), userId: me, name: body.name as string, isPublic: false };
    await c.query(`INSERT INTO user_list (id, "userId", name, "isPublic") VALUES ($1, $2, $3, false)`, [list.id, me, list.name]);
    const users = (await c.query(`SELECT "userId" FROM user_list_membership WHERE "userListId" = $1 ORDER BY id`, [src.id])).rows.map((r) => String(r.userId));
    // upstream checks each member in turn and stops at the first error (the new list stays)
    for (const uid of users) {
      if (!(await userExists(c, uid))) return fail(E.cfpNoSuchUser);
      if (uid !== me && (await isBlockedBy(c, uid, me))) return fail(E.cfpBlocked);
      if (await isMember(c, list.id, uid)) return fail(E.cfpAlreadyAdded);
      if (!(await addMember(env, c, list, uid, me))) return fail(E.cfpTooManyUsers);
    }
    return { list };
  });
  if (out instanceof Response) return out;
  const packed = (await withHyperdriveClient(hd(env), (c) => packLists(c, [out.list])))[0]!;
  return packed;
};

const listsDelete: ListHandler = async (env, body, ctx) => {
  const me = await auth(env, body, ctx);
  if (!me) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  const listId = str(body.listId);
  if (!listId) return bad();
  return withHyperdriveClient(hd(env), async (c) => {
    const list = await getList(c, listId, { userId: me });
    if (!list) return fail(E.deleteNoSuchList);
    // memberships / favorites cascade (FK ON DELETE CASCADE upstream); explicit for schemas without FKs
    await c.query(`DELETE FROM user_list_membership WHERE "userListId" = $1`, [list.id]);
    await c.query(`DELETE FROM user_list_favorite WHERE "userListId" = $1`, [list.id]);
    await c.query(`DELETE FROM user_list WHERE id = $1`, [list.id]);
    return noContent();
  });
};

const listsList: ListHandler = async (env, body, ctx) => {
  const me = await auth(env, body, ctx);
  if (ctx.hasCredential && !me) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  if (body.userId !== undefined && typeof body.userId !== "string") return bad();
  return withHyperdriveClient(hd(env), async (c) => {
    if (typeof body.userId === "string") {
      const u = (await c.query(`SELECT host FROM "user" WHERE id = $1`, [body.userId])).rows[0];
      if (!u) return fail(E.listNoSuchUser);
      if (u.host != null) return fail(E.listRemoteUser);
    } else if (!me) {
      return fail(E.listInvalidParam);
    }
    const rows = typeof body.userId === "string"
      ? (await c.query(`SELECT id, "userId", name, "isPublic" FROM user_list WHERE "userId" = $1 AND "isPublic" = TRUE ORDER BY id`, [body.userId])).rows
      : (await c.query(`SELECT id, "userId", name, "isPublic" FROM user_list WHERE "userId" = $1 ORDER BY id`, [me])).rows;
    return packLists(c, rows as ListRow[]);
  });
};

const listsShow: ListHandler = async (env, body, ctx) => {
  const me = await auth(env, body, ctx);
  if (ctx.hasCredential && !me) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  const listId = str(body.listId);
  if (!listId || !optBool(body.forPublic)) return bad();
  const forPublic = body.forPublic === true;
  return withHyperdriveClient(hd(env), async (c) => {
    const list = await getList(c, listId, ownerOrPublic(forPublic, me));
    if (!list) return fail(E.showNoSuchList);
    const packed = (await packLists(c, [list]))[0]!;
    if (forPublic && list.isPublic) {
      packed.likedCount = Number((await c.query(`SELECT count(*)::int AS n FROM user_list_favorite WHERE "userListId" = $1`, [list.id])).rows[0]?.n ?? 0);
      packed.isLiked = me
        ? (await c.query(`SELECT 1 FROM user_list_favorite WHERE "userListId" = $1 AND "userId" = $2`, [list.id, me])).rows.length > 0
        : false;
    }
    return packed;
  });
};

const listsUpdate: ListHandler = async (env, body, ctx) => {
  const me = await auth(env, body, ctx);
  if (!me) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  const listId = str(body.listId);
  if (!listId || (body.name !== undefined && !validName(body.name)) || !optBool(body.isPublic)) return bad();
  return withHyperdriveClient(hd(env), async (c) => {
    const list = await getList(c, listId, { userId: me });
    if (!list) return fail(E.updateNoSuchList);
    const sets: string[] = [];
    const params: unknown[] = [];
    if (body.name !== undefined) { params.push(body.name); sets.push(`name = $${params.length}`); }
    if (body.isPublic !== undefined) { params.push(body.isPublic); sets.push(`"isPublic" = $${params.length}`); }
    if (sets.length) {
      params.push(list.id);
      await c.query(`UPDATE user_list SET ${sets.join(", ")} WHERE id = $${params.length}`, params);
    }
    return (await packLists(c, [(await getList(c, list.id))!]))[0];
  });
};

// ---------------------------------------------------------------- members

const listsPush: ListHandler = async (env, body, ctx) => {
  const me = await auth(env, body, ctx);
  if (!me) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  const listId = str(body.listId);
  const userId = str(body.userId);
  if (!listId || !userId) return bad();
  const out = await withHyperdriveClient(hd(env), async (c) => {
    const list = await getList(c, listId, { userId: me });
    if (!list) return fail(E.pushNoSuchList);
    if (!(await userExists(c, userId))) return fail(E.pushNoSuchUser);
    if (userId !== me && (await isBlockedBy(c, userId, me))) return fail(E.pushBlocked);
    if (await isMember(c, list.id, userId)) return fail(E.pushAlreadyAdded);
    if (!(await addMember(env, c, list, userId, me))) return fail(E.pushTooManyUsers);
    return list;
  });
  if (out instanceof Response) return out;
  return noContent();
};

const listsPull: ListHandler = async (env, body, ctx) => {
  const me = await auth(env, body, ctx);
  if (!me) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  const listId = str(body.listId);
  const userId = str(body.userId);
  if (!listId || !userId) return bad();
  const out = await withHyperdriveClient(hd(env), async (c) => {
    const list = await getList(c, listId, { userId: me });
    if (!list) return fail(E.pullNoSuchList);
    if (!(await userExists(c, userId))) return fail(E.pullNoSuchUser);
    await c.query(`DELETE FROM user_list_membership WHERE "userListId" = $1 AND "userId" = $2`, [list.id, userId]);
    return list;
  });
  if (out instanceof Response) return out;
  await publishListEvent(env, out, "userRemoved", userId);
  return noContent();
};

const listsUpdateMembership: ListHandler = async (env, body, ctx) => {
  const me = await auth(env, body, ctx);
  if (!me) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  const listId = str(body.listId);
  const userId = str(body.userId);
  if (!listId || !userId || !optBool(body.withReplies)) return bad();
  return withHyperdriveClient(hd(env), async (c) => {
    const list = await getList(c, listId, { userId: me });
    if (!list) return fail(E.pullNoSuchList);
    if (!(await userExists(c, userId))) return fail(E.pullNoSuchUser);
    if (typeof body.withReplies === "boolean") {
      await c.query(`UPDATE user_list_membership SET "withReplies" = $3 WHERE "userListId" = $1 AND "userId" = $2`, [list.id, userId, body.withReplies]);
    }
    return noContent();
  });
};

const listsGetMemberships: ListHandler = async (env, body, ctx) => {
  const me = await auth(env, body, ctx);
  if (ctx.hasCredential && !me) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  const listId = str(body.listId);
  if (!listId || !optBool(body.forPublic)) return bad();
  const limit = Math.max(1, Math.min(100, Math.floor(typeof body.limit === "number" ? body.limit : 30)));
  const rows = await withHyperdriveClient(hd(env), async (c) => {
    const list = await getList(c, listId, ownerOrPublic(body.forPublic === true, me));
    if (!list) return null;
    const params: unknown[] = [list.id];
    const pg = pagination(body, params, "m.id");
    params.push(limit);
    return (await c.query(
      `SELECT m.id, m."userId", m."withReplies" FROM user_list_membership m
       JOIN "user" u ON u.id = m."userId"
       WHERE ${["m.\"userListId\" = $1", ...pg.where].join(" AND ")} ORDER BY m.id ${pg.order} LIMIT $${params.length}`,
      params,
    )).rows;
  });
  if (!rows) return fail(E.showNoSuchList);
  const users = (await packUsers(env, rows.map((r) => String(r.userId)), me, false)) as { id: string }[];
  const byId = new Map(users.map((u) => [u.id, u]));
  return rows
    .filter((r) => byId.has(String(r.userId)))
    .map((r) => ({
      id: String(r.id),
      createdAt: (parseAidxTime(String(r.id)) ?? new Date(0)).toISOString(),
      userId: String(r.userId),
      user: byId.get(String(r.userId)),
      withReplies: Boolean(r.withReplies),
    }));
};

// ---------------------------------------------------------------- favorites

const listsFavorite: ListHandler = async (env, body, ctx) => {
  const me = await auth(env, body, ctx);
  if (!me) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  const listId = str(body.listId);
  if (!listId) return bad();
  return withHyperdriveClient(hd(env), async (c) => {
    if (!(await getList(c, listId, { isPublic: true }))) return fail(E.favNoSuchList);
    if ((await c.query(`SELECT 1 FROM user_list_favorite WHERE "userListId" = $1 AND "userId" = $2`, [listId, me])).rows.length) return fail(E.alreadyFavorited);
    await c.query(`INSERT INTO user_list_favorite (id, "userId", "userListId") VALUES ($1, $2, $3)`, [genAidx(Date.now()), me, listId]);
    return noContent();
  });
};

const listsUnfavorite: ListHandler = async (env, body, ctx) => {
  const me = await auth(env, body, ctx);
  if (!me) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  const listId = str(body.listId);
  if (!listId) return bad();
  return withHyperdriveClient(hd(env), async (c) => {
    if (!(await getList(c, listId, { isPublic: true }))) return fail(E.unfavNoSuchList);
    const r = await c.query(`DELETE FROM user_list_favorite WHERE "userListId" = $1 AND "userId" = $2 RETURNING id`, [listId, me]);
    if (!r.rows.length) return fail(E.notFavorited);
    return noContent();
  });
};

// ---------------------------------------------------------------- notes/user-list-timeline

/** upstream notes/user-list-timeline (timelines-pg.ts) */
const userListTimeline: ListHandler = async (env, body, ctx) => {
  const me = await auth(env, body, ctx);
  if (!me) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  const { userListTimelinePg } = await import("./timelines-pg.js");
  return userListTimelinePg(env, body, ctx);
};

// ---------------------------------------------------------------- registry

function pgOnly(h: ListHandler): ListHandler {
  return async (env, body, ctx) => {
    if (!env.HYPERDRIVE?.connectionString) {
      return apiErrorResponse({ message: "Hyperdrive required.", code: "HYPERDRIVE_UNBOUND", id: "00000000-0000-4000-8000-0000000000b1", kind: "server" }, 501);
    }
    return h(env, body, ctx);
  };
}

const RAW: Record<string, ListHandler> = {
  "users/lists/create": listsCreate,
  "users/lists/create-from-public": listsCreateFromPublic,
  "users/lists/delete": listsDelete,
  "users/lists/list": listsList,
  "users/lists/show": listsShow,
  "users/lists/update": listsUpdate,
  "users/lists/push": listsPush,
  "users/lists/pull": listsPull,
  "users/lists/update-membership": listsUpdateMembership,
  "users/lists/get-memberships": listsGetMemberships,
  "users/lists/favorite": listsFavorite,
  "users/lists/unfavorite": listsUnfavorite,
  "notes/user-list-timeline": userListTimeline,
};

export const listHandlers: Record<string, ListHandler> = Object.fromEntries(Object.entries(RAW).map(([k, h]) => [k, pgOnly(h)]));

