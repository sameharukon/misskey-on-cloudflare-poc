/**
 * NodeInfo 2.0 / 2.1 (upstream NodeinfoServerService): built from meta, the local user and note
 * counts and the proxy account. Other servers keep these values (name, description, admins, …)
 * and show them on their instance pages.
 *
 * Counts and the proxy account name are cached per isolate for NODEINFO_TTL_MS (upstream caches
 * the whole document for 10 minutes); meta comes from loadMetaSource, so edits show sooner.
 */
import { DEFAULT_POLICIES, MAX_NOTE_TEXT_LENGTH } from "../../../packers/src/index.js";
import type { ApiEnv } from "../env.js";
import { buildPackConfig, loadMetaSource } from "../meta-source.js";
import { isolateCached, withHyperdriveClient } from "../pg.js";

export const NODEINFO_TTL_MS = 10 * 60_000;
const NODEINFO_HOMEPAGE = "https://misskey-hub.net";

export function nodeInfoLinks(base: string): { links: { rel: string; href: string }[] } {
  return {
    links: [
      { rel: "http://nodeinfo.diaspora.software/ns/schema/2.1", href: `${base}/nodeinfo/2.1` },
      { rel: "http://nodeinfo.diaspora.software/ns/schema/2.0", href: `${base}/nodeinfo/2.0` },
    ],
  };
}

type Stats = { users: number; localPosts: number; proxyAccountName: string | null };

async function loadStats(env: ApiEnv): Promise<Stats> {
  if (!env.HYPERDRIVE?.connectionString) return { users: 0, localPosts: 0, proxyAccountName: null };
  return withHyperdriveClient(env.HYPERDRIVE, (c) =>
    isolateCached(c, "nodeinfo:stats", NODEINFO_TTL_MS, async () => {
      // first: created on first use (upstream SystemAccountService.fetch), and counted below
      const { fetchSystemAccountC } = await import("./relay.js");
      const proxyId = await fetchSystemAccountC(c, "proxy");
      const proxy = await c.query(`SELECT username FROM "user" WHERE id = $1`, [proxyId]);
      // upstream reads the newest users / notes chart totals: every local row ever created
      const users = await c.query(`SELECT count(*)::int AS n FROM "user" WHERE host IS NULL`);
      const notes = await c.query(`SELECT count(*)::int AS n FROM note WHERE "userHost" IS NULL`);
      return {
        users: Number(users.rows[0]?.n ?? 0),
        localPosts: Number(notes.rows[0]?.n ?? 0),
        proxyAccountName: proxy.rows[0] ? String(proxy.rows[0].username) : null,
      };
    }),
  );
}

/** The NodeInfo document for `version` ("2.0" or "2.1"). */
export async function buildNodeInfo(env: ApiEnv, version: "2.0" | "2.1"): Promise<Record<string, unknown>> {
  const [meta, stats] = await Promise.all([loadMetaSource(env), loadStats(env)]);
  const config = buildPackConfig(env);
  const policies = { ...DEFAULT_POLICIES, ...meta.policies };
  const software: Record<string, unknown> =
    version === "2.1"
      ? { name: "misskey", version: config.version, homepage: meta.repositoryUrl, repository: meta.repositoryUrl }
      : { name: "misskey", version: config.version, homepage: NODEINFO_HOMEPAGE };
  return {
    version,
    software,
    protocols: ["activitypub"],
    services: { inbound: [], outbound: ["atom1.0", "rss2.0"] },
    openRegistrations: !meta.disableRegistration,
    usage: {
      // upstream leaves the active counts out (too heavy)
      users: { total: stats.users, activeHalfyear: null, activeMonth: null },
      localPosts: stats.localPosts,
      localComments: 0,
    },
    metadata: {
      nodeName: meta.name,
      nodeDescription: meta.description,
      nodeAdmins: [{ name: meta.maintainerName, email: meta.maintainerEmail }],
      // deprecated
      maintainer: { name: meta.maintainerName, email: meta.maintainerEmail },
      langs: meta.langs,
      tosUrl: meta.termsOfServiceUrl,
      privacyPolicyUrl: meta.privacyPolicyUrl,
      inquiryUrl: meta.inquiryUrl,
      impressumUrl: meta.impressumUrl,
      repositoryUrl: meta.repositoryUrl,
      feedbackUrl: meta.feedbackUrl,
      disableRegistration: meta.disableRegistration,
      disableLocalTimeline: !policies.ltlAvailable,
      disableGlobalTimeline: !policies.gtlAvailable,
      emailRequiredForSignup: meta.emailRequiredForSignup,
      enableHcaptcha: meta.enableHcaptcha,
      enableRecaptcha: meta.enableRecaptcha,
      enableMcaptcha: meta.enableMcaptcha,
      enableTurnstile: meta.enableTurnstile,
      maxNoteTextLength: MAX_NOTE_TEXT_LENGTH,
      enableEmail: meta.enableEmail,
      enableServiceWorker: meta.enableServiceWorker,
      proxyAccountName: stats.proxyAccountName,
      themeColor: meta.themeColor ?? "#86b300",
    },
  };
}

/** Response headers of upstream's NodeInfo routes. */
export function nodeInfoHeaders(version: "2.0" | "2.1"): Record<string, string> {
  return {
    "content-type": `application/json; profile="http://nodeinfo.diaspora.software/ns/schema/${version}#"`,
    "cache-control": "public, max-age=600",
    "access-control-allow-headers": "Accept",
    "access-control-allow-methods": "GET, OPTIONS",
    "access-control-allow-origin": "*",
    "access-control-expose-headers": "Vary",
  };
}
