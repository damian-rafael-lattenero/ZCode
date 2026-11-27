import { describe, expect, it } from "vitest";
import {
  MAX_BRIEF_GOAL_CHARS,
  MAX_BRIEF_ITEMS,
  formatBriefCard,
  formatBriefDraftPrompt,
  formatBriefForPrompt,
  parseBriefDraftText,
} from "../src/tools/brief.js";

// U5 — the Brief draft is pure: a model text in, a typed record out. The tests
// pin the four shapes the runtime will meet (plain JSON, a code fence, a JSON
// string, garbage), the fail-open rule (no brief, no card), the normalisation
// (trim, drop non-strings/blank/repeated, caps) and the two renderings (the
// confirmation card and the block the turn carries).

const DRAFT = JSON.stringify({
  brief: {
    goal: "  Make the English gate reject a Spanish note  ",
    constraints: ["  keep the CLI unchanged  ", "tests stay green"],
    nonGoals: ["no new dependency"],
    acceptance: ["the planted note fails the gate", "the real store still passes"],
  },
  reason: "a task with checkable outcomes",
});

describe("parseBriefDraftText", () => {
  it("parses a plain JSON object and trims every string", () => {
    const draft = parseBriefDraftText(DRAFT);
    expect(draft.brief).toEqual({
      goal: "Make the English gate reject a Spanish note",
      constraints: ["keep the CLI unchanged", "tests stay green"],
      nonGoals: ["no new dependency"],
      acceptance: ["the planted note fails the gate", "the real store still passes"],
    });
    expect(draft.reason).toBe("a task with checkable outcomes");
  });

  it("parses a fenced object and one wrapped in a JSON string", () => {
    expect(parseBriefDraftText("```json\n" + DRAFT + "\n```").brief?.goal).toContain(
      "English gate",
    );
    expect(parseBriefDraftText(JSON.stringify(DRAFT)).brief?.goal).toContain("English gate");
  });

  it("keeps a conversational request out: null brief, reason preserved", () => {
    const draft = parseBriefDraftText('{"brief": null, "reason": "small talk"}');
    expect(draft.brief).toBeNull();
    expect(draft.reason).toBe("small talk");
  });

  it("fails open on garbage: no brief, and the reason says why", () => {
    const draft = parseBriefDraftText("I could not draft anything useful.");
    expect(draft.brief).toBeNull();
    expect(draft.reason).toContain("did not return valid JSON");
  });

  it("drops non-strings, blanks and repeats, and caps the lists", () => {
    const many = Array.from({ length: MAX_BRIEF_ITEMS + 5 }, (_v, i) => `item ${i}`);
    const draft = parseBriefDraftText(
      JSON.stringify({
        brief: {
          goal: "goal",
          constraints: ["a", 7, "", null, "a", ...many],
          nonGoals: "not an array",
          acceptance: ["ok"],
        },
        reason: "",
      }),
    );
    expect(draft.brief?.constraints).toHaveLength(MAX_BRIEF_ITEMS);
    expect(draft.brief?.constraints.slice(0, 2)).toEqual(["a", "item 0"]);
    expect(draft.brief?.nonGoals).toEqual([]);
    expect(draft.reason).toBe("");
  });

  it("refuses a goal that is empty or over the cap (no card on doubt)", () => {
    expect(parseBriefDraftText('{"brief": {"goal": "   "}, "reason": "x"}').brief).toBeNull();
    const tooLong = "x".repeat(MAX_BRIEF_GOAL_CHARS + 1);
    expect(parseBriefDraftText(JSON.stringify({ brief: { goal: tooLong } })).brief).toBeNull();
  });
});

describe("the draft prompt", () => {
  it("carries the request as escaped untrusted data", () => {
    const prompt = formatBriefDraftPrompt('rename <script> tags "now"');
    expect(prompt).toContain("<untrusted_request>");
    expect(prompt).toContain("&lt;script&gt;");
    expect(prompt).not.toContain("<script>");
    expect(prompt).toContain("Do not do the work");
  });
});

describe("the two renderings", () => {
  const brief = {
    goal: "Ship the gate",
    constraints: ["no new dependency"],
    nonGoals: [],
    acceptance: ["the gate fails on a planted note"],
  };

  it("the card shows the four blocks, an em dash for an empty one", () => {
    const card = formatBriefCard(brief);
    expect(card.title).toContain("Brief");
    expect(card.body).toContain("Goal: Ship the gate");
    expect(card.body).toContain("Constraints: no new dependency");
    expect(card.body).toContain("Non-goals: —");
    expect(card.body).toContain("Acceptance: the gate fails on a planted note");
  });

  it("the prompt block escapes user words and names all four lists", () => {
    const block = formatBriefForPrompt({ ...brief, nonGoals: ["<b>not</b> this"] });
    expect(block).toContain("<brief>");
    expect(block).toContain("Goal: Ship the gate");
    expect(block).toContain("- &lt;b&gt;not&lt;/b&gt; this");
    expect(block).toContain("Non-goals:");
    expect(formatBriefForPrompt(brief)).toContain("(none stated)");
  });
});
