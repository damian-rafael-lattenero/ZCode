# Fork testing: what exists, how long it takes, and where the cracks are

> Durations **measured** on this Mac (M-series, 8 lint threads, vitest
> 4.1.x) during the October 2026 waves. The dominant time in small unit tests
> is almost always `import`/`transform`, not execution.

## 1. Suites the fork touches (with real measured duration)

| Suite (command from the root or the workspace) | Tests | Measured duration | What it covers |
| --- | --- | --- | --- |
| `packages/ui/test/chatApiRetryCountdown.test.ts` + `packages/shared/test/zcodeApiRetryStatus.test.ts` | 18 | ~3–5 s (jsdom) | mm:ss countdown, labels per reason, `toRetryStatus` last mile, normalizer |
| `apps/…/core/tests/runtime-stream-recovery.test.ts` | 3 | ~6 s (5.8 s import) | recovery budget per consecutive failures (red-green) |
| `apps/…/adapters/tests/failure-usage-limit-reset.test.ts` + `failure-classifier.test.ts` + `runner-retry.test.ts` | 109 | ~1.9 s | `next_flush_time` parser, z.ai code table, 5 min gate bypass |
| `apps/…/adapters/tests/runner.test.ts` | 129 | ~2.6 s | 2^n curve with jitter=0 (adverse random), env parsing, 60s cap default (green after §3.3) |
| `apps/…/adapters/tests/skills.test.ts` | 19 | ~1.1 s | name matcher `prefix:name` → bare segment |
| `apps/…/bootstrap/tests/*projection*.test.ts` | 5 | ~5.5 s | v4 projection (ApiRetryState with reason) |
| `packages/services/test/forkModelRetrySpawnEnv.test.ts` | 3 | <1 s | env injection only if the user did not set it |
| `packages/desktop/test/desktopRuntimeEnv.test.ts` | 36 | ~0.25 s | Host env per build tier (production = alwaysOn) |
| **Full adapters suite** (`npx vitest run packages/adapters/tests/` from `apps/zcode-cli`) | 2 289 | **~59 s** | the whole model/retry/classifier — run it before touching adapters |

Big-suite reference: `pnpm test:unit` / `pnpm test` (whole workspace)
only on explicit request; `verify:pre-push` selects the affected UTs
but refuses a dirty tree and can take many minutes (see
[`FORK.md §Gotcha`](../../FORK.md)).

## 2. Per-change verification (mandatory pipeline)

```
pnpm typecheck                      # root: packages/* (NOT apps/zcode-cli — crack §3)
cd apps/zcode-cli/packages/<pkg> && npx tsc --noEmit   # ALWAYS when apps/ was touched
npx vitest run <affected tests>     # red-green when applicable
pnpm lint                           # oxlint, ~0.6 s over 6 700 files
pnpm architecture:check --changed   # <2 s; new files ⇒ exception in architecture-policy.yaml
```

The **bot has no formal suite** (the venv's pytest is unused infrastructure). Its
"testing" is: hot-backup per change (`~/.zcode/hooks/backups/`), production
watchdogs (`healer` reads heartbeats and acts if nobody delivers — F79c), and
live verification from Telegram. The fork-side tests are what
cover the contracts the bot consumes (sidecars, curves, states).

## 3. Known cracks (what the pipeline does NOT catch on its own)

1. **The root typecheck does not compile `apps/zcode-cli`.** Each package there
   compiles with its own `tsc`. On 2026-10-25 a missing CLI contract broke the
   bundle mid-deploy (commit `17fc5959` covered it). Rule: if you touched
   `apps/zcode-cli/**`, run that package's `tsc --noEmit` (or the agent
   build) BEFORE `bundle:desktop`.
2. **`oxfmt` does not cover `apps/`** and `packages/ui/src/chat-input-toolbar/display.tsx`
   is NOT pre-existing fmt-clean — running it there butchers the diff (~140 lines
   of noise). Edit by hand, respecting the file's style.
   `pnpm fmt:check` fails repo-wide on ~2 136 files: pre-existing.
3. **(RESOLVED 2026-10-28) `runner.test.ts` failed with 64000 vs 60000.**
   Original diagnosis (2026-10-25, wrong): "upstream baseline failure".
   Real cause: running vitest **inside the fork's spawned agent** inherits
   `ZCODE_MODEL_RETRY_MAX_DELAY_MS=1024000` from the spawn env — the test's 60s cap
   was overridden. Upstream in CI (without that env) is green. Fix:
   `apps/zcode-cli/test/setup/fork-hermetic-env.ts` (the CLI's vitest
   setupFiles) deletes the variables the fork injects; tests that WANT
   to exercise env-driven behavior still pass it explicitly. runner.test
   129/129 green. General lesson: any test that runs in the app/bot
   inherits the fork env — distrust "mysterious" failures that do not
   reproduce in CI.
4. **Lint: 96–97 pre-existing warnings** (0 errors). None in fork files
   as of 2026-10-28.
5. **A background `| tail` returns tail's exit code** and masks
   build failures (happened on 2026-10-25). Builds run with `> log 2>&1; echo
   "EXIT:$?" >> log` and the real `EXIT:` is checked.

## 4. The deploy is tested too (`scripts/verify-deploy.nu`)

Post-swap gate, runs in <2 s:

- **Markers per wave** in the THREE binaries: `Resources/glm/zcode.cjs`
  (agent), `app.asar` (UI/shared — minification-proof string
  literals, binary `grep -a`), and the repo dist (because this workspace's
  agent resolves from there BEFORE the bundle).
- No extra ZCode apps in `/Applications` (by bundle id — Dock/Spotlight
  opens the old one if it exists).
- The running app started after the swap (detected via `ps comm` — Electron's
  main launches with argv[0] lacking a path and `pgrep -f` does not see it).

Every new wave adds its marker to the script's list. The bundle's `EXIT`
and the verify PASS are the two signatures of a complete deploy.

## 5. Full deploy pipeline durations (measured)

| Step | Typical duration |
| --- | --- |
| `pnpm typecheck` (incremental) | 10–30 s (cold: minutes) |
| `tsc --noEmit` of one `apps/` package | 30–45 s |
| `pnpm lint` | ~0.6 s |
| `pnpm architecture:check --changed` | <2 s |
| Affected tests (those in §1) | 2–60 s depending on scope |
| Full `bundle:desktop` | **5–6 min** (prepare:runtime-assets ~2–3 min; electron-builder ~2–3 min; DMG after the .app — the .app is enough) |
| Swap + codesign + verify | ~15 s |

Reactive flow: the bundle runs in the background and notifies only when it finishes
(no sleep-polling); the swap happens on receiving the notification and the ⌘Q is
done by Damian (the headless bot never kills ZCode processes — it would kill its
own host, real incidents of 2026-10-13).
