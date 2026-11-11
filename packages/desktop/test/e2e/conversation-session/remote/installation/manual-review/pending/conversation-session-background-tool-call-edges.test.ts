// catalog BT02（double-click 幂等 / guard.stopTargetChanged 诚实 noop）+ BT03（按钮可见性边界）。
// 证据层 L3 pending：
// - BT02：同一帧连点两次「Go to background」→ 第一条 accepted、第二条
//   noop(guard.stopTargetChanged)（tool call 已移交，前台记录已不存在），恰好创建一个
//   bash 后台 work；原 turn 正常继续并按单一 wake 收口（无重复通知）。
//   说明：unknown toolCallId 在 UI 上没有可点击表面（按钮只为运行中 Bash 卡渲染），
//   守卫的 unknown-id 分支由 runtime 单测覆盖（runtime-background-tool-call.test.ts /
//   v4-native-background-tool-call.test.ts）；这里覆盖 UI 能构造出的已移交幂等边界。
// - BT03：completed 卡无按钮；非 execute 家族（Read）卡全生命周期无按钮；
//   backgrounded 卡无按钮且 kind 标签缀 `· Background`。
// 运行窗口与 BT 主链路同款：真实 Bash 进程（sleep/echo），免权限走 yolo 前置。
import { TID_V4_TOOL_BACKGROUND, testId } from "@zcode/shared/test-ids";
import { mkdir, writeFile } from "node:fs/promises";
import { clearAppData, clickTestIdByDom } from "#e2e/helpers/desktop-app";
import { ensureToolCrossProductFullAccessMode } from "#e2e/helpers/conversation-session-tool-cross-product";
import {
  countUpstreamRequests,
  waitForUpstreamRequest,
} from "#e2e/helpers/conversation-session-network";
import { resolveE2ERuntimePath } from "#e2e/helpers/e2e-runtime-paths";
import { waitForToolCallBlockByToolCallId } from "#e2e/helpers/conversation-session-tool";
import {
  assertVisibleV4UserMessagesNotContaining,
  getV4BackgroundWorks,
  getV4ComposerBackgroundWorkCounts,
  getV4ModelConfig,
  openV4ComposerRunningBackgroundWorks,
  prepareV4ConversationE2E,
  sendV4Prompt,
  startNewV4Draft,
  switchV4Model,
  waitForLatestV4CommandAck,
  waitForV4AssistantMessageContaining,
  waitForV4ComposerText,
  waitForV4ConversationState,
  waitForV4Pane,
  waitForV4UserMessageContaining,
} from "#e2e/helpers/v4-conversation";

const BT_EDGES_TIMEOUT_MS = 300000;
const TITLE_SENTINEL = "Generate a concise title";
// 通知以独立 user 消息进入最后一条消息；系统提示里的 `<task-notification>` 字样是
// Bash 工具说明的固定文案，body 级匹配必误伤（见 wakeQuery）。
const WAKE_LAST_USER_MESSAGE = "<task-notification>";
const BT_HANDOFF_SENTENCE = "User moved this command to the background";

const BT_DOUBLE_MARKER = "E2E_BT_DOUBLE";
const BT_DOUBLE_TOOL_CALL_ID = "toolu_bt_double_bash";
const BT_DOUBLE_CONTINUED_TEXT = "bt-double-continued-ok";
const BT_DOUBLE_WAKE_TEXT = "bt-double-wake-ok";

const BT_VIS_ECHO_MARKER = "E2E_BT_VISIBILITY_ECHO";
const BT_VIS_ECHO_TOOL_CALL_ID = "toolu_bt_vis_echo";
const BT_VIS_ECHO_TEXT = "bt-vis-echo-ok";
const BT_VIS_READ_MARKER = "E2E_BT_VISIBILITY_READ";
const BT_VIS_READ_TOOL_CALL_ID = "toolu_bt_vis_read";
const BT_VIS_READ_TEXT = "bt-vis-read-ok";
const BT_VIS_BG_MARKER = "E2E_BT_VISIBILITY_BG";
const BT_VIS_BG_TOOL_CALL_ID = "toolu_bt_vis_bg";
const BT_VIS_BG_TEXT = "bt-vis-bg-ok";
const BT_VIS_BG_WAKE_TEXT = "bt-vis-bg-wake-ok";
const BT_VIS_READ_TARGET_RELATIVE = "conversation-session-background-tool-call-edges/bt-read-target.txt";

describe("BT 边界：双击幂等（诚实 noop）与按钮可见性边界", () => {
  let modelProvider = "";
  let modelName = "";
  let modelThought = "";

  before(async function () {
    this.timeout(BT_EDGES_TIMEOUT_MS);
    await prepareV4ConversationE2E();
    await ensureToolCrossProductFullAccessMode();
    const modelChoice = await getV4ModelConfig();
    modelProvider = modelChoice.provider ?? "";
    modelName = modelChoice.model ?? "";
    modelThought = modelChoice.thought ?? "";
    // BT03 Read 相（非 execute 家族卡）的读取目标：spec 预建（fileFixtures created-by-spec）。
    const readTarget = resolveE2ERuntimePath(BT_VIS_READ_TARGET_RELATIVE);
    await mkdir(readTarget.substring(0, readTarget.lastIndexOf("/")), { recursive: true });
    await writeFile(readTarget, "bt-visibility-read-target\n", "utf8");
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("BT02：同一帧连点两次按钮只移交一次，第二条为诚实 noop(guard.stopTargetChanged)，恰好一个后台 work", async function () {
    this.timeout(BT_EDGES_TIMEOUT_MS);

    await startNewV4Draft();
    await switchV4Model(modelProvider, modelName, modelThought);
    await sendV4Prompt(`${BT_DOUBLE_MARKER} 运行这条耗时命令`);
    await waitForV4ComposerText("", "BT02 消息发送后输入框没有清空");
    await waitForV4UserMessageContaining(BT_DOUBLE_MARKER);
    await waitForV4Pane(
      (snapshot) => snapshot.canStop,
      "BT02 首轮没有进入 running（canStop）",
      45000,
    );
    await waitForToolCallBlockByToolCallId(BT_DOUBLE_TOOL_CALL_ID, 60000);

    // 同一帧连点两次：两次 click 必须落在同一次 React 刷新前，覆盖重复移交的幂等边界。
    const doubleClicked = await browser.execute(
      (buttonTestId) => {
        const button = document.querySelector<HTMLButtonElement>(
          `[data-testid="${buttonTestId}"]`,
        );
        if (!button || button.disabled) return false;
        button.click();
        button.click();
        return true;
      },
      testId(TID_V4_TOOL_BACKGROUND, BT_DOUBLE_TOOL_CALL_ID),
    );
    expect(doubleClicked).toBe(true);

    let acks: Array<{ status: string; reasonCode?: string }> = [];
    await browser.waitUntil(
      async () => {
        acks = await getV4CommandAcksOfType("backgroundToolCall");
        return acks.length >= 2;
      },
      { timeout: 30000, timeoutMsg: "BT02 没有返回两条 backgroundToolCall ACK" },
    );
    expect(acks[0]!.status).toBe("accepted");
    expect(acks[1]!.status).toBe("noop");
    expect(acks[1]!.reasonCode).toBe("guard.stopTargetChanged");

    // 恰好一个 bash 后台 work（重复命令没有创建第二个移交记录）。
    // Composer 入口随 BackgroundTaskStarted 投影渲染，轮询等它出现而不是立即读。
    let triggerCounts: Awaited<ReturnType<typeof getV4ComposerBackgroundWorkCounts>> = null;
    await browser.waitUntil(
      async () => {
        triggerCounts = await getV4ComposerBackgroundWorkCounts();
        return triggerCounts !== null && triggerCounts.bashCount === 1;
      },
      { timeout: 30000, timeoutMsg: "BT02 后台入口没有出现 bash 计数（BackgroundTaskStarted 未投影）" },
    );
    expect(triggerCounts!.totalCount).toBe(1);
    expect(triggerCounts!.workflowCount).toBe(0);
    expect(triggerCounts!.subagentCount).toBe(0);
    await openV4ComposerRunningBackgroundWorks();
    const works = await getV4BackgroundWorks();
    expect(works).toHaveLength(1);
    expect(works[0]!.workId.startsWith("exec_")).toBe(true);

    // 行翻 backgrounded：按钮消失（重复点击的 DOM 表面一并关闭）。
    expect(await hasToolBackgroundButton(BT_DOUBLE_TOOL_CALL_ID)).toBe(false);

    // 合成结果只结算一次，turn 正常继续。
    await waitForUpstreamRequest(
      {
        includes: [BT_DOUBLE_TOOL_CALL_ID, BT_HANDOFF_SENTENCE],
        excludes: [TITLE_SENTINEL, "CRITICAL: Respond with TEXT ONLY"],
      },
      "BT02 合成结果没有回灌，模型没有拿到继续指令",
      30000,
    );
    await waitForV4AssistantMessageContaining(BT_DOUBLE_CONTINUED_TEXT, 60000);
    await waitForV4ConversationState(
      (snapshot) => snapshot.state !== "streaming" && snapshot.queueCount === 0,
      "BT02 turn 没有正常收口",
      60000,
    );

    // 单一 wake：重复移交不产生第二条通知或第二个后台 work。
    await waitForUpstreamRequest(
      wakeQuery(BT_DOUBLE_MARKER),
      "BT02 后台命令完成后没有发出 wake 请求",
      90000,
    );
    await waitForV4AssistantMessageContaining(BT_DOUBLE_WAKE_TEXT, 90000);
    await assertVisibleV4UserMessagesNotContaining("<task-notification>");
    await waitForV4ConversationState(
      (snapshot) => snapshot.state !== "streaming" && snapshot.queueCount === 0,
      "BT02 wake 收口后会话没有回到 idle",
      90000,
    );
    expect(await countWakeRequests(BT_DOUBLE_MARKER)).toBe(1);
    await browser.waitUntil(
      async () => (await getV4BackgroundWorks()).length === 0,
      { timeout: 30000, timeoutMsg: "BT02 wake 结算后 Task Island 没有移除 bash 后台行" },
    );
  });

  it("BT03：按钮可见性边界——completed 卡无按钮、Read 卡无按钮、backgrounded 卡无按钮且缀 `· Background`", async function () {
    this.timeout(BT_EDGES_TIMEOUT_MS);

    await startNewV4Draft();
    await switchV4Model(modelProvider, modelName, modelThought);
    // 首发即相位 1（marker 带 E2E_BT_VISIBILITY 前缀，title fixture 靠前缀复用）。
    await sendV4Prompt(`${BT_VIS_ECHO_MARKER} 先执行一条快速命令`);
    await waitForV4ComposerText("", "BT03 消息发送后输入框没有清空");
    await waitForV4UserMessageContaining(BT_VIS_ECHO_MARKER);
    await waitForV4Pane(
      (snapshot) => snapshot.canStop,
      "BT03 首轮没有进入 running（canStop）",
      45000,
    );

    // 相位 1（completed 卡）：echo 立即完成，收口后按钮缺席。
    await waitForToolCallBlockByToolCallId(BT_VIS_ECHO_TOOL_CALL_ID, 60000);
    await waitForV4AssistantMessageContaining(BT_VIS_ECHO_TEXT, 60000);
    const echoBlock = await waitForToolCallBlockByToolCallId(BT_VIS_ECHO_TOOL_CALL_ID, 15000);
    expect(echoBlock.status).not.toBe("running");
    expect(await hasToolBackgroundButton(BT_VIS_ECHO_TOOL_CALL_ID)).toBe(false);

    // 相位 2（非 execute 家族）：Read 卡全生命周期都没有「Go to background」
    // （按钮只由 execute 渲染器 gate：v4Status=running 且未 backgrounded）。
    await sendV4Prompt(`${BT_VIS_READ_MARKER} 读取这个文件`);
    await waitForV4ComposerText("", "BT03 Read 消息发送后输入框没有清空");
    await waitForToolCallBlockByToolCallId(BT_VIS_READ_TOOL_CALL_ID, 60000);
    expect(await hasToolBackgroundButton(BT_VIS_READ_TOOL_CALL_ID)).toBe(false);
    await waitForV4AssistantMessageContaining(BT_VIS_READ_TEXT, 60000);
    await waitForToolCallBlockByToolCallId(BT_VIS_READ_TOOL_CALL_ID, 15000);
    expect(await hasToolBackgroundButton(BT_VIS_READ_TOOL_CALL_ID)).toBe(false);

    // 相位 3（backgrounded 卡）：运行中 Bash 卡有按钮；移交后按钮消失且 `· Background` 在场。
    await sendV4Prompt(`${BT_VIS_BG_MARKER} 运行这条耗时命令`);
    await waitForV4ComposerText("", "BT03 相位 3 消息发送后输入框没有清空");
    await waitForToolCallBlockByToolCallId(BT_VIS_BG_TOOL_CALL_ID, 60000);
    await clickTestIdByDom(testId(TID_V4_TOOL_BACKGROUND, BT_VIS_BG_TOOL_CALL_ID), {
      timeout: 30000,
      timeoutMsg: "BT03 相位 3「Go to background」按钮没有出现或不可点击",
    });
    const ack = await waitForLatestV4CommandAck("backgroundToolCall", 30000);
    expect(ack.status).toBe("accepted");
    // 按钮消失与 `· Background` 提示都等权威投影回流（row.backgrounded），ack 先于重绘。
    await browser.waitUntil(
      async () => !(await hasToolBackgroundButton(BT_VIS_BG_TOOL_CALL_ID)),
      { timeout: 15000, timeoutMsg: "BT03 相位 3 移交后按钮没有随投影消失" },
    );
    await browser.waitUntil(
      async () => {
        const block = await waitForToolCallBlockByToolCallId(BT_VIS_BG_TOOL_CALL_ID, 5000);
        return /·\s*(Background|后台)/.test(block.text);
      },
      { timeout: 15000, timeoutMsg: "BT03 相位 3 移交后卡上没有出现 `· Background` 提示" },
    );

    // 排水：等 sleep 自然完成 → wake 收口；后台 work 行随结算移除。
    await waitForV4AssistantMessageContaining(BT_VIS_BG_TEXT, 60000);
    await waitForUpstreamRequest(
      wakeQuery(BT_VIS_BG_MARKER),
      "BT03 相位 3 后台命令完成后没有发出 wake 请求",
      90000,
    );
    await waitForV4AssistantMessageContaining(BT_VIS_BG_WAKE_TEXT, 90000);
    await assertVisibleV4UserMessagesNotContaining("<task-notification>");
    await waitForV4ConversationState(
      (snapshot) => snapshot.state !== "streaming" && snapshot.queueCount === 0,
      "BT03 wake 收口后会话没有回到 idle",
      90000,
    );
    await browser.waitUntil(
      async () => (await getV4BackgroundWorks()).length === 0,
      { timeout: 30000, timeoutMsg: "BT03 wake 结算后 Task Island 没有移除 bash 后台行" },
    );
  });
});

/**
 * wake/通知请求锚定：`<task-notification>` 字样出现在每个请求的系统提示（Bash 工具
 * 说明）里，body 级匹配必误伤；通知以独立 user 消息进入最后一条消息，必须用
 * lastUserMessageIncludes 锚定（conversation-session-background.test.ts 同款口径）。
 */
function wakeQuery(marker: string) {
  return {
    includes: [marker],
    lastUserMessageIncludes: [WAKE_LAST_USER_MESSAGE],
    excludes: [TITLE_SENTINEL],
  };
}

/** 已捕获的 wake/通知请求数（同上，按最后一条 user 消息锚定）。 */
function countWakeRequests(marker: string): Promise<number> {
  return countUpstreamRequests({
    includes: [marker],
    lastUserMessageIncludes: [WAKE_LAST_USER_MESSAGE],
  });
}

/** 工具卡下「Go to background」按钮是否仍在 DOM（backgrounded/completed 后应消失）。 */
function hasToolBackgroundButton(toolCallId: string): Promise<boolean> {
  return browser.execute(
    (buttonTestId) => Boolean(document.querySelector(`[data-testid="${buttonTestId}"]`)),
    testId(TID_V4_TOOL_BACKGROUND, toolCallId),
  );
}

/** 读取 __zcodeV4CommandAcksE2E 中指定类型的全部 ACK（有界环形缓冲）。 */
function getV4CommandAcksOfType(
  commandType: string,
): Promise<Array<{ status: string; reasonCode?: string }>> {
  return browser.execute(
    (type) => {
      const entries =
        (window as Window & {
          __zcodeV4CommandAcksE2E?: Array<{ type: string; status: string; reasonCode?: string }>;
        }).__zcodeV4CommandAcksE2E ?? [];
      return entries
        .filter((entry) => entry.type === type)
        .map((entry) => ({ status: entry.status, reasonCode: entry.reasonCode }));
    },
    commandType,
  );
}
