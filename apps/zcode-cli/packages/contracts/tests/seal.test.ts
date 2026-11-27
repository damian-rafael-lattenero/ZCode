import { describe, expect, it } from "vitest";
import {
  MAX_SEAL_GAPS,
  SEAL_ANSWER_END,
  SEAL_ANSWER_RETURN,
  formatSealBounceNote,
  formatSealNoticeQuestion,
  formatSealPrompt,
  parseSealText,
  readSealNoticeAnswer,
} from "../src/tools/seal.js";

// U7 — the Seal is pure: a Brief and a reply in, one measurement out. The
// tests pin the fail-open law (a broken seal passes the turn), the shape law
// (result · evidence · next), the bounce note and the owner's notice card.

const BRIEF = {
  goal: "Close the English gate's red drill",
  constraints: ["keep the CLI unchanged"],
  nonGoals: [],
  acceptance: ["the planted note fails the gate"],
};

describe("parseSealText", () => {
  it("parses a full check with its gaps", () => {
    const check = parseSealText(
      JSON.stringify({
        complete: false,
        replyShapeOk: false,
        gaps: ["the test was never run", "no next step named"],
      }),
    );
    expect(check).toEqual({
      complete: false,
      replyShapeOk: false,
      gaps: ["the test was never run", "no next step named"],
    });
  });

  it("fails open on garbage: the turn passes", () => {
    expect(parseSealText("I could not measure anything.")).toEqual({
      complete: true,
      replyShapeOk: true,
      gaps: [],
    });
  });

  it("refuses a half answer: unreadable fields become passing", () => {
    expect(parseSealText('{"complete": false}')).toEqual({
      complete: false,
      replyShapeOk: true,
      gaps: [],
    });
    expect(parseSealText('{"gaps": "not an array"}')).toEqual({
      complete: true,
      replyShapeOk: true,
      gaps: [],
    });
  });

  it("drops non-strings, blanks and repeats, and caps the gaps", () => {
    const many = Array.from({ length: MAX_SEAL_GAPS + 4 }, (_v, i) => `gap ${i}`);
    const check = parseSealText(
      JSON.stringify({ complete: false, replyShapeOk: true, gaps: ["a", 7, "", "a", ...many] }),
    );
    expect(check.gaps).toHaveLength(MAX_SEAL_GAPS);
    expect(check.gaps.slice(0, 2)).toEqual(["a", "gap 0"]);
  });

  it("caps each gap's length", () => {
    const check = parseSealText(
      JSON.stringify({ complete: false, replyShapeOk: true, gaps: ["g".repeat(500)] }),
    );
    expect(Array.from(check.gaps[0]!)).toHaveLength(300);
  });
});

describe("formatSealPrompt", () => {
  it("carries the Brief and the reply as escaped data and names the shape", () => {
    const prompt = formatSealPrompt(BRIEF, 'done <script>alert(1)</script> via tests');
    expect(prompt).toContain("<untrusted_brief>");
    expect(prompt).toContain("Acceptance: the planted note fails the gate");
    expect(prompt).toContain("<untrusted_reply>");
    expect(prompt).toContain("&lt;script&gt;");
    expect(prompt).not.toContain("<script>");
    expect(prompt).toContain("result, the evidence");
    expect(prompt).toContain("Uncertain means false");
  });

  it("omits the empty Brief blocks instead of printing bare labels", () => {
    const prompt = formatSealPrompt({ ...BRIEF, nonGoals: [], acceptance: [] }, "r");
    expect(prompt).not.toContain("Non-goals:");
    expect(prompt).not.toContain("Acceptance:");
    expect(prompt).toContain("Constraints: keep the CLI unchanged");
  });
});

describe("formatSealBounceNote", () => {
  it("names the gaps, the shape and the one-bounce fact", () => {
    const note = formatSealBounceNote({
      complete: false,
      replyShapeOk: false,
      gaps: ["the test was never run"],
    });
    expect(note).toContain("<seal>");
    expect(note).toContain("sent the turn back once");
    expect(note).toContain("- the test was never run");
    expect(note).toContain("result · evidence · next");
  });

  it("escapes a gap that carries angle brackets", () => {
    const note = formatSealBounceNote({
      complete: false,
      replyShapeOk: true,
      gaps: ["cite <the> file"],
    });
    expect(note).toContain("cite &lt;the&gt; file");
    expect(note).not.toContain("<the>");
  });

  it("falls back to re-reading the acceptance when no gap is named", () => {
    const note = formatSealBounceNote({ complete: false, replyShapeOk: true, gaps: [] });
    expect(note).toContain("re-read the acceptance");
  });
});

describe("the notice card and its answer", () => {
  const check = { complete: false, replyShapeOk: false, gaps: ["still no test run"] };

  it("builds the one question with the two options and the gaps", () => {
    const question = formatSealNoticeQuestion(check);
    expect(question.header).toBe("Seal");
    expect(question.question).toContain("still no test run");
    expect(question.question).toContain("sent the turn back once");
    expect(question.options.map((option) => option.label)).toEqual([
      SEAL_ANSWER_END,
      SEAL_ANSWER_RETURN,
    ]);
    expect(question.multiSelect).toBe(false);
  });

  it("reads the three answers the runtime must handle", () => {
    const question = formatSealNoticeQuestion(check).question;
    expect(readSealNoticeAnswer({ answers: { [question]: "End the turn" } }, question)).toEqual({
      kind: "end",
    });
    expect(readSealNoticeAnswer({ answers: { [question]: "Send it back" } }, question)).toEqual({
      kind: "return",
      text: "",
    });
    expect(
      readSealNoticeAnswer({ answers: { [question]: " run the suite first " } }, question),
    ).toEqual({ kind: "return", text: "run the suite first" });
    expect(readSealNoticeAnswer({ answers: {} }, question)).toEqual({ kind: "dismissed" });
    expect(readSealNoticeAnswer(undefined, question)).toEqual({ kind: "dismissed" });
  });
});
