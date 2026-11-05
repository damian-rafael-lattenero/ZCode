// @vitest-environment jsdom

import { createElement } from "react";
import { cleanup, fireEvent, render, screen } from "./fork-testing";
import { afterEach, describe, expect, it } from "vitest";
import { TID_V4_TOOL_BACKGROUND, testId } from "@zcode/shared/test-ids";
import { ToolCallBlock } from "@/ToolCallBlocks.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import type { TaskChatToolCallTreeNode } from "@/lib/toolCallTree.js";

// ctrl+b parity：运行中的 Bash 卡获得单工具粒度的「Go to background」。
// DOM 契约：data-testid = testId("v4-tool-background", toolCallId)，渲染在 execute 卡
// 下方（ToolSnapshotFieldNotice 同款「不随收起隐藏」位置），仅当
// raw.v4Status === "running" && raw.backgrounded !== true && onBackgroundToolCall 在场。

afterEach(cleanup);

// fork-testing 只导出 getByTestId（断言存在）；缺席断言用同款过滤逻辑就地实现。
function queryByTestId(id: string): Element | null {
  return (
    Array.from(document.body.querySelectorAll("[data-testid]")).find(
      (element) => element.getAttribute("data-testid") === id,
    ) ?? null
  );
}

// 与 v4/toolCallRowAdapter.toolCallRowToLegacyNode 的 raw 桥接同形（只含本特性消费的键）。
function executeNode(options: {
  toolCallId: string;
  v4Status: string;
  backgrounded?: true;
  legacyStatus?: string;
}): TaskChatToolCallTreeNode {
  return {
    toolCall: {
      toolId: options.toolCallId,
      toolName: "Bash",
      kind: "Bash",
      input: { command: "sleep 30" },
      status: options.legacyStatus ?? (options.v4Status === "running" ? "in_progress" : "completed"),
      raw: {
        toolCallId: options.toolCallId,
        toolName: "Bash",
        v4Status: options.v4Status,
        ...(options.backgrounded ? { backgrounded: true } : {}),
      },
    },
    childToolCalls: [],
  };
}

function renderBlock(node: TaskChatToolCallTreeNode, onBackgroundToolCall?: (id: string) => void) {
  return render(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "en-US" },
      createElement(ToolCallBlock, {
        toolCallNode: node,
        workspacePath: "/tmp/workspace",
        ...(onBackgroundToolCall ? { onBackgroundToolCall } : {}),
      }),
    ),
  );
}

describe("execute 卡的单工具「Go to background」（ctrl+b parity）", () => {
  it("running 且未 backgrounded 且宿主在场时渲染按钮，testid 带 toolCallId", () => {
    renderBlock(executeNode({ toolCallId: "tc-live", v4Status: "running" }), () => {});
    expect(screen.getByTestId(testId(TID_V4_TOOL_BACKGROUND, "tc-live"))).toBeTruthy();
  });

  it("终态（success）不渲染按钮", () => {
    renderBlock(executeNode({ toolCallId: "tc-done", v4Status: "success" }), () => {});
    expect(queryByTestId(testId(TID_V4_TOOL_BACKGROUND, "tc-done"))).toBeNull();
  });

  it("投影翻成 backgrounded 后不再渲染按钮", () => {
    renderBlock(
      executeNode({ toolCallId: "tc-bg", v4Status: "running", backgrounded: true }),
      () => {},
    );
    expect(queryByTestId(testId(TID_V4_TOOL_BACKGROUND, "tc-bg"))).toBeNull();
  });

  it("宿主缺席（只读 / runtime 未就绪）不渲染按钮", () => {
    renderBlock(executeNode({ toolCallId: "tc-ro", v4Status: "running" }));
    expect(queryByTestId(testId(TID_V4_TOOL_BACKGROUND, "tc-ro"))).toBeNull();
  });

  it("点击把该卡的 toolCallId 交给宿主分发器", () => {
    const dispatched: string[] = [];
    renderBlock(
      executeNode({ toolCallId: "tc-click", v4Status: "running" }),
      (toolCallId) => dispatched.push(toolCallId),
    );
    fireEvent.click(screen.getByTestId(testId(TID_V4_TOOL_BACKGROUND, "tc-click")));
    expect(dispatched).toEqual(["tc-click"]);
  });
});
