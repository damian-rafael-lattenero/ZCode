import type {
  BackgroundExecutionSnapshot,
  BackgroundExecutionStartResult,
  ExecutionPort,
  ExecutionRequest,
  ExecutionResult,
  ExecutionRunOptions,
} from "@zcode/contracts";

export type BashBackgroundLifecycleMode = "explicit" | "auto_on_timeout" | "manual";

export type BashBackgroundLifecycleResult =
  | {
      kind: "foreground";
      result: ExecutionResult;
    }
  | {
      kind: "backgrounded";
      task: BackgroundExecutionStartResult;
      /** 仅外部（用户 backgroundToolCall）触发时置位：handler 据此改写合成输出文案。 */
      requestedBy?: "user";
    };

export interface BashBackgroundLifecycleExecutionPort extends ExecutionPort {
  runBashWithBackgroundLifecycle(
    request: ExecutionRequest,
    lifecycle: { mode: BashBackgroundLifecycleMode },
    options?: ExecutionRunOptions,
  ): Promise<BashBackgroundLifecycleResult>;
  /**
   * BT（2026-11-05）：按 toolCallId 把仍在跑的前台 Bash 原子移交后台（进程不动、不 abort）。
   * 命中返回后台 workId（≡ tracker 的 taskId）；无在跑前台 / 已终态返回 undefined。
   * 可选能力：runtime 与 handler 均鸭子类型探测，fakes 无需实现。
   */
  requestBackgroundByToolCallId?(toolCallId: string): string | undefined;
}

export function supportsBashBackgroundRequestByToolCallId(
  executionPort: ExecutionPort | undefined,
): executionPort is BashBackgroundLifecycleExecutionPort {
  return (
    typeof (executionPort as Partial<BashBackgroundLifecycleExecutionPort>)
      .requestBackgroundByToolCallId === "function"
  );
}

export function supportsBashBackgroundLifecycle(
  executionPort: ExecutionPort,
): executionPort is BashBackgroundLifecycleExecutionPort {
  return (
    typeof (executionPort as Partial<BashBackgroundLifecycleExecutionPort>)
      .runBashWithBackgroundLifecycle === "function"
  );
}

/**
 * 后台任务终态等待：与上面的后台生命周期一样在 ExecutionPort 接口之外，
 * 由 executor 的后台追踪按鸭子类型探测。缺这个能力时追踪只能退回 1 秒轮询。
 */
export interface BackgroundTaskWaiterExecutionPort extends ExecutionPort {
  waitForBackgroundTask(
    taskId: string,
    options?: { signal?: AbortSignal },
  ): Promise<BackgroundExecutionSnapshot | undefined>;
}

export function supportsBackgroundTaskWaiter(
  executionPort: ExecutionPort,
): executionPort is BackgroundTaskWaiterExecutionPort {
  return (
    typeof (executionPort as Partial<BackgroundTaskWaiterExecutionPort>).waitForBackgroundTask ===
    "function"
  );
}
