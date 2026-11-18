import { useEffect, useState } from "react";
import { highlightCode, type TokenizedCode } from "@/lib/shikiHighlighter.js";
import type { ExpandedSegment } from "@/lib/outputTree.js";

type HighlightSegment = Extract<ExpandedSegment, { kind: "highlight" }>;

// Renders expanded output segments inside the caller's <pre>. Text segments are
// literal; a highlight segment hands its block to shiki, and every line of a
// block gets the segment's indent (inline segments carry none).
export function ExpandedOutput({ segments }: { segments: ExpandedSegment[] }) {
  return (
    <>
      {segments.map((segment, index) =>
        segment.kind === "text" ? (
          <span key={index}>{segment.text}</span>
        ) : (
          <HighlightedSegment key={index} segment={segment} />
        ),
      )}
    </>
  );
}

function HighlightedSegment({ segment }: { segment: HighlightSegment }) {
  const { text, language, indent } = segment;
  const [tokens, setTokens] = useState<TokenizedCode | null>(null);

  useEffect(() => {
    let cancelled = false;
    const immediate = highlightCode(text, language, undefined, (result) => {
      if (!cancelled) setTokens(result);
    });
    if (immediate) setTokens(immediate);
    return () => {
      cancelled = true;
    };
  }, [text, language]);

  if (!tokens) {
    return <span>{indentAll(text, indent)}</span>;
  }

  return (
    <>
      {tokens.tokens.map((line, lineIndex) => (
        <span key={lineIndex}>
          {indent}
          {line.map((token, tokenIndex) => (
            <span key={tokenIndex} style={token.color ? { color: token.color } : undefined}>
              {token.content}
            </span>
          ))}
          {lineIndex < tokens.tokens.length - 1 ? "\n" : null}
        </span>
      ))}
    </>
  );
}

function indentAll(text: string, indent: string): string {
  return text
    .split("\n")
    .map((line) => `${indent}${line}`)
    .join("\n");
}
