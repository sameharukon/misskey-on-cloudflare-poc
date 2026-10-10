#!/usr/bin/env node
/**
 * Write packages/api/src/disposable-domains.txt from the installed disposable-email-domains (the
 * list deep-email-validator uses upstream): one domain per line, with a newline before the first
 * and after the last, so the api Worker finds `\n<domain>\n` in it. wrangler bundles `.txt` as a
 * Text module, so the list is not parsed as JavaScript.
 *
 * Usage: node scripts/gen-disposable-domains.mjs [--check]
 */
import { createRequire } from "node:module";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(resolve(root, "packages/api/package.json"));
const list = require("disposable-email-domains");
const out = resolve(root, "packages/api/src/disposable-domains.txt");
const text = `\n${list.join("\n")}\n`;

if (process.argv.includes("--check")) {
  if (!existsSync(out) || readFileSync(out, "utf8") !== text) {
    console.error("gen-disposable-domains: packages/api/src/disposable-domains.txt is stale; run node scripts/gen-disposable-domains.mjs");
    process.exit(1);
  }
  console.log("gen-disposable-domains: up to date");
} else {
  writeFileSync(out, text);
  console.log(`gen-disposable-domains: wrote ${list.length} domains`);
}
