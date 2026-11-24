# structural.nu — the fork's scripts (build-install, signing identity,
# upstream sync, diff-ask bootstrap, verify-deploy, fork-ops lib): effects on
# the app bundle. Generic proof: parse + shebang resolves + no stale import.
# covers: /Users/lattenero/Projects/ZCode/scripts/**/*.nu
use std/assert
use /Users/lattenero/Scripts/lib/structural.nu *

let files: list<string> = (glob '/Users/lattenero/Projects/ZCode/scripts/**/*.nu')
assert greater ($files | length) 5 "the glob must see the family"

let found: list<Finding> = (findings $files)
assert equal $found [] ($found | to json)

print $"ZCode scripts structural ok — ($files | length) scripts"
