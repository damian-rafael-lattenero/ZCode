# Upstream sync expedition — v3.18.2 → v4.0.0

Merge executed 2026-11-23, merge commit `07de6190` on `damian` (parents: fork
`96e600fc` + upstream `a4b44451` "chore: sync ZCode source v4.0.0"). Upstream
delta: **1 squashed sync commit** — 2,209 files, +149,753/−24,801. `v4.0.0` is
exactly `upstream/main` at merge time. Cleanup follow-up: `d0b67d88` (dead
composer-badge code). Tag: `damian-v4.0.0-20261123`. Safety tag before the
merge: `pre-v4.0.0-merge`.

## Upstream content

- **Preinstalled document tools** — background install/update/delete of Python
  3.12.16, qpdf 12.4.2, Pandoc, Poppler 26.10.0, LibreOffice 26.8.1; stable
  `bin/` entries on the Agent PATH with `ZCODE_PREINSTALLED_TOOLS_AVAILABLE=1`;
  new root import maps (`#preinstalled-*`) and deps (`tar-stream`,
  `unbzip2-stream`, `yauzl`, `zod`, `@zcode/shared`).
- **Document plugins split** — `documents` / `pdf` / `presentations` /
  `spreadsheets` official plugins (+ `image-search`), shared LibreOffice
  unified entry, PPTX read-only preview with element references into the
  composer.
- **Status capsules** — `ConversationStatusPanel` rewritten (1,672 lines vs the
  fork's 2,869), `ComposerStatusRow` in the composer, activity capsules with
  `activitySummaryDismissed` / `completedActivityCount`, `ComposerStatusRow`
  card mounted from the composer and the read-only dock. Deletes
  `ConversationBackgroundWorkTrigger.tsx`.
- **Chat/protocol additions** — session-activity quit confirmation
  (`hasCompactWork`), crash restart, agent reply language, server-driven draft
  model migration, skills live catalog, MCP async catalog + `WaitForMcpServers`,
  token-budget reminder, `agentAlwaysBackground` setting, plugin-store regions,
  workspace plugin/hook trust, CLI `--browser-state`, security hardening
  (navigation boundary, executable-open guard, hardlink rejection), Windows Git
  Bash discovery, voice-input shortcut, project order sync, web regional login
  same-page redirect, iOS static project discovery.

## Conflict inventory (29 from the `git merge-tree` dry-run)

| # | File | Resolution |
| --- | --- | --- |
| 1 | `adapters/src/exec/bash-shell-provider.ts` | Kept `resolvePosixNuShell` (fork) on top of upstream's async `resolveWindowsBashShellProvider`. |
| 2 | `adapters/src/model/empty-completion-retry.ts` | Took upstream's `retryDelayWithAdmissionCooldown` wrapper (the follow-up log line needs its fields). |
| 3 | `adapters/src/model/runner-generate.ts` | Admission-cooldown block adopted; `calculateRetryDelay` keeps the fork's `usageLimitResetWaitMs` arg. |
| 4 | `adapters/src/model/runner-stream.ts` | Same union in both hunks; the fork's segmented usage-limit probe stays inside the new destructuring. |
| 5 | `adapters/src/skills/index.ts` | Upstream's exported `matchesSkillRequest` + the fork's colon-qualified fallback. |
| 6 | `adapters/tests/failure-classifier.test.ts` | Fork's usage-limit reset suite + upstream's `provider code shape` suite, both kept. |
| 7 | `bootstrap/.../product-projection.ts` | Fork's live-detail map/method/serializer kept; upstream's `activitySummaryDismissed` patch and completed-activity index fields kept. Idempotence compares `liveDetail` **and** `resultSummary`. |
| 8 | `bootstrap/.../server-operations.ts` | Fork's cross-platform shell guard + `resolveDefaultSessionBashShellSelection` on the async signature; CMD fallback uses `WINDOWS_CMD_SHELL_DISPLAY_NAME`; Nushell/POSIX display names kept. |
| 9 | `bootstrap/tests/zcode-protocol.test.ts` | Fork's three Nushell default/explicit tests kept. |
| 10 | `contracts/src/interfaces/execution.port.ts` | Doc-comment union (`Nushell`, `cmd.exe`). |
| 11 | `core/src/runtime/types.ts` | `targetContinuationBudget` (fork) + `totalTokensReminder` (upstream). |
| 12 | `core/src/tool/executor/call-runner.ts` | Fork's early `readOnlyBashCapability` + nu branch and upstream's CMD classifier; detach gate kept; upstream's helper extraction (`live-entry-resolution`, `model-output-entry`, `result-helpers`) wins over the duplicated tail. |
| 13 | `core/src/tool/handlers/bash-prompt.ts` | Both imports; nu prompt gains the foreground-sleep rule (same validator). |
| 14 | `core/src/tool/handlers/bash.ts` | Union: nu read-only branch, `requestedBy`/`backgroundedByUser`, upstream's `backgroundSessionCwd`/`syncSubagent` in one options object. |
| 15 | `core/src/tool/handlers/index.ts` | Both imports. |
| 16 | `core/src/tool/handlers/websearch.ts` | Fork's `backgrounding` capability + upstream's `validateInput`. |
| 17 | `docs/testing/conversation-session-e2e-coverage-matrix.md` | Fork's DT section + upstream's 2026-11-11 evidence note. |
| 18 | `packages/services/src/node.ts` | Fork retry-env defaults + upstream preinstalled-tools env/PATH. |
| 19 | `packages/services/src/system/integratedTerminalShells.ts` | Upstream shared Git Bash discovery + async signature; fork POSIX nu/zsh/bash list kept; probe made async. |
| 20-24 | `packages/ui/src/i18n/locales/{en-US,ja-JP,ko-KR,ru-RU,zh-CN}.ts` | Fork background-work keys kept; `chat.statusPanel.viewAllChanges` adopted. |
| 25 | `packages/ui/src/lib/userActionTraceCatalog.ts` | Verbosity actions (fork) + token-reminder / always-background switches. |
| 26 | `packages/ui/src/v4/ConversationComposer.tsx` | Interrupt picker imports kept; trigger import dropped with the component. |
| 27 | `packages/ui/src/v4/ConversationStatusPanel.tsx` | Fork panel kept wholesale over the capsule rewrite (see Decisions). `ComposerStatusRow` re-added; capsule-only props accepted. |
| 28 | `packages/ui/src/v4/SessionPane.tsx` | Fork's four blocks (section state, status model/counts/handlers, queue panel, panel mounting) kept; the duplicate panel instance removed and the upstream `statusCapsules` instance extended with the fork props. |
| 29 | `packages/ui/src/v4/composer/ConversationBackgroundWorkTrigger.tsx` | Deleted (modify/delete, upstream deleted it); the status row is the single entry point. |

## Decisions

1. **Status panel: fork wins.** Upstream replaced the section panel with
   status capsules. The fork's panel carries the Task Island sections
   (terminals / tools / turns / agents / workflows) and the Diff Ask-first
   Changes row; porting all of that to capsules is a redesign, not a merge.
   The panel keeps its own support stack, restored from `damian`:
   `conversationStatusPanelModel.ts` (`sessionPlans`, `workflowRunWords`),
   `conversationLayout.ts` (`resolveConversationStatusPanelVariant`,
   `shouldUseConversationStatusPanelInlineLayout`, width classes) and
   `legacyChatViewTypes.ts` (`ChatViewSummaryPanelVariant`).
   `ConversationTimeline` regained the `summaryPanelLayout` prop so the
   content column still makes room for the inline panel.
   Capsule-only data (ended subagents, completed-activity count, dismissal
   watermarks) flows through the props but is not rendered yet.
2. **Composer badge retired.** With upstream's deletion, the badge (counts,
   tooltips, `TID_V4_COMPOSER_BACKGROUND_WORK_TRIGGER`) no longer exists; the
   status row is the entry point. Its dead handler/memo went with `d0b67d88`.
   The two test ids the fork still needs (`TID_CHAT_SUMMARY_PANEL`, the
   retired trigger id for the pending e2e specs) were restored in
   `packages/shared/src/test-ids.ts`.
3. **Bash tool mergers.** Upstream's foreground `sleep >= 25s` block, CMD
   read-only classifier, `backgroundSessionCwd` and `timed_out` provider error
   live next to the fork's Nushell path. The nu provider prompt now documents
   the sleep rule because the shared validator applies to every dialect.
4. **Executor.** Upstream's `live-entry-resolution` module and
   `unparsed-JSON` / hook-updated-input validations are adopted; the fork's
   detach gate and `completeDetachedToolCall` chain stay as the only
   backgrounding path. The helper modules the fork extracted in the audit
   (`model-output-entry.ts`, `result-helpers.ts`) remain the single source,
   so upstream's duplicate tail was dropped.
5. **Updater.** The fork's hard-disable (`enabled:false`,
   `ZCODE_AUTO_UPDATE` frozen) wins over the new in-app confirmation flow:
   the fork never installs official builds. The hydration that clears ghost
   release notes is untouched.
6. **Terminal shells.** Upstream's shared Windows Git Bash discovery is
   adopted (it also feeds `packages/shared/node`), together with the async
   listing signature. The fork's POSIX option list (Nushell first) and the
   `resolveDefaultSessionBashShellSelection` cross-platform guard are kept.

## Not adopted (deliberate)

- **Status capsules** (superseded by decision 1; revisitable later).
- Upstream's `chat.capsule.*` / capsule tests: the i18n keys stay (harmless),
  the pending browser test `composer-status-capsules.test.mjs` targets a UI
  this fork does not render.
- `getConversationContentWidthClassName` simplification (the fork's width
  classes are restored with the layout helpers).

## Gates (all run on the merge, 2026-11-23)

| Gate | Result |
| --- | --- |
| `pnpm install` | OK (lockfile from upstream, new deps resolved) |
| Root `pnpm typecheck` | **0 errors** |
| CLI turbo typecheck (`node_modules/.bin/turbo typecheck` from `apps/zcode-cli`) | **34/34** |
| Fork suite `vitest run -c vitest.fork.config.ts` | 34 files passed, 1 failed — `desktopRuntimeEnv` unsigned-CUA helper ×3, the **pre-existing** backlog proven on the v3.17.1/v3.18.0/v3.18.2 baselines (378 passed / 3 failed / 1 skipped) |
| `pnpm lint` | 0 errors (546 warnings; +6 vs the v3.18.2 baseline, all exhaustiveness/deps warnings) |
| `pnpm architecture:check -- --changed` | 0 violations (baseline 0, new 0) |
| `pnpm test:architecture` | 61/61 |

### Merge-induced fixes (found by the gates, not by conflicts)

- `turn-model-step.ts` — upstream renamed `inputAttachmentCollectionPending`
  to `normalInputPreparationPending`; the fork's text-guide hunk still used
  the old field (CLI typecheck caught it).
- `packages/ui/test/v4BackgroundToolWorks.test.ts` — retired: it imported the
  deleted trigger component.
- `ConversationStatusPanel` / `SessionPane` — the 3 missing capsule props,
  `ComposerStatusRow`, `ChatViewSummaryPanelVariant` import, the restored
  layout imports and the pane-local variant control were re-added.

## Build/install

Not run by the agent: the owner deploys the fork. After
`scripts/build-install.nu` + `scripts/verify-deploy.nu`, append the build
receipt to the `damian-v4.0.0-20261123` ledger row in `FORK.md`.
