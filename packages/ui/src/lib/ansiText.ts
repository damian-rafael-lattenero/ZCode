// SGR (ANSI color/style) support for Bash tool output. Commands run with
// FORCE_COLOR, so their output carries escapes even through a pipe; the model
// gets a stripped copy and the UI renders these spans instead of raw escapes.
// Only SGR is interpreted; every other escape (cursor, OSC/hyperlinks) is
// dropped so the transcript never executes terminal control sequences.

const ESC = "\u001b";
const ANSI_ESCAPE_SOURCE = `${ESC}(?:\\[[0-?]*[ -/]*[@-~]|\\][^\\u0007]*(?:\\u0007|${ESC}\\\\)|[@-_])`;
const SGR_SOURCE = `^${ESC}\\[([0-9;]*)m$`;

export interface AnsiSpanStyle {
  backgroundColor?: string;
  color?: string;
  fontStyle?: "italic";
  fontWeight?: 600;
  opacity?: number;
  textDecoration?: "underline";
}

export interface AnsiSpan {
  text: string;
  style?: AnsiSpanStyle;
}

// VS Code's terminal palette: readable in the app's dark transcript and close
// enough to the standard 16-color set on light backgrounds.
const BASE_COLORS = [
  "#000000",
  "#cd3131",
  "#0dbc79",
  "#e5e510",
  "#2472c8",
  "#bc3fbc",
  "#11a8cd",
  "#e5e5e5",
  "#666666",
  "#f14c4c",
  "#23d18b",
  "#f5f543",
  "#3b8eea",
  "#d670d6",
  "#29b8db",
  "#e5e5e5",
] as const;

export function hasAnsi(text: string): boolean {
  return text.includes(ESC);
}

export function parseAnsiText(input: string): AnsiSpan[] {
  if (!hasAnsi(input)) return [{ text: input }];

  const escapePattern = new RegExp(ANSI_ESCAPE_SOURCE, "g");
  const sgrPattern = new RegExp(SGR_SOURCE);
  const spans: AnsiSpan[] = [];
  let style: AnsiSpanStyle = {};
  let cursor = 0;
  let match: RegExpExecArray | null;

  const push = (text: string): void => {
    if (!text) return;
    spans.push(Object.keys(style).length === 0 ? { text } : { text, style: { ...style } });
  };

  while ((match = escapePattern.exec(input)) !== null) {
    push(input.slice(cursor, match.index));
    const sgr = sgrPattern.exec(match[0]);
    if (sgr) {
      style = applySgr(style, parseSgrCodes(sgr[1] ?? ""));
    }
    cursor = match.index + match[0].length;
  }
  push(input.slice(cursor));

  return spans.length > 0 ? spans : [{ text: "" }];
}

function parseSgrCodes(raw: string): number[] {
  if (!raw) return [0];
  return raw
    .split(";")
    .map((part) => (part === "" ? 0 : Number.parseInt(part, 10)))
    .filter((code) => Number.isFinite(code));
}

function applySgr(style: AnsiSpanStyle, codes: number[]): AnsiSpanStyle {
  let next: AnsiSpanStyle = { ...style };
  for (let index = 0; index < codes.length; index += 1) {
    const code = codes[index]!;
    if (code === 0) {
      next = {};
    } else if (code === 1) {
      next.fontWeight = 600;
    } else if (code === 2) {
      next.opacity = 0.7;
    } else if (code === 3) {
      next.fontStyle = "italic";
    } else if (code === 4) {
      next.textDecoration = "underline";
    } else if (code === 22) {
      delete next.fontWeight;
      delete next.opacity;
    } else if (code === 23) {
      delete next.fontStyle;
    } else if (code === 24) {
      delete next.textDecoration;
    } else if (code === 39) {
      delete next.color;
    } else if (code === 49) {
      delete next.backgroundColor;
    } else if (code === 38 || code === 48) {
      const key = code === 38 ? "color" : "backgroundColor";
      const mode = codes[index + 1];
      if (mode === 5 && codes[index + 2] !== undefined) {
        next[key] = colorFrom256(codes[index + 2]!);
        index += 2;
      } else if (
        mode === 2 &&
        codes[index + 2] !== undefined &&
        codes[index + 3] !== undefined &&
        codes[index + 4] !== undefined
      ) {
        next[key] = `rgb(${codes[index + 2]}, ${codes[index + 3]}, ${codes[index + 4]})`;
        index += 4;
      }
    } else if (code >= 30 && code <= 37) {
      next.color = BASE_COLORS[code - 30];
    } else if (code >= 90 && code <= 97) {
      next.color = BASE_COLORS[code - 90 + 8];
    } else if (code >= 40 && code <= 47) {
      next.backgroundColor = BASE_COLORS[code - 40];
    } else if (code >= 100 && code <= 107) {
      next.backgroundColor = BASE_COLORS[code - 100 + 8];
    }
  }
  return next;
}

function colorFrom256(index: number): string {
  if (index < 16) return BASE_COLORS[index] ?? BASE_COLORS[7];
  if (index >= 232) {
    const level = 8 + (index - 232) * 10;
    return `rgb(${level}, ${level}, ${level})`;
  }
  const cube = index - 16;
  const component = (value: number): number => (value === 0 ? 0 : 55 + value * 40);
  return `rgb(${component(Math.floor(cube / 36))}, ${component(Math.floor((cube % 36) / 6))}, ${component(cube % 6)})`;
}
