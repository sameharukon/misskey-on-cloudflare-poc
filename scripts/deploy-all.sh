#!/usr/bin/env bash
# Deploy every Worker in dependency order: stream → timeline → media → api → gateway (a Worker
# that binds another one's Durable Object class needs it deployed first).
#
# The gateway's static assets (the web client) come from R2 (scripts/frontend-artifact.sh), so
# nothing heavy is built here; this is the deploy command of the Workers Builds connection
# (README "デプロイ"). The media Worker references a prebuilt Container image
# (packages/media-container/scripts/push-image.mjs), so no Docker is needed either.
#
# Usage: bash scripts/deploy-all.sh   (or pnpm deploy:all)
# Environment: as for wrangler (CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID),
# scripts/frontend-artifact.sh (MISSKEY_CF_BUILD_BUCKET), and the deployment's own values, which
# the committed wrangler.toml files leave as `__NAME__` placeholders:
#   MISSKEY_CF_DOMAIN               instance domain (INSTANCE_URL https://<domain>, the gateway's custom domain)
#   MISSKEY_CF_HYPERDRIVE_ID        Hyperdrive config id (api, timeline)
#   MISSKEY_CF_META_CACHE_KV_ID     KV namespace id of META_CACHE (api)
#   MISSKEY_CF_ACCOUNT_ID           Cloudflare account id in the media Container image URL
#                                   (default: CLOUDFLARE_ACCOUNT_ID)
# Each Worker is deployed from a copy of its wrangler.toml with them filled in
# (packages/<worker>/wrangler.deploy.toml, removed afterwards).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WRANGLER="${MISSKEY_CF_WRANGLER:-$ROOT/node_modules/.bin/wrangler}"
[ -x "$WRANGLER" ] || WRANGLER="npx wrangler"

log() { printf '\n[deploy-all] %s\n' "$*"; }
die() { printf '\n[deploy-all] error: %s\n' "$*" >&2; exit 1; }

MISSKEY_CF_ACCOUNT_ID="${MISSKEY_CF_ACCOUNT_ID:-${CLOUDFLARE_ACCOUNT_ID:-}}"
# checked before anything is deployed
for v in MISSKEY_CF_DOMAIN MISSKEY_CF_HYPERDRIVE_ID MISSKEY_CF_META_CACHE_KV_ID MISSKEY_CF_ACCOUNT_ID; do
	[ -n "${!v:-}" ] || die "$v is not set (see the header of scripts/deploy-all.sh)"
done

# packages/<worker>/wrangler.toml with the placeholders filled in, next to it (relative paths hold)
render() {
	local src="$ROOT/packages/$1/wrangler.toml" out="$ROOT/packages/$1/wrangler.deploy.toml"
	sed -e "s|__MISSKEY_CF_DOMAIN__|$MISSKEY_CF_DOMAIN|g" \
		-e "s|__MISSKEY_CF_HYPERDRIVE_ID__|$MISSKEY_CF_HYPERDRIVE_ID|g" \
		-e "s|__MISSKEY_CF_META_CACHE_KV_ID__|$MISSKEY_CF_META_CACHE_KV_ID|g" \
		-e "s|__MISSKEY_CF_ACCOUNT_ID__|$MISSKEY_CF_ACCOUNT_ID|g" "$src" >"$out"
	if grep -q "__MISSKEY_CF_[A-Z_]*__" "$out"; then
		die "unfilled placeholder in $out: $(grep -o "__MISSKEY_CF_[A-Z_]*__" "$out" | sort -u | tr '\n' ' ')"
	fi
	printf '%s' "$out"
}
cleanup() { rm -f "$ROOT"/packages/*/wrangler.deploy.toml; }
trap cleanup EXIT

WORKERS=(stream timeline media api gateway)
declare -A CONFIG
for w in "${WORKERS[@]}"; do CONFIG[$w]="$(render "$w")"; done

# fetch the client first: a missing build stops the deploy before any Worker changes
bash "$ROOT/scripts/frontend-artifact.sh" download

# Workers Builds runs this as the gateway's deploy command and tells wrangler which Worker it
# builds: WRANGLER_CI_OVERRIDE_NAME replaces the config's name (so every deploy would land on
# misskey-cf-gateway) and WRANGLER_CI_MATCH_TAG checks the Worker against the gateway's. Only the
# gateway deploy keeps them.
for w in "${WORKERS[@]}"; do
	log "deploying $w"
	if [ "$w" = "gateway" ]; then
		$WRANGLER deploy --config "${CONFIG[$w]}"
	else
		env -u WRANGLER_CI_OVERRIDE_NAME -u WRANGLER_CI_MATCH_TAG $WRANGLER deploy --config "${CONFIG[$w]}"
	fi
done
log "done"
