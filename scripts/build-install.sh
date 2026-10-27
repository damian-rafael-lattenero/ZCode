#!/usr/bin/env bash
# FORK (damian-rafael-lattenero): rebuild the fork and swap it into /Applications.
# Usage: scripts/build-install.sh [--keep-prev] [--yes] [--when-quit] [--zip <path>]
#
# Ritual (see FORK.md):
#   1. bundle the desktop app from the CURRENT working tree (branch damian)
#   2. verify the produced .app launches from the build output dir (smoke,
#      manual — skipped with --yes: an unattended run pops no windows)
#   3. atomically swap /Applications/ZCode.app (previous build -> ZCode.prev.app
#      when --keep-prev, else discarded; the official app can always be
#      re-downloaded as rollback)
#
# Modes (27/10 lessons — the installer must ALWAYS work):
#   default        interactive: build → smoke → Enter → swap (app must be closed)
#   --yes          unattended: no smoke window, no prompt (CI, detached runs —
#                  a closed stdin used to kill the script AT the read)
#   --when-quit    arm a DETACHED waiter (own session: survives the caller,
#                  interruptions included) that installs the LAST built zip the
#                  moment the app quits, then reopens it and announces on
#                  Telegram (token/chat from the bot's own config — the
#                  announcement works even with the app gone). Damian's whole
#                  gesture becomes ⌘Q.
#   --zip <path>   install that zip instead of building (pair with --when-quit).
#
# The build is unsigned/ad-hoc on purpose: the Squirrel auto-updater only applies
# Z.ai-signed payloads, so updates arrive EXCLUSIVELY via scripts/sync-upstream.sh.
set -euo pipefail
cd "$(dirname "$0")/.."

KEEP_PREV=""
YES=""
WHEN_QUIT=""
ZIP_OVERRIDE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --keep-prev) KEEP_PREV="$1" ;;
    --yes) YES="$1" ;;
    --when-quit) WHEN_QUIT="$1" ;;
    --zip) ZIP_OVERRIDE="$2"; shift ;;
    *) echo "[fork] unknown flag: $1" >&2; exit 2 ;;
  esac
  shift
done

MISE=/opt/homebrew/bin/mise

install_zip() {
  # $1 = zip path. Assumes the app is NOT running (checked by the caller).
  local zip="$1"
  local stage app v
  stage="$(mktemp -d)/stage"
  ditto -x -k "$zip" "$stage"
  app="$(find "$stage" -maxdepth 1 -name 'ZCode*.app' -print -quit)"
  [ -n "$app" ] || { echo "[fork] no .app inside $zip" >&2; return 1; }
  if [ "$KEEP_PREV" = "--keep-prev" ] && [ -d /Applications/ZCode.app ]; then
    rm -rf /Applications/ZCode.prev.app
    mv /Applications/ZCode.app /Applications/ZCode.prev.app
    echo "[fork] previous build kept at /Applications/ZCode.prev.app"
  else
    rm -rf /Applications/ZCode.app
  fi
  ditto "$app" /Applications/ZCode.app
  # Locally built bundles carry no quarantine xattr; ad-hoc sign for consistency.
  codesign --force --deep --sign - /Applications/ZCode.app >/dev/null 2>&1 || true
  v="$(defaults read /Applications/ZCode.app/Contents/Info.plist CFBundleShortVersionString)"
  echo "[fork] installed: $v at /Applications/ZCode.app"
  # FORK CHANGE (damian): ship with Diff Ask — ensure its marketplace + install
  # (runtime-resolved, optional: the fork degrades to stock git review without it).
  echo "[fork] ensuring the Diff Ask plugin..."
  bash scripts/bootstrap-diff-ask.sh || echo "[fork] WARN: Diff Ask bootstrap failed — install it manually (Plugins → Personal)"
  open -a ZCode
  # The bot's Telegram config (if present) announces the swap — the one-shot
  # curl is independent of the app AND of the bot's transport.
  CFG="$HOME/.zcode/telegram-remote.json"
  if [ -f "$CFG" ]; then
    TOKEN=$(/usr/bin/python3 -c "import json;print(json.load(open('$CFG')).get('token',''))" 2>/dev/null || true)
    CHAT=$(/usr/bin/python3 -c "import json;print(json.load(open('$CFG')).get('chat_id',''))" 2>/dev/null || true)
    [ -n "${TOKEN:-}" ] && [ -n "${CHAT:-}" ] && curl -s -m 10 \
      "https://api.telegram.org/bot$TOKEN/sendMessage" -d chat_id="$CHAT" \
      -d text="✅ Fork instalado (v$v) y app reabierta." >/dev/null 2>&1 || true
  fi
  echo "[fork] done — verify: New tab → App plugins grid shows Diff Ask; bot turn works; /diff works."
}

if [ -n "$WHEN_QUIT" ]; then
  # Armed mode: build now unless --zip, then detach the swap-waiter in its
  # OWN session (a bare & or nohup still dies with the caller's process
  # group — start_new_session is the only interrupt-proof detach).
  if [ -z "$ZIP_OVERRIDE" ]; then
    echo "[fork] node/pnpm via mise..."
    "$MISE" install
    echo "[fork] bundle:desktop (ZCODE_ENV=production, no signing)..."
    ZCODE_ENV=production CSC_IDENTITY_AUTO_DISCOVERY=false \
      ELECTRON_MIRROR=https://artifacts.electronjs.org/ \
      "$MISE" exec -- node scripts/mise-run.mjs pnpm bundle:desktop
  fi
  ZIP="${ZIP_OVERRIDE:-$(ls -t packages/desktop/dist/ZCode-*-mac-arm64.zip | head -1)}"
  echo "[fork] armed: swapping $(basename "$ZIP") the moment the app quits (⌘Q — the rest is automatic; log: /tmp/fork_install.log)"
  exec ~/.zcode/hooks/venv/bin/python3 - "$ZIP" "$KEEP_PREV" <<'PYEOF'
import os, subprocess, sys
zip_path, keep_prev = sys.argv[1], sys.argv[2]
cmd = f"""
while pgrep -x ZCode >/dev/null 2>&1; do sleep 2; done
echo "[$(date +%H:%M:%S)] app quit — swapping"
cd {os.getcwd()}
scripts/build-install.sh {keep_prev} --yes --zip {zip_path}
"""
with open("/tmp/fork_install.log", "a") as log:
    subprocess.Popen(["/bin/bash", "-c", cmd], stdout=log,
                     stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
                     start_new_session=True)
print("[fork] waiter detached (own session) — ⌘Q installs")
PYEOF
  exit 0
fi

if [ -n "$ZIP_OVERRIDE" ]; then
  if pgrep -x ZCode >/dev/null 2>&1; then
    echo "[fork] ZCode is running — quit it first (or use --when-quit)." >&2
    exit 1
  fi
  install_zip "$ZIP_OVERRIDE"
  exit 0
fi

echo "[fork] node/pnpm via mise..."
"$MISE" install

echo "[fork] bundle:desktop (ZCODE_ENV=production, no signing)..."
ZCODE_ENV=production CSC_IDENTITY_AUTO_DISCOVERY=false \
  ELECTRON_MIRROR=https://artifacts.electronjs.org/ \
  "$MISE" exec -- node scripts/mise-run.mjs pnpm bundle:desktop

DIST_DIR="packages/desktop/dist"
ZIP="$(ls -t "$DIST_DIR"/ZCode-*-mac-arm64.zip | head -1)"
echo "[fork] built: $ZIP"

if [ -n "$YES" ]; then
  if pgrep -x ZCode >/dev/null 2>&1; then
    echo "[fork] ZCode is running — quit it first (or use --when-quit)." >&2
    exit 1
  fi
  install_zip "$ZIP"
  exit 0
fi

STAGE="$(mktemp -d)/stage"
ditto -x -k "$ZIP" "$STAGE"
APP_PATH="$(find "$STAGE" -maxdepth 1 -name 'ZCode*.app' -print -quit)"
[ -n "$APP_PATH" ] || { echo "[fork] no .app inside $ZIP" >&2; exit 1; }

echo "[fork] smoke: launching the built app from staging (close it manually when satisfied)..."
open "$APP_PATH"
read -r -p "[fork] app looks good? press Enter to swap /Applications/ZCode.app (Ctrl-C to abort) " || {
  echo "[fork] stdin closed (unattended?) — rerun with --yes, or --when-quit to arm the swap on quit" >&2
  exit 1
}

if pgrep -x ZCode >/dev/null 2>&1; then
  echo "[fork] ZCode is running — quit it first (the bot relaunches over the same path)." >&2
  exit 1
fi

install_zip "$ZIP"
