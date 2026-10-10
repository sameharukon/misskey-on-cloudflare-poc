/**
 * Mail delivery (upstream core/EmailService.ts) on Cloudflare Email Service (Email Sending).
 *
 * `sendEmail()` enqueues a `sendEmail` job on `mk-jobs` (run inline, errors logged, without the
 * queue binding) so callers are not blocked, as upstream's fire-and-forget sends. The job reads
 * `meta` at send time: nothing is sent unless `meta.enableEmail` is on (upstream) and the
 * `EMAIL` (`[[send_email]]`) binding exists; the sender is `meta.email` with `meta.name` as the
 * display name. A thrown `EMAIL.send` error fails the job so the queue retries it (bounded by the
 * consumer's `max_retries`). The `smtp*` meta settings are not used (no SMTP on Workers).
 *
 * The HTML part is upstream's template, sanitize-html on the body and juice (CSS inlining), as
 * upstream; the HTML is rendered when the job runs.
 *
 * Also here: upstream's active address validation through the verifymail / truemail APIs
 * (`activeEmailValidation`), used by `validateEmailForAccountPg` (misc-pg.ts).
 */

/// <reference path="./juice-client.d.ts" />
import type { ApiEnv } from "./env.js";
import { withHyperdriveClient, type PgQueryable } from "./pg.js";
import { enqueueJob } from "./queues/jobs-queue.js";
import { metaRowPg } from "./user-lite-pg.js";

type Row = Record<string, unknown>;

export type SendEmailJob = { kind: "sendEmail"; to: string; subject: string; html: string; text: string };

/** upstream misc/escape-html.ts */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

/** The latest `meta` row as JSON (columns missing on older schemas read as undefined). */
export async function metaJson(c: PgQueryable): Promise<Row> {
  return metaRowPg(c);
}

function instanceUrl(env: ApiEnv): string {
  return (env.INSTANCE_URL ?? "https://localhost").replace(/\/$/, "");
}

/**
 * EmailService.sendEmail's HTML part: upstream's template with the body passed through
 * sanitize-html (default options) and the CSS inlined by juice (its Workers-safe client build).
 */
export async function renderEmailHtml(env: ApiEnv, meta: Row, subject: string, html: string): Promise<string> {
  // sanitize-html (htmlparser2, postcss) and juice load only when mail is sent, not at Worker start
  const [{ default: sanitizeHtml }, { default: juice }] = await Promise.all([import("sanitize-html"), import("juice/client")]);
  const url = instanceUrl(env);
  const host = (() => {
    try {
      return new URL(url).host;
    } catch {
      return url;
    }
  })();
  const iconUrl = `${url}/static-assets/mi-white.png`;
  const emailSettingUrl = `${url}/settings/email`;
  const sanitizedHtml = sanitizeHtml(html);
  const htmlContent = `<!doctype html>
<html>
	<head>
		<meta charset="utf-8">
		<title>${ escapeHtml(subject) }</title>
		<style>
			html {
				background: #eee;
			}

			body {
				padding: 16px;
				margin: 0;
				font-family: sans-serif;
				font-size: 14px;
			}

			a {
				text-decoration: none;
				color: #86b300;
			}
			a:hover {
				text-decoration: underline;
			}

			main {
				max-width: 500px;
				margin: 0 auto;
				background: #fff;
				color: #555;
			}
				main > header {
					padding: 32px;
					background: #86b300;
				}
					main > header > img {
						max-width: 128px;
						max-height: 28px;
						vertical-align: bottom;
					}
				main > article {
					padding: 32px;
				}
					main > article > h1 {
						margin: 0 0 1em 0;
					}
				main > footer {
					padding: 32px;
					border-top: solid 1px #eee;
				}

			nav {
				box-sizing: border-box;
				max-width: 500px;
				margin: 16px auto 0 auto;
				padding: 0 32px;
			}
				nav > a {
					color: #888;
				}
		</style>
	</head>
	<body>
		<main>
			<header>
				<img src="${ escapeHtml((meta.logoImageUrl as string | null | undefined) ?? (meta.iconUrl as string | null | undefined) ?? iconUrl) }"/>
			</header>
			<article>
				<h1>${ escapeHtml(subject) }</h1>
				<div>${ sanitizedHtml }</div>
			</article>
			<footer>
				<a href="${ escapeHtml(emailSettingUrl) }">${ 'Email setting' }</a>
			</footer>
		</main>
		<nav>
			<a href="${ escapeHtml(url) }">${ escapeHtml(host) }</a>
		</nav>
	</body>
</html>`;
  return juice(htmlContent);
}

/** An address for the logs: `a***@example.com` (the logs are kept and readable by operators). */
export function maskEmail(to: string): string {
  const at = to.lastIndexOf("@");
  return at > 0 ? `${to[0]}***${to.slice(at)}` : "***";
}

/**
 * EmailService.sendEmail, asynchronously: a `sendEmail` job on `mk-jobs`. Never throws (upstream
 * callers mostly do not await the send either).
 */
export async function sendEmail(env: ApiEnv, to: string, subject: string, html: string, text: string): Promise<void> {
  if (!env.EMAIL) {
    console.warn(`email to ${maskEmail(to)} (${subject}) dropped: no EMAIL binding`);
    return;
  }
  const job: SendEmailJob = { kind: "sendEmail", to, subject, html, text };
  try {
    if (env.Q_JOBS) await enqueueJob(env, job);
    else await runSendEmailJob(env, job);
  } catch (e) {
    console.warn(`email to ${maskEmail(to)} failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** The `sendEmail` job: throws when Email Service refuses the message (the queue retries). */
export async function runSendEmailJob(env: ApiEnv, job: SendEmailJob): Promise<void> {
  const meta = env.HYPERDRIVE?.connectionString ? await withHyperdriveClient(env.HYPERDRIVE, metaJson) : {};
  if (!meta.enableEmail) return; // upstream: `if (!this.meta.enableEmail) return;`
  if (!env.EMAIL) {
    console.warn(`email to ${maskEmail(job.to)} dropped: no EMAIL binding`);
    return;
  }
  const address = typeof meta.email === "string" ? meta.email : "";
  if (!address) {
    console.warn(`email to ${maskEmail(job.to)} dropped: meta.email is not set`);
    return;
  }
  const name = typeof meta.name === "string" && meta.name ? meta.name : null;
  const r = await env.EMAIL.send({
    from: name ? { email: address, name } : address,
    to: job.to,
    subject: job.subject,
    text: job.text,
    html: await renderEmailHtml(env, meta, job.subject, job.html),
  });
  console.log(`Message sent: ${r?.messageId ?? "?"}`);
}

// ---------------------------------------------------------------- active validation

export type EmailValidation = { valid: boolean; reason: string | null };

/**
 * EmailService.validateEmailForAccount's `enableActiveEmailValidation` branch: verifymail.io or a
 * truemail instance, otherwise deep-email-validator (deepEmailValidation below).
 */
export async function activeEmailValidation(env: ApiEnv, meta: Row, email: string): Promise<EmailValidation> {
  if (!meta.enableActiveEmailValidation) return { valid: true, reason: null };
  const f = env.AP_FETCH ?? fetch;
  if (meta.enableVerifymailApi && meta.verifymailAuthKey != null) {
    const res = await f(`https://verifymail.io/api/${email}?key=${meta.verifymailAuthKey}`, {
      method: "GET",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json, */*" },
    });
    const json = (await res.json()) as Partial<{ message: string; email_address: string; deliverable_email: boolean; disposable: boolean; mx: boolean }>;
    if (Object.keys(json).length === 1 && "message" in json) return { valid: false, reason: null };
    if (json.email_address === undefined) return { valid: false, reason: "format" };
    if (json.deliverable_email !== undefined && !json.deliverable_email) return { valid: false, reason: "smtp" };
    if (json.disposable) return { valid: false, reason: "disposable" };
    if (json.mx !== undefined && !json.mx) return { valid: false, reason: "mx" };
    return { valid: true, reason: null };
  }
  if (meta.enableTruemailApi && meta.truemailInstance && meta.truemailAuthKey != null) {
    try {
      const res = await f(`${meta.truemailInstance}?email=${email}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: String(meta.truemailAuthKey) },
      });
      const json = (await res.json()) as { email?: string; success?: boolean; errors?: { list_match?: string; regex?: string; mx?: string; smtp?: string } | null };
      if (json.email === undefined || json.errors?.regex) return { valid: false, reason: "format" };
      if (json.errors?.smtp) return { valid: false, reason: "smtp" };
      if (json.errors?.mx) return { valid: false, reason: "mx" };
      if (!json.success) return { valid: false, reason: json.errors?.list_match || "blacklist" };
      return { valid: true, reason: null };
    } catch {
      return { valid: false, reason: "network" };
    }
  }
  return deepEmailValidation(env, email);
}

/** deep-email-validator isEmail (its "regex" level). */
function deepIsEmail(email: string): boolean {
  const e = (email || "").trim();
  if (e.length === 0) return false;
  const split = e.split("@");
  if (split.length !== 2) return false;
  const [local, domain] = split as [string, string];
  if (!local || !domain || !domain.includes(".")) return false;
  return !/[\s\x00-\x1f\x7f]/.test(e);
}

let disposable: Promise<string> | null = null;

/**
 * Whether a domain is on the disposable-email-domains list deep-email-validator bundles (exact
 * match). The list is `disposable-domains.txt` (scripts/gen-disposable-domains.mjs), a Text
 * module searched for `\n<domain>\n`: as a JSON import it was parsed into 121k strings on first
 * use, ~70 ms of CPU and ~7 MB per isolate.
 */
async function isDisposableDomain(domain: string): Promise<boolean> {
  disposable ??= import("./disposable-domains.txt").then((m) => m.default);
  return (await disposable).includes(`\n${domain}\n`);
}

/** DNS-over-HTTPS resolver for MX lookups (Workers have no node:dns). */
export const DOH_URL = "https://cloudflare-dns.com/dns-query";

/** dns.resolveMx through DoH JSON: true when the domain has any MX record (errors count as none, as deep-email-validator). */
async function hasMx(env: ApiEnv, domain: string): Promise<boolean> {
  try {
    const res = await (env.AP_FETCH ?? fetch)(`${DOH_URL}?name=${encodeURIComponent(domain)}&type=MX`, { headers: { Accept: "application/dns-json" } });
    if (!res.ok) return false;
    const j = (await res.json()) as { Status?: number; Answer?: { type?: number }[] };
    return j.Status === 0 && (j.Answer ?? []).some((a) => a.type === 15);
  } catch {
    return false;
  }
}

/**
 * deep-email-validator `validate` with upstream's options: regex, disposable list (exact domain
 * match) and MX; typo and SMTP checks off, as upstream.
 */
export async function deepEmailValidation(env: ApiEnv, email: string): Promise<EmailValidation> {
  if (!deepIsEmail(email)) return { valid: false, reason: "regex" };
  const parts = email.split("@");
  if (parts.length !== 2 || !parts[1]) return { valid: false, reason: "regex" };
  const domain = parts[1];
  if (await isDisposableDomain(domain)) return { valid: false, reason: "disposable" };
  if (!(await hasMx(env, domain))) return { valid: false, reason: "mx" };
  return { valid: true, reason: null };
}

/** EmailService.validateEmailForAccount's mapping of validator reasons to the API's reasons. */
export function mapValidationReason(reason: string | null): string | null {
  const m: Record<string, string> = { regex: "format", disposable: "disposable", mx: "mx", smtp: "smtp", network: "network", blacklist: "blacklist", format: "format" };
  return reason ? (m[reason] ?? null) : null;
}
