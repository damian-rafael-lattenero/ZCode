// catalog DT05（backgroundTurnPendingInteractionBadge）+ DT07（backgroundTurnCancelViaBackgroundControl）
// + DT08（stopExcludesBackgroundTurn）+ double-demote 幂等（guard.stopTargetChanged 诚实拒绝）。
// 证据层 L3 pending：
// - DT05：pending permission 下 demote 不被阻止；任务行显示 pending interaction badge；
//   弹窗保留，批准后 detached turn 继续执行并经 backgroundResult wake 收口。
// - DT07：Task Island cancel（cancelBackgroundWork）→ 无 wake、无 background result，
//   session 保持 completed，transcript 保留已流出内容。
// - DT08：session 仅有 detached turn 时主停止按钮不可用（无 stop 控件、无 stop 命令），
//   detached turn 不受影响，释放后按 backgroundResult 语义收口。
// - double-demote：同一帧连点两次 → 第一条 accepted、第二条 noop(guard.stopTargetChanged)，
//   只有一条 detached 行，turn 不中断。
// helper 边界：composer/时间线/运行态/后台工作/权限弹窗读 v4-conversation.ts，provider 请求
// 证据读 conversation-session-network.ts；受控流释放按 pending 惯例复用 controlled-replay.ts。
import {
  TID_CHAT_SUMMARY_PANEL,
  TID_TASK_ITEM,
  TID_V4_COMPOSER_BACKGROUND_TURN,
  TID_V4_STOP,
  testId,
} from "@zcode/shared/test-ids";
import { clearAppData, clickTestIdByDom } from "#e2e/helpers/desktop-app";
import { releaseControlledReplay } from "#e2e/helpers/controlled-replay";
import {
  approveV4PermissionAlways,
  assertVisibleV4UserMessagesNotContaining,
  clickV4BackgroundWorkCancel,
  getLatestV4CommandAck,
  getV4BackgroundWorks,
  getV4ConversationState,
  getV4ModelConfig,
  hasV4PermissionDialog,
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
  waitForV4PermissionDialog,
  waitForV4TimelineContaining,
  waitForV4UserMessageContaining,
} from "#e2e/helpers/v4-conversation";
import {
  countUpstreamRequestsContainingAll,
  waitForUpstreamRequest,
} from "#e2e/helpers/conversation-session-network";

const DT_EDGES_TIMEOUT_MS = 300000;
const TITLE_SENTINEL = "Generate a concise title";

describe("DT 边界：pending permission demote / Task Island cancel / stop 排除 / 双击幂等", () => {
  let modelProvider = "";
  let modelName = "";
  let modelThought = "";

  before(async function () {
    this.timeout(DT_EDGES_TIMEOUT_MS);
    await prepareV4ConversationE2E();
    const modelChoice = await getV4ModelConfig();
    modelProvider = modelChoice.provider ?? "";
    modelName = modelChoice.model ?? "";
    modelThought = modelChoice.thought ?? "";
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("DT05：pending permission 下 demote 不被阻止，任务行显示 badge，批准后 turn 继续并经 wake 收口", async function () {
    this.timeout(DT_EDGES_TIMEOUT_MS);

    // 首个固定目录草稿（ZCodeProject cwd）：Bash workspace 相对路径落在 .zcode-e2e/<case>/。
    await sendV4Prompt("E2E_DT_PENDING_PERM 使用 Bash 写入 fixture 文件");
    await waitForV4ComposerText("", "DT05 消息发送后输入框没有清空");
    await waitForV4UserMessageContaining("E2E_DT_PENDING_PERM");
    // 权限弹窗挂起（pendingInteractions sidecar），turn 以 primaryTurn 等待批准。
    await waitForV4PermissionDialog();
    await waitForV4Pane(
      (snapshot) => snapshot.canStop && snapshot.sessionId !== "draft",
      "DT05 权限挂起时没有 primaryTurn running（canStop）",
      45000,
    );
    const permSessionId = (await getV4ConversationState()).taskId!;
    expect(permSessionId).toBeTruthy();

    // pending interaction 不阻止 demote：按钮可见并接受点击。
    await clickTestIdByDom(TID_V4_COMPOSER_BACKGROUND_TURN, {
      timeout: 30000,
      timeoutMsg: "pending permission 下「转入后台」按钮没有出现或不可点击（demote 被错误阻止）",
    });
    const demoteAck = await waitForLatestV4CommandAck("backgroundTurn", 30000);
    expect(demoteAck.status).toBe("accepted");

    // 前台收口；权限弹窗仍挂起（demote 不 resolve 也不丢弃 interaction）。
    await waitForV4Pane(
      (snapshot) => !snapshot.canStop,
      "DT05 demote 后没有退出 running 相位（canStop 仍在）",
      30000,
    );
    expect(await hasV4PermissionDialog()).toBe(true);

    // 任务行显示 pending interaction badge（pendingInteractions sidecar）。
    await waitForTaskRowPermissionBadge(permSessionId);

    // Task Island detached 行保持 running。
    await openV4ComposerRunningBackgroundWorks();
    await expandV4TurnStatusSection();
    const detachedRows = await getV4DetachedTurnRows();
    expect(detachedRows).toHaveLength(1);
    expect(detachedRows[0]!.kind).toBe("turn");
    expect(detachedRows[0]!.status).toBe("running");

    // 从当前 surface resolve：批准 exact 命令（allowAlways）。
    const approved = await approveV4PermissionAlways();
    expect(approved).toBe(true);

    // turn 继续执行：tool_result 回灌进入下一次 provider 请求，最终文本可见。
    await waitForUpstreamRequest(
      {
        includes: ["E2E_DT_PENDING_PERM", "toolu_dt_edges_perm_bash"],
        excludes: [TITLE_SENTINEL, "<task-notification>"],
      },
      "DT05 批准后 tool_result 没有回灌，detached turn 未继续执行",
      90000,
    );
    await waitForV4AssistantMessageContaining("dt-pending-perm-final-ok", 90000);

    // detached turn 完成产生 backgroundResult wake：独立 product turn、无可见 user trigger row。
    await waitForUpstreamRequest(
      {
        includes: ["<task-notification>", "E2E_DT_PENDING_PERM"],
        excludes: [TITLE_SENTINEL],
      },
      "DT05 detached turn 完成后没有发出 backgroundResult wake 请求",
      90000,
    );
    await waitForV4AssistantMessageContaining("dt-pending-perm-wake-ok", 90000);
    await assertVisibleV4UserMessagesNotContaining("<task-notification>");
    await waitForV4ConversationState(
      (snapshot) => snapshot.state !== "streaming" && snapshot.queueCount === 0,
      "DT05 wake 收口后会话没有回到 idle",
      90000,
    );
    expect(await getV4DetachedTurnRows()).toEqual([]);
  });

  it("DT07：Task Island cancel 取消 detached turn：无 wake、无 background result、session 保持 completed", async function () {
    this.timeout(DT_EDGES_TIMEOUT_MS);

    await startNewV4Draft();
    await switchV4Model(modelProvider, modelName, modelThought);
    await sendV4Prompt("E2E_DT_CANCEL_MAIN 慢慢回答这个问题");
    await waitForV4ComposerText("", "DT07 消息发送后输入框没有清空");
    await waitForV4UserMessageContaining("E2E_DT_CANCEL_MAIN");
    await waitForV4Pane(
      (snapshot) => snapshot.canStop,
      "DT07 首轮没有进入 running（canStop）",
      45000,
    );
    await waitForV4TimelineContaining("dt-cancel-streaming", 45000);

    await clickTestIdByDom(TID_V4_COMPOSER_BACKGROUND_TURN, {
      timeout: 30000,
      timeoutMsg: "DT07「转入后台」按钮没有出现或不可点击",
    });
    const demoteAck = await waitForLatestV4CommandAck("backgroundTurn", 30000);
    expect(demoteAck.status).toBe("accepted");
    await waitForV4Pane(
      (snapshot) => !snapshot.canStop,
      "DT07 demote 后没有退出 running 相位",
      30000,
    );

    await openV4ComposerRunningBackgroundWorks();
    await expandV4TurnStatusSection();
    const detachedRows = await getV4DetachedTurnRows();
    expect(detachedRows).toHaveLength(1);
    const cancelWorkId = detachedRows[0]!.workId;
    expect(cancelWorkId.startsWith("turn_")).toBe(true);

    const clickedCancel = await clickV4BackgroundWorkCancel(cancelWorkId);
    expect(clickedCancel).toBe(true);

    // 无 wake、无 background result：取消不产生 task-notification 请求，尾段正文永不出现。
    await browser.pause(1500);
    expect(
      await countUpstreamRequestsContainingAll(["<task-notification>", "E2E_DT_CANCEL_MAIN"]),
    ).toBe(0);
    const cancelSnapshot = await waitForV4Pane(
      (snapshot) => !snapshot.canStop,
      "DT07 cancel 后会话没有保持 completed（canStop 复活）",
      30000,
    );
    expect(cancelSnapshot.timelineText).toContain("dt-cancel-streaming");
    expect(cancelSnapshot.timelineText).not.toContain("dt-cancel-final-ok");
    await waitForV4ConversationState(
      (snapshot) => snapshot.state !== "streaming",
      "DT07 cancel 后会话没有保持非 streaming",
      30000,
    );

    // detached 行随取消收口消失，后台计数归零。
    expect(await getV4DetachedTurnRows()).toEqual([]);
    expect(await getV4BackgroundWorks()).toEqual([]);
  });

  it("DT08：session 仅有 detached turn 时主停止按钮不可用，stop 为 noop，turn 不受影响", async function () {
    this.timeout(DT_EDGES_TIMEOUT_MS);

    await startNewV4Draft();
    await switchV4Model(modelProvider, modelName, modelThought);
    await sendV4Prompt("E2E_DT_STOP_EXCLUDE 慢慢回答这个问题");
    await waitForV4ComposerText("", "DT08 消息发送后输入框没有清空");
    await waitForV4UserMessageContaining("E2E_DT_STOP_EXCLUDE");
    await waitForV4Pane(
      (snapshot) => snapshot.canStop,
      "DT08 首轮没有进入 running（canStop）",
      45000,
    );
    await waitForV4TimelineContaining("dt-stop-exclude-streaming", 45000);

    await clickTestIdByDom(TID_V4_COMPOSER_BACKGROUND_TURN, {
      timeout: 30000,
      timeoutMsg: "DT08「转入后台」按钮没有出现或不可点击",
    });
    const demoteAck = await waitForLatestV4CommandAck("backgroundTurn", 30000);
    expect(demoteAck.status).toBe("accepted");

    // 仅有 detached turn（backgroundWork only）：主停止按钮不可用，stopTargetKind 不报告 turn。
    await waitForV4Pane(
      (snapshot) => !snapshot.canStop,
      "DT08 demote 后 canStop 没有清空（stop 控件仍可用）",
      30000,
    );
    expect(await hasV4StopControl()).toBe(false);
    // stop 请求为 noop 的最强形态：整个会话运行期间不存在任何 stop 命令 ACK。
    expect(await getLatestV4CommandAck("stop")).toBeNull();

    // detached turn 不受 stop 语义影响：保持 running，随后释放自然完成并经 wake 收口。
    await openV4ComposerRunningBackgroundWorks();
    await expandV4TurnStatusSection();
    const detachedRows = await getV4DetachedTurnRows();
    expect(detachedRows).toHaveLength(1);
    expect(detachedRows[0]!.status).toBe("running");

    await releaseControlledReplay("upstream-dt-edges-stop-exclude-controlled-stream");
    await waitForUpstreamRequest(
      {
        includes: ["<task-notification>", "E2E_DT_STOP_EXCLUDE"],
        excludes: [TITLE_SENTINEL],
      },
      "DT08 释放后没有发出 backgroundResult wake 请求",
      90000,
    );
    await waitForV4AssistantMessageContaining("dt-stop-exclude-wake-ok", 90000);
    await assertVisibleV4UserMessagesNotContaining("<task-notification>");
    await waitForV4ConversationState(
      (snapshot) => snapshot.state !== "streaming" && snapshot.queueCount === 0,
      "DT08 wake 收口后会话没有回到 idle",
      90000,
    );
    expect(await getV4DetachedTurnRows()).toEqual([]);
  });

  it("double-demote：同一帧连点两次只 demote 一次，第二条为诚实 noop(guard.stopTargetChanged)", async function () {
    this.timeout(DT_EDGES_TIMEOUT_MS);

    await startNewV4Draft();
    await switchV4Model(modelProvider, modelName, modelThought);
    await sendV4Prompt("E2E_DT_DOUBLE_DEMOTE 慢慢回答这个问题");
    await waitForV4ComposerText("", "double-demote 消息发送后输入框没有清空");
    await waitForV4UserMessageContaining("E2E_DT_DOUBLE_DEMOTE");
    await waitForV4Pane(
      (snapshot) => snapshot.canStop,
      "double-demote 首轮没有进入 running（canStop）",
      45000,
    );
    await waitForV4TimelineContaining("dt-double-streaming", 45000);

    // 同一帧连点两次：两次 click 必须在同一轮 React 状态刷新前发出，覆盖重复 demote 的幂等边界。
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
      TID_V4_COMPOSER_BACKGROUND_TURN,
    );
    expect(doubleClicked).toBe(true);

    let acks: Array<{ status: string; reasonCode?: string }> = [];
    await browser.waitUntil(
      async () => {
        acks = await getV4CommandAcksOfType("backgroundTurn");
        return acks.length >= 2;
      },
      { timeout: 30000, timeoutMsg: "double-demote 没有返回两条 backgroundTurn ACK" },
    );
    expect(acks[0]!.status).toBe("accepted");
    expect(acks[1]!.status).toBe("noop");
    expect(acks[1]!.reasonCode).toBe("guard.stopTargetChanged");

    // 只有一条 detached 行；前台已收口，turn 不中断（部分正文仍在）。
    await waitForV4Pane(
      (snapshot) => !snapshot.canStop,
      "double-demote 后没有退出 running 相位",
      30000,
    );
    await openV4ComposerRunningBackgroundWorks();
    await expandV4TurnStatusSection();
    const detachedRows = await getV4DetachedTurnRows();
    expect(detachedRows).toHaveLength(1);
    expect(detachedRows[0]!.status).toBe("running");

    // 原_turn 正常完成：单一 wake，无第二条 detached 行或双份通知。
    await releaseControlledReplay("upstream-dt-edges-double-controlled-stream");
    await waitForUpstreamRequest(
      {
        includes: ["<task-notification>", "E2E_DT_DOUBLE_DEMOTE"],
        excludes: [TITLE_SENTINEL],
      },
      "double-demote 后没有发出 backgroundResult wake 请求",
      90000,
    );
    await waitForV4AssistantMessageContaining("dt-double-wake-ok", 90000);
    await waitForV4ConversationState(
      (snapshot) => snapshot.state !== "streaming" && snapshot.queueCount === 0,
      "double-demote wake 收口后会话没有回到 idle",
      90000,
    );
    expect(
      await countUpstreamRequestsContainingAll(["<task-notification>", "E2E_DT_DOUBLE_DEMOTE"]),
    ).toBe(1);
    expect(await getV4DetachedTurnRows()).toEqual([]);
  });
});

/** 主停止控件（TID_V4_STOP）是否存在于 DOM。 */
function hasV4StopControl(): Promise<boolean> {
  return browser.execute(
    (stopTestId) => Boolean(document.querySelector(`[data-testid="${stopTestId}"]`)),
    TID_V4_STOP,
  );
}

interface DetachedTurnRowSnapshot {
  kind: string | null;
  status: string | null;
  workId: string;
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

/** 等待任务行出现 pending permission badge（TaskInteractionBadge / attention 文案）。 */
async function waitForTaskRowPermissionBadge(sessionId: string) {
  await browser.waitUntil(
    async () =>
      browser.execute(
        (rowTestId) => {
          const row = document.querySelector(`[data-testid="${rowTestId}"]`);
          if (!row) return false;
          if (row.querySelector('[data-task-interaction-badge="permission"]')) return true;
          return Array.from(row?.querySelectorAll('[data-slot="badge"]') ?? []).some((badge) =>
            /^(等待确认|Awaiting approval)$/.test(badge.textContent?.trim() ?? ""),
          );
        },
        testId(TID_TASK_ITEM, sessionId),
      ),
    {
      timeout: 30000,
      timeoutMsg: `DT05 demote 后任务行没有显示 pending interaction badge: ${sessionId}`,
    },
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
