import { describe, expect, it } from "vitest";
import { stripAnsi } from "../src/tool/handlers/ansi.js";

describe("stripAnsi", () => {
  it("removes SGR color and style codes", () => {
    expect(stripAnsi("\u001b[1;31mred bold\u001b[0m plain")).toBe("red bold plain");
  });

  it("removes OSC sequences (hyperlinks, titles)", () => {
    expect(stripAnsi("\u001b]8;;https://example.com\u0007link\u001b]8;;\u0007")).toBe("link");
  });

  it("keeps plain text untouched", () => {
    expect(stripAnsi("no escapes here\nsecond line")).toBe("no escapes here\nsecond line");
  });

  it("keeps newlines and indentation after codes", () => {
    expect(stripAnsi("\u001b[32mok\u001b[0m\n  indented")).toBe("ok\n  indented");
  });
});
