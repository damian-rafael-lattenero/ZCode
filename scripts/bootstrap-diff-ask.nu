#!/Users/lattenero/.local/bin/nu-nightly
# FORK (damian-rafael-lattenero): ensure the Diff Ask plugin is installed.
#
# The fork's Changes button, /diff and the plugin-grid card all resolve the
# plugin at RUNTIME and degrade to stock behavior when it is missing, so
# this step is optional — but the fork is meant to ship with Diff Ask, and
# this script makes that a one-command setup on any machine.
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
# Requires the fork app installed at /Applications/ZCode.app (uses its
# bundled runtime). Run AFTER build-install.nu, BEFORE the first app launch.
#
# Migrated from bootstrap-diff-ask.sh on 2026-11-02.

use lib/fork-ops.nu *

const HELPER = "/Applications/ZCode.app/Contents/Frameworks/ZCode Helper.app/Contents/MacOS/ZCode Helper"
const RUNTIME = "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs"
const MARKETPLACE_ID = "dev-zcode-diff-ask-5098ef5a"
const PLUGIN_ID = "diff-ask@dev-zcode-diff-ask-5098ef5a"

# The app's own runtime speaks the plugin CLI. ELECTRON_RUN_AS_NODE turns
# the Helper into a plain Node process (the fork's documented trick).
def zc [helper: string, runtime: string, ...args: string]: nothing -> nothing {
    with-env {ELECTRON_RUN_AS_NODE: "1"} {
        ^$helper $runtime plugins ...$args
    }
}

def main []: nothing -> nothing {
    if not (is-exec $HELPER) {
        fail "[diff-ask]" $"($HELPER) missing — install the fork first \(scripts/build-install.nu\)"
    }
    if not (($RUNTIME | path type) == "file") {
        fail "[diff-ask]" $"($RUNTIME) missing — install the fork first \(scripts/build-install.nu\)"
    }

    let local_repo = ($env.ZCODE_DIFF_ASK_REPO? | default ($nu.home-dir | path join "Projects/zcode-diff-ask"))
    let src = if (($local_repo | path join "marketplace.json") | path exists) {
        print $"[diff-ask] source: local checkout ($local_repo)"
        $local_repo
    } else {
        print "[diff-ask] source: GitHub (damian-rafael-lattenero/zcode-diff-ask)"
        "damian-rafael-lattenero/zcode-diff-ask"
    }

    print $"[diff-ask] marketplace add \(creates or re-binds ($MARKETPLACE_ID))..."
    zc $HELPER $RUNTIME marketplace add $src

    print "[diff-ask] marketplace refresh..."
    zc $HELPER $RUNTIME marketplace update $MARKETPLACE_ID

    # install is idempotent: fresh → installs, existing → reinstalls at
    # latest (a version rollback needs `plugins uninstall` first).
    print "[diff-ask] install..."
    zc $HELPER $RUNTIME install $PLUGIN_ID

    print $"[diff-ask] done — plugin ($PLUGIN_ID). Restart ZCode if it is running."
}
