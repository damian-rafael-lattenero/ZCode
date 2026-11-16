// BT (2026-11-05, OpenCode ctrl+b parity): the runtime primitive
// backgroundRunningToolCall. Two legs share one guard contract:
// - Bash: the executionPort toolCallId registry decides (hit → backgrounded,
//   the process is untouched; unknown/terminal → noop, never an abort);
// - Agent: the runtime task registry decides by parentToolCallId (local_agent
//   still foreground → backgrounded through the subagent port; anything else
//   → noop). A port that lacks the capability produces unsupported.
// These tests use a minimal internal stub and call the method directly.
import { describe, expect, it, vi } from "vitest";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";
import type { RuntimeTaskSnapshot } from "../src/runtime-task/registry.js";
import { backgroundRunningToolCall } from "../src/runtime/methods/background-tool-call.js";

function agentTask(overrides: Partial<RuntimeTaskSnapshot> = {}): RuntimeTaskSnapshot {
  return {
    agentId: "agent_1",
    agentType: "general-purpose",
    description: "investigate",
    isBackgrounded: false,
    parentToolCallId: "toolu_agent",
    startedAt: new Date(0),
    status: "running",
    taskId: "agent_1",
    type: "local_agent",
    ...overrides,
  } as RuntimeTaskSnapshot;
}

function internalWith(overrides: {
  executionPort?: Record<string, unknown>;
  logger?: Record<string, unknown>;
  subagentPort?: Record<string, unknown>;
  tasks?: RuntimeTaskSnapshot[];
} = {}): AgentRuntimeInternal {
  const tasks = overrides.tasks ?? [];
  return {
    executionPort: overrides.executionPort,
    logger: overrides.logger,
    rootTraceContext: { traceId: "trace_bt" },
    runtimeTaskRegistry: {
      all: () => Object.fromEntries(tasks.map((task) => [task.taskId, task])),
      get: (id: string) => tasks.find((task) => task.taskId === id),
    },
    subagentPort: overrides.subagentPort,
  } as unknown as AgentRuntimeInternal;
}

describe("backgroundRunningToolCall（BT 用户移交）", () => {
  it("Bash 命中：委托 executionPort 的移交入口并返回 backgrounded(workId)", async () => {
    const requestBackgroundByToolCallId = vi.fn(() => "exec_user_bg");
    const logger = { info: vi.fn() };
    const result = await backgroundRunningToolCall.call(
      internalWith({ executionPort: { requestBackgroundByToolCallId }, logger }),
      "toolu_1",
      { traceContext: { traceId: "trace_bt" } },
    );

    expect(result).toEqual({ kind: "backgrounded", workId: "exec_user_bg" });
    expect(requestBackgroundByToolCallId).toHaveBeenCalledWith("toolu_1");
    expect(logger.info).toHaveBeenCalled();
  });

  it("Bash 未知 toolCallId：noop，不抛错、不触碰端口以外的状态", async () => {
    const requestBackgroundByToolCallId = vi.fn(() => undefined);
    const result = await backgroundRunningToolCall.call(
      internalWith({ executionPort: { requestBackgroundByToolCallId } }),
      "toolu_unknown",
    );

    expect(result).toEqual({ kind: "noop" });
  });

  it("两个 port 都缺移交能力：unsupported", async () => {
    await expect(
      backgroundRunningToolCall.call(internalWith({ executionPort: {} }), "toolu_1"),
    ).resolves.toEqual({ kind: "unsupported" });
    await expect(
      backgroundRunningToolCall.call(internalWith({}), "toolu_1"),
    ).resolves.toEqual({ kind: "unsupported" });
  });

  it("Agent 命中：按 parentToolCallId 找 local_agent 并委托 subagentPort", async () => {
    const task = agentTask();
    const backgroundTask = vi.fn(async () => {
      task.isBackgrounded = true;
      return task;
    });
    const logger = { info: vi.fn() };
    const result = await backgroundRunningToolCall.call(
      internalWith({
        executionPort: {},
        logger,
        subagentPort: { backgroundTask },
        tasks: [task],
      }),
      "toolu_agent",
    );

    expect(result).toEqual({ kind: "backgrounded", workId: "agent_1" });
    expect(backgroundTask).toHaveBeenCalledWith("agent_1");
    expect(logger.info).toHaveBeenCalled();
  });

  it("Bash 端口在场但未命中时，仍落到 Agent 那条腿", async () => {
    const task = agentTask();
    const backgroundTask = vi.fn(async () => {
      task.isBackgrounded = true;
      return task;
    });
    const result = await backgroundRunningToolCall.call(
      internalWith({
        executionPort: { requestBackgroundByToolCallId: () => undefined },
        subagentPort: { backgroundTask },
        tasks: [task],
      }),
      "toolu_agent",
    );

    expect(result).toEqual({ kind: "backgrounded", workId: "agent_1" });
    expect(backgroundTask).toHaveBeenCalledWith("agent_1");
  });

  it("off-peak 借用执行拒绝移交（registry 未翻 backgrounded）：noop", async () => {
    const task = agentTask();
    const backgroundTask = vi.fn(async () => task);
    const result = await backgroundRunningToolCall.call(
      internalWith({
        executionPort: {},
        subagentPort: { backgroundTask },
        tasks: [task],
      }),
      "toolu_agent",
    );

    expect(result).toEqual({ kind: "noop" });
    expect(backgroundTask).toHaveBeenCalledWith("agent_1");
  });

  it("Agent 已后台/已终态/不匹配：noop 且不调用 subagentPort", async () => {
    const backgroundTask = vi.fn(async () => agentTask({ isBackgrounded: true }));
    const cases: RuntimeTaskSnapshot[][] = [
      [agentTask({ isBackgrounded: true })],
      [agentTask({ status: "completed" })],
      [agentTask({ parentToolCallId: "toolu_other" })],
      [],
    ];
    for (const tasks of cases) {
      await expect(
        backgroundRunningToolCall.call(
          internalWith({ executionPort: {}, subagentPort: { backgroundTask }, tasks }),
          "toolu_agent",
        ),
      ).resolves.toEqual({ kind: "noop" });
    }
    expect(backgroundTask).not.toHaveBeenCalled();
  });
});
