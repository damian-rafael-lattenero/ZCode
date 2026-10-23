#!/usr/bin/env bash
# FORK (damian-rafael-lattenero): bring upstream zai-org/ZCode changes into the
# fork's `damian` branch. See FORK.md for the full ritual and the version ledger.
# Usage: scripts/sync-upstream.sh
set -euo pipefail
cd "$(dirname "$0")/.."

MISE=/opt/homebrew/bin/mise

echo "[fork] fetching upstream..."
git fetch upstream main

BEHIND="$(git rev-list --count damian..upstream/main)"
if [ "$BEHIND" -eq 0 ]; then
  echo "[fork] damian is already up to date with upstream/main."
  exit 0
fi
echo "[fork] $BEHIND upstream commit(s) to merge. Upstream version:"
git show upstream/main:package.json | python3 -c 'import json,sys; print("  upstream:", json.load(sys.stdin)["version"])'

CURRENT_BRANCH="$(git branch --show-current)"
if [ "$CURRENT_BRANCH" != "damian" ]; then
  echo "[fork] not on branch damian (on '$CURRENT_BRANCH'). Aborting." >&2
  exit 1
fi
if [ -n "$(git status --porcelain)" ]; then
  echo "[fork] working tree is dirty. Commit or stash first." >&2
  exit 1
fi

echo "[fork] merging upstream/main into damian..."
git merge upstream/main

echo "[fork] gates: unit tests (plugin-ui recommendations) + typecheck..."
"$MISE" exec -- pnpm exec vitest run \
  packages/ui/test/useUiPluginRecommendations.test.ts \
  packages/ui/test/useRecommendedUiPlugins.test.ts
"$MISE" run typecheck

UPSTREAM_VERSION="$(git show upstream/main:package.json | python3 -c 'import json,sys; print(json.load(sys.stdin)["version"])')"
TAG="damian-v${UPSTREAM_VERSION}-$(date +%Y%m%d)"

cat <<EOF
[fork] merge complete. Next steps:
  1. Review the merge (conflicts, if any, should touch only the [fork] files).
  2. scripts/build-install.sh          # rebuild + swap /Applications/ZCode.app
  3. git push origin damian
  4. git tag '$TAG' && git push origin '$TAG'
  5. Append the tag to FORK.md's ledger.
EOF
