// @vitest-environment jsdom

import { createElement, useState } from "react";
import { act, cleanup, fireEvent, render, screen } from "./fork-testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TID_V4_TOOL_BACKGROUND, testId } from "@zcode/shared/test-ids";
import { ToolCallBlock } from "@/ToolCallBlocks.js";
import { canBackgroundToolCall, PILL_DELAY_MS } from "@/ToolCallBlocks/ToolBackgroundButton.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import type { TaskChatToolCallTreeNode } from "@/lib/toolCallTree.js";

// ctrl+b parity: any running tool row that the host marks `raw.backgroundable` gets
// the single-tool "Go to background" pill after PILL_DELAY_MS of uninterrupted
// running. DOM contract: data-testid = testId("v4-tool-background", toolCallId),
// rendered as a sibling below the generic tool card (same placement as
// ToolSnapshotFieldNotice: it does not hide with the collapsed body).

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

// fork-testing only exports getByTestId (which asserts presence); absence and count
// assertions use the same filter logic locally.
function queryAllByTestId(id: string): Element[] {
  return Array.from(document.body.querySelectorAll("[data-testid]")).filter(
    (element) => element.getAttribute("data-testid") === id,
  );
}

function queryByTestId(id: string): Element | null {
  return queryAllByTestId(id)[0] ?? null;
}

// Mirrors the v4/toolCallRowAdapter.toolCallRowToLegacyNode raw bridge shape
// (only the keys this feature consumes).
function toolNode(options: {
  toolCallId: string;
  toolName: string;
  input?: unknown;
  v4Status: string;
  backgroundable?: true;
  backgrounded?: true;
  legacyStatus?: string;
}): TaskChatToolCallTreeNode {
  return {
    toolCall: {
      toolId: options.toolCallId,
      toolName: options.toolName,
      kind: options.toolName,
      input: options.input ?? {},
      status:
        options.legacyStatus ?? (options.v4Status === "running" ? "in_progress" : "completed"),
      raw: {
        toolCallId: options.toolCallId,
        toolName: options.toolName,
        v4Status: options.v4Status,
        ...(options.backgroundable ? { backgroundable: true } : {}),
        ...(options.backgrounded ? { backgrounded: true } : {}),
      },
    },
    childToolCalls: [],
  };
}

function executeNode(options: {
  toolCallId: string;
  v4Status: string;
  backgroundable?: true;
  backgrounded?: true;
  legacyStatus?: string;
}): TaskChatToolCallTreeNode {
  return toolNode({
    ...options,
    toolName: "Bash",
    input: { command: "sleep 30" },
  });
}

function agentNode(options: {
  toolCallId: string;
  v4Status: string;
  backgroundable?: true;
  backgrounded?: true;
  legacyStatus?: string;
}): TaskChatToolCallTreeNode {
  return toolNode({
    ...options,
    toolName: "Agent",
    input: { description: "Investigate the failure" },
  });
}

function grepNode(options: {
  toolCallId: string;
  v4Status: string;
  backgroundable?: true;
  backgrounded?: true;
}): TaskChatToolCallTreeNode {
  return toolNode({
    ...options,
    toolName: "Grep",
    input: { pattern: "needle", path: "src" },
  });
}

type BackgroundHandler = (toolCallId: string) => void;

function blockProps(node: TaskChatToolCallTreeNode, onBackgroundToolCall?: BackgroundHandler) {
  return {
    toolCallNode: node,
    workspacePath: "/tmp/workspace",
    ...(onBackgroundToolCall ? { onBackgroundToolCall } : {}),
  };
}

function renderBlock(node: TaskChatToolCallTreeNode, onBackgroundToolCall?: BackgroundHandler) {
  return render(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "en-US" },
      createElement(ToolCallBlock, blockProps(node, onBackgroundToolCall)),
    ),
  );
}

// Stateful host harness: lets a test flip the same card from running to backgrounded
// (or any terminal status) without a remount, matching real projection updates.
function renderUpdatable(
  initialNode: TaskChatToolCallTreeNode,
  onBackgroundToolCall?: BackgroundHandler,
) {
  let updateNode: ((node: TaskChatToolCallTreeNode) => void) | undefined;

  function Harness() {
    const [node, setNode] = useState(initialNode);
    updateNode = setNode;
    return createElement(ToolCallBlock, blockProps(node, onBackgroundToolCall));
  }

  render(createElement(ZCodeIntlProvider, { initialLocale: "en-US" }, createElement(Harness)));

  return {
    update(nextNode: TaskChatToolCallTreeNode): void {
      act(() => {
        updateNode?.(nextNode);
      });
    },
  };
}

function advance(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

describe("per-tool Go to background delay", () => {
  it("declares the 2.5s delay constant", () => {
    expect(PILL_DELAY_MS).toBe(2500);
  });

  it("stays hidden at 2400ms and appears at 2500ms for a running backgroundable row", () => {
    renderBlock(
      executeNode({ toolCallId: "tc-delay", v4Status: "running", backgroundable: true }),
      () => {},
    );

    advance(PILL_DELAY_MS - 100);
    expect(queryByTestId(testId(TID_V4_TOOL_BACKGROUND, "tc-delay"))).toBeNull();

    advance(100);
    expect(screen.getByTestId(testId(TID_V4_TOOL_BACKGROUND, "tc-delay"))).toBeTruthy();
  });
});

describe("Bash (execute) card", () => {
  it("renders the pill with the toolCallId test id after the delay", () => {
    renderBlock(
      executeNode({ toolCallId: "tc-live", v4Status: "running", backgroundable: true }),
      () => {},
    );
    advance(PILL_DELAY_MS);
    expect(screen.getByTestId(testId(TID_V4_TOOL_BACKGROUND, "tc-live"))).toBeTruthy();
  });

  it("never renders without the host backgroundable capability", () => {
    renderBlock(executeNode({ toolCallId: "tc-no-cap", v4Status: "running" }), () => {});
    advance(PILL_DELAY_MS * 4);
    expect(queryByTestId(testId(TID_V4_TOOL_BACKGROUND, "tc-no-cap"))).toBeNull();
  });

  it("hides immediately once the projection flips the row to backgrounded", () => {
    const view = renderUpdatable(
      executeNode({ toolCallId: "tc-bg", v4Status: "running", backgroundable: true }),
      () => {},
    );
    advance(PILL_DELAY_MS);
    expect(screen.getByTestId(testId(TID_V4_TOOL_BACKGROUND, "tc-bg"))).toBeTruthy();

    view.update(
      executeNode({
        toolCallId: "tc-bg",
        v4Status: "running",
        backgroundable: true,
        backgrounded: true,
      }),
    );
    expect(queryByTestId(testId(TID_V4_TOOL_BACKGROUND, "tc-bg"))).toBeNull();
  });

  it("never renders for a terminal (success) row", () => {
    renderBlock(
      executeNode({ toolCallId: "tc-done", v4Status: "success", backgroundable: true }),
      () => {},
    );
    advance(PILL_DELAY_MS * 4);
    expect(queryByTestId(testId(TID_V4_TOOL_BACKGROUND, "tc-done"))).toBeNull();
  });

  it("never renders for a pending row", () => {
    renderBlock(
      executeNode({
        toolCallId: "tc-pending",
        v4Status: "pendingApproval",
        backgroundable: true,
        legacyStatus: "pending",
      }),
      () => {},
    );
    advance(PILL_DELAY_MS * 4);
    expect(queryByTestId(testId(TID_V4_TOOL_BACKGROUND, "tc-pending"))).toBeNull();
  });

  it("never renders while the host handler is absent", () => {
    renderBlock(executeNode({ toolCallId: "tc-ro", v4Status: "running", backgroundable: true }));
    advance(PILL_DELAY_MS * 4);
    expect(queryByTestId(testId(TID_V4_TOOL_BACKGROUND, "tc-ro"))).toBeNull();
  });

  it("click hands this card's toolCallId to the host dispatcher", () => {
    const dispatched: string[] = [];
    renderBlock(
      executeNode({ toolCallId: "tc-click", v4Status: "running", backgroundable: true }),
      (toolCallId) => dispatched.push(toolCallId),
    );
    advance(PILL_DELAY_MS);
    fireEvent.click(screen.getByTestId(testId(TID_V4_TOOL_BACKGROUND, "tc-click")));
    expect(dispatched).toEqual(["tc-click"]);
  });
});

describe("generic family cards", () => {
  it("gives a non-Bash/non-Agent family (Grep) the same pill after the delay", () => {
    renderBlock(
      grepNode({ toolCallId: "grep-live", v4Status: "running", backgroundable: true }),
      () => {},
    );
    advance(PILL_DELAY_MS);
    expect(screen.getByTestId(testId(TID_V4_TOOL_BACKGROUND, "grep-live"))).toBeTruthy();
  });

  it("never renders for a generic family row without backgroundable", () => {
    renderBlock(grepNode({ toolCallId: "grep-no-cap", v4Status: "running" }), () => {});
    advance(PILL_DELAY_MS * 4);
    expect(queryByTestId(testId(TID_V4_TOOL_BACKGROUND, "grep-no-cap"))).toBeNull();
  });

  it("never renders once a generic row is backgrounded", () => {
    renderBlock(
      grepNode({
        toolCallId: "grep-bg",
        v4Status: "running",
        backgroundable: true,
        backgrounded: true,
      }),
      () => {},
    );
    advance(PILL_DELAY_MS * 4);
    expect(queryByTestId(testId(TID_V4_TOOL_BACKGROUND, "grep-bg"))).toBeNull();
  });

  it("keeps the Background suffix near the card once backgrounded", () => {
    renderBlock(
      grepNode({
        toolCallId: "grep-suffix",
        v4Status: "running",
        backgroundable: true,
        backgrounded: true,
      }),
      () => {},
    );
    expect(screen.getByText("· Background")).toBeTruthy();
  });
});

describe("Agent card", () => {
  it("renders the pill with the toolCallId test id after the delay", () => {
    renderBlock(
      agentNode({ toolCallId: "agent-live", v4Status: "running", backgroundable: true }),
      () => {},
    );
    advance(PILL_DELAY_MS);
    expect(screen.getByTestId(testId(TID_V4_TOOL_BACKGROUND, "agent-live"))).toBeTruthy();
  });

  it("never renders without the host backgroundable capability", () => {
    renderBlock(agentNode({ toolCallId: "agent-no-cap", v4Status: "running" }), () => {});
    advance(PILL_DELAY_MS * 4);
    expect(queryByTestId(testId(TID_V4_TOOL_BACKGROUND, "agent-no-cap"))).toBeNull();
  });

  it("hides immediately once the projection flips the row to backgrounded", () => {
    const view = renderUpdatable(
      agentNode({ toolCallId: "agent-bg", v4Status: "running", backgroundable: true }),
      () => {},
    );
    advance(PILL_DELAY_MS);
    expect(screen.getByTestId(testId(TID_V4_TOOL_BACKGROUND, "agent-bg"))).toBeTruthy();

    view.update(
      agentNode({
        toolCallId: "agent-bg",
        v4Status: "running",
        backgroundable: true,
        backgrounded: true,
      }),
    );
    expect(queryByTestId(testId(TID_V4_TOOL_BACKGROUND, "agent-bg"))).toBeNull();
  });

  it("never renders for a terminal (success) row", () => {
    renderBlock(
      agentNode({ toolCallId: "agent-done", v4Status: "success", backgroundable: true }),
      () => {},
    );
    advance(PILL_DELAY_MS * 4);
    expect(queryByTestId(testId(TID_V4_TOOL_BACKGROUND, "agent-done"))).toBeNull();
  });

  it("never renders while the host handler is absent", () => {
    renderBlock(agentNode({ toolCallId: "agent-ro", v4Status: "running", backgroundable: true }));
    advance(PILL_DELAY_MS * 4);
    expect(queryByTestId(testId(TID_V4_TOOL_BACKGROUND, "agent-ro"))).toBeNull();
  });

  it("click hands this card's toolCallId to the host dispatcher", () => {
    const dispatched: string[] = [];
    renderBlock(
      agentNode({ toolCallId: "agent-click", v4Status: "running", backgroundable: true }),
      (toolCallId) => dispatched.push(toolCallId),
    );
    advance(PILL_DELAY_MS);
    fireEvent.click(screen.getByTestId(testId(TID_V4_TOOL_BACKGROUND, "agent-click")));
    expect(dispatched).toEqual(["agent-click"]);
  });
});

describe("single mount per card", () => {
  it("renders exactly one pill for a Bash card", () => {
    renderBlock(
      executeNode({ toolCallId: "one-bash", v4Status: "running", backgroundable: true }),
      () => {},
    );
    advance(PILL_DELAY_MS);
    expect(queryAllByTestId(testId(TID_V4_TOOL_BACKGROUND, "one-bash"))).toHaveLength(1);
  });

  it("renders exactly one pill for an Agent card", () => {
    renderBlock(
      agentNode({ toolCallId: "one-agent", v4Status: "running", backgroundable: true }),
      () => {},
    );
    advance(PILL_DELAY_MS);
    expect(queryAllByTestId(testId(TID_V4_TOOL_BACKGROUND, "one-agent"))).toHaveLength(1);
  });

  it("renders exactly one pill for a generic family card", () => {
    renderBlock(
      grepNode({ toolCallId: "one-grep", v4Status: "running", backgroundable: true }),
      () => {},
    );
    advance(PILL_DELAY_MS);
    expect(queryAllByTestId(testId(TID_V4_TOOL_BACKGROUND, "one-grep"))).toHaveLength(1);
  });
});

describe("canBackgroundToolCall gate", () => {
  it("requires the host capability, a handler, a plain record, running status and no prior flip", () => {
    expect(canBackgroundToolCall({ v4Status: "running", backgroundable: true }, true, false)).toBe(
      true,
    );
    expect(canBackgroundToolCall({ v4Status: "running" }, true, false)).toBe(false);
    expect(canBackgroundToolCall({ v4Status: "running", backgroundable: false }, true, false)).toBe(
      false,
    );
    expect(
      canBackgroundToolCall(
        { v4Status: "running", backgroundable: true, backgrounded: true },
        true,
        false,
      ),
    ).toBe(false);
    expect(canBackgroundToolCall({ v4Status: "success", backgroundable: true }, true, false)).toBe(
      false,
    );
    expect(
      canBackgroundToolCall({ v4Status: "pendingApproval", backgroundable: true }, true, false),
    ).toBe(false);
    expect(canBackgroundToolCall({ v4Status: "running", backgroundable: true }, false, false)).toBe(
      false,
    );
    expect(canBackgroundToolCall({ v4Status: "running", backgroundable: true }, true, true)).toBe(
      false,
    );
    expect(canBackgroundToolCall(["running"], true, false)).toBe(false);
    expect(canBackgroundToolCall("running", true, false)).toBe(false);
    expect(canBackgroundToolCall(null, true, false)).toBe(false);
  });
});
