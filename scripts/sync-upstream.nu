#!/Users/lattenero/.local/bin/nu-nightly
# FORK (damian-rafael-lattenero): bring upstream zai-org/ZCode changes into
# the fork's `damian` branch. See FORK.md for the full ritual and the
# version ledger.
# Usage: scripts/sync-upstream.nu
#
# Migrated from sync-upstream.sh on 2026-11-02.

use lib/fork.nu *

const MISE = "/opt/homebrew/bin/mise"

def main []: nothing -> nothing {
    let repo = ($env.FILE_PWD | path dirname)
    cd $repo

    print "[fork] fetching upstream..."
    ^git fetch upstream main

    let behind = (^git rev-list --count damian..upstream/main | str trim | into int)
    if $behind == 0 {
        print "[fork] damian is already up to date with upstream/main."
        return
    }
    let upstream_version = (^git show upstream/main:package.json | from json | get version)
    print $"[fork] ($behind) upstream commit\(s\) to merge. Upstream version:"
    print $"  upstream: ($upstream_version)"

    let branch = (^git branch --show-current | str trim)
    if $branch != "damian" {
        fail "[fork]" $"not on branch damian \(on '($branch)'\). Aborting."
    }
    let dirty = (^git status --porcelain | str trim)
    if not ($dirty | is-empty) {
        fail "[fork]" "working tree is dirty. Commit or stash first."
    }

    print "[fork] merging upstream/main into damian..."
    ^git merge upstream/main

    print "[fork] gates: unit tests (plugin-ui recommendations) + typecheck..."
    ^$MISE exec -- pnpm exec vitest run packages/ui/test/useUiPluginRecommendations.test.ts packages/ui/test/useRecommendedUiPlugins.test.ts
    ^$MISE run typecheck

    let merged_version = (^git show upstream/main:package.json | from json | get version)
    let tag = $"damian-v($merged_version)-(date now | format date "%Y%m%d")"

    print ""
    print "[fork] merge complete. Next steps:"
    print "  1. Review the merge (conflicts, if any, should touch only the [fork] files)."
    print "  2. scripts/build-install.nu          # rebuild + swap /Applications/ZCode.app"
    print "  3. git push origin damian"
    print $"  4. git tag '($tag)' && git push origin '($tag)'"
    print "  5. Append the tag to FORK.md's ledger."
}
