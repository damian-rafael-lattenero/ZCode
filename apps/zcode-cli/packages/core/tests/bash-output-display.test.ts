import { describe, expect, it } from "vitest";
import { toolResultDisplayPayloadSchema } from "@zcode/contracts";
import { createToolResultDisplay } from "../src/tool/executor/result-display.js";
import { formatBashModelContent } from "../src/tool/handlers/bash-model-content.js";
const base = {
  stdout: "head",
  stderr: "",
  interrupted: false,
  isImage: false,
  status: "completed",
};
describe("Bash result display", () => {
  it("preserves the bounded head, actual truncation and canonical file path", () => {
    const display = createToolResultDisplay("Bash", {
      ...base,
      stdout: "x".repeat(30000),
      stdoutTruncated: true,
      persistedOutputPath: "/中文 空格/output.log",
    });
    expect(display).toEqual({
      kind: "bash_output",
      output: "x".repeat(30000),
      truncated: true,
      outputPath: "/中文 空格/output.log",
    });
    expect(toolResultDisplayPayloadSchema.parse(display)).toEqual(display);
  });
  it("retains small-output, background and image rendering correctly", () => {
    expect(createToolResultDisplay("Bash", base)).toEqual({
      kind: "bash_output",
      output: "head",
      truncated: false,
    });
    expect(createToolResultDisplay("Bash", { ...base, stdout: "x".repeat(30000) })).toEqual({
      kind: "bash_output",
      output: "x".repeat(30000),
      truncated: false,
    });
    for (const output of [
      { ...base, status: "backgrounded", persistedOutputPath: "/file" },
      { ...base, isImage: true, persistedOutputPath: "/file" },
      { ...base, stdout: "", stderr: "" },
    ]) {
      expect(createToolResultDisplay("Bash", output)).toBeUndefined();
    }
  });
  it("keeps ANSI in the UI display and strips it from the model content", () => {
    const colored = { ...base, stdout: "\u001b[32mok\u001b[0m" };
    expect(createToolResultDisplay("Bash", colored)).toEqual({
      kind: "bash_output",
      output: "\u001b[32mok\u001b[0m",
      truncated: false,
    });
    expect(formatBashModelContent(colored)).toBe("ok");
  });
  it("shows truncation without promising a file after output-limit cleanup", () => {
    expect(
      createToolResultDisplay("Bash", { ...base, stdoutTruncated: true, stderr: "killed" }),
    ).toEqual({ kind: "bash_output", output: "head\nkilled", truncated: true });
  });
  it("bounds display independently of an oversized or multibyte handler result", () => {
    const display = createToolResultDisplay("Bash", {
      ...base,
      stdout: "中".repeat(60000),
      persistedOutputPath: "/file",
    });
    if (display?.kind !== "bash_output") throw new Error("missing display");
    expect(display.truncated).toBe(true);
    expect(Buffer.byteLength(display.output)).toBeLessThanOrEqual(150000);
    expect(display.output).not.toContain("�");
  });
});
