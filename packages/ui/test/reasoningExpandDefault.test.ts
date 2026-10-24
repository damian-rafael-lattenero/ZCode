// @vitest-environment jsdom

import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ReasoningRow } from "@zcode/shared/zcode-protocol-v4";
import { TID_CHAT_REASONING_TRIGGER } from "@zcode/shared/test-ids";
import { ReasoningRowView } from "@/v4/ConversationRowView.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import {
  resetConversationExpandDefaultForTest,
  setConversationExpandDefault,
} from "@/ToolCallBlocks/conversationExpandDefaultStore.js";

afterEach(() => {
  cleanup();
  resetConversationExpandDefaultForTest();
});

function reasoningRow(overrides: Partial<ReasoningRow> = {}): ReasoningRow {
  return {
    rowId: 1,
    turnId: "turn-1",
    text: "REASONING-BODY",
    state: "complete",
    createdAt: 0,
    createdAtSeq: 0,
    ...overrides,
  };
}

function renderReasoning(row: ReasoningRow = reasoningRow()) {
  return render(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(ReasoningRowView, { row }),
    ),
  );
}

describe("ReasoningRowView「默认展开全部」偏好（spec：docs/specs/conversation-verbosity-views.md）", () => {
  it("默认收起；偏好翻开后思考内容立即出现（已挂载块回溯展开）", async () => {
    renderReasoning();
    expect(screen.queryByText("REASONING-BODY")).toBeNull();

    setConversationExpandDefault(true);
    expect(await screen.findByText("REASONING-BODY")).toBeTruthy();
  });

  it("偏好打开时完成态思考块保持展开（完成自动收起被偏好禁用）", async () => {
    setConversationExpandDefault(true);
    renderReasoning();
    // 若 autoCollapse 未被禁用，挂载后的 autoCollapseKey 效果会立刻收起内容。
    expect(await screen.findByText("REASONING-BODY")).toBeTruthy();
  });

  it("偏好打开不锁定：仍可手动收起，且偏好翻转后回溯重置", async () => {
    setConversationExpandDefault(true);
    renderReasoning();
    expect(await screen.findByText("REASONING-BODY")).toBeTruthy();

    fireEvent.click(screen.getByTestId(TID_CHAT_REASONING_TRIGGER));
    await waitFor(
      () => {
        expect(screen.queryByText("REASONING-BODY")).toBeNull();
      },
      { timeout: 1000 },
    );

    // 手动收起只在本偏好代际内有效：epoch 递增 ⇒ 重挂载回到新默认值。
    setConversationExpandDefault(false);
    setConversationExpandDefault(true);
    expect(await screen.findByText("REASONING-BODY")).toBeTruthy();
  });

  it("偏好收回后，历史思考块回溯收起", async () => {
    setConversationExpandDefault(true);
    renderReasoning();
    expect(await screen.findByText("REASONING-BODY")).toBeTruthy();

    setConversationExpandDefault(false);
    await waitFor(
      () => {
        expect(screen.queryByText("REASONING-BODY")).toBeNull();
      },
      { timeout: 1000 },
    );
  });
});
