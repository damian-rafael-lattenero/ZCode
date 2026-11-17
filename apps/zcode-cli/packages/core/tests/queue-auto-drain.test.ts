// BT 3.1 (2026-11-17): setQueueAutoDrain is idempotent. The sendText admission re-arms
// auto-drain when an explicit queue choice arrives; repeating the current value must not
// emit a redundant QueueAutoDrainChanged event or flip the external-drain latch.
import { describe, expect, it, vi } from "vitest";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";
import { setQueueAutoDrain } from "../src/runtime/methods/steering.js";

function internalWith(autoDrain: boolean, externalDrainActive = false): AgentRuntimeInternal {
  return {
    appendEvent: vi.fn(async () => {}),
    queueAutoDrain: autoDrain,
    queueExternalDrainActive: externalDrainActive,
    sessionId: "s1",
  } as unknown as AgentRuntimeInternal;
}

describe("setQueueAutoDrain", () => {
  it("is a no-op when the value is unchanged (no event, latch untouched)", async () => {
    const runtime = internalWith(true);

    await setQueueAutoDrain.call(runtime, {
      autoDrain: true,
      traceContext: { traceId: "t" },
    });

    expect(runtime.appendEvent).not.toHaveBeenCalled();
    expect(runtime.queueAutoDrain).toBe(true);
  });

  it("re-arms a paused queue, flips the external-drain latch and emits once", async () => {
    const runtime = internalWith(false);

    await setQueueAutoDrain.call(runtime, {
      autoDrain: true,
      traceContext: { traceId: "t" },
    });

    expect(runtime.queueAutoDrain).toBe(true);
    expect(runtime.queueExternalDrainActive).toBe(true);
    expect(runtime.appendEvent).toHaveBeenCalledTimes(1);
  });

  it("pausing still flips the latch and emits", async () => {
    const runtime = internalWith(true, true);

    await setQueueAutoDrain.call(runtime, {
      autoDrain: false,
      traceContext: { traceId: "t" },
    });

    expect(runtime.queueAutoDrain).toBe(false);
    expect(runtime.queueExternalDrainActive).toBe(false);
    expect(runtime.appendEvent).toHaveBeenCalledTimes(1);
  });
});
