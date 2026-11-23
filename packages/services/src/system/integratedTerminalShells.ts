import { accessSync, constants as fsConstants } from "node:fs";
import { posix } from "node:path";
import type { IntegratedTerminalShellOption } from "@zcode/shared";
import { discoverWindowsGitBash, type WindowsGitBashDiscoveryOptions } from "@zcode/shared/node";

type ExecutableCheck = (path: string) => boolean | Promise<boolean>;

interface PosixShellSpec {
  dialect: "nu" | "posix";
  label: string;
  name: string;
  systemDirs: readonly string[];
}

const POSIX_SHELL_SPECS: readonly PosixShellSpec[] = [
  {
    dialect: "nu",
    label: "Nushell",
    name: "nu",
    systemDirs: ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"],
  },
  { dialect: "posix", label: "zsh", name: "zsh", systemDirs: ["/bin", "/usr/bin"] },
  {
    dialect: "posix",
    label: "bash",
    name: "bash",
    systemDirs: ["/bin", "/usr/bin", "/usr/local/bin", "/opt/homebrew/bin"],
  },
];

export async function listIntegratedTerminalShellOptions(options: {
  env: NodeJS.ProcessEnv;
  gitBashDiscovery?: Omit<WindowsGitBashDiscoveryOptions, "env" | "platform" | "isExecutable">;
  isExecutable?: WindowsGitBashDiscoveryOptions["isExecutable"];
  platform: NodeJS.Platform;
}): Promise<IntegratedTerminalShellOption[]> {
  if (options.platform !== "win32") {
    return listPosixIntegratedTerminalShellOptions(options.env, options.isExecutable);
  }

  const shellOptions: IntegratedTerminalShellOption[] = [createCommandPromptOption(options.env)];
  // 原来重复的固定目录/PATH 发现会漏掉非标准安装；共享发现修复漏检，选择与来源映射保持不变。
  const gitBash = await discoverWindowsGitBash({
    ...options.gitBashDiscovery,
    env: options.env,
    isExecutable: options.isExecutable,
    platform: options.platform,
  });
  if (gitBash) {
    shellOptions.push({
      dialect: "git-bash",
      id: `git-bash:${gitBash.path}`,
      label: "Git Bash",
      path: gitBash.path,
      source: gitBash.source,
    });
  }

  return shellOptions;
}

function createCommandPromptOption(env: NodeJS.ProcessEnv): IntegratedTerminalShellOption {
  const path = getWindowsEnvValue(env, "ComSpec")?.trim() || "cmd.exe";
  return {
    dialect: "cmd",
    id: `cmd:${path}`,
    label: "CMD",
    path,
    source: "system",
  };
}

function getWindowsEnvValue(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const lowerKey = key.toLowerCase();
  const match = Object.keys(env).find((envKey) => envKey.toLowerCase() === lowerKey);
  return match ? env[match] : undefined;
}

async function isExecutableCandidate(path: string, isExecutable?: ExecutableCheck): Promise<boolean> {
  if (isExecutable) {
    return await isExecutable(path);
  }

  try {
    accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function listPosixIntegratedTerminalShellOptions(
  env: NodeJS.ProcessEnv,
  isExecutable?: ExecutableCheck,
): Promise<IntegratedTerminalShellOption[]> {
  const shellOptions: IntegratedTerminalShellOption[] = [];
  for (const spec of POSIX_SHELL_SPECS) {
    const resolved = await resolvePosixShell(spec, env, isExecutable);
    if (resolved) {
      shellOptions.push({
        dialect: spec.dialect,
        id: `${spec.name}:${resolved.path}`,
        label: spec.label,
        path: resolved.path,
        source: resolved.source,
      });
    }
  }
  return shellOptions;
}

async function resolvePosixShell(
  spec: PosixShellSpec,
  env: NodeJS.ProcessEnv,
  isExecutable?: ExecutableCheck,
): Promise<{ path: string; source: "path" | "system" } | undefined> {
  const pathValue = env.PATH;
  if (pathValue) {
    for (const entry of pathValue.split(posix.delimiter)) {
      if (!entry) continue;
      const candidate = posix.join(entry, spec.name);
      if (await isExecutableCandidate(candidate, isExecutable)) {
        return { path: candidate, source: "path" };
      }
    }
  }

  for (const dir of spec.systemDirs) {
    const candidate = posix.join(dir, spec.name);
    if (await isExecutableCandidate(candidate, isExecutable)) {
      return { path: candidate, source: "system" };
    }
  }

  return undefined;
}

