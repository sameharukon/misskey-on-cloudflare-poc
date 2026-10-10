#!/usr/bin/env node
/**
 * Federation smoke test between the two local environments started by scripts/fed-local/up.sh
 * (https://a.mk.test and https://b.mk.test). Each check drives the client API on one side and
 * waits for the effect on the other, so it exercises WebFinger, signed GETs, the mk-deliver /
 * mk-inbox queues and the inbox processing end to end.
 *
 *   NODE_EXTRA_CA_CERTS=.fed-local/tls/ca.crt node scripts/fed-local/smoke.mjs [--report <file.md>]
 *
 * FED_ONLY=<regex> limits the run to matching checks; FED_TIMEOUT_MS sets the wait per effect.
 *
 * Users are created with a per-run suffix, so the script can run repeatedly against the same DBs.
 */
import { writeFileSync } from "node:fs";

const A = "https://a.mk.test";
const B = "https://b.mk.test";
const HOST = { [A]: "a.mk.test", [B]: "b.mk.test" };
// root tokens, passed by fed-local.sh (signing in on every run would hit the signin rate limit)
const ADMIN_TOKEN = { [A]: process.env.FED_ADMIN_TOKEN_A, [B]: process.env.FED_ADMIN_TOKEN_B };
const TIMEOUT_MS = Number(process.env.FED_TIMEOUT_MS ?? 60_000);
const run = Date.now().toString(36).slice(-5);
const reportIdx = process.argv.indexOf("--report");
const reportPath = reportIdx > 0 ? process.argv[reportIdx + 1] : null;

async function api(base, endpoint, body = {}, token) {
  const res = await fetch(`${base}/api/${endpoint}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(token ? { ...body, i: token } : body),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`${HOST[base]} ${endpoint} → ${res.status} ${text.slice(0, 300)}`);
  return json;
}

async function get(url, accept) {
  const res = await fetch(url, { headers: accept ? { accept } : {}, redirect: "manual" });
  return { status: res.status, headers: res.headers, body: await res.text() };
}

/** Poll `fn` until it returns a truthy value or TIMEOUT_MS passes. */
async function waitFor(what, fn, timeout = TIMEOUT_MS) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`timed out waiting for ${what}${last ? ` (last error: ${last.message})` : ""}`);
}

async function signup(base, username) {
  const me = await api(base, "signup", { username, password: `pw-${username}-xyz` });
  return { base, id: me.id, username, token: me.token, acct: `@${username}@${HOST[base]}` };
}

/** The local id of a remote user as seen from `base`. */
async function resolveUser(base, token, user) {
  const u = await api(base, "users/show", { username: user.username, host: HOST[user.base] }, token);
  return u.id;
}

/** The local id of a note as seen from `base` (fetches it over AP when unknown). */
async function resolveNote(base, token, uri) {
  const r = await api(base, "ap/show", { uri }, token);
  if (r.type !== "Note") throw new Error(`ap/show returned ${r.type}`);
  return r.object;
}

const noteUri = (user, noteId) => `${user.base}/notes/${noteId}`;

/** Notes of `remoteUser` as stored on `base` (no AP fetch). */
async function notesOf(base, token, remoteId) {
  return api(base, "users/notes", { userId: remoteId, limit: 50, withReplies: true }, token);
}

/** users/relation for one user (the endpoint answers with an array, as upstream). */
async function relation(base, token, userId) {
  return (await api(base, "users/relation", { userId }, token))[0];
}

async function ensureFollowing(base, token, userId) {
  if ((await relation(base, token, userId)).isFollowing) return;
  await api(base, "following/create", { userId }, token);
  await waitFor("follow accepted", async () => (await relation(base, token, userId)).isFollowing);
}

async function findNoteOn(base, token, remoteId, pred) {
  const notes = await notesOf(base, token, remoteId);
  return notes.find(pred) ?? null;
}

const results = [];
// FED_ONLY=<regex> runs only the matching checks (later checks may depend on earlier ones)
const only = process.env.FED_ONLY ? new RegExp(process.env.FED_ONLY) : null;
async function check(name, fn) {
  if (only && !only.test(name)) return;
  const started = Date.now();
  try {
    const detail = await fn();
    results.push({ name, ok: true, ms: Date.now() - started, detail: detail ?? "" });
    console.log(`ok   ${name}${detail ? ` — ${detail}` : ""}`);
  } catch (e) {
    results.push({ name, ok: false, ms: Date.now() - started, detail: e.message });
    console.log(`FAIL ${name} — ${e.message}`);
  }
}

// ---------------------------------------------------------------------------

const alice = await signup(A, `alice${run}`);
const bob = await signup(B, `bob${run}`);
const carol = await signup(B, `carol${run}`);
const ctx = {};

await check("discovery: WebFinger (both directions)", async () => {
  for (const u of [alice, bob]) {
    const r = await get(`${u.base}/.well-known/webfinger?resource=acct:${u.username}@${HOST[u.base]}`);
    if (r.status !== 200) throw new Error(`${HOST[u.base]} webfinger ${r.status}`);
    const self = JSON.parse(r.body).links.find((l) => l.rel === "self");
    if (self?.href !== `${u.base}/users/${u.id}`) throw new Error(`self link ${self?.href}`);
  }
});

await check("discovery: host-meta / NodeInfo", async () => {
  for (const base of [A, B]) {
    const hm = await get(`${base}/.well-known/host-meta`);
    if (hm.status !== 200 || !hm.body.includes("lrdd")) throw new Error(`${HOST[base]} host-meta ${hm.status}`);
    const ni = JSON.parse((await get(`${base}/nodeinfo/2.0`)).body);
    if (ni.software?.name !== "misskey") throw new Error(`${HOST[base]} nodeinfo software ${ni.software?.name}`);
  }
});

await check("discovery: /@user redirects to the actor for AP clients", async () => {
  const r = await get(`${A}/@${alice.username}`, "application/activity+json");
  const loc = r.headers.get("location");
  if (r.status === 200 && JSON.parse(r.body).type === "Person") return "Person served directly";
  if (![301, 302, 303, 307, 308].includes(r.status) || !loc?.includes(`/users/${alice.id}`)) throw new Error(`status ${r.status} location ${loc}`);
  return `${r.status} → ${loc}`;
});

await check("actor: resolve remote users (A↔B, signed GET by instance actor)", async () => {
  ctx.bobOnA = await resolveUser(A, alice.token, bob);
  ctx.carolOnA = await resolveUser(A, alice.token, carol);
  ctx.aliceOnB = await resolveUser(B, bob.token, alice);
  return `bob on A = ${ctx.bobOnA}, alice on B = ${ctx.aliceOnB}`;
});

await check("actor: Person profile fields (name / bio / fields / isCat) shown remotely", async () => {
  await api(B, "i/update", { name: `Bob ${run}`, description: "bio from B", isCat: true, fields: [{ name: "site", value: "https://example.com" }] }, bob.token);
  // Update(Person) is delivered to followers; nobody follows yet, so re-fetch through users/show after a refresh
  const u = await waitFor("Update(Person) / refetch on A", async () => {
    await api(A, "federation/update-remote-user", { userId: ctx.bobOnA }, alice.token).catch(() => null);
    const u = await api(A, "users/show", { userId: ctx.bobOnA }, alice.token);
    return u.name === `Bob ${run}` ? u : null;
  });
  if (u.description !== "bio from B") throw new Error(`description ${u.description}`);
  if (!u.isCat) throw new Error("isCat not set");
  if (u.fields?.[0]?.name !== "site") throw new Error(`fields ${JSON.stringify(u.fields)}`);
});

await check("follow: A → B (unlocked) and Accept", async () => {
  await api(A, "following/create", { userId: ctx.bobOnA }, alice.token);
  await waitFor("bob's followers on B to include alice", async () => {
    const f = await api(B, "users/followers", { userId: bob.id }, bob.token);
    return f.some((x) => x.followerId === ctx.aliceOnB);
  });
  await waitFor("Accept on A (isFollowing, not pending)", async () => {
    const r = await relation(A, alice.token, ctx.bobOnA);
    return r.isFollowing && !r.hasPendingFollowRequestFromYou;
  });
});

await check("follow: B → A (unlocked) and Accept", async () => {
  await api(B, "following/create", { userId: ctx.aliceOnB }, bob.token);
  await waitFor("Accept on B", async () => {
    const r = await relation(B, bob.token, ctx.aliceOnB);
    return r.isFollowing && !r.hasPendingFollowRequestFromYou;
  });
  const f = await api(A, "users/followers", { userId: alice.id }, alice.token);
  if (!f.some((x) => x.followerId === ctx.bobOnA)) throw new Error("bob not in alice's followers on A");
});

await check("follow: locked account — request, accept", async () => {
  await api(B, "i/update", { isLocked: true }, carol.token);
  await api(A, "federation/update-remote-user", { userId: ctx.carolOnA }, alice.token).catch(() => null);
  await api(A, "following/create", { userId: ctx.carolOnA }, alice.token);
  const req = await waitFor("follow request on B", async () => {
    const r = await api(B, "following/requests/list", {}, carol.token);
    return r.find((x) => x.follower.username === alice.username) ?? null;
  });
  await api(B, "following/requests/accept", { userId: req.follower.id }, carol.token);
  await waitFor("alice following carol on A", async () => (await relation(A, alice.token, ctx.carolOnA)).isFollowing);
});

await check("follow: unfollow (Undo Follow)", async () => {
  await api(A, "following/delete", { userId: ctx.carolOnA }, alice.token);
  await waitFor("carol's followers on B to be empty", async () => {
    const f = await api(B, "users/followers", { userId: carol.id }, carol.token);
    return f.length === 0;
  });
});

await check("follow: locked account — request, reject", async () => {
  await api(A, "following/create", { userId: ctx.carolOnA }, alice.token);
  const req = await waitFor("follow request on B", async () => {
    const r = await api(B, "following/requests/list", {}, carol.token);
    return r.find((x) => x.follower.username === alice.username) ?? null;
  });
  await api(B, "following/requests/reject", { userId: req.follower.id }, carol.token);
  await waitFor("pending request gone on A", async () => {
    const r = await relation(A, alice.token, ctx.carolOnA);
    return !r.isFollowing && !r.hasPendingFollowRequestFromYou;
  });
});

await check("collections: followers / following pages readable remotely", async () => {
  const r = await get(`${B}/users/${bob.id}/followers?page=true`, "application/activity+json");
  if (r.status !== 200) throw new Error(`followers page ${r.status}`);
  const items = JSON.parse(r.body).orderedItems ?? [];
  if (!items.includes(`${A}/users/${alice.id}`)) throw new Error(`alice missing in ${JSON.stringify(items)}`);
});

await check("collections: non-public followers → 403", async () => {
  await api(B, "i/update", { followersVisibility: "followers" }, carol.token);
  const r = await get(`${B}/users/${carol.id}/followers`, "application/activity+json");
  if (r.status !== 403) throw new Error(`status ${r.status}`);
});

await check("note B→A: text with CW and hashtag delivered to follower", async () => {
  const n = await api(B, "notes/create", { text: `hello from B #fedtest${run}`, cw: "cw here" }, bob.token);
  ctx.bobNote = n.createdNote;
  const got = await waitFor("note on A", () => findNoteOn(A, alice.token, ctx.bobOnA, (x) => x.uri === noteUri(bob, ctx.bobNote.id)));
  ctx.bobNoteOnA = got.id;
  if (got.cw !== "cw here") throw new Error(`cw ${got.cw}`);
  if (!got.tags?.includes(`fedtest${run}`)) throw new Error(`tags ${JSON.stringify(got.tags)}`);
});

await check("note A→B: text delivered to follower", async () => {
  const n = await api(A, "notes/create", { text: `hello from A ${run}` }, alice.token);
  ctx.aliceNote = n.createdNote;
  const got = await waitFor("note on B", () => findNoteOn(B, bob.token, ctx.aliceOnB, (x) => x.uri === noteUri(alice, ctx.aliceNote.id)));
  ctx.aliceNoteOnB = got.id;
});

await check("mention A→B: notification on B", async () => {
  const n = await api(A, "notes/create", { text: `@${bob.username}@b.mk.test ping ${run}` }, alice.token);
  await waitFor("mention notification on B", async () => {
    const ns = await api(B, "i/notifications", { limit: 30 }, bob.token);
    return ns.some((x) => x.type === "mention" && x.note?.uri === noteUri(alice, n.createdNote.id));
  });
});

await check("reply B→A: reply arrives with replyId", async () => {
  const r = await api(B, "notes/create", { text: `reply ${run}`, replyId: ctx.aliceNoteOnB }, bob.token);
  const got = await waitFor("reply on A", () => findNoteOn(A, alice.token, ctx.bobOnA, (x) => x.uri === noteUri(bob, r.createdNote.id)));
  if (got.replyId !== ctx.aliceNote.id) throw new Error(`replyId ${got.replyId}`);
  const ns = await api(A, "i/notifications", { limit: 30 }, alice.token);
  if (!ns.some((x) => x.type === "reply")) throw new Error("no reply notification on A");
});

await check("quote B→A", async () => {
  const r = await api(B, "notes/create", { text: `quote ${run}`, renoteId: ctx.aliceNoteOnB }, bob.token);
  const got = await waitFor("quote on A", () => findNoteOn(A, alice.token, ctx.bobOnA, (x) => x.uri === noteUri(bob, r.createdNote.id)));
  if (got.renoteId !== ctx.aliceNote.id) throw new Error(`renoteId ${got.renoteId}`);
});

await check("renote (Announce) B→A and Undo Announce", async () => {
  // upstream counts quotes and renotes in renoteCount and does not decrement it on delete,
  // so the check follows the renote itself (stored with the Announce id as its uri)
  const r = await api(B, "notes/create", { renoteId: ctx.aliceNoteOnB }, bob.token);
  const uri = `${noteUri(bob, r.createdNote.id)}/activity`;
  await waitFor("renote on A", () => findNoteOn(A, alice.token, ctx.bobOnA, (x) => x.uri === uri && x.renoteId === ctx.aliceNote.id));
  await api(B, "notes/delete", { noteId: r.createdNote.id }, bob.token);
  await waitFor("renote gone on A", async () => !(await findNoteOn(A, alice.token, ctx.bobOnA, (x) => x.uri === uri)));
});

await check("reaction B→A (unicode) and undo", async () => {
  await api(B, "notes/reactions/create", { noteId: ctx.aliceNoteOnB, reaction: "👍" }, bob.token);
  await waitFor("reaction on A", async () => (await api(A, "notes/show", { noteId: ctx.aliceNote.id }, alice.token)).reactions?.["👍"] === 1);
  await api(B, "notes/reactions/delete", { noteId: ctx.aliceNoteOnB }, bob.token);
  await waitFor("reaction removed on A", async () => !(await api(A, "notes/show", { noteId: ctx.aliceNote.id }, alice.token)).reactions?.["👍"]);
});

await check("reaction A→B", async () => {
  await api(A, "notes/reactions/create", { noteId: ctx.bobNoteOnA, reaction: "🎉" }, alice.token);
  await waitFor("reaction on B", async () => (await api(B, "notes/show", { noteId: ctx.bobNote.id }, bob.token)).reactions?.["🎉"] === 1);
});

await check("visibility: home / followers / specified", async () => {
  const home = (await api(B, "notes/create", { text: `home ${run}`, visibility: "home" }, bob.token)).createdNote;
  const fol = (await api(B, "notes/create", { text: `followers ${run}`, visibility: "followers" }, bob.token)).createdNote;
  const dm = (await api(B, "notes/create", { text: `dm ${run}`, visibility: "specified", visibleUserIds: [ctx.aliceOnB] }, bob.token)).createdNote;
  const seen = {};
  for (const [label, n] of [["home", home], ["followers", fol], ["specified", dm]]) {
    const got = await waitFor(`${label} note on A`, () => findNoteOn(A, alice.token, ctx.bobOnA, (x) => x.uri === noteUri(bob, n.id)));
    seen[label] = got.visibility;
  }
  if (seen.home !== "home" || seen.followers !== "followers" || seen.specified !== "specified") throw new Error(JSON.stringify(seen));
  return JSON.stringify(seen);
});

await check("poll: Question A→B, remote vote counted on A, Update(Question) back to B", async () => {
  const p = (await api(A, "notes/create", { text: `poll ${run}`, poll: { choices: ["x", "y"], multiple: false } }, alice.token)).createdNote;
  const onB = await waitFor("poll on B", () => findNoteOn(B, bob.token, ctx.aliceOnB, (x) => x.uri === noteUri(alice, p.id)));
  if (!onB.poll || onB.poll.choices.length !== 2) throw new Error(`poll on B ${JSON.stringify(onB.poll)}`);
  await api(B, "notes/polls/vote", { noteId: onB.id, choice: 1 }, bob.token);
  await waitFor("vote counted on A", async () => (await api(A, "notes/show", { noteId: p.id }, alice.token)).poll?.choices?.[1]?.votes === 1);
  await waitFor("Update(Question) on B", async () => (await api(B, "notes/show", { noteId: onB.id }, bob.token)).poll?.choices?.[1]?.votes === 1);
});

await check("featured: pin / unpin (collections/featured)", async () => {
  await api(B, "i/pin", { noteId: ctx.bobNote.id }, bob.token);
  const r = await get(`${B}/users/${bob.id}/collections/featured`, "application/activity+json");
  const items = JSON.parse(r.body).orderedItems ?? [];
  if (!items.some((x) => (x.id ?? x) === noteUri(bob, ctx.bobNote.id))) throw new Error(`featured ${r.body.slice(0, 200)}`);
  await waitFor("pinned on A (Add)", async () => {
    const u = await api(A, "users/show", { userId: ctx.bobOnA }, alice.token);
    return u.pinnedNoteIds?.includes(ctx.bobNoteOnA);
  });
  await api(B, "i/unpin", { noteId: ctx.bobNote.id }, bob.token);
  await waitFor("unpinned on A (Remove)", async () => {
    const u = await api(A, "users/show", { userId: ctx.bobOnA }, alice.token);
    return !u.pinnedNoteIds?.includes(ctx.bobNoteOnA);
  });
});

await check("outbox: index and first page", async () => {
  const idx = JSON.parse((await get(`${B}/users/${bob.id}/outbox`, "application/activity+json")).body);
  if (idx.type !== "OrderedCollection" || !idx.first) throw new Error(`index ${JSON.stringify(idx).slice(0, 200)}`);
  const page = JSON.parse((await get(idx.first, "application/activity+json")).body);
  if (!(page.orderedItems?.length > 0)) throw new Error("empty first page");
  return `${page.orderedItems.length} items`;
});

await check("ap/show: fetch a note by URI from the other side", async () => {
  const n = (await api(B, "notes/create", { text: `fetch me ${run}` }, carol.token)).createdNote;
  const got = await resolveNote(A, alice.token, noteUri(carol, n.id));
  if (got.text !== `fetch me ${run}`) throw new Error(`text ${got.text}`);
});

await check("delete: Delete(Note) B→A", async () => {
  const n = (await api(B, "notes/create", { text: `to be deleted ${run}` }, bob.token)).createdNote;
  const got = await waitFor("note on A", () => findNoteOn(A, alice.token, ctx.bobOnA, (x) => x.uri === noteUri(bob, n.id)));
  await api(B, "notes/delete", { noteId: n.id }, bob.token);
  await waitFor("note gone on A", async () => {
    try {
      await api(A, "notes/show", { noteId: got.id }, alice.token);
      return false;
    } catch (e) {
      return /NO_SUCH_NOTE|404|400/.test(e.message);
    }
  });
});

await check("Update(Person): profile change reaches followers", async () => {
  await api(B, "i/update", { name: `Bob renamed ${run}` }, bob.token);
  await waitFor("name on A", async () => (await api(A, "users/show", { userId: ctx.bobOnA }, alice.token)).name === `Bob renamed ${run}`);
});

await check("block: B blocks A — follow removed on both sides", async () => {
  await api(B, "blocking/create", { userId: ctx.aliceOnB }, bob.token);
  await waitFor("A no longer follows bob", async () => {
    const r = await relation(A, alice.token, ctx.bobOnA);
    return !r.isFollowing && !r.isFollowed;
  });
  await api(B, "blocking/delete", { userId: ctx.aliceOnB }, bob.token);
  await waitFor("Undo Block on A", async () => !(await relation(A, alice.token, ctx.bobOnA)).isBlocked);
});

await check("attachment: B note with a file → link Document on A, remoteFile job fills md5", async () => {
  await ensureFollowing(A, alice.token, ctx.bobOnA); // the block check above removed the follow
  // 1×1 PNG
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  const form = new FormData();
  form.append("i", bob.token);
  form.append("file", new Blob([png], { type: "image/png" }), `px${run}.png`);
  const res = await fetch(`${B}/api/drive/files/create`, { method: "POST", body: form });
  if (!res.ok) throw new Error(`drive/files/create ${res.status} ${(await res.text()).slice(0, 200)}`);
  const file = await res.json();
  const n = (await api(B, "notes/create", { text: `file ${run}`, fileIds: [file.id] }, bob.token)).createdNote;
  const got = await waitFor("note with file on A", () => findNoteOn(A, alice.token, ctx.bobOnA, (x) => x.uri === noteUri(bob, n.id)));
  const f = got.files?.[0];
  if (!f) throw new Error("no files on A");
  if (f.type !== "image/png") throw new Error(`type ${f.type}`);
  const filled = await waitFor("md5 filled by remoteFile", async () => {
    const r = await findNoteOn(A, alice.token, ctx.bobOnA, (x) => x.id === got.id);
    const ff = r?.files?.[0];
    return ff?.md5 ? ff : null;
  });
  return `md5 ${filled.md5}, ${filled.properties?.width}×${filled.properties?.height}`;
});

await check("move: B account moves to A, A followers migrate", async () => {
  const erin = await signup(B, `erin${run}`);
  const dave = await signup(A, `dave${run}`);
  const erinOnA = await resolveUser(A, alice.token, erin);
  await api(A, "following/create", { userId: erinOnA }, alice.token);
  await waitFor("alice follows erin", async () => (await relation(A, alice.token, erinOnA)).isFollowing);
  await api(A, "i/update", { alsoKnownAs: [`@${erin.username}@b.mk.test`] }, dave.token);
  await waitFor("i/move accepted", async () => {
    try {
      await api(B, "i/move", { moveToAccount: `@${dave.username}@a.mk.test` }, erin.token);
      return true;
    } catch (e) {
      if (/DESTINATION_ACCOUNT_FORBIDS/.test(e.message)) return false; // dave's alsoKnownAs not fetched yet
      throw e;
    }
  });
  await waitFor("alice follows dave on A", async () => (await relation(A, alice.token, dave.id)).isFollowing);
  const u = await api(A, "users/show", { userId: erinOnA }, alice.token);
  if (!u.movedTo) throw new Error("movedTo not set on A");
});

await check("account deletion: Delete(Person) B→A", async () => {
  const frank = await signup(B, `frank${run}`);
  const frankOnA = await resolveUser(A, alice.token, frank);
  await api(B, "i/delete-account", { password: `pw-${frank.username}-xyz` }, frank.token);
  await waitFor("frank deleted on A", async () => {
    try {
      const u = await api(A, "users/show", { userId: frankOnA }, alice.token);
      return u.isDeleted === true ? "isDeleted" : null;
    } catch (e) {
      return /NO_SUCH_USER|404|400/.test(e.message) ? "gone" : null;
    }
  });
});

await check("blockedHosts: A drops activities from b.mk.test", async () => {
  if (!ADMIN_TOKEN[A]) throw new Error("FED_ADMIN_TOKEN_A not set");
  await ensureFollowing(A, alice.token, ctx.bobOnA);
  try {
    await api(A, "admin/update-meta", { blockedHosts: ["b.mk.test"] }, ADMIN_TOKEN[A]);
    await new Promise((r) => setTimeout(r, 31_000)); // federation policy cache (30 s)
    const n = (await api(B, "notes/create", { text: `blocked ${run}` }, bob.token)).createdNote;
    await new Promise((r) => setTimeout(r, 15_000));
    if (await findNoteOn(A, alice.token, ctx.bobOnA, (x) => x.uri === noteUri(bob, n.id))) throw new Error("note from blocked host arrived");
  } finally {
    await api(A, "admin/update-meta", { blockedHosts: [] }, ADMIN_TOKEN[A]);
    await new Promise((r) => setTimeout(r, 31_000));
  }
});

await check("gate: federation none → WebFinger / AP GET 403", async () => {
  if (!ADMIN_TOKEN[A]) throw new Error("FED_ADMIN_TOKEN_A not set");
  const started = Date.now();
  try {
    await api(A, "admin/update-meta", { federation: "none" }, ADMIN_TOKEN[A]);
    // the federation policy is cached per isolate for 30 s (ap/federation.ts)
    await waitFor("webfinger 403", async () => (await get(`${A}/.well-known/webfinger?resource=acct:${alice.username}@a.mk.test`)).status === 403, 35_000);
    const ap = await get(`${A}/users/${alice.id}`, "application/activity+json");
    if (ap.status !== 403) throw new Error(`AP GET ${ap.status}`);
    return `403 / 403 after ${((Date.now() - started) / 1000).toFixed(0)}s`;
  } finally {
    await api(A, "admin/update-meta", { federation: "all" }, ADMIN_TOKEN[A]);
    // let the policy cache expire before anything else federates
    await waitFor("webfinger 200 again", async () => (await get(`${A}/.well-known/webfinger?resource=acct:${alice.username}@a.mk.test`)).status === 200, 35_000);
  }
});

// ---------------------------------------------------------------------------

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed (run ${run})`);
if (reportPath) {
  const rows = results.map((r) => `| ${r.ok ? "✅" : "❌"} | ${r.name} | ${(r.ms / 1000).toFixed(1)}s | ${String(r.detail).replace(/\|/g, "\\|").replace(/\n/g, " ")} |`);
  writeFileSync(reportPath, `# Federation smoke (run ${run})\n\n${results.length - failed.length}/${results.length} passed\n\n| | check | time | detail |\n|---|---|---|---|\n${rows.join("\n")}\n`);
}
process.exit(failed.length ? 1 : 0);
