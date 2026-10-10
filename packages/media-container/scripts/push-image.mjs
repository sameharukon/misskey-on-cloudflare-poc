#!/usr/bin/env node
/**
 * Build + push the media container image WITHOUT Docker (box has no daemon):
 *   1. esbuild-bundle src/server.ts → stage/app/dist/server.mjs
 *   2. npm install --omit=dev sharp blurhash (linux-x64 glibc prebuilt) in stage/app
 *   3. copy a static ffmpeg (FFMPEG_STATIC=/path/to/ffmpeg) → stage/app/bin/ffmpeg
 *   4. tar the layer, `crane append` it onto node:22-bookworm-slim (linux/amd64),
 *      `crane mutate` workdir/env/cmd, push to registry.cloudflare.com/<account>/misskey-cf-media:<tag>
 * Registry credentials come from `wrangler containers registries credentials --push`
 * and are passed to `crane auth login --password-stdin` only (never printed).
 *
 * Usage: FFMPEG_STATIC=… CRANE=… node scripts/push-image.mjs <tag>
 * Prints the pushed image reference for packages/media/wrangler.toml.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const tag = process.argv[2];
if (!tag) throw new Error("usage: push-image.mjs <tag>");
const here = dirname(fileURLToPath(import.meta.url));
const pkg = resolve(here, "..");
const repo = resolve(pkg, "../..");
const crane = process.env.CRANE ?? "crane";
const ffmpeg = process.env.FFMPEG_STATIC;
if (!ffmpeg) throw new Error("FFMPEG_STATIC=/path/to/static/ffmpeg required");
const stage = join(process.env.STAGE_DIR ?? "/tmp", "mkcf-media-image");
const app = join(stage, "app");

rmSync(stage, { recursive: true, force: true });
mkdirSync(join(app, "dist"), { recursive: true });
mkdirSync(join(app, "bin"), { recursive: true });

// esbuild is this package's devDependency; resolve it from here (pnpm keeps it out of the root .bin)
const esbuild = createRequire(join(pkg, "package.json"))("esbuild");
esbuild.buildSync({ entryPoints: [join(pkg, "src/server.ts")], bundle: true, platform: "node", target: "node22", format: "esm",
  outfile: join(app, "dist/server.mjs"), external: ["sharp", "blurhash"], logLevel: "info" });

const deps = JSON.parse(execFileSync("node", ["-e", `process.stdout.write(JSON.stringify(require(${JSON.stringify(join(pkg, "package.json"))}).dependencies))`]).toString());
writeFileSync(join(app, "package.json"), JSON.stringify({ name: "misskey-cf-media-container", private: true, type: "module", dependencies: deps }, null, 2));
execFileSync("npm", ["install", "--omit=dev", "--no-audit", "--no-fund", "--os=linux", "--cpu=x64", "--libc=glibc"], { cwd: app, stdio: "inherit" });
cpSync(ffmpeg, join(app, "bin/ffmpeg"));
chmodSync(join(app, "bin/ffmpeg"), 0o755);

const layer = join(stage, "layer.tar");
execFileSync("tar", ["--owner=0", "--group=0", "--numeric-owner", "-C", stage, "-cf", layer, "app"], { stdio: "inherit" });

// registry login (password via stdin only)
const credJson = execFileSync("npx", ["wrangler", "containers", "registries", "credentials", "registry.cloudflare.com", "--push", "--pull", "--expiration-minutes", "30", "--json"],
  { cwd: join(repo, "packages/api"), stdio: ["ignore", "pipe", "ignore"] }).toString();
const cred = JSON.parse(credJson);
const host = cred.registry_host || "registry.cloudflare.com";
const login = spawnSync(crane, ["auth", "login", host, "-u", cred.username, "--password-stdin"], { input: cred.password, stdio: ["pipe", "ignore", "inherit"] });
if (login.status !== 0) throw new Error("crane auth login failed");

const ref = `${host}/${cred.account_id}/misskey-cf-media:${tag}`;
const base = execFileSync(crane, ["digest", "--platform", "linux/amd64", "docker.io/library/node:22-bookworm-slim"]).toString().trim();
execFileSync(crane, ["append", "-b", `docker.io/library/node:22-bookworm-slim@${base}`, "-f", layer, "-t", ref], { stdio: ["ignore", "ignore", "inherit"] });
const pushed = execFileSync(crane, ["mutate", ref, "-t", ref, "--workdir", "/app",
  "--env", "NODE_ENV=production", "--env", "PORT=8080", "--env", "FFMPEG_PATH=/app/bin/ffmpeg",
  "--exposed-ports", "8080", "--entrypoint", "node", "--cmd", "dist/server.mjs"]).toString().trim();
console.log(`pushed ${ref}`);
console.log(`digest ${pushed}`);
