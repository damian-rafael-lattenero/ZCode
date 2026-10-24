#!/usr/bin/env bash
# FORK (damian-rafael-lattenero): ensure the Diff Ask plugin is installed.
#
# The fork's Changes button, /diff and the plugin-grid card all resolve the
# plugin at RUNTIME and degrade to stock behavior when it is missing, so this
# step is optional — but the fork is meant to ship with Diff Ask, and this
# script makes that a one-command setup on any machine.
#
# Source resolution:
#   1. local dev checkout (default ~/Projects/zcode-diff-ask, override with
#      ZCODE_DIFF_ASK_REPO) — instant iteration, dist/panel.html is committed
#   2. GitHub repo damian-rafael-lattenero/zcode-diff-ask — no checkout needed
#
# Both sources produce the SAME marketplace id (dev-zcode-diff-ask-5098ef5a,
# from marketplace.json "name"), so the plugin id the fork hardcodes
# (FORK_DIFF_ASK_PLUGIN_ID) stays stable regardless of source. `marketplace
# add` re-binds an existing marketplace to the new source — re-running this
# script just switches local↔GitHub.
#
# Requires the fork app installed at /Applications/ZCode.app (uses its bundled
# runtime). Run AFTER build-install.sh, BEFORE the first app launch.
set -euo pipefail

HELPER="/Applications/ZCode.app/Contents/Frameworks/ZCode Helper.app/Contents/MacOS/ZCode Helper"
RUNTIME="/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs"
MARKETPLACE_ID="dev-zcode-diff-ask-5098ef5a"
PLUGIN_ID="diff-ask@${MARKETPLACE_ID}"

[ -x "$HELPER" ] || { echo "[diff-ask] $HELPER missing — install the fork first (scripts/build-install.sh)" >&2; exit 1; }
[ -f "$RUNTIME" ] || { echo "[diff-ask] $RUNTIME missing — install the fork first (scripts/build-install.sh)" >&2; exit 1; }

zc() { ELECTRON_RUN_AS_NODE=1 "$HELPER" "$RUNTIME" plugins "$@"; }

LOCAL_REPO="${ZCODE_DIFF_ASK_REPO:-$HOME/Projects/zcode-diff-ask}"
if [ -f "${LOCAL_REPO}/marketplace.json" ]; then
  SRC="$LOCAL_REPO"
  echo "[diff-ask] source: local checkout ($SRC)"
else
  SRC="damian-rafael-lattenero/zcode-diff-ask"
  echo "[diff-ask] source: GitHub ($SRC)"
fi

echo "[diff-ask] marketplace add (creates or re-binds ${MARKETPLACE_ID})..."
zc marketplace add "$SRC"

echo "[diff-ask] marketplace refresh..."
zc marketplace update "$MARKETPLACE_ID"

# install is idempotent: fresh → installs, existing → reinstalls at latest
# (a version rollback needs `plugins uninstall` first).
echo "[diff-ask] install..."
zc install "$PLUGIN_ID"

echo "[diff-ask] done — plugin ${PLUGIN_ID}. Restart ZCode if it is running."
