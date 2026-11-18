import { describe, expect, it } from "vitest";
import { formatCommandForDisplay } from "../src/lib/commandFormat.js";

describe("formatCommandForDisplay", () => {
  it("splits top-level pipes into indented lines", () => {
    expect(formatCommandForDisplay("ls | where size > 1kb | sort-by size | first 5")).toBe(
      "ls\n  | where size > 1kb\n  | sort-by size\n  | first 5",
    );
  });

  it("splits statements on semicolons", () => {
    expect(formatCommandForDisplay("cd /tmp; ls; pwd")).toBe("cd /tmp;\nls;\npwd");
  });

  it("leaves pipes inside strings, closures and brackets alone", () => {
    const quoted = formatCommandForDisplay('print "a | b"');
    expect(quoted).toBe('print "a | b"');
    const closure = formatCommandForDisplay("[1 2] | each {|x| $x | into string}");
    expect(closure).toBe("[1 2]\n  | each {|x| $x | into string}");
    const nested = formatCommandForDisplay("(ls | first 1) | get name");
    expect(nested).toBe("(ls | first 1)\n  | get name");
  });

  it("does not split comments", () => {
    expect(formatCommandForDisplay("# a | b; c\nls")).toBe("# a | b; c\nls");
  });

  it("keeps a plain command unchanged", () => {
    expect(formatCommandForDisplay("git status --short")).toBe("git status --short");
  });
});
