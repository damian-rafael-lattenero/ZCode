import { describe, expect, it } from "vitest";
import { hasAnsi, parseAnsiText } from "../src/lib/ansiText.js";

describe("parseAnsiText", () => {
  it("returns one plain span when there are no escapes", () => {
    expect(parseAnsiText("plain output")).toEqual([{ text: "plain output" }]);
    expect(hasAnsi("plain output")).toBe(false);
  });

  it("maps basic colors and bold", () => {
    const spans = parseAnsiText("\u001b[31mred\u001b[0m");
    expect(spans).toHaveLength(1);
    expect(spans[0]).toEqual({ text: "red", style: { color: "#cd3131" } });
  });

  it("resets styles on ESC[0m", () => {
    const spans = parseAnsiText("\u001b[1;32mgreen\u001b[0m plain");
    expect(spans[0]?.style).toEqual({ fontWeight: 600, color: "#0dbc79" });
    expect(spans[1]).toEqual({ text: " plain" });
  });

  it("supports 256-color and truecolor", () => {
    const indexed = parseAnsiText("\u001b[38;5;196mX\u001b[0m");
    expect(indexed[0]?.style?.color).toBe("rgb(255, 0, 0)");
    const truecolor = parseAnsiText("\u001b[38;2;1;2;3mX\u001b[0m");
    expect(truecolor[0]?.style?.color).toBe("rgb(1, 2, 3)");
  });

  it("drops OSC sequences instead of rendering them", () => {
    const spans = parseAnsiText("\u001b]8;;https://example.com\u0007link\u001b]8;;\u0007");
    expect(spans.map((span) => span.text).join("")).toBe("link");
  });
});
