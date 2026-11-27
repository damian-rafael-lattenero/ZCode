import { describe, expect, it } from "vitest";
import {
  MAX_VERDICT_WINDOW_ENTRIES,
  type VerdictTriggerEvidence,
} from "@zcode/contracts";
import {
  MIN_STEPS_FOR_INTERRUPT_VERDICT,
  buildVerdictWindow,
} from "../src/runtime/methods/verdict-gate.js";
import type { RuntimeMessageEntry } from "../src/agent/message-history.js";

// U6 — the judge's pure witness: the window the one model call reads. The gate
// itself is inert outside the interactive app (its guards return before any
// work), so its live behaviour is U6's on-device receipt; these tests pin the
// window laws: only real steps speak, each on one bounded line, the tail wins.

const entry = (message: RuntimeMessageEntry["message"]): RuntimeMessageEntry =>
  ({
    message,
    metadata: { source: "real_user" },
  }) as RuntimeMessageEntry;

const attachment = {
  kind: "attachment",
  message: { role: "user", content: "<system-reminder>noise</system-reminder>" },
  metadata: { source: "brief" },
} as unknown as RuntimeMessageEntry;

describe("buildVerdictWindow", () => {
  it("speaks tool calls with their input and skips attachments", () => {
    const window = buildVerdictWindow([
      attachment,
      entry({
        role: "assistant",
        content: "",
        toolCalls: [{ id: "t1", name: "Read", input: { file_path: "/tmp/a.ts" } }],
      }),
      entry({ role: "assistant", content: "Reading the file now." }),
      entry({ role: "user", content: "the user text never enters the window" }),
    ]);
    expect(window).toEqual([
      "tool Read: {\"file_path\":\"/tmp/a.ts\"}",
      "assistant: Reading the file now.",
    ]);
  });

  it("flattens whitespace and bounds each line", () => {
    const long = `word ${"x ".repeat(300)}`;
    const window = buildVerdictWindow([
      entry({ role: "assistant", content: long }),
    ]);
    expect(window).toHaveLength(1);
    const [, text] = window[0]!.split(": ");
    expect(text.length).toBeLessThanOrEqual(200);
    expect(text).not.toMatch(/\n/);
  });

  it("keeps the tail when the turn ran long", () => {
    const entries = Array.from({ length: MAX_VERDICT_WINDOW_ENTRIES + 4 }, (_v, i) =>
      entry({ role: "assistant", content: `step ${i}` }),
    );
    const window = buildVerdictWindow(entries);
    expect(window).toHaveLength(MAX_VERDICT_WINDOW_ENTRIES);
    expect(window.at(-1)).toContain(`step ${entries.length - 1}`);
    expect(window[0]).toContain(`step 4`);
  });
});

describe("the interrupt trigger's threshold", () => {
  it("needs real work before a stop counts as drift evidence", () => {
    expect(MIN_STEPS_FOR_INTERRUPT_VERDICT).toBe(2);
  });
});

describe("the trigger evidence shape", () => {
  it("carries counts, not prose, and the window rides separately", () => {
    const evidence: VerdictTriggerEvidence = {
      trigger: "repeated_tool_calls",
      facts: ["the same Read call repeated 6 times in a row"],
      window: buildVerdictWindow([]),
    };
    expect(evidence.facts[0]).toMatch(/\d/);
    expect(evidence.window).toEqual([]);
  });
});
