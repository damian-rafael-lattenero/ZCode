# ZCode fork — Damian Lattenero

Personal fork of [zai-org/ZCode](https://github.com/zai-org/ZCode) (Apache-2.0).
The app installed at `/Applications/ZCode.app` on this Mac is **built from this
repo**, not downloaded from Z.ai. Updates arrive only through the ritual below.

## Why a fork

Z.ai does not accept community PRs ("Only collaborators can create PRs") and the
feature request for a first-class Diff Ask entry went unanswered. The ZCode
**binary is never patched** (asar patching broke Squirrel updates silently in
Oct 2026); instead the change lives in source, as a normal git commit.

## What the fork changes

| Commit prefix | File | Change |
| --- | --- | --- |
| `[fork]` | `packages/ui/src/plugin-ui/adapters/useUiPluginRecommendations.ts` | Prepends local UI-plugin recommendations (Diff Ask) to the list served by Z.ai's client-config service, so Diff Ask shows in the side-pane **New tab → App plugins** grid (and the store's recommended chips). |
| `[fork]` | `packages/ui/test/useUiPluginRecommendations.test.ts` | Expectations updated for the merged list. |
| `[fork]` | `scripts/sync-upstream.sh`, `scripts/build-install.sh`, `FORK.md` | This runbook. |

Every modified upstream file carries a `FORK CHANGE` notice at the top (Apache-2.0 §4).
`LICENSE` and `NOTICE.md` are kept intact.

## Branch layout

- `main` — mirror of `upstream/main`. **Never commit here.**
- `damian` — `main` + the `[fork]` commits. This is what gets built and installed.
- Remotes: `origin` = `damian-rafael-lattenero/ZCode`, `upstream` = `zai-org/ZCode`.

Upstream tags/releases lag the shipped app (e.g. app 3.16.3 shipped while `main`
and the last tag were 3.16.2 / v3.15.1), so the sync follows **`upstream/main`**,
not tags. The fork can be one patch release behind the official app until Z.ai
pushes the source.

## The ritual (when Z.ai ships a new version, or whenever you want the latest)

```bash
cd ~/Projects/ZCode
scripts/sync-upstream.sh      # fetch + merge upstream/main into damian + gates
scripts/build-install.sh      # bundle (ZCODE_ENV=production, unsigned) + swap /Applications/ZCode.app
git push origin damian
git tag damian-v<version>-<yyyymmdd> && git push origin --tags
```

Merge conflicts, if any, will be in the `[fork]` files above — resolve by
re-applying the small change. If upstream reworks the recommendations pipeline,
`git log -p -- packages/ui/src/plugin-ui/adapters/` shows where it moved.

## Build notes

- Toolchain pinned by `mise.toml` (node 24.14.0, pnpm 10.33.2): `mise install`.
- Build identity axis: `ZCODE_ENV=production` → appId `dev.zcode.app`, product
  "ZCode" (replaces the official app, same `~/.zcode` data). The default
  (`test`) builds "ZCode Preview" against the test backend — not what we want.
- `CSC_IDENTITY_AUTO_DISCOVERY=false`: no Apple signing identity; the bundle is
  ad-hoc signed after install. Consequence: the built-in auto-updater silently
  ignores Z.ai payloads (signature mismatch) — by design.
- `ELECTRON_MIRROR=https://artifacts.electronjs.org/`: the repo's default
  (npmmirror) failed to download from this network.
- Artifact: `packages/desktop/dist/ZCode-<version>-mac-arm64.zip` (~187 MiB).

## Rollback

The official app is always re-downloadable (verify sha512 against
`update-info.json`, extract with `ditto -x -k`, atomic `mv` into
`/Applications`). The official 3.16.3 bundle that the fork replaced was kept at
`~/zcode-official-backup/ZCode-3.16.3-official.app` (outside `/Applications`
so LaunchServices does not see two `dev.zcode.app` bundles).

## Ledger (installed builds)

| Tag | Upstream version | Installed | Notes |
| --- | --- | --- | --- |
| `damian-v3.16.2-20261023` | 3.16.2 (`upstream/main` 2026-10-20) | 2026-10-23 | First fork build. Replaced official 3.16.3. |

## Gotcha: pushing needs `--no-verify`

The repo's husky pre-push gate (`verify:pre-push`) currently fails on
**upstream's own** lint errors (`no-unused-vars` in `packages/services/...`,
untouched by this fork). Push with:

```bash
mise exec -- git push --no-verify origin damian
```

Re-check after each sync — if upstream cleans up their lint, drop the flag.
