#!/usr/bin/env bash
# Detect upstream Misskey diffs for migrations / models / endpoints / misskey-js.
# Usage:
#   scripts/sync-upstream.sh           # report current pin + path presence
#   scripts/sync-upstream.sh --bump <sha|ref>   # fetch & checkout, print changelog vs previous
# Exit 2: submodule missing
# Exit 3: --bump produced unreviewed path changes (always for now — review required)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UPSTREAM="${ROOT}/upstream/misskey"
WATCH_PATHS=(
  packages/backend/migration
  packages/backend/src/models
  packages/backend/src/server/api/endpoint-list.ts
  packages/backend/src/server/api/endpoints
  packages/misskey-js
)

if [[ ! -e "${UPSTREAM}/.git" ]]; then
  echo "upstream/misskey is not a git submodule yet."
  echo "  git submodule update --init upstream/misskey"
  echo "See README.md (Upstream の同期)"
  exit 2
fi

PREV="$(cd "${UPSTREAM}" && git rev-parse HEAD)"

if [[ "${1:-}" == "--bump" ]]; then
  REF="${2:-origin/develop}"
  cd "${UPSTREAM}"
  git fetch --depth 1 origin "${REF}" 2>/dev/null || git fetch origin "${REF}"
  git checkout FETCH_HEAD 2>/dev/null || git checkout "${REF}"
  NEW="$(git rev-parse HEAD)"
  echo "== bumped ${PREV} -> ${NEW} =="
  echo ""
  echo "== changelog (watched paths) =="
  CHANGED=0
  for p in "${WATCH_PATHS[@]}"; do
    if git diff --stat "${PREV}..${NEW}" -- "$p" | grep -q .; then
      echo "--- $p ---"
      git diff --stat "${PREV}..${NEW}" -- "$p" || true
      CHANGED=1
    fi
  done
  if [[ "$CHANGED" -eq 0 ]]; then
    echo "(no changes in watched paths)"
    exit 0
  fi
  echo ""
  echo "REVIEW REQUIRED: watched paths changed. Update packages/db types, packers, API as needed."
  echo "Re-run without --bump after committing the new submodule pin."
  exit 3
fi

cd "${UPSTREAM}"
echo "== upstream HEAD =="
git rev-parse HEAD
git log -1 --oneline
echo ""
echo "== watched paths =="
MISSING=0
for p in "${WATCH_PATHS[@]}"; do
  if [[ -e "$p" ]]; then
    if [[ -d "$p" ]]; then
      count=$(find "$p" -type f | wc -l | tr -d ' ')
      echo "  present: $p ($count files)"
    else
      echo "  present: $p"
    fi
  else
    echo "  missing: $p"
    MISSING=1
  fi
done

# Quick endpoint count
EL="packages/backend/src/server/api/endpoint-list.ts"
if [[ -f "$EL" ]]; then
  n=$(grep -c "export \* as '" "$EL" || true)
  echo ""
  echo "endpoint-list exports: $n"
fi

if [[ "$MISSING" -ne 0 ]]; then
  echo "Some watched paths missing — update this script."
  exit 1
fi

# Endpoint gate metadata (secure / kind / requireCredential) must match the pin
echo ""
if ! node "${ROOT}/scripts/gen-endpoint-meta.mjs" --check; then
  echo "Run: node scripts/gen-endpoint-meta.mjs"
  exit 1
fi
# Endpoint paramDefs (validated by the router's call gate) must match the pin
if ! node "${ROOT}/scripts/gen-endpoint-params.mjs" --check; then
  echo "Run: node scripts/gen-endpoint-params.mjs"
  exit 1
fi

# Vendored schema migrations (packages/db/migrations) must match the pin
if ! node "${ROOT}/scripts/gen-migrations.mjs" --check; then
  echo "Run: node scripts/gen-migrations.mjs"
  exit 1
fi
# Kysely table types (packages/db/src/schema.gen.ts) must match the vendored migrations
if ! (cd "${ROOT}" && node --import tsx packages/db/scripts/gen-types.ts --check); then
  echo "Run: pnpm db:gen-types"
  exit 1
fi

echo ""
echo "OK: pin healthy. Use --bump <ref> to advance and print changelog."
