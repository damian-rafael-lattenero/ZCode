# Shared helpers for the fork's own scripts.
#
# The fork's operational surface is typed Nushell (see FORK.md and
# docs/plan-brujula.md §Nushell). The shebang pins the interpreter:
# ~/.local/bin/nu-nightly (0.116.2-nightly.28 at the time of the
# migration). `nu-check --debug` is the gate.

export def log [prefix: string, msg: string]: nothing -> nothing {
    print $"($prefix) ($msg)"
}

export def fail [prefix: string, msg: string]: nothing -> nothing {
    print -e $"($prefix) FAIL: ($msg)"
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

export def app-version []: nothing -> string {
    (^defaults read /Applications/ZCode.app/Contents/Info.plist CFBundleShortVersionString | str trim)
}

# One-shot Telegram announce, independent of the app and of the bot's
# transport: token/chat come from the config the poller itself reads. The
# announcement NEVER breaks the caller (do -i + catch).
export def announce [text: string]: nothing -> nothing {
    let cfg_path = ($nu.home-dir | path join ".zcode/telegram-remote.json")
    if not ($cfg_path | path exists) { return }
    try {
        let cfg = (open $cfg_path)
        let token = ($cfg.token? | default "")
        let chat = ($cfg.chat_id? | default "")
        if ($token | is-empty) or ($chat | is-empty) { return }
        let body = ({chat_id: $chat, text: $text} | to json)
        do -i {
            http post -m 10sec -t application/json $"https://api.telegram.org/bot($token)/sendMessage" $body -r | ignore
        }
    } catch {|_e| }
}
