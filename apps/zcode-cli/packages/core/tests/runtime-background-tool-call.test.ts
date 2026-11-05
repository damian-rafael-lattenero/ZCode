// BT（2026-11-05，OpenCode ctrl+b 复刻）：runtime 原语 backgroundRunningToolCall。
// 身份守卫在 executionPort 的 toolCallId 登记表：命中 → backgrounded(workId)、进程不动；
// 未知/已终态 → noop 不抛错；端口缺能力 → unsupported。这里用最小 internal 桩直测方法。
import { describe, expect, it, vi } from "vitest";
import { backgroundRunningToolCall } from "../src/runtime/methods/background-tool-call.js";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";

function internalWith(overrides: {
  executionPort?: Record<string, unknown>;
  logger?: Record<string, unknown>;
} = {}): AgentRuntimeInternal {
  return {
    executionPort: overrides.executionPort,
    logger: overrides.logger,
    rootTraceContext: { traceId: "trace_bt" },
  } as unknown as AgentRuntimeInternal;
}

describe("backgroundRunningToolCall（BT 用户移交）", () => {
  it("命中：委托 executionPort 的移交入口并返回 backgrounded(workId)", () => {
    const requestBackgroundByToolCallId = vi.fn(() => "exec_user_bg");
    const logger = { info: vi.fn() };
    const result = backgroundRunningToolCall.call(
      internalWith({ executionPort: { requestBackgroundByToolCallId }, logger }),
      "toolu_1",
      { traceContext: { traceId: "trace_bt" } },
    );

    expect(result).toEqual({ kind: "backgrounded", workId: "exec_user_bg" });
    expect(requestBackgroundByToolCallId).toHaveBeenCalledWith("toolu_1");
    expect(logger.info).toHaveBeenCalled();
  });

  it("未知 toolCallId：noop，不抛错、不触碰端口以外的状态", () => {
    const requestBackgroundByToolCallId = vi.fn(() => undefined);
    const result = backgroundRunningToolCall.call(
      internalWith({ executionPort: { requestBackgroundByToolCallId } }),
      "toolu_unknown",
    );

    expect(result).toEqual({ kind: "noop" });
  });

  it("executionPort 缺移交能力：unsupported", () => {
    expect(
      backgroundRunningToolCall.call(internalWith({ executionPort: {} }), "toolu_1"),
    ).toEqual({ kind: "unsupported" });
    expect(
      backgroundRunningToolCall.call(internalWith({}), "toolu_1"),
    ).toEqual({ kind: "unsupported" });
  });
});
