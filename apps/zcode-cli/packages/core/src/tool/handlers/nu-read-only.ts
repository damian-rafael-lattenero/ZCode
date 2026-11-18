// Conservative read-only classifier for Nushell commands. Plan mode uses it to
// allow `pwd`, `ls`, `git status`… without trusting the bash AST (which cannot
// prove anything about Nu syntax). False negatives are fine: an unknown command
// stays unproven and is denied in plan mode. False positives are not.
const READ_ONLY_COMMANDS = new Set([
  "pwd",
  "ls",
  "open",
  "cat",
  "which",
  "describe",
  "table",
  "select",
  "where",
  "sort",
  "sort-by",
  "first",
  "last",
  "length",
  "get",
  "columns",
  "find",
  "echo",
  "print",
  "env",
  "ps",
  "date",
  "version",
  "help",
  "scope",
  "lines",
  "split",
  "parse",
  "format",
  "str",
  "into",
  "to",
  "from",
  "math",
  "uniq",
  "uniq-by",
  "group-by",
  "transpose",
  "flatten",
  "wrap",
  "headers",
  "skip",
  "take",
  "nu-highlight",
  "rg",
  "bat",
  "head",
  "tail",
  "wc",
  "file",
  "stat",
  "du",
  "df",
]);

const WRITE_OR_CONTROL_COMMANDS = new Set([
  "save",
  "rm",
  "mv",
  "cp",
  "mkdir",
  "touch",
  "chmod",
  "chown",
  "trash",
  "kill",
  "pkill",
  "sudo",
  "source",
  "export",
  "def",
  "alias",
  "use",
  "module",
  "let",
  "mut",
  "for",
  "while",
  "loop",
  "do",
  "try",
  "if",
  "match",
  "return",
  "break",
  "continue",
  "exec",
  "run-external",
  "start",
  "job",
  "hide-env",
  "load-env",
]);

const GIT_READ_ONLY_SUBCOMMANDS = new Set([
  "status",
  "diff",
  "log",
  "show",
  "branch",
  "rev-parse",
  "remote",
  "tag",
  "describe",
  "config",
  "ls-files",
  "blame",
  "shortlog",
  "whatchanged",
]);

const WRITE_TOKENS = /\b(?:save|rm|mv|cp|mkdir|touch|chmod|chown|trash|kill|pkill|sudo|source)\b/;
// Nu redirection operators are o>/e>/out>/err>; a bare `>` is comparison.
const REDIRECTIONS = /\b(?:o>|e>|out>|err>)/;

export function isNuReadOnlyCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) return false;
  if (WRITE_TOKENS.test(trimmed) || REDIRECTIONS.test(trimmed)) return false;

  const stages = trimmed
    .split(/[|\n;]/)
    .map((stage) => stage.trim())
    .filter((stage) => stage.length > 0);
  if (stages.length === 0) return false;

  for (const stage of stages) {
    const words = stage.split(/\s+/);
    const rawName = words[0] ?? "";
    const name = rawName.startsWith("^") ? rawName.slice(1) : rawName;
    if (name === "git") {
      const subcommand = words[1];
      if (!subcommand || !GIT_READ_ONLY_SUBCOMMANDS.has(subcommand)) return false;
      continue;
    }
    if (WRITE_OR_CONTROL_COMMANDS.has(name)) return false;
    if (!READ_ONLY_COMMANDS.has(name)) return false;
  }
  return true;
}
