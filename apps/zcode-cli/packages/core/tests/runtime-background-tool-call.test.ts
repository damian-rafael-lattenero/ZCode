// BT (2026-11-05, OpenCode ctrl+b parity): the runtime primitive
// backgroundRunningToolCall. Three legs share one guard contract:
// - Bash: the executionPort toolCallId registry decides (hit → backgrounded,
//   the process is untouched; unknown/terminal → noop, never an abort);
// - Agent: the runtime task registry decides by parentToolCallId (local_agent
//   still foreground → backgrounded through the subagent port; anything else
//   → noop);
// - Generic tool (BT 2.0): the executor's DetachedToolTaskStore decides by
//   toolCallId (backgrounding-capable and still running → backgrounded; any
//   other miss → noop). A runtime with no handoff leg at all is unsupported.
// These tests use a minimal internal stub and call the method directly.
import { describe, expect, it, vi } from "vitest";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";
import type { RuntimeTaskSnapshot } from "../src/runtime-task/registry.js";
import type { ToolBackgroundRequestResult } from "../src/tool/executor/detached-tool-tasks.js";
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
  executor?: Record<string, unknown>;
  logger?: Record<string, unknown>;
  subagentPort?: Record<string, unknown>;
  tasks?: RuntimeTaskSnapshot[];
} = {}): AgentRuntimeInternal {
  const tasks = overrides.tasks ?? [];
  return {
    executionPort: overrides.executionPort,
    executor: overrides.executor,
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

  it("通用工具第三腿命中：委托 executor.requestBackgroundToolCall 并返回 backgrounded(workId)", async () => {
    const requestBackgroundToolCall = vi.fn(
      (): ToolBackgroundRequestResult => ({ kind: "backgrounded", workId: "toolbg_1" }),
    );
    const logger = { info: vi.fn() };
    const result = await backgroundRunningToolCall.call(
      internalWith({
        executionPort: {},
        executor: { requestBackgroundToolCall },
        logger,
      }),
      "toolu_grep",
    );

    expect(result).toEqual({ kind: "backgrounded", workId: "toolbg_1" });
    expect(requestBackgroundToolCall).toHaveBeenCalledWith("toolu_grep");
    expect(logger.info).toHaveBeenCalled();
  });

  it("通用工具第三腿未命中（store 守卫 miss）：noop", async () => {
    const requestBackgroundToolCall = vi.fn(
      (): ToolBackgroundRequestResult => ({ kind: "noop" }),
    );
    await expect(
      backgroundRunningToolCall.call(
        internalWith({ executionPort: {}, executor: { requestBackgroundToolCall } }),
        "toolu_grep",
      ),
    ).resolves.toEqual({ kind: "noop" });
    expect(requestBackgroundToolCall).toHaveBeenCalledWith("toolu_grep");
  });

  it("executor 明确回 unsupported 但腿在场：整体仍是 noop，不冒充运行时级不支持", async () => {
    const requestBackgroundToolCall = vi.fn(
      (): ToolBackgroundRequestResult => ({ kind: "unsupported" }),
    );
    await expect(
      backgroundRunningToolCall.call(
        internalWith({ executionPort: {}, executor: { requestBackgroundToolCall } }),
        "toolu_read",
      ),
    ).resolves.toEqual({ kind: "noop" });
  });

  it("Bash 腿优先：命中后不再询问 executor", async () => {
    const requestBackgroundToolCall = vi.fn(
      (): ToolBackgroundRequestResult => ({ kind: "backgrounded", workId: "toolbg_never" }),
    );
    const result = await backgroundRunningToolCall.call(
      internalWith({
        executionPort: { requestBackgroundByToolCallId: () => "exec_user_bg" },
        executor: { requestBackgroundToolCall },
      }),
      "toolu_1",
    );

    expect(result).toEqual({ kind: "backgrounded", workId: "exec_user_bg" });
    expect(requestBackgroundToolCall).not.toHaveBeenCalled();
  });
});
