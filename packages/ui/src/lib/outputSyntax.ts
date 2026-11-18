// Structured output detection: when a command emits structured text but no
// ANSI, highlight it with the matching shiki grammar. Detection is deliberately
// conservative — a false positive paints prose as YAML, which is worse than
// plain text. Only shapes with an unambiguous signature are accepted.
const MAX_SYNTAX_HIGHLIGHT_BYTES = 64_000;
const MAX_FORMATTED_DISPLAY_BYTES = 150_000;

// ANSI SGR for the generated table; ExecuteOutput already renders ANSI spans.
const ANSI_RESET = "\u001b[0m";
const ANSI_HEADER = "\u001b[1;36m";
const ANSI_NUMBER = "\u001b[32m";
const ANSI_BOOLEAN = "\u001b[33m";
const ANSI_NULL = "\u001b[2m";

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

// Display-only formatting: the model keeps the original text, the card shows
// JSON pretty-printed (uniform object arrays as an aligned table), JSON Lines
// expanded, and delimited rows aligned. YAML/TOML/XML are already structured.
export function formatOutputForDisplay(text: string, language: OutputSyntaxLanguage): string {
  if (language === "json") {
    const table = jsonArrayToAnsiTable(text);
    if (table) return table;
    return bounded(prettyJson(text), text);
  }
  if (language === "jsonl") {
    const pretty = text
      .trim()
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => prettyJson(line.trim()))
      .join("\n\n");
    return bounded(pretty, text);
  }
  if (language === "csv" || language === "tsv") {
    return bounded(alignDelimited(text, language === "csv" ? "," : "\t"), text);
  }
  return text;
}

function bounded(candidate: string, fallback: string): string {
  return candidate.length <= MAX_FORMATTED_DISPLAY_BYTES ? candidate : fallback;
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

type Scalar = string | number | boolean | null;
type ScalarRow = Record<string, Scalar>;

// A JSON array of uniform scalar records reads far better as a table than as
// pretty-printed objects; the header and typed cells carry ANSI colors.
function jsonArrayToAnsiTable(text: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.trim());
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length < 2 || !parsed.every(isScalarRow)) return null;

  const rows = parsed as ScalarRow[];
  const keys = Object.keys(rows[0]!);
  if (keys.length === 0) return null;
  const uniform = rows.every(
    (row) => Object.keys(row).length === keys.length && keys.every((key) => key in row),
  );
  if (!uniform) return null;

  const cells = rows.map((row) => keys.map((key) => renderCell(row[key]!)));
  const widths = keys.map((key, index) =>
    Math.max(key.length, ...cells.map((row) => row[index]!.plain.length)),
  );
  const header = keys
    .map((key, index) => `${ANSI_HEADER}${key.padEnd(widths[index]!)}${ANSI_RESET}`)
    .join("  ");
  const body = cells.map((row) =>
    row
      .map((cell, index) => `${cell.prefix}${cell.plain.padEnd(widths[index]!)}${cell.suffix}`)
      .join("  "),
  );
  return bounded([header, ...body].join("\n"), text);
}

function isScalarRow(value: unknown): value is ScalarRow {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Object.values(value).every(
    (item) =>
      item === null ||
      typeof item === "string" ||
      typeof item === "number" ||
      typeof item === "boolean",
  );
}

function renderCell(value: Scalar): { plain: string; prefix: string; suffix: string } {
  if (value === null) return { plain: "null", prefix: ANSI_NULL, suffix: ANSI_RESET };
  if (typeof value === "number") {
    return { plain: String(value), prefix: ANSI_NUMBER, suffix: ANSI_RESET };
  }
  if (typeof value === "boolean") {
    return { plain: String(value), prefix: ANSI_BOOLEAN, suffix: ANSI_RESET };
  }
  return { plain: value.replace(/\n/g, "\\n"), prefix: "", suffix: "" };
}
