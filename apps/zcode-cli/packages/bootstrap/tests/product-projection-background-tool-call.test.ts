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
