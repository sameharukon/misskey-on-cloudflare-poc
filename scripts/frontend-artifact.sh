#!/usr/bin/env bash
# Keep the web client build (packages/gateway/public) in R2, so deploys do not rebuild it.
#
#   bash scripts/frontend-artifact.sh upload     # after `pnpm build-frontend`
#   bash scripts/frontend-artifact.sh download   # before deploying the gateway (scripts/deploy-all.sh)
#   bash scripts/frontend-artifact.sh key        # print the R2 key for this checkout
#
# The object key is `frontend/<stamp>.tar.gz`, <stamp> being scripts/frontend-stamp.sh for this
# checkout (upstream pin + frontend patches). `upload` refuses a build whose recorded stamp
# (.misskey-cf-frontend, written by build-frontend.sh) is not this checkout's, or that skipped the
# embed client; `download` fails when no build exists for the stamp, rather than deploying a
# client that does not match the code. Rebuild and upload whenever the pin or the patches change.
#
# Environment:
#   MISSKEY_CF_BUILD_BUCKET   R2 bucket (default: misskey-cf-build; create it once with
#                             `wrangler r2 bucket create misskey-cf-build`)
#   MISSKEY_CF_FRONTEND_OUT   build directory (default: <repo>/packages/gateway/public)
#   CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID  as for wrangler (set in Workers Builds)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${MISSKEY_CF_FRONTEND_OUT:-$ROOT/packages/gateway/public}"
BUCKET="${MISSKEY_CF_BUILD_BUCKET:-misskey-cf-build}"
STAMP="$(bash "$ROOT/scripts/frontend-stamp.sh")"
KEY="frontend/$STAMP.tar.gz"
WRANGLER="${MISSKEY_CF_WRANGLER:-$ROOT/node_modules/.bin/wrangler}"
[ -x "$WRANGLER" ] || WRANGLER="npx wrangler"

log() { printf '[frontend-artifact] %s\n' "$*"; }
die() { printf '[frontend-artifact] error: %s\n' "$*" >&2; exit 1; }

# value of `name=` in the build's .misskey-cf-frontend (empty when missing)
recorded() { sed -n "s/^$1=//p" "$OUT/.misskey-cf-frontend" 2>/dev/null | head -n1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

case "${1:-}" in
	key)
		echo "$KEY"
		;;
	upload)
		[ -f "$OUT/.misskey-cf-frontend" ] || die "no build in $OUT: run pnpm build-frontend first"
		[ "$(recorded stamp)" = "$STAMP" ] || die "the build in $OUT is for $(recorded stamp), this checkout needs $STAMP: run pnpm build-frontend again"
		[ "$(recorded skipEmbed)" != "1" ] || die "the build skipped the embed client (MISSKEY_CF_SKIP_EMBED=1): build it with the embed client to deploy"
		log "packing $OUT"
		tar -czf "$TMP/frontend.tar.gz" -C "$OUT" --exclude=./.gitkeep --exclude=./.assetsignore .
		SIZE="$(wc -c < "$TMP/frontend.tar.gz")"
		# wrangler uploads one object of up to 315 MB
		[ "$SIZE" -lt $((315 * 1000 * 1000)) ] || die "the archive is $SIZE bytes, over wrangler's 315 MB upload limit"
		log "uploading $SIZE bytes to r2://$BUCKET/$KEY"
		$WRANGLER r2 object put "$BUCKET/$KEY" --file "$TMP/frontend.tar.gz" --content-type application/gzip --remote
		log "done"
		;;
	download)
		if [ "$(recorded stamp)" = "$STAMP" ]; then
			log "$OUT already holds $STAMP"
			exit 0
		fi
		log "fetching r2://$BUCKET/$KEY"
		$WRANGLER r2 object get "$BUCKET/$KEY" --file "$TMP/frontend.tar.gz" --remote \
			|| die "no web client build for $STAMP in r2://$BUCKET: run pnpm build-frontend && pnpm frontend:upload for this commit"
		[ -s "$TMP/frontend.tar.gz" ] || die "no web client build for $STAMP in r2://$BUCKET: run pnpm build-frontend && pnpm frontend:upload for this commit"
		find "$OUT" -mindepth 1 -maxdepth 1 ! -name '.gitkeep' ! -name '.assetsignore' -exec rm -rf {} +
		tar -xzf "$TMP/frontend.tar.gz" -C "$OUT"
		[ "$(recorded stamp)" = "$STAMP" ] || die "the archive at $KEY records $(recorded stamp), not $STAMP"
		log "extracted $(find "$OUT" -type f | wc -l) files into $OUT"
		;;
	*)
		echo "usage: bash scripts/frontend-artifact.sh upload|download|key" >&2
		exit 2
		;;
esac
