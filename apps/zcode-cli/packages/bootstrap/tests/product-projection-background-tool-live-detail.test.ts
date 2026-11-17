// Background tool live detail: BackgroundTaskStarted/Updated/Completed events with
// `taskKind: "tool"` keep a bounded mirror on the matching backgroundWorks entry, throttled
// to 4/s for running updates and always published on terminal status.
import { describe, expect, it } from "vitest";
import { SessionEventType, type SessionEvent } from "@zcode/contracts";
import {
  conversationDeltaSchema,
  type BackgroundWorkSummary,
} from "@zcode/shared/zcode-protocol-v4";
import { ProductProjection } from "../src/zcode-protocol-v4/index.js";

const START = 1_700_000_000_000;

function harness() {
  const projection = new ProductProjection("bg-tool-live-detail", "epoch");
  let seq = 0;
  let clock = START;
  const apply = (type: SessionEvent["type"], payload: unknown, timestampMs = clock) =>
    projection.applyEvent({
      id: `event-${++seq}`,
      sessionId: "bg-tool-live-detail",
      turnId: "turn-1",
      traceId: "trace",
      timestamp: new Date(timestampMs),
      sequenceNumber: seq,
      type,
      payload,
    } as SessionEvent);
  const advance = (ms: number) => {
    clock += ms;
  };
  apply(SessionEventType.SessionCreated, { mode: "default", contextWindow: 200000 });
  apply(SessionEventType.TurnStarted, { turnNumber: 1, input: "run", messageId: "user-1" });
  const work = (): BackgroundWorkSummary | undefined =>
    projection.getSnapshot().backgroundWorks.find((item) => item.workId === "tool_exec_1");
  const started = (payload: Record<string, unknown> = {}) =>
    apply(SessionEventType.BackgroundTaskStarted, {
      taskId: "tool_exec_1",
      toolCallId: "call-1",
      toolName: "WebSearch",
      taskKind: "tool",
      command: "search the docs",
      status: "running",
      cancellable: true,
      ...payload,
    });
  const updated = (payload: Record<string, unknown>, timestampMs?: number) =>
    apply(
      SessionEventType.BackgroundTaskUpdated,
      {
        taskId: "tool_exec_1",
        toolName: "WebSearch",
        taskKind: "tool",
        status: "running",
        ...payload,
      },
      timestampMs,
    );
  const completed = (payload: Record<string, unknown>, timestampMs?: number) =>
    apply(
      SessionEventType.BackgroundTaskCompleted,
      {
        taskId: "tool_exec_1",
        toolName: "WebSearch",
        taskKind: "tool",
        status: "completed",
        ...payload,
      },
      timestampMs,
    );
  return { projection, apply, advance, work, started, updated, completed };
}

describe("background tool live detail projection", () => {
  it("seeds liveDetail from the runtime output tail and validates against the schema", () => {
    const h = harness();
    const deltas = h.started({ outputTail: "chunk-1" });

    const detail = h.work()?.liveDetail;
    expect(detail?.text).toBe("chunk-1");
    expect(detail?.truncated).toBe(false);
    expect(detail?.updatedAt).toBe(START);
    expect(detail?.tool).toEqual({ toolName: "WebSearch", status: "running" });
    for (const delta of deltas) expect(conversationDeltaSchema.parse(delta)).toEqual(delta);
  });

  it("throttles running updates to at most 4/s and publishes once the window opens", () => {
    const h = harness();
    h.started({ outputTail: "chunk-1" });

    h.advance(10);
    h.updated({ outputTail: "chunk-2" });
    expect(h.work()?.liveDetail?.text).toBe("chunk-1");

    h.advance(10);
    h.updated({ outputTail: "chunk-3" });
    expect(h.work()?.liveDetail?.text).toBe("chunk-1");

    h.advance(300);
    h.updated({ outputTail: "chunk-4" });
    expect(h.work()?.liveDetail?.text).toBe("chunk-4");
    expect(h.work()?.liveDetail?.tool?.status).toBe("running");
  });

  it("always publishes terminal text and freezes it against late running updates", () => {
    const h = harness();
    h.started({ outputTail: "chunk-1" });

    // Terminal arrives inside the throttle window: it must not be dropped.
    h.advance(10);
    h.completed({ resultText: "the final result" });
    const frozen = h.work()?.liveDetail;
    expect(frozen?.text).toBe("the final result");
    expect(frozen?.tool?.status).toBe("success");

    h.advance(500);
    h.updated({ outputTail: "late chunk" });
    expect(h.work()?.liveDetail?.text).toBe("the final result");
    expect(h.work()?.liveDetail?.tool?.status).toBe("success");
  });

  it("bounds the text at 8192 chars and flags truncation", () => {
    const h = harness();
    h.started();

    h.advance(10);
    h.completed({ resultText: "x".repeat(9000) });

    const detail = h.work()?.liveDetail;
    expect(detail?.text).toHaveLength(8192);
    expect(detail?.truncated).toBe(true);
  });

  it("falls back to a status line when the runtime sends no text", () => {
    const h = harness();
    h.started();

    expect(h.work()?.liveDetail?.text).toBe("WebSearch running");
    expect(h.work()?.liveDetail?.truncated).toBe(false);
  });
});
