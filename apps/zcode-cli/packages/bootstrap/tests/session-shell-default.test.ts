import { describe, expect, it } from "vitest";
import { resolveDefaultSessionBashShellSelection } from "../src/zcode-protocol/session-shell-default.js";

describe("resolveDefaultSessionBashShellSelection", () => {
  it("defaults POSIX sessions to an executable Nushell", () => {
    expect(
      resolveDefaultSessionBashShellSelection({
        env: { PATH: "/custom/bin" },
        exists: (path) => path === "/custom/bin/nu",
        platform: "darwin",
      }),
    ).toEqual({
      dialect: "nu",
      display: { name: "Nushell" },
      id: "nu:/custom/bin/nu",
      label: "Nushell",
      path: "/custom/bin/nu",
      source: "auto-detected",
    });
  });

  it("returns undefined when nu is not installed so POSIX auto-detection stays in charge", () => {
    expect(
      resolveDefaultSessionBashShellSelection({
        env: { PATH: "/usr/bin", SHELL: "/bin/zsh" },
        exists: (path) => path === "/bin/zsh",
        platform: "darwin",
      }),
    ).toBeUndefined();
  });

  it("never defaults Windows sessions to Nushell", () => {
    expect(
      resolveDefaultSessionBashShellSelection({
        env: { PATH: "C:\\bin" },
        exists: () => true,
        platform: "win32",
      }),
    ).toBeUndefined();
  });
});
