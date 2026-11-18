import { describe, expect, it } from "vitest";
import { resolveTerminalShell } from "../src/terminal/terminalService.js";

describe("resolveTerminalShell", () => {
  it("prefers an executable nu from PATH before SHELL on POSIX", () => {
    expect(
      resolveTerminalShell({
        env: { PATH: "/custom/bin", SHELL: "/bin/zsh" },
        isExecutable: (path) => path === "/custom/bin/nu" || path === "/bin/zsh",
        platform: "darwin",
      }),
    ).toBe("/custom/bin/nu");
  });

  it("uses the well-known nu location when PATH has no nu", () => {
    expect(
      resolveTerminalShell({
        env: { PATH: "/usr/bin", SHELL: "/bin/zsh" },
        isExecutable: (path) => path === "/opt/homebrew/bin/nu" || path === "/bin/zsh",
        platform: "darwin",
      }),
    ).toBe("/opt/homebrew/bin/nu");
  });

  it("keeps SHELL when nu is absent", () => {
    expect(
      resolveTerminalShell({
        env: { PATH: "/usr/bin", SHELL: "/bin/zsh" },
        isExecutable: (path) => path === "/bin/zsh",
        platform: "linux",
      }),
    ).toBe("/bin/zsh");
  });

  it("does not use nu for Windows terminals", () => {
    expect(
      resolveTerminalShell({
        env: { ComSpec: "C:\\Windows\\System32\\cmd.exe", PATH: "C:\\bin" },
        isExecutable: (path) => path === "pwsh.exe",
        platform: "win32",
      }),
    ).toBe("pwsh.exe");
  });
});
