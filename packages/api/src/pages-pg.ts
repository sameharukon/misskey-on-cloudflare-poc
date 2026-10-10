/**
 * Pages (W7.12) on PG `page` / `page_like` (upstream schema): pages/create|update|delete|show|
 * featured|like|unlike, i/pages, i/page-likes, users/pages. Follows upstream PageService /
 * PageEntityService: unique name per user, eye-catching image from the caller's drive, note
 * `pageCount` kept in step with `note` blocks in the content, moderators may delete others' pages
 * (moderation log `deletePage`), the legacy `input` block migration on pack, attached image files.
 */

import { genAidx, parseAidxTime } from "../../id/src/index.js";
import type { ApiEnv } from "./env.js";
import { apiErrorResponse, CREDENTIAL_REQUIRED } from "./errors.js";
import { withHyperdriveClient, type PgQueryable } from "./pg.js";
import { isModeratorPg, moderationLogPg } from "./policies-pg.js";
import { packUsers, pagination } from "./client-endpoints-pg.js";
import { packDriveFile } from "./drive/pack.js";
import { authUserId as auth, clientError as err, errorResponse as fail, hd, invalidParam as bad, optionalUserId as optionalMe } from "./handler-kit.js";

type Ctx = { hasCredential: boolean; request: Request };
type Body = Record<string, unknown>;
type Handler = (env: ApiEnv, body: Body, ctx: Ctx) => Promise<Response | unknown>;
type Row = Record<string, unknown>;

const noSuchPage = (id: string) => err("NO_SUCH_PAGE", id, "No such page.");
const E = {
  createNoSuchFile: err("NO_SUCH_FILE", "b7b97489-0f66-4b12-a5ff-b21bd63f6e1c", "No such file."),
  createNameExists: err("NAME_ALREADY_EXISTS", "4650348e-301c-499a-83c9-6aa988c66bc1", "Specified name already exists."),
  updateNoSuchPage: noSuchPage("21149b9e-3616-4778-9592-c4ce89f5a864"),
  updateDenied: err("ACCESS_DENIED", "3c15cd52-3b4b-4274-967d-6456fc4f792b", "Access denied."),
  updateNoSuchFile: err("NO_SUCH_FILE", "cfc23c7c-3887-490e-af30-0ed576703c82", "No such file."),
  updateNameExists: err("NAME_ALREADY_EXISTS", "2298a392-d4a1-44c5-9ebb-ac1aeaa5a9ab", "Specified name already exists."),
  deleteNoSuchPage: noSuchPage("eb0c6e1d-d519-4764-9486-52a7e1c6392a"),
  deleteDenied: err("ACCESS_DENIED", "8b741b3e-2c22-44b3-a15f-29949aa1601e", "Access denied."),
  showNoSuchPage: noSuchPage("222120c0-3ead-4528-811b-b96f233388d7"),
  likeNoSuchPage: noSuchPage("cc98a8a2-0dc3-4123-b198-62c71df18ed3"),
  yourPage: err("YOUR_PAGE", "28800466-e6db-40f2-8fae-bf9e82aa92b8", "You cannot like your page."),
  alreadyLiked: err("ALREADY_LIKED", "d4c1edbe-7da2-4eae-8714-1acfd2d63941", "The page has already been liked."),
  unlikeNoSuchPage: noSuchPage("a0d41e20-1993-40bd-890e-f6e560ae648e"),
  notLiked: err("NOT_LIKED", "f5e586b0-ce93-4050-b0e3-7f31af5259ee", "You have not liked that page."),
};

const noContent = () => new Response(null, { status: 204 });
const PAGE_NAME = /^[^\s:/?#[\]@!$&'()*+,;=\\%\x00-\x20]{1,256}$/;

/** PageService.collectReferencedNotes: `note` blocks, recursing into `section` children. */
export function collectReferencedNotes(content: unknown): string[] {
  const out = new Set<string>();
  const walk = (xs: unknown) => {
    if (!Array.isArray(xs)) return;
    for (const x of xs) {
      if (!x || typeof x !== "object" || !("type" in x)) continue;
      const el = x as Row;
      if (el.type === "note" && typeof el.note === "string") out.add(el.note);
      if (el.type === "section" && Array.isArray(el.children)) walk(el.children);
    }
  };
  walk(content);
  return [...out];
}

async function bumpPageCount(c: PgQueryable, ids: string[], delta: 1 | -1): Promise<void> {
  if (!ids.length) return;
  await c.query(`UPDATE note SET "pageCount" = "pageCount" + $2 WHERE id = ANY($1::varchar[])`, [ids, delta]);
}

/** PageEntityService.pack (UserLite user, attached image files, legacy `input` migration). */
async function packPages(env: ApiEnv, c: PgQueryable, pages: Row[], me: string | null): Promise<Record<string, unknown>[]> {
  if (!pages.length) return [];
  const users = new Map(
    ((await packUsers(env, [...new Set(pages.map((p) => String(p.userId)))], me, false)) as { id: string }[]).map((u) => [u.id, u]),
  );
  const out: Record<string, unknown>[] = [];
  for (const page of pages) {
    const content = (Array.isArray(page.content) ? page.content : []) as Row[];
    const fileIds: string[] = [];
    let migrated = false;
    const walk = (xs: Row[]) => {
      for (const x of xs) {
        if (x.type === "image" && typeof x.fileId === "string") fileIds.push(x.fileId);
        if (x.type === "input") {
          if (x.inputType === "text") x.type = "textInput";
          if (x.inputType === "number") {
            x.type = "numberInput";
            if (x.default) x.default = parseInt(String(x.default), 10);
          }
          migrated = true;
        }
        if (Array.isArray(x.children)) walk(x.children as Row[]);
      }
    };
    walk(content);
    if (migrated) await c.query(`UPDATE page SET content = $2::jsonb WHERE id = $1`, [page.id, JSON.stringify(content)]);
    const ids = [...fileIds, ...(page.eyeCatchingImageId ? [String(page.eyeCatchingImageId)] : [])];
    const files = ids.length
      ? new Map((await c.query(`SELECT * FROM drive_file WHERE id = ANY($1::varchar[])`, [ids])).rows.map((f) => [String(f.id), f]))
      : new Map<string, Row>();
    const isLiked = me
      ? (await c.query(`SELECT 1 AS ok FROM page_like WHERE "pageId" = $1 AND "userId" = $2`, [page.id, me])).rows.length > 0
      : undefined;
    const eye = page.eyeCatchingImageId ? files.get(String(page.eyeCatchingImageId)) : undefined;
    out.push({
      id: page.id,
      createdAt: (parseAidxTime(String(page.id)) ?? new Date(0)).toISOString(),
      updatedAt: new Date(String(page.updatedAt)).toISOString(),
      userId: page.userId,
      user: users.get(String(page.userId)) ?? null,
      content,
      variables: page.variables ?? [],
      title: page.title,
      name: page.name,
      summary: page.summary ?? null,
      hideTitleWhenPinned: Boolean(page.hideTitleWhenPinned),
      alignCenter: Boolean(page.alignCenter),
      font: page.font,
      script: page.script ?? "",
      eyeCatchingImageId: page.eyeCatchingImageId ?? null,
      eyeCatchingImage: eye ? packDriveFile(eye) : null,
      // attached image files must be the page owner's
      attachedFiles: fileIds.map((id) => files.get(id)).filter((f): f is Row => !!f && f.userId === page.userId).map((f) => packDriveFile(f)),
      likedCount: Number(page.likedCount ?? 0),
      ...(isLiked === undefined ? {} : { isLiked }),
    });
  }
  return out;
}

/** The packed page for users/show `pinnedPage` (null when missing). */
export async function packPageById(env: ApiEnv, c: PgQueryable, id: string, me: string | null): Promise<Record<string, unknown> | null> {
  const page = (await c.query(`SELECT * FROM page WHERE id = $1`, [id])).rows[0];
  return page ? ((await packPages(env, c, [page], me))[0] ?? null) : null;
}

/** paramDef checks shared by create / update; `required` lists create's required keys. */
function validPageBody(b: Body, required: boolean): boolean {
  const need = (k: string) => required && b[k] === undefined;
  if (need("title") || need("name") || need("content") || need("variables") || need("script")) return false;
  if (b.title !== undefined && typeof b.title !== "string") return false;
  if (b.name !== undefined && (typeof b.name !== "string" || !PAGE_NAME.test(b.name))) return false;
  if (b.summary !== undefined && b.summary !== null && typeof b.summary !== "string") return false;
  for (const k of ["content", "variables"]) {
    if (b[k] !== undefined && !(Array.isArray(b[k]) && (b[k] as unknown[]).every((x) => x && typeof x === "object" && !Array.isArray(x)))) return false;
  }
  if (b.script !== undefined && typeof b.script !== "string") return false;
  if (b.eyeCatchingImageId !== undefined && b.eyeCatchingImageId !== null && typeof b.eyeCatchingImageId !== "string") return false;
  if (b.font !== undefined && b.font !== "serif" && b.font !== "sans-serif") return false;
  for (const k of ["alignCenter", "hideTitleWhenPinned"]) if (b[k] !== undefined && typeof b[k] !== "boolean") return false;
  return true;
}

async function ownFile(c: PgQueryable, id: string, me: string): Promise<boolean> {
  return (await c.query(`SELECT 1 AS ok FROM drive_file WHERE id = $1 AND "userId" = $2`, [id, me])).rows.length > 0;
}

// ---------------------------------------------------------------- endpoints

const create: Handler = async (env, body, ctx) => {
  const me = await auth(env, body, ctx);
  if (!me) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  if (!validPageBody(body, true)) return bad();
  return withHyperdriveClient(hd(env), async (c) => {
    if (typeof body.eyeCatchingImageId === "string" && !(await ownFile(c, body.eyeCatchingImageId, me))) return fail(E.createNoSuchFile);
    if ((await c.query(`SELECT 1 AS ok FROM page WHERE "userId" = $1 AND name = $2`, [me, body.name])).rows.length) return fail(E.createNameExists);
    const id = genAidx(Date.now());
    await c.query(
      `INSERT INTO page (id, "updatedAt", title, name, summary, content, variables, script, "eyeCatchingImageId", "userId", visibility, "alignCenter", "hideTitleWhenPinned", font)
       VALUES ($1, now(), $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9, 'public', $10, $11, $12)`,
      [id, body.title, body.name, (body.summary as string | null | undefined) ?? null, JSON.stringify(body.content), JSON.stringify(body.variables), body.script,
        (body.eyeCatchingImageId as string | null | undefined) ?? null, me, body.alignCenter === true, body.hideTitleWhenPinned === true, (body.font as string | undefined) ?? "sans-serif"],
    );
    await bumpPageCount(c, collectReferencedNotes(body.content), 1);
    const page = (await c.query(`SELECT * FROM page WHERE id = $1`, [id])).rows[0]!;
    return (await packPages(env, c, [page], null))[0];
  });
};

const update: Handler = async (env, body, ctx) => {
  const me = await auth(env, body, ctx);
  if (!me) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  if (typeof body.pageId !== "string" || !validPageBody(body, false)) return bad();
  return withHyperdriveClient(hd(env), async (c) => {
    if (typeof body.eyeCatchingImageId === "string" && !(await ownFile(c, body.eyeCatchingImageId, me))) return fail(E.updateNoSuchFile);
    const page = (await c.query(`SELECT * FROM page WHERE id = $1`, [body.pageId])).rows[0];
    if (!page) return fail(E.updateNoSuchPage);
    if (page.userId !== me) return fail(E.updateDenied);
    if (body.name != null && (await c.query(`SELECT 1 AS ok FROM page WHERE id <> $1 AND "userId" = $2 AND name = $3`, [page.id, me, body.name])).rows.length) {
      return fail(E.updateNameExists);
    }
    const sets = [`"updatedAt" = now()`];
    const params: unknown[] = [page.id];
    const set = (col: string, v: unknown, cast = "") => sets.push(`"${col}" = $${params.push(v)}${cast}`);
    for (const k of ["title", "name", "script", "alignCenter", "hideTitleWhenPinned", "font"]) if (body[k] !== undefined) set(k, body[k]);
    if (body.summary !== undefined) set("summary", body.summary);
    if (body.content !== undefined) set("content", JSON.stringify(body.content), "::jsonb");
    if (body.variables !== undefined) set("variables", JSON.stringify(body.variables), "::jsonb");
    if (body.eyeCatchingImageId !== undefined) set("eyeCatchingImageId", body.eyeCatchingImageId);
    await c.query(`UPDATE page SET ${sets.join(", ")} WHERE id = $1`, params);
    if (body.content != null) {
      const before = collectReferencedNotes(page.content);
      const after = collectReferencedNotes(body.content);
      await bumpPageCount(c, before.filter((id) => !after.includes(id)), -1);
      await bumpPageCount(c, after.filter((id) => !before.includes(id)), 1);
    }
    return noContent();
  });
};

const del: Handler = async (env, body, ctx) => {
  const me = await auth(env, body, ctx);
  if (!me) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  if (typeof body.pageId !== "string") return bad();
  return withHyperdriveClient(hd(env), async (c) => {
    const page = (await c.query(`SELECT * FROM page WHERE id = $1`, [body.pageId])).rows[0];
    if (!page) return fail(E.deleteNoSuchPage);
    if (page.userId !== me && !(await isModeratorPg(env, c, me))) return fail(E.deleteDenied);
    await c.query(`DELETE FROM page_like WHERE "pageId" = $1`, [page.id]);
    await c.query(`DELETE FROM page WHERE id = $1`, [page.id]);
    if (page.userId !== me) {
      const owner = (await c.query(`SELECT username FROM "user" WHERE id = $1`, [page.userId])).rows[0];
      await moderationLogPg(c, me, "deletePage", { pageId: page.id, pageUserId: page.userId, pageUserUsername: owner?.username ?? null, page: page }, genAidx(Date.now()));
    }
    await bumpPageCount(c, collectReferencedNotes(page.content), -1);
    return noContent();
  });
};

const show: Handler = async (env, body, ctx) => {
  const me = await optionalMe(env, body, ctx);
  if (me === "invalid") return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  const byId = typeof body.pageId === "string";
  if (!byId && (typeof body.name !== "string" || typeof body.username !== "string")) return bad();
  return withHyperdriveClient(hd(env), async (c) => {
    const page = byId
      ? (await c.query(`SELECT * FROM page WHERE id = $1`, [body.pageId])).rows[0]
      : (await c.query(
          `SELECT p.* FROM page p JOIN "user" u ON u.id = p."userId" WHERE u.host IS NULL AND u."usernameLower" = $1 AND p.name = $2`,
          [String(body.username).toLowerCase(), body.name],
        )).rows[0];
    if (!page) return fail(E.showNoSuchPage);
    return (await packPages(env, c, [page], me))[0];
  });
};

const featured: Handler = async (env, body, ctx) => {
  const me = await optionalMe(env, body, ctx);
  if (me === "invalid") return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  return withHyperdriveClient(hd(env), async (c) => {
    const pages = (await c.query(`SELECT * FROM page WHERE visibility = 'public' AND "likedCount" > 0 ORDER BY "likedCount" DESC LIMIT 10`)).rows;
    return packPages(env, c, pages, me);
  });
};

const like: Handler = async (env, body, ctx) => {
  const me = await auth(env, body, ctx);
  if (!me) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  if (typeof body.pageId !== "string") return bad();
  return withHyperdriveClient(hd(env), async (c) => {
    const page = (await c.query(`SELECT id, "userId" FROM page WHERE id = $1`, [body.pageId])).rows[0];
    if (!page) return fail(E.likeNoSuchPage);
    if (page.userId === me) return fail(E.yourPage);
    if ((await c.query(`SELECT 1 AS ok FROM page_like WHERE "pageId" = $1 AND "userId" = $2`, [page.id, me])).rows.length) return fail(E.alreadyLiked);
    await c.query(`INSERT INTO page_like (id, "userId", "pageId") VALUES ($1, $2, $3)`, [genAidx(Date.now()), me, page.id]);
    await c.query(`UPDATE page SET "likedCount" = "likedCount" + 1 WHERE id = $1`, [page.id]);
    return noContent();
  });
};

const unlike: Handler = async (env, body, ctx) => {
  const me = await auth(env, body, ctx);
  if (!me) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  if (typeof body.pageId !== "string") return bad();
  return withHyperdriveClient(hd(env), async (c) => {
    const page = (await c.query(`SELECT id FROM page WHERE id = $1`, [body.pageId])).rows[0];
    if (!page) return fail(E.unlikeNoSuchPage);
    const ex = (await c.query(`SELECT id FROM page_like WHERE "pageId" = $1 AND "userId" = $2`, [page.id, me])).rows[0];
    if (!ex) return fail(E.notLiked);
    await c.query(`DELETE FROM page_like WHERE id = $1`, [ex.id]);
    await c.query(`UPDATE page SET "likedCount" = "likedCount" - 1 WHERE id = $1`, [page.id]);
    return noContent();
  });
};

function limitOf(body: Body): number | null {
  const l = body.limit === undefined ? 10 : body.limit;
  return Number.isInteger(l) && (l as number) >= 1 && (l as number) <= 100 ? (l as number) : null;
}

/** Paginated list of pages (makePaginationQuery). */
async function listPages(env: ApiEnv, c: PgQueryable, body: Body, where: string, whereParams: unknown[], limit: number): Promise<Row[]> {
  const params = [...whereParams];
  const p = pagination(body, params, "page.id");
  params.push(limit);
  return (await c.query(
    `SELECT page.* FROM page WHERE ${[where, ...p.where].join(" AND ")} ORDER BY page.id ${p.order} LIMIT $${params.length}`,
    params,
  )).rows;
}

const iPages: Handler = async (env, body, ctx) => {
  const me = await auth(env, body, ctx);
  if (!me) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  const limit = limitOf(body);
  if (limit == null) return bad();
  // upstream packs these without a viewer
  return withHyperdriveClient(hd(env), async (c) => packPages(env, c, await listPages(env, c, body, `page."userId" = $1`, [me], limit), null));
};

const usersPages: Handler = async (env, body, ctx) => {
  const me = await optionalMe(env, body, ctx);
  if (me === "invalid") return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  const limit = limitOf(body);
  if (limit == null || typeof body.userId !== "string") return bad();
  return withHyperdriveClient(hd(env), async (c) =>
    packPages(env, c, await listPages(env, c, body, `page."userId" = $1 AND page.visibility = 'public'`, [body.userId], limit), null),
  );
};

const iPageLikes: Handler = async (env, body, ctx) => {
  const me = await auth(env, body, ctx);
  if (!me) return apiErrorResponse(CREDENTIAL_REQUIRED, 401);
  const limit = limitOf(body);
  if (limit == null) return bad();
  return withHyperdriveClient(hd(env), async (c) => {
    const params: unknown[] = [me];
    const p = pagination(body, params, "l.id");
    params.push(limit);
    const likes = (await c.query(
      `SELECT l.id AS "likeId", l."pageId" FROM page_like l WHERE ${[`l."userId" = $1`, ...p.where].join(" AND ")} ORDER BY l.id ${p.order} LIMIT $${params.length}`,
      params,
    )).rows;
    const pages = likes.length ? (await c.query(`SELECT * FROM page WHERE id = ANY($1::varchar[])`, [likes.map((l) => l.pageId)])).rows : [];
    const packed = new Map((await packPages(env, c, pages, me)).map((x) => [String(x.id), x]));
    return likes.filter((l) => packed.has(String(l.pageId))).map((l) => ({ id: l.likeId, page: packed.get(String(l.pageId)) }));
  });
};

// ---------------------------------------------------------------- registry

function pgOnly(h: Handler): Handler {
  return async (env, body, ctx) => {
    if (!env.HYPERDRIVE?.connectionString) {
      return apiErrorResponse({ message: "Hyperdrive required.", code: "HYPERDRIVE_UNBOUND", id: "00000000-0000-4000-8000-0000000000b1", kind: "server" }, 501);
    }
    return h(env, body, ctx);
  };
}

const RAW: Record<string, Handler> = {
  "pages/create": create,
  "pages/update": update,
  "pages/delete": del,
  "pages/show": show,
  "pages/featured": featured,
  "pages/like": like,
  "pages/unlike": unlike,
  "i/pages": iPages,
  "i/page-likes": iPageLikes,
  "users/pages": usersPages,
};

export const pageHandlers: Record<string, Handler> = Object.fromEntries(Object.entries(RAW).map(([k, h]) => [k, pgOnly(h)]));

