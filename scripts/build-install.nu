#!/Users/lattenero/.local/bin/nu-nightly
# FORK (damian-rafael-lattenero): rebuild the fork and swap it into
# /Applications.
# Usage: scripts/build-install.nu [--keep-prev] [--yes] [--when-quit] [--zip <path>]
#
# Ritual (see FORK.md):
#   1. bundle the desktop app from the CURRENT working tree (branch damian)
#   2. verify the produced .app launches from the build output dir (smoke,
#      manual — skipped with --yes: an unattended run pops no windows)
#   3. atomically swap /Applications/ZCode.app (previous build ->
#      ZCode.prev.app when --keep-prev, else discarded; the official app can
#      always be re-downloaded as rollback)
#
# Modes (27/10 lessons — the installer must ALWAYS work):
#   default        interactive: build → smoke → Enter → swap (app must be closed)
#   --yes          unattended: no smoke window, no prompt (CI, detached runs —
#                  a closed stdin used to kill the old script AT the read)
#   --when-quit    arm a DETACHED launchd job that installs the LAST built zip
#                  the moment the app quits, then reopens it and announces on
#                  Telegram. Damian's whole gesture becomes ⌘Q.
#   --zip <path>   install that zip instead of building (pair with --when-quit).
#
# The build is unsigned/ad-hoc on purpose: the Squirrel auto-updater only
# applies Z.ai-signed payloads, so updates arrive EXCLUSIVELY via
# scripts/sync-upstream.nu.
#
# Migrated from build-install.sh on 2026-11-02. The detach is a launchd
# job (`launchctl submit`), not Python's start_new_session: same guarantee
# (own session, survives the caller) with one less language.

use lib/fork.nu *

const MISE = "/opt/homebrew/bin/mise"
const WAITER_LABEL = "com.zcode.fork-swap-waiter"

def build-bundle [repo: string]: nothing -> string {
    cd $repo
    print "[fork] node/pnpm via mise..."
    ^$MISE install
    # node_modules FRESCO SIEMPRE (2/11: el sync v3.17.1 cambió pnpm-lock.yaml
    # y el bundle compiló contra node_modules del 23/10 — el CLI resolvió el
    # zod v4 hoisteado en vez del v3 del lockfile y el tsc explotó en 40
    # archivos). frozen-lockfile: si package.json y lock no coinciden, grita —
    # el gate correcto para un build.
    # LOS TRAMOS MUDOS AL TELÉFONO (4/11: el owner leyó silencio 15 min en
    # este tramo — announce en cada fase larga; el announce nunca rompe).
    print "[fork] pnpm install --frozen-lockfile (node_modules contra el lock)..."
    announce "🚀 deploy fork — pnpm install --frozen-lockfile (tarda minutos)…"
    ^$MISE exec -- node scripts/mise-run.mjs pnpm install --frozen-lockfile
    print "[fork] bundle:desktop (ZCODE_ENV=production, no signing)..."
    announce "🚀 deploy fork — bundle:desktop (el tramo largo, ~10-15 min)…"
    with-env {
        ZCODE_ENV: "production"
        CSC_IDENTITY_AUTO_DISCOVERY: "false"
        ELECTRON_MIRROR: "https://artifacts.electronjs.org/"
    } {
        ^$MISE exec -- node scripts/mise-run.mjs pnpm bundle:desktop
    }
    let zips = (ls ($repo | path join "packages/desktop/dist")
        | where name =~ 'ZCode-.*-mac-arm64\.zip$'
        | sort-by modified -r)
    if ($zips | is-empty) {
        fail "[fork]" "el build no produjo ningún ZCode-*-mac-arm64.zip"
    }
    announce $"✅ deploy fork — build listo \(($zips | first).name | path basename\)"
    (($zips | first).name)
}

def install-zip [repo: string, zip: string, keep_prev: bool]: nothing -> nothing {
    if not (($zip | path type) == "file") {
        fail "[fork]" $"no existe el zip: ($zip)"
    }
    let stage = ((mktemp -d) | path join "stage")
    mkdir $stage
    ^ditto -x -k $zip $stage
    let apps = (glob $"($stage)/ZCode*.app")
    if ($apps | is-empty) {
        fail "[fork]" $"no hay .app dentro de ($zip)"
    }
    let app = ($apps | first)
    if $keep_prev and (("/Applications/ZCode.app" | path type) == "dir") {
        rm -rf "/Applications/ZCode.prev.app"
        ^mv "/Applications/ZCode.app" "/Applications/ZCode.prev.app"
        print "[fork] previous build kept at /Applications/ZCode.prev.app"
    } else {
        rm -rf "/Applications/ZCode.app"
    }
    ^ditto $app "/Applications/ZCode.app"
    # Locally built bundles carry no quarantine xattr; ad-hoc sign for
    # consistency.
    do -i { ^codesign --force --deep --sign - "/Applications/ZCode.app" | ignore }
    let version = (app-version)
    print $"[fork] installed: ($version) at /Applications/ZCode.app"
    # FORK CHANGE (damian): ship with Diff Ask — ensure its marketplace +
    # install (runtime-resolved, optional: the fork degrades to stock git
    # review without it).
    print "[fork] ensuring the Diff Ask plugin..."
    let bootstrap = ($repo | path join "scripts/bootstrap-diff-ask.nu")
    let r = (do { ^$bootstrap } | complete)
    if $r.exit_code != 0 {
        print -e "[fork] WARN: Diff Ask bootstrap failed — install it manually (Plugins → Personal)"
    }
    ^open -a ZCode
    announce $"✅ Fork instalado — versión ($version) — y app reabierta."
    print "[fork] done — verify: New tab → App plugins grid shows Diff Ask; bot turn works; /diff works."
}

def arm-waiter [repo: string, zip: string, keep_prev: bool]: nothing -> nothing {
    let waiter = ($repo | path join "scripts/build-install-waiter.nu")
    do { ^launchctl remove $WAITER_LABEL } | complete | ignore
    let base = ["submit" "-l" $WAITER_LABEL "--" $waiter "--zip" $zip]
    let args = if $keep_prev { $base | append "--keep-prev" } else { $base }
    ^launchctl ...$args
    print $"[fork] armed: swapping ($zip | path basename) the moment the app quits \(⌘Q — the rest is automatic; log: /tmp/fork_install.log\)"
}

def main [
    --keep-prev        # keep the previous build at /Applications/ZCode.prev.app
    --yes              # unattended: no smoke window, no prompt
    --when-quit        # arm a launchd waiter that swaps the moment the app quits
    --zip: string      # install this zip instead of building (pair with --when-quit)
]: nothing -> nothing {
    let repo = ($env.FILE_PWD | path dirname)
    cd $repo

    if not ($zip | is-empty) and not (($zip | path type) == "file") {
        fail "[fork]" $"no existe el zip: ($zip)"
    }

    if $when_quit {
        let built = if ($zip | is-empty) { build-bundle $repo } else { $zip }
        arm-waiter $repo $built $keep_prev
        return
    }

    if not ($zip | is-empty) {
        if (zcode-running) {
            fail "[fork]" "ZCode is running — quit it first (or use --when-quit)."
        }
        install-zip $repo $zip $keep_prev
        return
    }

    let built = (build-bundle $repo)
    print $"[fork] built: ($built)"

    if $yes {
        if (zcode-running) {
            fail "[fork]" "ZCode is running — quit it first (or use --when-quit)."
        }
        install-zip $repo $built $keep_prev
        return
    }

    let stage = ((mktemp -d) | path join "stage")
    mkdir $stage
    ^ditto -x -k $built $stage
    let apps = (glob $"($stage)/ZCode*.app")
    if ($apps | is-empty) {
        fail "[fork]" $"no hay .app dentro de ($built)"
    }
    print "[fork] smoke: launching the built app from staging (close it manually when satisfied)..."
    ^open ($apps | first)

    if not ((do { ^test -t 0 } | complete).exit_code == 0) {
        fail "[fork]" "stdin closed (unattended?) — rerun with --yes, or --when-quit to arm the swap on quit"
    }
    try {
        input "[fork] app looks good? press Enter to swap /Applications/ZCode.app (Ctrl-C to abort) " | ignore
    } catch {|_e|
        fail "[fork]" "stdin closed (unattended?) — rerun with --yes, or --when-quit to arm the swap on quit"
    }

    if (zcode-running) {
        fail "[fork]" "ZCode is running — quit it first (the bot relaunches over the same path)."
    }
    install-zip $repo $built $keep_prev
}
