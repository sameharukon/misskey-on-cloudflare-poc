#!/usr/bin/env node
/**
 * Compare implemented /api endpoints vs upstream endpoint-list.ts
 * Categories: tier-a | admin-min | rest
 */
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

const TIER_A = [
  "meta", "emojis", "emoji", "endpoints", "endpoint", "ping", "i",
  "notes/create", "notes/show", "notes/delete", "notes/timeline",
  "notes/local-timeline", "notes/hybrid-timeline",
  "notes/reactions", "notes/reactions/create", "notes/reactions/delete",
  "following/create", "following/delete",
  "blocking/create", "blocking/delete",
  "mute/create", "mute/delete",
  "drive", "drive/files", "drive/files/create", "drive/files/show",
  "i/notifications", "i/update",
];

const ADMIN_MIN = [
  "admin/meta", "admin/update-meta", "admin/show-user", "admin/show-users",
  "admin/server-info", "admin/queue/stats",
];

/** IMPLEMENTED_ENDPOINTS from packages/api/src/registry.ts (derived from the handler table at runtime). */
function implementedEndpoints() {
  const out = execFileSync(process.execPath, ["--import", "tsx", "--import", "./scripts/test-hooks.mjs", resolve(root, "scripts/list-implemented-endpoints.mts")], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  return JSON.parse(out.trim().split("\n").pop());
}

/** Paths relative to packages/api that imply an endpoint is implemented (convention). */
function loadImplemented() {
  const impl = new Set();
  const handlersDir = resolve(root, "packages/api/src/endpoints");
  if (existsSync(handlersDir)) {
    const walk = (dir, prefix = "") => {
      for (const ent of readdirSync(dir, { withFileTypes: true })) {
        if (ent.isDirectory()) walk(join(dir, ent.name), prefix ? `${prefix}/${ent.name}` : ent.name);
        else if (ent.name.endsWith(".ts") && ent.name !== "index.ts") {
          const base = ent.name.replace(/\.ts$/, "");
          impl.add(prefix ? `${prefix}/${base}` : base);
        }
      }
    };
    walk(handlersDir);
  }
  // Source of truth: IMPLEMENTED_ENDPOINTS in packages/api/src/registry.ts (handlers also live in *-pg.ts modules)
  for (const name of implementedEndpoints()) impl.add(name);
  return impl;
}

function loadUpstreamList() {
  const listPath = resolve(root, "upstream/misskey/packages/backend/src/server/api/endpoint-list.ts");
  if (!existsSync(listPath)) return null;
  const text = readFileSync(listPath, "utf8");
  // export * as 'path/to/endpoint' from '...'
  const found = [...text.matchAll(/export\s+\*\s+as\s+'([^']+)'/g)].map((m) => m[1]);
  return [...new Set(found)].sort();
}

const upstream = loadUpstreamList();
const implemented = loadImplemented();

console.log("misskey-cf endpoint coverage");
if (!upstream) {
  console.log("upstream list: NOT AVAILABLE (init submodule: git submodule update --init)");
  process.exit(2);
}

console.log(`upstream list: ${upstream.length} endpoints`);
console.log(`implemented:   ${implemented.size}`);

const missingTier = TIER_A.filter((e) => !implemented.has(e));
const missingAdmin = ADMIN_MIN.filter((e) => !implemented.has(e));
const upstreamSet = new Set(upstream);
const tierNotInUpstream = TIER_A.filter((e) => !upstreamSet.has(e));
const adminNotInUpstream = ADMIN_MIN.filter((e) => !upstreamSet.has(e));

console.log("");
console.log("tier-a missing:", missingTier.join(", ") || "(none)");
console.log("admin-min missing:", missingAdmin.join(", ") || "(none)");
if (tierNotInUpstream.length) console.log("tier-a not in upstream (rename?):", tierNotInUpstream.join(", "));
if (adminNotInUpstream.length) console.log("admin-min not in upstream (rename?):", adminNotInUpstream.join(", "));

const rest = upstream.filter((e) => !TIER_A.includes(e) && !ADMIN_MIN.includes(e) && !implemented.has(e));
console.log(`rest unimplemented: ${rest.length}`);
process.exit(0);
