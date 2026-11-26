// U1 (2026-11-17): the composer's interrupt cuts the CURRENT model step and continues the
// same turn with the steer guide. Two pieces are pinned here: the controller primitive and
// the admission wiring (guide enqueued FIRST, then abort; non-steerable falls to queue).
import { describe, expect, it, vi } from "vitest";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";
import {
  createModelStepInterruptedError,
  isModelStepInterruptedError,
} from "../src/runtime/helpers/turn-errors.js";
import { admitPrompt } from "../src/runtime/methods/prompt-admission.js";
import { interruptActiveModelStep } from "../src/runtime/methods/steering.js";

function internalWithController(controller?: AbortController): AgentRuntimeInternal {
  return {
    activeModelStepController: controller,
    rootTraceContext: { traceId: "trace_u1" },
    activeTurn: { turnId: "turn_1", traceContext: { traceId: "trace_u1" } },
  } as unknown as AgentRuntimeInternal;
}

describe("interruptActiveModelStep", () => {
  it("aborts ONLY the model step with the steer identity, and the second hit is a no-op", () => {
    const controller = new AbortController();
    const runtime = internalWithController(controller);

    expect(interruptActiveModelStep.call(runtime)).toBe(true);
    expect(controller.signal.aborted).toBe(true);
    expect(isModelStepInterruptedError(controller.signal.reason)).toBe(true);
    expect(interruptActiveModelStep.call(runtime)).toBe(false);
  });

  it("no step in flight (mid-tool): no-op, the guide waits at the batch boundary", () => {
    expect(interruptActiveModelStep.call(internalWithController(undefined))).toBe(false);
  });

  it("recognizes the interrupt identity through a provider wrapper cause chain", () => {
    const wrapped = new Error("model request failed", {
      cause: createModelStepInterruptedError(),
    });
    expect(isModelStepInterruptedError(wrapped)).toBe(true);
    expect(isModelStepInterruptedError(new Error("plain provider failure"))).toBe(false);
  });
});

describe("admitPrompt interruptCurrentModelStep", () => {
  function busyRuntime(steerable: boolean) {
    const steerTurn = vi.fn(async () => ({
      kind: "queued" as const,
      pendingInputId: "pending_1",
      queueLength: 1,
      turnId: "turn_1",
    }));
    const enqueueDeferredInput = vi.fn(async () => ({
      kind: "queued" as const,
      pendingInputId: "pending_2",
      queueLength: 1,
      turnId: "turn_1",
    }));
    const interruptActiveModelStep = vi.fn(() => true);
    return {
      runtime: {
        activeTurn: { turnId: "turn_1", steerable, traceContext: { traceId: "trace_u1" } },
        enqueueDeferredInput,
        hasActiveOrQueuedTurnWork: () => true,
        interruptActiveModelStep,
        steerTurn,
      } as unknown as AgentRuntimeInternal,
      enqueueDeferredInput,
      interruptActiveModelStep,
      steerTurn,
    };
  }

  it("enqueues the guide FIRST, then cuts the step", async () => {
    const { runtime, steerTurn, interruptActiveModelStep, enqueueDeferredInput } = busyRuntime(true);

    const result = await admitPrompt.call(runtime, "keep going from here", undefined, {
      interruptCurrentModelStep: true,
    });

    expect(result.kind).toBe("queued");
    expect(steerTurn).toHaveBeenCalledWith(
      expect.objectContaining({ delivery: "guide", input: "keep going from here" }),
    );
    expect(interruptActiveModelStep).toHaveBeenCalledTimes(1);
    expect(steerTurn.mock.invocationCallOrder[0]!).toBeLessThan(
      interruptActiveModelStep.mock.invocationCallOrder[0]!,
    );
    expect(enqueueDeferredInput).not.toHaveBeenCalled();
  });

  it("non-steerable turn: cuts nothing and falls back to the ordinary queue", async () => {
    const { runtime, steerTurn, interruptActiveModelStep, enqueueDeferredInput } = busyRuntime(false);

    const result = await admitPrompt.call(runtime, "keep going from here", undefined, {
      interruptCurrentModelStep: true,
    });

    expect(result.kind).toBe("queued");
    expect(steerTurn).not.toHaveBeenCalled();
    expect(interruptActiveModelStep).not.toHaveBeenCalled();
    expect(enqueueDeferredInput).toHaveBeenCalledTimes(1);
  });
});
