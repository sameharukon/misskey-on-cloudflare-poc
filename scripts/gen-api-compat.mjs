#!/usr/bin/env node
/**
 * Emit packages/api/API-COMPAT.md:
 * the compatibility status of every upstream endpoint (pinned upstream/misskey endpoint-list.ts) in
 * misskey-cf, as summary tables plus the list of endpoints that are not fully compatible.
 *
 * Notes: every packages/api/compat-notes/*.json is merged (one file per area, e.g. chat.json):
 * { "<endpoint or prefix/*>": { "status": "compatible" | "deviation" | "approx" | "unimplemented", "note": "...", "noteEn": "...", "summary": "...", "summaryEn": "..." } }
 * `note` / `noteEn` are the detailed notes for developers; `summaryEn` is the short phrase shown in
 * the table and is required for every entry that is not "compatible" (`summary` is its Japanese
 * counterpart, kept with the notes). An exact endpoint entry wins
 * over a prefix entry. Without an entry, implemented endpoints are "compatible" and the others
 * "unimplemented".
 *
 * Endpoints are split into two categories (README: Compatibility): admin-facing ones (admin/*, v2/admin/*,
 * requireAdmin / requireModerator, or an admin access-token kind) and user / third-party-client ones.
 *
 * Usage: node scripts/gen-api-compat.mjs [--check]
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const apiSrc = resolve(root, "packages/api/src");
const notesDir = resolve(root, "packages/api/compat-notes");

const listPath = resolve(root, "upstream/misskey/packages/backend/src/server/api/endpoint-list.ts");
if (!existsSync(listPath)) {
  console.error("gen-api-compat: upstream submodule not checked out");
  process.exit(2);
}
const upstream = [...readFileSync(listPath, "utf8").matchAll(/export\s+\*\s+as\s+'([^']+)'/g)].map((m) => m[1]);

/** IMPLEMENTED_ENDPOINTS from packages/api/src/registry.ts (derived from the handler table at runtime). */
function implementedEndpoints() {
  const out = execFileSync(process.execPath, ["--import", "tsx", "--import", "./scripts/test-hooks.mjs", resolve(root, "scripts/list-implemented-endpoints.mts")], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  return JSON.parse(out.trim().split("\n").pop());
}
const implemented = new Set(implementedEndpoints());

const metaSrc = readFileSync(resolve(apiSrc, "endpoint-meta.gen.ts"), "utf8");
const meta = JSON.parse(metaSrc.slice(metaSrc.indexOf("{", metaSrc.indexOf("=", metaSrc.indexOf("ENDPOINT_META"))), metaSrc.lastIndexOf("};") + 1));

const notes = {};
for (const f of existsSync(notesDir) ? readdirSync(notesDir).filter((f) => f.endsWith(".json")).sort() : []) {
  for (const [k, v] of Object.entries(JSON.parse(readFileSync(join(notesDir, f), "utf8")))) {
    if (notes[k]) {
      console.error(`gen-api-compat: ${k} has notes in more than one file (${f})`);
      process.exit(1);
    }
    notes[k] = v;
  }
}
const noteFor = (name) => {
  if (notes[name]) return notes[name];
  const parts = name.split("/");
  for (let i = parts.length - 1; i > 0; i--) {
    const k = `${parts.slice(0, i).join("/")}/*`;
    if (notes[k]) return notes[k];
  }
  return null;
};

const ORDER = ["compatible", "deviation", "approx", "unimplemented"];

/** "admin" for endpoints used only by moderators / admins (README: Compatibility), else "user". */
function categoryOf(name, m) {
  if (/^(v2\/)?admin\//.test(name)) return "admin";
  if (m.requireAdmin || m.requireModerator) return "admin";
  if (/(^|:)admin(:|$)/.test(m.kind ?? "")) return "admin";
  return "user";
}

const statusOf = (n, isImpl) => {
  if (!isImpl) return "unimplemented";
  const st = n?.status ?? "compatible";
  return st === "unimplemented" ? "compatible" : st;
};

const rows = upstream.map((name) => {
  const n = noteFor(name);
  return { name, status: statusOf(n, implemented.has(name)), category: categoryOf(name, meta[name] ?? {}), summary: n?.summary ?? "", summaryEn: n?.summaryEn ?? "" };
});

// upstream's special API routes (ApiServerService), outside endpoint-list.ts: sign-up / sign-in
const SPECIAL_ROUTES = ["signup", "signup-pending", "signin-flow", "signin-with-passkey"];
const srcFiles = readdirSync(apiSrc)
  .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.endsWith(".gen.ts"))
  .map((f) => readFileSync(join(apiSrc, f), "utf8"));
const specialImplemented = (name) =>
  existsSync(join(apiSrc, "endpoints", `${name}.ts`)) || srcFiles.some((src) => src.includes(`"${name}"`) || new RegExp(`^\\s{2}${name}: `, "m").test(src));
const specialRows = SPECIAL_ROUTES.map((name) => ({ name, status: statusOf(notes[name], specialImplemented(name)), category: "user", summary: notes[name]?.summary ?? "", summaryEn: notes[name]?.summaryEn ?? "" }));

const unknownNotes = Object.keys(notes).filter((k) => !k.endsWith("/*") && !upstream.includes(k) && !SPECIAL_ROUTES.includes(k));
if (unknownNotes.length) {
  console.error(`gen-api-compat: notes for unknown endpoints: ${unknownNotes.join(", ")}`);
  process.exit(1);
}
const noSummary = [...rows, ...specialRows].filter((r) => r.status !== "compatible" && r.status !== "unimplemented" && !r.summaryEn).map((r) => r.name);
if (noSummary.length) {
  console.error(`gen-api-compat: "summaryEn" missing for: ${noSummary.join(", ")}`);
  process.exit(1);
}

const esc = (s) => String(s).replace(/\|/g, "\\|").replace(/\n/g, " ");
const group = (name) => name.split("/")[0];
const count = (rs, st) => rs.filter((r) => r.status === st).length;
const catRows = (key) => rows.filter((r) => r.category === key);
const groupsOf = (rs) => [...new Set(rs.map((r) => group(r.name)))];
const CATEGORY_KEYS = ["user", "admin"];

/** Page text. */
const LOCALES = [
  {
    file: resolve(root, "packages/api/API-COMPAT.md"),
    label: { compatible: "Compatible", deviation: "Differs", approx: "Approximate", unimplemented: "Not implemented" },
    summaryOf: (r) => r.summaryEn,
    title: "API compatibility",
    intro: (n) => `Compatibility status of all ${n} endpoints of upstream Misskey (the pinned version).`,
    statusTitle: "Statuses",
    statusHead: "| Status | Meaning |",
    meaning: {
      compatible: "Same parameters, errors, responses, and behavior as upstream",
      deviation: "Implemented. Part of the behavior differs, for example because of Cloudflare constraints",
      approx: "Implemented. Parts that depend on Redis or BullMQ are approximated",
      unimplemented: "Not implemented (returns 501)",
    },
    categoryTitle: "Categories",
    categoryHead: "| Category | Policy |",
    categoryCol: "Category",
    categories: {
      user: { title: "User-facing", policy: "Strictly compatible with upstream. Behavior in third-party clients is guaranteed" },
      admin: { title: "Admin-facing", policy: "Used only by the admin UI and moderators. Optimization and changes are allowed" },
    },
    adminRule: "Endpoints whose names start with `admin/`, that require admin or moderator rights upstream, or that require an admin token permission are admin-facing.",
    totalsTitle: "Totals",
    count: "Count",
    total: "Total",
    group: "Group",
    byGroup: (t) => `By group (${t.toLowerCase()})`,
    diffTitle: "Endpoints that are not compatible",
    diffIntro: (l) => `Everything above that is not "${l}". Special routes outside endpoint-list (\`/api/signup\` and others) are included.`,
    diffHead: "| Endpoint | Status | Difference |",
    none: "None",
  },
];

function render(L) {
  const statusRow = (label, rs) => `| ${label} | ${rs.length} | ${ORDER.map((st) => count(rs, st) || "-").join(" | ")} |`;
  const statusHeader = (first) => `| ${first} | ${L.count} | ${ORDER.map((st) => L.label[st]).join(" | ")} |\n|---|---:|${ORDER.map(() => "---:").join("|")}|`;
  const title = (key) => L.categories[key].title;

  let md = `<!-- Generated by scripts/gen-api-compat.mjs from upstream/misskey and packages/api/compat-notes/*.json — do not edit by hand. -->
# ${L.title}

${L.intro(rows.length)}

## ${L.statusTitle}

${L.statusHead}
|---|---|
${ORDER.map((st) => `| ${L.label[st]} | ${L.meaning[st]} |`).join("\n")}

## ${L.categoryTitle}

${L.categoryHead}
|---|---|
${CATEGORY_KEYS.map((k) => `| ${title(k)} | ${L.categories[k].policy} |`).join("\n")}

${L.adminRule}

## ${L.totalsTitle}

${statusHeader(L.categoryCol)}
${CATEGORY_KEYS.map((k) => statusRow(title(k), catRows(k))).join("\n")}
${statusRow(L.total, rows)}
`;

  for (const k of CATEGORY_KEYS) {
    const rs = catRows(k);
    md += `\n## ${L.byGroup(title(k))}\n\n${statusHeader(L.group)}\n${groupsOf(rs).map((g) => statusRow(`\`${g}\``, rs.filter((r) => group(r.name) === g))).join("\n")}\n`;
  }

  // endpoints sharing a status and summary are listed in one row
  const diffRows = [...rows, ...specialRows.map((r) => ({ ...r, name: `/api/${r.name}` }))].filter((r) => r.status !== "compatible");
  const merged = [];
  for (const r of diffRows) {
    const summary = L.summaryOf(r);
    const hit = merged.find((m) => m.category === r.category && m.status === r.status && m.summary === summary);
    if (hit) hit.names.push(r.name);
    else merged.push({ category: r.category, status: r.status, summary, names: [r.name] });
  }
  md += `\n## ${L.diffTitle}\n\n${L.diffIntro(L.label.compatible)}\n`;
  for (const k of CATEGORY_KEYS) {
    const ms = merged.filter((m) => m.category === k);
    md += `\n### ${title(k)}\n\n`;
    if (!ms.length) {
      md += `${L.none}\n`;
      continue;
    }
    md += `${L.diffHead}\n|---|---|---|\n`;
    for (const m of ms) md += `| ${m.names.map((n) => `\`${n}\``).join("<br>")} | ${L.label[m.status]} | ${esc(m.summary)} |\n`;
  }
  return md;
}

const check = process.argv.includes("--check");
let stale = false;
for (const L of LOCALES) {
  const md = render(L);
  const rel = L.file.slice(root.length + 1);
  if (check) {
    if ((existsSync(L.file) ? readFileSync(L.file, "utf8") : "") !== md) {
      console.error(`gen-api-compat: ${rel} is stale; run node scripts/gen-api-compat.mjs`);
      stale = true;
    }
  } else {
    writeFileSync(L.file, md);
  }
}
if (check) {
  if (stale) process.exit(1);
  console.log("gen-api-compat: up to date");
} else {
  console.log(`gen-api-compat: wrote ${rows.length} endpoints (${ORDER.map((st) => `${st} ${count(rows, st)}`).join(", ")})`);
}
