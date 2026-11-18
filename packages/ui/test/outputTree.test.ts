import { describe, expect, it } from "vitest";
import { classifyOutput, expandOutputText, hasBlockLeaf } from "../src/lib/outputTree.js";

describe("classifyOutput", () => {
  it("splits strings by content", () => {
    expect(classifyOutput('{"a":1}')).toEqual({ tag: "json", text: '{"a":1}' });
    expect(classifyOutput("let x = 1")).toEqual({ tag: "code", text: "let x = 1" });
    expect(classifyOutput("a\nb")).toEqual({ tag: "lines", text: "a\nb" });
    expect(classifyOutput("plain")).toEqual({ tag: "text", text: "plain" });
  });

  it("serializes every scalar kind and recurses into products", () => {
    expect(classifyOutput({ n: 1, f: 1.5, ok: true, none: null })).toEqual({
      tag: "record",
      fields: [
        { key: "n", node: { tag: "scalar", text: "1" } },
        { key: "f", node: { tag: "scalar", text: "1.5" } },
        { key: "ok", node: { tag: "scalar", text: "true" } },
        { key: "none", node: { tag: "scalar", text: "null" } },
      ],
    });
    expect(classifyOutput([1, "a"])).toEqual({
      tag: "list",
      items: [
        { tag: "scalar", text: "1" },
        { tag: "text", text: "a" },
      ],
    });
  });

  it("keeps each nested leaf's own tag", () => {
    const tree = classifyOutput({ a: { b: '{"k":1}' } });
    expect(tree.tag).toBe("record");
    if (tree.tag !== "record") return;
    const inner = tree.fields[0]!.node;
    expect(inner.tag).toBe("record");
    if (inner.tag !== "record") return;
    expect(inner.fields[0]!.node.tag).toBe("json");
  });
});

describe("expandOutputText", () => {
  it("returns null when nothing inside a string needs expansion", () => {
    expect(expandOutputText('{"a":1,"b":"plain"}')).toBeNull();
    expect(expandOutputText("not json")).toBeNull();
  });

  it("expands an embedded JSON string as its own highlight block", () => {
    const segments = expandOutputText(JSON.stringify({ payload: JSON.stringify({ a: 1 }) }));
    expect(segments).not.toBeNull();
    expect(segments![0]).toEqual({ kind: "text", text: '{\n  "payload":\n' });
    const block = segments![1];
    expect(block?.kind).toBe("highlight");
    if (block?.kind !== "highlight") return;
    expect(block.language).toBe("json");
    expect(block.indent).toBe("    ");
    expect(block.text).toContain('"a": 1');
    expect(segments![2]).toEqual({ kind: "text", text: "\n}" });
  });

  it("shows multi-line text as real lines", () => {
    expect(expandOutputText(JSON.stringify({ out: "line one\nline two" }))).toEqual([
      { kind: "text", text: '{\n  "out":\n    line one\n    line two\n}' },
    ]);
  });

  it("highlights an inline Nu command without breaking its line", () => {
    const segments = expandOutputText(JSON.stringify({ command: "let x = 1", out: "a\nb" }));
    expect(segments).toEqual([
      { kind: "text", text: '{\n  "command": ' },
      { kind: "highlight", language: "nu", text: "let x = 1", indent: "" },
      { kind: "text", text: '\n  "out":\n    a\n    b\n}' },
    ]);
  });

  it("keeps nesting depth for inline leaves", () => {
    const segments = expandOutputText(
      JSON.stringify({ state: { input: { command: "let x = 1", out: "a\nb" } } }),
    );
    expect(segments![0]).toEqual({
      kind: "text",
      text: '{\n  "state": {\n    "input": {\n      "command": ',
    });
    expect(segments![1]).toMatchObject({ kind: "highlight", language: "nu", indent: "" });
  });
});

describe("hasBlockLeaf", () => {
  it("is true only when a string leaf carries structure", () => {
    expect(hasBlockLeaf(classifyOutput({ a: 1 }))).toBe(false);
    expect(hasBlockLeaf(classifyOutput({ a: "plain" }))).toBe(false);
    expect(hasBlockLeaf(classifyOutput({ a: "x\ny" }))).toBe(true);
    expect(hasBlockLeaf(classifyOutput({ a: { b: '{"k":1}' } }))).toBe(true);
  });
});
