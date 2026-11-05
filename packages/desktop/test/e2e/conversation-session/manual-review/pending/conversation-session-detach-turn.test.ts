// catalog DT01（backgroundTurnDemotion 主链路）+ DT06（backgroundTurnCompletionIsBackgroundResult）。
// 证据层 L3 pending：controlled-stream 让首轮停在 mid-flight（部分正文已流出、轮未收口）→
// 点 Composer「转入后台」→ turn 不中断、session 前台收口（composer 可输入、无 running 相位）、
// Task Island 出现 detached 行、sidebar 行以 hasBackgroundWork 保持 active 排序 →
// 释放受控流让轮自然完成 → backgroundResult wake 以独立 product turn 回到时间线
// （无可见 user trigger row），未选中会话出现 unread 徽标。
// helper 边界：composer/时间线/运行态/后台工作读 v4-conversation.ts，provider 请求证据读
// conversation-session-network.ts；受控流释放按 pending 惯例复用 controlled-replay.ts。
import {
  TID_CHAT_SUMMARY_PANEL,
  TID_CONVERSATION_SECTION,
  TID_TASK_ITEM,
  TID_V4_COMPOSER_BACKGROUND_TURN,
  TID_V4_COMPOSER_BACKGROUND_WORK_TRIGGER,
  testId,
} from "@zcode/shared/test-ids";
import {
  clearAppData,
  clickTestIdByDom,
  waitForDefaultWorkspaceReady,
} from "#e2e/helpers/desktop-app";
import { releaseControlledReplay } from "#e2e/helpers/controlled-replay";
import {
  assertVisibleV4UserMessagesNotContaining,
  getV4BackgroundWorks,
  getV4ComposerBackgroundWorkCounts,
  getV4ConversationState,
  getV4ModelConfig,
  openV4ComposerRunningBackgroundWorks,
  prepareV4ConversationE2E,
  selectV4TaskById,
  sendV4Prompt,
  setV4ComposerText,
  startNewV4Draft,
  switchV4Model,
  waitForLatestV4CommandAck,
  waitForV4AssistantMessageContaining,
  waitForV4ComposerText,
  waitForV4ConversationState,
  waitForV4Pane,
  waitForV4TimelineContaining,
  waitForV4UserMessageContaining,
} from "#e2e/helpers/v4-conversation";
import { waitForUpstreamRequest } from "#e2e/helpers/conversation-session-network";

const DT_DETACH_TIMEOUT_MS = 300000;
const DT_DETACH_MAIN_FIXTURE_ID = "upstream-dt-detach-main-controlled-stream";
const DT_DETACH_PEER_MARKER = "E2E_DT_DETACH_PEER";
const DT_DETACH_MAIN_MARKER = "E2E_DT_DETACH_MAIN";
const DT_DETACH_PARTIAL_TEXT = "dt-detach-streaming";
const DT_DETACH_FINAL_TEXT = "dt-detach-final-ok";
const DT_DETACH_WAKE_REPLY = "dt-detach-wake-consumed-ok";

describe("DT01/DT06 转入后台：demote 主链路与 backgroundResult 独立成轮", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("mid-flight demote 不中断 turn；完成经 backgroundResult wake 独立 product turn + unread", async function () {
    this.timeout(DT_DETACH_TIMEOUT_MS);

    await prepareV4ConversationE2E();
    const modelChoice = await getV4ModelConfig();

    // ── 阶段 A：peer 会话先完成，作为 sidebar active 排序的对照行 ──
    await sendV4Prompt(`${DT_DETACH_PEER_MARKER} 先完成一个对照会话`);
    await waitForV4ComposerText("", "peer 消息发送后输入框没有清空");
    await waitForV4UserMessageContaining(DT_DETACH_PEER_MARKER);
    await waitForV4AssistantMessageContaining("dt-detach-peer-ok");
    await waitForV4ConversationState(
      (snapshot) => snapshot.state !== "streaming" && snapshot.queueCount === 0,
      "peer 会话没有回到 idle",
    );
    const peerSessionId = (await getV4ConversationState()).taskId!;
    expect(peerSessionId).toBeTruthy();

    // ── 阶段 B：主会话受控慢流，停在 mid-flight（部分正文已流出）──
    await startNewV4Draft();
    await switchV4Model(
      modelChoice.provider ?? "",
      modelChoice.model ?? "",
      modelChoice.thought ?? "",
    );
    await sendV4Prompt(`${DT_DETACH_MAIN_MARKER} 慢慢回答这个问题`);
    await waitForV4ComposerText("", "主会话消息发送后输入框没有清空");
    await waitForV4UserMessageContaining(DT_DETACH_MAIN_MARKER);
    await waitForV4Pane(
      (snapshot) => snapshot.canStop && snapshot.sessionId !== "draft",
      "主会话首轮没有进入 running（canStop）",
      45000,
    );
    // releaseAfterChunks=3：message_start / block_start / 首段正文立即流出，尾段被 hold。
    await waitForV4TimelineContaining(DT_DETACH_PARTIAL_TEXT, 45000);
    const mainSessionId = (await getV4ConversationState()).taskId!;
    expect(mainSessionId).toBeTruthy();
    expect(mainSessionId).not.toBe(peerSessionId);

    // ── 阶段 C：点「转入后台」→ DT01 主链路断言 ──
    await clickTestIdByDom(TID_V4_COMPOSER_BACKGROUND_TURN, {
      timeout: 30000,
      timeoutMsg: "Composer「转入后台」按钮没有出现或不可点击（mid-flight primaryTurn 缺席？）",
    });
    const demoteAck = await waitForLatestV4CommandAck("backgroundTurn", 30000);
    expect(demoteAck.status).toBe("accepted");

    // session 前台收口（BackgroundTurnDemoted 在 demote 时刻结算 activeWorks/canStop/phase）：
    // 无 running 相位（control.phase→completed 投影为 canStop=false + 非 streaming）、
    // stop 控件消失、转入后台入口随 primaryTurn 消失。
    await waitForV4Pane(
      (snapshot) => !snapshot.canStop,
      "demote 后没有退出 running 相位（canStop 仍在）",
      30000,
    );
    await waitForV4ConversationState(
      (snapshot) => snapshot.state !== "streaming",
      "demote 后会话没有回到非 streaming（前台 completion gate 未解除）",
      30000,
    );
    expect(await hasComposerBackgroundTurnButton()).toBe(false);
    // composer 立即可输入：Lexical helper 遵守真实可编辑态，禁用输入会在此抛错。
    await setV4ComposerText("demote 后立即可输入");
    // turn 未被中断：已流出的部分正文仍在时间线，detached 行保持 running。
    await waitForV4TimelineContaining(DT_DETACH_PARTIAL_TEXT, 10000);

    // Task Island：Composer 后台入口计数把 kind=turn 计入徽标，detached turn 有独立分区行。
    const triggerCounts = await getV4ComposerBackgroundWorkCounts();
    expect(triggerCounts).not.toBeNull();
    expect(triggerCounts!.totalCount).toBe(1);
    expect(triggerCounts!.bashCount).toBe(0);
    expect(triggerCounts!.workflowCount).toBe(0);
    expect(triggerCounts!.subagentCount).toBe(0);
    expect(await getComposerBackgroundTurnCount()).toBe(1);
    await openV4ComposerRunningBackgroundWorks();
    await expandV4TurnStatusSection();
    const detachedRows = await getV4DetachedTurnRows();
    expect(detachedRows).toHaveLength(1);
    expect(detachedRows[0]!.kind).toBe("turn");
    expect(detachedRows[0]!.status).toBe("running");
    // runtime 原语形状：demote 结果 workId = `turn_${foregroundExecutionId}`。
    expect(detachedRows[0]!.workId.startsWith("turn_")).toBe(true);
    const works = await getV4BackgroundWorks();
    expect(works.map((work) => work.status)).toEqual(["running"]);

    // sidebar：前台已 completed，但 detached turn 让行保持 active 排序（hasBackgroundWork）。
    await waitForTaskRowBefore(peerSessionId, mainSessionId);

    // ── 阶段 D：切走 → 释放受控流 → backgroundResult wake（DT06）──
    await startNewV4Draft();
    await releaseControlledReplay(DT_DETACH_MAIN_FIXTURE_ID);
    await waitForUpstreamRequest(
      {
        includes: ["<task-notification>", DT_DETACH_FINAL_TEXT],
        excludes: ["Generate a concise title"],
      },
      "detached turn 完成后没有发出 backgroundResult wake 请求",
      90000,
    );

    // wake 落在未选中会话：sidebar 行出现 unread 徽标（DT06 的 badge surface）。
    await waitForTaskRowUnread(mainSessionId);

    await selectV4TaskById(mainSessionId);
    // wake 是独立 product turn：可见 assistant 回复出现，且没有可见的 user trigger row。
    await waitForV4AssistantMessageContaining(DT_DETACH_WAKE_REPLY, 90000);
    await assertVisibleV4UserMessagesNotContaining("<task-notification>");
    await waitForV4ConversationState(
      (snapshot) => snapshot.state !== "streaming" && snapshot.queueCount === 0,
      "wake 收口后会话没有回到 idle",
      90000,
    );
    // 收口后 detached 行消失、后台计数归零。
    expect(await getComposerBackgroundTurnCount()).toBe(0);
    expect(await getV4BackgroundWorks()).toEqual([]);

    // ── 阶段 E：冷恢复无 ghost running 行（BackgroundTurnDemoted 不进冷恢复的运行投影）──
    await browser.reloadSession();
    await waitForDefaultWorkspaceReady(60000);
    await selectV4TaskById(mainSessionId);
    await waitForV4AssistantMessageContaining(DT_DETACH_WAKE_REPLY, 90000);
    await waitForV4Pane(
      (snapshot) => snapshot.sessionId === mainSessionId && !snapshot.canStop,
      "冷恢复后主会话出现 ghost running 相位（canStop）",
      30000,
    );
    expect(await getV4DetachedTurnRows()).toEqual([]);
    expect(await getComposerBackgroundTurnCount()).toBe(0);
  });
});

/** Composer「转入后台」按钮是否仍在 DOM（demote 后应随 primaryTurn 消失）。 */
function hasComposerBackgroundTurnButton(): Promise<boolean> {
  return browser.execute(
    (buttonTestId) => Boolean(document.querySelector(`[data-testid="${buttonTestId}"]`)),
    TID_V4_COMPOSER_BACKGROUND_TURN,
  );
}

/** Composer 后台入口 data-background-turn-count（DT 徽标把 kind=turn 计入总数）。 */
function getComposerBackgroundTurnCount(): Promise<number> {
  return browser.execute(
    (triggerTestId) =>
      Number(
        document
          .querySelector<HTMLElement>(`[data-testid="${triggerTestId}"]`)
          ?.getAttribute("data-background-turn-count") ?? "0",
      ),
    TID_V4_COMPOSER_BACKGROUND_WORK_TRIGGER,
  );
}

/** 展开 Task Island 的 detached-turn 分区（data-status-section-trigger="turn"）。 */
async function expandV4TurnStatusSection() {
  await browser.waitUntil(
    async () =>
      browser.execute(
        (panelTestId, sectionName) => {
          const panel = document.querySelector<HTMLElement>(`[data-testid="${panelTestId}"]`);
          if (!panel || Number(panel.dataset.runningTurnCount ?? "0") < 1) return false;
          const trigger = panel.querySelector<HTMLButtonElement>(
            `[data-status-section-trigger="${sectionName}"]`,
          );
          if (!trigger) return false;
          if (trigger.getAttribute("aria-expanded") !== "true") {
            trigger.click();
            return false;
          }
          return true;
        },
        TID_CHAT_SUMMARY_PANEL,
        "turn",
      ),
    { timeout: 15000, timeoutMsg: "Task Island 没有出现可展开的 detached-turn 分区" },
  );
}

interface DetachedTurnRowSnapshot {
  kind: string | null;
  status: string | null;
  workId: string;
}

/** 读取 detached turn 分区行（data-background-task-kind / data-work-status）。 */
function getV4DetachedTurnRows(): Promise<DetachedTurnRowSnapshot[]> {
  return browser.execute((itemPrefix) => {
    return Array.from(
      document.querySelectorAll<HTMLElement>(`[data-testid^="${itemPrefix}-"]`),
    )
      .filter((row) => row.getAttribute("data-background-task-kind") === "turn")
      .map((row) => ({
        kind: row.getAttribute("data-background-task-kind"),
        status: row.getAttribute("data-work-status"),
        workId: row.getAttribute("data-work-id") ?? "",
      }));
  }, "v4-background-work-item");
}

/** 等待 sidebar 中 activeSessionId 的行排在 restingSessionId 之前（running-first 分层）。 */
async function waitForTaskRowBefore(restingSessionId: string, activeSessionId: string) {
  let latest: string[] = [];
  await browser.waitUntil(
    async () => {
      latest = await browser.execute(
        (sectionTestId, itemPrefix) =>
          Array.from(
            document
              .querySelector(`[data-testid="${sectionTestId}"]`)
              ?.querySelectorAll<HTMLElement>(`[data-testid^="${itemPrefix}-"]`) ?? [],
          ).map((row) => row.getAttribute("data-testid") ?? ""),
        TID_CONVERSATION_SECTION,
        TID_TASK_ITEM,
      );
      const restingIndex = latest.indexOf(testId(TID_TASK_ITEM, restingSessionId));
      const activeIndex = latest.indexOf(testId(TID_TASK_ITEM, activeSessionId));
      return restingIndex >= 0 && activeIndex >= 0 && activeIndex < restingIndex;
    },
    {
      timeout: 20000,
      timeoutMsg:
        "sidebar 没有把 detached-turn 会话保持在 active 分层（hasBackgroundWork 排序缺失）",
    },
  );
}

/** 等待未选中会话行的 unread 蓝点（backgroundResult 到达后的 badge surface）。 */
async function waitForTaskRowUnread(sessionId: string) {
  const row = $(
    `[data-testid="${TID_CONVERSATION_SECTION}"] [data-testid="${testId(
      TID_TASK_ITEM,
      sessionId,
    )}"]`,
  );
  await row.waitForDisplayed({ timeout: 15000, timeoutMsg: `sidebar 没有目标会话行: ${sessionId}` });
  await browser.waitUntil(
    async () =>
      browser.execute(
        (sectionTestId, rowTestId) =>
          Boolean(
            document
              .querySelector(`[data-testid="${sectionTestId}"] [data-testid="${rowTestId}"]`)
              ?.querySelector('[data-unread-indicator="true"]'),
          ),
        TID_CONVERSATION_SECTION,
        testId(TID_TASK_ITEM, sessionId),
      ),
    {
      timeout: 30000,
      timeoutMsg: "wake 到达后 sidebar 行没有出现 unread 徽标（backgroundResult badge 缺失）",
    },
  );
}
