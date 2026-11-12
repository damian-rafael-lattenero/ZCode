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
import {
  clickV4Stop,
  getV4PaneSnapshot,
  prepareV4ConversationE2E,
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
  });
});

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
  const item = await $(`[data-testid="${testId(TID_V4_VERBOSITY_OPTION, mode)}"]`);
  await item.waitForClickable({ timeout: 5000 });
  await item.click();
  await browser.waitUntil(
    async () => (await control.getAttribute("data-verbosity")) === mode,
    {
      timeout: 10000,
      timeoutMsg: `verbosity control did not switch to ${mode}`,
    },
  );
}

async function setExpandEverythingThroughPicker(enabled: boolean): Promise<void> {
  await openVerbosityMenu();
  const toggle = await $(`[data-testid="${TID_V4_VERBOSITY_EXPAND_TOGGLE}"]`);
  await toggle.waitForClickable({ timeout: 5000 });
  const checked = (await toggle.getAttribute("aria-checked")) === "true";
  if (checked !== enabled) {
    await toggle.click();
  } else {
    await browser.keys("Escape");
    return;
  }
  // The Radix menu closes after the click, so confirm through the persisted
  // user-scope settings the picker writes to.
  await browser.waitUntil(async () => {
    const settings = await readSettings();
    return Boolean(settings?.messageStreamExpandedByDefault) === enabled;
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
