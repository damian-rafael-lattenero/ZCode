// DT (foreground -> background turn): demoting never aborts the turn, but the projection
// stops accepting that turn's stream (`isRunning()` flips to false), so an open text or
// reasoning row can never receive its own close. Owner drill 2026-11-17: demoting while the
// model was still thinking left the reasoning row `streaming` forever — a thinking spinner
// that could never finish. The demote reducer seals the foreground segment in place; the
// rest of the turn comes back through the backgroundResult wake.
import { describe, expect, it } from "vitest";
import { SessionEventType, type SessionEvent } from "@zcode/contracts";
import {
  conversationDeltaSchema,
  type AssistantTextRow,
  type ReasoningRow,
} from "@zcode/shared/zcode-protocol-v4";
import { ProductProjection } from "../src/zcode-protocol-v4/index.js";

const TURN_ID = "turn-demote-1";

function harness() {
  const projection = new ProductProjection("demote-session", "demote-epoch");
  let seq = 0;
  const apply = (type: SessionEvent["type"], payload: unknown) =>
    projection.applyEvent({
      id: `demote-event-${++seq}`,
      sessionId: "demote-session",
      turnId: TURN_ID,
      traceId: "demote-trace",
      timestamp: new Date(1_700_000_000_000 + seq),
      sequenceNumber: seq,
      type,
      payload,
    } as SessionEvent);
  const reasoningRow = (): ReasoningRow | undefined =>
    projection.getSnapshot().rows.window.find((row) => row.kind === "reasoning") as
      | ReasoningRow
      | undefined;
  const textRow = (): AssistantTextRow | undefined =>
    projection.getSnapshot().rows.window.find((row) => row.kind === "assistantText") as
      | AssistantTextRow
      | undefined;
  const stream = (payload: Record<string, unknown>) =>
    apply(SessionEventType.ModelStreaming, { delta: "", done: false, ...payload });
  const demote = () =>
    apply(SessionEventType.BackgroundTurnDemoted, {
      foregroundExecutionId: "runtime_command_1",
      taskId: "turn_runtime_command_1",
      turnId: TURN_ID,
      title: "run",
    });

  apply(SessionEventType.SessionCreated, { mode: "default", contextWindow: 200_000 });
  apply(SessionEventType.TurnStarted, {
    turnNumber: 1,
    input: "run",
    messageId: "user-1",
  });
  return { projection, apply, demote, reasoningRow, stream, textRow };
}

describe("backgroundTurn demote projection", () => {
  it("seals an open reasoning row: the thinking spinner ends at the demote", () => {
    const h = harness();
    h.stream({ kind: "reasoning_start", assistantMessageId: "assistant-1" });
    h.stream({ kind: "reasoning_delta", delta: "checking the repo" });
    expect(h.reasoningRow()?.state).toBe("streaming");

    const deltas = h.demote();

    expect(h.reasoningRow()?.state).toBe("complete");
    // Sealing keeps the text that already streamed; only the live state changes.
    expect(h.reasoningRow()?.text).toBe("checking the repo");
    expect(deltas.some((d) => d.op === "row.upserted")).toBe(true);
    for (const delta of deltas) expect(conversationDeltaSchema.parse(delta)).toEqual(delta);
  });

  it("seals an open assistant text row in the same demote", () => {
    const h = harness();
    h.stream({ kind: "reasoning_start", assistantMessageId: "assistant-1" });
    h.stream({ kind: "reasoning_delta", delta: "plan" });
    h.stream({ kind: "text_start", assistantMessageId: "assistant-1" });
    h.stream({ kind: "text_delta", delta: "partial answer" });

    h.demote();

    expect(h.textRow()?.state).toBe("complete");
    expect(h.textRow()?.text).toBe("partial answer");
    expect(h.reasoningRow()?.state).toBe("complete");
  });

  it("the detached turn's later stream no longer mutates the sealed rows", () => {
    const h = harness();
    h.stream({ kind: "reasoning_start", assistantMessageId: "assistant-1" });
    h.stream({ kind: "reasoning_delta", delta: "first" });
    h.demote();

    h.stream({ kind: "reasoning_delta", delta: " second" });
    h.stream({ kind: "text_start", assistantMessageId: "assistant-1" });
    h.stream({ kind: "text_delta", delta: "late text" });

    expect(h.reasoningRow()?.text).toBe("first");
    expect(h.reasoningRow()?.state).toBe("complete");
    expect(h.textRow()).toBeUndefined();
  });

  it("closes the foreground phase as a completed turn (session free, stop idle)", () => {
    const h = harness();
    h.stream({ kind: "reasoning_start", assistantMessageId: "assistant-1" });
    h.demote();

    const control = h.projection.getSnapshot().control;
    expect(control.phase).toBe("completedSuccess");
    expect(control.canStop).toBe(false);
    expect(control.activeWorks).toEqual([]);
  });
});
