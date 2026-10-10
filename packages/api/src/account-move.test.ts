/**
 * Account migration (PGlite, remote fetches mocked): i/move (local and remote destinations),
 * AccountMoveService.postMoveProcess (blocks, mutes, lists, roles, antennas, follows, the delayed
 * unfollow as `accountMove` jobs), the router's prohibitMoved gate, Person movedTo / alsoKnownAs,
 * and an inbound Move from a remote account followed by a local user.
 */
import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { genAidx } from "../../id/src/index.js";
import { exportPkcs8Pem, exportSpkiPem, generateRsaKeyPair, parseActivity } from "../../ap/src/index.js";
import { IMPLEMENTED_ENDPOINTS } from "./registry.js";
import { ENDPOINT_META } from "./endpoint-meta.gen.js";
import { makeFixture, TOK, type Fixture } from "./pglite-fixture.js";
import { setFederationPolicy } from "./ap/federation.js";
import { setUserKeypairForTest } from "./ap/keys.js";
import { InMemoryQueueProducer, MK_DELIVER, setQueueProducer } from "./queues/fanout.js";
import { applyActivity } from "./ap/inbox.js";
import { resolveRemoteUser } from "./ap/remote.js";
import { renderLocalPerson } from "./ap/routes.js";
import { runJobStep, type JobMessage } from "./jobs.js";
import { dispatchApi } from "./router.js";
import { getUserDetailedPg } from "./users-pg.js";
import { buildPackConfig } from "./meta-source.js";
import { ENDPOINT_PARAM_DEFS } from "./endpoint-params.gen.js";

let f: Fixture;
let q: InMemoryQueueProducer;
const jobs: { body: JobMessage; delaySeconds?: number }[] = [];
const remote = new Map<string, () => Response>();
const BASE = "https://misskey.example.com";
const json = (o: unknown, type = "application/activity+json") => () => new Response(JSON.stringify(o), { headers: { "Content-Type": type } });
const rows = async (sql: string, p: unknown[] = []) => (await f.db.query(sql, p)).rows as any[];
const E = (r: { data: any }) => r.data?.error?.id;
const delivered = () => q.ofQueue<{ inbox: string; signerId: string; activity: any }>(MK_DELIVER);

const actor = (name: string, host: string, extra: Record<string, unknown> = {}) => ({
  "@context": "https://www.w3.org/ns/activitystreams",
  id: `https://${host}/users/${name}`,
  type: "Person",
  preferredUsername: name,
  inbox: `https://${host}/users/${name}/inbox`,
  endpoints: { sharedInbox: `https://${host}/inbox` },
  followers: `https://${host}/users/${name}/followers`,
  ...extra,
});

async function localUser(name: string): Promise<string> {
  const id = genAidx(Date.now() + Math.floor(Math.random() * 1000));
  await f.db.query(`INSERT INTO "user" (id, username, "usernameLower") VALUES ($1, $2, $2)`, [id, name]);
  await f.db.query(`INSERT INTO user_profile ("userId") VALUES ($1)`, [id]);
  return id;
}

async function remoteUser(name: string, host: string): Promise<string> {
  const r = await resolveRemoteUser(f.env, `https://${host}/users/${name}`);
  return r.id;
}

async function follow(followerId: string, followeeId: string): Promise<void> {
  const [a, b] = await Promise.all([followerId, followeeId].map(async (id) => (await rows(`SELECT host, inbox, "sharedInbox" FROM "user" WHERE id = $1`, [id]))[0]));
  await f.db.query(
    `INSERT INTO following (id, "followerId", "followeeId", "followerHost", "followeeHost", "followerInbox", "followerSharedInbox", "followeeInbox", "followeeSharedInbox")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [genAidx(Date.now()), followerId, followeeId, a.host, b.host, a.inbox, a.sharedInbox, b.inbox, b.sharedInbox],
  );
  await f.db.query(`UPDATE "user" SET "followingCount" = "followingCount" + 1 WHERE id = $1`, [followerId]);
  await f.db.query(`UPDATE "user" SET "followersCount" = "followersCount" + 1 WHERE id = $1`, [followeeId]);
}

/** Runs the captured mk-jobs messages (and their follow-ups) like the consumer. */
async function drainJobs(filter?: (j: JobMessage) => boolean): Promise<void> {
  for (let i = 0; i < jobs.length; i++) {
    const j = jobs[i]!;
    if (filter && !filter(j.body)) continue;
    jobs.splice(i--, 1);
    let next: JobMessage | null = j.body;
    while (next) next = await runJobStep(f.env, next);
  }
}

before(async () => {
  f = await makeFixture("MoveTest");
  setFederationPolicy(f.env, { mode: "all", hosts: [], blockedHosts: [] });
  q = new InMemoryQueueProducer();
  setQueueProducer(f.env, q);
  f.env.Q_JOBS = { send: async (body, opts) => void jobs.push({ body: body as JobMessage, delaySeconds: opts?.delaySeconds }) };
  f.env.AP_FETCH = (async (url: string) => {
    const h = remote.get(url);
    return h ? h() : new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  for (const who of ["a", "b", "c"] as const) {
    const kp = await generateRsaKeyPair();
    setUserKeypairForTest(f.env, f.ids[who], { publicKey: await exportSpkiPem(kp.publicKey), privateKey: await exportPkcs8Pem(kp.privateKey) });
  }
  remote.set("https://remote.example/users/r1", json(actor("r1", "remote.example")));
  remote.set("https://remote.example/users/r2", json(actor("r2", "remote.example")));
});

describe("i/move", () => {
  it("is registered with upstream's meta", () => {
    assert.ok((IMPLEMENTED_ENDPOINTS as readonly string[]).includes("i/move"));
    assert.deepEqual(Object.keys(ENDPOINT_PARAM_DEFS["i/move"]!.properties ?? {}), ["moveToAccount"]);
    assert.equal(ENDPOINT_META["i/move"]!.prohibitMoved, true);
    assert.equal(ENDPOINT_META["i/move"]!.secure, true);
    assert.equal(ENDPOINT_META["notes/create"]!.prohibitMoved, true);
    assert.equal(ENDPOINT_META["notes/show"]!.prohibitMoved, undefined);
  });

  it("validates params and the destination", async () => {
    assert.equal((await f.call("i/move", {}, "b")).status, 400);
    assert.equal(E(await f.call("i/move", { moveToAccount: "" }, "b")), "fcd2eef9-a9b2-4c4f-8624-038099e90aa5");
    assert.equal(E(await f.call("i/move", { moveToAccount: "@user_c" }, "a")), "4362e8dc-731f-4ad8-a694-be2a88922a24"); // root
    assert.equal(E(await f.call("i/move", { moveToAccount: "@nobody" }, "b")), "fcd2eef9-a9b2-4c4f-8624-038099e90aa5");
    assert.equal(E(await f.call("i/move", { moveToAccount: "@ghost@unknown.example" }, "b")), "fcd2eef9-a9b2-4c4f-8624-038099e90aa5");
    // no alias on the destination
    assert.equal(E(await f.call("i/move", { moveToAccount: "@user_c" }, "b")), "b5c90186-4ab0-49c8-9bba-a1f766282ba4");
    // an alias that only contains the old URI (not the URI itself) does not count
    await f.db.query(`UPDATE "user" SET "alsoKnownAs" = $2 WHERE id = $1`, [f.ids.c, `https://attacker.example/proof?u=${BASE}/users/${f.ids.b}`]);
    assert.equal(E(await f.call("i/move", { moveToAccount: "@user_c" }, "b")), "b5c90186-4ab0-49c8-9bba-a1f766282ba4");
    await f.db.query(`UPDATE "user" SET "alsoKnownAs" = $2 WHERE id = $1`, [f.ids.c, `${BASE}/users/${f.ids.b}x`]);
    assert.equal(E(await f.call("i/move", { moveToAccount: "@user_c" }, "b")), "b5c90186-4ab0-49c8-9bba-a1f766282ba4");
    // destination already moved
    await f.db.query(`UPDATE "user" SET "alsoKnownAs" = $2, "movedToUri" = 'https://x.example/u' WHERE id = $1`, [f.ids.c, `${BASE}/users/${f.ids.b}`]);
    assert.equal(E(await f.call("i/move", { moveToAccount: "@user_c" }, "b")), "b5c90186-4ab0-49c8-9bba-a1f766282ba4");
    await f.db.query(`UPDATE "user" SET "movedToUri" = NULL WHERE id = $1`, [f.ids.c]);
  });

  it("moves a local account to a local one and migrates its relations", async () => {
    const { b, c } = f.ids;
    const d = await localUser("user_d"); // follows b
    const e = await localUser("user_e"); // blocks b
    const r1 = await remoteUser("r1", "remote.example"); // remote follower of b
    const r2 = await remoteUser("r2", "remote.example"); // b follows r2
    await follow(d, b);
    await follow(r1, b);
    await follow(b, r2);
    await follow(b, f.ids.a);
    await f.db.query(`INSERT INTO blocking (id, "blockerId", "blockeeId") VALUES ($1, $2, $3)`, [genAidx(Date.now()), e, b]);
    await f.db.query(`INSERT INTO muting (id, "muterId", "muteeId", "expiresAt") VALUES ($1, $2, $3, NULL), ($4, $5, $3, now() - interval '1 day')`, [genAidx(Date.now()), d, b, genAidx(Date.now() + 1), e]);
    await f.db.query(`INSERT INTO user_list (id, "userId", name) VALUES ('list1', $1, 'l')`, [d]);
    await f.db.query(`INSERT INTO user_list_membership (id, "userId", "userListId", "userListUserId") VALUES ('m1', $1, 'list1', $2)`, [b, d]);
    await f.db.query(`INSERT INTO role (id, name, "preserveAssignmentOnMoveAccount", "isPublic", description, "updatedAt", "lastUsedAt") VALUES ('keep', 'keep', TRUE, TRUE, '', now(), now()), ('drop', 'drop', FALSE, FALSE, '', now(), now())`);
    await f.db.query(`INSERT INTO role_assignment (id, "userId", "roleId") VALUES ('ra1', $1, 'keep'), ('ra2', $1, 'drop')`, [b]);
    await f.db.query(`INSERT INTO antenna (id, "userId", name, src, "withFile", users, "lastUsedAt") VALUES ('ant1', $1, 'x', 'users', FALSE, $2, now())`, [d, ["@user_b"]]);

    const r = await f.call("i/move", { moveToAccount: "@user_c" }, "b");
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.id, b);
    const bRow = (await rows(`SELECT "movedToUri", "alsoKnownAs", "movedAt", "followersCount", "followingCount" FROM "user" WHERE id = $1`, [b]))[0];
    assert.equal(bRow.movedToUri, `${BASE}/users/${c}`);
    assert.equal(bRow.alsoKnownAs, `${BASE}/users/${c}`); // simple-array (comma-joined text), as upstream
    assert.ok(bRow.movedAt);
    assert.deepEqual([bRow.followersCount, bRow.followingCount], [0, 0]); // adjustFollowingCounts

    // Update(Person) and Move to the remote follower
    const acts = delivered().filter((x) => x.signerId === b);
    const move = acts.find((x) => x.activity.type === "Move")!;
    assert.deepEqual([move.inbox, move.activity.actor, move.activity.object, move.activity.target, move.activity.id],
      ["https://remote.example/inbox", `${BASE}/users/${b}`, `${BASE}/users/${b}`, `${BASE}/users/${c}`, `${BASE}/moves/${b}/${c}`]);
    const update = acts.find((x) => x.activity.type === "Update")!;
    assert.equal(update.activity.object.movedTo, `${BASE}/users/${c}`);

    // copied at once: mutes (live ones only), list membership, preserved roles, antennas
    assert.deepEqual((await rows(`SELECT "muterId" FROM muting WHERE "muteeId" = $1`, [c])).map((x) => x.muterId), [d]);
    assert.equal((await rows(`SELECT 1 FROM user_list_membership WHERE "userId" = $1 AND "userListId" = 'list1'`, [c])).length, 1);
    assert.deepEqual((await rows(`SELECT "roleId" FROM role_assignment WHERE "userId" = $1`, [c])).map((x) => x.roleId), ["keep"]);
    assert.deepEqual((await rows(`SELECT users FROM antenna WHERE id = 'ant1'`))[0].users, ["@user_b", "@user_c"]);

    // queued: block, follow, and the delayed unfollow (plus the web push of the roleAssigned
    // notification RoleService.assign creates for the copied public role)
    assert.deepEqual(jobs.filter((j) => j.body.kind === "accountMove").map((j) => (j.body as any).op).sort(), ["block", "follow", "unfollow"]);
    assert.ok(jobs.some((j) => j.body.kind === "push" && (j.body as any).userId === c));
    assert.equal(jobs.find((j) => (j.body as any).op === "unfollow")!.delaySeconds, 12 * 3600);
    await drainJobs((j) => (j as any).op !== "unfollow");
    assert.equal((await rows(`SELECT 1 FROM blocking WHERE "blockerId" = $1 AND "blockeeId" = $2`, [e, c])).length, 1);
    assert.equal((await rows(`SELECT 1 FROM following WHERE "followerId" = $1 AND "followeeId" = $2`, [d, c])).length, 1);
    // the old following rows stay; counts as upstream
    assert.equal((await rows(`SELECT 1 FROM following WHERE "followerId" = $1 AND "followeeId" = $2`, [d, b])).length, 1);
    assert.equal((await rows(`SELECT "followingCount" FROM "user" WHERE id = $1`, [d]))[0].followingCount, 1);
    // remote followers are left to their server
    assert.equal((await rows(`SELECT 1 FROM following WHERE "followerId" = $1 AND "followeeId" = $2`, [r1, c])).length, 0);

    // unfollow: not before 24 h (re-delayed), then Undo(Follow) to the remote followee
    const unf = jobs.find((j) => (j.body as any).op === "unfollow")!;
    jobs.length = 0;
    assert.equal(await runJobStep(f.env, unf.body), null);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0]!.delaySeconds, 12 * 3600);
    jobs.length = 0;
    q.clear();
    await runJobStep(f.env, { ...(unf.body as any), notBefore: Date.now() - 1 });
    assert.equal((await rows(`SELECT 1 FROM following WHERE "followerId" = $1`, [b])).length, 0);
    const undo = delivered().find((x) => x.activity.type === "Undo")!;
    assert.deepEqual([undo.inbox, undo.activity.object.type, undo.activity.object.object], ["https://remote.example/users/r2/inbox", "Follow", "https://remote.example/users/r2"]);

    // the moved account renders movedTo / alsoKnownAs; users/show returns user ids
    const person = await renderLocalPerson(f.env, b);
    assert.equal(person!.movedTo, `${BASE}/users/${c}`);
    assert.deepEqual(person!.alsoKnownAs, [`${BASE}/users/${c}`]);
    const shown = await getUserDetailedPg(f.env, { userId: b }, null, buildPackConfig(f.env), null);
    assert.equal(shown!.movedTo, c);
    assert.deepEqual(shown!.alsoKnownAs, [c]);
  });

  it("refuses prohibitMoved endpoints for a moved account (router)", async () => {
    const call = (name: string, who: keyof typeof TOK, body: Record<string, unknown> = {}) =>
      dispatchApi(new Request(`https://api.test/api/${name}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...body, i: TOK[who] }) }), f.env);
    for (const name of ["notes/create", "i/move", "following/create"]) {
      const res = await call(name, "b", { text: "x", moveToAccount: "@user_c", userId: f.ids.a });
      assert.equal(res.status, 403, name);
      const body = (await res.json()) as any;
      assert.deepEqual([body.error.code, body.error.id, body.error.kind], ["YOUR_ACCOUNT_MOVED", "56f20ec9-fd06-4fa5-841b-edd6d7d4fa31", "permission"]);
    }
    // endpoints without the flag, and accounts that have not moved, pass the gate
    assert.notEqual((await call("i", "b")).status, 403);
    assert.notEqual((await call("notes/create", "c", { text: "hi" })).status, 403);
  });

  it("moves to a remote account found over WebFinger", async () => {
    const g = await localUser("user_g");
    await f.db.query(`UPDATE "user" SET token = 'gggggggggggggggg' WHERE id = $1`, [g]);
    const kp = await generateRsaKeyPair();
    setUserKeypairForTest(f.env, g, { publicKey: await exportSpkiPem(kp.publicKey), privateKey: await exportPkcs8Pem(kp.privateKey) });
    remote.set("https://remote.example/users/r9", json(actor("r9", "remote.example")));
    const r9 = await remoteUser("r9", "remote.example");
    await follow(r9, g);
    remote.set("https://other.example/.well-known/webfinger?resource=acct%3Anewme%40other.example", json({
      subject: "acct:newme@other.example",
      links: [{ rel: "self", type: "application/activity+json", href: "https://other.example/users/newme" }],
    }, "application/jrd+json"));
    remote.set("https://other.example/users/newme", json(actor("newme", "other.example", { alsoKnownAs: [`${BASE}/users/${g}`] })));
    q.clear();
    jobs.length = 0;
    // user_g is not one of the fixture's token holders: call the handler directly
    const { handlers } = await import("./endpoints/index.js");
    const res = await handlers["i/move"]!(f.env, { moveToAccount: "newme@other.example", i: "gggggggggggggggg" }, { hasCredential: true, request: new Request("https://api.test/api/i/move", { method: "POST" }) });
    assert.ok(!(res instanceof Response), res instanceof Response ? await res.text() : "");
    const dst = (await rows(`SELECT id, "alsoKnownAs" FROM "user" WHERE uri = 'https://other.example/users/newme'`))[0];
    assert.equal(dst.alsoKnownAs, `${BASE}/users/${g}`);
    assert.equal((await rows(`SELECT "movedToUri" FROM "user" WHERE id = $1`, [g]))[0].movedToUri, "https://other.example/users/newme");
    const move = delivered().find((x) => x.activity.type === "Move")!;
    assert.deepEqual([move.inbox, move.activity.target], ["https://remote.example/inbox", "https://other.example/users/newme"]);
  });
});

describe("inbound Move", () => {
  it("re-fetches the actor and moves its local followers to the new account", async () => {
    const h = await localUser("user_h");
    remote.set("https://far.example/users/old", json(actor("old", "far.example")));
    await remoteUser("old", "far.example");
    const oldId = (await rows(`SELECT id FROM "user" WHERE uri = 'https://far.example/users/old'`))[0].id;
    await follow(h, oldId);
    remote.set("https://far.example/users/old", json(actor("old", "far.example", { movedTo: "https://near.example/users/new" })));
    remote.set("https://near.example/users/new", json(actor("new", "near.example", { alsoKnownAs: ["https://far.example/users/old"] })));
    q.clear();
    jobs.length = 0;
    const oldActor = (await import("./ap/remote.js")).findRemoteUserByUri;
    const signer = (await oldActor(f.env, "https://far.example/users/old"))!;
    // a Move without a target is skipped
    const bad = parseActivity({ type: "Move", id: "https://far.example/m/0", actor: signer.uri, object: signer.uri })!;
    assert.equal((await applyActivity(f.env, signer, bad)).reason, "move_invalid_target");
    const act = parseActivity({ type: "Move", id: "https://far.example/m/1", actor: signer.uri, object: signer.uri, target: "https://near.example/users/new" })!;
    assert.equal((await applyActivity(f.env, signer, act)).reason, "move_processed");
    const old = (await rows(`SELECT "movedToUri", "movedAt", "followersCount" FROM "user" WHERE id = $1`, [oldId]))[0];
    assert.equal(old.movedToUri, "https://near.example/users/new");
    assert.ok(old.movedAt);
    assert.equal(old.followersCount, 0);
    await drainJobs();
    const newId = (await rows(`SELECT id FROM "user" WHERE uri = 'https://near.example/users/new'`))[0].id;
    // a remote followee: a follow request + Follow delivered
    assert.equal((await rows(`SELECT 1 FROM follow_request WHERE "followerId" = $1 AND "followeeId" = $2`, [h, newId])).length, 1);
    const fol = delivered().find((x) => x.activity.type === "Follow")!;
    assert.deepEqual([fol.signerId, fol.inbox, fol.activity.object], [h, "https://near.example/users/new/inbox", "https://near.example/users/new"]);

    // a second Move within 14 days is not processed again
    jobs.length = 0;
    remote.set("https://far.example/users/old", json(actor("old", "far.example", { movedTo: "https://near.example/users/new2" })));
    remote.set("https://near.example/users/new2", json(actor("new2", "near.example", { alsoKnownAs: ["https://far.example/users/old"] })));
    await applyActivity(f.env, signer, parseActivity({ type: "Move", id: "https://far.example/m/2", actor: signer.uri, object: signer.uri, target: "https://near.example/users/new2" })!);
    assert.equal(jobs.length, 0);
  });

  it("skips a destination that does not list the old account", async () => {
    const k = await localUser("user_k");
    remote.set("https://far.example/users/x1", json(actor("x1", "far.example")));
    await remoteUser("x1", "far.example");
    const x1 = (await rows(`SELECT id FROM "user" WHERE uri = 'https://far.example/users/x1'`))[0].id;
    await follow(k, x1);
    remote.set("https://far.example/users/x1", json(actor("x1", "far.example", { movedTo: "https://near.example/users/x2" })));
    remote.set("https://near.example/users/x2", json(actor("x2", "near.example")));
    jobs.length = 0;
    await resolveRemoteUser(f.env, "https://far.example/users/x1", { refresh: true });
    assert.equal(jobs.length, 0);
    assert.equal((await rows(`SELECT "followersCount" FROM "user" WHERE id = $1`, [x1]))[0].followersCount, 1);
  });
});
