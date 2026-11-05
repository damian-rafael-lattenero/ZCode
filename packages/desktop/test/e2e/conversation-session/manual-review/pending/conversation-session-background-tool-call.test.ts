// catalog BT01（backgroundToolCallDemotion 主链路）+ BT04（continuation honesty）。
// 证据层 L3 pending：与 DT 不同，运行窗口由真实 Bash 进程提供（fixture 只发 tool_use，
// 不需要 controlled-stream）：fast-text tool_use 启动 `sleep`，前台 Bash 卡稳定 running →
// 点卡下「Go to background」（v4-tool-background-<toolCallId>）→ ack accepted →
// tool call 以合成结果立即结算（模型收到 "Command was manually backgrounded by user …"
// 字面交接句），turn 不中断、模型同一 turn 继续输出 → 投影把行翻 backgrounded
// （按钮消失、kind 标签缀 `· Background`）→ Task Island 出现 bash 行（workId=exec_*）
// → turn 正常收口时进程仍在跑（session idle + 后台 work running 同框）→ 完成经
// backgroundResult wake 独立收口，Task Island 行移除。
// helper 边界：composer/时间线/运行态/后台工作读 v4-conversation.ts，tool 卡读
// conversation-session-tool.ts，provider 请求证据读 conversation-session-network.ts；
// Bash 免权限前置复用 tool-cross-product 的 yolo 切换。
import { TID_V4_TOOL_BACKGROUND, testId } from "@zcode/shared/test-ids";
import { clearAppData, clickTestIdByDom } from "#e2e/helpers/desktop-app";
import { ensureToolCrossProductFullAccessMode } from "#e2e/helpers/conversation-session-tool-cross-product";
import {
  countUpstreamRequests,
  findFirstUpstreamRequestIndex,
  waitForUpstreamRequest,
} from "#e2e/helpers/conversation-session-network";
import { waitForToolCallBlockByToolCallId } from "#e2e/helpers/conversation-session-tool";
import {
  assertVisibleV4UserMessagesNotContaining,
  getV4BackgroundWorks,
  getV4ComposerBackgroundWorkCounts,
  getV4ModelConfig,
  openV4ComposerRunningBackgroundWorks,
  prepareV4ConversationE2E,
  sendV4Prompt,
  setV4ComposerText,
  startNewV4Draft,
  switchV4Model,
  waitForLatestV4CommandAck,
  waitForV4AssistantMessageContaining,
  waitForV4ComposerText,
  waitForV4ConversationState,
  waitForV4Pane,
  waitForV4UserMessageContaining,
} from "#e2e/helpers/v4-conversation";

const BT_TIMEOUT_MS = 300000;
const TITLE_SENTINEL = "Generate a concise title";
// 通知以独立 user 消息进入最后一条消息；系统提示里的 `<task-notification>` 字样是
// Bash 工具说明的固定文案，body 级匹配必误伤（见 wakeQuery）。
const WAKE_LAST_USER_MESSAGE = "<task-notification>";
// 模型交接句的字面契约（bash-model-content.ts backgroundedByUser，不得改写）。
const BT_HANDOFF_SENTENCE = "User moved this command to the background";

const BT_MAIN_MARKER = "E2E_BT_MAIN";
const BT_MAIN_TOOL_CALL_ID = "toolu_bt_main_bash";
const BT_MAIN_CONTINUED_TEXT = "bt-main-continued-ok";
const BT_MAIN_WAKE_TEXT = "bt-main-wake-ok";

const BT_CONTINUE_MARKER = "E2E_BT_CONTINUE";
const BT_CONTINUE_TOOL_CALL_ID = "toolu_bt_continue_bash";
const BT_CONTINUE_TEXT = "bt-continue-after-background-ok";
const BT_CONTINUE_WAKE_TEXT = "bt-continue-wake-ok";

describe("BT01/BT04 转入后台：Bash tool call demote 主链路与同 turn continuation", () => {
  let modelProvider = "";
  let modelName = "";
  let modelThought = "";

  before(async function () {
    this.timeout(BT_TIMEOUT_MS);
    await prepareV4ConversationE2E();
    // Bash 免权限：BT 的运行窗口必须稳定落在真实执行相位（v4Status=running），
    // 不能被 permission pending 挡住（那是 DT05 的边界，不属于 BT）。
    await ensureToolCrossProductFullAccessMode();
    const modelChoice = await getV4ModelConfig();
    modelProvider = modelChoice.provider ?? "";
    modelName = modelChoice.model ?? "";
    modelThought = modelChoice.thought ?? "";
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("BT01：运行中 Bash 卡移交后台不结束 turn；行翻 backgrounded；完成经 backgroundResult wake 收口", async function () {
    this.timeout(BT_TIMEOUT_MS);

    await startNewV4Draft();
    await switchV4Model(modelProvider, modelName, modelThought);
    await sendV4Prompt(`${BT_MAIN_MARKER} 运行这条耗时命令，完成后告诉我结果`);
    await waitForV4ComposerText("", "BT01 消息发送后输入框没有清空");
    await waitForV4UserMessageContaining(BT_MAIN_MARKER);
    await waitForV4Pane(
      (snapshot) => snapshot.canStop && snapshot.sessionId !== "draft",
      "BT01 首轮没有进入 running（canStop）",
      45000,
    );
    // fixture 只发 tool_use：真实 `sleep` 进程提供稳定的前台 running 窗口。
    await waitForToolCallBlockByToolCallId(BT_MAIN_TOOL_CALL_ID, 60000);

    // ── 点卡下「Go to background」→ BT01 主链路断言 ──
    await clickTestIdByDom(testId(TID_V4_TOOL_BACKGROUND, BT_MAIN_TOOL_CALL_ID), {
      timeout: 30000,
      timeoutMsg: "运行中 Bash 卡下方没有出现「Go to background」按钮或不可点击",
    });
    const ack = await waitForLatestV4CommandAck("backgroundToolCall", 30000);
    expect(ack.status).toBe("accepted");

    // tool call 立即结算：合成结果（含字面交接句）回灌进入下一次 provider 请求。
    // 注意：`<task-notification>` 字样出现在每个请求的系统提示（Bash 工具说明）里，
    // 任何 body 级排除/包含都会误伤；请求锚定用 includes 的唯一串 + lastUserMessageIncludes。
    const settleQuery = {
      includes: [BT_MAIN_TOOL_CALL_ID, BT_HANDOFF_SENTENCE],
      excludes: [TITLE_SENTINEL, "CRITICAL: Respond with TEXT ONLY"],
    };
    await waitForUpstreamRequest(
      settleQuery,
      "BT01 移交后合成结果没有回灌，模型没有拿到继续指令",
      30000,
    );
    const settleIndex = await findFirstUpstreamRequestIndex(settleQuery);
    expect(settleIndex).not.toBeNull();
    // turn 不中断：continuation 请求先于任何 task-notification（不是 DT 式前台收口）。
    const continuationIndex = await findFirstUpstreamRequestIndex(
      {
        includes: [BT_MAIN_MARKER, BT_MAIN_TOOL_CALL_ID],
        excludes: [TITLE_SENTINEL, "CRITICAL: Respond with TEXT ONLY"],
      },
      { afterIndex: settleIndex ?? undefined },
    );
    expect(continuationIndex).not.toBeNull();
    await waitForV4AssistantMessageContaining(BT_MAIN_CONTINUED_TEXT, 60000);

    // turn 正常收口（composer 不被 force-idle 是「后台 work 比 turn 活得久」的同框事实）：
    // session idle 时后台 bash 仍在跑，Task Island 保留 bash 行。
    await waitForV4ConversationState(
      (snapshot) => snapshot.state !== "streaming" && snapshot.queueCount === 0,
      "BT01 turn 没有正常收口（streaming 未解除）",
      60000,
    );

    // 行翻 backgrounded：按钮消失，kind 标签缀 `· Background`（zh/en 双语断言）。
    expect(await hasToolBackgroundButton(BT_MAIN_TOOL_CALL_ID)).toBe(false);
    const backgroundedBlock = await waitForToolCallBlockByToolCallId(BT_MAIN_TOOL_CALL_ID, 15000);
    expect(/·\s*(Background|后台)/.test(backgroundedBlock.text)).toBe(true);

    // Composer 后台入口计数：bash 1（turn/workflow/subagent 不计入）。
    const triggerCounts = await getV4ComposerBackgroundWorkCounts();
    expect(triggerCounts).not.toBeNull();
    expect(triggerCounts!.bashCount).toBe(1);
    expect(triggerCounts!.totalCount).toBe(1);
    expect(triggerCounts!.workflowCount).toBe(0);
    expect(triggerCounts!.subagentCount).toBe(0);

    // Task Island bash 行：workId = exec_*（adapter taskId，tracker/投影共同主键）。
    await openV4ComposerRunningBackgroundWorks();
    const works = await getV4BackgroundWorks();
    expect(works).toHaveLength(1);
    expect(works[0]!.workId.startsWith("exec_")).toBe(true);
    expect(works[0]!.status).toBe("running");

    // session idle 且后台命令在跑时 composer 仍可输入（BT 与 DT 的收口语义差异面）。
    await setV4ComposerText("后台命令运行中仍可输入");

    // ── 完成链路：进程自然退出 → task-notification → backgroundResult wake ──
    await waitForUpstreamRequest(
      wakeQuery(BT_MAIN_MARKER),
      "BT01 后台命令完成后没有发出 task-notification wake 请求",
      90000,
    );
    await waitForV4AssistantMessageContaining(BT_MAIN_WAKE_TEXT, 90000);
    await assertVisibleV4UserMessagesNotContaining("<task-notification>");
    await waitForV4ConversationState(
      (snapshot) => snapshot.state !== "streaming" && snapshot.queueCount === 0,
      "BT01 wake 收口后会话没有回到 idle",
      90000,
    );
    // 后台 work 随 wake 结算从 Task Island 移除；时间线上 backgrounded 卡与 `· Background`
    // 事实保留（历史转录不回写）。
    await browser.waitUntil(
      async () => (await getV4BackgroundWorks()).length === 0,
      { timeout: 30000, timeoutMsg: "BT01 wake 结算后 Task Island 没有移除 bash 后台行" },
    );
    // 单次完成只产生一条通知请求（无重复 wake）。
    expect(await countWakeRequests(BT_MAIN_MARKER)).toBe(1);
  });

  it("BT04：移交后模型在同一 turn 继续产出（不等待、不轮询），continuation 先于 wake", async function () {
    this.timeout(BT_TIMEOUT_MS);

    await startNewV4Draft();
    await switchV4Model(modelProvider, modelName, modelThought);
    await sendV4Prompt(`${BT_CONTINUE_MARKER} 运行这条耗时命令`);
    await waitForV4ComposerText("", "BT04 消息发送后输入框没有清空");
    await waitForV4UserMessageContaining(BT_CONTINUE_MARKER);
    await waitForV4Pane(
      (snapshot) => snapshot.canStop,
      "BT04 首轮没有进入 running（canStop）",
      45000,
    );
    await waitForToolCallBlockByToolCallId(BT_CONTINUE_TOOL_CALL_ID, 60000);

    await clickTestIdByDom(testId(TID_V4_TOOL_BACKGROUND, BT_CONTINUE_TOOL_CALL_ID), {
      timeout: 30000,
      timeoutMsg: "BT04「Go to background」按钮没有出现或不可点击",
    });
    const ack = await waitForLatestV4CommandAck("backgroundToolCall", 30000);
    expect(ack.status).toBe("accepted");

    // 诚实性断言的核心：合成结果指令模型「不要等待/睡眠/轮询」，随后模型在同一 turn
    // 产出后续内容——continuation 请求发生在任何 task-notification 之前（后台命令还在跑）。
    await waitForUpstreamRequest(
      {
        includes: [BT_CONTINUE_TOOL_CALL_ID, BT_HANDOFF_SENTENCE, "Do not wait, sleep, or poll"],
        excludes: [TITLE_SENTINEL, "CRITICAL: Respond with TEXT ONLY"],
      },
      "BT04 合成结果没有携带字面交接句（do-not-wait 指令缺失）",
      30000,
    );
    await waitForV4AssistantMessageContaining(BT_CONTINUE_TEXT, 60000);
    await waitForV4ConversationState(
      (snapshot) => snapshot.state !== "streaming" && snapshot.queueCount === 0,
      "BT04 turn 没有正常收口",
      60000,
    );
    // turn 已收口而后台命令仍在跑：此刻不可能有 wake 请求（顺序事实，不靠时序竞速）。
    expect(await countWakeRequests(BT_CONTINUE_MARKER)).toBe(0);

    // 排水：等 sleep 自然完成 → wake 独立收口，不留跨用例后台工作。
    await waitForUpstreamRequest(
      wakeQuery(BT_CONTINUE_MARKER),
      "BT04 后台命令完成后没有发出 wake 请求",
      60000,
    );
    await waitForV4AssistantMessageContaining(BT_CONTINUE_WAKE_TEXT, 60000);
    await assertVisibleV4UserMessagesNotContaining("<task-notification>");
    await waitForV4ConversationState(
      (snapshot) => snapshot.state !== "streaming" && snapshot.queueCount === 0,
      "BT04 wake 收口后会话没有回到 idle",
      60000,
    );
  });
});

/** 工具卡下「Go to background」按钮是否仍在 DOM（backgrounded 后应消失）。 */
function hasToolBackgroundButton(toolCallId: string): Promise<boolean> {
  return browser.execute(
    (buttonTestId) => Boolean(document.querySelector(`[data-testid="${buttonTestId}"]`)),
    testId(TID_V4_TOOL_BACKGROUND, toolCallId),
  );
}

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
