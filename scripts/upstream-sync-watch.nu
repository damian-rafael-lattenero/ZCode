#!/Users/lattenero/.local/bin/nu-nightly
# upstream-sync-watch.nu — daily launchd one-shot: did zai-org/ZCode publish a
# source sync newer than v3.18.2 on upstream/main? When a "chore: sync ZCode
# source vX" commit lands, announce ONCE on Telegram — that is merge time for
# the fork (20/11 law: binaries ship first, the source mirror lags days).
#
# State: ~/.zcode/fork/upstream-watch.json {lastTip, announcedTip}.
# Honest doors: git/network failure -> log + exit 1 (no Telegram spam for a
# mere offline day); announce never breaks (fork-ops contract); one announce
# per tip. The fork's updater stays hard-disabled — this watcher is the ONLY
# upgrade signal.

use lib/fork-ops.nu [announce, log]

const REPO: string = "/Users/lattenero/Projects/ZCode"
const STATE_PATH: string = "/Users/lattenero/.zcode/fork/upstream-watch.json"
# The tip at watcher birth: upstream/main == v3.18.2 (already merged into damian).
const SEED_TIP: string = "fec975905a2abd4c07e35c40d51fa097a2258ec9"

# The type aliases (the owner's 22/11 law): the shapes read once, the
# signatures spell the name.
type WatchState = record<lastTip: string, announcedTip: string>

def load-state []: nothing -> WatchState {
    try {
        open $STATE_PATH
    } catch {
        {lastTip: $SEED_TIP, announcedTip: ""}
    }
}

def save-state [st: WatchState]: nothing -> nothing {
    mkdir ($STATE_PATH | path dirname)
    $st | to json | save -f $STATE_PATH
}

def remote-tip []: nothing -> string {
    let out: record = (do { ^git -C $REPO ls-remote upstream } | complete)
    if $out.exit_code != 0 {
        log "[watch]" $"ls-remote failed — ($out.stderr | str trim)"
        exit 1
    }
    $out.stdout
    | lines
    | split column "\t" sha ref
    | where ref == "refs/heads/main"
    | get sha.0
    | str trim
}

def new-subjects [old: string, new: string]: nothing -> list<string> {
    let fetched: record = (do { ^git -C $REPO fetch upstream } | complete)
    if $fetched.exit_code != 0 {
        log "[watch]" $"fetch failed — ($fetched.stderr | str trim)"
        exit 1
    }
    let out: record = (do { ^git -C $REPO log --format=%s $"($old)..($new)" } | complete)
    if $out.exit_code != 0 {
        log "[watch]" $"git log failed — ($out.stderr | str trim)"
        exit 1
    }
    $out.stdout | lines
}

def check []: nothing -> int {
    let st: record = (load-state)
    let tip: string = (remote-tip)
    if ($tip == $st.lastTip) {
        # Idempotent baseline write: the state file exists from the first run on.
        save-state $st
        log "[watch]" $"no change — upstream/main tip ($tip)"
        return 0
    }
    let subjects: list<string> = (new-subjects $st.lastTip $tip)
    let syncs: list<string> = ($subjects | where {|s| ($s | str contains "sync ZCode source")})
    if ($syncs | is-not-empty) and ($st.announcedTip != $tip) {
        announce $"🚨 ZCode upstream — source sync aterrizó — ($syncs | str join ' | ') — hora de mergear y deployar el fork"
        save-state {lastTip: $tip, announcedTip: $tip}
    } else {
        save-state {lastTip: $tip, announcedTip: $st.announcedTip}
        log "[watch]" $"tip moved without a source sync — ($subjects | str join ' | ')"
    }
    0
}

def main []: nothing -> int {
    check
}
