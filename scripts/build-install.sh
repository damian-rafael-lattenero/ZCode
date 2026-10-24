#!/usr/bin/env bash
# FORK (damian-rafael-lattenero): rebuild the fork and swap it into /Applications.
# Usage: scripts/build-install.sh [--keep-prev]
#
# Ritual (see FORK.md):
#   1. bundle the desktop app from the CURRENT working tree (branch damian)
#   2. verify the produced .app launches from the build output dir (smoke, manual)
#   3. atomically swap /Applications/ZCode.app (previous build -> ZCode.prev.app
#      when --keep-prev, else discarded; the official app can always be
#      re-downloaded as rollback)
#
# The build is unsigned/ad-hoc on purpose: the Squirrel auto-updater only applies
# Z.ai-signed payloads, so updates arrive EXCLUSIVELY via scripts/sync-upstream.sh.
set -euo pipefail
cd "$(dirname "$0")/.."

KEEP_PREV="${1:-}"
MISE=/opt/homebrew/bin/mise

echo "[fork] node/pnpm via mise..."
"$MISE" install

echo "[fork] bundle:desktop (ZCODE_ENV=production, no signing)..."
ZCODE_ENV=production CSC_IDENTITY_AUTO_DISCOVERY=false \
  ELECTRON_MIRROR=https://artifacts.electronjs.org/ \
  "$MISE" exec -- node scripts/mise-run.mjs pnpm bundle:desktop

DIST_DIR="packages/desktop/dist"
ZIP="$(ls -t "$DIST_DIR"/ZCode-*-mac-arm64.zip | head -1)"
echo "[fork] built: $ZIP"

STAGE="$(mktemp -d)/stage"
ditto -x -k "$ZIP" "$STAGE"
APP_PATH="$(find "$STAGE" -maxdepth 1 -name 'ZCode*.app' -print -quit)"
[ -n "$APP_PATH" ] || { echo "[fork] no .app inside $ZIP" >&2; exit 1; }

echo "[fork] smoke: launching the built app from staging (close it manually when satisfied)..."
open "$APP_PATH"
read -r -p "[fork] app looks good? press Enter to swap /Applications/ZCode.app (Ctrl-C to abort) "

if pgrep -x ZCode >/dev/null 2>&1; then
  echo "[fork] ZCode is running — quit it first (the bot relaunches over the same path)." >&2
  exit 1
fi

if [ "$KEEP_PREV" = "--keep-prev" ] && [ -d /Applications/ZCode.app ]; then
  rm -rf /Applications/ZCode.prev.app
  mv /Applications/ZCode.app /Applications/ZCode.prev.app
  echo "[fork] previous build kept at /Applications/ZCode.prev.app"
else
  rm -rf /Applications/ZCode.app
fi

ditto "$APP_PATH" /Applications/ZCode.app
# Locally built bundles carry no quarantine xattr; ad-hoc sign for consistency.
codesign --force --deep --sign - /Applications/ZCode.app >/dev/null 2>&1 || true

echo "[fork] installed: $(defaults read /Applications/ZCode.app/Contents/Info.plist CFBundleShortVersionString) at /Applications/ZCode.app"

# FORK CHANGE (damian): ship with Diff Ask — ensure its marketplace + install
# (runtime-resolved, optional: the fork degrades to stock git review without it).
echo "[fork] ensuring the Diff Ask plugin..."
bash scripts/bootstrap-diff-ask.sh || echo "[fork] WARN: Diff Ask bootstrap failed — install it manually (Plugins → Personal)"

open -a ZCode
echo "[fork] done — verify: New tab → App plugins grid shows Diff Ask; bot turn works; /diff works."
