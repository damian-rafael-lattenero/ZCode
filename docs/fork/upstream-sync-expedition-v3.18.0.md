# Upstream sync expedition — v3.17.2 → v3.18.0

Merge executed 2026-11-11, merge commit `d1f4cae3` on `damian` (parent: fork `15fe7979` + upstream `b95ebaff` "chore: sync ZCode source v3.18.0", source `cc1f87e4`). Upstream delta: 1 squashed sync commit, 5099 files, +429,348/−44,745 lines.

## Conflict inventory (29 from the `git merge-tree` dry-run)

All 29 resolved keeping both sides where orthogonal; fork behavior survives everywhere.

| # | File | Resolution |
| --- | --- | --- |
| 1 | `.agents/skills/feature-boundary-planner/references/zcode-feature-graph.yaml` | Union of edges (fork `background-turn-demotion` + upstream `archive-permanent-deletion`). |
| 2 | `apps/zcode-cli/packages/adapters/src/model/runner-stream.ts` | 4 hunks, one shape: fork `liveCotTap(event)` + upstream `yield withRepairMarker(event)` → `liveCotTap(event); yield withRepairMarker(event);` at every site. |
| 3 | `architecture-policy.yaml` | Union of `exceptions:` (2 fork + 4 upstream at the top; upstream extended `workflow-mode-user-choice-unmanaged-edit`, 4 fork exceptions re-appended after it). |
| 4 | `docs/conversation-product-protocol.md` | Fork's `backgroundTurnHoldsQueueDrain` paragraph + upstream's extended `editQueueItem`/edit-lock paragraph. |
| 5 | `docs/conversation-session-case-catalog.md` | Union: fork's DT + BT sections (BT path updated to the renamed `remote/installation/manual-review/pending/`) + upstream's XSG02/APD/MEM-DEVICE/IFD/TT/AAP sections. |
| 6 | `docs/testing/conversation-session-e2e-coverage-matrix.md` | Upstream's 2026-11-09 evidence note + fork's DT section (all 4 pending-spec paths updated to the renamed directory). |
| 7–10 | `packages/desktop/test/e2e/.../manual-review/pending/{background-tool-call{,-edges},detach-turn{,-edges}}.test.ts` | File-location conflicts: upstream renamed the directory (`manual-review/pending` → `remote/installation/manual-review/pending`). Fork's 4 e2e specs moved to the new path, fork content kept. |
| 11 | `packages/services/src/highspeed/highspeedCardService.ts` | Semantic: upstream's `startDraw` now applies the draw response itself (auth-scope bound) and resolves `null` for a stale scope. Fork's `applyDrawResponse` call dropped (would double-apply); upstream's `!outcome.value → unavailable` translated through the fork's wrapper to `!outcome.value.response → unavailable`; the fork's wrapper stays (spec §3 rule 16: a rejected draw inside the budget degrades to `draw-miss`). Gate-follow-up: the new top auth gate now returns `draw-timeout` **with the cached card** (fork law: the fallback carries the card, UI keeps showing it valid). |
| 12 | `packages/services/src/zcode-agent/zcodeTaskServiceAdapter.ts` | Import union; `sendPrompt` takes upstream's `Promise<CommandAck \| undefined>` signature with the fork's A4 subagent-order preamble intact (subagent branch returns honest `undefined` — no ack exists for an order). |
| 13 | `packages/shared/src/protocol.ts` | Fork's `messageStreamVerbosity`/`ExpandedByDefault` kept; upstream's toolGrouping settings retired (feature removed upstream). |
| 14 | `packages/shared/src/zcode-protocol-v4/command.ts` | Union: fork's `backgroundTurn` + `backgroundToolCall` commands + upstream's `stopSubagent`. |
| 15 | `packages/shared/src/validationAppSettings.ts` | Same doctrine as protocol.ts (verbosity kept, toolGrouping retired). |
| 16 | `packages/ui/src/SettingsPage.tsx` | Verbosity state/handlers kept, toolGrouping states/handlers dropped; verbosity props now passed to the new `AgentBehaviorSectionContent` (upstream moved the message-stream settings there). |
| 17 | `packages/ui/src/ToolCallBlocks/ToolLayout.tsx` | Import union (fork `useSyncExternalStore` + upstream `SummaryPreviewContext`/`SummaryIconOnlyContext`/`useContext`). |
| 18 | `packages/ui/src/ToolCallBlocks/renderers/execute-group.tsx` | Modify/delete: upstream retired the group renderer; fork's only change (passing `onBackgroundToolCall` down) is moot → adopted the deletion (`git rm`). |
| 19 | `packages/ui/src/ToolCallBlocks/renderers/execute.tsx` | Fork's BT backgrounded-label suffix (now on upstream's new `chat.toolCall.execute.ran` id) + upstream's XSG02 Bash-description secondary text. |
| 20 | `packages/ui/src/components/marketing-touch/marketingTouchController.ts` | Import union (`Locale` + `ManualClaimPlanFailureReason`). |
| 21–22 | `packages/ui/src/i18n/locales/{en-US,zh-CN}.ts` | Fork's verbosity keys kept; upstream's toolGrouping keys retired. |
| 23 | `packages/ui/src/settingsPageHelpers.tsx` | Fork's verbosity props/UI moved into upstream's new `AgentBehaviorSectionContent` (the message-stream settings' new home); toolGrouping props dropped; auto-merge had already placed the fork's verbosity rows inside the new section. |
| 24 | `packages/ui/src/v4/ConversationFileSummaryPanel.tsx` | Import union (fork `useRef`/`useSyncExternalStore`/expand-default store + upstream `LoaderCircle` rename/`FileRewindLockedHint`). |
| 25 | `packages/ui/src/v4/ConversationStatusPanel.tsx` | Fork's detached-turn icon branch (`MessageSquareTextIcon`) + upstream's `SubagentCollectionIcon` rename as the fallback. |
| 26 | `packages/ui/src/v4/ConversationTurnGroup.tsx` | Import union; fork's stale items-recomputation block replaced by upstream's `groups`/`groupKeys` shape with the fork's verbosity injected into `useConversationAssistantWorkItems` (the merged `buildAssistantWorkRenderItems` already accepts `ConversationReasoningVisibility` incl. verbosity); history-header chevron = fork's `assistantHistoryLockedOpen ?? defaultOpen` gate + upstream's `collapsible` gate. |
| 27 | `packages/ui/src/v4/SessionPane.tsx` | 6 hunks: import union (+`useExtensionWorkbenchPane`); verbosity/expand + mirror-store effect kept (toolGrouping dropped); fork's `handleBackgroundToolCall` + upstream's `handleStopSubagent`/`pendingSubagentStops` both kept; rowContext + deps keep verbosity, drop toolGrouping; single `openPluginUi` declaration (fork's, reused by upstream's draft request) + upstream's extension reporting hook. |
| 28 | `packages/ui/src/v4/composer/ConversationBackgroundWorkTrigger.tsx` | Icon union minus unused `BotIcon`. |
| 29 | `packages/ui/src/v4/composer/V4ComposerModeControls.tsx` | Fork's architecture wins (owner's law: standalone plan toggle outside the permission menu, #301 hooks law — no `if (!selected) return null`); upstream's new `modeTriggerColor` trigger styling + item descriptions adopted; upstream's plan checkbox inside the dropdown and the plan-marker chip dropped (the toggle already always speaks). |

## Semantic merges the auto-merge hid (caught by the gates)

- `packages/shared/src/zcode-protocol-v4/sessions-index.ts` — upstream adopted the same `parentSessionId` field the fork added; the fork's duplicate removed, fork's `taskType` kept (upstream has none).
- `packages/shared/src/zcode-protocol/index.ts` — upstream added `inputPresentation` to the steer schema that the fork had already added (2026-10-30 audit); fork's duplicate removed.
- `packages/ui/src/v4/SessionPane.tsx` — one orphaned `>>>>>>>` marker left by the conflict-3 union; removed.

## Gates (all run on the merge, 2026-11-11)

| Gate | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | OK (9s; lockfile untouched) |
| Fork suite `vitest run -c vitest.fork.config.ts` | 291 passed / 3 failed / 1 skipped — the 3 are the **pre-existing** `desktopRuntimeEnv` CUA-helper backlog, proven identical on the pre-merge baseline (`15fe7979`, temp worktree: 3 failed / 33 passed) |
| `pnpm typecheck` (root) | OK after the semantic-merge fixes above |
| CLI per-package `tsc --noEmit` (adapters, core, contracts, bootstrap, i18n) | all OK after building sibling dist-types (`contracts`, `adapters`, `core`, `dynamic-workflow`) |
| `pnpm lint` | 0 errors (540 warnings = upstream's own) |
| `pnpm architecture:check -- --changed` | 0 violations, 0 new |
| `pnpm test:architecture` | OK |
| A1 doctrine: `git diff upstream/main -- pnpm-lock.yaml packages/ui/package.json` | empty — byte-identical to upstream |
| CLI affected suites (runner, runner-retry, skills, live-cot-tap, failure-classifier, failure-usage-limit-reset, bash-handler, bash-run-conformance, runtime-stream-recovery) | 397/397 passed |

## Not adopted (deliberate)

- Upstream's plan checkbox inside the mode dropdown + plan-marker chip — the owner's standalone plan toggle (10/11 law) already always speaks its state.
- Upstream's toolGrouping settings/UI/i18n — upstream retired the feature; the fork follows.
- Upstream's `execute-group` renderer — retired upstream; the fork's single change to it died with the feature.

## Build/install

Not run by the agent: the owner deploys manually (2026-11-11). After `scripts/build-install.nu` + verify, tag per the ritual:
`git tag damian-v3.18.0-<yyyymmdd> && git push origin damian-v3.18.0-<yyyymmdd>` and append the FORK.md ledger row.
