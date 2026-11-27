# Shared helpers for the fork's own scripts.
#
# The fork's operational surface is typed Nushell (see FORK.md and
# docs/plan-compass.md §Nushell). The shebang pins the interpreter:
# ~/.local/bin/nu-nightly (0.116.2-nightly.28 at the time of the
# migration). `nu-check --debug` is the gate.

# The announce rung lives in nushell-fp (single source, audit wave 6): the
# 10/11 lesson (a null param is a PARSE error) and the silent-by-design law
# ride that module. Imported here so `announce` keeps the same call.
use /Users/lattenero/Scripts/nushell-fp/mods/telegram.nu send-telegram

export def log [prefix: string, msg: string]: nothing -> nothing {
    print $"($prefix) ($msg)"
}

export def fail [prefix: string, msg: string]: nothing -> nothing {
    print -e $"($prefix) FAIL: ($msg)"
    # The owner's law (2026-11-11 incident): parens inside an interpolated
    # string are SUBEXPRESSIONS — `(...)` with prose ran external `el` and the
    # failure announce itself crashed. Plain words after the em-dash, no parens.
    announce-loud $"❌ <b>FORK DEPLOY FAILED</b> — ($msg) — check the script output"
    exit 1
}

export def is-exec [path: string]: nothing -> bool {
    (do { ^test -x $path } | complete).exit_code == 0
}

# ZOMBIE-PROOF (measured, 17:36 incident): nu's builtin `ps` reports the old
# name for a dead-but-unreaped process, so `name == ZCode` lied about a
# zombie. The EXTERNAL ps reports `<defunct>`, and the exact comm "ZCode"
# excludes every Helper. Only a live process counts.
export def zcode-running []: nothing -> bool {
    (^ps -axo comm= | lines | any {|c| ($c | str trim) == "ZCode"})
}

export def zcode-pids []: nothing -> list<int> {
    (^ps -axo pid=,comm= | lines | parse "{pid} {comm}" | where comm == ZCode | get pid)
}

# THE FORCE-QUIT LAW (27/11, the owner's order after the 12:12 modal — a
# quit-confirmation popup blocked a bot-launched deploy for 40 minutes:
# "I want to force quit always ZCode, even if it is running, from the Mac
# or from the bot"): a confirm dialog is a refusal, and a deploy never
# negotiates with a modal. The ladder never touches the quit-event path the
# dialog lives on: SIGTERM (the clean flush chance; sessions persist
# continuously so nothing durable is lost) → ≤6 s → SIGKILL (the kernel
# ends it; no dialog survives it) → ≤6 s. Generic by design — pids in,
# dead-or-false out — so a dummy process can prove it live. False only for
# an unkillable process, which hands the decision to the armed waiter.
export def force-kill-pids [pids: list<int>]: nothing -> bool {
    if ($pids | is-empty) { return true }
    mut alive: list<int> = $pids
    for p in $pids {
        do -i { ^kill -TERM $p }
    }
    for _ in 1..6 {
        sleep 1sec
        $alive = ($pids | where {|p| (do { ^kill -0 $p } | complete).exit_code == 0 })
        if ($alive | is-empty) { return true }
    }
    for p in $pids {
        do -i { ^kill -9 $p }
    }
    for _ in 1..6 {
        sleep 1sec
        $alive = ($pids | where {|p| (do { ^kill -0 $p } | complete).exit_code == 0 })
        if ($alive | is-empty) { return true }
    }
    false
}

export def app-version []: nothing -> string {
    (^defaults read /Applications/ZCode.app/Contents/Info.plist CFBundleShortVersionString | str trim)
}

# One-shot Telegram announce, independent of the app and of the bot's
# transport: token/chat come from the config the poller itself reads. The
# announcement NEVER breaks the caller (do -i + catch).
export def announce [text: string]: nothing -> nothing {
    send-telegram $text
}

# THE LOUD VOICE (the owner's order, 10/11: "a loud notice when each script
# ends"): HTML bold for the END of a deploy and for every
# failure — the phone cannot skim past them. Same never-breaks contract.
export def announce-loud [html: string]: nothing -> nothing {
    send-telegram --html $html
}
