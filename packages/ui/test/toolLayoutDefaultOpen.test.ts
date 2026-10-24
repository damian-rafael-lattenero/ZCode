// @vitest-environment jsdom

import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ToolLayout } from "@/ToolCallBlocks/ToolLayout.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import {
  resetConversationExpandDefaultForTest,
  setConversationExpandDefault,
} from "@/ToolCallBlocks/conversationExpandDefaultStore.js";

// toolLayoutOpenState 是模块级 Map：每个用例用独立 toolId，避免跨用例覆盖串扰。
afterEach(() => {
  cleanup();
  resetConversationExpandDefaultForTest();
});

function renderTool(toolId: string) {
  return render(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(ToolLayout, {
        toolId,
        icon: null,
        kindLabel: "Read",
        primaryText: "file.ts",
        content: createElement("div", null, `CONTENT:${toolId}`),
      }),
    ),
  );
}

describe("ToolLayout 默认展开偏好（回溯重置；spec：docs/specs/conversation-verbosity-views.md）", () => {
  it("默认收起；偏好翻开后内容立即出现（已挂载卡片回溯展开）", async () => {
    renderTool("tool-a");
    expect(screen.queryByText("CONTENT:tool-a")).toBeNull();

    setConversationExpandDefault(true);
    expect(await screen.findByText("CONTENT:tool-a")).toBeTruthy();
  });

  it("手动收起成为本代际覆盖；偏好再次翻转时覆盖作废并回到新默认", async () => {
    setConversationExpandDefault(true);
    renderTool("tool-b");
    expect(await screen.findByText("CONTENT:tool-b")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "收起工具详情" }));
    await waitFor(() => {
      expect(screen.queryByText("CONTENT:tool-b")).toBeNull();
    });

    // 偏好 true→false：epoch 递增清空覆盖。新默认也是收起，内容保持缺席；
    // 若覆盖未被清空，之后同卡片再翻回 true 时会仍停在收起（由下一个用例另行覆盖）。
    setConversationExpandDefault(false);
    await waitFor(() => {
      expect(screen.queryByText("CONTENT:tool-b")).toBeNull();
    });
  });

  it("偏好收到开翻转后，即使上一代际被手动收起过也会回溯展开", async () => {
    setConversationExpandDefault(true);
    renderTool("tool-c");
    expect(await screen.findByText("CONTENT:tool-c")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "收起工具详情" }));
    await waitFor(() => {
      expect(screen.queryByText("CONTENT:tool-c")).toBeNull();
    });

    setConversationExpandDefault(false);
    setConversationExpandDefault(true);
    expect(await screen.findByText("CONTENT:tool-c")).toBeTruthy();
  });

  it("偏好收起时新挂载卡片按收起初始化；偏好打开时新挂载卡片按展开初始化", async () => {
    renderTool("tool-d");
    expect(screen.queryByText("CONTENT:tool-d")).toBeNull();
    cleanup();

    setConversationExpandDefault(true);
    renderTool("tool-e");
    expect(await screen.findByText("CONTENT:tool-e")).toBeTruthy();
  });
});
