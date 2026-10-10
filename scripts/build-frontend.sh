#!/usr/bin/env bash
# Build the pinned upstream Misskey web client (frontend, embed, service worker,
# locales, static/client assets, emoji assets) from the `upstream/misskey`
# submodule and copy the result into packages/gateway/public (Static Assets).
#
# The submodule tree itself is never modified: the pinned commit is exported
# (`git archive`) into a work directory, the patches in scripts/frontend-patches
# (*.patch, in name order) are applied to that copy, and it is built there.
#
# Usage:
#   bash scripts/build-frontend.sh            # or: pnpm build-frontend
#
# Environment:
#   MISSKEY_CF_FRONTEND_WORKDIR  work dir (default: <repo>/.frontend-build)
#   MISSKEY_CF_FRONTEND_OUT      output dir (default: <repo>/packages/gateway/public)
#   MISSKEY_CF_SKIP_EMOJI=1      do not copy /twemoji and /fluent-emoji (≈ 7k files)
#   MISSKEY_CF_SKIP_EMBED=1      do not build the embed client (/embed_vite)
#   MISSKEY_CF_CLEAN=1           wipe the work dir first (fresh install)
#   MISSKEY_CF_REUSE_BUILD=1     skip install + build, only re-copy an existing work-dir build
#   MISSKEY_CF_KEEP_UNLOCALIZED=1  also copy the unused unlocalized vite/scripts chunks
#   MISSKEY_CF_GITHUB_DEPS=auto|tarball|clone  how GitHub-hosted deps are fetched (see below)
#   NODE_OPTIONS                 defaults to --max-old-space-size=8192
#
# Output layout (mirrors upstream ClientServerService):
#   /vite/**            built/_frontend_vite_        (hashed, per-language script dirs)
#   /embed_vite/**      built/_frontend_embed_vite_
#   /assets/**          built/_frontend_dist_        (locales JSON for the SW)
#   /static-assets/**   packages/backend/assets
#   /client-assets/**   packages/frontend/assets
#   /twemoji/**, /fluent-emoji/**  @misskey-dev/emoji-assets
#   /sw.js              built/_sw_dist_/sw.js
#   /favicon.ico, /apple-touch-icon.png, /embed.js   from packages/backend/assets
#   /misskey-cf-client.json  boot info for the gateway shell (see packages/gateway/src/client-build.ts)
#   /.misskey-cf-frontend   build identity (scripts/frontend-stamp.sh), not served (.assetsignore)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/upstream/misskey"
WORK="${MISSKEY_CF_FRONTEND_WORKDIR:-$ROOT/.frontend-build}"
OUT="${MISSKEY_CF_FRONTEND_OUT:-$ROOT/packages/gateway/public}"
TREE="$WORK/misskey"

export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=8192}"
# pnpm >= 10 in upstream; let corepack pick the version pinned in upstream package.json.
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
export CI=1

log() { printf '\n[build-frontend] %s\n' "$*"; }

if [ ! -f "$SRC/package.json" ]; then
	log "initializing upstream/misskey submodule"
	git -C "$ROOT" submodule update --init --depth 1 upstream/misskey
fi

REV="$(git -C "$SRC" rev-parse HEAD)"
log "upstream misskey @ $REV"

PATCH_DIR="$ROOT/scripts/frontend-patches"
PATCHES=()
if [ -d "$PATCH_DIR" ]; then
	while IFS= read -r p; do PATCHES+=("$p"); done < <(find "$PATCH_DIR" -maxdepth 1 -type f -name '*.patch' | LC_ALL=C sort)
fi
# The export is reused while both the pin and the patches are unchanged.
STAMP="$REV"
if [ "${#PATCHES[@]}" -gt 0 ]; then
	STAMP="$REV $(cat "${PATCHES[@]}" | git hash-object --stdin)"
fi

if [ "${MISSKEY_CF_CLEAN:-0}" = "1" ]; then
	rm -rf "$WORK"
fi

# Export the pinned tree and apply the patches (keeps node_modules across runs of the same pin).
if [ ! -f "$TREE/.misskey-cf-rev" ] || [ "$(cat "$TREE/.misskey-cf-rev")" != "$STAMP" ]; then
	log "exporting $REV to $TREE"
	if [ -f "$TREE/.misskey-cf-rev" ] && [ "$(cut -d' ' -f1 "$TREE/.misskey-cf-rev")" = "$REV" ]; then
		# same pin, other patches: replace everything but the installed node_modules
		find "$TREE" -name node_modules -prune -o ! -type d -print0 | xargs -0 rm -f
	else
		rm -rf "$TREE"
	fi
	mkdir -p "$TREE"
	git -C "$SRC" archive --format=tar HEAD | tar -x -C "$TREE"
	for p in ${PATCHES[@]+"${PATCHES[@]}"}; do
		log "applying ${p#"$ROOT/"}"
		# GIT_CEILING_DIRECTORIES: apply to the export as a plain directory, not as part of this repository
		GIT_CEILING_DIRECTORIES="$(dirname "$TREE")" git -C "$TREE" apply "$p"
	done
	echo "$STAMP" > "$TREE/.misskey-cf-rev"
fi

cd "$TREE"

FILTERS=(--filter "frontend..." --filter "sw...")
if [ "${MISSKEY_CF_SKIP_EMBED:-0}" != "1" ]; then
	FILTERS+=(--filter "frontend-embed...")
fi

if [ "${MISSKEY_CF_REUSE_BUILD:-0}" = "1" ] && [ -d built/_frontend_vite_ ]; then
	log "MISSKEY_CF_REUSE_BUILD=1: reusing $TREE/built (skip install + build)"
else

# Restore the files the clone fallback below may have rewritten on a previous run.
git -C "$SRC" archive --format=tar HEAD packages/frontend/package.json pnpm-lock.yaml | tar -x -C "$TREE"

# GitHub-hosted deps are locked as codeload.github.com tarballs. Some sandboxes
# (e.g. Claude Code cloud) block codeload but allow `git clone`; in that case
# (or with MISSKEY_CF_GITHUB_DEPS=clone) clone them and relink:
#   aiscript-vscode (runtime: AiScript grammar for shiki) -> file: clone
#   storybook-addon-misskey-theme (storybook only)        -> dropped
# and install without --frozen-lockfile (only those two entries are re-resolved).
INSTALL_LOCK=(--frozen-lockfile)
GITHUB_DEPS="${MISSKEY_CF_GITHUB_DEPS:-auto}"
if [ "$GITHUB_DEPS" = "auto" ]; then
	AISCRIPT_TARBALL="$(grep -o 'https://codeload.github.com/aiscript-dev/aiscript-vscode/tar.gz/[0-9a-f]*' pnpm-lock.yaml | head -n1)"
	if [ -n "$AISCRIPT_TARBALL" ] && curl -fsS -o /dev/null --max-time 30 "$AISCRIPT_TARBALL" 2>/dev/null; then
		GITHUB_DEPS=tarball
	else
		GITHUB_DEPS=clone
	fi
fi
if [ "$GITHUB_DEPS" = "clone" ]; then
	log "codeload.github.com unavailable: cloning GitHub-hosted deps"
	AISCRIPT_REF="$(node -e "console.log(require('./packages/frontend/package.json').dependencies['aiscript-vscode'].split('#')[1] ?? '')")"
	AISCRIPT_DIR="$WORK/git-deps/aiscript-vscode-${AISCRIPT_REF:-HEAD}"
	if [ ! -f "$AISCRIPT_DIR/package.json" ]; then
		rm -rf "$AISCRIPT_DIR"
		git clone --depth 1 ${AISCRIPT_REF:+--branch "$AISCRIPT_REF"} https://github.com/aiscript-dev/aiscript-vscode "$AISCRIPT_DIR"
	fi
	node -e '
		const fs = require("fs");
		const p = "packages/frontend/package.json";
		const j = JSON.parse(fs.readFileSync(p, "utf-8"));
		j.dependencies["aiscript-vscode"] = "file:" + process.argv[1];
		delete j.devDependencies["storybook-addon-misskey-theme"];
		fs.writeFileSync(p, JSON.stringify(j, null, "\t") + "\n");
	' "$AISCRIPT_DIR"
	INSTALL_LOCK=(--no-frozen-lockfile)
fi

log "pnpm install (frontend / sw / embed and their workspace deps)"
# Root package (esbuild/execa/js-yaml used by build scripts), frontend-builder (imported
# by relative path from the vite build scripts) + the client packages.
# engine-strict is off because upstream's `engineStrict: true` also checks
# packages/backend's engines.node, which we never install or build here.
pnpm install "${INSTALL_LOCK[@]}" --config.engine-strict=false --filter misskey --filter frontend-builder "${FILTERS[@]}"

log "build workspace packages (i18n, misskey-js, icons-subsetter, reversi, bubble-game, sw, frontend, embed)"
rm -rf built
node scripts/build-pre.mjs
NODE_ENV=production pnpm --config.engine-strict=false "${FILTERS[@]}" -r --workspace-concurrency=1 run build

fi # MISSKEY_CF_REUSE_BUILD

for d in built/_frontend_vite_ built/_frontend_dist_ built/_sw_dist_; do
	[ -d "$d" ] || { echo "missing $d after build" >&2; exit 1; }
done

log "copying output to $OUT"
mkdir -p "$OUT"
# Remove previous build output but keep tracked placeholders.
find "$OUT" -mindepth 1 -maxdepth 1 ! -name '.gitkeep' ! -name '.assetsignore' -exec rm -rf {} +

cp -a built/_frontend_vite_ "$OUT/vite"
cp -a built/_frontend_dist_ "$OUT/assets"
if [ -d built/_frontend_embed_vite_ ]; then
	cp -a built/_frontend_embed_vite_ "$OUT/embed_vite"
fi
if [ "${MISSKEY_CF_KEEP_UNLOCALIZED:-0}" != "1" ]; then
	# The boot loader always imports CLIENT_ENTRY with `scripts` replaced by the
	# language (`/vite/<lang>/...`, written by frontend-builder's locale inliner),
	# and the localized chunks only import each other, so the unlocalized
	# `scripts/` copies (~470 files each) are never requested. Dropping them keeps
	# the upload under the Static Assets file-count limit.
	rm -rf "$OUT/vite/scripts" "$OUT/embed_vite/scripts" "$OUT/vite/mockServiceWorker.js"
fi
cp built/_sw_dist_/sw.js "$OUT/sw.js"
cp -a packages/backend/assets "$OUT/static-assets"
cp -a packages/frontend/assets "$OUT/client-assets"
cp packages/backend/assets/favicon.ico "$OUT/favicon.ico"
cp packages/backend/assets/apple-touch-icon.png "$OUT/apple-touch-icon.png"
cp packages/backend/assets/embed.js "$OUT/embed.js"

EMOJI_DIR="packages/frontend/node_modules/@misskey-dev/emoji-assets"
EMOJI_VERSION="$(node -e "console.log(require('./$EMOJI_DIR/package.json').version)")"
rm -f "$OUT/_redirects"
if [ "${MISSKEY_CF_SKIP_EMOJI:-0}" != "1" ]; then
	cp -a "$EMOJI_DIR/built/twemoji" "$OUT/twemoji"
	cp -a "$EMOJI_DIR/built/fluent-emoji" "$OUT/fluent-emoji"
else
	# Not uploaded: the asset store redirects /twemoji/* and /fluent-emoji/* to the same files on
	# jsDelivr (these paths skip the Worker, see run_worker_first in packages/gateway/wrangler.toml).
	cat > "$OUT/_redirects" <<REDIRECTS
/twemoji/* https://cdn.jsdelivr.net/npm/@misskey-dev/emoji-assets@${EMOJI_VERSION}/built/twemoji/:splat 302
/fluent-emoji/* https://cdn.jsdelivr.net/npm/@misskey-dev/emoji-assets@${EMOJI_VERSION}/built/fluent-emoji/:splat 302
REDIRECTS
fi

# Headers for assets served without invoking the Worker (see run_worker_first in
# packages/gateway/wrangler.toml); same lifetimes as upstream ClientServerService.
cat > "$OUT/_headers" <<'HEADERS'
/vite/*
  Cache-Control: public, max-age=2592000, immutable
/vite/loader/*
  ! Cache-Control
  Cache-Control: public, max-age=3600
/embed_vite/*
  Cache-Control: public, max-age=2592000, immutable
/embed_vite/loader/*
  ! Cache-Control
  Cache-Control: public, max-age=3600
/assets/*
  Cache-Control: public, max-age=604800
/static-assets/*
  Cache-Control: public, max-age=604800
/client-assets/*
  Cache-Control: public, max-age=604800
/twemoji/*
  Cache-Control: public, max-age=2592000
  Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'
/fluent-emoji/*
  Cache-Control: public, max-age=2592000
  Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'
/tarball/*
  Cache-Control: public, max-age=2592000
/sw.js
  Cache-Control: public, max-age=600
/embed.js
  Cache-Control: public, max-age=86400
/favicon.ico
  Cache-Control: public, max-age=3600
/apple-touch-icon.png
  Cache-Control: public, max-age=3600
HEADERS

log "writing misskey-cf-client.json"
node "$ROOT/scripts/frontend-client-info.mjs" "$TREE" "$OUT" "$REV" "$EMOJI_VERSION"

# Identity of this build (scripts/frontend-stamp.sh) and the options that shape it, checked by
# scripts/frontend-artifact.sh before the build is uploaded to R2 or deployed from there.
{
	echo "stamp=$(bash "$ROOT/scripts/frontend-stamp.sh" "$REV")"
	echo "skipEmoji=${MISSKEY_CF_SKIP_EMOJI:-0}"
	echo "skipEmbed=${MISSKEY_CF_SKIP_EMBED:-0}"
} > "$OUT/.misskey-cf-frontend"

FILES="$(find "$OUT" -type f ! -name _headers ! -name _redirects ! -name .gitkeep ! -name .assetsignore | wc -l)"
SIZE="$(du -sh "$OUT" | cut -f1)"
log "done: $FILES files, $SIZE in $OUT"
if [ "$FILES" -gt 20000 ]; then
	echo "warning: $FILES files exceeds the Workers Free plan Static Assets limit (20,000 files per version). Use a paid plan (100,000) or MISSKEY_CF_SKIP_EMOJI=1." >&2
fi
