#!/Users/lattenero/.local/bin/nu-nightly
# FORK (damian-rafael-lattenero): rebuild the fork and swap it into
# /Applications.
# Usage: scripts/build-install.nu [--keep-prev] [--yes] [--quit] [--when-quit] [--zip <path>]
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
#   --quit         build, then CLOSE ZCode, swap and reopen in one arc. If the
#                  app refuses to quit (its quit handler cancels with -128
#                  while a turn runs), the swap is ARMED instead — the zip
#                  waits for the owner's ⌘Q. A force-kill here would destroy
#                  in-flight work; the deploy is delivered either way.
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

use lib/fork-ops.nu *

const MISE: string = "/opt/homebrew/bin/mise"
const WAITER_LABEL: string = "com.zcode.fork-swap-waiter"

def build-bundle [repo: string]: nothing -> string {
    cd $repo
    print "[fork] node/pnpm via mise..."
    ^$MISE install
    # node_modules FRESH ALWAYS (2026-11-02: the v3.17.1 sync changed
    # pnpm-lock.yaml and the bundle compiled against node_modules from 2026-10-23
    # — the CLI resolved the hoisted zod v4 instead of the lockfile's v3 and tsc
    # exploded across 40 files). frozen-lockfile: if package.json and the lock
    # disagree, it screams — the right gate for a build.
    # THE MUTE STRETCHES ON THE PHONE (2026-11-04: the owner read 15 min of
    # silence during this stretch — announce on every long phase; the announce
    # never breaks the run).
    print "[fork] pnpm install --frozen-lockfile (node_modules against the lock)..."
    announce "🚀 deploy Fork ZCode — pnpm install --frozen-lockfile (tarda minutos)…"  # lang-ok: owner-voice announce
    let install: record = (do { ^$MISE exec -- node scripts/mise-run.mjs pnpm install --frozen-lockfile } | complete)
    print $install.stdout
    if $install.exit_code != 0 {
        print -e $install.stderr
        fail "[fork]" $"pnpm install failed \(exit ($install.exit_code)\)"
    }
    print "[fork] bundle:desktop (ZCODE_ENV=production, no signing)..."
    announce "🚀 deploy Fork ZCode — bundle:desktop (el tramo largo, ~10-15 min)…"  # lang-ok: owner-voice announce
    let bundle: record = (with-env {
        ZCODE_ENV: "production"
        CSC_IDENTITY_AUTO_DISCOVERY: "false"
        ELECTRON_MIRROR: "https://artifacts.electronjs.org/"
        # Fork law: freeze the auto-updater OFF at build time (empty string reads
        # as disabled in scripts/build-time-config.mjs). Belt-and-suspenders for
        # the hard disable in packages/desktop/src/main/index.ts — a live updater
        # would self-swap the fork for the official build.
        ZCODE_AUTO_UPDATE: ""
    } {
        do { ^$MISE exec -- node scripts/mise-run.mjs pnpm bundle:desktop } | complete
    })
    print $bundle.stdout
    if $bundle.exit_code != 0 {
        print -e $bundle.stderr
        fail "[fork]" $"bundle:desktop failed \(exit ($bundle.exit_code)\)"
    }
    let zips: table = (ls ($repo | path join "packages/desktop/dist")
        | where name =~ 'ZCode-.*-mac-arm64\.zip$'
        | sort-by modified -r)
    if ($zips | is-empty) {
        fail "[fork]" "the build produced no ZCode-*-mac-arm64.zip"
    }
    announce $"✅ deploy Fork ZCode — build listo \(($zips | first).name | path basename\)"  # lang-ok: owner-voice announce
    (($zips | first).name)
}

# THE AUTOMATIC CLOSE (4/11, the owner: "run from a separate Ghostty, it should
# be able to close zcode without ⌘Q"): exact — ⌘Q was a choice, not a limit.
# Honest ladder: osascript quit → ≤15 s → re-quit ×2 (anti-resurrection, the
# old cutover law). Returns false when the app survives: its quit handler
# cancels with -128 while a turn runs, and that cancel is CORRECT — the caller
# decides (main arms the waiter instead of dying).
def quit-zcode []: nothing -> bool {
    if not (zcode-running) { return true }
    announce "🔒 cerrando ZCode para el swap (~15 s)…"  # lang-ok: owner-voice announce
    for attempt in 1..3 {
        let r: record = (^osascript -e "quit app \"ZCode\"" | complete)
        # -128 = the quit handler CANCELED (a turn is running): that is an
        # answer, not a miss. Retrying only re-raises the same dialog — hand
        # the decision to the caller at once (measured 24/11: the modal kept
        # the script blocked and burned the whole ladder).
        if $r.exit_code != 0 { return false }
        mut dead: bool = false
        for _ in 1..15 {
            sleep 1sec
            if not (zcode-running) {
                $dead = true
                break
            }
        }
        if $dead { return true }
        print $"[fork] quit attempt ($attempt): ZCode still alive — retrying…"
    }
    false
}

def install-zip [repo: string, zip: string, keep_prev: bool]: nothing -> nothing {
    if not (($zip | path type) == "file") {
        fail "[fork]" $"zip does not exist: ($zip)"
    }
    let stage: path = ((mktemp -d) | path join "stage")
    mkdir $stage
    ^ditto -x -k $zip $stage
    let apps: list<string> = (glob $"($stage)/ZCode*.app")
    if ($apps | is-empty) {
        fail "[fork]" $"no .app inside ($zip)"
    }
    let app: string = ($apps | first)
    if $keep_prev and (("/Applications/ZCode.app" | path type) == "dir") {
        rm -rf "/Applications/ZCode.prev.app"
        ^mv "/Applications/ZCode.app" "/Applications/ZCode.prev.app"
        print "[fork] previous build kept at /Applications/ZCode.prev.app"
    } else {
        rm -rf "/Applications/ZCode.app"
    }
    ^ditto $app "/Applications/ZCode.app"
    # THE KEYCHAIN LAW (12/11, CORRECTED by the web — hermes-agent #91115):
    # macOS adjudicates keychain access by the item's PARTITION LIST, which
    # accumulates the requesting binaries' CDSHASH — not the designated
    # requirement. Every deploy changes the cdhash → one login-password
    # prompt per deploy EVEN with a stable identity (three machines and a
    # controlled relaunch-vs-update experiment confirm it; the official
    # Z.ai app never prompted because its Developer-ID teamid matched the
    # partition). The stable identity is still worth signing with: it
    # preserves TCC grants and keeps one coherent identity. The REAL
    # silence path is the ITEM: recreate it ACL-less via /usr/bin/security
    # (the Claude-Code pattern) — runbook, one interactive password.
    # Prefer the APPLE-ISSUED identity when present: its signature carries
    # a real TeamIdentifier, so the ONE keychain Always Allow registers
    # teamid:<TEAM> in the item's partition list and every later build
    # matches — the per-deploy prompt DIES (the local self-signed identity
    # cannot: securityd matches it by cdhash). Matched by NAME PREFIX so a
    # certificate renewal keeps working; the local identity stays as the
    # fallback for machines without the (free) Apple ID cert.
    let apple_id: string = (do { ^security find-identity -v -p codesigning } | complete | get stdout
        | lines | where {|l| $l =~ '"Apple Development:' } | first | default ""
        | parse -r '\d\) [0-9A-F]+ "(?<n>[^"]+)"' | get 0.n? | default "")
    let sign_id: string = (if ($apple_id | is-not-empty) { $apple_id } else { "ZCode Local Signing" })
    print $"[fork] signing with ($sign_id)"
    let has_id: bool = (do { ^security find-identity -v -p codesigning } | complete | get stdout | str contains $sign_id)
    if $has_id {
        let signed: record = (do { ^codesign --force --deep --sign $sign_id "/Applications/ZCode.app" } | complete)
        if $signed.exit_code != 0 {
            print -e $"[fork] WARN: stable signing failed — TCC grants lost, rebuild the identity: ($signed.stderr | str trim)"
            do -i { ^codesign --force --deep --sign - "/Applications/ZCode.app" | ignore }
        } else {
            # THE DR GUARD: an install silently degrading to ad-hoc (the
            # 12/11 finding) loses TCC grants — verify the requirement
            # anchors to a real identity before declaring victory.
            let dr: string = (do { ^codesign -d -r- "/Applications/ZCode.app" } | complete | get stdout)
            let anchored: string = (if ($dr | str contains "anchor apple generic") {
                "apple teamid"
            } else if ($dr | str contains 'certificate leaf = H"') {
                "local identity"
            } else {
                "AD-HOC"
            })
            if $anchored == "AD-HOC" {
                print -e "[fork] WARN: the installed app is AD-HOC signed — TCC grants lost, keychain prompts every launch"
            } else {
                print $"[fork] signed with ($anchored) — DR verified"
            }
        }
    } else {
        print -e "[fork] WARN: no stable signing identity — run scripts/make-signing-identity.nu once to stop the Keychain prompts"
        do -i { ^codesign --force --deep --sign - "/Applications/ZCode.app" | ignore }
    }
    let version: string = (app-version)
    print $"[fork] installed: ($version) at /Applications/ZCode.app"
    # FORK CHANGE (damian): ship with Diff Ask — ensure its marketplace +
    # install (runtime-resolved, optional: the fork degrades to stock git
    # review without it).
    print "[fork] ensuring the Diff Ask plugin..."
    let bootstrap: path = ($repo | path join "scripts/bootstrap-diff-ask.nu")
    let r: record = (do { ^$bootstrap } | complete)
    if $r.exit_code != 0 {
        print -e "[fork] WARN: Diff Ask bootstrap failed — install it manually (Plugins → Personal)"
    }
    ^open -a ZCode
    announce-loud $"🔥 <b>DEPLOY FORK ZCODE COMPLETO</b> — versión ($version) instalada y app reabierta; verificá el canal 📡"  # lang-ok: owner-voice announce
    print "[fork] done — verify: New tab → App plugins grid shows Diff Ask; bot turn works; /diff works."
}

def arm-waiter [repo: string, zip: string, keep_prev: bool]: nothing -> nothing {
    let waiter: path = ($repo | path join "scripts/build-install-waiter.nu")
    do { ^launchctl remove $WAITER_LABEL } | complete | ignore
    let base: list<string> = ["submit" "-l" $WAITER_LABEL "--" $waiter "--zip" $zip]
    let args: list<string> = if $keep_prev { $base | append "--keep-prev" } else { $base }
    ^launchctl ...$args
    print $"[fork] armed: swapping ($zip | path basename) the moment the app quits \(⌘Q — the rest is automatic; log: /tmp/fork_install.log\)"
}

def main [
    --keep-prev        # keep the previous build at /Applications/ZCode.prev.app
    --yes              # unattended: no smoke window, no prompt
    --quit             # build, then CLOSE ZCode, swap and reopen — the full automatic arc
    --when-quit        # arm a launchd waiter that swaps the moment the app quits
    --zip: string      # install this zip instead of building (pair with --when-quit)
]: nothing -> nothing {
    let repo: path = ($env.FILE_PWD | path dirname)
    cd $repo

    if not ($zip | is-empty) and not (($zip | path type) == "file") {
        fail "[fork]" $"zip does not exist: ($zip)"
    }

    if $when_quit {
        let built: string = if ($zip | is-empty) { build-bundle $repo } else { $zip }
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

    let built: string = (build-bundle $repo)
    print $"[fork] built: ($built)"

    if $quit {
        # THE AUTOMATIC ARC (4/11): the build ran with the app ALIVE (the
        # owner's session kept working the ~15 min); only now does it close —
        # the swap is seconds and install-zip reopens and announces. A refused
        # quit means a turn is in flight: forcing would destroy it, so the
        # waiter (the --when-quit door) takes over — same result, owner-paced.
        if not (quit-zcode) {
            arm-waiter $repo $built $keep_prev
            announce-loud "⏳ <b>FORK BUILD READY</b> — ZCode refused to quit (a task is running); the swap is ARMED — ⌘Q when free and it installs + reopens automatically"
            print "[fork] quit refused (a task was running) — swap armed; ⌘Q when free and it installs + reopens"
            return
        }
        install-zip $repo $built $keep_prev
        return
    }

    if $yes {
        if (zcode-running) {
            fail "[fork]" "ZCode is running — quit it first (or use --when-quit)."
        }
        install-zip $repo $built $keep_prev
        return
    }

    let stage: path = ((mktemp -d) | path join "stage")
    mkdir $stage
    ^ditto -x -k $built $stage
    let apps: list<string> = (glob $"($stage)/ZCode*.app")
    if ($apps | is-empty) {
        fail "[fork]" $"no .app inside ($built)"
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
