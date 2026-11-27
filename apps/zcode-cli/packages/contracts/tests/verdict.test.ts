import { describe, expect, it } from "vitest";
import {
  MAX_VERDICT_EVIDENCE_CHARS,
  MAX_VERDICT_NOTE_CHARS,
  MAX_VERDICT_WINDOW_ENTRIES,
  VERDICT_ANSWER_FINISH,
  VERDICT_ANSWER_REDIRECT,
  formatVerdictNote,
  formatVerdictPrompt,
  formatVerdictQuestion,
  parseVerdictText,
  readVerdictAnswer,
} from "../src/tools/verdict.js";

// U6 — the Verdict is pure: a model text in, a typed judgement out. The tests
// pin the fail-open rule (a broken judge is an aligned verdict, never a block),
// the evidence law (drift without quoted evidence downgrades to aligned), the
// caps, and the two renderings (the note the agent reads and the card the
// owner answers).

const EVIDENCE = {
  trigger: "repeated_tool_calls",
  facts: ["same tool call 6 times in a row", "5 model steps, 14 tool calls"],
  window: ["Read the same file 6 times", 'Bash "nu scripts/check.nu" twice'],
} as const;

describe("parseVerdictText", () => {
  it("parses the three kinds with their evidence and note", () => {
    const aligned = parseVerdictText(
      JSON.stringify({ kind: "aligned", evidence: "the retries all failed on a 429", note: "" }),
    );
    expect(aligned).toEqual({
      kind: "aligned",
      evidence: "the retries all failed on a 429",
      note: "",
    });
    const minor = parseVerdictText(
      JSON.stringify({ kind: "minor_drift", evidence: "e", note: "read the test first" }),
    );
    expect(minor.kind).toBe("minor_drift");
    expect(minor.note).toBe("read the test first");
    const drift = parseVerdictText(
      JSON.stringify({ kind: "drift", evidence: "editing unrelated files", note: "" }),
    );
    expect(drift.kind).toBe("drift");
  });

  it("fails open on garbage: aligned, with the reason as evidence", () => {
    const verdict = parseVerdictText("I am not sure what happened here.");
    expect(verdict.kind).toBe("aligned");
    expect(verdict.evidence).toContain("did not return valid JSON");
    expect(verdict.note).toBe("");
  });

  it("downgrades a drift verdict that carries no evidence", () => {
    const verdict = parseVerdictText(JSON.stringify({ kind: "drift", evidence: "", note: "x" }));
    expect(verdict.kind).toBe("aligned");
    expect(verdict.evidence).toContain("without evidence");
  });

  it("trims and caps evidence and note", () => {
    const verdict = parseVerdictText(
      JSON.stringify({
        kind: "minor_drift",
        evidence: `  ${"e".repeat(MAX_VERDICT_EVIDENCE_CHARS + 50)}  `,
        note: ` ${"n".repeat(MAX_VERDICT_NOTE_CHARS + 50)} `,
      }),
    );
    expect(Array.from(verdict.evidence)).toHaveLength(MAX_VERDICT_EVIDENCE_CHARS);
    expect(Array.from(verdict.note)).toHaveLength(MAX_VERDICT_NOTE_CHARS);
  });

  it("maps an unknown kind to aligned", () => {
    expect(parseVerdictText(JSON.stringify({ kind: "frenzy", evidence: "e" })).kind).toBe(
      "aligned",
    );
  });
});

describe("formatVerdictPrompt", () => {
  it("carries the goal escaped, the trigger facts and the window", () => {
    const prompt = formatVerdictPrompt("fix <the> gate", "brief", { ...EVIDENCE });
    expect(prompt).toContain("<untrusted_goal>");
    expect(prompt).toContain("&lt;the&gt;");
    expect(prompt).not.toContain("<the>");
    expect(prompt).toContain("Trigger: repeated_tool_calls");
    expect(prompt).toContain("- same tool call 6 times in a row");
    expect(prompt).toContain("- Read the same file 6 times");
  });

  it("names the source of the goal and survives an empty window", () => {
    expect(formatVerdictPrompt("g", "request", { ...EVIDENCE })).toContain(
      "no confirmed Brief exists",
    );
    expect(formatVerdictPrompt("g", "brief", { ...EVIDENCE })).toContain(
      "the Brief the owner confirmed",
    );
    expect(formatVerdictPrompt("g", "brief", { ...EVIDENCE, window: [] })).toContain(
      "(no steps recorded)",
    );
  });
});

describe("formatVerdictNote", () => {
  const verdict = {
    kind: "minor_drift" as const,
    evidence: "the same Read repeated six times",
    note: "use the first result and move on",
  };

  it("carries the evidence and the correction, escaped", () => {
    const note = formatVerdictNote(verdict, "repeated_tool_calls");
    expect(note).toContain("<verdict>");
    expect(note).toContain("Evidence: the same Read repeated six times");
    expect(note).toContain("Correction: use the first result and move on");
  });

  it("escapes an owner redirect that carries angle brackets", () => {
    const note = formatVerdictNote(verdict, "repeated_tool_calls", "stop <b>this</b> now");
    expect(note).toContain("Correction: stop &lt;b&gt;this&lt;/b&gt; now");
    expect(note).not.toContain("<b>this</b>");
  });

  it("speaks the interrupted-attempt wording for the owner trigger", () => {
    const note = formatVerdictNote(verdict, "owner_interrupt");
    expect(note).toContain("The owner stopped the previous attempt");
    expect(note).not.toContain("anomaly guard");
  });
});

describe("the verdict card and its answer", () => {
  const verdict = {
    kind: "drift" as const,
    evidence: "editing unrelated files",
    note: "",
  };

  it("builds the one question with the two options", () => {
    const question = formatVerdictQuestion(verdict);
    expect(question.header).toBe("Verdict");
    expect(question.question).toContain("editing unrelated files");
    expect(question.options.map((option) => option.label)).toEqual([
      VERDICT_ANSWER_FINISH,
      VERDICT_ANSWER_REDIRECT,
    ]);
    expect(question.multiSelect).toBe(false);
  });

  it("reads the three answers the runtime must handle", () => {
    const question = formatVerdictQuestion(verdict).question;
    expect(readVerdictAnswer({ answers: { [question]: "Let it finish" } }, question)).toEqual({
      kind: "finish",
    });
    expect(readVerdictAnswer({ answers: { [question]: "Redirect" } }, question)).toEqual({
      kind: "redirect",
      text: "",
    });
    expect(
      readVerdictAnswer({ answers: { [question]: " switch to the other file " } }, question),
    ).toEqual({ kind: "redirect", text: "switch to the other file" });
    expect(readVerdictAnswer({ answers: {} }, question)).toEqual({ kind: "dismissed" });
    expect(readVerdictAnswer(undefined, question)).toEqual({ kind: "dismissed" });
  });
});

describe("the window cap", () => {
  it("is named so the caller cannot inflate the judge call", () => {
    expect(MAX_VERDICT_WINDOW_ENTRIES).toBe(8);
  });
});
