# Upstream sync expedition — v3.18.0 → v3.18.2

Merge executed 2026-11-13, merge commit `0b69d234` on `damian` (parent: fork `b9e1a9d0` + upstream `fec97590` "chore: sync ZCode source v3.18.2"). Upstream delta: **2 squashed sync commits** — `c5904686` (v3.18.1) + `fec97590` (v3.18.2) — 148 files, +5,870/−692 lines. Upstream `main` was exactly at 3.18.2 at merge time (no tag needed; the ritual follows `upstream/main`).

## Upstream content

- **v3.18.1** — `memory-diagnostics` module (adapters: recorder/storage/types + tests; bootstrap `resource-sampler` wiring), Windows installer overhaul (runtime host CMake/helper), architecture-policy module for `cli-memory-diagnostics`, voice-input permission guide TIDs/i18n, composer voice docs.
- **v3.18.2** — credential-security hardening (`systemCredentialCipher`, contract, desktop host/main/auth wiring, Start-plan material split in `node.ts`/`accountProviderConnectionResolver`), Start Plan CN unlinked login e2e, font-smoothing setting (SettingsPage + i18n), `app-control-navigation` desktop project (referenced by `tsconfig.main.json`), architecture snapshot refresh.

## Conflict inventory (2 from the `git merge-tree` dry-run)

Both resolved keeping both sides.

| # | File | Resolution |
| --- | --- | --- |
| 1 | `.gitignore` | Union of appended blocks: fork's `.zcode/` + upstream's `packages/desktop/build/generated/` (NSIS afterPack artifact). |
| 2 | `docs/bash-background-parity.md` | Fork's structure kept — the fork's BT work moved `backgroundedByUser` reachability into 已支持 (upstream still lists it under 暂不支持) — plus upstream's reworded final bullet (the global background-tasks switch lost its `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` literal upstream). |

## Semantic merges the auto-merge hid (reviewed, clean)

- `architecture-policy.yaml` — upstream's `cli-memory-diagnostics` module appended; the fork's exception block untouched.
- `.agents/skills/feature-boundary-planner/references/zcode-feature-graph.yaml` — upstream label tweak only; fork's `background-turn-demotion` edge intact.
- `packages/services/src/node.ts`, `packages/shared/src/index.ts`, `packages/shared/src/test-ids.ts` — pure upstream (Start-plan material, `MicrophoneAccessResetResult` export, voice-permission TIDs); no fork-field collision (the duplicate-zod trap did not apply: upstream did not touch `sessions-index.ts` / `zcode-protocol/index.ts`).
- `packages/ui/src/SettingsPage.tsx` + i18n locales — upstream font-smoothing + microphone-permission keys only; fork's verbosity keys intact, no `toolGrouping` resurrection.
- A1 doctrine held without intervention: `git diff upstream/main -- pnpm-lock.yaml packages/ui/package.json` empty (byte-identical).

## Stale-build-state incident (typecheck gate)

Root `pnpm typecheck` failed on the first run with a `TS6305` cascade (`out/app-control-navigation/main.d.ts` "has not been built") + 3 derived `TS7006` implicit-any errors in upstream's `desktopHostProcess.ts` / `main/index.ts` / `host/index.ts`. Cause: **stale `.tsbuildinfo` incremental state, not missing sources** — `packages/desktop/out/` was empty yet `out/tsconfig.main.tsbuildinfo` and `packages/desktop/{tsconfig.app-navigation,tsconfig.host,tsconfig.renderer-services}.tsbuildinfo` claimed up-to-date (left over from the v3.18.0 build). Deleting the 5 gitignored tsbuildinfo files and re-running the gate turned it green.

**Doctrine extension for the next sync:** the v3.18.0 note said "build sibling dist-types first (contracts/adapters/core/dynamic-workflow)"; now it is "stale build state lies — delete `.tsbuildinfo` (and stale `out/`) before blaming the merge" when a `-b` gate reports unbuilt outputs for a project upstream touched.

## Gates (all run on the merge, 2026-11-13)

| Gate | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | OK (lockfile untouched) |
| Fork suite `vitest run -c vitest.fork.config.ts` | 292 passed / 3 failed / 1 skipped — the 3 are the **pre-existing** `desktopRuntimeEnv` CUA-helper backlog (identical names proven on the v3.18.0 and v3.17.1 baselines) |
| `pnpm typecheck` (root) | OK after deleting the stale tsbuildinfo files (see incident above) |
| CLI turbo typecheck | 34/34 OK (root `node_modules/.bin/turbo typecheck` from `apps/zcode-cli`; `pnpm exec turbo` does not resolve there) |
| `pnpm lint` | 0 errors (540 warnings = upstream's own, same count as v3.18.0) |
| `pnpm architecture:check -- --changed` | 0 violations |
| `pnpm test:architecture` | OK |
| A1 doctrine: `git diff upstream/main -- pnpm-lock.yaml packages/ui/package.json` | empty — byte-identical to upstream |
| CLI doctrine battery (full `packages/adapters/tests` + `packages/core/tests/runtime-stream-recovery.test.ts`) | **green on final HEAD `81e5bbbe`** — every adapter+core file passed (runner ×129, runner-retry, skills, live-cot-tap, failure-classifier, failure-usage-limit-reset, bash-handler, bash-run-conformance, credential-security ×2, memory-diagnostics, mcp) |

### Bootstrap full-suite observation (non-blocking, parked)

A broader run that also included `packages/bootstrap/tests` (6,564 tests total) surfaced 69 failures across 15 heavy process-spawning files. Pattern: most die at the ~5s process timeout under load and the failure set is **non-deterministic across runs** (18 files in the first run vs 15 in the second, different mixes — e.g. `plugins.test.ts` 4→12, `session-persistence` 10→8, `app-unbound-resume` appearing only in run 2). Deterministic exceptions:

- `product-projection.test.ts` — 3 fast (2–26ms) assertion failures in the fork's apiRetry/retry projection tests; last proven green at v3.17.1, and **not part of the v3.18.0 gate battery**. Neither the upstream delta nor the verbosity commits touch `product-projection.ts`, so this predates the merge; root cause not proven (upstream did touch neighboring shared modules) — parked as fork debt, baseline worktree was ready for the comparison when the owner paused the investigation (2026-11-13).
- `v4-gateway.test.ts` — 1 timeout-shaped failure (~10.7s) in both runs; the file IS upstream-touched (v3.18.1 +4 lines). Same parking.

## Not adopted (deliberate)

Nothing to retire this time: upstream shipped no replacement for any fork surface (no plan-dropdown UI, no renderer retirement).

## Build/install

Not run by the agent: the owner deploys manually (2026-11-13). After `scripts/build-install.nu` + verify, tag per the ritual:
`git tag damian-v3.18.2-<yyyymmdd> && git push origin damian-v3.18.2-<yyyymmdd>` and append the FORK.md ledger row.
