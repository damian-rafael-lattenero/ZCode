/** @vitest-environment jsdom */
/* [fork] UI 边界的诚实文案：claim 失败带 reason=verification-unavailable 时，
 * 弹窗必须显示本地化的「这个构建做不到验证」，而不是把原始服务端消息或通用
 * 失败伪装成最终答案；没有原因时仍显示原始消息。同时锁住两份 locale 都有该 key。
 */
import { createElement } from "react";
import { cleanup, render, screen } from "./fork-testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MarketingAction, MarketingDelivery } from "@zcode/shared";
import { MarketingDialogs } from "@/components/marketing-touch/MarketingDialogs.js";
import {
  createMarketingTouchController,
  type MarketingActionResult,
  type PreparedMarketingDelivery,
} from "@/components/marketing-touch/marketingTouchController.js";
import enUS from "@/i18n/locales/en-US.js";
import zhCN from "@/i18n/locales/zh-CN.js";

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    // 返回 id 本身即可断言「选对了 key」；真实文案由 locale 断言覆盖。
    intl: { formatMessage: ({ id }: { id: string }) => id },
    locale: "en-US",
  }),
}));
vi.mock("@/components/ui/toast.js", () => ({ toast: vi.fn() }));
vi.mock("@/components/cloud-content-dialog/CloudContentDialog.js", () => ({
  CloudContentDialog: () => null,
}));
vi.mock("@/components/marketing-touch/marketingPopupAdapter.js", () => ({
  adaptMarketingPopup: () => null,
}));

const verificationKey = "manualClaimPlan.claim.verificationUnavailable";

const bannerDelivery: MarketingDelivery = {
  campaign_id: "campaign-claim-test",
  priority: 0,
  resource_position: "banner",
  banner: {
    background: {
      type: "image",
      image: {
        default: { src: "https://example.com/banner.png", sha256: "a".repeat(64) },
      },
    },
    buttons: [
      {
        text: { format: "plaintext", content: "Claim" },
        action: { type: "claim_zcode_plan", args: { plan_id: "global-build" } },
      },
    ],
  },
};

const candidate: PreparedMarketingDelivery & { scope: string } = {
  delivery: bannerDelivery,
  hero: null,
  scope: "scope-claim-test",
  release: async () => {},
};

function createController(execute?: (action: MarketingAction) => Promise<MarketingActionResult>) {
  return createMarketingTouchController({
    query: async () => ({
      scope: "scope-claim-test",
      serverTime: 0,
      language: "en-US",
      deliveries: [],
      rejectedCount: 0,
    }),
    report: async () => {},
    prepare: async () => {
      throw new Error("prepare is not used by this test");
    },
    execute: execute ?? (async () => ({ status: "failure" })),
    locale: "en-US",
    canOpen: () => true,
    refresh: () => {},
  });
}

afterEach(cleanup);

describe("MarketingDialogs · claim 验证不可用", () => {
  it("带原因时显示本地化文案，不显示原始服务端消息", () => {
    const controller = createController();
    controller.store.setState({
      error: "raw server message",
      errorAction: "claim_zcode_plan",
      errorReason: "verification-unavailable",
    });

    render(createElement(MarketingDialogs, { controller }));

    expect(screen.getByText(verificationKey)).toBeTruthy();
    expect(screen.queryByText("raw server message")).toBeNull();
  });

  it("没有原因时仍显示原始服务端消息", () => {
    const controller = createController();
    controller.store.setState({
      error: "raw server message",
      errorAction: "claim_zcode_plan",
      errorReason: null,
    });

    render(createElement(MarketingDialogs, { controller }));

    expect(screen.getByText("raw server message")).toBeTruthy();
    expect(screen.queryByText(verificationKey)).toBeNull();
  });
});

describe("marketingTouchController · errorReason 生命周期", () => {
  it("随失败写入、随 clearError 清理、下一次无原因失败不残留", async () => {
    const results: MarketingActionResult[] = [
      { status: "failure", message: "raw", reason: "verification-unavailable" },
      { status: "failure", message: "raw" },
    ];
    const controller = createController(async () => results.shift() ?? { status: "failure" });
    controller.store.setState({ banner: candidate });

    await controller.clickBanner();
    const failed = controller.store.getState();
    expect(failed.error).toBe("raw");
    expect(failed.errorAction).toBe("claim_zcode_plan");
    expect(failed.errorReason).toBe("verification-unavailable");

    controller.clearError();
    const cleared = controller.store.getState();
    expect(cleared.error).toBeNull();
    expect(cleared.errorAction).toBeNull();
    expect(cleared.errorReason).toBeNull();

    // 栈底仍需有 banner：第一次失败不 terminal，banner 未被移除。
    expect(controller.store.getState().banner).not.toBeNull();
    await controller.clickBanner();
    expect(controller.store.getState().errorReason).toBeNull();
  });
});

describe("locale parity", () => {
  it("en-US 与 zh-CN 都提供 verificationUnavailable 文案", () => {
    expect(enUS[verificationKey]).toContain("official ZCode app");
    expect(zhCN[verificationKey]).toContain("官方 ZCode");
  });
});
