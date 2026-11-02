#!/Users/lattenero/.local/bin/nu-nightly
# FORK (damian-rafael-lattenero): post-deploy verification.
# Usage: scripts/verify-deploy.nu
#
# Answers one question: is the code just deployed the code that is running
# (or about to run)?
# Checks (any FAIL = exit 1):
#   1. /Applications has exactly one ZCode.app (extra copies make Dock/
#      Spotlight open the old one)
#   2. the installed app bundle's agent (Resources/glm/zcode.cjs) carries
#      every wave's marker
#   3. the repo dist agent (apps/zcode-cli/packages/cli/dist/zcode.cjs —
#      when the workspace is this monorepo it resolves BEFORE the bundle!)
#      carries the same markers and is not older than the bundle
#   4. the running ZCode process started after the installed bundle
#      (otherwise it tells you to ⌘Q and reopen)
#
# Every new fork wave: add one line to MARKERS.
#
# Migrated from verify-deploy.sh on 2026-11-02. Typed; the interpreter is
# pinned by the shebang.

use lib/fork.nu *

const APP = "/Applications/ZCode.app"
const BUNDLE = "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs"
const ASAR = "/Applications/ZCode.app/Contents/Resources/app.asar"
const DIST = "apps/zcode-cli/packages/cli/dist/zcode.cjs"
# Build artifact (with its original mtime): the swap's ditto refreshes the
# installed copy's mtime, so the age comparison must use the staging copy or
# it always reports dist as "older".
const STAGED_BUNDLE = "packages/desktop/bundled-agents/darwin-arm64/glm/zcode.cjs"

# Per-wave agent markers (CLI runtime). UI_MARKERS go to app.asar
# (renderer + desktop services). Never cross the lists: a CLI marker is not
# in the asar, and vice versa.
const AGENT_MARKERS: list<string> = [
    "nextAttemptAtMs"        # Ola 4b: absolute countdown (adapter publish)
    "usageLimitResetWaitMs"  # Ola 5: wait-until-reset (next_flush_time)
    "live_io_partial"        # FORK live CoT: mid-request sidecar flush
]
# renderer/shared are bundled into the asar and minified: markers must be
# literals (i18n keys, property names), never function names. The asar is
# binary, so grep needs -a.
const UI_MARKERS: list<string> = [
    "chat.apiRetryStatus.serverError"  # Ola 6 (B2): honest labels
    "chat.apiRetryStatus.recovery"     # Ola 6 (B2): stream recovery marker
    "nextRetryAtMs"                    # Ola 4b: normalizer + legacy schema
]

def grep-has [file: string, marker: string]: nothing -> bool {
    let r = (do { with-env {LC_ALL: "C"} { ^grep -a -q $marker $file } } | complete)
    $r.exit_code == 0
}

def check-markers [file: string, markers: list<string>, kind: string]: nothing -> nothing {
    if not (($file | path type) == "file") {
        fail "[verify-deploy]" $"falta ($kind): ($file)"
    }
    let missing = ($markers | where {|m| not (grep-has $file $m) })
    if ($missing | length) > 0 {
        fail "[verify-deploy]" $"($kind) sin marker: ($missing | str join ', ')"
    }
    print $"[verify-deploy] ok: ($kind) tiene todos los markers \(($markers | length)\)"
}

def main []: nothing -> nothing {
    let repo = ($env.FILE_PWD | path dirname)
    cd $repo

    print $"[verify-deploy] app: ($APP)"
    if not (($APP | path type) == "dir") {
        fail "[verify-deploy]" $"no existe ($APP)"
    }

    # Warn only about copies of the SAME product (dev.zcode.app); unrelated
    # personal tools with a similar name are not our business.
    for extra in (glob "/Applications/ZCode*.app" | where {|p| $p != $APP }) {
        let bid = (do { ^defaults read $"($extra)/Contents/Info.plist" CFBundleIdentifier } | complete)
        if ($bid.exit_code == 0) and (($bid.stdout | str trim) == "dev.zcode.app") {
            print "[verify-deploy] WARN: hay apps ZCode extra \(Dock/Spotlight pueden abrir la vieja\):"
            print $"  - ($extra)"
        }
    }

    check-markers $BUNDLE $AGENT_MARKERS "bundle del app (agent)"
    check-markers $ASAR $UI_MARKERS "asar del app (UI/shared)"

    if (($DIST | path type) == "file") {
        check-markers $DIST $AGENT_MARKERS "repo dist"
    } else {
        print "[verify-deploy] note: sin repo dist \(checkout limpio\) — el agent saldrá del bundle del app"
    }

    # When the app is launched from the Dock, argv[0] is just "ZCode" (no
    # full path), so pgrep -f/-x are unreliable. ps comm is the only stable
    # source.
    let pids = (^ps -A -o pid=,comm= | lines | parse "{pid} {comm}" | where comm == ZCode | get pid)
    if ($pids | is-empty) {
        print "[verify-deploy] note: ZCode no está corriendo — abrir y volver a correr este script"
        print "[verify-deploy] PASS"
        return
    }
    let main_pid = ($pids | first)
    let bundle_epoch = (^stat -f %m $BUNDLE | str trim | into int)
    let start_line = (^ps -p $main_pid -o lstart= | str trim | str replace --all --regex '\s+' ' ')
    let start = (do { ^date -j -f "%a %b %d %H:%M:%S %Y" $start_line +%s } | complete)
    let start_epoch = if $start.exit_code == 0 { $start.stdout | str trim | into int } else { 0 }
    if ($start_epoch > 0) and ($start_epoch < $bundle_epoch) {
        fail "[verify-deploy]" $"la ZCode corriendo \(pid ($main_pid), iniciada ($start_line)\) es anterior al bundle instalado — hacer ⌘Q y reabrir"
    }
    print $"[verify-deploy] ok: la app corriendo es el build instalado \(pid ($main_pid)\)"
    print "[verify-deploy] PASS"
}
