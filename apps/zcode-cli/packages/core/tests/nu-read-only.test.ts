import { describe, expect, it } from "vitest";
import { isNuReadOnlyCommand } from "../src/tool/handlers/nu-read-only.js";

describe("isNuReadOnlyCommand", () => {
  it("accepts common read-only commands and pipelines", () => {
    expect(isNuReadOnlyCommand("pwd")).toBe(true);
    expect(isNuReadOnlyCommand("ls -la /tmp")).toBe(true);
    expect(isNuReadOnlyCommand("ls | where size > 1kb | sort-by size | first 5")).toBe(true);
    expect(isNuReadOnlyCommand("open config.json | get name")).toBe(true);
    expect(isNuReadOnlyCommand("^rg --color=always pattern src")).toBe(true);
    expect(isNuReadOnlyCommand("git status --short")).toBe(true);
    expect(isNuReadOnlyCommand("git log --oneline -5")).toBe(true);
  });

  it("rejects writes, control flow, redirections and unknown commands", () => {
    expect(isNuReadOnlyCommand("rm -rf /tmp/x")).toBe(false);
    expect(isNuReadOnlyCommand("ls; rm x")).toBe(false);
    expect(isNuReadOnlyCommand("ls o> out.txt")).toBe(false);
    expect(isNuReadOnlyCommand("let x = 1")).toBe(false);
    expect(isNuReadOnlyCommand("$env.FOO = 'bar'")).toBe(false);
    expect(isNuReadOnlyCommand("git commit -m x")).toBe(false);
    expect(isNuReadOnlyCommand("some-unknown-binary")).toBe(false);
    expect(isNuReadOnlyCommand("ls | save out.txt")).toBe(false);
    expect(isNuReadOnlyCommand("")).toBe(false);
  });
});
