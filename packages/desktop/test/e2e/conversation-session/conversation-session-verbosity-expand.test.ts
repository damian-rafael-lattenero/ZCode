import {
  TID_CHAT_REASONING_CONTENT,
  TID_CHAT_REASONING_TRIGGER,
  TID_V4_VERBOSITY_CONTROL,
  TID_V4_VERBOSITY_EXPAND_TOGGLE,
  TID_V4_VERBOSITY_OPTION,
  testId,
} from "@zcode/shared/test-ids";
import type { MessageStreamVerbosity } from "@zcode/shared";
import { clearAppData, readSettings } from "#e2e/helpers/desktop-app";
import { ensureToolCrossProductFullAccessMode } from "#e2e/helpers/conversation-session-tool-cross-product";
import { restartIntoWorkspace } from "#e2e/helpers/model-provider-restart";
import {
  clickV4Stop,
  getV4PaneSnapshot,
  prepareV4ConversationE2E,
  selectV4TaskById,
  sendV4Prompt,
  waitForV4AssistantMessageContaining,
  waitForV4Pane,
  waitForV4TimelineContaining,
} from "#e2e/helpers/v4-conversation";

const CASE_MARKER = "E2E_VERBOSE_EXPAND";
const REPLY_TOKEN = "verbosity-e2e-ok";
const TURN_TIMEOUT_MS = 180_000;

interface ReasoningState {
  contentDisplayed: boolean | null;
  count: number;
  expanded: string | null;
}

describe("Verbosity verbose and Expand everything drive reasoning collapse", () => {
  before(async function () {
    this.timeout(TURN_TIMEOUT_MS);
    await prepareV4ConversationE2E();
  });

  afterEach(async () => {
    await stopIfBusy();
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("picker toggles expand reasoning retroactively and new turns are born expanded", async function () {
    this.timeout(TURN_TIMEOUT_MS);

    // Phase 1 (control): at default verbosity the finished turn collapses into
    // the "Worked for" history group — the reasoning row inside is not mounted.
    await sendV4Prompt(`${CASE_MARKER}_1 default collapse baseline`);
    await waitForV4TimelineContaining(CASE_MARKER);
    await waitForTurnIdle();
    let group = await readLatestHistoryGroupState();
    if (group.count < 1) {
      throw new Error(`no history group rendered: ${JSON.stringify(await collectConversationDiagnostics())}`);
    }
    expect(group.expanded).toBe("false");

    // Phase 2: switch verbosity to verbose through the real picker — the same
    // turn's history group must expand retroactively and the reasoning row
    // inside must be mounted expanded (epoch remount).
    await selectVerbosityThroughPicker("verbose");
    await browser.pause(300);
    group = await readLatestHistoryGroupState();
    expect(group.expanded).toBe("true");
    let state = await readLatestReasoningState();
    expect(state.count).toBeGreaterThanOrEqual(1);
    expect(state.expanded).toBe("true");

    // Phase 3: back to normal — the preference flips off and the group collapses again.
    await selectVerbosityThroughPicker("normal");
    await browser.pause(300);
    group = await readLatestHistoryGroupState();
    expect(group.expanded).toBe("false");

    // Phase 4: tick Expand everything while staying on normal — expands again
    // through the independent checkbox path (the owner's reported state).
    await setExpandEverythingThroughPicker(true);
    await browser.pause(300);
    group = await readLatestHistoryGroupState();
    expect(group.expanded).toBe("true");

    // Phase 5: a fresh turn must be BORN expanded (defaultOpen at mount) and
    // stay expanded after completion (auto-collapse disabled under the preference).
    // A turn born under the preference may render its rows directly without a
    // collapsed-group wrapper, so the born-expanded proof is the reasoning row
    // itself (mounted, expanded, content visible), not a per-turn group count.
    await sendV4Prompt(`${CASE_MARKER}_2 born expanded`);
    await waitForV4TimelineContaining(`${CASE_MARKER}_2`);
    await waitForTurnIdle();
    state = await readLatestReasoningState();
    expect(state.count).toBeGreaterThanOrEqual(1);
    expect(state.expanded).toBe("true");
    expect(state.contentDisplayed).toBe(true);

    // Park the preference at the owner's exact persisted state (verbose + expand
    // everything) so the cold-resume case below boots with it already set.
    await selectVerbosityThroughPicker("verbose");
  });

  it("live running bash card and streaming reasoning stay expanded under the preference", async function () {
    this.timeout(TURN_TIMEOUT_MS);
    // The turn requests a real 12s local Bash run; assert inside that running
    // window (the owner's exact complaint: the live card stays collapsed).
    await ensureToolCrossProductFullAccessMode();
    await selectVerbosityThroughPicker("verbose");
    await setExpandEverythingThroughPicker(true);

    // The live marker is a standalone token (not nested inside CASE_MARKER) so
    // the case-local fixture match needles can distinguish it from plain turns.
    await sendV4Prompt("E2E_VERBOSE_LIVE run sleep and reply");
    await waitForV4TimelineContaining("E2E_VERBOSE_LIVE");
    await browser.waitUntil(
      async () =>
        (await readLatestBashCardState()).count > 0 && (await getV4PaneSnapshot()).canStop,
      {
        timeout: 30000,
        timeoutMsg: `the live bash card did not appear while running: ${JSON.stringify(
          await collectLiveTurnDiagnostics(),
        ).slice(0, 1800)}`,
      },
    );
    const card = await readLatestBashCardState();
    expect(card.expanded).toBe("true");
    const reasoning = await readLatestReasoningState();
    expect(reasoning.count).toBeGreaterThanOrEqual(1);
    expect(reasoning.expanded).toBe("true");
    await waitForTurnIdle();
  });

  it("cold resume with the preference already set reopens the old turn expanded", async function () {
    this.timeout(TURN_TIMEOUT_MS);
    const sessionId = (await getV4PaneSnapshot()).sessionId;
    expect(sessionId).toBeTruthy();

    await restartIntoWorkspace();
    await selectV4TaskById(sessionId!);
    await waitForV4TimelineContaining(CASE_MARKER);
    await browser.pause(300);

    const group = await readLatestHistoryGroupState();
    expect(group.count).toBeGreaterThanOrEqual(1);
    expect(group.expanded).toBe("true");
    const state = await readLatestReasoningState();
    expect(state.count).toBeGreaterThanOrEqual(1);
    expect(state.expanded).toBe("true");
    expect(state.contentDisplayed).toBe(true);
  });
});

async function collectLiveTurnDiagnostics(): Promise<unknown> {
  return browser.execute(() => {
    const toolNames = Array.from(document.querySelectorAll<HTMLElement>("[data-tool-name]")).map(
      (element) => element.getAttribute("data-tool-name") ?? "",
    );
    return {
      canStop: Boolean(document.querySelector('[data-testid="v4-stop"]')),
      timelineTail: document.querySelector('[data-testid="v4-timeline"]')?.innerText.slice(-500),
      toolNames,
    };
  });
}

async function readLatestBashCardState(): Promise<{
  count: number;
  expanded: string | null;
  cardHtml?: string;
  triggerHtml?: string;
}> {
  const state = (await browser.execute(() => {
    const cards = Array.from(document.querySelectorAll<HTMLElement>('[data-tool-name="Bash"]'));
    const last = cards.at(-1);
    const trigger = last?.querySelector<HTMLElement>('[data-testid^="tool-summary-trigger-"]');
    return {
      count: cards.length,
      expanded: trigger?.getAttribute("aria-expanded") ?? null,
      cardHtml: last?.outerHTML.slice(0, 700) ?? "",
      triggerHtml: trigger?.outerHTML.slice(0, 400) ?? "",
    };
  })) as { count: number; expanded: string | null; cardHtml: string; triggerHtml: string };
  if (state.expanded === null && state.count > 0) {
    throw new Error(
      `bash card trigger has no aria-expanded: ${JSON.stringify(state).slice(0, 1200)}`,
    );
  }
  return state;
}

async function waitForTurnIdle(): Promise<void> {
  await browser.waitUntil(async () => !(await getV4PaneSnapshot()).canStop, {
    timeout: TURN_TIMEOUT_MS,
    timeoutMsg: `${CASE_MARKER} turn did not finish`,
  });
  await waitForV4AssistantMessageContaining(REPLY_TOKEN);
}

async function collectConversationDiagnostics(): Promise<unknown> {
  return browser.execute(() => {
    const testIds = Array.from(document.querySelectorAll<HTMLElement>("[data-testid]"))
      .slice(0, 120)
      .map((element) => element.dataset.testid ?? "");
    return {
      bodyTextTail: document.body?.innerText?.slice(-1200) ?? "",
      reasoningCount: document.querySelectorAll("[data-conversation-reasoning]").length,
      testIds,
    };
  });
}

interface HistoryGroupState {
  count: number;
  expanded: string | null;
}

async function readLatestHistoryGroupState(): Promise<HistoryGroupState> {
  return browser.execute(() => {
    const triggers = Array.from(
      document.querySelectorAll<HTMLElement>('[data-testid^="chat-assistant-history-trigger"]'),
    );
    const last = triggers.at(-1);
    return {
      count: triggers.length,
      expanded: last?.getAttribute("aria-expanded") ?? null,
    };
  }) as Promise<HistoryGroupState>;
}

async function readLatestReasoningState(): Promise<ReasoningState> {
  return browser.execute(
    (triggerTestId, contentTestId) => {
      const triggers = Array.from(
        document.querySelectorAll<HTMLElement>(`[data-testid="${triggerTestId}"]`),
      );
      const last = triggers.at(-1);
      const contents = Array.from(
        document.querySelectorAll<HTMLElement>(`[data-testid="${contentTestId}"]`),
      );
      const lastContent = contents.at(-1);
      return {
        contentDisplayed: lastContent ? lastContent.getClientRects().length > 0 : null,
        count: triggers.length,
        expanded: last?.getAttribute("aria-expanded") ?? null,
      };
    },
    TID_CHAT_REASONING_TRIGGER,
    TID_CHAT_REASONING_CONTENT,
  ) as Promise<ReasoningState>;
}

async function openVerbosityMenu() {
  const control = await $(`[data-testid="${TID_V4_VERBOSITY_CONTROL}"]`);
  await control.waitForClickable({ timeout: 15000 });
  if ((await control.getAttribute("aria-expanded")) !== "true") {
    await control.click();
  }
  return control;
}

async function selectVerbosityThroughPicker(mode: MessageStreamVerbosity): Promise<void> {
  const control = await openVerbosityMenu();
  if ((await control.getAttribute("data-verbosity")) === mode) {
    await browser.keys("Escape");
    return;
  }
  // Radix remounts portal menu items on focus/scroll; the click target can vanish
  // between waitForClickable and click. Retry open+click like the upstream helper.
  const optionTestId = testId(TID_V4_VERBOSITY_OPTION, mode);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const clicked = await browser.execute((currentTestId) => {
      const item = document.querySelector<HTMLElement>(`[data-testid="${currentTestId}"]`);
      if (!item) {
        return false;
      }
      item.click();
      return true;
    }, optionTestId);
    if (clicked) {
      await browser.waitUntil(
        async () => (await control.getAttribute("data-verbosity")) === mode,
        {
          timeout: 10000,
          timeoutMsg: `verbosity control did not switch to ${mode}`,
        },
      );
      return;
    }
    await browser.pause(250);
    await openVerbosityMenu();
  }
  throw new Error(`verbosity option ${mode} never appeared in the open menu`);
}

async function setExpandEverythingThroughPicker(enabled: boolean): Promise<void> {
  // The persisted user-scope settings are the source of truth; Radix dropdown
  // checkbox items do not expose aria-checked, so only interact on a mismatch.
  const settings = await readSettings();
  if (Boolean(settings?.messageStreamExpandedByDefault) === enabled) {
    return;
  }
  await openVerbosityMenu();
  const toggle = await $(`[data-testid="${TID_V4_VERBOSITY_EXPAND_TOGGLE}"]`);
  await toggle.waitForClickable({ timeout: 5000 });
  await toggle.click();
  await browser.waitUntil(async () => {
    const next = await readSettings();
    return Boolean(next?.messageStreamExpandedByDefault) === enabled;
  }, {
    timeout: 10000,
    timeoutMsg: `expand-everything setting did not persist to ${enabled}`,
  });
}

async function stopIfBusy(): Promise<void> {
  const snapshot = await getV4PaneSnapshot();
  if (!snapshot.canStop) {
    return;
  }
  await clickV4Stop();
  await waitForV4Pane((nextSnapshot) => !nextSnapshot.canStop, "stop did not end streaming", 30000);
}
