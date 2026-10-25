// @vitest-environment jsdom

import { createElement } from "react";
import { cleanup, render, screen, act } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ZCodeApiRetryStatus } from "@zcode/shared";
import { ChatApiRetryStatus, formatRetryCountdown } from "@/chat-input-toolbar/display.js";

const fakeIntl = {
  formatMessage: (_desc: { id: string }, values?: Record<string, string>) =>
    `Reconnecting... ${values?.attempt ?? "?"}/${values?.maxRetries ?? "?"}`,
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
