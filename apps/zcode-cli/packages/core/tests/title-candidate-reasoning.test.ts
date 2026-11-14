import { describe, expect, it } from "vitest";
import {
  createRootTraceContext,
  createSessionId,
  type ModelCatalogEntry,
} from "@zcode/contracts";
import { generateTitleCandidate } from "../src/runtime/methods/title-generation-sidecar.js";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { createTestModelFactory } from "./test-runtime-model.js";
import type { RuntimeModelFactoryInput } from "../src/runtime/types.js";

const created: RuntimeModelFactoryInput[] = [];

// The live failure this pins: the session model's isolated title request was provider-blocked
// (WAF 405), the chain fell through to the catalog candidates, and a candidate whose model
// REQUIRES a reasoning level died locally ("Reasoning level is required for ...") before any
// request — the chain lost its rescue and the session kept its raw first-input title.
const catalog: ModelCatalogEntry[] = [
  {
    providerId: "levelless",
    modelId: "m1",
    reasoningLevels: [],
    current: false,
  },
  {
    providerId: "levelful",
    modelId: "m2",
    reasoningLevels: ["high"],
    defaultReasoningLevel: "high",
    current: false,
  },
];

function createRuntime() {
  return createTestAgentRuntime(
    createSessionId("title-candidate-reasoning"),
    { modelSelection: { providerId: "primary", modelId: "m" } },
    {
      eventStore: createTestSessionEventStore(),
      modelCatalogPort: { listModels: () => catalog },
      modelFactory: createTestModelFactory({
        onCreate: (input) => created.push(input),
        generateText: async (_request, observation) => {
          if (observation.model.providerId !== "levelful") {
            throw new Error("provider-side block");
          }
          return { text: '{"title":"Session title"}', finishReason: "stop" as const };
        },
      }),
    },
  );
}

describe("title candidate chain reasoning levels", () => {
  it("seeds catalog candidates with their default reasoning level", async () => {
    const runtime = createRuntime();
    const candidate = await generateTitleCandidate.call(runtime as never, "Improve headers", {
      querySource: "session_title",
      traceContext: createRootTraceContext({ sessionId: runtime.getSessionId() }),
    });

    expect(candidate?.title).toBe("session_title");
    expect(created.map((input) => input.selection.providerId)).toEqual([
      "primary",
      "levelless",
      "levelful",
    ]);
    expect(created[1]!.selection.options).toBeUndefined();
    expect(created[2]!.selection.options?.reasoningLevel).toBe("high");
  });
});
