import { describe, expect, it } from "vitest";
import { createContextBuilder } from "../src/context/index.js";
import { createSubagentContextBuilder } from "../src/subagent/context-builder.js";

// [fork] U4 — the law file the runtime reads from `systemPromptAppendFile` rides
// every system prompt as its own stable section: it never replaces the base
// prompt, it is appended to the main session AND to every subagent, and its
// absence leaves the prompt exactly as it was.

const ENV = {
  cwd: "/workspace",
  platform: "darwin",
  shell: "zsh",
  osVersion: "Darwin 25.4.0",
  nodeVersion: "v24.14.0",
};

const LAW = "# The law\nDenotation before code; effects at the edge.";

describe("system prompt append (fork U4)", () => {
  it("appends the law as a stable system section after the base body", () => {
    const result = createContextBuilder({
      workingDirectory: "/workspace",
      envInfo: ENV,
      systemPromptAppend: LAW,
    }).build();

    const append = result.sections.find((section) => section.source === "system_prompt_append");
    expect(append).toBeDefined();
    expect(append?.injectionTarget).toBe("system");
    expect(append?.cacheHint).toBe("stable");
    expect(append?.content).toContain(LAW);

    const identity = result.sections.find((section) => section.source === "identity");
    expect(identity).toBeDefined();

    const stable = result.systemMessages[1]?.content as string;
    expect(stable).toContain(LAW);
    expect(stable.indexOf(identity?.content ?? "\u0000")).toBeLessThan(stable.indexOf(LAW));
  });

  it("carries the same law inside a subagent's system prompt", () => {
    const result = createSubagentContextBuilder({
      agentPrompt: "You are the Explore agent.",
      envInfo: ENV,
      systemPromptAppend: LAW,
    }).build();

    const append = result.sections.find((section) => section.source === "system_prompt_append");
    expect(append).toBeDefined();
    expect(append?.content).toContain(LAW);
    const system = result.systemMessages.map((message) => String(message.content)).join("\n");
    expect(system).toContain(LAW);
    expect(system).toContain("You are the Explore agent.");
  });

  it("leaves the prompt untouched when the key is unset or blank", () => {
    const without = createContextBuilder({
      workingDirectory: "/workspace",
      envInfo: ENV,
    }).build();
    expect(without.sections.some((section) => section.source === "system_prompt_append")).toBe(
      false,
    );

    const blank = createContextBuilder({
      workingDirectory: "/workspace",
      envInfo: ENV,
      systemPromptAppend: "   \n  ",
    }).build();
    expect(blank.sections.some((section) => section.source === "system_prompt_append")).toBe(false);
  });
});
