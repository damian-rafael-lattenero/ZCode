import { afterEach, describe, expect, it } from "vitest";
import {
  getConversationExpandDefaultSnapshot,
  resetConversationExpandDefaultForTest,
  setConversationExpandDefault,
  subscribeConversationExpandDefault,
} from "@/ToolCallBlocks/conversationExpandDefaultStore.js";

afterEach(() => {
  resetConversationExpandDefaultForTest();
});

describe("conversationExpandDefaultStore（spec：docs/specs/conversation-verbosity-views.md）", () => {
  it("初态为收起（defaultOpen=false, epoch=0）", () => {
    expect(getConversationExpandDefaultSnapshot()).toEqual({ defaultOpen: false, epoch: 0 });
  });

  it("同值写入为 no-op：不递增 epoch、不通知订阅者", () => {
    let notified = 0;
    const unsubscribe = subscribeConversationExpandDefault(() => {
      notified += 1;
    });
    setConversationExpandDefault(false);
    expect(getConversationExpandDefaultSnapshot()).toEqual({ defaultOpen: false, epoch: 0 });
    expect(notified).toBe(0);
    unsubscribe();
  });

  it("翻转值递增 epoch 并通知订阅者（epoch 是回溯重置的信号）", () => {
    let notified = 0;
    const unsubscribe = subscribeConversationExpandDefault(() => {
      notified += 1;
    });
    setConversationExpandDefault(true);
    expect(getConversationExpandDefaultSnapshot()).toEqual({ defaultOpen: true, epoch: 1 });
    setConversationExpandDefault(false);
    expect(getConversationExpandDefaultSnapshot()).toEqual({ defaultOpen: false, epoch: 2 });
    expect(notified).toBe(2);
    unsubscribe();
  });

  it("退订后不再收到通知", () => {
    let notified = 0;
    const unsubscribe = subscribeConversationExpandDefault(() => {
      notified += 1;
    });
    unsubscribe();
    setConversationExpandDefault(true);
    expect(notified).toBe(0);
  });
});
