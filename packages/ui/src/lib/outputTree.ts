// Display tree for structured command output. Mirrors the Nushell-side ADT in
// nushell-fp/mods/highlight.nu: a value is classified ONCE into tagged nodes and
// layout is a recursion over the tree. String leaves that carry structure
// inside are expanded — embedded JSON and Nu code become highlight segments,
// multi-line text becomes real lines — because serializers escape strings and
// shiki never looks inside one.

export type DisplayNode =
  | { tag: "scalar"; text: string }
  | { tag: "text"; text: string }
  | { tag: "json"; text: string }
  | { tag: "code"; text: string }
  | { tag: "lines"; text: string }
  | { tag: "record"; fields: DisplayField[] }
  | { tag: "list"; items: DisplayNode[] };

export interface DisplayField {
  key: string;
  node: DisplayNode;
}

export type ExpandedSegment =
  | { kind: "text"; text: string }
  | { kind: "highlight"; language: string; text: string; indent: string };

const PAD = "  ";
const MARK = "\u0000";

const DECLARATIONS = new Set([
  "let",
  "mut",
  "def",
  "use",
  "alias",
  "source",
  "export",
  "if",
  "for",
  "while",
  "print",
]);

interface BlockSpec {
  language: string;
  text: string;
}

export function classifyOutput(value: unknown): DisplayNode {
  if (Array.isArray(value)) {
    return { tag: "list", items: value.map(classifyOutput) };
  }
  if (value !== null && typeof value === "object") {
    return {
      tag: "record",
      fields: Object.entries(value as Record<string, unknown>).map(([key, child]) => ({
        key,
        node: classifyOutput(child),
      })),
    };
  }
  if (typeof value === "string") {
    return classifyString(value);
  }
  return { tag: "scalar", text: scalarText(value) };
}

function scalarText(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value) ?? String(value);
}

function classifyString(text: string): DisplayNode {
  if (looksLikeJson(text)) return { tag: "json", text };
  if (looksLikeNu(text)) return { tag: "code", text };
  if (text.includes("\n")) return { tag: "lines", text };
  return { tag: "text", text };
}

function looksLikeJson(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return false;
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

// Conservative: a declaration head, an external head, or `$` plus a pipe.
// Prose and log lines stay plain.
function looksLikeNu(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  const head = trimmed.split(" ")[0] ?? "";
  return (
    DECLARATIONS.has(head) ||
    head.startsWith("^") ||
    (trimmed.includes("$") && trimmed.includes(" | "))
  );
}

function isBlockLeaf(node: DisplayNode): boolean {
  if (node.tag === "json") return true;
  if (node.tag === "code" || node.tag === "lines") return node.text.includes("\n");
  return false;
}

export function hasBlockLeaf(node: DisplayNode): boolean {
  if (isBlockLeaf(node)) return true;
  if (node.tag === "record") return node.fields.some((field) => hasBlockLeaf(field.node));
  if (node.tag === "list") return node.items.some(hasBlockLeaf);
  return false;
}

// Parse the display text once; expand only when a string leaf carries
// structure. null means "keep the plain syntax-highlighted path".
export function expandOutputText(text: string): ExpandedSegment[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.trim());
  } catch {
    return null;
  }
  const tree = classifyOutput(parsed);
  return hasBlockLeaf(tree) ? layoutExpanded(tree) : null;
}

export function layoutExpanded(tree: DisplayNode): ExpandedSegment[] {
  const blocks: BlockSpec[] = [];
  const text = layoutNode(tree, "", blocks);
  return segmentsFrom(text, blocks);
}

function layoutNode(node: DisplayNode, pad: string, blocks: BlockSpec[]): string {
  switch (node.tag) {
    case "scalar":
      return node.text;
    case "text":
      return JSON.stringify(node.text);
    case "json":
      return marker(blocks, "json", prettyJson(node.text));
    case "code":
      return marker(blocks, "nu", node.text);
    case "lines":
      return node.text.replace(/\s+$/, "");
    case "record": {
      if (node.fields.length === 0) return "{}";
      const rows = node.fields.map(({ key, node: child }) => {
        const label = `${pad}${PAD}${renderKey(key)}`;
        if (!isBlockLeaf(child)) {
          const value = layoutNode(child, "", blocks);
          return `${label}: ${shiftContinuation(value, PAD)}`;
        }
        const childPad = `${pad}${PAD}${PAD}`;
        if (child.tag === "lines") {
          return `${label}:\n${indentAll(layoutNode(child, "", blocks), childPad)}`;
        }
        // A marker line carries its own indent; the segment expander reads it.
        return `${label}:\n${childPad}${layoutNode(child, childPad, blocks)}`;
      });
      return `{\n${rows.join("\n")}\n${pad}}`;
    }
    case "list": {
      if (node.items.length === 0) return "[]";
      const rows = node.items.map((item) =>
        indentAll(layoutNode(item, "", blocks), `${pad}${PAD}`),
      );
      return `[\n${rows.join("\n")}\n${pad}]`;
    }
  }
}

function marker(blocks: BlockSpec[], language: string, text: string): string {
  blocks.push({ language, text: text.replace(/\s+$/, "") });
  return `${MARK}${blocks.length - 1}${MARK}`;
}

function segmentsFrom(text: string, blocks: BlockSpec[]): ExpandedSegment[] {
  const segments: ExpandedSegment[] = [];
  const pattern = new RegExp(`${MARK}(\\d+)${MARK}`, "g");
  let cursor = 0;
  let match = pattern.exec(text);
  while (match !== null) {
    const start = match.index;
    const lineStart = text.lastIndexOf("\n", start - 1) + 1;
    const linePrefix = text.slice(lineStart, start);
    const atLineStart = linePrefix.trim().length === 0;
    const block = blocks[Number(match[1])];
    if (block) {
      const chunk = text.slice(cursor, start);
      pushText(segments, atLineStart ? chunk.replace(/[ \t]+$/, "") : chunk);
      segments.push({
        kind: "highlight",
        language: block.language,
        text: block.text,
        indent: atLineStart ? linePrefix : "",
      });
      cursor = start + match[0].length;
    }
    match = pattern.exec(text);
  }
  pushText(segments, text.slice(cursor));
  return segments;
}

function pushText(segments: ExpandedSegment[], text: string): void {
  if (text.length === 0) return;
  const previous = segments[segments.length - 1];
  if (previous?.kind === "text") {
    previous.text += text;
  } else {
    segments.push({ kind: "text", text });
  }
}

function indentAll(text: string, pad: string): string {
  return text
    .split("\n")
    .map((line) => `${pad}${line}`)
    .join("\n");
}

function shiftContinuation(text: string, prefix: string): string {
  const rows = text.split("\n");
  if (rows.length <= 1) return text;
  return [rows[0], ...rows.slice(1).map((line) => `${prefix}${line}`)].join("\n");
}

// Keys keep JSON quotes: the card renders the JSON shape it was given, and
// quoted keys are what the json grammar colors.
function renderKey(key: string): string {
  return JSON.stringify(key);
}

function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text.trim()), null, 2);
  } catch {
    return text;
  }
}
