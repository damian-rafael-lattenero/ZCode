// @vitest-environment jsdom

import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "./fork-testing";
import { afterEach, describe, expect, it } from "vitest";
import { ConsecutiveSummaryGroup } from "@/ToolCallBlocks/ToolSummaryRow.js";
import {
  resetConversationExpandDefaultForTest,
  setConversationExpandDefault,
} from "@/ToolCallBlocks/conversationExpandDefaultStore.js";

afterEach(() => {
  cleanup();
  resetConversationExpandDefaultForTest();
});

function renderGroup(key: string) {
  return render(
    createElement(
      ConsecutiveSummaryGroup,
      {
        summary: createElement("span", null, `SUMMARY:${key}`),
        contentKey: key,
        refreshVersion: key,
        statistics: `1 Thought · 1 Read (${key})`,
        lastRowId: 1,
        hasActiveItem: false,
      },
      createElement("div", null, `CHILDREN:${key}`),
    ),
  );
}

describe("ConsecutiveSummaryGroup 默认展开偏好（CoT 摘要组；owner 12/12 根因）", () => {
  it("默认收起；偏好翻开后已挂载的组回溯展开", async () => {
    renderGroup("group-a");
    expect(screen.queryByText("CHILDREN:group-a")).toBeNull();

    setConversationExpandDefault(true);
    expect(await screen.findByText("CHILDREN:group-a")).toBeTruthy();
  });

  it("偏好打开时新挂载的组按展开初始化；手动收起后偏好翻转回到新默认", async () => {
    setConversationExpandDefault(true);
    renderGroup("group-b");
    expect(await screen.findByText("CHILDREN:group-b")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "1 Thought · 1 Read (group-b)" }));
    await waitFor(() => {
      expect(screen.queryByText("CHILDREN:group-b")).toBeNull();
    });

    // 偏好 true→false：epoch 递增清空本代际的手动覆盖。
    setConversationExpandDefault(false);
    await waitFor(() => {
      expect(screen.queryByText("CHILDREN:group-b")).toBeNull();
    });
  });

  it("偏好收起时新挂载的组保持收起", () => {
    renderGroup("group-c");
    expect(screen.queryByText("CHILDREN:group-c")).toBeNull();
  });
});
