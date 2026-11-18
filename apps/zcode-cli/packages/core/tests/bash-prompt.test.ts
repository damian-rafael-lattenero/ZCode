import { describe, expect, it } from "vitest";
import { createBashProviderDescription } from "../src/tool/handlers/bash-prompt.js";
import { createBashToolEntry } from "../src/tool/handlers/bash.js";

const BASE_DESCRIPTION_INPUT = {
  defaultTimeoutMs: 120_000,
  maxTimeoutMs: 600_000,
};

describe("createBashProviderDescription", () => {
  it("keeps the existing Bash text for non-Nushell dialects", () => {
    const posix = createBashProviderDescription(BASE_DESCRIPTION_INPUT);

    expect(posix.startsWith("Executes a bash command and returns its output.")).toBe(true);
    for (const shellDialect of ["posix", "git-bash", "cmd", "legacy-shell"] as const) {
      expect(createBashProviderDescription({ ...BASE_DESCRIPTION_INPUT, shellDialect })).toBe(
        posix,
      );
    }
  });

  it("describes Nushell parsing rules and the explicit bash escape hatch", () => {
    const nu = createBashProviderDescription({
      ...BASE_DESCRIPTION_INPUT,
      shellDialect: "nu",
    });

    expect(nu).toContain("Executes a Nushell command and returns its output.");
    expect(nu).not.toContain("Executes a bash command");
    expect(nu).toContain("There is no `&&`, no `export`, and no `$?`");
    expect(nu).toContain("$env.LAST_EXIT_CODE");
    expect(nu).toContain("`^bash -c '…'` or `^zsh -c '…'`");
    expect(nu).toContain("- `run_in_background` runs the command detached");
    expect(nu).toContain("# Git");
  });

  it("uses the Nushell description for a registered Bash tool entry", () => {
    expect(
      createBashToolEntry({ bashShellDialect: "nu" }).metadata.description,
    ).toContain("Executes a Nushell command");
  });
});
