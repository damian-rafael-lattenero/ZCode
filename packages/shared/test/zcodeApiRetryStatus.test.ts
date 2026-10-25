import { describe, expect, it } from "vitest";
import {
  normalizeZCodeApiRetryStatus,
  zcodeApiRetryFromModelNetworkStatusPayload,
} from "../src/zcode-api-retry-status.js";

describe("normalizeZCodeApiRetryStatus (FORK: nextRetryAtMs 倒计时绝对时间)", () => {
  it("透传 nextAttemptAtMs（adapter model_retry_scheduled 事件）", () => {
    const status = normalizeZCodeApiRetryStatus({
      type: "model_retry_scheduled",
      attempt: 4,
      maxRetries: 10,
      delayMs: 512_000,
      nextAttemptAtMs: 1_790_000_000_000,
    });
    expect(status).toMatchObject({
      kind: "api_retry",
      attempt: 4,
      maxRetries: 10,
      retryDelayMs: 512_000,
      nextRetryAtMs: 1_790_000_000_000,
    });
  });

  it("缺省时回落 null（旧 runtime / core stream recovery 无等待可计）", () => {
    const status = normalizeZCodeApiRetryStatus({ attempt: 2, maxRetries: 10, delayMs: 1000 });
    expect(status?.nextRetryAtMs).toBeNull();
  });

  it("model_retry_scheduled 状态载荷产出带 nextRetryAtMs 的重试状态", () => {
    const status = zcodeApiRetryFromModelNetworkStatusPayload({
      type: "model_retry_scheduled",
      attempt: 1,
      maxRetries: 10,
      delayMs: 2000,
      nextAttemptAtMs: 1_790_000_000_000,
    });
    expect(status).toMatchObject({
      kind: "api_retry",
      attempt: 1,
      nextRetryAtMs: 1_790_000_000_000,
    });
  });

  it("streamRecovery 来源的重试状态没有倒计时（立即重开）", () => {
    const status = zcodeApiRetryFromModelNetworkStatusPayload({
      type: "model_request_started",
      attempt: 1,
      streamRecovery: { retryNumber: 2, maxRetries: 10 },
    });
    expect(status).toMatchObject({ kind: "api_retry", attempt: 2, nextRetryAtMs: null });
  });

  // (FORK·B2) reason 透传：UI 靠它区分网关 502 / 限流 / 流恢复的诚实文案。
  it("model_retry_scheduled 状态载荷透传 reason", () => {
    const status = zcodeApiRetryFromModelNetworkStatusPayload({
      type: "model_retry_scheduled",
      attempt: 6,
      maxRetries: 10,
      delayMs: 52_381,
      reason: "server_error",
    });
    expect(status).toMatchObject({ kind: "api_retry", attempt: 6, reason: "server_error" });
  });

  it("payload 无 reason 时归一为 null（旧事件）", () => {
    const status = normalizeZCodeApiRetryStatus({ attempt: 2, maxRetries: 10, delayMs: 1000 });
    expect(status?.reason).toBeNull();
  });

  it("streamRecovery 来源标记 reason=stream_recovery（UI 独立文案）", () => {
    const status = zcodeApiRetryFromModelNetworkStatusPayload({
      type: "model_request_started",
      attempt: 1,
      streamRecovery: { retryNumber: 3, maxRetries: 10 },
    });
    expect(status).toMatchObject({ reason: "stream_recovery" });
  });
});
