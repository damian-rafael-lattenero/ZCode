import type { ExecutionShellSelection } from "@zcode/contracts";

export function createBashProviderDescription(input: {
  defaultTimeoutMs: number;
  embeddedSearchEnabled?: boolean;
  maxTimeoutMs: number;
  shellDialect?: ExecutionShellSelection["dialect"];
}): string {
  if (input.shellDialect === "nu") {
    return createNushellProviderDescription(input);
  }

  const avoidCommands = input.embeddedSearchEnabled
    ? "`cat`, `head`, `tail`, `sed`, `awk`, or `echo`"
    : "`find`, `grep`, `cat`, `head`, `tail`, `sed`, `awk`, or `echo`";

  return [
    "Executes a bash command and returns its output.",
    "",
    "- Working directory persists between calls, but prefer absolute paths — `cd` in a compound command can trigger a permission prompt. Shell state (env vars, functions) does not persist; the shell is initialized from the user's profile.",
    `- IMPORTANT: Avoid using this tool to run ${avoidCommands} commands, unless explicitly instructed or after you have verified that a dedicated tool cannot accomplish your task. Instead, use the appropriate dedicated tool as this will provide a much better experience for the user.`,
    "- Command output is displayed to you, not reliably to the user.",
    // 显式后台命令提交后清除前台 deadline，上限只约束前台命令。
    `- \`timeout\` is in milliseconds: default ${input.defaultTimeoutMs}, max ${input.maxTimeoutMs} for a foreground command.`,
    "- `run_in_background` runs the command detached: it keeps running across turns and re-invokes you when it exits. No `&` needed.",
    "",
    "# Git",
    "- Interactive flags (`-i`, e.g. `git rebase -i`, `git add -i`) are not supported in this environment.",
    "- Use the `gh` CLI for GitHub operations (PRs, issues, API).",
    "- Commit or push only when the user asks. If on the default branch, branch first.",
  ].join("\n");
}

function createNushellProviderDescription(input: {
  defaultTimeoutMs: number;
  maxTimeoutMs: number;
}): string {
  return [
    "Executes a Nushell command and returns its output.",
    "",
    "- The command string is parsed by Nushell, not bash: chain with `;` or `and`, read variables as `$env.VAR`, and call external binaries with `^name` when a Nushell builtin would shadow them. There is no `&&`, no `export`, and no `$?` — use `$env.LAST_EXIT_CODE` instead.",
    "- POSIX-only tools must be invoked explicitly, e.g. `^bash -c '…'` or `^zsh -c '…'`.",
    "- Working directory persists between calls, but prefer absolute paths — `cd` in a compound command can trigger a permission prompt. Shell state (env vars, functions) does not persist; the shell is initialized from the user's profile.",
    "- IMPORTANT: Avoid using this tool to run `find`, `grep`, `cat`, `head`, `tail`, `sed`, `awk`, or `echo` commands, unless explicitly instructed or after you have verified that a dedicated tool cannot accomplish your task. Instead, use the appropriate dedicated tool as this will provide a much better experience for the user.",
    "- Command output is displayed to you, not reliably to the user.",
    `- \`timeout\` is in milliseconds: default ${input.defaultTimeoutMs}, max ${input.maxTimeoutMs} for a foreground command.`,
    "- `run_in_background` runs the command detached: it keeps running across turns and re-invokes you when it exits. No `&` needed.",
    "",
    "# Git",
    "- Interactive flags (`-i`, e.g. `git rebase -i`, `git add -i`) are not supported in this environment.",
    "- Use the `gh` CLI for GitHub operations (PRs, issues, API).",
    "- Commit or push only when the user asks. If on the default branch, branch first.",
  ].join("\n");
}
