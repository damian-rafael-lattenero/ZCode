// @vitest-environment jsdom

import { createElement } from "react";
import { cleanup, render, screen, act } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ZCodeApiRetryStatus } from "@zcode/shared";
import type { ApiRetryState } from "@zcode/shared";
import { toRetryStatus } from "@/v4/ConversationTurnGroup.js";
import {
  apiRetryStatusMessageId,
  ChatApiRetryStatus,
  formatRetryCountdown,
} from "@/chat-input-toolbar/display.js";

// (FORK·B2) 用消息表模拟 Intl：渲染断言验证选中的 message id，而不是固定文案。
const FAKE_MESSAGES: Record<string, string> = {
  "chat.apiRetryStatus": "Reconnecting... {attempt}/{maxRetries}",
  "chat.apiRetryStatus.serverError": "z.ai server error — retrying {attempt}/{maxRetries}",
  "chat.apiRetryStatus.overloaded": "z.ai overloaded — retrying {attempt}/{maxRetries}",
  "chat.apiRetryStatus.rateLimited": "Rate limited — retrying {attempt}/{maxRetries}",
  "chat.apiRetryStatus.quota": "Quota exhausted — retrying {attempt}/{maxRetries}",
  "chat.apiRetryStatus.authRefresh": "Refreshing sign-in… {attempt}/{maxRetries}",
  "chat.apiRetryStatus.stalled": "Stream stalled — retrying {attempt}/{maxRetries}",
  "chat.apiRetryStatus.network": "Connection lost — retrying {attempt}/{maxRetries}",
  "chat.apiRetryStatus.recovery": "Recovering stream {attempt}/{maxRetries}",
};

const fakeIntl = {
  formatMessage: (desc: { id: string }, values?: Record<string, string>) =>
    (FAKE_MESSAGES[desc.id] ?? `?${desc.id}?`).replace(
      /\{(\w+)\}/g,
      (_match, key: string) => values?.[key] ?? "?",
    ),
} as never;

function retryStatus(overrides: Partial<ZCodeApiRetryStatus> = {}): ZCodeApiRetryStatus {
  return {
    kind: "api_retry",
    attempt: 4,
    maxRetries: 10,
    retryDelayMs: 512_000,
    nextRetryAtMs: null,
    errorStatus: 502,
    error: "Provider returned a server error.",
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("formatRetryCountdown (FORK)", () => {
  it("格式化为 mm:ss；>=1h 用 h:mm:ss；负值钳到 00:00", () => {
    expect(formatRetryCountdown(0)).toBe("00:00");
    expect(formatRetryCountdown(-5_000)).toBe("00:00");
    expect(formatRetryCountdown(59_000)).toBe("00:59");
    expect(formatRetryCountdown(90_000)).toBe("01:30");
    expect(formatRetryCountdown(900_000)).toBe("15:00");
    expect(formatRetryCountdown(3_600_000)).toBe("1:00:00");
  });
});

describe("ChatApiRetryStatus 倒计时 (FORK)", () => {
  it("nextRetryAtMs 存在时显示倒计时并每秒递减", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_790_000_000_000);
    render(
      createElement(ChatApiRetryStatus, {
        apiRetry: retryStatus({ nextRetryAtMs: 1_790_000_000_000 + 90_000 }),
        intl: fakeIntl,
        locale: "en-US",
      }),
    );
    expect(screen.getByText("Reconnecting... 4/10")).toBeTruthy();
    expect(screen.getByText("01:30")).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(31_000);
    });
    expect(screen.getByText("00:59")).toBeTruthy();
  });

  it("nextRetryAtMs 缺失（旧事件 / stream recovery）不渲染倒计时段", () => {
    render(
      createElement(ChatApiRetryStatus, {
        apiRetry: retryStatus({ nextRetryAtMs: null }),
        intl: fakeIntl,
        locale: "en-US",
      }),
    );
    expect(screen.getByText("Reconnecting... 4/10")).toBeTruthy();
    expect(screen.queryByText(/\d{2}:\d{2}/)).toBeNull();
  });
});

describe("apiRetryStatusMessageId — 诚实文案 (FORK·B2)", () => {
  it("已知 reason 映射到对应文案 id", () => {
    expect(apiRetryStatusMessageId("server_error")).toBe("chat.apiRetryStatus.serverError");
    expect(apiRetryStatusMessageId("provider_overloaded")).toBe("chat.apiRetryStatus.overloaded");
    expect(apiRetryStatusMessageId("rate_limited")).toBe("chat.apiRetryStatus.rateLimited");
    expect(apiRetryStatusMessageId("timeout")).toBe("chat.apiRetryStatus.stalled");
    expect(apiRetryStatusMessageId("stream_idle_timeout")).toBe("chat.apiRetryStatus.stalled");
    expect(apiRetryStatusMessageId("network_error")).toBe("chat.apiRetryStatus.network");
    expect(apiRetryStatusMessageId("stream_recovery")).toBe("chat.apiRetryStatus.recovery");
    // (FORK·Ola 4) 配额耗尽与一次性 PAT 刷新不再落回笼统的 "Reconnecting..."。
    expect(apiRetryStatusMessageId("usage_limit_reset")).toBe("chat.apiRetryStatus.quota");
    expect(apiRetryStatusMessageId("auth_refresh")).toBe("chat.apiRetryStatus.authRefresh");
  });

  it("未知/缺省 reason 回退到通用文案 id", () => {
    expect(apiRetryStatusMessageId("something_new")).toBe("chat.apiRetryStatus");
    expect(apiRetryStatusMessageId(null)).toBe("chat.apiRetryStatus");
    expect(apiRetryStatusMessageId(undefined)).toBe("chat.apiRetryStatus");
  });
});

describe("ChatApiRetryStatus 按 reason 选文案 (FORK·B2)", () => {
  it("server_error 显示 z.ai 服务端错误文案（可叠加倒计时）", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_790_000_000_000);
    render(
      createElement(ChatApiRetryStatus, {
        apiRetry: retryStatus({
          reason: "server_error",
          nextRetryAtMs: 1_790_000_000_000 + 52_000,
        }),
        intl: fakeIntl,
        locale: "en-US",
      }),
    );
    expect(screen.getByText("z.ai server error — retrying 4/10")).toBeTruthy();
    expect(screen.getByText("00:52")).toBeTruthy();
  });

  it("stream_recovery 显示流恢复文案且无倒计时", () => {
    render(
      createElement(ChatApiRetryStatus, {
        apiRetry: retryStatus({ reason: "stream_recovery", nextRetryAtMs: null }),
        intl: fakeIntl,
        locale: "en-US",
      }),
    );
    expect(screen.getByText("Recovering stream 4/10")).toBeTruthy();
    expect(screen.queryByText(/\d{2}:\d{2}/)).toBeNull();
  });

  it("usage_limit_reset 显示配额耗尽文案，倒计时指向真实重置时间 (FORK·Ola 4)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_790_000_000_000);
    render(
      createElement(ChatApiRetryStatus, {
        apiRetry: retryStatus({
          reason: "usage_limit_reset",
          nextRetryAtMs: 1_790_000_000_000 + 2 * 3_600_000,
        }),
        intl: fakeIntl,
        locale: "en-US",
      }),
    );
    expect(screen.getByText("Quota exhausted — retrying 4/10")).toBeTruthy();
    expect(screen.getByText("2:00:00")).toBeTruthy();
  });

  it("auth_refresh 显示刷新登录文案而不是笼统的 Reconnecting (FORK)", () => {
    render(
      createElement(ChatApiRetryStatus, {
        apiRetry: retryStatus({ reason: "auth_refresh", nextRetryAtMs: null }),
        intl: fakeIntl,
        locale: "en-US",
      }),
    );
    expect(screen.getByText("Refreshing sign-in… 4/10")).toBeTruthy();
  });

  it("缺省 reason（旧事件）保持通用文案", () => {
    render(
      createElement(ChatApiRetryStatus, {
        apiRetry: retryStatus({ reason: undefined }),
        intl: fakeIntl,
        locale: "en-US",
      }),
    );
    expect(screen.getByText("Reconnecting... 4/10")).toBeTruthy();
  });
});

describe("toRetryStatus — pill v4 最后一公里 (FORK·B2/4b)", () => {
  it("透传 nextRetryAt 与原始 reason（adapter 重试：标签 + 倒计时数据齐全）", () => {
    const status = toRetryStatus({
      attempt: 4,
      maxAttempts: 11,
      nextRetryAt: 1_790_000_000_000 + 52_000,
      reasonCode: "fault.provider.serverError",
      reason: "server_error",
    });
    expect(status).toMatchObject({
      kind: "api_retry",
      attempt: 4,
      maxRetries: 10,
      nextRetryAtMs: 1_790_000_000_000 + 52_000,
      reason: "server_error",
    });
  });

  it("stream_recovery 不渲染倒计时（立即重开），文案走 recovery", () => {
    const status = toRetryStatus({
      attempt: 3,
      maxAttempts: 11,
      nextRetryAt: 1_790_000_000_000,
      reasonCode: "fault.network.sseDisconnected",
      reason: "stream_recovery",
    });
    expect(status.nextRetryAtMs).toBeNull();
    expect(apiRetryStatusMessageId(status.reason)).toBe("chat.apiRetryStatus.recovery");
  });

  it("旧 producer 无 reason 时回退 reasonCode（fault.* 码也在映射表）", () => {
    const status = toRetryStatus({
      attempt: 2,
      maxAttempts: 11,
      nextRetryAt: 1_790_000_000_000 + 4_000,
      reasonCode: "fault.provider.rateLimited",
    });
    expect(status.reason).toBe("fault.provider.rateLimited");
    expect(apiRetryStatusMessageId(status.reason)).toBe("chat.apiRetryStatus.rateLimited");
    expect(status.nextRetryAtMs).toBe(1_790_000_000_000 + 4_000);
  });
});
