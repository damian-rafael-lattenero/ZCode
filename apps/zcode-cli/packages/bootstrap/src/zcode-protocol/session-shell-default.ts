import { resolvePosixNuShell } from "@zcode/adapters/exec";
import type { ExecutionShellSelection } from "@zcode/contracts";

/**
 * POSIX session default: when the user never picked a shell, run agent commands in Nushell.
 * The adapter's own auto-detection stays zsh/bash so internal posix-bash executions without
 * a session shell override (hooks, custom commands, startup scripts) keep their behavior.
 */
export function resolveDefaultSessionBashShellSelection(options: {
  env: NodeJS.ProcessEnv;
  exists?: (path: string) => boolean;
  platform: NodeJS.Platform | string;
}): ExecutionShellSelection | undefined {
  if (options.platform === "win32") {
    return undefined;
  }
  const path = resolvePosixNuShell(options.env, options.exists);
  return path
    ? {
        dialect: "nu",
        display: { name: "Nushell" },
        id: `nu:${path}`,
        label: "Nushell",
        path,
        source: "auto-detected",
      }
    : undefined;
}
