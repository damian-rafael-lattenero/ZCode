# Upstream sync expedition — v3.16.2 → v3.17.1 (the merge plan)

Expedition report recovered verbatim from the OpenCode plan session "git diff zcode" and re-verified against the repo on 2026-11-02 before being archived here. The Spanish original is preserved in the raw archive cited in §0; §1 is its English rendering, marked `[translated]`.

## 0. Provenance & verification

**Session**
- OpenCode session `ses_e63713227ffeXDxAmRuMKhwJrk` — "git diff zcode", agent `plan`, model `gemini-4-argon` (opencode-go, variant high), run 2026-11-02 10:59:26 → 11:28:00 (-03), directory `/Users/lattenero/Projects/ZCode`.
- Token ledger: 1,500,576 input / 15,244 output / 20,039 reasoning / 9,984,280 cache-read. Outcome: succeeded.

**Raw archive (the full 431K-token context)**
- `/Users/lattenero/Projects/git-diff-zcode.json` — full session export, 1.5MB, tool outputs complete.
- `/Users/lattenero/Projects/git-diff-zcode.json.gz` — gzip backup (480KB).
- `/Users/lattenero/Projects/git-diff-zcode.transcript.md` — readable transcript (tool outputs capped at 3000 chars; the JSON has them complete).
- Source of truth: `~/.local/share/opencode/opencode.db` (tables `session_v2` + `session_message`, 1.38MB of message data for this session).

**Verification performed 2026-11-02 (ZCode conversation, after recovery)**
- 57/57 session messages in the DB = 57 in the JSON export, zero ID diff → the export is complete; no blobs, no separate part store, nothing missing.
- The final report below is byte-identical to the session's last assistant message (only a trailing newline differs from the user's paste).
- Fork file list (`git diff --name-only 3c5b2276..damian`): **0 added / 0 removed** since the expedition → every conflict analysis below still applies.
- File count correction: the real count is **109 files (34 `[A]` + 75 `[M]`)**; the report's "107" undercounts by 2. The per-group analysis is unaffected.
- `upstream/main` unchanged at `a60ba6a7` (tag `v3.17.1`); merge-base unchanged at `3c5b2276` (v3.16.2). Only delta since the session: `f2f3df12` (FORK.md ledger, +1 line — Group 4 territory).
- Expedition scope sanity: upstream's `-611.504` lines come from Z.ai retiring all App unit tests on 2026-10-26 (policy `docs/testing/unit-test-quality.md`); the `apps/zcode-cli` suite was NOT retired.

## 1. The expedition report (verbatim from the session; `[translated]`)

I ran the full expedition (100% read-only) comparing our `damian` branch against `upstream/main` (`a60ba6a7`, tag **`v3.17.1`** of 2026-10-30) from the common `merge-base` (`3c5b2276`, `v3.16.2` of 2026-10-20).

---

## 1. Expedition overview

- **`damian` (fork)**: 48 commits on top of `3c5b2276`, touching **107 files** (34 created `[A]` and 73 modified `[M]`).
- **`upstream/main` (`v3.17.1`)**: 1 sync commit (`a60ba6a7`) with **5,231 changed files** (`+216,552` / `-611,504` lines).
- **Why did `upstream/main` delete ~611k lines?**
  On 2026-10-26 Z.ai applied the policy `docs/testing/unit-test-quality.md` (*"App 单测退役规格"*, "App unit-test retirement spec"): **they retired every business unit test in the App (`packages/*/test/*.test.ts` and `contract.test.ts`, ~1,800 files)** and removed `@testing-library/react` and `@testing-library/dom` from `packages/ui/package.json` and `pnpm-lock.yaml`.
  - At the root (`vitest.config.ts`) they left only the `engineering` project (a closed list of 141 files in `scripts/engineering-test-files.json`) and `packages/zcode-cua`.
  - **Important**: the **`apps/zcode-cli` suite was NOT retired**; it remains intact with its own `apps/zcode-cli/vitest.config.ts`.

Crossing the fork's **107 files** against `upstream/main`, they split exactly into **4 groups**:

| Group | Count | State in a `git merge` |
| :--- | :---: | :--- |
| **Group 1 — `CONFLICT_MM`** (both modified the same lines) | **9 files** | Content conflict (`<<<<<<<`) |
| **Group 2 — `SPECIAL [M / D]`** (the fork edited a test upstream deleted) + 10 new fork tests in `packages/*` | **7 files** (+10) | `modify/delete` conflict + runner loss in `vitest.config.ts` |
| **Group 3 — `CLEAN_3WAY [M / M]`** (both touched the file in different zones) | **28 files** | Merges without a textual conflict, but **there are 2 semantic traps** |
| **Group 4 — `ONLY_OURS`** (only touched/created by the fork) | **63 files** | Merges straight through, but **there are 3 governance/script adjustments** |

---

## 2. Group 1: The 9 Direct Conflicts (`CONFLICT_MM`) — File by File

### 1) `apps/zcode-cli/packages/adapters/tests/runner-retry.test.ts`
- **What the fork has**: 3 tests at the end of `describe("calculateRetryDelay")` validating that `usageLimitResetWaitMs` (`next_flush_time`, Wave 5) skips the 5-minute cap and takes priority over `Retry-After`.
- **What ZCode brings (`v3.17.1`)**: Imports `vi` from `vitest` and adds 2 tests in the same block validating that when `retry.jitter === true`, `Retry-After` gets an upward jitter of up to +20% (cap +5s) to avoid 1302 stampedes.
- **Trade-off (Fork, ZCode or Both?)**: **Both coexist without touching each other**. In `runner-retry.ts` (which merges cleanly), `usageLimitResetWaitMs` returns before evaluating `Retry-After`; moreover, in production the fork runs with `jitter: false` (`ZCODE_MODEL_RETRY_JITTER=0`), while upstream's test forces `jitter: true` locally.
- **Resolution**: Keep `vi` in the import and leave the fork's 3 tests + upstream's 2 tests.

---

### 2) `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/product-projection.ts`
- **What the fork has (Wave 6b)**: In `case "model_retry_scheduled"`, it passes `reasonCode: modelRetryReasonCode(payload.reason)` and adds a raw `reason: payload.reason` (so the v4 pill can distinguish `provider_overloaded`, `server_error` and `usage_limit_reset`).
- **What ZCode brings (`v3.17.1`)**: Changes `reasonCode` to a ternary:
  ```ts
  reasonCode:
    payload.errorCode === ModelErrorCode.ModelRequestVerificationConfigNetwork
      ? ModelErrorCode.ModelRequestVerificationConfigNetwork
      : modelRetryReasonCode(payload.reason),
  ```
  (upstream's new flow for retrying network failures while reading the security/verification configuration before sending the request to the model).
- **Trade-off**: **Both are orthogonal and necessary**. If we pick only the fork, we break `ModelRequestVerificationConfigNetwork` detection in v4; if we pick only upstream, the chat-area pill loses the raw `reason` and collapses causes again.
- **Resolution**: Use upstream's `reasonCode` ternary **and** keep the fork's `reason: payload.reason` underneath.

---

### 3) `architecture-policy.yaml`
- **What the fork has**: 4 exceptions in `exceptions:`:
  - `fork-daemon-local-channel-new-files` (at the start of `exceptions:`)
  - `conversation-verbosity-views-unmanaged-new` (at the end)
  - `fork-model-retry-spawn-env-unmanaged-new` (at the end)
  - `fork-usage-limit-reset-unmanaged-new` (at the end)
- **What ZCode brings (`v3.17.1`)**: 7 new exceptions at the start of `exceptions:` and 12 new exceptions at the end (plus several new `managed: true` modules above that merge cleanly).
- **Extra expedition finding**: `packages/ui/src/v4/forkCommandModel.ts` (created in Wave 2) was not listed in the fork's exceptions; running `architecture:check --changed` against `3c5b2276` fails with `unmanaged-new-file`.
- **Trade-off**: **Keep every entry from both sides**.
- **Resolution**: Union upstream's and the fork's `exceptions:` lists, and add `packages/ui/src/v4/forkCommandModel.ts` to the fork's exceptions.

---

### 4) `packages/ui/src/SlashCommandPlugin.tsx`
- **What the fork has (Wave 2)**: Inverts the precedence between App commands (`appCommands`) and CLI catalog commands (`commands`): it computes `appValues = new Set(appSuggestions.map(i => i.value))` and filters `cliSuggestions` with `!appValues.has(item.value)`. That way the fork's client-side `/diff` eclipses the CLI's `/diff` (which burned a model turn).
- **What ZCode brings (`v3.17.1`)**: Adds support for a `recovery?: boolean` flag in `AppSlashCommand` (used by the new `/reload` command), and only lets commands with `recovery: true` (`recoveryNames`) eclipse the CLI (`!recoveryNames.has(item.value)`).
- **Trade-off**: The fork's rule (`!appValues.has(item.value)`) **is an exact superset** of upstream's (`recoveryNames ⊆ appValues`). Since `/side` and `/btw` are already pre-filtered in `SessionPane.tsx` when they exist in `cliSlashCommandNames`, making every visible `appCommand` eclipse CLI homonyms makes **both `/diff` (fork) and `/reload` (upstream)** work.
- **Resolution**: Keep the fork's precedence (`!appValues.has(item.value)`).

---

### 5) `packages/ui/src/chat-input-toolbar/display.tsx`
- **What the fork has (Wave 4b/6)**: In `ChatApiRetryStatus`, it uses `{ id: apiRetryStatusMessageId(apiRetry.reason) }` (honest labels per cause) and renders the `mm:ss` countdown next to it (`useRetryCountdown(apiRetry?.nextRetryAtMs)`).
- **What ZCode brings (`v3.17.1`)**: Imports `zcodeProviderRuntimeHeadersErrorCode` and, when `apiRetry.error === zcodeProviderRuntimeHeadersErrorCode.configNetwork`, shows the message `"chat.configReadRetryStatus"` (*retrying configuration read*).
- **Trade-off**: **Make both work**. If a retry is due to `configNetwork` (a failure before the model request), `"chat.configReadRetryStatus"` must be shown; for every other case the fork's `API_RETRY_REASON_MESSAGE_IDS` table + the countdown must keep applying.
- **Resolution**:
  1. Keep upstream's `zcodeProviderRuntimeHeadersErrorCode` import.
  2. Add `[zcodeProviderRuntimeHeadersErrorCode.configNetwork]: "chat.configReadRetryStatus"` to `API_RETRY_REASON_MESSAGE_IDS` and, in `ChatApiRetryStatus`, pass `apiRetry.error === zcodeProviderRuntimeHeadersErrorCode.configNetwork ? zcodeProviderRuntimeHeadersErrorCode.configNetwork : apiRetry.reason` to `apiRetryStatusMessageId(...)`, leaving `countdownLabel` untouched.

---

### 6) `packages/ui/src/v4/ConversationTimeline.tsx` *(coupled with #9)*
- **What the fork has (Verbosity wave)**: Extracts `messageStreamVerbosity` and `messageStreamExpandedByDefault` from `rowContext` and passes them to `buildConversationTurnRenderUnits(rows, { ... })`.
- **What ZCode brings (`v3.17.1`)**: Replaces `buildConversationTurnRenderUnits(rows, ...)` + `withTopicPreparationMessages` with the new partitioned pipeline `rowsPartition = getConversationRowsPartition(rows)` → `selectRenderUnits = createConversationTurnRenderUnitsSelector()` → `withTopicPreparationUnits(selectRenderUnits(rowsPartition, { ... }))`, which returns `{ history, tail }` and avoids recomputing the whole history on every streaming token.
- **Trade-off**: **Both are indispensable**. We cannot stay with `buildConversationTurnRenderUnits` in `ConversationTimeline.tsx` because the rest of the component in `v3.17.1` consumes the `{ history, tail }` partition and because the performance win on long conversations is huge; and we cannot lose `verbosity` / `expandAllByDefault`.
- **Resolution**: Use `withTopicPreparationUnits(selectRenderUnits(rowsPartition, { nowMs: liveNowMs, sessionPhase, pluginUiPinResolver, ...(messageStreamVerbosity ? { verbosity: messageStreamVerbosity } : {}), ...(messageStreamExpandedByDefault ? { expandAllByDefault: true } : {}) }), rows, topicPreparations)` and include every dependency in the `useMemo`. *(See #9 for cache invalidation inside the selector).*

---

### 7) `packages/ui/src/v4/ConversationTurnGroup.tsx`
- **What the fork has (Verbosity wave)**:
  - It separates `assistantHistoryLockedOpen` (a diagnostic fact: turn running, failure/interruption, or a 1-segment turn without final text → **locked open**) from `assistantHistoryDefaultOpen` (user preference `verbose` / `expandAllByDefault` → **opens by default but can be closed manually**):
    ```ts
    const historyLockedOpen =
      segment.assistantHistoryLockedOpen ?? segment.assistantHistoryDefaultOpen;
    const open = historyLockedOpen || historyOpen;
    // ...
    onOpenChange={historyLockedOpen ? undefined : setHistoryOpen}
    ```
- **What ZCode brings (`v3.17.1`)**:
  - It passes `turnRunning={unit.isRunning}` to `ConversationWorkSegmentFlow` and writes:
    ```ts
    const open = turnRunning || segment.assistantHistoryDefaultOpen || historyOpen;
    // ...
    onOpenChange={turnRunning || segment.assistantHistoryDefaultOpen ? undefined : setHistoryOpen}
    ```
- **Trade-off**: If we used upstream's line as-is (`turnRunning || segment.assistantHistoryDefaultOpen ? undefined : setHistoryOpen`), when the user turns on `Verbose` or `Expand all` (`assistantHistoryDefaultOpen = true`, `assistantHistoryLockedOpen = false`), **`onOpenChange` would stay `undefined` and no historical turn could be collapsed manually**, breaking the fork's spec (`docs/specs/conversation-verbosity-views.md` §2).
- **Resolution**: Combine both concepts:
  ```ts
  const historyLockedOpen =
    turnRunning || (segment.assistantHistoryLockedOpen ?? segment.assistantHistoryDefaultOpen);
  const open = historyLockedOpen || historyOpen;
  // ...
  onOpenChange={historyLockedOpen ? undefined : setHistoryOpen}
  ```
  That way `turnRunning` locks open (as upstream asks) and `assistantHistoryLockedOpen` distinguishes diagnostic lock from preference-driven opening (as the fork asks).

---

### 8) `packages/ui/src/v4/SessionPane.tsx`
- **What the fork has (Wave 2)**:
  - In `appSlashCommands`, it defines `diffAction` (client-side `/diff` when `sessionId && !compactForRemoteControl`) and builds `baseActions = diffAction ? [planAction, diffAction] : [planAction]`.
  - In `planAction`, it had `label: intl.formatMessage({ id: "chat.slash.app.plan.label" })`.
- **What ZCode brings (`v3.17.1`)**:
  - Deletes the i18n key `"chat.slash.app.plan.label"` from `en-US.ts` and `zh-CN.ts` and removes `label` from `planAction`.
  - Adds `reloadActions` (`/reload` with `recovery: true` → `taskRestart.restart`).
- **Trade-off**: **Both commands (`/reload` and `/diff`) must be available**, and we must remove `label` from `planAction` because the i18n key no longer exists in the `v3.17.1` dictionaries.
- **Resolution**:
  - Remove `label` from `planAction`.
  - Define `const baseActions = [...reloadActions, planAction, ...(diffAction ? [diffAction] : [])];` and return `baseActions` (or `[...baseActions, ...sideCommands]`).
  - In the `useMemo` dependency array, keep both `taskRestart.restart` (upstream) and `openDiffAskPanel` and `compactForRemoteControl` (fork).

---

### 9) `packages/ui/src/v4/conversationTurnRenderUnits.ts` *(extra care here!)*
- **What the fork has (Verbosity wave)**:
  - In `materializeDraftUnit` and `normalizeRenderUnitPosition`, it computes `assistantHistoryDefaultOpen` and `assistantHistoryLockedOpen` through `resolveAssistantHistoryOpenState(...)` reading `options.verbosity` and `options.expandAllByDefault`.
- **What ZCode brings (`v3.17.1`)**:
  1. In `normalizeRenderUnitPosition`, it avoids doing `unit.workSegments?.map(...)` before the `if (...) return unit;` so as not to allocate arrays on every frame when nothing changed.
  2. It adds `createConversationTurnRenderUnitsSelector()`, which caches the units of `partition.history` and of each `DraftTurnRenderUnit`.
- **Semantic trap detected in the expedition**:
  Upstream's new `createConversationTurnRenderUnitsSelector()` decides whether to reuse the cache (`isHistoryReusable`, `materializeReusing` and `history.tailDropped`) by looking only at `rows`, `sessionPhase`, `nowMs` and `pluginUiPinResolver`. **It does not look at `options.verbosity` or `options.expandAllByDefault`**. If we do not add those two fields to the selector's reuse conditions, changing verbosity or the "Expand all" switch live **would not update the already-cached historical turns**.
- **Resolution (Both + verbosity-aware cache)**:
  1. In `normalizeRenderUnitPosition`: compute `unitOpenState` and `lastSegmentOpenState` with `resolveAssistantHistoryOpenState(...)` **before** the `if (...) return unit;` without cloning `workSegments`, and only do `.map(...)` after the `if` when `isLastTurn`, `defaultOpen` or `lockedOpen` actually changed.
  2. In `createConversationTurnRenderUnitsSelector()`: store `verbosity` and `expandAllByDefault` in `Entry`, `HistoryCache` and `history.tailDropped`, and include them in `unchanged` and in `isHistoryReusable`.

---

## 3. Group 2: The 7 `modify/delete` Conflicts (`SPECIAL [M / D]`) and the Fork's Test Suite

Since Z.ai deleted every unit test in `packages/{ui,services,shared,desktop}/test/` in `v3.17.1`, we have:
- **7 files in a `modify/delete` conflict (`[M / D]`)** (upstream tests the fork had extended):
  1. `packages/desktop/test/desktopRuntimeEnv.test.ts` (Wave 8: `production` → `alwaysOn`)
  2. `packages/services/test/highspeedCardService.test.ts` (Wave 3: 502 retry `[1s, 3s]` + `draw-miss` inside budget)
  3. `packages/services/test/zcodeStdioTransport.test.ts` (2026-10-30 fix: a throwing listener does not kill the stdio transport)
  4. `packages/shared/test/appSettings.test.ts` (Verbosity wave: `messageStreamVerbosity` / `messageStreamExpandedByDefault` schema)
  5. `packages/ui/test/v4ConversationTurnRenderUnits.test.ts` (Verbosity wave: 7 tests for `summary`/`normal`/`verbose` + `lockedOpen`)
  6. `packages/ui/test/useUiPluginRecommendations.test.ts` (Wave 1: Diff Ask card prepended)
  7. `packages/ui/test/v4ConversationStatusPanelGitReview.test.ts` (Wave 1: Changes button → Diff Ask)
- **10 test files created by the fork (`[A / -]`) in `packages/*`**:
  - In `services`: `daemonChannel.test.ts` (**30 tests for the B3a channel**), `forkModelRetrySpawnEnv.test.ts`, `subagentLaunchAck.test.ts`.
    *(Careful: `daemonChannel.test.ts` imports `./botsService.fixtures.js`, which upstream deleted because the fork had not touched it; if we keep `daemonChannel.test.ts`, we must keep `packages/services/test/botsService.fixtures.ts` too).*
  - In `shared`: `zcodeApiRetryStatus.test.ts`, `zcodeSessionEventTolerance.test.ts`.
  - In `ui`: `chatApiRetryCountdown.test.ts`, `conversationExpandDefaultStore.test.ts`, `forkCommandModel.test.ts`, `reasoningExpandDefault.test.ts`, `toolLayoutDefaultOpen.test.ts`.
- *(Reminder: the fork's 9 test files inside `apps/zcode-cli/` **keep working unchanged** because the CLI did not retire its tests).*

### The options and their trade-off for the `packages/*` tests:

#### Option A (Recommended): Keep the fork's 17 tests under a dedicated `vitest.fork.config.ts`
- **How it works**:
  - We accept the deletion of upstream's ~1,800 tests (we do not maintain other people's tests that Z.ai abandoned).
  - We keep the **17 test files that exercise the fork's own features** (the 10 `[A]` + the 7 `[M/D]` + `packages/services/test/botsService.fixtures.ts`).
  - We leave `vitest.config.ts` and `scripts/engineering-test-files.json` **100% identical to upstream** (so upstream's `pnpm test:architecture` and `pnpm test:engineering-tools` gates pass without friction), and we create a new fork file `vitest.fork.config.ts` that includes only the fork's 17 tests.
  - We update `scripts/sync-upstream.nu` to run `vitest run -c vitest.fork.config.ts`.
- **Sub-decision about `@testing-library/react` (5 of the 17 tests)**:
  Upstream removed `@testing-library/react` and `@testing-library/dom` from `packages/ui/package.json` and `pnpm-lock.yaml`. Five of the fork's UI tests (`chatApiRetryCountdown`, `reasoningExpandDefault`, `toolLayoutDefaultOpen`, `useUiPluginRecommendations`, `v4ConversationStatusPanelGitReview`) import it:
  - **Variant A1 (clean going forward — recommended)**: Replace the `@testing-library/react` helper in those 5 files with a small local helper using `createRoot` from `react-dom/client` + `act` from `react` (using `jsdom`, which **does** stay in upstream's root `package.json`). **Huge advantage**: `packages/ui/package.json` and `pnpm-lock.yaml` (30,000+ lines) stay **100% identical to upstream** and will never conflict in future syncs.
  - **Variant A2**: Re-add `@testing-library/react` and `@testing-library/dom` to `packages/ui/package.json` and run `pnpm install`. **Disadvantage**: `pnpm-lock.yaml` ends up modified in the fork and will conflict on every future sync.

#### Option B: Follow upstream's doctrine 100% in `packages/*`, or keep only the 12 tests without DOM
- Keep only the fork's 12 tests that do not use `@testing-library/react` (including the 30 critical tests in `daemonChannel.test.ts`, `zcodeSessionEventTolerance.test.ts`, `v4ConversationTurnRenderUnits.test.ts`, `forkCommandModel.test.ts`, `highspeedCardService.test.ts`, etc.) and retire the 5 that mounted DOM with `@testing-library/react`.

---

## 4. Group 3: The 28 `CLEAN_3WAY [M / M]` Files (Audited Automatic Merges)

I reviewed both sides' diffs in the **28 files** where Git does the 3-way merge without textual conflicts.
- **26 of the 28 files are 100% semantically compatible** (for example: `.husky/pre-push`, `failure-classifier.ts`, `model-execution.ts`, `runner-generate.ts`, `runner-retry.ts`, `runner-stream.ts`, `runner.test.ts`, `contracts/src/model/index.ts`, `turn-model-step.ts`, `runtime-stream-recovery.test.ts`, `node.ts`, `zcodeAgentService.ts`, `zcodeTaskServiceAdapter.ts`, `shared/src/*`, `SettingsPage.tsx`, `en-US.ts`, `zh-CN.ts`, `ConversationRowView.tsx`, `V4ComposerToolbar.tsx`, `conversationTurnRenderUnitTypes.ts`, `conversationTurnWorkSegments.ts`).
- **2 semantic details detected when crossing `CLEAN_3WAY` with `CONFLICT_MM`**:
  1. In `packages/ui/src/v4/ConversationTurnGroup.tsx`:
     - In `TurnChatLoadingSlot`: upstream changed the visibility condition to `apiRetry?.reasonCode === zcodeProviderRuntimeHeadersErrorCode.configNetwork || retryStatus.attempt >= MIN_VISIBLE_API_RETRY_ATTEMPT`. With the fork's `MIN_VISIBLE_API_RETRY_ATTEMPT = 1` (Wave 7), both branches are satisfied from attempt 1/10.
     - In `ConversationBackgroundResultWork`: upstream wrapped the background-result block in a `<Collapsible>` building a `historySegment: ConversationTurnWorkSegment`. It is worth also passing `...(unit.assistantHistoryLockedOpen !== undefined ? { assistantHistoryLockedOpen: unit.assistantHistoryLockedOpen } : {})` in that `historySegment` so the `AssistantHistoryStatus` chevron behaves like it does in normal turns.
  2. In `packages/ui/src/v4/SessionPane.tsx`:
     - Upstream introduced `modelSelectionDisplayView` for render props (while keeping `modelSelectionView` for send operations). In our `resolveCommandModelSelection` block (Wave 2, inside `dispatchSendTextAfterConfig`), we still use `view: modelSelectionView` (which still exists in scope and is already in the `useCallback` dependency array), so it compiles and works unchanged.

---

## 5. Group 4: The 63 `ONLY_OURS` Files — 3 Hygiene and Governance Adjustments

Although these 63 files do not conflict with upstream, the expedition detected **3 points** we must adjust when closing the merge so that all the gates (`pnpm lint`, `pnpm typecheck`, `pnpm architecture:check --changed`) pass green:

1. **`packages/services/src/bots/daemonChannel.ts` currently exceeds `oxlint`'s 800-line limit**:
   - After the `respond` (`6993d7e8`) and `steer` (`7ae1a972`) commits, `daemonChannel.ts` sits at 1,019 effective lines (max 800 in `.oxlintrc.json`) and has an unused imported `type ZCodePermissionResponse`, making `pnpm lint` fail today with 1 error and 1 warning.
   - **Solution**: remove the unused `ZCodePermissionResponse` import and add `/* oxlint-disable eslint(max-lines) -- ... */` at the top of `daemonChannel.ts` (or extract the `respond`/`steer` handlers next to `daemonChannelModelSelection.ts`), exactly like `botsService.ts`, `zcodeAgentService.ts` and `node.ts`.
2. **`packages/ui/test/chatApiRetryCountdown.test.ts`**:
   - It has an `oxlint` warning for an unused `import type { ApiRetryState } from "@zcode/shared"`; worth cleaning up.
3. **`scripts/sync-upstream.nu`**:
   - On line 42 it runs `packages/ui/test/useRecommendedUiPlugins.test.ts` (deleted by upstream) without `-c vitest.fork.config.ts`. We will update it to run the fork suite with the new configuration.

---

## 6. Step-by-Step Execution Plan (for when we switch to Build mode)

1. **Fetch & merge without commit (`git merge --no-commit upstream/main`)** on `damian`.
2. **Resolve the 9 `CONFLICT_MM` conflicts** by applying the exact merges from **Point 2** (including the `verbosity`/`expandAllByDefault` cache invalidation in `createConversationTurnRenderUnitsSelector`).
3. **Resolve the 7 `SPECIAL [M / D]` conflicts + `botsService.fixtures.ts`** according to the option you pick in **Point 3** and create `vitest.fork.config.ts`.
4. **Apply the 3 hygiene adjustments from Point 5** (`daemonChannel.ts` lint, `forkCommandModel.ts` in `architecture-policy.yaml`, and `scripts/sync-upstream.nu`).
5. **Run the full verification battery**:
   - `pnpm typecheck` (root)
   - `tsc --noEmit` in `apps/zcode-cli/packages/{contracts,adapters,core,bootstrap,tui,i18n}`
   - `pnpm lint` (`oxlint`, 0 errors)
   - `pnpm architecture:check --changed` and `pnpm test:architecture`
   - CLI Vitest suites (`apps/zcode-cli`: `runner-retry`, `runner`, `failure-classifier`, `failure-usage-limit-reset`, `runner-usage-limit-segments`, `live-cot-tap`, `skills`, `runtime-stream-recovery`, `tui-network-retry-copy`)
   - Fork Vitest suites (`vitest.fork.config.ts`: `daemonChannel`, `zcodeStdioTransport`, `highspeedCardService`, `v4ConversationTurnRenderUnits`, etc.)
6. **Merge commit + ledger update in `FORK.md`** (ready for `build-install.nu`).

---

### Question to settle before executing

For **Group 2 (the fork's tests in `packages/*` after upstream's App unit-test retirement)**, do we confirm going with **Option A1** (keep the fork's own 17 tests + `botsService.fixtures.ts` under `vitest.fork.config.ts`, and move the 5 UI tests to `react-dom/client` to keep `packages/ui/package.json` and `pnpm-lock.yaml` **100% identical to upstream**)?

---

## Appendix A — the full expedition command trail

Every tool invocation, in session order (full outputs live in the raw archive):

     1	**`shell`** `git status -sb && git remote -v && git branch -a`
     2	**`shell`** `git log -n 5 --oneline --decorate damian && git log -n 5 --oneline --decorate main && git log -n 5 --oneline --decorate upstream/main && git rev-list --left-right --count damian...upstream/main`
     3	**`shell`** `git log -n 3 --format="%ci %h %s" upstream/main && git ls-remote upstream refs/heads/main refs/tags/*`
     4	**`shell`** `git ls-remote upstream refs/heads/main 'refs/tags/*'`
     5	**`shell`** `git diff --name-status 3c5b2276..damian`
     6	**`shell`** `git diff --stat 3c5b2276..upstream/main | tail -n 5 && comm -12 <(git diff --name-only 3c5b2276..damian | sort) <(git diff --name-only 3c5b2276..upstream/main | sort)`
     7	**`read`** `FORK.md`
     8	**`read`** `docs/fork/ARCHITECTURE.md`
     9	**`read`** `scripts/sync-upstream.nu`
    10	**`read`** `docs/fork/DAEMON-CHANNEL.md`
    11	**`read`** `docs/fork/TESTING.md`
    12	**`shell`** `git log --oneline 3c5b2276..damian`
    13	**`shell`** `python3 -c ' ⏎ import subprocess, tempfile, os ⏎  ⏎ base = "3c5b2276" ⏎ ours = "damian" ⏎ theirs = "upstream/main" ⏎  ⏎ def get_status(rev_range): ⏎     out = subprocess.check_output(["git", "diff", "--no-renames", "--name-status", rev_range], text=True) ⏎     res = {} ⏎     for line in out.strip().splitlines(): ⏎         if not line: continue ⏎         st, path = line.split("\t", 1) ⏎         res[path] = st ⏎     return res ⏎  ⏎ ours_st = get_status(f"{base}..{ours}") ⏎ theirs_st = get_status(f"{base}..{theirs}") ⏎  ⏎ for path, ost in sorted(ours_st.items()): ⏎     tst = theirs_st.get(path, "-") ⏎     if tst == "-": ⏎         print(f"ONLY_OURS  [{ost} / -] {path}") ⏎     else: ⏎         # Check if 3-way merge-file cleanly merges or conflicts ⏎         if ost == "M" and tst == "M": ⏎             with tempfile.TemporaryDirectory(dir="/private/var/folders/mt/6n_kh76x031gg9r6hx0y_nmr0000gn/T/opencode") as d: ⏎                 for name, rev in [("base", base), ("ours", ours), ("theirs", theirs)]: ⏎                     blob = subprocess.check_output(["git", "show", f"{rev}:{path}"]) ⏎                     with open(os.path.join(d, name), "wb") as f: ⏎                         f.write(blob) ⏎                 rc = subprocess.call(["git", "merge-file", "-q", os.path.join(d, "ours"), os.path.join(d, "base"), os.path.join(d, "theirs")]) ⏎                 state = "CONFLICT_MM" if rc != 0 else "CLEAN_3WAY " ⏎                 print(f"{state} [{ost} / {tst}] {path}") ⏎         else: ⏎             print(f"SPECIAL    [{ost} / {tst}] {path}") ⏎ '`
    14	**`shell`** `git diff --dirstat=files,1 3c5b2276..upstream/main && git diff --diff-filter=D --name-only 3c5b2276..upstream/main | cut -d/ -f1-3 | sort | uniq -c | sort -nr | head -n 30`
    15	**`shell`** `git show upstream/main:vitest.config.ts && git show upstream/main:package.json`
    16	**`shell`** `git show upstream/main:scripts/engineering-test-files.json && git show upstream/main:scripts/test/retired-app-unit-evidence.test.mjs && git show upstream/main:AGENTS.md`
    17	**`shell`** `git show upstream/main:docs/testing/unit-test-quality.md && git show upstream/main:scripts/lib/retired-app-unit-evidence.mjs`
    18	**`shell`** `git show upstream/main:scripts/test/architecture-governance.test.mjs upstream/main:scripts/test/architecture-upstream-admission.test.mjs upstream/main:scripts/test/source-size-policy.test.mjs`
    19	**`shell`** `git show upstream/main:.oxlintrc.json && wc -l $(git diff --name-only 3c5b2276..damian) | sort -nr | head -n 30`
    20	**`shell`** `git diff 3c5b2276..upstream/main -- .oxlintrc.json && npx oxlint packages/services/src/bots/daemonChannel.ts`
    21	**`shell`** `pnpm lint`
    22	**`shell`** `head -n 5 packages/services/src/bots/botsService.ts`
    23	**`shell`** `git grep max-lines`
    24	**`shell`** `python3 -c ' ⏎ import subprocess, tempfile, os ⏎  ⏎ base = "3c5b2276" ⏎ ours = "damian" ⏎ theirs = "upstream/main" ⏎  ⏎ conflicts = [ ⏎     "apps/zcode-cli/packages/adapters/tests/runner-retry.test.ts", ⏎     "apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/product-projection.ts", ⏎     "architecture-policy.yaml", ⏎     "packages/ui/src/SlashCommandPlugin.tsx", ⏎     "packages/ui/src/chat-input-toolbar/display.tsx", ⏎     "packages/ui/src/v4/ConversationTimeline.tsx", ⏎     "packages/ui/src/v4/ConversationTurnGroup.tsx", ⏎     "packages/ui/src/v4/SessionPane.tsx", ⏎     "packages/ui/src/v4/conversationTurnRenderUnits.ts", ⏎ ] ⏎  ⏎ with tempfile.TemporaryDirectory(dir="/private/var/folders/mt/6n_kh76x031gg9r6hx0y_nmr0000gn/T/opencode") as d: ⏎     for path in conflicts: ⏎         for name, rev in [("base", base), ("ours", ours), ("theirs", theirs)]: ⏎             blob = subprocess.check_output(["git", "show", f"{rev}:{path}"]) ⏎             with open(os.path.join(d, name), "wb") as f: ⏎                 f.write(blob) ⏎         p = subprocess.run( ⏎             ["git", "merge-file", "-p", "-L", "damian (fork)", "-L", "base (3c5b2276)", "-L", "upstream/main (v3.17.1)", ⏎              os.path.join(d, "ours"), os.path.join(d, "base"), os.path.join(d, "theirs")], ⏎              text=True, capture_output=True ⏎         ) ⏎         lines = p.stdout.splitlines() ⏎         print(f"=== FILE: {path} (exit={p.returncode}) ===") ⏎         in_conflict = False ⏎         start_idx = 0 ⏎         for i, line in enumerate(lines): ⏎             if line.startswith("<<<<<<< "): ⏎                 in_conflict = True ⏎                 start_idx = max(0, i - 5) ⏎                 for ctx in lines[start_idx:i]: ⏎                     print(f"  {ctx}") ⏎             if in_conflict: ⏎                 print(f"! {line}") ⏎             if line.startswith(">>>>>>> "): ⏎                 in_conflict = False ⏎                 for ctx in lines[i+1:min(len(lines), i+6)]: ⏎                     print(f"  {ctx}") ⏎                 print("---") ⏎ '`
    25	**`shell`** `python3 -c ' ⏎ import subprocess ⏎  ⏎ base = "3c5b2276" ⏎ ours = "damian" ⏎ theirs = "upstream/main" ⏎  ⏎ conflicts = [ ⏎     "apps/zcode-cli/packages/adapters/tests/runner-retry.test.ts", ⏎     "apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/product-projection.ts", ⏎     "packages/ui/src/SlashCommandPlugin.tsx", ⏎     "packages/ui/src/chat-input-toolbar/display.tsx", ⏎     "packages/ui/src/v4/ConversationTimeline.tsx", ⏎     "packages/ui/src/v4/ConversationTurnGroup.tsx", ⏎     "packages/ui/src/v4/SessionPane.tsx", ⏎     "packages/ui/src/v4/conversationTurnRenderUnits.ts", ⏎ ] ⏎  ⏎ for path in conflicts: ⏎     print("=================================================================") ⏎     print(f"FILE: {path}") ⏎     print("--- OURS (3c5b2276..damian) ---") ⏎     print(subprocess.check_output(["git", "diff", "-U5", f"{base}..{ours}", "--", path], text=True)) ⏎     print("--- THEIRS (3c5b2276..upstream/main) ---") ⏎     print(subprocess.check_output(["git", "diff", "-U5", f"{base}..{theirs}", "--", path], text=True)) ⏎ '`
    26	**`read`** `/Users/lattenero/.local/share/opencode/shell/3ebe6d6e5e37c395ae3004215621a1339add6036/sh_19c94a0c2002A4LCDQOYakUFRD.out`
    27	**`read`** `/Users/lattenero/.local/share/opencode/shell/3ebe6d6e5e37c395ae3004215621a1339add6036/sh_19c94a0c2002A4LCDQOYakUFRD.out`
    28	**`shell`** `python3 -c ' ⏎ import subprocess ⏎  ⏎ base = "3c5b2276" ⏎ ours = "damian" ⏎ theirs = "upstream/main" ⏎  ⏎ clean_files = [ ⏎     ".husky/pre-push", ⏎     "apps/zcode-cli/packages/adapters/src/model/failure-classifier.ts", ⏎     "apps/zcode-cli/packages/adapters/src/model/model-execution.ts", ⏎     "apps/zcode-cli/packages/adapters/src/model/runner-generate.ts", ⏎     "apps/zcode-cli/packages/adapters/src/model/runner-retry.ts", ⏎     "apps/zcode-cli/packages/adapters/src/model/runner-stream.ts", ⏎     "apps/zcode-cli/packages/adapters/tests/runner.test.ts", ⏎     "apps/zcode-cli/packages/contracts/src/model/index.ts", ⏎     "apps/zcode-cli/packages/core/src/runtime/methods/turn-model-step.ts", ⏎     "apps/zcode-cli/packages/core/tests/runtime-stream-recovery.test.ts", ⏎     "docs/highspeed/highspeed-card-spec.md", ⏎     "packages/services/src/node.ts", ⏎     "packages/services/src/zcode-agent/zcodeAgentService.ts", ⏎     "packages/services/src/zcode-agent/zcodeTaskServiceAdapter.ts", ⏎     "packages/shared/src/index.ts", ⏎     "packages/shared/src/protocol.ts", ⏎     "packages/shared/src/test-ids.ts", ⏎     "packages/shared/src/validationAppSettings.ts", ⏎     "packages/shared/src/zcode-protocol-legacy-types.ts", ⏎     "packages/shared/src/zcode-protocol-v4/snapshot.ts", ⏎     "packages/shared/src/zcode-protocol/index.ts", ⏎     "packages/ui/src/SettingsPage.tsx", ⏎     "packages/ui/src/i18n/locales/en-US.ts", ⏎     "packages/ui/src/i18n/locales/zh-CN.ts", ⏎     "packages/ui/src/v4/ConversationRowView.tsx", ⏎     "packages/ui/src/v4/composer/V4ComposerToolbar.tsx", ⏎     "packages/ui/src/v4/conversationTurnRenderUnitTypes.ts", ⏎     "packages/ui/src/v4/conversationTurnWorkSegments.ts", ⏎ ] ⏎  ⏎ for path in clean_files[:14]: ⏎     print("=================================================================") ⏎     print(f"CLEAN_3WAY FILE: {path}") ⏎     print("--- OURS (3c5b2276..damian) ---") ⏎     print(subprocess.check_output(["git", "diff", "-U3", f"{base}..{ours}", "--", path], text=True)) ⏎     print("--- THEIRS (3c5b2276..upstream/main) ---") ⏎     print(subprocess.check_output(["git", "diff", "-U3", f"{base}..{theirs}", "--", path], text=True)) ⏎ '`
    29	**`read`** `/Users/lattenero/.local/share/opencode/shell/3ebe6d6e5e37c395ae3004215621a1339add6036/sh_19c95170f001eVJSKeGPR01x0p.out`
    30	**`read`** `/Users/lattenero/.local/share/opencode/shell/3ebe6d6e5e37c395ae3004215621a1339add6036/sh_19c95170f001eVJSKeGPR01x0p.out`
    31	**`read`** `/Users/lattenero/.local/share/opencode/shell/3ebe6d6e5e37c395ae3004215621a1339add6036/sh_19c95170f001eVJSKeGPR01x0p.out`
    32	**`shell`** `python3 -c ' ⏎ import subprocess ⏎  ⏎ base = "3c5b2276" ⏎ ours = "damian" ⏎ theirs = "upstream/main" ⏎  ⏎ clean_files_2 = [ ⏎     "packages/shared/src/index.ts", ⏎     "packages/shared/src/protocol.ts", ⏎     "packages/shared/src/test-ids.ts", ⏎     "packages/shared/src/validationAppSettings.ts", ⏎     "packages/shared/src/zcode-protocol-legacy-types.ts", ⏎     "packages/shared/src/zcode-protocol-v4/snapshot.ts", ⏎     "packages/shared/src/zcode-protocol/index.ts", ⏎     "packages/ui/src/SettingsPage.tsx", ⏎     "packages/ui/src/i18n/locales/en-US.ts", ⏎     "packages/ui/src/i18n/locales/zh-CN.ts", ⏎     "packages/ui/src/v4/ConversationRowView.tsx", ⏎     "packages/ui/src/v4/composer/V4ComposerToolbar.tsx", ⏎     "packages/ui/src/v4/conversationTurnRenderUnitTypes.ts", ⏎     "packages/ui/src/v4/conversationTurnWorkSegments.ts", ⏎ ] ⏎  ⏎ for path in clean_files_2: ⏎     print("=================================================================") ⏎     print(f"CLEAN_3WAY FILE: {path}") ⏎     print("--- OURS (3c5b2276..damian) ---") ⏎     print(subprocess.check_output(["git", "diff", "-U3", f"{base}..{ours}", "--", path], text=True)) ⏎     print("--- THEIRS (3c5b2276..upstream/main) ---") ⏎     print(subprocess.check_output(["git", "diff", "-U3", f"{base}..{theirs}", "--", path], text=True)) ⏎ '`
    33	**`read`** `/Users/lattenero/.local/share/opencode/shell/3ebe6d6e5e37c395ae3004215621a1339add6036/sh_19c956cfc001T7PqvInJFmSrKt.out`
    34	**`read`** `/Users/lattenero/.local/share/opencode/shell/3ebe6d6e5e37c395ae3004215621a1339add6036/sh_19c956cfc001T7PqvInJFmSrKt.out`
    35	**`shell`** `git diff 3c5b2276..upstream/main -- architecture-policy.yaml scripts/architecture/`
    36	**`read`** `/Users/lattenero/.local/share/opencode/shell/3ebe6d6e5e37c395ae3004215621a1339add6036/sh_19c96719e001X0cqM4RI9N462E.out`
    37	**`read`** `/Users/lattenero/.local/share/opencode/shell/3ebe6d6e5e37c395ae3004215621a1339add6036/sh_19c96719e001X0cqM4RI9N462E.out`
    38	**`read`** `/Users/lattenero/.local/share/opencode/shell/3ebe6d6e5e37c395ae3004215621a1339add6036/sh_19c96719e001X0cqM4RI9N462E.out`
    39	**`read`** `scripts/architecture/upstream-admission.mjs`
    40	**`shell`** `head -n 30 scripts/architecture/upstream-snapshot.json && git show upstream/main:scripts/architecture/upstream-snapshot.json | head -n 30`
    41	**`read`** `scripts/architecture/upstream-snapshot.mjs`
    42	**`shell`** `python3 -c ' ⏎ import subprocess, json ⏎  ⏎ snap = json.loads(subprocess.check_output(["git", "show", "upstream/main:scripts/architecture/upstream-snapshot.json"], text=True)) ⏎ introduced = set(snap.get("introduced", [])) ⏎ ours = subprocess.check_output(["git", "diff", "--name-status", "3c5b2276..damian"], text=True).strip().splitlines() ⏎  ⏎ print("--- Fork files that are in upstream-snapshot.json introduced[] ---") ⏎ for line in ours: ⏎     st, path = line.split("\t", 1) ⏎     if path in introduced: ⏎         print(f"  [{st}] {path}") ⏎  ⏎ print("--- Fork files that are Added [A] ---") ⏎ for line in ours: ⏎     st, path = line.split("\t", 1) ⏎     if st == "A": ⏎         print(f"  [{st}] {path}") ⏎ '`
    43	**`shell`** `git diff 3c5b2276..damian -- architecture-policy.yaml`
    44	**`shell`** `node scripts/architecture/architecture-check.mjs check --base 3c5b2276`
    45	**`shell`** `node scripts/architecture/architecture-check.mjs check --changed --base 3c5b2276`
    46	**`read`** `architecture-policy.yaml`
    47	**`read`** `scripts/architecture/index.mjs`
    48	**`shell`** `python3 -c ' ⏎ import subprocess ⏎  ⏎ base = "3c5b2276" ⏎ ours = "damian" ⏎  ⏎ only_ours_m = [ ⏎     ".gitignore", ⏎     "apps/zcode-cli/packages/adapters/src/model/empty-completion-retry.ts", ⏎     "apps/zcode-cli/packages/adapters/src/model/retry-policy.ts", ⏎     "apps/zcode-cli/packages/adapters/src/model/runner-debug.ts", ⏎     "apps/zcode-cli/packages/adapters/src/skills/index.ts", ⏎     "apps/zcode-cli/packages/i18n/src/locales/en-US.ts", ⏎     "apps/zcode-cli/packages/i18n/src/locales/zh-CN.ts", ⏎     "apps/zcode-cli/packages/i18n/src/types.ts", ⏎     "apps/zcode-cli/packages/tui/src/app-network-events.ts", ⏎     "apps/zcode-cli/vitest.config.ts", ⏎     "packages/desktop/src/main/desktopRuntimeEnv.ts", ⏎     "packages/services/src/bots/bots.ts", ⏎     "packages/services/src/bots/botsService.ts", ⏎     "packages/services/src/commands/commandFileParser.ts", ⏎     "packages/services/src/highspeed/highspeedCardService.ts", ⏎     "packages/services/src/highspeed/highspeedHttpTransport.ts", ⏎     "packages/services/src/session/zcodeTaskService.ts", ⏎     "packages/services/src/zcode-agent/zcodeStdioTransport.ts", ⏎     "packages/shared/src/bots.ts", ⏎     "packages/shared/src/command-types.ts", ⏎     "packages/shared/src/zcode-api-retry-status.ts", ⏎     "packages/shared/src/zcode-task-types-core.ts", ⏎     "packages/ui/src/ToolCallBlocks/ToolLayout.tsx", ⏎     "packages/ui/src/lib/userActionTraceCatalog.ts", ⏎     "packages/ui/src/plugin-ui/adapters/useUiPluginRecommendations.ts", ⏎     "packages/ui/src/settingsPageHelpers.tsx", ⏎     "packages/ui/src/v4/ConversationFileSummaryPanel.tsx", ⏎     "packages/ui/src/v4/ConversationStatusPanel.tsx", ⏎     "packages/ui/src/v4/conversationRowContext.ts", ⏎ ] ⏎  ⏎ for path in only_ours_m: ⏎     print("=================================================================") ⏎     print(f"ONLY_OURS [M / -]: {path}") ⏎     print(subprocess.check_output(["git", "diff", "-U2", f"{base}..{ours}", "--", path], text=True)) ⏎ '`
    49	**`shell`** `git diff 3c5b2276..upstream/main -- packages/ui/src/plugin-ui/`
    50	**`read`** `/Users/lattenero/.local/share/opencode/shell/3ebe6d6e5e37c395ae3004215621a1339add6036/sh_19c9bab33001lqvEmigrcfHHV0.out`
    51	**`shell`** `python3 -c ' ⏎ import subprocess ⏎  ⏎ base = "3c5b2276" ⏎ ours = "damian" ⏎  ⏎ md_files = [ ⏎     "packages/desktop/test/desktopRuntimeEnv.test.ts", ⏎     "packages/services/test/highspeedCardService.test.ts", ⏎     "packages/services/test/zcodeStdioTransport.test.ts", ⏎     "packages/shared/test/appSettings.test.ts", ⏎     "packages/ui/test/useUiPluginRecommendations.test.ts", ⏎     "packages/ui/test/v4ConversationStatusPanelGitReview.test.ts", ⏎     "packages/ui/test/v4ConversationTurnRenderUnits.test.ts", ⏎ ] ⏎  ⏎ for path in md_files: ⏎     print("=================================================================") ⏎     print(f"SPECIAL [M / D]: {path}") ⏎     print(subprocess.check_output(["git", "diff", "-U2", f"{base}..{ours}", "--", path], text=True)) ⏎ '`
    52	**`shell`** `python3 -c ' ⏎ import subprocess, re, os ⏎  ⏎ ours_tests = [ ⏎     "packages/desktop/test/desktopRuntimeEnv.test.ts", ⏎     "packages/services/test/highspeedCardService.test.ts", ⏎     "packages/services/test/zcodeStdioTransport.test.ts", ⏎     "packages/shared/test/appSettings.test.ts", ⏎     "packages/ui/test/useUiPluginRecommendations.test.ts", ⏎     "packages/ui/test/v4ConversationStatusPanelGitReview.test.ts", ⏎     "packages/ui/test/v4ConversationTurnRenderUnits.test.ts", ⏎     "packages/services/test/daemonChannel.test.ts", ⏎     "packages/services/test/forkModelRetrySpawnEnv.test.ts", ⏎     "packages/services/test/subagentLaunchAck.test.ts", ⏎     "packages/shared/test/zcodeApiRetryStatus.test.ts", ⏎     "packages/shared/test/zcodeSessionEventTolerance.test.ts", ⏎     "packages/ui/test/chatApiRetryCountdown.test.ts", ⏎     "packages/ui/test/conversationExpandDefaultStore.test.ts", ⏎     "packages/ui/test/forkCommandModel.test.ts", ⏎     "packages/ui/test/reasoningExpandDefault.test.ts", ⏎     "packages/ui/test/toolLayoutDefaultOpen.test.ts", ⏎ ] ⏎  ⏎ upstream_files = set(subprocess.check_output(["git", "ls-tree", "-r", "--name-only", "upstream/main"], text=True).splitlines()) ⏎  ⏎ for t in ours_tests: ⏎     src = subprocess.check_output(["git", "show", f"damian:{t}"], text=True) ⏎     specs = re.findall(r"from\s+[\"'\'']([^\"'\'']+)[\"'\'']|import\(\s*[\"'\'']([^\"'\'']+)[\"'\'']\s*\)", src) ⏎     specs = [a or b for a, b in specs] ⏎     print(f"TEST: {t}") ⏎     for s in specs: ⏎         if s.startswith(".") or s.startswith("@/"): ⏎             if s.startswith("@/"): ⏎                 base_candidate = "packages/ui/src/" + s[2:] ⏎             else: ⏎                 base_candidate = os.path.normpath(os.path.join(os.path.dirname(t), s)) ⏎             stem = re.sub(r"\.(js|mjs|cjs|ts|tsx)$", "", base_candidate) ⏎             found = any(stem + ext in upstream_files for ext in [".ts", ".tsx", ".js", ".mjs", "/index.ts", "/index.tsx"]) ⏎             if not found: ⏎                 print(f"  MISSING IN UPSTREAM: {s} -> {stem}.*") ⏎ '`
    53	**`shell`** `python3 -c ' ⏎ import subprocess, re, os ⏎  ⏎ ours_changed = subprocess.check_output(["git", "diff", "--name-only", "3c5b2276..damian"], text=True).splitlines() ⏎ upstream_files = set(subprocess.check_output(["git", "ls-tree", "-r", "--name-only", "upstream/main"], text=True).splitlines()) ⏎ ours_files = set(subprocess.check_output(["git", "ls-tree", "-r", "--name-only", "damian"], text=True).splitlines()) ⏎ deleted_in_upstream = set(subprocess.check_output(["git", "diff", "--diff-filter=D", "--name-only", "3c5b2276..upstream/main"], text=True).splitlines()) ⏎  ⏎ queue = list(ours_changed) ⏎ visited = set() ⏎  ⏎ while queue: ⏎     f = queue.pop(0) ⏎     if f in visited or not f.endswith((".ts", ".tsx", ".mjs", ".js")): ⏎         continue ⏎     visited.add(f) ⏎     try: ⏎         src = subprocess.check_output(["git", "show", f"damian:{f}"], text=True) ⏎     except Exception: ⏎         continue ⏎     specs = re.findall(r"from\s+[\"'\'']([^\"'\'']+)[\"'\'']|import\(\s*[\"'\'']([^\"'\'']+)[\"'\'']\s*\)", src) ⏎     specs = [a or b for a, b in specs] ⏎     for s in specs: ⏎         base_candidate = None ⏎         if s.startswith("@/"): ⏎             base_candidate = "packages/ui/src/" + s[2:] ⏎         elif s.startswith("#src/"): ⏎             pkg_root = "/".join(f.split("/")[:2]) ⏎             base_candidate = pkg_root + "/src/" + s[5:] ⏎         elif s.startswith("."): ⏎             base_candidate = os.path.normpath(os.path.join(os.path.dirname(f), s)) ⏎         if base_candidate: ⏎             stem = re.sub(r"\.(js|mjs|cjs|ts|tsx)$", "", base_candidate) ⏎             for ext in [".ts", ".tsx", ".js", ".mjs", "/index.ts", "/index.tsx"]: ⏎                 cand = stem + ext ⏎                 if cand in deleted_in_upstream: ⏎                     print(f"DELETED DEPENDENCY: {f} -> {cand}") ⏎                     queue.append(cand) ⏎ '`
    54	**`shell`** `git diff 3c5b2276..upstream/main -- vitest.config.ts 'packages/*/vitest.config.ts' 'packages/*/package.json'`
    55	**`shell`** `git show upstream/main:pnpm-lock.yaml | grep -E "testing-library/(react|dom)" | head -n 10`
    56	**`shell`** `git grep -E "@testing-library/react|react-dom" -- 'packages/*/test/*.test.ts'`
    57	**`shell`** `git grep -E "@testing-library/react|react-dom" -- packages/ui/test/chatApiRetryCountdown.test.ts packages/ui/test/conversationExpandDefaultStore.test.ts packages/ui/test/forkCommandModel.test.ts packages/ui/test/reasoningExpandDefault.test.ts packages/ui/test/toolLayoutDefaultOpen.test.ts packages/ui/test/useUiPluginRecommendations.test.ts packages/ui/test/v4ConversationStatusPanelGitReview.test.ts packages/ui/test/v4ConversationTurnRenderUnits.test.ts`
    58	**`shell`** `git show upstream/main:vitest.setup.ts`
    59	**`shell`** `git diff 3c5b2276..upstream/main -- '**/tsconfig*.json'`
    60	**`shell`** `git show upstream/main:packages/ui/tsconfig.json && git show upstream/main:packages/services/tsconfig.json && git show upstream/main:packages/shared/tsconfig.json && git show upstream/main:packages/desktop/tsconfig.e2e.json`
    61	**`shell`** `git show upstream/main:packages/shared/tsconfig.testing.json`

---

## Decision record — Group 2 test doctrine

**2026-11-02: Option A1 confirmed by the owner.**

When the merge executes:
- Keep all **17 fork test files** + `packages/services/test/botsService.fixtures.ts` (required by `daemonChannel.test.ts`).
- Accept upstream's retirement of the ~1.800 retired App tests; `vitest.config.ts` and `scripts/engineering-test-files.json` stay **100% identical to upstream**.
- Create `vitest.fork.config.ts` covering exactly the fork's tests; point `scripts/sync-upstream.nu` (line 42) at it.
- Migrate the 5 DOM tests (`chatApiRetryCountdown`, `reasoningExpandDefault`, `toolLayoutDefaultOpen`, `useUiPluginRecommendations`, `v4ConversationStatusPanelGitReview`) from `@testing-library/react` to a local `createRoot` (react-dom/client) + `act` helper on jsdom — `packages/ui/package.json` and `pnpm-lock.yaml` stay upstream-identical, zero lockfile conflicts in future syncs.
