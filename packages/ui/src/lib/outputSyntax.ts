// Structured output detection: when a command emits structured text but no
// ANSI, highlight it with the matching shiki grammar. Detection is deliberately
// conservative — a false positive paints prose as YAML, which is worse than
// plain text. Only shapes with an unambiguous signature are accepted.
const MAX_SYNTAX_HIGHLIGHT_BYTES = 64_000;

export type OutputSyntaxLanguage = "json" | "jsonl" | "yaml" | "toml" | "xml" | "csv" | "tsv";

export function detectOutputSyntax(text: string): OutputSyntaxLanguage | null {
  const trimmed = text.trim();
  if (trimmed.length < 2 || trimmed.length > MAX_SYNTAX_HIGHLIGHT_BYTES) return null;
  if (isJsonDocument(trimmed)) return "json";

  const lines = trimmed
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length < 2) return null;

  if (lines.every(isJsonLine)) return "jsonl";
  if (looksLikeXml(trimmed)) return "xml";
  if (looksLikeToml(lines)) return "toml";
  if (looksLikeYaml(lines)) return "yaml";
  if (looksLikeSeparated(lines, ",")) return "csv";
  if (looksLikeSeparated(lines, "\t")) return "tsv";
  return null;
}

function isJsonDocument(trimmed: string): boolean {
  const first = trimmed[0];
  if (first !== "{" && first !== "[") return false;
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

function isJsonLine(line: string): boolean {
  if (!line.startsWith("{") && !line.startsWith("[")) return false;
  try {
    JSON.parse(line);
    return true;
  } catch {
    return false;
  }
}

function looksLikeXml(trimmed: string): boolean {
  return trimmed.startsWith("<") && /^<\/?[A-Za-z?!]/.test(trimmed) && trimmed.includes(">");
}

function looksLikeToml(lines: string[]): boolean {
  const hasSection = lines.some((line) => /^\[[A-Za-z0-9_.\- ]+\]$/.test(line));
  const hasAssignment = lines.some((line) => /^[A-Za-z0-9_.\-"]+\s*=/.test(line));
  return hasSection && hasAssignment;
}

function looksLikeYaml(lines: string[]): boolean {
  if (lines.some((line) => /^[{[<]/.test(line))) return false;
  // Log lines often look like `INFO: message` / `2026-11-18 ...`; never YAML.
  if (lines.some((line) => /^\d{4}-\d{2}-\d{2}/.test(line))) return false;
  if (lines.some((line) => /^(INFO|WARN|WARNING|ERROR|DEBUG|TRACE)\b/.test(line))) return false;
  const keyLines = lines.filter(
    (line) => /^[A-Za-z_][\w.-]*:\s/.test(line) || /^-\s+[A-Za-z_][\w.-]*:/.test(line),
  );
  const listItems = lines.filter((line) => line.startsWith("- "));
  return keyLines.length >= 3 || listItems.length >= 2 || lines.includes("---");
}

function looksLikeSeparated(lines: string[], delimiter: string): boolean {
  if (lines.some((line) => line.startsWith("{") || line.startsWith("<") || line.startsWith("["))) {
    return false;
  }
  const counts = lines.map((line) => line.split(delimiter).length - 1);
  const first = counts[0] ?? 0;
  return first >= 1 && counts.every((count) => count === first);
}

const MAX_FORMATTED_DISPLAY_BYTES = 150_000;

// Display-only formatting: the model keeps the original text, the card shows
// JSON pretty-printed and delimited rows aligned. YAML/TOML/XML are already
// structured line by line, so they render as-is.
export function formatOutputForDisplay(text: string, language: OutputSyntaxLanguage): string {
  if (language === "json") {
    const pretty = prettyJson(text);
    return pretty.length <= MAX_FORMATTED_DISPLAY_BYTES ? pretty : text;
  }
  if (language === "csv" || language === "tsv") {
    const aligned = alignDelimited(text, language === "csv" ? "," : "\t");
    return aligned.length <= MAX_FORMATTED_DISPLAY_BYTES ? aligned : text;
  }
  return text;
}

function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text.trim()), null, 2);
  } catch {
    return text;
  }
}

function alignDelimited(text: string, delimiter: string): string {
  const rows = text
    .trim()
    .split("\n")
    .map((line) => line.split(delimiter).map((cell) => cell.trim()));
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, index) => {
      widths[index] = Math.max(widths[index] ?? 0, cell.length);
    });
  }
  return rows
    .map((row) =>
      row
        .map((cell, index) => cell.padEnd(widths[index] ?? cell.length))
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}
