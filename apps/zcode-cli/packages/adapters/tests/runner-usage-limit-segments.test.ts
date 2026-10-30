import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiSdkModelRuntime } from "../src/model/runner.js";
import { ProviderBusinessError } from "../src/model/model-execution.js";
import { USAGE_LIMIT_RESET_SEGMENT_MS } from "../src/model/failure-usage-limit-reset.js";
import {
  TestAiSdkModelAdapter as AiSdkModelAdapter,
  TestProviderConfigFixture,
} from "./test-provider-config.js";
import { executeAdapterGenerateText, executeAdapterStreamText } from "./test-adapter-model.js";
import type { ModelFailureReason, ModelNetworkStatusEvent } from "@zcode/contracts";

// (FORK·Ola 4c) 用量重置等待的分段探测：单段 sleep ≤5min，每段结束重新发出请求。
// 这里验证四件事：
// 1) model_retry_scheduled 按完整等待发布（delayMs/nextAttemptAtMs = 真实 flush 点，倒计时诚实）；
// 2) 实际 sleep 只有 5min——段后立即重发请求，配额回补即恢复（最坏 ~5min 感知）；
// 3) 分段再探测不消耗重试预算（服务端契约：整段配额等待是一次逻辑等待）；
// 4) 段中/段间 abort 仍走既有的终态 model_request_failed 路径。

const NOW_MS = Date.parse("2026-10-25T18:00:00Z");
const FLUSH_AT_MS = NOW_MS + 2 * 3_600_000;

function quotaExhaustedError(flushAtMs: number): ProviderBusinessError {
  return new ProviderBusinessError({
    providerCode: "1308",
    providerId: "account:zai-individual-coding-plan",
    providerKind: "openai-compatible",
    providerMessage: "Your usage limit has been reached.",
    responseBodySummary: {
      error: {
        code: "1308",
        message: "Your usage limit has been reached.",
        next_flush_time: new Date(flushAtMs).toISOString(),
      },
    },
    responseStatus: 429,
    statusCode: 429,
  });
}

function registry(): TestProviderConfigFixture {
  return new TestProviderConfigFixture({
    providers: {
      test: {
        kind: "custom",
        createLanguageModel: (modelId) => ({ modelId }) as never,
      },
    },
  });
}

function usage(inputTokens: number, outputTokens: number) {
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
  };
}

function healthyTextResult(text: string) {
  return {
    text,
    finishReason: "stop",
    usage: usage(2, 3),
    totalUsage: usage(2, 3),
  } as never;
}

const HEALTHY_STREAM_CHUNKS = [
  { type: "start" },
  { type: "text-delta", id: "text-1", text: "quota restored" },
  { type: "finish", finishReason: "stop", totalUsage: usage(1, 1) },
];

async function* stream(chunks: unknown[]) {
  for (const chunk of chunks) {
    yield chunk;
  }
}

async function* failingStream(error: unknown) {
  throw error;
}

async function spinUntil(predicate: () => boolean, label: string, turns = 200): Promise<void> {
  for (let turn = 0; turn < turns && !predicate(); turn += 1) {
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(0);
  }
  expect(predicate(), label).toBe(true);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW_MS);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("(FORK·Ola 4c) generate 路径：用量重置等待分段探测", () => {
  it("sleeps in ≤5min segments, republishes the honest flush countdown, and resumes when quota returns", async () => {
    const events: ModelNetworkStatusEvent[] = [];
    let calls = 0;
    const runtime: AiSdkModelRuntime = {
      async generateText() {
        calls += 1;
        if (calls <= 2) {
          // 两次探测都撞 1308；服务端重复同一 flush 点（也会给更早点——下一个断言只看绝对值）。
          throw quotaExhaustedError(FLUSH_AT_MS);
        }
        return healthyTextResult("quota restored");
      },
      streamText() {
        throw new Error("not used");
      },
    };
    // maxAttempts=2（即只有 1 次重试预算）：分段探测若被当成独立重试，第二段就会耗尽预算。
    const adapter = new AiSdkModelAdapter({
      registry: registry(),
      retry: { baseDelayMs: 0, jitter: false, maxAttempts: 2, maxDelayMs: 0 },
      runtime,
    });

    const resultPromise = executeAdapterGenerateText(adapter, {
      providerId: "test" as never,
      modelId: "model-a" as never,
      messages: [{ role: "user", content: "Ping" }],
      statusSink: { publish: (event) => events.push(event) },
    });

    const retryEvents = () => events.filter((event) => event.type === "model_retry_scheduled");
    const startedEvents = () => events.filter((event) => event.type === "model_request_started");

    await spinUntil(() => retryEvents().length === 1, "first retry_scheduled published");
    // 诚实倒计时：delayMs/nextAttemptAtMs 是完整等待（真实 flush 点），不是 5min 分段。
    expect(retryEvents()[0]).toMatchObject({
      attempt: 1,
      delayMs: 2 * 3_600_000,
      reason: "usage_limit_reset",
    });
    expect(retryEvents()[0].nextAttemptAtMs).toBe(FLUSH_AT_MS);

    // 第一段：只睡 5 分钟就重发请求（不是 2 小时）。
    await vi.advanceTimersByTimeAsync(USAGE_LIMIT_RESET_SEGMENT_MS);
    await spinUntil(() => calls === 2, "segment re-probe issued");
    await spinUntil(() => retryEvents().length === 2, "second retry_scheduled published");
    expect(retryEvents()[1]).toMatchObject({ attempt: 1, reason: "usage_limit_reset" });
    // 新 delayMs = 剩余等待；绝对 nextAttemptAtMs 仍是同一个 flush 点。
    expect(retryEvents()[1].delayMs).toBe(2 * 3_600_000 - USAGE_LIMIT_RESET_SEGMENT_MS);
    expect(retryEvents()[1].nextAttemptAtMs).toBe(FLUSH_AT_MS);

    // 第二段后配额回补：探测成功，turn 继续。
    await vi.advanceTimersByTimeAsync(USAGE_LIMIT_RESET_SEGMENT_MS);
    await expect(resultPromise).resolves.toMatchObject({ text: "quota restored" });
    expect(calls).toBe(3);

    // 分段再探测不消耗重试预算：三次物理请求全部是 attempt 1（1 次重试预算内完成整个等待）。
    expect(startedEvents().map((event) => event.attempt)).toEqual([1, 1, 1]);
  });

  it("abort mid-segment still yields the terminal cancelled failure and no further requests", async () => {
    const abortController = new AbortController();
    const events: ModelNetworkStatusEvent[] = [];
    let calls = 0;
    const runtime: AiSdkModelRuntime = {
      async generateText() {
        calls += 1;
        throw quotaExhaustedError(FLUSH_AT_MS);
      },
      streamText() {
        throw new Error("not used");
      },
    };
    const adapter = new AiSdkModelAdapter({
      registry: registry(),
      retry: { baseDelayMs: 0, jitter: false, maxAttempts: 3, maxDelayMs: 0 },
      runtime,
    });

    const resultPromise = executeAdapterGenerateText(adapter, {
      abortSignal: abortController.signal,
      providerId: "test" as never,
      modelId: "model-a" as never,
      messages: [{ role: "user", content: "Ping" }],
      statusSink: { publish: (event) => events.push(event) },
    });

    await spinUntil(
      () => events.some((event) => event.type === "model_retry_scheduled"),
      "quota wait scheduled",
    );
    // 段中取消：不是等到 2h 后才发现。
    await vi.advanceTimersByTimeAsync(60_000);
    abortController.abort(new Error("user stopped during quota wait"));

    await expect(resultPromise).rejects.toMatchObject({
      context: {
        errorPhase: "connect",
        reason: "cancelled" satisfies ModelFailureReason,
      },
    });
    const failedEvents = events.filter((event) => event.type === "model_request_failed");
    expect(failedEvents.at(-1)).toMatchObject({
      reason: "cancelled",
      retryable: false,
    });
    expect(calls).toBe(1);
  });
});

describe("(FORK·Ola 4c) stream 路径：用量重置等待分段探测", () => {
  it("segments the thrown-failure wait the same way (honest delay, frozen budget)", async () => {
    const events: ModelNetworkStatusEvent[] = [];
    let calls = 0;
    const runtime: AiSdkModelRuntime = {
      generateText() {
        throw new Error("not used");
      },
      streamText() {
        calls += 1;
        if (calls === 1) {
          return { fullStream: failingStream(quotaExhaustedError(FLUSH_AT_MS)) } as never;
        }
        return { fullStream: stream(HEALTHY_STREAM_CHUNKS) } as never;
      },
    };
    const adapter = new AiSdkModelAdapter({
      registry: registry(),
      retry: { baseDelayMs: 0, jitter: false, maxAttempts: 2, maxDelayMs: 0 },
      runtime,
    });

    const collected: unknown[] = [];
    const result = (async () => {
      for await (const event of executeAdapterStreamText(adapter, {
        providerId: "test" as never,
        modelId: "model-a" as never,
        messages: [{ role: "user", content: "Ping" }],
        statusSink: { publish: (event) => events.push(event) },
      })) {
        collected.push(event);
      }
    })();

    const retryEvents = () => events.filter((event) => event.type === "model_retry_scheduled");
    await spinUntil(() => retryEvents().length === 1, "stream retry_scheduled published");
    expect(retryEvents()[0]).toMatchObject({
      attempt: 1,
      delayMs: 2 * 3_600_000,
      reason: "usage_limit_reset",
    });
    expect(retryEvents()[0].nextAttemptAtMs).toBe(FLUSH_AT_MS);

    await vi.advanceTimersByTimeAsync(USAGE_LIMIT_RESET_SEGMENT_MS);
    await result;

    expect(calls).toBe(2);
    expect(collected.some((event) => (event as { type?: string }).type === "text_delta")).toBe(
      true,
    );
    const startedEvents = events.filter((event) => event.type === "model_request_started");
    expect(startedEvents.map((event) => event.attempt)).toEqual([1, 1]);
  });

  it("segments the SSE error-chunk wait and freezes the attempt budget for the re-probe", async () => {
    const events: ModelNetworkStatusEvent[] = [];
    let calls = 0;
    const runtime: AiSdkModelRuntime = {
      generateText() {
        throw new Error("not used");
      },
      streamText() {
        calls += 1;
        if (calls === 1) {
          return {
            fullStream: stream([{ type: "error", error: quotaExhaustedError(FLUSH_AT_MS) }]),
          } as never;
        }
        return { fullStream: stream(HEALTHY_STREAM_CHUNKS) } as never;
      },
    };
    const adapter = new AiSdkModelAdapter({
      registry: registry(),
      retry: { baseDelayMs: 0, jitter: false, maxAttempts: 2, maxDelayMs: 0 },
      runtime,
    });

    const collected: unknown[] = [];
    const result = (async () => {
      for await (const event of executeAdapterStreamText(adapter, {
        providerId: "test" as never,
        modelId: "model-a" as never,
        messages: [{ role: "user", content: "Ping" }],
        statusSink: { publish: (event) => events.push(event) },
      })) {
        collected.push(event);
      }
    })();

    const retryEvents = () => events.filter((event) => event.type === "model_retry_scheduled");
    await spinUntil(() => retryEvents().length === 1, "chunk retry_scheduled published");
    expect(retryEvents()[0]).toMatchObject({
      attempt: 1,
      delayMs: 2 * 3_600_000,
      reason: "usage_limit_reset",
    });
    expect(retryEvents()[0].nextAttemptAtMs).toBe(FLUSH_AT_MS);

    // 段长只有 5min：到点即重发；配额已回补 → 探测成功。
    await vi.advanceTimersByTimeAsync(USAGE_LIMIT_RESET_SEGMENT_MS);
    await result;

    expect(calls).toBe(2);
    expect(collected.some((event) => (event as { type?: string }).type === "text_delta")).toBe(
      true,
    );
    const startedEvents = events.filter((event) => event.type === "model_request_started");
    expect(startedEvents.map((event) => event.attempt)).toEqual([1, 1]);
  });

  it("abort during the error-chunk quota wait still rejects with the terminal cancelled error", async () => {
    const abortController = new AbortController();
    const events: ModelNetworkStatusEvent[] = [];
    const runtime: AiSdkModelRuntime = {
      generateText() {
        throw new Error("not used");
      },
      streamText() {
        return {
          fullStream: stream([{ type: "error", error: quotaExhaustedError(FLUSH_AT_MS) }]),
        } as never;
      },
    };
    const adapter = new AiSdkModelAdapter({
      registry: registry(),
      retry: { baseDelayMs: 0, jitter: false, maxAttempts: 3, maxDelayMs: 0 },
      runtime,
    });

    const result = (async () => {
      for await (const _event of executeAdapterStreamText(adapter, {
        abortSignal: abortController.signal,
        providerId: "test" as never,
        modelId: "model-a" as never,
        messages: [{ role: "user", content: "Ping" }],
        statusSink: { publish: (event) => events.push(event) },
      })) {
        // no-op
      }
    })();

    await spinUntil(
      () => events.some((event) => event.type === "model_retry_scheduled"),
      "chunk quota wait scheduled",
    );
    await vi.advanceTimersByTimeAsync(30_000);
    abortController.abort(new Error("user stopped during chunk quota wait"));

    await expect(result).rejects.toMatchObject({
      context: {
        errorPhase: "connect",
        reason: "cancelled" satisfies ModelFailureReason,
      },
    });
  });
});
