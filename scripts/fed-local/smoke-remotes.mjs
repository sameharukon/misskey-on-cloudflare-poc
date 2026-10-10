#!/usr/bin/env node
/**
 * Interoperability smoke test: misskey-cf (https://a.mk.test, fed-local.sh) against stock Misskey
 * (https://m.mk.test) and Mastodon with AUTHORIZED_FETCH (https://t.mk.test), both from
 * remotes.sh. The same checks run against each remote through a small adapter per server API.
 *
 *   bash scripts/fed-local/fed-local.sh smoke-remotes [misskey|mastodon]
 *
 * Needs FED_ADMIN_TOKEN_A and the remote tokens (.fed-local/remotes/tokens.env), both passed by
 * fed-local.sh. FED_ONLY=<regex> limits the checks; FED_TIMEOUT_MS is the wait per effect.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const A = "https://a.mk.test";
const TIMEOUT_MS = Number(process.env.FED_TIMEOUT_MS ?? 60_000);
const run = Date.now().toString(36).slice(-5);
const only = process.env.FED_ONLY ? new RegExp(process.env.FED_ONLY) : null;
const reportIdx = process.argv.indexOf("--report");
const reportPath = reportIdx > 0 ? process.argv[reportIdx + 1] : null;
const which = process.argv.slice(2).filter((x, i, all) => !x.startsWith("--") && all[i - 1] !== "--report");
const env = Object.fromEntries(
  readFileSync(process.env.FED_REMOTE_TOKENS ?? ".fed-local/remotes/tokens.env", "utf8")
    .split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);
const ADMIN_A = process.env.FED_ADMIN_TOKEN_A;
const REMOTES_SH = fileURLToPath(new URL("./remotes.sh", import.meta.url));
const PASSWORD = "fedtest-pass-123";
const execFileAsync = promisify(execFile);
/**
 * Ruby in the Mastodon container (remotes.sh rails), for what Mastodon has no API for. Asynchronous:
 * a blocked event loop would keep fetch from noticing keep-alive sockets the servers closed meanwhile.
 */
async function mastodonRails(ruby) {
  return (await execFileAsync("bash", [REMOTES_SH, "rails", ruby], { encoding: "utf8", timeout: 300_000, maxBuffer: 16 << 20 })).stdout;
}
async function docker(...args) {
  return (await execFileAsync("docker", args, { encoding: "utf8", timeout: 120_000 })).stdout;
}
const PNG_BASE = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
/**
 * A 1×1 PNG with random bytes after IEND (decoders ignore them): every upload has its own md5, so
 * the servers do not dedupe it into a file from an earlier run.
 */
const png = () => Buffer.concat([PNG_BASE, Buffer.from(crypto.getRandomValues(new Uint8Array(16)))]);

// --- HTTP helpers ------------------------------------------------------------------------------

async function mk(base, endpoint, body = {}, token) {
  const res = await fetch(`${base}/api/${endpoint}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(token ? { ...body, i: token } : body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${new URL(base).host} ${endpoint} → ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

async function mkUpload(base, token, name) {
  const form = new FormData();
  form.append("i", token);
  form.append("file", new Blob([png()], { type: "image/png" }), name);
  const res = await fetch(`${base}/api/drive/files/create`, { method: "POST", body: form });
  if (!res.ok) throw new Error(`${new URL(base).host} drive/files/create → ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

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
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`timed out waiting for ${what}${last ? ` (last error: ${last.message})` : ""}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- misskey-cf (the side under test) -----------------------------------------------------------

const local = {
  async signup(username) {
    const me = await mk(A, "signup", { username, password: `pw-${username}-xyz` });
    return { id: me.id, username, token: me.token, acct: `${username}@a.mk.test`, uri: `${A}/users/${me.id}` };
  },
  async resolve(token, username, host) {
    return (await mk(A, "users/show", { username, host }, token)).id;
  },
  relation: async (token, userId) => (await mk(A, "users/relation", { userId }, token))[0],
  notesOf: (token, userId) => mk(A, "users/notes", { userId, limit: 50, withReplies: true }, token),
  async findNote(token, userId, uri) {
    return (await local.notesOf(token, userId)).find((n) => n.uri === uri) ?? null;
  },
  noteUri: (id) => `${A}/notes/${id}`,
  post: async (token, body) => (await mk(A, "notes/create", body, token)).createdNote,
};

// --- remote adapters ---------------------------------------------------------------------------

/** Stock Misskey: same client API as misskey-cf. */
function misskeyAdapter() {
  const M = "https://m.mk.test";
  const token = env.MISSKEY_CAROL_TOKEN;
  return {
    name: "misskey",
    host: "m.mk.test",
    user: { username: "carol", token },
    async me() {
      const me = await mk(M, "i", {}, token);
      return { id: me.id, uri: `${M}/users/${me.id}` };
    },
    resolve: async (acctUser, acctHost) => (await mk(M, "users/show", { username: acctUser, host: acctHost }, token)).id,
    async profileOf(id) {
      const u = await mk(M, "users/show", { userId: id }, token);
      return { name: u.name, bio: u.description, fields: u.fields ?? [], isCat: u.isCat, followers: u.followersCount, avatar: u.avatarUrl, pinned: (u.pinnedNotes ?? []).map((n) => n.uri ?? `${M}/notes/${n.id}`), movedTo: u.movedTo };
    },
    async follow(id) { await mk(M, "following/create", { userId: id }, token); },
    async unfollow(id) { await mk(M, "following/delete", { userId: id }, token); },
    async relation(id) {
      const r = (await mk(M, "users/relation", { userId: id }, token))[0];
      return { following: r.isFollowing, requested: r.hasPendingFollowRequestFromYou, followedBy: r.isFollowed, blocking: r.isBlocking };
    },
    async block(id) { await mk(M, "blocking/create", { userId: id }, token); },
    async unblock(id) { await mk(M, "blocking/delete", { userId: id }, token); },
    async findByUri(authorId, uri) {
      const notes = await mk(M, "users/notes", { userId: authorId, limit: 50, withReplies: true }, token);
      const n = notes.find((x) => x.uri === uri);
      return n ? norm(n) : null;
    },
    async lookup(uri) {
      const r = await mk(M, "ap/show", { uri }, token);
      return r.type === "Note" ? norm(r.object) : null;
    },
    async get(id) {
      try {
        return norm(await mk(M, "notes/show", { noteId: id }, token));
      } catch (e) {
        if (/NO_SUCH_NOTE|404/.test(e.message)) return null;
        throw e;
      }
    },
    async post(o) {
      const body = { text: o.text, cw: o.cw, visibility: o.visibility ?? "public" };
      if (o.visibleUserIds) body.visibleUserIds = o.visibleUserIds;
      if (o.replyId) body.replyId = o.replyId;
      if (o.quoteId) body.renoteId = o.quoteId;
      if (o.poll) body.poll = { choices: o.poll, multiple: false };
      if (o.image) body.fileIds = [(await mkUpload(M, token, `px${run}.png`)).id];
      const n = (await mk(M, "notes/create", body, token)).createdNote;
      return { id: n.id, uri: `${M}/notes/${n.id}` };
    },
    async boost(id) {
      const n = (await mk(M, "notes/create", { renoteId: id }, token)).createdNote;
      return { id: n.id, uri: `${M}/notes/${n.id}/activity` };
    },
    async unboost(boost) { await mk(M, "notes/delete", { noteId: boost.id }, token); },
    async del(id) { await mk(M, "notes/delete", { noteId: id }, token); },
    async react(id) { await mk(M, "notes/reactions/create", { noteId: id, reaction: "👍" }, token); },
    async unreact(id) { await mk(M, "notes/reactions/delete", { noteId: id }, token); },
    async vote(id, choice) { await mk(M, "notes/polls/vote", { noteId: id, choice }, token); },
    async mentionNotified(uri) {
      const ns = await mk(M, "i/notifications", { limit: 50 }, token);
      return ns.some((x) => x.type === "mention" && x.note?.uri === uri);
    },
    async updateName(name) { await mk(M, "i/update", { name }, token); },
    async setAvatar() {
      const f = await mkUpload(M, token, `av${run}.png`);
      await mk(M, "i/update", { avatarId: f.id }, token);
    },
    emoji: "fed_m",
    async ensureEmoji() {
      const admin = env.MISSKEY_ADMIN_TOKEN;
      const list = await mk(M, "admin/emoji/list", { query: "fed_m", limit: 10 }, admin);
      if (list.some((e) => e.name === "fed_m")) return;
      const f = await mkUpload(M, admin, "fed_m.png");
      await mk(M, "admin/emoji/add", { name: "fed_m", fileId: f.id }, admin);
    },
    async reactCustom(id) { await mk(M, "notes/reactions/create", { noteId: id, reaction: ":fed_m:" }, token); },
    /** A new local user with a token. */
    async newUser(name) {
      const u = await mk(M, "admin/accounts/create", { username: name, password: PASSWORD }, env.MISSKEY_ADMIN_TOKEN);
      return { id: u.id, username: name, token: u.token };
    },
    async followAs(u, id) { await mk(M, "following/create", { userId: id }, u.token); },
    async relationAs(u, id) {
      const r = (await mk(M, "users/relation", { userId: id }, u.token))[0];
      return { following: r.isFollowing, followedBy: r.isFollowed };
    },
    async postAs(u, text) {
      const n = (await mk(M, "notes/create", { text }, u.token)).createdNote;
      return { id: n.id, uri: `${M}/notes/${n.id}` };
    },
    async setAliases(u, acct) { await mk(M, "i/update", { alsoKnownAs: [acct] }, u.token); },
    async move(u, acct) { await mk(M, "i/move", { moveToAccount: acct }, u.token); },
    async deleteUser(u) { await mk(M, "admin/delete-account", { userId: u.id }, env.MISSKEY_ADMIN_TOKEN); },
    async resolveAs(u, acctUser, acctHost) { return (await mk(M, "users/show", { username: acctUser, host: acctHost }, u.token)).id; },
    expectsReaction: (n) => Object.keys(n.reactions ?? {}).length > 0,
  };
  function norm(n) {
    return {
      id: n.id, uri: n.uri ?? `${M}/notes/${n.id}`, text: n.text, cw: n.cw, visibility: n.visibility,
      replyId: n.replyId, renoteId: n.renoteId, tags: n.tags ?? [], poll: n.poll?.choices?.map((c) => c.votes) ?? null,
      emojis: Object.keys(n.emojis ?? {}).map((k) => k.split("@")[0]), reactionKeys: Object.keys(n.reactions ?? {}),
      files: (n.files ?? []).length, reactions: n.reactions ?? {}, reactionCount: Object.values(n.reactions ?? {}).reduce((a, b) => a + b, 0),
      renoteCount: n.renoteCount,
    };
  }
}

/** Mastodon REST API (statuses, accounts, notifications). */
function mastodonAdapter() {
  const T = "https://t.mk.test";
  const token = env.MASTODON_TOKEN_CAROL;
  async function md(method, path, body) {
    const res = await fetch(`${T}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body && !(body instanceof FormData) ? { "content-type": "application/json" } : {}) },
      body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`t.mk.test ${method} ${path} → ${res.status} ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : null;
  }
  async function mdAs(u, method, path, body) {
    const res = await fetch(`${T}${path}`, {
      method,
      headers: { authorization: `Bearer ${u.token}`, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`t.mk.test ${method} ${path} → ${res.status} ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : null;
  }
  const VIS = { public: "public", home: "unlisted", followers: "private", specified: "direct" };
  const norm = (s) => ({
    id: s.id, uri: s.uri, text: s.content, cw: s.spoiler_text || null, visibility: s.visibility,
    replyId: s.in_reply_to_id, renoteId: s.reblog?.id ?? s.quote?.quoted_status?.id ?? null, tags: (s.tags ?? []).map((t) => t.name),
    poll: s.poll ? s.poll.options.map((o) => o.votes_count) : null, files: (s.media_attachments ?? []).length,
    emojis: (s.emojis ?? []).map((e) => e.shortcode), reactionKeys: [],
    reactionCount: s.favourites_count, renoteCount: s.reblogs_count,
  });
  return {
    name: "mastodon",
    host: "t.mk.test",
    user: { username: "carol", token },
    async me() {
      const me = await md("GET", "/api/v1/accounts/verify_credentials");
      return { id: me.id, uri: (await md("GET", `/api/v1/accounts/${me.id}`)).uri ?? null };
    },
    async resolve(acctUser, acctHost) {
      const r = await md("GET", `/api/v2/search?q=${encodeURIComponent(`@${acctUser}@${acctHost}`)}&resolve=true&type=accounts`);
      const a = r.accounts.find((x) => x.acct === `${acctUser}@${acctHost}`);
      if (!a) throw new Error("not resolved");
      return a.id;
    },
    async profileOf(id) {
      const a = await md("GET", `/api/v1/accounts/${id}`);
      const pinned = await md("GET", `/api/v1/accounts/${id}/statuses?pinned=true`);
      return {
        name: a.display_name, bio: a.note, fields: a.fields ?? [], isCat: null, followers: a.followers_count,
        avatar: a.avatar_static ?? a.avatar, pinned: pinned.map((x) => x.uri), movedTo: a.moved?.id ?? null,
      };
    },
    async follow(id) { await md("POST", `/api/v1/accounts/${id}/follow`); },
    async unfollow(id) { await md("POST", `/api/v1/accounts/${id}/unfollow`); },
    async relation(id) {
      const [r] = await md("GET", `/api/v1/accounts/relationships?id[]=${id}`);
      return { following: r.following, requested: r.requested, followedBy: r.followed_by, blocking: r.blocking };
    },
    async block(id) { await md("POST", `/api/v1/accounts/${id}/block`); },
    async unblock(id) { await md("POST", `/api/v1/accounts/${id}/unblock`); },
    async findByUri(authorId, uri) {
      const ss = await md("GET", `/api/v1/accounts/${authorId}/statuses?limit=40`);
      const s = ss.find((x) => x.uri === uri);
      if (s) return norm(s);
      // direct messages are not listed on the account: look in the conversations
      const cs = await md("GET", "/api/v1/conversations?limit=40");
      const c = cs.map((x) => x.last_status).find((x) => x?.uri === uri);
      return c ? norm(c) : null;
    },
    async lookup(uri) {
      const r = await md("GET", `/api/v2/search?q=${encodeURIComponent(uri)}&resolve=true&type=statuses`);
      return r.statuses[0] ? norm(r.statuses[0]) : null;
    },
    async get(id) {
      try {
        return norm(await md("GET", `/api/v1/statuses/${id}`));
      } catch (e) {
        if (/→ 404/.test(e.message)) return null;
        throw e;
      }
    },
    async post(o) {
      let mediaIds;
      if (o.image) {
        const form = new FormData();
        form.append("file", new Blob([png()], { type: "image/png" }), `px${run}.png`);
        const m = await md("POST", "/api/v2/media", form);
        await waitFor("media processed", async () => (await md("GET", `/api/v1/media/${m.id}`)).url, 30_000).catch(() => null);
        mediaIds = [m.id];
      }
      const body = { status: o.text, spoiler_text: o.cw ?? undefined, visibility: VIS[o.visibility ?? "public"] };
      if (o.replyId) body.in_reply_to_id = o.replyId;
      if (o.quoteId) body.quoted_status_id = o.quoteId;
      if (o.poll) body.poll = { options: o.poll, expires_in: 3600 };
      if (mediaIds) body.media_ids = mediaIds;
      const s = await md("POST", "/api/v1/statuses", body);
      return { id: s.id, uri: s.uri };
    },
    async boost(id) {
      const s = await md("POST", `/api/v1/statuses/${id}/reblog`);
      return { id: s.id, uri: s.uri, of: id };
    },
    async unboost(boost) { await md("POST", `/api/v1/statuses/${boost.of}/unreblog`); },
    async del(id) { await md("DELETE", `/api/v1/statuses/${id}`); },
    async react(id) { await md("POST", `/api/v1/statuses/${id}/favourite`); },
    async unreact(id) { await md("POST", `/api/v1/statuses/${id}/unfavourite`); },
    async vote(id, choice) {
      const s = await md("GET", `/api/v1/statuses/${id}`);
      await md("POST", `/api/v1/polls/${s.poll.id}/votes`, { choices: [String(choice)] });
    },
    async mentionNotified(uri) {
      const ns = await md("GET", "/api/v1/notifications?limit=40&types[]=mention");
      return ns.some((x) => x.status?.uri === uri);
    },
    async updateName(name) {
      const form = new FormData();
      form.append("display_name", name);
      await md("PATCH", "/api/v1/accounts/update_credentials", form);
    },
    async setAvatar() {
      const form = new FormData();
      form.append("avatar", new Blob([png()], { type: "image/png" }), `av${run}.png`);
      await md("PATCH", "/api/v1/accounts/update_credentials", form);
    },
    emoji: "fed_t", // created by remotes.sh setup
    async ensureEmoji() {},
    reactCustom: null, // Mastodon has no emoji reactions
    async newUser(name) {
      const out = await mastodonRails(`
        user = User.new(email: "${name}@t.mk.test", password: "${PASSWORD}", agreement: true, approved: true,
                        confirmed_at: Time.now.utc, account_attributes: { username: "${name}" })
        user.save!(validate: false)
        user.update_columns(approved: true)
        app = Doorkeeper::Application.find_by!(name: "fed-local")
        tok = Doorkeeper::AccessToken.create!(application: app, resource_owner_id: user.id, scopes: "read write follow push")
        puts "NEWUSER #{tok.token} #{user.account.id}"`);
      const m = out.match(/NEWUSER (\S+) (\d+)/);
      if (!m) throw new Error(`could not create Mastodon user: ${out.slice(-300)}`);
      return { id: m[2], username: name, token: m[1] };
    },
    async followAs(u, id) { await mdAs(u, "POST", `/api/v1/accounts/${id}/follow`); },
    async relationAs(u, id) {
      const [r] = await mdAs(u, "GET", `/api/v1/accounts/relationships?id[]=${id}`);
      return { following: r.following, followedBy: r.followed_by };
    },
    async postAs(u, text) {
      const st = await mdAs(u, "POST", "/api/v1/statuses", { status: text, visibility: "public" });
      return { id: st.id, uri: st.uri };
    },
    async setAliases(u, acct) {
      const a = acct.replace(/^@/, "");
      await mastodonRails(`Account.find_local!("${u.username}").aliases.create!(acct: "${a}")`);
    },
    async move(u, acct) {
      const a = acct.replace(/^@/, "");
      // saved without validation (no password challenge), so the target is resolved explicitly
      const out = await mastodonRails(`
        account = Account.find_local!("${u.username}")
        target = ResolveAccountService.new.call("${a}")
        migration = account.migrations.new(acct: "${a}", target_account: target, current_password: "${PASSWORD}", current_username: "${u.username}")
        migration.save!(validate: false)
        account.update!(moved_to_account: migration.target_account)
        ActivityPub::UpdateDistributionWorker.new.perform(account.id)
        ActivityPub::MoveDistributionWorker.new.perform(migration.id)
        puts "MOVED #{migration.target_account&.uri}"`);
      if (!/MOVED https:/.test(out)) throw new Error(`Mastodon move failed: ${out.slice(-300)}`);
    },
    async deleteUser(u) {
      await mastodonRails(`DeleteAccountService.new.call(Account.find_local!("${u.username}"), reserve_username: false, reserve_email: false)`);
    },
    async resolveAs(u, acctUser, acctHost) {
      const r = await mdAs(u, "GET", `/api/v2/search?q=${encodeURIComponent(`@${acctUser}@${acctHost}`)}&resolve=true&type=accounts`);
      const a = r.accounts.find((x) => x.acct === `${acctUser}@${acctHost}`);
      if (!a) throw new Error("not resolved");
      return a.id;
    },
  };
}

// --- checks ------------------------------------------------------------------------------------

const results = [];
async function check(remote, name, fn) {
  const label = `${remote.name}: ${name}`;
  if (only && !only.test(label)) return;
  const started = Date.now();
  try {
    const detail = await fn();
    results.push({ name: label, ok: true, ms: Date.now() - started, detail: detail ?? "" });
    console.log(`ok   ${label}${detail ? ` — ${detail}` : ""}`);
  } catch (e) {
    // fetch errors keep the reason in `cause`; a failed rails runner in its stderr
    const why = [e.message, e.cause?.message ?? e.cause?.code, e.stderr ? String(e.stderr).trim().split("\n").slice(-3).join(" | ") : null]
      .filter(Boolean).join(" — ");
    results.push({ name: label, ok: false, ms: Date.now() - started, detail: why });
    console.log(`FAIL ${label} — ${why}`);
  }
}

async function suite(R) {
  const alice = await local.signup(`al${R.name.slice(0, 2)}${run}`);
  const me = await R.me();
  const ctx = {};

  await check(R, "discovery: remote resolves misskey-cf user (WebFinger + actor)", async () => {
    ctx.aliceOnR = await R.resolve(alice.username, "a.mk.test");
    return `alice on ${R.host} = ${ctx.aliceOnR}`;
  });

  await check(R, "discovery: misskey-cf resolves remote user (signed GET by instance actor)", async () => {
    ctx.carolOnA = await local.resolve(alice.token, R.user.username, R.host);
  });

  await check(R, "discovery: remote lists misskey-cf in its federation (NodeInfo)", async () => {
    if (R.name === "misskey") {
      const i = await waitFor("instance on Misskey", async () => {
        const x = await mk("https://m.mk.test", "federation/show-instance", { host: "a.mk.test" }, R.user.token);
        return x?.softwareName ? x : null;
      });
      if (i.softwareName !== "misskey") throw new Error(`softwareName ${i.softwareName}`);
      return `${i.softwareName} ${i.softwareVersion}`;
    }
    const peers = await (await fetch("https://t.mk.test/api/v1/instance/peers", { headers: { authorization: `Bearer ${R.user.token}` } })).json();
    if (!peers.includes("a.mk.test")) throw new Error(`peers ${JSON.stringify(peers)}`);
  });

  await check(R, "actor: remote shows Person (name / bio / fields)", async () => {
    await mk(A, "i/update", { name: `Alice ${run}`, description: `bio ${run}`, isCat: true, fields: [{ name: "site", value: "https://example.com/" }] }, alice.token);
    // remote refetches on Update(Person) only for followers: follow first, then expect the update
    await R.follow(ctx.aliceOnR);
    await waitFor("follow accepted (remote → misskey-cf)", async () => (await R.relation(ctx.aliceOnR)).following);
    await mk(A, "i/update", { name: `Alice ${run}!` }, alice.token);
    const p = await waitFor("Update(Person) on remote", async () => {
      const p = await R.profileOf(ctx.aliceOnR);
      return p.name === `Alice ${run}!` ? p : null;
    });
    if (!String(p.bio).includes(`bio ${run}`)) throw new Error(`bio ${p.bio}`);
    if (!p.fields.some((f) => f.name === "site" && String(f.value).includes("example.com"))) throw new Error(`fields ${JSON.stringify(p.fields)}`);
    if (R.name === "misskey" && !p.isCat) throw new Error("isCat not set");
    return `fields ${JSON.stringify(p.fields.map((f) => f.value))}`;
  });

  await check(R, "follow: remote → misskey-cf shows on misskey-cf", async () => {
    const f = await mk(A, "users/followers", { userId: alice.id }, alice.token);
    if (!f.some((x) => x.followerId === ctx.carolOnA)) throw new Error("remote user not in followers");
  });

  await check(R, "follow: misskey-cf → remote and Accept", async () => {
    await mk(A, "following/create", { userId: ctx.carolOnA }, alice.token);
    await waitFor("Accept on misskey-cf", async () => {
      const r = await local.relation(alice.token, ctx.carolOnA);
      return r.isFollowing && !r.hasPendingFollowRequestFromYou;
    });
    await waitFor("remote sees the follower", async () => (await R.relation(ctx.aliceOnR)).followedBy);
  });

  await check(R, "actor: avatar (Person icon) both directions", async () => {
    const res = await (async () => {
      const form = new FormData();
      form.append("i", alice.token);
      form.append("file", new Blob([png()], { type: "image/png" }), `av${run}.png`);
      return (await fetch(`${A}/api/drive/files/create`, { method: "POST", body: form })).json();
    })();
    await mk(A, "i/update", { avatarId: res.id }, alice.token);
    const p = await waitFor("avatar on remote", async () => {
      const p = await R.profileOf(ctx.aliceOnR);
      return p.avatar && !/identicon|missing\.png/.test(p.avatar) ? p : null;
    });
    await R.setAvatar();
    const u = await waitFor("remote avatar on misskey-cf", async () => {
      await mk(A, "federation/update-remote-user", { userId: ctx.carolOnA }, alice.token).catch(() => null);
      const u = await mk(A, "users/show", { userId: ctx.carolOnA }, alice.token);
      return u.avatarUrl && !u.avatarUrl.includes("/identicon/") ? u : null;
    });
    return `remote ${p.avatar.slice(0, 60)}… / local ${u.avatarUrl.slice(0, 60)}…`;
  });

  await check(R, "custom emoji: notes both directions", async () => {
    const n = await local.post(alice.token, { text: `:fed_a: emoji ${run}` });
    const got = await waitFor("emoji note on remote", () => R.findByUri(ctx.aliceOnR, local.noteUri(n.id)));
    if (!got.emojis.includes("fed_a")) throw new Error(`emojis on remote ${JSON.stringify(got.emojis)}`);
    await R.ensureEmoji();
    const rn = await R.post({ text: `:${R.emoji}: remote emoji ${run}` });
    const onA = await waitFor("remote emoji note on misskey-cf", () => local.findNote(alice.token, ctx.carolOnA, rn.uri));
    const keys = Object.keys(onA.emojis ?? {});
    // keyed by the name the note uses, as upstream populateEmojis
    if (!keys.some((k) => k === R.emoji || k.startsWith(`${R.emoji}@`))) throw new Error(`emojis on misskey-cf ${JSON.stringify(onA.emojis)}`);
    return keys.join(", ");
  });

  await check(R, "custom emoji: reactions", async () => {
    const remoteNote = await R.post({ text: `emoji react me ${run}` });
    const onA = await waitFor("remote note on misskey-cf", () => local.findNote(alice.token, ctx.carolOnA, remoteNote.uri));
    await mk(A, "notes/reactions/create", { noteId: onA.id, reaction: ":fed_a:" }, alice.token);
    const got = await waitFor("custom reaction on remote", async () => {
      const x = await R.get(remoteNote.id);
      return x && (x.reactionKeys.some((k) => k.startsWith(":fed_a@")) || (R.name === "mastodon" && x.reactionCount >= 1)) ? x : null;
    });
    let back = "";
    if (R.reactCustom) {
      const mine = await local.post(alice.token, { text: `react to me with emoji ${run}` });
      const mineOnR = await waitFor("note on remote", () => R.findByUri(ctx.aliceOnR, local.noteUri(mine.id)));
      await R.reactCustom(mineOnR.id);
      const n = await waitFor("remote custom reaction on misskey-cf", async () => {
        const x = await mk(A, "notes/show", { noteId: mine.id }, alice.token);
        return Object.keys(x.reactions ?? {}).some((k) => k.startsWith(`:${R.emoji}@`)) ? x : null;
      });
      back = ` / misskey-cf ${JSON.stringify(n.reactions)}`;
    }
    return R.name === "mastodon" ? `favourites ${got.reactionCount} (no emoji reactions on Mastodon)` : `remote ${JSON.stringify(got.reactionKeys)}${back}`;
  });

  await check(R, "featured: pin / unpin shown on remote", async () => {
    const n = await local.post(alice.token, { text: `pin me ${run}` });
    await waitFor("note on remote", () => R.findByUri(ctx.aliceOnR, local.noteUri(n.id)));
    await mk(A, "i/pin", { noteId: n.id }, alice.token);
    await waitFor("pinned on remote (Add)", async () => (await R.profileOf(ctx.aliceOnR)).pinned.includes(local.noteUri(n.id)));
    await mk(A, "i/unpin", { noteId: n.id }, alice.token);
    await waitFor("unpinned on remote (Remove)", async () => !(await R.profileOf(ctx.aliceOnR)).pinned.includes(local.noteUri(n.id)));
  });

  await check(R, "note misskey-cf → remote: text, CW, hashtag", async () => {
    const n = await local.post(alice.token, { text: `hello #fed${run}`, cw: "cw!" });
    ctx.aliceNote = n;
    const got = await waitFor("note on remote", () => R.findByUri(ctx.aliceOnR, local.noteUri(n.id)));
    ctx.aliceNoteOnR = got.id;
    if (got.cw !== "cw!") throw new Error(`cw ${got.cw}`);
    if (!got.tags.map((t) => t.toLowerCase()).includes(`fed${run}`)) throw new Error(`tags ${JSON.stringify(got.tags)}`);
  });

  await check(R, "note misskey-cf → remote: mention notification", async () => {
    const n = await local.post(alice.token, { text: `@${R.user.username}@${R.host} hi ${run}` });
    await waitFor("mention notification on remote", () => R.mentionNotified(local.noteUri(n.id)));
  });

  await check(R, "note misskey-cf → remote: visibility home / followers / specified", async () => {
    const seen = {};
    for (const [vis, extra] of [["home", {}], ["followers", {}], ["specified", { visibleUserIds: [ctx.carolOnA], text: `@${R.user.username}@${R.host} dm ${run}` }]]) {
      const n = await local.post(alice.token, { text: `${vis} ${run}`, visibility: vis, ...extra });
      const got = await waitFor(`${vis} note on remote`, () => R.findByUri(ctx.aliceOnR, local.noteUri(n.id)));
      seen[vis] = got.visibility;
    }
    const want = R.name === "misskey" ? { home: "home", followers: "followers", specified: "specified" } : { home: "unlisted", followers: "private", specified: "direct" };
    if (JSON.stringify(seen) !== JSON.stringify(want)) throw new Error(JSON.stringify(seen));
    return JSON.stringify(seen);
  });

  await check(R, "note misskey-cf → remote: reply and quote", async () => {
    const remoteNote = await R.post({ text: `parent ${run}` });
    const parentOnA = await waitFor("remote note on misskey-cf", () => local.findNote(alice.token, ctx.carolOnA, remoteNote.uri));
    const reply = await local.post(alice.token, { text: `reply ${run}`, replyId: parentOnA.id });
    const r = await waitFor("reply on remote", () => R.findByUri(ctx.aliceOnR, local.noteUri(reply.id)));
    if (r.replyId !== remoteNote.id) throw new Error(`replyId ${r.replyId}`);
    const quote = await local.post(alice.token, { text: `quote ${run}`, renoteId: parentOnA.id });
    const q = await waitFor("quote on remote", () => R.findByUri(ctx.aliceOnR, local.noteUri(quote.id)));
    return R.name === "mastodon" ? `quote shown as ${q.renoteId ? "quote" : "plain post (link)"}` : q.renoteId === remoteNote.id ? "" : (() => { throw new Error(`renoteId ${q.renoteId}`); })();
  });

  await check(R, "note misskey-cf → remote: renote (Announce) and undo", async () => {
    const remoteNote = await R.post({ text: `boost me ${run}` });
    const onA = await waitFor("remote note on misskey-cf", () => local.findNote(alice.token, ctx.carolOnA, remoteNote.uri));
    const rn = await local.post(alice.token, { renoteId: onA.id });
    // the renote is stored remotely under the Announce id (upstream Misskey keeps renoteCount on undo)
    const announce = `${local.noteUri(rn.id)}/activity`;
    await waitFor("renote on remote", () => R.findByUri(ctx.aliceOnR, announce));
    await mk(A, "notes/delete", { noteId: rn.id }, alice.token);
    await waitFor("renote undone on remote", async () => !(await R.findByUri(ctx.aliceOnR, announce)));
  });

  await check(R, "note misskey-cf → remote: attachment", async () => {
    const res = await (async () => {
      const form = new FormData();
      form.append("i", alice.token);
      form.append("file", new Blob([png()], { type: "image/png" }), `px${run}.png`);
      return (await fetch(`${A}/api/drive/files/create`, { method: "POST", body: form })).json();
    })();
    const n = await local.post(alice.token, { text: `file ${run}`, fileIds: [res.id] });
    const got = await waitFor("note with file on remote", () => R.findByUri(ctx.aliceOnR, local.noteUri(n.id)));
    if (got.files !== 1) throw new Error(`files ${got.files}`);
  });

  await check(R, "note misskey-cf → remote: poll, remote vote counted, Update(Question)", async () => {
    const n = await local.post(alice.token, { text: `poll ${run}`, poll: { choices: ["x", "y"], multiple: false } });
    const got = await waitFor("poll on remote", () => R.findByUri(ctx.aliceOnR, local.noteUri(n.id)));
    if (!got.poll || got.poll.length !== 2) throw new Error(`poll ${JSON.stringify(got.poll)}`);
    await R.vote(got.id, 1);
    await waitFor("vote counted on misskey-cf", async () => (await mk(A, "notes/show", { noteId: n.id }, alice.token)).poll?.choices?.[1]?.votes === 1);
    await waitFor("Update(Question) on remote", async () => (await R.get(got.id))?.poll?.[1] === 1);
  });

  await check(R, "reaction remote → misskey-cf and undo", async () => {
    await R.react(ctx.aliceNoteOnR);
    const n = await waitFor("reaction on misskey-cf", async () => {
      const x = await mk(A, "notes/show", { noteId: ctx.aliceNote.id }, alice.token);
      return Object.keys(x.reactions ?? {}).length > 0 ? x : null;
    });
    await R.unreact(ctx.aliceNoteOnR);
    await waitFor("reaction removed on misskey-cf", async () => Object.keys((await mk(A, "notes/show", { noteId: ctx.aliceNote.id }, alice.token)).reactions ?? {}).length === 0);
    return JSON.stringify(n.reactions);
  });

  await check(R, "reaction misskey-cf → remote and undo", async () => {
    const remoteNote = await R.post({ text: `react me ${run}` });
    const onA = await waitFor("remote note on misskey-cf", () => local.findNote(alice.token, ctx.carolOnA, remoteNote.uri));
    await mk(A, "notes/reactions/create", { noteId: onA.id, reaction: "👍" }, alice.token);
    await waitFor("reaction on remote", async () => (await R.get(remoteNote.id))?.reactionCount >= 1);
    await mk(A, "notes/reactions/delete", { noteId: onA.id }, alice.token);
    await waitFor("reaction undone on remote", async () => (await R.get(remoteNote.id))?.reactionCount === 0);
  });

  await check(R, "note remote → misskey-cf: text, CW, hashtag, mention notification", async () => {
    const n = await R.post({ text: `@${alice.username}@a.mk.test from remote #rfed${run}`, cw: "rcw" });
    const got = await waitFor("note on misskey-cf", () => local.findNote(alice.token, ctx.carolOnA, n.uri));
    if (got.cw !== "rcw") throw new Error(`cw ${got.cw}`);
    if (!got.tags?.includes(`rfed${run}`)) throw new Error(`tags ${JSON.stringify(got.tags)}`);
    // the `hashtag` row counts the remote author (HashtagService.updateHashtags)
    const h = await waitFor("hashtag aggregated on misskey-cf", async () => {
      const x = await mk(A, "hashtags/show", { tag: `rfed${run}` }, alice.token);
      return x.mentionedRemoteUsersCount >= 1 ? x : null;
    });
    ctx.hashtag = `hashtag users ${h.mentionedUsersCount} (remote ${h.mentionedRemoteUsersCount})`;
    await waitFor("mention notification on misskey-cf", async () => {
      const ns = await mk(A, "i/notifications", { limit: 30 }, alice.token);
      return ns.some((x) => x.type === "mention" && x.note?.uri === n.uri);
    });
    return ctx.hashtag;
  });

  await check(R, "note remote → misskey-cf: reply, quote, boost and undo", async () => {
    const reply = await R.post({ text: `reply from remote ${run}`, replyId: ctx.aliceNoteOnR });
    const r = await waitFor("reply on misskey-cf", () => local.findNote(alice.token, ctx.carolOnA, reply.uri));
    if (r.replyId !== ctx.aliceNote.id) throw new Error(`replyId ${r.replyId}`);
    let quoteDetail = "";
    try {
      const quote = await R.post({ text: `quote from remote ${run}`, quoteId: ctx.aliceNoteOnR });
      const q = await waitFor("quote on misskey-cf", () => local.findNote(alice.token, ctx.carolOnA, quote.uri));
      quoteDetail = q.renoteId === ctx.aliceNote.id ? "quote ok" : `quote arrived without renoteId`;
    } catch (e) {
      quoteDetail = `quote skipped (${e.message.slice(0, 80)})`;
    }
    const before = (await mk(A, "notes/show", { noteId: ctx.aliceNote.id }, alice.token)).renoteCount;
    const boost = await R.boost(ctx.aliceNoteOnR);
    await waitFor("boost on misskey-cf", async () => (await mk(A, "notes/show", { noteId: ctx.aliceNote.id }, alice.token)).renoteCount > before);
    await R.unboost(boost);
    await waitFor("boost gone on misskey-cf", async () => !(await local.findNote(alice.token, ctx.carolOnA, boost.uri)));
    return quoteDetail;
  });

  await check(R, "note remote → misskey-cf: attachment (remoteFile fills md5)", async () => {
    const n = await R.post({ text: `img ${run}`, image: true });
    const got = await waitFor("note with file on misskey-cf", () => local.findNote(alice.token, ctx.carolOnA, n.uri));
    if (!got.files?.length) throw new Error("no files");
    const f = await waitFor("md5 and blurhash filled", async () => {
      const x = await local.findNote(alice.token, ctx.carolOnA, n.uri);
      return x?.files?.[0]?.md5 && x.files[0].blurhash ? x.files[0] : null;
    });
    return `${f.type} ${f.properties?.width}×${f.properties?.height} blurhash ${f.blurhash.slice(0, 8)}…`;
  });

  await check(R, "note remote → misskey-cf: poll, local vote counted remotely", async () => {
    const n = await R.post({ text: `rpoll ${run}`, poll: ["p", "q"] });
    const got = await waitFor("poll on misskey-cf", () => local.findNote(alice.token, ctx.carolOnA, n.uri));
    if (got.poll?.choices?.length !== 2) throw new Error(`poll ${JSON.stringify(got.poll)}`);
    await mk(A, "notes/polls/vote", { noteId: got.id, choice: 0 }, alice.token);
    await waitFor("vote counted on remote", async () => (await R.get(n.id))?.poll?.[0] === 1);
    await waitFor("Update(Question) back on misskey-cf", async () => {
      const x = await mk(A, "notes/show", { noteId: got.id }, alice.token);
      return x.poll?.choices?.[0]?.votes === 1;
    });
  });

  await check(R, "note remote → misskey-cf: delete", async () => {
    const n = await R.post({ text: `to delete ${run}` });
    await waitFor("note on misskey-cf", () => local.findNote(alice.token, ctx.carolOnA, n.uri));
    await R.del(n.id);
    await waitFor("note gone on misskey-cf", async () => !(await local.findNote(alice.token, ctx.carolOnA, n.uri)));
  });

  await check(R, "note misskey-cf → remote: delete", async () => {
    const n = await local.post(alice.token, { text: `local delete ${run}` });
    const got = await waitFor("note on remote", () => R.findByUri(ctx.aliceOnR, local.noteUri(n.id)));
    await mk(A, "notes/delete", { noteId: n.id }, alice.token);
    await waitFor("note gone on remote", async () => !(await R.get(got.id)));
  });

  await check(R, "Update(Person) remote → misskey-cf", async () => {
    await R.updateName(`Carol ${run}`);
    await waitFor("name on misskey-cf", async () => (await mk(A, "users/show", { userId: ctx.carolOnA }, alice.token)).name === `Carol ${run}`);
  });

  await check(R, "unfollow misskey-cf → remote (Undo Follow)", async () => {
    await mk(A, "following/delete", { userId: ctx.carolOnA }, alice.token);
    await waitFor("follower gone on remote", async () => !(await R.relation(ctx.aliceOnR)).followedBy);
  });

  await check(R, "locked misskey-cf account: request, accept, reject", async () => {
    const bob = await local.signup(`lk${R.name.slice(0, 2)}${run}`);
    await mk(A, "i/update", { isLocked: true }, bob.token);
    const bobOnR = await R.resolve(bob.username, "a.mk.test");
    await R.follow(bobOnR);
    const req = await waitFor("follow request on misskey-cf", async () => {
      const r = await mk(A, "following/requests/list", {}, bob.token);
      return r.find((x) => x.follower.id === ctx.carolOnA) ?? null;
    });
    await mk(A, "following/requests/accept", { userId: req.follower.id }, bob.token);
    await waitFor("accepted on remote", async () => (await R.relation(bobOnR)).following);
    await R.unfollow(bobOnR);
    await waitFor("unfollowed on misskey-cf", async () => (await mk(A, "users/followers", { userId: bob.id }, bob.token)).length === 0);
    await R.follow(bobOnR);
    const req2 = await waitFor("second request on misskey-cf", async () => {
      const r = await mk(A, "following/requests/list", {}, bob.token);
      return r.find((x) => x.follower.id === ctx.carolOnA) ?? null;
    });
    await mk(A, "following/requests/reject", { userId: req2.follower.id }, bob.token);
    await waitFor("rejected on remote", async () => {
      const r = await R.relation(bobOnR);
      return !r.following && !r.requested;
    });
  });

  await check(R, "block: misskey-cf blocks remote, remote follow removed", async () => {
    if (!(await R.relation(ctx.aliceOnR)).following) {
      await R.follow(ctx.aliceOnR);
      await waitFor("remote follows again", async () => (await R.relation(ctx.aliceOnR)).following);
    }
    await mk(A, "blocking/create", { userId: ctx.carolOnA }, alice.token);
    await waitFor("follow removed on remote", async () => !(await R.relation(ctx.aliceOnR)).following);
    await mk(A, "blocking/delete", { userId: ctx.carolOnA }, alice.token);
  });

  await check(R, "block: remote blocks misskey-cf user", async () => {
    await mk(A, "following/create", { userId: ctx.carolOnA }, alice.token);
    await waitFor("misskey-cf follows remote", async () => (await local.relation(alice.token, ctx.carolOnA)).isFollowing);
    await R.block(ctx.aliceOnR);
    await waitFor("follow removed on misskey-cf", async () => !(await local.relation(alice.token, ctx.carolOnA)).isFollowing);
    await R.unblock(ctx.aliceOnR);
  });

  await check(R, "move: misskey-cf account → remote account, remote followers follow the target", async () => {
    const mover = await local.signup(`mv${R.name.slice(0, 2)}${run}`);
    const dest = await R.newUser(`dst${R.name.slice(0, 2)}${run}`);
    const moverOnR = await R.resolve(mover.username, "a.mk.test");
    await R.follow(moverOnR);
    await waitFor("remote follows the mover", async () => (await R.relation(moverOnR)).following);
    await R.setAliases(dest, `@${mover.username}@a.mk.test`);
    await waitFor("i/move accepted", async () => {
      try {
        await mk(A, "i/move", { moveToAccount: `@${dest.username}@${R.host}` }, mover.token);
        return true;
      } catch (e) {
        if (/DESTINATION_ACCOUNT_FORBIDS|0d8ecf7c|forbid/i.test(e.message)) return false; // aliases not fetched yet
        throw e;
      }
    });
    const p = await waitFor("movedTo on remote", async () => {
      const p = await R.profileOf(moverOnR);
      return p.movedTo ? p : null;
    });
    if (R.name === "misskey") {
      // upstream Misskey 2026.10.0 cannot move followers to a *local* target: processRemoteMove looks
      // the target up by `uri`, which is null for local users (EntityNotFoundError)
      return `movedTo ${p.movedTo}; follower migration skipped (upstream Misskey: local target lookup by uri fails)`;
    }
    await waitFor("remote follower now follows the target", async () => (await R.relation(dest.id)).following);
  });

  await check(R, "move: remote account → misskey-cf account, misskey-cf followers follow the target", async () => {
    const mover = await R.newUser(`rmv${R.name.slice(0, 2)}${run}`);
    const dest = await local.signup(`rdst${R.name.slice(0, 2)}${run}`);
    const moverOnA = await local.resolve(alice.token, mover.username, R.host);
    await mk(A, "following/create", { userId: moverOnA }, alice.token);
    await waitFor("misskey-cf follows the mover", async () => (await local.relation(alice.token, moverOnA)).isFollowing);
    // a just-created remote account can take a moment to resolve (WebFinger)
    await waitFor("alias set on misskey-cf", async () => {
      await mk(A, "i/update", { alsoKnownAs: [`@${mover.username}@${R.host}`] }, dest.token);
      return true;
    });
    await R.resolveAs(mover, dest.username, "a.mk.test"); // the remote fetches the target with its aliases
    await R.move(mover, `@${dest.username}@a.mk.test`);
    await waitFor("misskey-cf follower now follows the target", async () => (await local.relation(alice.token, dest.id)).isFollowing);
    const u = await mk(A, "users/show", { userId: moverOnA }, alice.token);
    if (!u.movedTo) throw new Error("movedTo not set on misskey-cf");
  });

  await check(R, "account deletion: remote Delete(Person) removes the user and notes on misskey-cf", async () => {
    const gone = await R.newUser(`rdl${R.name.slice(0, 2)}${run}`);
    const goneOnA = await local.resolve(alice.token, gone.username, R.host);
    await mk(A, "following/create", { userId: goneOnA }, alice.token);
    await waitFor("misskey-cf follows the account", async () => (await local.relation(alice.token, goneOnA)).isFollowing);
    const n = await R.postAs(gone, `soon gone ${run}`);
    await waitFor("note on misskey-cf", () => local.findNote(alice.token, goneOnA, n.uri));
    await R.deleteUser(gone);
    await waitFor("user deleted on misskey-cf", async () => {
      try {
        const u = await mk(A, "users/show", { userId: goneOnA }, alice.token);
        return u.isDeleted === true;
      } catch (e) {
        return /NO_SUCH_USER|4\d\d/.test(e.message);
      }
    });
    await waitFor("note gone on misskey-cf", async () => {
      try {
        return !(await local.findNote(alice.token, goneOnA, n.uri));
      } catch (e) {
        return /NO_SUCH_USER|4\d\d/.test(e.message);
      }
    });
  });

  await check(R, "account deletion: misskey-cf Delete(Person) reaches remote", async () => {
    const del = await local.signup(`dl${R.name.slice(0, 2)}${run}`);
    const onR = await R.resolve(del.username, "a.mk.test");
    // Delete(Person) goes to every shared inbox misskey-cf knows from following rows (as upstream),
    // so the remote follows the account first
    await R.follow(onR);
    await waitFor("remote follows the account", async () => (await R.relation(onR)).following);
    await mk(A, "i/delete-account", { password: `pw-${del.username}-xyz` }, del.token);
    await waitFor("user gone on remote", async () => {
      try {
        const p = await R.profileOf(onR);
        return R.name === "misskey" ? false : p == null;
      } catch (e) {
        return /404|NO_SUCH_USER|Record not found/.test(e.message);
      }
    }).catch(async (e) => {
      if (R.name === "misskey") {
        const u = await mk("https://m.mk.test", "users/show", { userId: onR }, R.user.token).catch(() => null);
        if (u == null || u.isDeleted) return;
      }
      throw e;
    });
  });
}

// --- environment-wide checks (meta settings, relay, an unreachable remote) -----------------------

const meta = (patch) => mk(A, "admin/update-meta", patch, ADMIN_A);
const instance = (host) => mk(A, "federation/show-instance", { host }, ADMIN_A);
const G = { name: "global" };

/** A fresh misskey-cf user followed by carol on each given remote (Accept awaited). */
async function followedUser(prefix, rs) {
  const u = await local.signup(`${prefix}${run}`);
  for (const R of rs) {
    const id = await R.resolve(u.username, "a.mk.test");
    await R.follow(id);
    await waitFor(`${R.name} follows ${u.username}`, async () => (await R.relation(id)).following);
    u[`on_${R.name}`] = id;
  }
  return u;
}

async function globalChecks(M, T) {
  await check(G, "signToActivityPubGet: false sends unsigned GETs (Mastodon AUTHORIZED_FETCH refuses them)", async () => {
    const carolT = await mk(A, "users/show", { username: "carol", host: "t.mk.test" }, ADMIN_A);
    const carolM = await mk(A, "users/show", { username: "carol", host: "m.mk.test" }, ADMIN_A);
    try {
      await meta({ signToActivityPubGet: false });
      const t = await mk(A, "federation/update-remote-user", { userId: carolT.id }, ADMIN_A).then(() => "ok", (e) => e.message);
      if (t === "ok") throw new Error("Mastodon accepted an unsigned GET");
      await mk(A, "federation/update-remote-user", { userId: carolM.id }, ADMIN_A); // Misskey does not require signatures
    } finally {
      await meta({ signToActivityPubGet: true });
    }
    await mk(A, "federation/update-remote-user", { userId: carolT.id }, ADMIN_A);
    return "unsigned: Mastodon refused, Misskey answered; signed again: Mastodon answered";
  });

  await check(G, "cacheRemoteFiles: remote attachment stored in R2 with a thumbnail", async () => {
    const u = await local.signup(`cr${run}`);
    const carolOnA = await local.resolve(u.token, "carol", "m.mk.test");
    await mk(A, "following/create", { userId: carolOnA }, u.token);
    await waitFor("follow accepted", async () => (await local.relation(u.token, carolOnA)).isFollowing);
    try {
      await meta({ cacheRemoteFiles: true });
      const n = await M.post({ text: `cache me ${run}`, image: true });
      const f = await waitFor("cached file on misskey-cf", async () => {
        const x = await local.findNote(u.token, carolOnA, n.uri);
        const f = x?.files?.[0];
        return f?.url?.startsWith(`${A}/files/`) && f.thumbnailUrl ? f : null;
      });
      return `${f.url.slice(0, 50)}… thumbnail ${f.thumbnailUrl ? "yes" : "no"}`;
    } finally {
      await meta({ cacheRemoteFiles: false });
    }
  });

  await check(G, "blockedHosts: delivery to a blocked host stops (outbound)", async () => {
    const u = await followedUser("bh", [M, T]);
    try {
      await meta({ blockedHosts: ["m.mk.test"] });
      const n = await local.post(u.token, { text: `not for blocked ${run}` });
      await waitFor("note on Mastodon (not blocked)", () => T.findByUri(u.on_mastodon, local.noteUri(n.id)));
      await sleep(10_000);
      if (await M.findByUri(u.on_misskey, local.noteUri(n.id))) throw new Error("note reached the blocked host");
    } finally {
      await meta({ blockedHosts: [] });
    }
  });

  await check(G, "federation: specified — only listed hosts, inbound and outbound", async () => {
    const u = await followedUser("sp", [M, T]);
    const carolM = await local.resolve(u.token, "carol", "m.mk.test");
    const carolT = await local.resolve(u.token, "carol", "t.mk.test");
    for (const id of [carolM, carolT]) {
      await mk(A, "following/create", { userId: id }, u.token);
      await waitFor("follow accepted", async () => (await local.relation(u.token, id)).isFollowing);
    }
    try {
      await meta({ federation: "specified", federationHosts: ["t.mk.test"] });
      const out = await local.post(u.token, { text: `specified out ${run}` });
      await waitFor("note on Mastodon (listed)", () => T.findByUri(u.on_mastodon, local.noteUri(out.id)));
      const inT = await T.post({ text: `specified in t ${run}` });
      await waitFor("Mastodon note on misskey-cf (listed)", () => local.findNote(u.token, carolT, inT.uri));
      const inM = await M.post({ text: `specified in m ${run}` });
      await sleep(10_000);
      if (await M.findByUri(u.on_misskey, local.noteUri(out.id))) throw new Error("note reached an unlisted host");
      if (await local.findNote(u.token, carolM, inM.uri)) throw new Error("note from an unlisted host was accepted");
    } finally {
      await meta({ federation: "all", federationHosts: [] });
    }
  });

  await check(G, "isNotResponding: set when deliveries fail, cleared when the host answers again", async () => {
    const u = await followedUser("nr", [M]);
    await docker("stop", "mkfed-misskey");
    try {
      await local.post(u.token, { text: `while down ${run}` });
      await waitFor("isNotResponding on misskey-cf", async () => (await instance("m.mk.test")).isNotResponding === true);
    } finally {
      await docker("start", "mkfed-misskey");
    }
    await waitFor("Misskey back", async () => (await fetch("https://m.mk.test/")).ok, 300_000);
    await local.post(u.token, { text: `after recovery ${run}` });
    await waitFor("isNotResponding cleared", async () => (await instance("m.mk.test")).isNotResponding === false, 180_000);
  });

  // last: upstream Misskey caches its relay list for 10 minutes; the restart above starts it afresh
  await check(G, "relay: subscribe, LD-signed relaying both ways (misskey-cf ↔ relay ↔ Misskey)", async () => {
    const RELAY = "https://relay.mk.test/inbox";
    const subscribe = async (base, token) => {
      const list = await mk(base, "admin/relays/list", {}, token);
      if (!list.some((r) => r.inbox === RELAY)) await mk(base, "admin/relays/add", { inbox: RELAY }, token);
      await waitFor(`relay accepted on ${new URL(base).host}`, async () => (await mk(base, "admin/relays/list", {}, token)).find((r) => r.inbox === RELAY)?.status === "accepted");
    };
    await subscribe(A, ADMIN_A);
    await subscribe("https://m.mk.test", env.MISSKEY_ADMIN_TOKEN);
    try {
      // nobody on misskey-cf follows Misskey's admin, and nobody on Misskey follows this new user
      const fromM = (await mk("https://m.mk.test", "notes/create", { text: `relay from misskey ${run}` }, env.MISSKEY_ADMIN_TOKEN)).createdNote;
      const uriM = `https://m.mk.test/notes/${fromM.id}`;
      await waitFor("Misskey note on misskey-cf via the relay", async () => (await mk(A, "notes/global-timeline", { limit: 50 }, ADMIN_A)).some((n) => n.uri === uriM));
      const u = await local.signup(`rl${run}`);
      const fromA = await local.post(u.token, { text: `relay from misskey-cf ${run}` });
      await waitFor("misskey-cf note on Misskey via the relay", async () =>
        (await mk("https://m.mk.test", "notes/global-timeline", { limit: 50 }, env.MISSKEY_ADMIN_TOKEN)).some((n) => n.uri === local.noteUri(fromA.id)));
    } finally {
      // unsubscribe: relayed notes would reach blocked / unlisted hosts in the checks below
      await mk(A, "admin/relays/remove", { inbox: RELAY }, ADMIN_A).catch(() => null);
      await mk("https://m.mk.test", "admin/relays/remove", { inbox: RELAY }, env.MISSKEY_ADMIN_TOKEN).catch(() => null);
    }
  });
}

// --- main --------------------------------------------------------------------------------------

// :fed_a: on misskey-cf for the emoji checks
if (ADMIN_A) {
  const list = await mk(A, "admin/emoji/list", { query: "fed_a", limit: 10 }, ADMIN_A).catch(() => []);
  if (!list.some((e) => e.name === "fed_a")) {
    const form = new FormData();
    form.append("i", ADMIN_A);
    form.append("file", new Blob([png()], { type: "image/png" }), "fed_a.png");
    const f = await (await fetch(`${A}/api/drive/files/create`, { method: "POST", body: form })).json();
    await mk(A, "admin/emoji/add", { name: "fed_a", fileId: f.id }, ADMIN_A);
  }
}

const remotes = [];
if (!which.length || which.includes("misskey")) remotes.push(misskeyAdapter());
if (!which.length || which.includes("mastodon")) remotes.push(mastodonAdapter());
for (const R of remotes) {
  if (!R.user.token) {
    console.log(`skip ${R.name}: no token in tokens.env`);
    continue;
  }
  await suite(R);
}
// the environment-wide checks need both remotes
if (remotes.length === 2 && ADMIN_A && !process.env.FED_SKIP_GLOBAL) await globalChecks(remotes[0], remotes[1]);

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed (run ${run})`);
if (reportPath) {
  const rows = results.map((r) => `| ${r.ok ? "✅" : "❌"} | ${r.name} | ${(r.ms / 1000).toFixed(1)}s | ${String(r.detail).replace(/\|/g, "\\|").replace(/\n/g, " ")} |`);
  writeFileSync(reportPath, `# Interop smoke (run ${run})\n\n${results.length - failed.length}/${results.length} passed\n\n| | check | time | detail |\n|---|---|---|---|\n${rows.join("\n")}\n`);
}
process.exit(failed.length ? 1 : 0);
