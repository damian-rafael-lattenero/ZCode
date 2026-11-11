#!/Users/lattenero/.local/bin/nu-nightly
# The detached half of `build-install.nu --when-quit`.
#
# launchd owns this process (launchctl submit), so it survives the caller
# and the app: a bare & or nohup still dies with the caller's process
# group — start_new_session was the only interrupt-proof detach in bash;
# a submitted launchd job is the native equivalent and one less language.
#
# It waits for ZCode to quit, then installs the zip with --yes (which
# reopens the app and announces the swap).

use lib/fork-ops.nu *

def main [
    --zip: string      # the zip to install
    --keep-prev        # forward the previous-build flag
]: nothing -> nothing {
    let repo = ($env.FILE_PWD | path dirname)
    if ($zip | is-empty) {
        fail "[waiter]" "--zip is required"
    }
    print $"[waiter] armed for ($zip | path basename) — waiting for ZCode to quit..."
    while (zcode-running) {
        sleep 2sec
    }
    print "[waiter] app quit — swapping"
    let installer = ($repo | path join "scripts/build-install.nu")
    let args = ["--yes" "--zip" $zip]
    let args = if $keep_prev { $args | append "--keep-prev" } else { $args }
    ^$installer ...$args
}
