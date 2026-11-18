import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { logger } from "@/logger.js";
import { ScrollFadeViewport } from "@/components/ui/scroll-fade-viewport.js";
import { hasAnsi, parseAnsiText } from "@/lib/ansiText.js";
import { highlightCode, type TokenizedCode } from "@/lib/shikiHighlighter.js";
import { detectOutputSyntax, formatOutputForDisplay } from "@/lib/outputSyntax.js";
import { expandOutputText } from "@/lib/outputTree.js";
import { ExpandedOutput } from "@/ToolCallBlocks/renderers/ExpandedOutput.js";

export function ExecuteOutput({ text, running }: { text: string; running: boolean }) {
  const scroll = useRef<HTMLDivElement>(null);
  const previousTop = useRef(0);
  const hasStreamed = useRef(running);
  const [frozen, setFrozen] = useState<string | null>(null);
  const following = frozen === null;
  const display = frozen ?? text;
  const ansiSpans = useMemo(() => (hasAnsi(display) ? parseAnsiText(display) : null), [display]);
  const [syntaxTokens, setSyntaxTokens] = useState<TokenizedCode | null>(null);
  const syntax = useMemo(
    () => (ansiSpans === null ? detectOutputSyntax(display) : null),
    [ansiSpans, display],
  );
  const formatted = useMemo(
    () => (syntax ? formatOutputForDisplay(display, syntax) : display),
    [display, syntax],
  );
  // The formatter can emit ANSI itself (JSON array table); that path skips shiki.
  const formattedSpans = useMemo(
    () => (hasAnsi(formatted) ? parseAnsiText(formatted) : null),
    [formatted],
  );
  const activeSyntax = hasAnsi(formatted) ? null : syntax;

  // JSON that carries structured strings inside gets expanded before any shiki
  // pass (embedded JSON, multi-line text, Nu code); null keeps the plain path.
  const expanded = useMemo(
    () => (ansiSpans === null && syntax === "json" ? expandOutputText(display) : null),
    [ansiSpans, syntax, display],
  );

  useEffect(() => {
    if (!activeSyntax) {
      setSyntaxTokens(null);
      return;
    }
    let cancelled = false;
    const immediate = highlightCode(formatted, activeSyntax, undefined, (result) => {
      if (!cancelled) setSyntaxTokens(result);
    });
    if (immediate) setSyntaxTokens(immediate);
    return () => {
      cancelled = true;
    };
  }, [formatted, activeSyntax]);

  useLayoutEffect(() => {
    if (running) hasStreamed.current = true;
    if (!hasStreamed.current || !following || !scroll.current) return;
    scroll.current.scrollTop = scroll.current.scrollHeight;
    // 程序吸底后记录浏览器实际位置，避免尾窗变短时把程序滚动误判为上滚。
    previousTop.current = scroll.current.scrollTop;
  }, [display, following, running]);

  return (
    <ScrollFadeViewport
      ref={scroll}
      data-testid="bash-output-scroll"
      data-following={following}
      // 原预览与结果的高度上限不同且不吸底；共用五行上限，短内容自适应，结束时保留阅读状态。
      className="min-w-0 max-w-full max-h-[5lh] flex-none overflow-auto leading-5"
      tabIndex={0}
      onScroll={(event) => {
        const el = event.currentTarget;
        const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= 8;
        if (hasStreamed.current && following && el.scrollTop < previousTop.current && !atBottom) {
          setFrozen(display);
          logger.debug("Bash output following changed", { following: false });
        } else if (!following && atBottom) {
          setFrozen(null);
          logger.debug("Bash output following changed", { following: true });
        }
        previousTop.current = el.scrollTop;
      }}
    >
      <pre
        data-testid={running ? "bash-output-preview-full" : "bash-result-output"}
        className="whitespace-pre-wrap break-words font-mono text-ui-base leading-5 text-foreground-subtle"
      >
        {expanded ? (
          <ExpandedOutput segments={expanded} />
        ) : ansiSpans ? (
          ansiSpans.map((span, index) => (
            <span key={index} style={span.style}>
              {span.text}
            </span>
          ))
        ) : formattedSpans ? (
          formattedSpans.map((span, index) => (
            <span key={index} style={span.style}>
              {span.text}
            </span>
          ))
        ) : activeSyntax && syntaxTokens ? (
          syntaxTokens.tokens.map((line, lineIndex) => (
            <span key={lineIndex}>
              {line.map((token, tokenIndex) => (
                <span key={tokenIndex} style={token.color ? { color: token.color } : undefined}>
                  {token.content}
                </span>
              ))}
              {lineIndex < syntaxTokens.tokens.length - 1 ? "\n" : null}
            </span>
          ))
        ) : (
          formatted
        )}
      </pre>
    </ScrollFadeViewport>
  );
}
