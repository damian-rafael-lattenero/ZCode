import { SessionEventType, traceContextToLogContext } from "../deps.js";
import type { TraceContext, TurnId } from "@zcode/contracts";
import { formatTaskNotification } from "../../runtime-task/notification.js";
import { isTerminalRuntimeTask } from "../../runtime-task/registry.js";
import type { RuntimeTaskSnapshot } from "../../runtime-task/registry.js";
import { CoreErrorType, isCoreError } from "../deps.js";
import type { PromptRuntimeCommand } from "../command-queue.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type {
  ActiveForegroundExecutionState,
  BackgroundActiveForegroundExecutionOptions,
  BackgroundActiveForegroundExecutionResult,
  DetachedTurnHandle,
  ForegroundDetachmentState,
  TurnResult,
} from "../types.js";

/**
 * DT 分组（2026-11-04）：运行中的 primaryTurn 由用户主动 demote 为 backgroundTurn。
 *
 * 归属移交沿用 subagent runner 的 ownership-handoff race：
 * - 等待侧（runRuntimeCommand 的 prompt 分支）把 turn 完成与 registry 的
 *   waitForBackgroundRequest 放进同一 race；
 * - 请求侧（backgroundActiveForegroundExecution）做身份守卫后 requestBackground，
 *   race 即刻裁决 → 前台命令提前 resolve、AbortController 父链断开
 *   （analog of taskAbort.detachParent()），turn 不中断继续执行；
 * - detached turn 以 taskKind "turn" 登记进 runtime task registry：residency 保护、
 *   cancelBackgroundWork、BackgroundTask* 事件管线全部自动适用。
 */

/** prompt 命令的 detach 装置；armForegroundTurnDetachment 的返回值。 */
export interface ArmedForegroundTurnDetachment {
  state: ForegroundDetachmentState;
  /** waitForBackgroundRequest 包装：resolve(task) = 已请求后台；resolve(undefined) = turn 已先收口。 */
  backgroundRequestPromise: Promise<RuntimeTaskSnapshot | undefined>;
}

/** demotion 面向用户的行标题；截断到通知/面板都可接受的长度。 */
function detachedTurnTitle(input: string): string {
  const normalized = input.replace(/\s+/g, " ").trim();
  if (normalized.length === 0) return "Background turn";
  const MAX_TITLE_CHARS = 80;
  return normalized.length <= MAX_TITLE_CHARS
    ? normalized
    : `${normalized.slice(0, MAX_TITLE_CHARS)}…`;
}

/**
 * prompt 命令开始执行时武装 demote 移交：登记 local_turn registry 条目
 * （isBackgrounded=false，尚属前台）并挂上 detach 句柄。
 * startReservation 缺席（非 admission 路径的 prompt）不武装——demote 命令的身份守卫
 * 无法对齐这种执行。
 */
export function armForegroundTurnDetachment(
  this: AgentRuntimeInternal,
  command: PromptRuntimeCommand,
  foregroundExecution: ActiveForegroundExecutionState,
): ArmedForegroundTurnDetachment | undefined {
  const turnId = command.startReservation?.turnId;
  if (!turnId) return undefined;
  const taskId = `turn_${foregroundExecution.foregroundExecutionId}`;
  const title = detachedTurnTitle(command.input);
  this.runtimeTaskRegistry.register({
    agentId: taskId,
    agentType: "local_turn",
    command: command.input,
    description: title,
    isBackgrounded: false,
    prompt: command.input,
    startedAt: new Date(),
    status: "running",
    taskId,
    taskType: "local_turn",
    type: "local_turn",
    turnId,
  } as RuntimeTaskSnapshot);

  let requested = false;
  let requestResolve!: (accepted: boolean) => void;
  const requestedPromise = new Promise<boolean>((resolve) => {
    requestResolve = resolve;
  });
  const state: ForegroundDetachmentState = {
    taskId,
    request: () => {
      if (requested) return true;
      // requestBackground 在条目已终结/移除（turn 先收口）时返回 false，请求落空。
      const accepted = this.runtimeTaskRegistry.requestBackground(taskId);
      if (accepted) {
        requested = true;
        requestResolve(true);
      }
      return accepted;
    },
    requested: requestedPromise,
  };
  foregroundExecution.detach = state;
  return {
    state,
    backgroundRequestPromise: this.runtimeTaskRegistry.waitForBackgroundRequest(taskId),
  };
}

/**
 * turn 先于 demote 请求收口：摘除武装条目，registry 回到 demote 前的形状
 * （local_turn 从未对投影可见）。此后 request() 返回 false，demote 落空为 idle。
 */
export function releaseArmedForegroundTurnDetachment(
  this: AgentRuntimeInternal,
  detachment: ArmedForegroundTurnDetachment,
): void {
  this.runtimeTaskRegistry.remove(detachment.state.taskId);
}

/**
 * demote 请求命中：断开 AbortController 父链、登记取消句柄、发射 demotion 事件，
 * 然后把 turn 的 settle 挂到后台跟踪。调用方负责提前 resolve 前台命令。
 */
export async function beginDetachedTurnTracking(
  this: AgentRuntimeInternal,
  input: {
    command: PromptRuntimeCommand;
    controller: AbortController;
    detachment: ArmedForegroundTurnDetachment;
    foregroundExecutionId: string;
    traceContext: TraceContext;
    turnPromise: Promise<TurnResult>;
  },
): Promise<void> {
  const turnId = input.command.startReservation?.turnId;
  if (!turnId) return;
  const handle: DetachedTurnHandle = {
    controller: input.controller,
    foregroundExecutionId: input.foregroundExecutionId,
    taskId: input.detachment.state.taskId,
    turnId,
    title: detachedTurnTitle(input.command.input),
  };
  this.detachedTurns.set(turnId, handle);
  await this.appendEvent(
    this.createEvent(
      SessionEventType.BackgroundTurnDemoted,
      {
        foregroundExecutionId: input.foregroundExecutionId,
        taskId: handle.taskId,
        ...(turnId ? { turnId } : {}),
        ...(input.command.options?.inputId ? { inputId: input.command.options.inputId } : {}),
        title: handle.title,
      },
      input.traceContext,
    ),
    input.traceContext,
  );
  await this.appendEvent(
    this.createEvent(
      SessionEventType.BackgroundTaskStarted,
      detachedTurnTaskPayload(handle, "running", { cancellable: true }),
      input.traceContext,
    ),
    input.traceContext,
  );
  void input.turnPromise.then(
    (result) => void settleDetachedTurn.call(this, handle, { result }),
    (error) => void settleDetachedTurn.call(this, handle, { error }),
  );
}

/**
 * foregroundTurn demote 原语：身份守卫与 stop 相同（mismatch = noop，绝不 abort）。
 * 命中即转移归属；前台命令由等待侧提前 resolve，本方法不等待 turn 收口。
 */
export function backgroundActiveForegroundExecution(
  this: AgentRuntimeInternal,
  options: BackgroundActiveForegroundExecutionOptions = {},
): BackgroundActiveForegroundExecutionResult {
  const active = this.activeForegroundExecution;
  if (!active || active.controller.signal.aborted) {
    return { kind: "idle" };
  }
  if (
    options.expectedForegroundExecutionId !== undefined &&
    options.expectedForegroundExecutionId !== active.foregroundExecutionId
  ) {
    return {
      kind: "mismatch",
      activeForegroundExecutionId: active.foregroundExecutionId,
    };
  }
  const detach = active.detach;
  if (!detach) {
    // compact / verifier / notification batch 等不可移交执行：demote 为 noop。
    return {
      kind: "unsupported",
      activeForegroundExecutionId: active.foregroundExecutionId,
    };
  }
  const accepted = detach.request();
  if (!accepted) return { kind: "idle" };
  this.logger?.info?.("Foreground turn demoted to background turn", {
    ...traceContextToLogContext(options.traceContext ?? this.rootTraceContext),
    event: "runtime.background_turn.demoted",
    foregroundExecutionId: active.foregroundExecutionId,
    module: "core.runtime",
    workId: detach.taskId,
  });
  return {
    foregroundExecutionId: active.foregroundExecutionId,
    kind: "demoted",
    workId: detach.taskId,
  };
}

/**
 * 未收口的 detached turn 是否存在。bootstrap 的 queue auto-drain gate 以此阻塞队首消费
 * （backgroundTurnHoldsQueueDrain）；runtime command drain 亦用它暂停出队。
 */
export function hasUnsettledBackgroundTurn(this: AgentRuntimeInternal): boolean {
  return Object.values(this.runtimeTaskRegistry.all()).some(
    (task) => task.type === "local_turn" && task.status === "running",
  );
}

function detachedTurnTaskPayload(
  handle: DetachedTurnHandle,
  status: "running" | "completed" | "cancelled" | "failed",
  overrides: { cancellable?: boolean; resultText?: string } = {},
): Record<string, unknown> {
  return {
    cancellable: overrides.cancellable ?? false,
    completedAt: status === "running" ? undefined : new Date(),
    description: handle.title,
    status,
    taskKind: "turn",
    taskId: handle.taskId,
    toolName: "Turn",
    ...(overrides.resultText ? { resultText: overrides.resultText } : {}),
  };
}

/**
 * detached turn 结算：registry 终态 + BackgroundTaskCompleted；仅正常完成产生
 * backgroundResult wake（backgroundTurnCompletionIsBackgroundResult），取消/失败不 wake。
 */
async function settleDetachedTurn(
  this: AgentRuntimeInternal,
  handle: DetachedTurnHandle,
  outcome: { error?: unknown; result?: TurnResult },
): Promise<void> {
  this.detachedTurns.delete(handle.turnId);
  const task = this.runtimeTaskRegistry.get(handle.taskId);
  const traceContext = this.rootTraceContext;
  if (!task || isTerminalRuntimeTask(task)) return;
  const cancelled = outcome.error !== undefined && isDetachedTurnCancellation(handle, outcome.error);
  if (outcome.error !== undefined) {
    this.logger?.warn?.("Detached background turn failed", {
      ...traceContextToLogContext(traceContext),
      errorMessage:
        outcome.error instanceof Error ? outcome.error.message : String(outcome.error),
      event: "runtime.background_turn.failed",
      module: "core.runtime",
      status: cancelled ? "cancelled" : "failed",
      workId: handle.taskId,
    });
    this.runtimeTaskRegistry.update(handle.taskId, (current) => ({
      ...current,
      completedAt: new Date(),
      error:
        outcome.error instanceof Error ? outcome.error.message : String(outcome.error),
      status: cancelled ? "cancelled" : "failed",
    }));
    await this.appendEvent(
      this.createEvent(
        SessionEventType.BackgroundTaskCompleted,
        detachedTurnTaskPayload(handle, cancelled ? "cancelled" : "failed"),
        traceContext,
      ),
      traceContext,
    );
    // settlement 释放 drain hold；失败/取消没有 wake，必须显式恢复 runtime 命令出队。
    void this.drainRuntimeCommandQueue();
    return;
  }
  const resultText = outcome.result?.response ?? "";
  this.runtimeTaskRegistry.update(handle.taskId, (current) => ({
    ...current,
    completedAt: new Date(),
    resultText,
    status: "completed",
  }));
  await this.appendEvent(
    this.createEvent(
      SessionEventType.BackgroundTaskCompleted,
      detachedTurnTaskPayload(handle, "completed", { resultText }),
      traceContext,
    ),
    traceContext,
  );
  this.logger?.info?.("Detached background turn completed; wake enqueued", {
    ...traceContextToLogContext(traceContext),
    event: "runtime.background_turn.completed",
    module: "core.runtime",
    workId: handle.taskId,
  });
  this.enqueueBackgroundTaskNotification({
    originMeta: {
      backgroundSource: "turn",
      title: handle.title,
      workId: handle.taskId,
    },
    taskId: handle.taskId,
    text: formatTaskNotification({
      description: handle.title,
      result: resultText,
      status: "completed",
      summary: `Background turn "${handle.title}" completed`,
      taskId: handle.taskId,
      taskType: "local_turn",
    }),
    traceContext,
  });
}

function isDetachedTurnCancellation(handle: DetachedTurnHandle, error: unknown): boolean {
  if (handle.controller.signal.aborted) return true;
  return isCoreError(error) && error.type === CoreErrorType.TurnCancelled;
}
