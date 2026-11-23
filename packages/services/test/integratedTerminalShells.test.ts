import { describe, expect, it } from "vitest";
import { listIntegratedTerminalShellOptions } from "../src/system/integratedTerminalShells.js";

describe("integrated terminal shell options", async () => {
  it("lists Nushell first for POSIX hosts when nu is executable", async () => {
    const options = await listIntegratedTerminalShellOptions({
      env: { PATH: "/home/user/.local/bin" },
      isExecutable: (path) => path === "/opt/homebrew/bin/nu" || path === "/usr/bin/zsh",
      platform: "darwin",
    });

    expect(options).toEqual([
      {
        dialect: "nu",
        id: "nu:/opt/homebrew/bin/nu",
        label: "Nushell",
        path: "/opt/homebrew/bin/nu",
        source: "system",
      },
      {
        dialect: "posix",
        id: "zsh:/usr/bin/zsh",
        label: "zsh",
        path: "/usr/bin/zsh",
        source: "system",
      },
    ]);
  });

  it("marks a PATH-discovered nu as a path option", async () => {
    const options = await listIntegratedTerminalShellOptions({
      env: { PATH: "/custom/bin:/usr/bin" },
      isExecutable: (path) => path === "/custom/bin/nu",
      platform: "linux",
    });

    expect(options).toEqual([
      {
        dialect: "nu",
        id: "nu:/custom/bin/nu",
        label: "Nushell",
        path: "/custom/bin/nu",
        source: "path",
      },
    ]);
  });

  it("keeps Windows options free of Nushell", async () => {
    const options = await listIntegratedTerminalShellOptions({
      env: { ComSpec: "C:\\Windows\\System32\\cmd.exe", PATH: "" },
      isExecutable: (path) => path === "C:\\Program Files\\Git\\bin\\bash.exe",
      platform: "win32",
    });

    expect(options.map((option) => option.dialect)).toEqual(["cmd", "git-bash"]);
    expect(options.some((option) => option.dialect === "nu")).toBe(false);
  });
});
