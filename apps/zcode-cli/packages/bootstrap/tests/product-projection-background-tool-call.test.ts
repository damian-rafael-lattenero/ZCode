// BT（2026-11-05，OpenCode ctrl+b 复刻）：Bash 后台生命周期事件把工具行翻成 backgrounded
// 态。BackgroundTaskStarted（taskKind "bash"，payload.toolCallId）→ 工具行
// backgrounded:true + workId，BackgroundWorkSummary.anchorRowId 锚到该行；重复/终态事件
// 幂等不重翻；非 bash（subagent/turn）事件不翻工具行。harness 风格参照
// product-projection-bash-progress.test.ts。
import { describe, expect, it } from "vitest";
import { SessionEventType, type SessionEvent } from "@zcode/contracts";
import {
  conversationDeltaSchema,
  type BackgroundWorkSummary,
  type ToolCallRow,
} from "@zcode/shared/zcode-protocol-v4";
import { ProductProjection } from "../src/zcode-protocol-v4/index.js";

function harness() {
  const projection = new ProductProjection("bg-tool-call", "epoch");
  let seq = 0;
  const apply = (type: SessionEvent["type"], payload: unknown) =>
    projection.applyEvent({
      id: `event-${++seq}`,
      sessionId: "bg-tool-call",
      turnId: "turn-1",
      traceId: "trace",
      timestamp: new Date(1700000000000 + seq),
      sequenceNumber: seq,
      type,
      payload,
    } as SessionEvent);
  apply(SessionEventType.SessionCreated, { mode: "default", contextWindow: 200000 });
  apply(SessionEventType.TurnStarted, { turnNumber: 1, input: "run", messageId: "user-1" });
  apply(SessionEventType.ToolCallScheduled, {
    toolCallId: "bash-1",
    toolName: "Bash",
    input: { command: "sleep 30" },
    schedule: { parallelGroups: [["bash-1"]], executionOrder: ["bash-1"] },
  });
  apply(SessionEventType.ToolCallStarted, { toolCallId: "bash-1", toolName: "Bash" });
  const row = (): ToolCallRow | undefined =>
    projection
      .getSnapshot()
      .rows.window.find((r) => r.kind === "toolCall" && r.toolCallId === "bash-1") as
      | ToolCallRow
      | undefined;
  const work = (): BackgroundWorkSummary | undefined =>
    projection.getSnapshot().backgroundWorks.find((w) => w.workId === "exec_user_bg");
  const backgroundStarted = () =>
    apply(SessionEventType.BackgroundTaskStarted, {
      taskId: "exec_user_bg",
      toolCallId: "bash-1",
      toolName: "Bash",
      taskKind: "bash",
      command: "sleep 30",
      status: "running",
      cancellable: true,
    });
  return { projection, apply, row, work, backgroundStarted };
}

describe("bash background tool call projection flip", () => {
  it("BackgroundTaskStarted flips the tool row to backgrounded and anchors the summary", () => {
    const h = harness();
    const deltas = h.backgroundStarted();

    const flipped = h.row();
    expect(flipped?.backgrounded).toBe(true);
    expect(flipped?.workId).toBe("exec_user_bg");

    const summary = h.work();
    expect(summary?.status).toBe("running");
    expect(summary?.anchorRowId).toBe(flipped?.rowId);

    expect(deltas.some((d) => d.op === "row.upserted" && d.row.kind === "toolCall")).toBe(true);
    for (const delta of deltas) expect(conversationDeltaSchema.parse(delta)).toEqual(delta);
  });

  it("repeat lifecycle events are idempotent: no second flip, anchor stays", () => {
    const h = harness();
    h.backgroundStarted();
    const firstRowId = h.row()?.rowId;

    const repeat = h.backgroundStarted();
    expect(repeat.some((d) => d.op === "row.upserted")).toBe(false);
    expect(h.row()?.backgrounded).toBe(true);
    expect(h.row()?.rowId).toBe(firstRowId);
    expect(h.work()?.anchorRowId).toBe(firstRowId);
  });

  it("row flip survives later running updates without re-flipping", () => {
    const h = harness();
    h.backgroundStarted();
    h.apply(SessionEventType.BackgroundTaskUpdated, {
      taskId: "exec_user_bg",
      toolCallId: "bash-1",
      toolName: "Bash",
      taskKind: "bash",
      status: "running",
      stdoutBytes: 128,
    });
    expect(h.row()?.backgrounded).toBe(true);
    expect(h.work()?.anchorRowId).toBe(h.row()?.rowId);
  });

  it("non-bash lifecycle events (turn) do not flip tool rows", () => {
    const h = harness();
    h.apply(SessionEventType.BackgroundTaskStarted, {
      taskId: "turn_exec_1",
      toolCallId: "bash-1",
      taskKind: "turn",
      description: "Background turn",
      status: "running",
    });
    expect(h.row()?.backgrounded).toBeUndefined();
    expect(h.row()?.workId).toBeUndefined();
  });

  it("unknown toolCallId keeps the summary without anchor", () => {
    const projection = new ProductProjection("bg-tool-call", "epoch");
    let seq = 0;
    const apply = (type: SessionEvent["type"], payload: unknown) =>
      projection.applyEvent({
        id: `event-${++seq}`,
        sessionId: "bg-tool-call",
        turnId: "turn-1",
        traceId: "trace",
        timestamp: new Date(1700000000000 + seq),
        sequenceNumber: seq,
        type,
        payload,
      } as SessionEvent);
    apply(SessionEventType.SessionCreated, { mode: "default", contextWindow: 200000 });
    apply(SessionEventType.BackgroundTaskStarted, {
      taskId: "exec_lost_row",
      toolCallId: "bash-ghost",
      toolName: "Bash",
      taskKind: "bash",
      command: "sleep 30",
      status: "running",
    });
    const summary = projection
      .getSnapshot()
      .backgroundWorks.find((w) => w.workId === "exec_lost_row");
    expect(summary?.status).toBe("running");
    expect(summary?.anchorRowId).toBeNull();
  });
});

describe("generic tool background projection flip (BT 2.0)", () => {
  function toolHarness() {
    const projection = new ProductProjection("bg-generic-tool", "epoch");
    let seq = 0;
    const apply = (type: SessionEvent["type"], payload: unknown) =>
      projection.applyEvent({
        id: `event-${++seq}`,
        sessionId: "bg-generic-tool",
        turnId: "turn-1",
        traceId: "trace",
        timestamp: new Date(1700000000000 + seq),
        sequenceNumber: seq,
        type,
        payload,
      } as SessionEvent);
    apply(SessionEventType.SessionCreated, { mode: "default", contextWindow: 200000 });
    apply(SessionEventType.TurnStarted, { turnNumber: 1, input: "search", messageId: "user-1" });
    apply(SessionEventType.ToolCallScheduled, {
      toolCallId: "grep-1",
      toolName: "Grep",
      input: { pattern: "needle" },
      schedule: { parallelGroups: [["grep-1"]], executionOrder: ["grep-1"] },
    });
    apply(SessionEventType.ToolCallStarted, { toolCallId: "grep-1", toolName: "Grep" });
    const toolRow = (): ToolCallRow | undefined =>
      projection
        .getSnapshot()
        .rows.window.find((r) => r.kind === "toolCall" && r.toolCallId === "grep-1") as
        | ToolCallRow
        | undefined;
    const work = (): BackgroundWorkSummary | undefined =>
      projection.getSnapshot().backgroundWorks.find((w) => w.workId === "toolbg_1");
    const backgroundStarted = () =>
      apply(SessionEventType.BackgroundTaskStarted, {
        taskId: "toolbg_1",
        toolCallId: "grep-1",
        toolName: "Grep",
        taskKind: "tool",
        description: "needle",
        status: "running",
        cancellable: true,
      });
    return { apply, backgroundStarted, toolRow, work };
  }

  it("taskKind tool flips the tool row to backgrounded and anchors a tool summary", () => {
    const h = toolHarness();
    const deltas = h.backgroundStarted();

    const flipped = h.toolRow();
    expect(flipped?.backgrounded).toBe(true);
    expect(flipped?.workId).toBe("toolbg_1");

    const summary = h.work();
    expect(summary?.kind).toBe("tool");
    expect(summary?.status).toBe("running");
    expect(summary?.anchorRowId).toBe(flipped?.rowId);

    expect(deltas.some((d) => d.op === "row.upserted" && d.row.kind === "toolCall")).toBe(true);
    for (const delta of deltas) expect(conversationDeltaSchema.parse(delta)).toEqual(delta);
  });

  it("repeat tool lifecycle events are idempotent and terminal updates keep the anchor", () => {
    const h = toolHarness();
    h.backgroundStarted();
    const firstRowId = h.toolRow()?.rowId;

    expect(h.backgroundStarted().some((d) => d.op === "row.upserted")).toBe(false);
    h.apply(SessionEventType.BackgroundTaskCompleted, {
      taskId: "toolbg_1",
      toolCallId: "grep-1",
      toolName: "Grep",
      taskKind: "tool",
      status: "completed",
    });

    expect(h.toolRow()?.backgrounded).toBe(true);
    expect(h.toolRow()?.rowId).toBe(firstRowId);
    expect(h.work()?.status).toBe("resultPending");
    expect(h.work()?.anchorRowId).toBe(firstRowId);
  });
});

describe("subagent background tool call projection flip (BT 2.0)", () => {
  function subagentHarness() {
    const projection = new ProductProjection("bg-subagent", "epoch");
    let seq = 0;
    const apply = (type: SessionEvent["type"], payload: unknown) =>
      projection.applyEvent({
        id: `event-${++seq}`,
        sessionId: "bg-subagent",
        turnId: "turn-1",
        traceId: "trace",
        timestamp: new Date(1700000000000 + seq),
        sequenceNumber: seq,
        type,
        payload,
      } as SessionEvent);
    apply(SessionEventType.SessionCreated, { mode: "default", contextWindow: 200000 });
    apply(SessionEventType.TurnStarted, { turnNumber: 1, input: "run", messageId: "user-1" });
    apply(SessionEventType.ToolCallScheduled, {
      toolCallId: "agent-1",
      toolName: "Agent",
      input: { description: "kap mailbox", subagent_type: "general-purpose" },
      schedule: { parallelGroups: [["agent-1"]], executionOrder: ["agent-1"] },
    });
    apply(SessionEventType.ToolCallStarted, { toolCallId: "agent-1", toolName: "Agent" });
    apply(SessionEventType.SubagentSpawned, {
      agentId: "agent_live",
      taskId: "agent_live",
      executionId: "exec-1",
      agentType: "general-purpose",
      childSessionId: "subagent_agent_live",
      description: "kap mailbox",
      prompt: "investigate the mailbox",
      parentToolCallId: "agent-1",
      status: "running",
      allowedTools: [],
    });
    const toolRow = (): ToolCallRow | undefined =>
      projection
        .getSnapshot()
        .rows.window.find((r) => r.kind === "toolCall" && r.toolCallId === "agent-1") as
        | ToolCallRow
        | undefined;
    const subagentRow = () =>
      projection
        .getSnapshot()
        .rows.window.find((r) => r.kind === "subagent" && r.parentToolCallId === "agent-1");
    const work = (): BackgroundWorkSummary | undefined =>
      projection.getSnapshot().backgroundWorks.find((w) => w.workId === "agent_live");
    const backgroundStarted = () =>
      apply(SessionEventType.BackgroundTaskStarted, {
        taskId: "agent_live",
        toolCallId: "agent-1",
        toolName: "Agent",
        taskKind: "subagent",
        description: "kap mailbox",
        status: "running",
        cancellable: true,
      });
    return { apply, toolRow, subagentRow, work, backgroundStarted };
  }

  it("flips the Agent tool row and the subagent row; the summary anchors to the tool row", () => {
    const h = subagentHarness();
    const deltas = h.backgroundStarted();

    const toolRow = h.toolRow();
    expect(toolRow?.backgrounded).toBe(true);
    expect(toolRow?.workId).toBe("agent_live");
    const subagentRow = h.subagentRow();
    expect(subagentRow?.kind === "subagent" && subagentRow.backgrounded).toBe(true);
    expect(subagentRow?.kind === "subagent" && subagentRow.workId).toBe("agent_live");

    const summary = h.work();
    expect(summary?.kind).toBe("subagent");
    expect(summary?.status).toBe("running");
    expect(summary?.anchorRowId).toBe(toolRow?.rowId);

    const flips = deltas.filter((delta) => delta.op === "row.upserted");
    expect(flips).toHaveLength(2);
    for (const delta of deltas) expect(conversationDeltaSchema.parse(delta)).toEqual(delta);
  });

  it("repeat lifecycle events are idempotent: no second flip, anchor stays", () => {
    const h = subagentHarness();
    h.backgroundStarted();
    const firstToolRowId = h.toolRow()?.rowId;

    const repeat = h.backgroundStarted();
    expect(repeat.some((delta) => delta.op === "row.upserted")).toBe(false);
    expect(h.toolRow()?.backgrounded).toBe(true);
    expect(h.toolRow()?.rowId).toBe(firstToolRowId);
    expect(h.work()?.anchorRowId).toBe(firstToolRowId);
  });
});
