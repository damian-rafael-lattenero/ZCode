import assert from "node:assert/strict";
import test from "node:test";
import { getZCodeCopy } from "@zcode/i18n";
import { applyModelNetworkEvent } from "../src/app-network-events.js";
import type { NetworkRequest } from "../src/app-model.js";

// (FORK·Ola 4) 配额耗尽（1308 族 + next_flush_time）的状态行必须与秒级限流区分：
// 等待的是重置窗口（可达小时级），充值后分段探测自动恢复；delayMs 是真实重置等待。

const copy = getZCodeCopy("en-US").tui;

test("usage_limit_reset retry line reads as quota exhaustion with the real resume wait", () => {
  const statuses: string[] = [];
  applyModelNetworkEvent(
    {
      type: "model_retry_scheduled",
      requestId: "req-quota",
      attempt: 1,
      maxAttempts: 11,
      delayMs: 7_200_000,
      reason: "usage_limit_reset",
    },
    () => {},
    (status: string) => statuses.push(status),
    copy,
  );
  assert.deepEqual(statuses, ["Quota exhausted — resuming model request 1/10 in 7200s"]);
});

test("other retry reasons keep the generic retry line with the raw reason", () => {
  const statuses: string[] = [];
  applyModelNetworkEvent(
    {
      type: "model_retry_scheduled",
      requestId: "req-rate-limit",
      attempt: 2,
      maxAttempts: 11,
      delayMs: 4_000,
      reason: "rate_limited",
    },
    () => {},
    (status: string) => statuses.push(status),
    copy,
  );
  assert.deepEqual(statuses, ["Retrying model request 2/10 in 4.0s: rate_limited"]);
});

test("quota retry line also records the pending network request entry", () => {
  const requests: NetworkRequest[][] = [];
  applyModelNetworkEvent(
    {
      type: "model_retry_scheduled",
      requestId: "req-quota-2",
      attempt: 1,
      maxAttempts: 11,
      delayMs: 300_000,
      reason: "usage_limit_reset",
    },
    (update: (current: NetworkRequest[]) => NetworkRequest[]) =>
      requests.push(update([])),
    () => {},
    copy,
  );
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.[0]?.requestId, "req-quota-2");
  assert.equal(requests[0]?.[0]?.status, "pending");
});
