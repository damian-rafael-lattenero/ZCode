# ZCode fork — Damian Lattenero

Personal fork of [zai-org/ZCode](https://github.com/zai-org/ZCode) (Apache-2.0).
The app installed at `/Applications/ZCode.app` on this Mac is **built from this
repo**, not downloaded from Z.ai. Updates arrive only through the ritual below.

## Documentation map (start here)

- **[docs/fork/ARCHITECTURE.md](docs/fork/ARCHITECTURE.md)** — the master map:
  the components (fork app / CLI agent / Telegram bot), the diagram, **why the
  bot is headless**, the fork's 10 design patterns with the commit that
  introduces each one, the bot↔fork table (which commit enables what in the
  bot), and the recorded architecture decisions with their why.
- **[docs/fork/TESTING.md](docs/fork/TESTING.md)** — suites with **measured**
  durations, the per-change verification pipeline, the known cracks (root
  typecheck does not cover `apps/`, oxfmt does not cover `apps/`, the failing
  `runner.test.ts` baseline), and how the deploy is tested (`verify-deploy.nu`).
- **This file (FORK.md)** — operational runbook: the sync/deploy ritual,
  rollback, the build ledger and the wave history (chronological, with each
  wave's diagnosis).

System in one line: the fork app survives z.ai's unstable network and
publishes facts (sidecars, events, countdowns); the live Telegram bot is the
Kotlin daemon (`~/.zcode/bot-daemon`), which speaks the fork's daemon-local
channel and is the sole owner of getUpdates. The Python bot
(`~/.zcode/hooks/zcode_bot/`) was retired on 2026-10-30 as the parity and
rollback reference. The boundary is still JSONL files, not APIs.

## Why a fork

Z.ai does not accept community PRs ("Only collaborators can create PRs") and the
feature request for a first-class Diff Ask entry went unanswered. The ZCode
**binary is never patched** (asar patching broke Squirrel updates silently in
Oct 2026); instead the change lives in source, as a normal git commit.

## What the fork changes

Fork areas (file-by-file detail in the Waves below and in
[ARCHITECTURE.md §4–5](docs/fork/ARCHITECTURE.md)):

| Area | Waves / commits | Summary |
| --- | --- | --- |
| Diff Ask (3 surfaces + bootstrap) | `e01206ef`, `6d441a8a`, `7c33c912`, `a3bd3f9b` | Card in the plugins grid, Changes→Diff Ask, client-side `/diff`, idempotent install |
| `model:` frontmatter per command | `7c33c912` | The turn runs on the model the command asks for |
| Transcript verbosity | `942e82f7` | Detail modes + retroactive "expand EVERYTHING" switch |
| z.ai network resilience | `2b2d17a0`, `f6034b5f`, `c578e14a`, `f85a67f6` | Fixed retry table, 2^n backoff up to 1024s with no jitter, budget per consecutive failure |
| Honest states in the UI | `c578e14a`, `9bb337bf`, `3ab83c67` | Absolute mm:ss countdown + labels per cause, on TWO surfaces |
| z.ai usage limits | `08d05f36` | `next_flush_time` → wait for the reset (24h cap) instead of dying |
| Workflows always available | `2ac70c51` | The gateway can no longer switch the plans off; Skill tolerates `prefix:name` |
| Live telemetry for the bot | `1e4f7413`, `4b46d692`, `d4f231bc` | live-io sidecars: live CoT + tool-args composing |
| Verified deploy | `f6659e93`, `40f0c958`, `d1c0b9f5` | Runbook, `verify-deploy.nu` with markers, build-install `--yes/--when-quit/--zip` |

Historical detail (the first changes):

| Commit prefix | File | Change |
| --- | --- | --- |
| `[fork]` | `packages/ui/src/plugin-ui/adapters/useUiPluginRecommendations.ts` | Prepends local UI-plugin recommendations (Diff Ask) to the list served by Z.ai's client-config service, so Diff Ask shows in the side-pane **New tab → App plugins** grid (and the store's recommended chips). |
| `[fork]` | `packages/ui/src/v4/ConversationStatusPanel.tsx` | The **Changes** row in the status panel (git tools) opens the Diff Ask plugin panel directly (ported from the retired asar patch). Resolves the surface via the plugin UI bridge and opens the side-pane tab; falls back to the stock git review when the plugin is missing. |
| `[fork]` | `packages/shared/src/command-types.ts`, `packages/services/src/commands/commandFileParser.ts`, `packages/ui/src/v4/forkCommandModel.ts` (+ tests), `packages/ui/src/v4/SessionPane.tsx` | **`model:` frontmatter honored per command turn**: `model: <providerId>/<modelId>[$<level>]` (or bare modelId) in a custom command's frontmatter runs that turn on that model (validated against the live selection view; unknown model/level never sent). |
| `[fork]` | `packages/ui/src/v4/SessionPane.tsx`, `packages/ui/src/SlashCommandPlugin.tsx` | **Client-side `/diff`**: an app-layer slash command that opens the Diff Ask panel instantly with NO model turn. App commands now take precedence over same-name CLI catalog entries (so the client-side /diff eclipses the CLI one). Requires a live session. |
| `[fork]` | `packages/ui/test/useUiPluginRecommendations.test.ts`, `packages/ui/test/v4ConversationStatusPanelGitReview.test.ts`, `packages/ui/test/forkCommandModel.test.ts` | Expectations/new tests for the fork behavior. |
| `[fork]` | `apps/zcode-cli/packages/adapters/src/model/runner-debug.ts` (+ `tests/live-cot-tap.test.ts`) | **F81b — tool-arg streaming in the sidecar**: `tool_input_delta` accumulates into `toolName`/`toolChars`/`toolTail` (8k tail; `tool_input_start` names the tool and resets per composition). While the model composes an Edit, the desktop header shows the line count growing (20→42→100) — the Telegram bot mirrors that header from the sidecar. Schema-additive. |
| `[fork]` | `scripts/build-install.nu` | **Unattended + armed modes**: `--yes` (no smoke window/prompt — a closed stdin killed the script at the read), `--when-quit` (detached waiter in its OWN session swaps+reopens+announces on Telegram the moment the app quits), `--zip <path>` (install without rebuilding). |
| `[fork]` | `scripts/sync-upstream.nu`, `scripts/build-install.nu`, `scripts/bootstrap-diff-ask.nu`, `FORK.md` | This runbook. `build-install.nu` also ensures the Diff Ask plugin is installed (see "Diff Ask plugin" below). |
| `[fork]` | `apps/zcode-cli/packages/adapters/src/model/runner-debug.ts`, `runner-stream.ts` (+ `tests/live-cot-tap.test.ts`) | **Live CoT sidecar**: mid-request reasoning/text flushed to `live-io-<session>.jsonl` next to the model-io rollout (first flush at once, then ≤1/s, tails capped 3k/800, rewritten per request, removed when the full record lands). File-based watchers (the Telegram bot) read thinking WHILE it happens instead of per completed request. The canonical `model-io-*.jsonl` is untouched. |

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
./scripts/sync-upstream.nu     # fetch + merge upstream/main into damian + gates
./scripts/build-install.nu     # bundle (ZCODE_ENV=production, unsigned) + swap /Applications/ZCode.app
git push origin damian
git tag damian-v<version>-<yyyymmdd> && git push origin --tags
```

All of the fork's own script surface is typed Nushell (`.nu`) since
2026-11-02: the shebang pins `~/.local/bin/nu-nightly`, and
`nu-check --debug <file>` is the parse gate. The upstream scripts under
`scripts/` that ship with zai-org (release, CDN, Docker e2e) stay bash on
purpose: migrating them would diverge from upstream on every sync.

Merge conflicts, if any, will be in the `[fork]` files above — resolve by
re-applying the small change. If upstream reworks the recommendations pipeline,
`git log -p -- packages/ui/src/plugin-ui/adapters/` shows where it moved.

## Feature deploy (the process, 2026-10-25)

Every feature ALWAYS follows the same pipeline, in this order:

1. **Implement** + tests (red-green where applicable) + `pnpm typecheck`
   (the root does NOT compile `apps/zcode-cli`! each package there compiles
   with its own tsc — also run `cd apps/zcode-cli/packages/adapters && npx
   tsc --noEmit` if you touched it) + `pnpm lint` + `pnpm architecture:check
   --changed`.
2. **Commit** `[fork] ...` + `git push --no-verify origin damian`.
3. **Bundle**: `ZCODE_ENV=production CSC_IDENTITY_AUTO_DISCOVERY=false
   ELECTRON_MIRROR=https://artifacts.electronjs.org/ mise exec -- node
   scripts/mise-run.mjs pnpm bundle:desktop` with the output to a FILE and
   check the real `EXIT:` (a background `| tail` returns tail's exit code and
   **masks the failure** — it happened on 2026-10-25 and almost installed an
   old build).
4. **Swap** with rename semantics (`mv` to `.prev` + `ditto` + `codesign
   --sign -`): the running app stays alive until ⌘Q.
5. **⌘Q + reopen** (Damian does this; never kill zcode processes from the bot).
6. **Verify**: `scripts/verify-deploy.nu` — checks that the app bundle AND
   the repo dist carry each wave's markers, that there are no extra ZCode apps
   in /Applications, and that the running app started after the swap.

**Documented mine (2026-10-25):** when the active workspace IS this monorepo,
the agent resolves from `apps/zcode-cli/packages/cli/dist/zcode.cjs` BEFORE
the app bundle (`resolveDefaultZCodeAgentCommand` in
`zcodeAgentProcessManager.ts`: env → monorepo dist → bundle). The bundle step
regenerates that dist, so the pipeline above keeps both fresh — but a swap
WITHOUT a bundle (or a bundle that fails halfway) leaves the repo dist stale
and "the deploy did not take". That is why step 6 checks both binaries.

## Diff Ask plugin (separate repo)

The three fork touch points (Changes button, `/diff`, plugin-grid card) resolve
the plugin at **runtime** by id `diff-ask@dev-zcode-diff-ask-5098ef5a` and
degrade to stock behavior when it is missing — the fork never bundles plugin
files, so plugin releases don't need an app rebuild.

- Source repo: `~/Projects/zcode-diff-ask` (local) / GitHub
  `damian-rafael-lattenero/zcode-diff-ask`. Both produce the **same marketplace
  id** (`dev-zcode-diff-ask-5098ef5a`, from that repo's `marketplace.json`
  `name`), which is why the id hardcoded in the fork stays valid across
  sources — don't rename it there.
- `scripts/bootstrap-diff-ask.nu` — ensure marketplace + install, idempotent:
  local checkout when `~/Projects/zcode-diff-ask` exists (or
  `$ZCODE_DIFF_ASK_REPO`), GitHub shorthand otherwise. `marketplace add`
  re-binds an existing marketplace to the given source. Run by
  `build-install.nu`; standalone for plugin-only updates (restart ZCode after).
- Plugin-only iteration (no app rebuild): `npm run build` + version bump in the
  plugin repo + commit + push, then `./scripts/bootstrap-diff-ask.nu`.
- Gotcha (2026-10-24): the marketplace scan validates EVERYTHING inside the
  source directory (`.gitignore` is ignored) — keep heavy files out of the
  plugin repo root, or updates die with `plugin_marketplace_invalid`. (The old
  341 MB asar backup that motivated this note lived at
  `~/zcode-official-backup/zcode-diff-ask-tools-backup/` until the whole stash
  was deleted 2026-11-13; asar patching is retired.)

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
`/Applications`). The old local backup stash (`~/zcode-official-backup/` —
official 3.16.3/3.17.2 bundles + a previous fork build) was **deleted
2026-11-13** as stale; the rollback path is simply re-downloading the official
bundle (outside `/Applications` first, so LaunchServices does not see two
`dev.zcode.app` bundles).

## Ledger (installed builds)

| Tag | Upstream version | Installed | Notes |
| --- | --- | --- | --- |
| `damian-v4.0.0-20261123` | 4.0.0 (`upstream/main` `a4b44451`, 2026-11-23) | — (build pending owner) | Upstream sync merge landed 2026-11-23 at HEAD `07de6190` (1 squashed sync commit, 2,209 files, +149,753/−24,801; 29 conflicts — expedition: `docs/fork/upstream-sync-expedition-v4.0.0.md`; cleanup follow-up `d0b67d88`). Gates: root typecheck 0, CLI turbo typecheck 34/34, fork suite 34 files passed + 1 pre-existing CUA-helper backlog file (3 tests, unchanged since v3.17.1), lint 0 errors (546 warnings), architecture 0 violations + 61/61. Decisions: the fork's section status panel stays over upstream's status capsules (support stack restored: panel model/layout/legacy types; `ComposerStatusRow` re-added; capsule-only props accepted but not rendered); the composer badge retired with upstream's deletion (status row is the entry point); Bash tool keeps Nushell + adopts sleep-block/CMD classifier/`backgroundSessionCwd`; executor keeps the fork detach chain with upstream's `live-entry-resolution`; retries adopt admission cooldown with the fork's usage-limit probe inside; terminal shells adopt shared Git Bash discovery with the fork POSIX nu list; updater hard-disable wins. Upstream content: preinstalled document tools, split document plugins + PPTX preview, status capsules, reply language, crash restart, skills/MCP live catalogs, plugin/hook trust, security hardening. Merge-induced fixes: renamed loop-state field in `turn-model-step.ts`, retired the badge unit test. Owner builds via `scripts/build-install.nu` and installs (⌘Q recipe); then `verify-deploy.nu` and this row gets the receipt. Tag pushed with the fork `--no-verify` exception. |
| `damian-v3.18.2-20261113` | 3.18.2 (`upstream/main` `fec97590`, 2026-11-13) | 2026-11-13 | Upstream sync merge landed 2026-11-13 at HEAD `0b69d234` (2 squashed sync commits — `c5904686` v3.18.1 + `fec97590` v3.18.2; 148 files, +5870/−692; 2 conflicts resolved keeping both sides — expedition: `docs/fork/upstream-sync-expedition-v3.18.2.md`). All gates green: fork suite 292✓/3 pre-existing CUA backlog, root typecheck (after deleting stale `.tsbuildinfo` files — the new `app-control-navigation` project surfaced them), CLI turbo typecheck 34/34, CLI doctrine battery (adapters+core) green, lint 0 errors, architecture 0 violations, lockfile byte-identical to upstream. Bootstrap full-suite flakes + 2 deterministic test debts parked (see the expedition doc). Upstream content: memory-diagnostics module, credential-security hardening + Start-plan material split, font-smoothing setting, Windows installer overhaul, `app-control-navigation` desktop project. The HEAD also carries the verbosity expand-all fix (`81e5bbbe`, merged `agent/verbosity-expand` the same morning). Owner-built via `zcode-deploy-all` (Ghostty tab) and installed — `verify-deploy.nu` PASS (bundle 3.18.2, running pid 12991). Tag pushed with the fork `--no-verify` exception. |
| `damian-v3.18.0-20261111` | 3.18.0 (`upstream/main` `b95ebaff`, 2026-11-11) | 2026-11-11 | Upstream sync merge landed 2026-11-11 at HEAD `d1f4cae3` (1 squashed sync commit, 5099 files, +429K/−44K; 29 conflicts resolved keeping both sides — expedition: `docs/fork/upstream-sync-expedition-v3.18.0.md`). All gates green: fork suite 291✓/3 pre-existing CUA backlog, root+CLI typecheck, lint 0 errors, architecture 0 violations, CLI affected suites 397✓, lockfile byte-identical to upstream. Deliberately not adopted: upstream's plan checkbox/marker chip (the owner's standalone toggle wins), retired toolGrouping, retired execute-group renderer. Owner-built (`ZCode-3.18.0-mac-arm64.zip`, 222.8 MiB) and installed — the app runs 3.18.0; first build attempt refused the swap honestly while ZCode was alive (its fail-announce crashed on a literal-paren bug — fixed same day and the helper library renamed to what it does: `scripts/lib/fork-ops.nu`). Tag pushed with the fork `--no-verify` exception. |
| `damian-v3.17.2-20261103` | 3.17.2 (`upstream/main` 2026-11-02) | 2026-11-03 | Built from HEAD `ba53f330` (upstream sync merge: 203 files, 2 content conflicts, both resolved keeping both sides; `a9fe401e` source sync + `e6756260` daemon-channel gifts — read, use a reset, claim an offer, captcha-gated plans remembered). Owner-built and installed (⌘Q recipe); the app runs 3.17.2.9661. Only build error is the PRE-EXISTING x86_64 `window-bounds` defect (arm64 popover works, does not snap). The 3.17.1 build was superseded before it happened — the untagged row below stays as history. |
| *(untagged — build pending)* | 3.17.1 (`upstream/main` `a60ba6a7`, 2026-10-30) | — | The upstream sync merge landed 2026-11-02 at HEAD `81ece566` (merge) + follow-ups through `3ae8b250`. Expedition: `docs/fork/upstream-sync-expedition-v3.17.1.md`. All 9 content conflicts resolved keeping both sides where orthogonal (retry jitter + usage-limit reset, configNetwork retry copy, verbosity-aware render-units selector cache, `turnRunning` folded into `assistantHistoryLockedOpen`, fork slash-command precedence, `/reload` + `/diff` in `SessionPane`). Test doctrine A1: the fork's 17 tests run on `vitest.fork.config.ts`, the 5 DOM tests left `@testing-library` for a local `react-dom/client` helper (`packages/ui/test/fork-testing.tsx`), `packages/ui/package.json` + root `pnpm-lock.yaml` byte-identical to upstream. Gates: root typecheck ✓, CLI turbo typecheck 34/34 ✓, lint 0 errors ✓, architecture 0 violations + 51/51 ✓, engineering 961/961 ✓, CLI suites 284 + tui 220 ✓, fork suite 242 ✓ (3 pre-existing `desktopRuntimeEnv` unsigned-helper failures = backlog, proven on pre-merge `1592700a`). Known upstream breakage absorbed: v3.17.1 ships an inconsistent CLI sub-workspace (`@withfig/autocomplete` added to package.json without regenerating its lockfile; `@zcode/model-option-map` only resolvable from the root workspace). Superseded 2026-11-03: the v3.17.2 build shipped before this merge was ever built — see the row above. |
| `damian-v3.16.2-20261102` | 3.16.2 (`upstream/main` 2026-10-20) | 2026-11-02 | Built from HEAD `bac786e5`. The fork's own script surface is typed Nushell (`build-install`, `verify-deploy`, `bootstrap-diff-ask`, `sync-upstream`, `lib/fork.nu`; `--when-quit` is a launchd job instead of a Python detach). Ships Diff Ask 0.9.20 (Nushell highlighting + composer draft survival). Full automaton cutover `--real`: quit → build/swap → reopen → verify PASS → retire Python, rc=0. |
| `damian-v3.16.2-20261031` | 3.16.2 (`upstream/main` 2026-10-20) | 2026-10-31 | Retroactive tag for the build from HEAD `7ae1a972`: the daemon-local channel complete (respond, steer, plan/modelSelection, contextWindow, quota, stream_keepalive, subagent agentId) and the live Kotlin bot. The ledger caught up two days later. |
| `damian-v3.16.2-20261025f` | 3.16.2 (`upstream/main` 2026-10-20) | 2026-10-25 | Olas 3-7: highspeed transient retry, 15 min model backoff, `nextAttemptAtMs`, usage-limit wait-until-reset, honest labels, deterministic `2^n` retry curve. Superseded by `20261031`. |
| `damian-v3.16.2-20261024` | 3.16.2 (`upstream/main` 2026-10-20) | 2026-10-24 | Verbosity modes (Summary/Normal/Verbose) + retroactive expand-all switch. Replaced wave-2 build (model:/diff, 23/10, untagged). |
| `damian-v3.16.2-20261023b` | 3.16.2 (`upstream/main` 2026-10-20) | 2026-10-23 | Grid card + Changes button → Diff Ask. Replaced `damian-v3.16.2-20261023`. |
| `damian-v3.16.2-20261023` | 3.16.2 (`upstream/main` 2026-10-20) | 2026-10-23 | First fork build (grid card only). Replaced official 3.16.3. |

## Gotcha: pushing needs `--no-verify`

The husky pre-push gate (`verify:pre-push` = lint + db:schema + architecture
+ affected unit tests) is impractical for this fork (verified 2026-10-24):

1. The hook needs `pnpm` on PATH — push from a mise-shims shell or via
   `mise exec --`, otherwise it dies with code 127 before running anything.
2. Upstream's old lint errors are gone (lint now passes with 0 errors), but
   `test:unit:affected` refuses a dirty tree (local untracked dirs count —
   `.zcode/` is now gitignored for this) and, for feature-sized changes
   touching `packages/ui` + `packages/shared`, selects a very large UT set
   that runs for many minutes and looks stuck.

So the ritual is: run `pnpm typecheck`, `pnpm lint`,
`pnpm architecture:check --changed` and the targeted tests yourself, then:

```bash
mise exec -- git push --no-verify origin damian
```

Re-check after each sync — if the gate gets fast/reliable again, drop the flag.

## Wave 2 (night of 2026-10-23, tag `damian-v3.16.2-20261023c`): model: + client-side /diff

- **A** — user commands with `model:` in the frontmatter run THEIR turn on
  that model: `model: account:plan/GLM-5.3-Flash$low` (or a bare modelId).
  Parsed by `commandFileParser`, applied per turn in SessionPane via
  `forkCommandModel.ts` (validated against the live view — an unknown
  model/level is never sent). /diff and any future command: seconds
  instead of 25-30s.
- **C** — `/diff` is now a 100% client-side app-command: it opens the
  Diff Ask panel instantly, WITHOUT a model turn (0 tokens). App-commands
  beat the CLI catalog homonyms (precedence inverted in
  SlashCommandPlugin). Requires a live session.
- **B** (bot side, commit `5e7545f` in the bot repo — the `zcode.cjs` runtime
  is not built from this repo): every protocol runtime keeps the Mac
  awake with `caffeinate -i -w <pid>` while it lives (on battery too).
  It complements the `caffeinate -s` of the poller's LaunchAgent (AC-only).

## Wave 3 (2026-10-25): highspeed resilience against zcode.z.ai 502s

The auxiliary gateway `zcode.z.ai` (where `/api/v1/highspeed/` lives)
suffers 502 micro-outages of a few seconds (measured 2026-10-24/25: 4-6
warns/day, ~5-10s each, while `api.z.ai` answers in 1s). Two client-side fixes
(spec `docs/highspeed/highspeed-card-spec.md` §3 rules 6+16, marked FORK):

- **Fixed retry table** — `highspeedHttpTransport` retries ONLY transient
  failures (502/503/504, network error, timeout): exactly 2 extras at 1s and
  3s (compiled, NOT an open "n/10"). Business codes and 4xx are not
  retried. The table is injectable (`transientRetryDelaysMs`) for tests.
- **The send never breaks because of the card** — if the draw rejects INSIDE the
  1s budget, `prepareTurn` degrades to a normal send (`draw-miss`) instead of
  throwing the exception through the RPC and aborting the prompt (surface
  bug: a fast 502 killed the whole turn). Post-budget was already
  covered (the race frees the in-flight).

## Wave 4 (afternoon of 2026-10-25): "Reconnecting n/10" from the root — backoff up to 15min

Diagnosis (CLI log `~/.zcode/cli/log/zcode-2026-10-25.jsonl`): 567
`model.request.failed` in the day, ALL `statusCode: 502` from
`api.z.ai/api/anthropic` (0 429s: it is neither rate limiting nor Damian's
usage — it is z.ai's gateway). The UI's "Reconnecting n/10" is the
adapter retry (`maxAttempts: 11`, backoff 2s→60s): a ~30s failure ×
11 attempts is exhausted in ~5 min and **kills long turns whole**.

Fix: `forkModelRetrySpawnEnv.ts` injects into the agent spawn
`ZCODE_MODEL_RETRY_MAX_DELAY_MS=900000` (15min) ONLY if the user did not
set it. Resulting curve 2s→4s→…→512s→900s ≈ 32min recovery
window with the same 10 retries (upstream's fixed exponential curve,
only the cap is raised). Chosen by Damian: wait for z.ai to recover
(10-15min per wait is fine) rather than lose the task.

## Wave 4b (night of 2026-10-25): budget per consecutive failures + mm:ss countdown

With the 15min window, two UX defects remained from "n/10":

1. **The counter never reset.** `streamRecoveryRetryCount` was only
   initialized when the turn was created, so in long tasks (dozens of
   iterations) discrete failures accumulated until the core's 10 recoveries
   were exhausted even if successful requests sat between them. Fix in
   `turn-model-step.ts`: a model-request that completes returns the full
   budget (failures count as *consecutive*, not accumulated per turn).
   Red-green test in `runtime-stream-recovery.test.ts`: 2 recoveries
   separated by a success both show `retryNumber: 1`.

2. **There was no way to know how long until the next attempt.** The adapter
   now publishes `nextAttemptAtMs` (absolute epoch) in `model_retry_scheduled`
   (runner-generate/runner-stream/empty-completion-retry, all 3 sites);
   shared normalizes it to `ZCodeApiRetryStatus.nextRetryAtMs` (legacy schema
   included; core stream recovery sends `null` because it reopens with no
   local wait) and the UI (`ChatApiRetryStatus`) renders an `mm:ss`
   countdown (`h:mm:ss` ≥1h) next to the counter that self-calibrates
   against the clock — a re-render or a snapshot replay does not reset it.
   Without the field (old runtime) the UI stays as before: the counter only.

## Wave 5 (night of 2026-10-25): z.ai usage limits — wait for the reset instead of dying

The official doc (docs.z.ai/api-reference/api-code) says that 1308/1310/1316-1321
(usage-window limits) carry `next_flush_time` — the moment the
limit resets. Upstream treats them as terminal (kills the turn) and also
drops the field in `summarizeProviderBusinessBody` (a whitelist that did not
copy it).

Fix (FORK): if the error carries a **parseable** reset, the family moves from
terminal to "retry at that time":

- `failure-usage-limit-reset.ts` (new): parses `next_flush_time` from the body
  (JSON field, unix s/ms or ISO) or from the interpolated message ("Your limit will
  reset at …"); without a time zone it assumes UTC. The wait has clamps: 24h cap
  (the maximum documented window), 120s floor if the reset has already passed
  (avoids a hot loop; each retry consumes an attempt from the budget).
- `classifyProviderBusinessFailure`: with a family code AND a parseable reset
  → `retryable: true` + `retryAfterMs`/`usageLimitResetWaitMs` =
  wait. **Without** a parseable reset it keeps upstream's fail-fast (it does not
  wait blindly). 1113/1309/1313 (balance/plan/fair-use) stay terminal.
- `calculateRetryDelay`: the reset wait bypasses the 5min Retry-After
  gate (it is deterministic, not a "looks reasonable" header).
- Free bonus: workflow stops by quota compute `resetAt` from
  `context.retryAfterMs` — now the notification carries the real reset time.
- UI: Wave 4b's countdown already shows it ("Reconnecting 2/11 · 1:59:32").

Tests: 11 for the parser + 4 for the classifier (includes untouched 1113 and 1308
without flush staying terminal) + 3 for the gate bypass. (Correction 2026-10-28: the "baseline
failure" of `runner.test.ts` cited here was the fork env leaking
into vitest — see Wave 9 / docs/fork/TESTING.md §3.3; already fixed.)



## Wave 6 (afternoon of 2026-10-25): honest labels (B2) + a bulletproof deploy process

What was missing from the "Reconnecting n/10" banner: saying WHAT is happening. The
adapter already publishes `reason` in `model_retry_scheduled`; now it travels to the
UI (`ZCodeApiRetryStatus.reason`, legacy schema included) and the text changes
with the cause (i18n en/zh, fallback to the generic text on an unknown reason):

- `server_error` → "z.ai server error — retrying n/10" (+ countdown)
- `provider_overloaded` → "z.ai overloaded — retrying n/10"
- `rate_limited` → "Rate limited — retrying n/10" (the real 429/1302)
- `timeout`/`stream_idle_timeout` → "Stream stalled — retrying n/10"
- `network_error`/`stale_connection` → "Connection lost — retrying n/10"
- core stream recovery (marks `stream_recovery` in the normalizer) →
  "Recovering stream n/10" with no countdown (it reopens instantly — that is how it
  differs from the adapter retry with a wait)

Diagnosis of the 2026-10-25 "did not take": it HAD taken (agent dist +
bundle + renderer verified fresh); what was seen was a stream recovery
(no countdown by design, previously indistinguishable) and/or old apps in
/Applications confusing the Dock. Actions: deleted `ZCode.prev.app` and
`ZCode-3.16.2-patched.bak`; new `scripts/verify-deploy.nu` ("Feature deploy"
section); the agent resolution mine documented (monorepo dist
before the bundle). Tests: 5 shared (reason passthrough ×3, stream recovery,
fallback) + 5 UI (pure mapping ×2, render server_error/stream_recovery/fallback).

### Wave 6b (night of 2026-10-25): the chat-area pill — the last mile that was missing

The "Reconnecting 3/10" centered over the input did NOT come from the
`ZCodeApiRetryStatus` pipeline but from the **v4** projection (`sessionControl.apiRetry`,
`ApiRetryState`): the CLI producer (`product-projection.ts`) DID build
`nextRetryAt` (event + delayMs) and `reasonCode`, but `toRetryStatus`
(`ConversationTurnGroup.tsx`) discarded them when building the UI state —
that is why that pill never showed a countdown or an honest label.

Fix: `ApiRetryState` gains an optional `reason` (raw ModelRetryReason —
the fault.* reasonCode collapses overloaded with server_error); the producer sets it
(stream recovery marks `stream_recovery`); `toRetryStatus` passes `nextRetryAt`
and `reason` (fallback to reasonCode for old producers, with the fault.*
entries added to the copy map). Stream recovery: no countdown (it reopens instantly).
zod schema non-strict: the optional field tolerates old producers/consumers.

## Wave 7 (night of 2026-10-25): deterministic curve — 2s→4s→…→1024s, no jitter, visible from 1/10

Damian reported (with a screenshot): the pill started at 3/10 and the seconds did
not follow the expected sequence. Diagnosis with the day's log: (a) upstream's
jitter (`wait × [0.5,1)`) makes the readings 1.9s/2.5s/7.0s instead
of a clean 2/4/8 (verified: attempt 1 → 1934/1509/1625 ms); (b)
upstream hides attempts 1-2 on purpose ("equivalent to normal load").

Damian's decision (asked): **pure 2^n up to 17:04** (cap 1024000ms =
exactly attempt 10), total window **34:06**, countdown **per attempt**.

- `retry-policy.ts`: env `ZCODE_MODEL_RETRY_JITTER` ("0"/"false" turns it off;
  invalid is ignored; explicit options still win over env).
- `forkModelRetrySpawnEnv.ts`: cap 900000→**1024000** + `JITTER=0` (only if
  the user did not define them).
- `ConversationTurnGroup.tsx`: `MIN_VISIBLE_API_RETRY_ATTEMPT` 3→1 — the
  full 1/10…10/10 sequence is visible.
- Note: the reported "~16 min" never happened (day maximum: 4:23 on
  attempt 9) — it was the jittered curve read with an expectation of pure 2^n.

## Wave 8 (2026-10-27): the plans cannot find their tools — gateway fail-closed

Report: "ZCode cannot find the tools to run the plans". The
`dynamic-workflows` skill pack is healthy (bundle + repo dist, 0 load warns).
The real failure chain:

1. The dynamic workflow "offer" comes from `configs.dynamicWorkflow.mode`
   on zcode.z.ai (`client/configs`), **fail-closed to disabled** if the fetch
   fails — and that gateway is the 502 one (Wave 3).
2. In production builds, desktop main **wipes** the local env override
   `ZCODE_DYNAMIC_WORKFLOW_MODE` → the only source is the network.
3. With no user choice in settings → effective = offer = **disabled**
   → CreateWorkflow + 9 tools + skill are NOT registered.
4. Extra symptom: the model invoked `Skill("dynamic-workflows:
   dynamic-workflows")` (plugin:skill habit) → `Skill not found`.

Fix (at the root + immediate):

- **Immediate**: `~/.zcode/v2/setting.json` → `dynamicWorkflowMode:
  "onDemand"` — the user's choice ALWAYS beats the failed offer
  (`applyDynamicWorkflowUserMode`); reads of the file are per use.
- **Root**: `desktopRuntimeEnv.ts` — production now sets
  `ZCODE_DYNAMIC_WORKFLOW_MODE=alwaysOn` (same as preview). The env override
  resolves **before any network action** → the gateway no longer gates
  the feature. The user's choice still wins on top.
- **Tolerance**: `matchesSkillRequest` (adapters/skills) — `prefix:name`
  requests also try the bare segment; it only widens the match,
  it does not relax bare names.
- Tests: skills 19/19 (new qualified fallback case), desktopRuntimeEnv
  36/36 (production now expects alwaysOn in two updated tests).
