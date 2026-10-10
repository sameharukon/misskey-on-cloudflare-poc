#!/usr/bin/env bash
# Print the identity of the web client build for this checkout: "<upstream rev>-<patches hash>".
#
# <upstream rev> is the upstream/misskey pin recorded in this repository's tree (the submodule
# does not need to be checked out). <patches hash> is the git blob hash of
# scripts/frontend-patches/*.patch concatenated in name order ("none" without patches), the same
# value build-frontend.sh uses. The build writes this stamp into its output
# (.misskey-cf-frontend), and frontend-artifact.sh stores the build in R2 under it.
#
# Usage: bash scripts/frontend-stamp.sh [<upstream rev>]   (default: the pin)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REV="${1:-$(git -C "$ROOT" rev-parse HEAD:upstream/misskey)}"

PATCHES=()
if [ -d "$ROOT/scripts/frontend-patches" ]; then
	while IFS= read -r p; do PATCHES+=("$p"); done < <(find "$ROOT/scripts/frontend-patches" -maxdepth 1 -type f -name '*.patch' | LC_ALL=C sort)
fi
if [ "${#PATCHES[@]}" -gt 0 ]; then
	PH="$(cat "${PATCHES[@]}" | git hash-object --stdin)"
else
	PH="none"
fi
echo "$REV-$PH"
