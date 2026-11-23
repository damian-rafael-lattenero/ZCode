import type { ExecutionShellSelection } from "@zcode/contracts";
import { FOREGROUND_SLEEP_MIN_SECONDS } from "./bash-semantics.js";

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
    "- `cd` carries to the next call only in the main session, if the command succeeds and ends inside the working directories. Outside them the shell returns to the start folder; otherwise it stays where it was. Prefer absolute paths — `cd` in a compound command can trigger a permission prompt. Shell state (env vars, functions) does not persist; the shell is initialized from the user's profile.",
    `- IMPORTANT: Avoid using this tool to run ${avoidCommands} commands, unless explicitly instructed or after you have verified that a dedicated tool cannot accomplish your task. Instead, use the appropriate dedicated tool as this will provide a much better experience for the user.`,
    "- Command output is displayed to you, not reliably to the user.",
    "- Workspace-controlled adb executables are blocked. Installed SDK adb outside the workspace is allowed; bare adb resolves through SDK paths and absolute PATH entries. Use an SDK absolute path if it is only configured in shell startup files. Android MCP tools are optional.",
    // 显式后台命令提交后清除前台 deadline，上限只约束前台命令。
    `- \`timeout\` is in milliseconds: default ${input.defaultTimeoutMs}, max ${input.maxTimeoutMs} for a foreground command.`,
    // 前台长 sleep 在 validateInput 被拒（bash-semantics.ts），描述与规则读同一个阈值常量。
    `- \`run_in_background\` runs the command detached: it keeps running across turns and re-invokes you when it exits. No \`&\` needed. Foreground \`sleep\` of ${FOREGROUND_SLEEP_MIN_SECONDS} seconds or more is blocked; to wait on a condition, run an until-loop with \`run_in_background\`.`,
    "",
    "# Git",
    "- Interactive flags (`-i`, e.g. `git rebase -i`, `git add -i`) are not supported in this environment.",
    "- Use the `gh` CLI for GitHub operations (PRs, issues, API).",
    "- GitHub notifies the owner of any `@name` written in a PR, issue, or comment. Write a bare `@name` only for a real login you mean to notify. Put roles, placeholders, and code (`@human`, `@reviewer`, `@types/node`) in backticks or drop the `@`, even when copied from project files.",
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
    "- Working directory: a bare `cd <dir>` persists between calls; `cd` inside a pipeline or compound command does not. Prefer absolute paths. Shell state (env vars, functions) does not persist; the shell is initialized from the user's profile.",
    "- IMPORTANT: Avoid using this tool to run `find`, `grep`, `cat`, `head`, `tail`, `sed`, `awk`, or `echo` commands, unless explicitly instructed or after you have verified that a dedicated tool cannot accomplish your task. Instead, use the appropriate dedicated tool as this will provide a much better experience for the user.",
    "- Command output is displayed to you, not reliably to the user.",
    `- \`timeout\` is in milliseconds: default ${input.defaultTimeoutMs}, max ${input.maxTimeoutMs} for a foreground command.`,
    `- \`run_in_background\` runs the command detached: it keeps running across turns and re-invokes you when it exits. No \`&\` needed. Foreground \`sleep\` of ${FOREGROUND_SLEEP_MIN_SECONDS} seconds or more is blocked; to wait on a condition, run the wait loop with \`run_in_background\`.`,
    "",
    "# Git",
    "- Interactive flags (`-i`, e.g. `git rebase -i`, `git add -i`) are not supported in this environment.",
    "- Use the `gh` CLI for GitHub operations (PRs, issues, API).",
    "- Commit or push only when the user asks. If on the default branch, branch first.",
  ].join("\n");
}
