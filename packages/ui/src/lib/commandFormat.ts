// Display-only command formatting: split top-level pipelines and statements
// into readable lines. Strings, closures, brackets and comments are tracked so
// the split never lands inside them. The rendered command stays valid Nushell
// (pipelines and `;` may span lines), and copy keeps the same semantics.
export function formatCommandForDisplay(command: string): string {
  const lines: string[] = [];
  let current = "";
  let quote: '"' | "'" | "`" | null = null;
  let depth = 0;
  let inComment = false;

  const flush = (suffix: string): void => {
    const line = current.trimEnd();
    if (line.length > 0) lines.push(line + suffix);
    current = "";
  };

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;

    if (!inComment && quote === null && current.length === 0) {
      if (char === " " || char === "\t") continue;
    }

    if (inComment) {
      current += char;
      if (char === "\n") inComment = false;
      continue;
    }

    if (quote) {
      current += char;
      if (char === "\\" && quote === '"' && index + 1 < command.length) {
        current += command[index + 1]!;
        index += 1;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      current += char;
      continue;
    }

    if (char === "#" && isTokenBoundary(command[index - 1])) {
      inComment = true;
      current += char;
      continue;
    }

    if (char === "(" || char === "[" || char === "{") {
      depth += 1;
      current += char;
      continue;
    }
    if (char === ")" || char === "]" || char === "}") {
      depth = Math.max(0, depth - 1);
      current += char;
      continue;
    }

    if (depth === 0 && char === "|" && command[index - 1] !== "|" && command[index + 1] !== "|") {
      const line = current.trimEnd();
      if (line.length > 0) lines.push(line);
      current = "  | ";
      index = skipSpaces(command, index);
      continue;
    }

    if (depth === 0 && char === ";") {
      flush(";");
      index = skipSpaces(command, index);
      continue;
    }

    current += char;
  }

  flush("");
  return lines.join("\n");
}

function skipSpaces(command: string, index: number): number {
  let next = index;
  while (next + 1 < command.length) {
    const char = command[next + 1];
    if (char !== " " && char !== "\t") break;
    next += 1;
  }
  return next;
}

function isTokenBoundary(previous: string | undefined): boolean {
  return previous === undefined || /[\s;|()]/.test(previous);
}
