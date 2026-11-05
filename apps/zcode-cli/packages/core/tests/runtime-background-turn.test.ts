// DT 分组（2026-11-04，docs/conversation-session-case-catalog.md）：运行中的 primaryTurn
// 由用户主动 demote 为 backgroundTurn。这里测 runtime 原语（background-turn.ts）+
// runtime-command-queue 的移交 race：demote 永不中断执行、身份守卫与 stop 同源、
// detached turn 以 taskKind "turn" 进入 runtime task registry、queue drain hold。
// 真实 runtime 侧沿用 prompt-admission.test.ts 的 harness（gated test model，无 sleep）；
// drain-hold 侧沿用 runtime-command-queue.test.ts 的局部 runtime 桩。
import { describe, expect, it, vi } from "vitest";
import { createSessionId, SessionEventType } from "@zcode/contracts";
import { AgentRuntime } from "../src/runtime.js";
import { createRuntimeCommandQueue } from "../src/runtime/command-queue.js";
import type { RuntimeCommand, RuntimeCommandId } from "../src/runtime/command-queue.js";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";
import {
  acquireForegroundPromotionLease,
  drainRuntimeCommandQueue,
} from "../src/runtime/methods/runtime-command-queue.js";
import { InMemoryRuntimeTaskRegistry } from "../src/runtime-task/registry.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { createTestModelFactory } from "./test-runtime-model.js";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

async function flushMicrotasks(times = 5): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

interface GatedModelHarness {
  modelCalls: () => number;
  releaseModel: () => void;
  runtime: AgentRuntime;
}

/**
 * 第一轮模型请求挂起（模拟流式/工具执行中）；demote 后的 wake 通知轮立即完成。
 * gate 只有第一次生效：settle 后的 backgroundResult wake 不能把测试挂死。
 */
function createGatedRuntime(sessionKey: string): GatedModelHarness {
  let modelCalls = 0;
  let releaseFirst!: () => void;
  const modelGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const runtime = new AgentRuntime(
    createSessionId(sessionKey),
    {
      mode: "build",
      modelSelection: { providerId: "test-provider", modelId: "test-model" },
    },
    {
      eventStore: createTestSessionEventStore(),
      modelFactory: createTestModelFactory({
        generateText: (async () => {
          modelCalls += 1;
          if (modelCalls === 1) await modelGate;
          return {
            finishReason: "stop",
            text: `done ${modelCalls}`,
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          };
        }) as never,
      }),
    },
  );
  return {
    modelCalls: () => modelCalls,
    releaseModel: releaseFirst,
    runtime,
  };
}

function admissionOptions(inputId: string) {
  return {
    inputId,
    queryId: inputId,
    traceContext: {
      queryId: inputId,
      sessionId: createSessionId("runtime-background-turn-test"),
      traceId: `trace-${inputId}`,
    },
  } as never;
}

/** 等到 prompt 命令真实起跑：foreground execution 与 activeTurn 都已就位（detach 已武装）。 */
async function waitUntilTurnActive(runtime: AgentRuntime): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (
      runtime.getActiveForegroundExecutionId() !== undefined &&
      runtime.getActiveTurnInfo() !== undefined
    ) {
      return;
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("turn never became active");
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(message);
}

function internalOf(runtime: AgentRuntime): AgentRuntimeInternal {
  return runtime as unknown as AgentRuntimeInternal;
}

/** 等 wake（backgroundResult 通知轮）也收口，测试结束时不留悬挂 turn。 */
async function waitUntilIdleAfterWake(harness: GatedModelHarness): Promise<void> {
  await waitFor(
    () =>
      harness.modelCalls() >= 2 &&
      harness.runtime.getActiveTurnInfo() === undefined &&
      harness.runtime.getActiveForegroundExecutionId() === undefined,
    "wake turn never settled",
  );
  await flushMicrotasks();
}

describe("backgroundTurn demotion（DT01 原语语义）", () => {
  it("demote 保留执行：前台命令提前 resolve，turn 在后台继续（model gate 仍挂起）", async () => {
    const harness = createGatedRuntime("background-turn-demote-preserves");
    const { runtime } = harness;
    const first = await runtime.admitPrompt(
      "long running task",
      undefined,
      admissionOptions("dt01"),
    );
    if (first.kind !== "started") throw new Error("first prompt was not admitted");
    await waitUntilTurnActive(runtime);
    const foregroundExecutionId = runtime.getActiveForegroundExecutionId();
    if (!foregroundExecutionId) throw new Error("foreground execution id missing");

    const demote = runtime.backgroundActiveForegroundExecution({
      expectedForegroundExecutionId: foregroundExecutionId,
    });

    expect(demote).toEqual({
      foregroundExecutionId,
      kind: "demoted",
      workId: `turn_${foregroundExecutionId}`,
    });
    // 前台命令提前 resolve：completion 在 model gate 释放之前就已收口。
    let completionSettled = false;
    const completion = first.completion.then((result) => {
      completionSettled = true;
      return result;
    });
    await flushMicrotasks();
    expect(completionSettled).toBe(true);
    const result = await completion;
    expect(result.response).toBe("");
    expect(result.turnId).toBe(first.turnId);
    expect(result.projection).toBeDefined();

    // turn 不中断：activeTurn 仍在、detached turn 在 registry 里继续跑。
    expect(runtime.getActiveTurnInfo()?.turnId).toBe(first.turnId);
    expect(runtime.hasUnsettledBackgroundTurn()).toBe(true);
    expect(runtime.hasRunningBackgroundTasks()).toBe(true);
    // foreground authority 已随提前 resolve 释放（主停止按钮对 detached turn 无目标）。
    expect(runtime.getActiveForegroundExecutionId()).toBeUndefined();

    // 结算：释放 gate → turn 完成 → registry 终态 completed（wake 轮随即启动并完成）。
    harness.releaseModel();
    const internal = internalOf(runtime);
    await waitFor(
      () =>
        internal.runtimeTaskRegistry.get(`turn_${foregroundExecutionId}`)?.status === "completed",
      "detached turn never completed",
    );
    await waitUntilIdleAfterWake(harness);
    expect(runtime.hasUnsettledBackgroundTurn()).toBe(false);
  });

  it("身份守卫：expectedForegroundExecutionId 不符 → mismatch noop，绝不 abort 在跑执行", async () => {
    const harness = createGatedRuntime("background-turn-guard-mismatch");
    const { runtime } = harness;
    const first = await runtime.admitPrompt(
      "guarded task",
      undefined,
      admissionOptions("dt-guard"),
    );
    if (first.kind !== "started") throw new Error("first prompt was not admitted");
    await waitUntilTurnActive(runtime);
    const activeId = runtime.getActiveForegroundExecutionId();
    if (!activeId) throw new Error("foreground execution id missing");

    let completionSettled = false;
    void first.completion.then(() => {
      completionSettled = true;
    });

    const mismatch = runtime.backgroundActiveForegroundExecution({
      expectedForegroundExecutionId: "stale_execution_id",
    });

    expect(mismatch).toEqual({ kind: "mismatch", activeForegroundExecutionId: activeId });
    await flushMicrotasks();
    // 没有任何东西被 abort / 提前 resolve：turn 仍在前台执行。
    expect(completionSettled).toBe(false);
    expect(runtime.hasUnsettledBackgroundTurn()).toBe(false);
    expect(runtime.getActiveTurnInfo()?.turnId).toBe(first.turnId);
    expect(runtime.getActiveForegroundExecutionId()).toBe(activeId);

    // 守卫放行正确 id 时 demote 仍可用（mismatch 没有消耗任何状态）。
    const demote = runtime.backgroundActiveForegroundExecution({
      expectedForegroundExecutionId: activeId,
    });
    expect(demote).toMatchObject({ kind: "demoted", foregroundExecutionId: activeId });
    await first.completion;
    harness.releaseModel();
    await waitFor(() => !runtime.hasUnsettledBackgroundTurn(), "detached turn never settled");
    await waitUntilIdleAfterWake(harness);
  });

  it("无前台执行时 demote 为 idle noop", () => {
    const { runtime } = createGatedRuntime("background-turn-idle");
    expect(runtime.backgroundActiveForegroundExecution({})).toEqual({ kind: "idle" });
    expect(
      runtime.backgroundActiveForegroundExecution({ expectedForegroundExecutionId: "exec-1" }),
    ).toEqual({ kind: "idle" });
  });

  it("demoted turn 以 runtime background task kind turn 登记（registry + hasRunningBackgroundTasks）", async () => {
    const harness = createGatedRuntime("background-turn-registry");
    const { runtime } = harness;
    const first = await runtime.admitPrompt(
      "registry task",
      undefined,
      admissionOptions("dt-registry"),
    );
    if (first.kind !== "started") throw new Error("first prompt was not admitted");
    await waitUntilTurnActive(runtime);
    const foregroundExecutionId = runtime.getActiveForegroundExecutionId();
    const demote = runtime.backgroundActiveForegroundExecution({
      expectedForegroundExecutionId: foregroundExecutionId,
    });
    if (demote?.kind !== "demoted") throw new Error(`demote failed: ${JSON.stringify(demote)}`);

    const internal = internalOf(runtime);
    const task = internal.runtimeTaskRegistry.get(demote.workId);
    expect(task).toMatchObject({
      description: "registry task",
      isBackgrounded: true,
      prompt: "registry task",
      status: "running",
      taskId: demote.workId,
      taskType: "local_turn",
      turnId: first.turnId,
      type: "local_turn",
    });
    // demote 后 registry 里不存在仍标记前台（isBackgrounded=false）的 local_turn 残留。
    expect(
      Object.values(internal.runtimeTaskRegistry.all()).filter(
        (entry) => entry.type === "local_turn" && entry.isBackgrounded !== true,
      ),
    ).toEqual([]);
    expect(runtime.hasRunningBackgroundTasks()).toBe(true);

    harness.releaseModel();
    await waitFor(() => !runtime.hasUnsettledBackgroundTurn(), "detached turn never settled");
    await waitUntilIdleAfterWake(harness);
    expect(internal.runtimeTaskRegistry.get(demote.workId)).toMatchObject({
      status: "completed",
    });
  });

  it("demote 事件形状：BackgroundTurnDemoted + BackgroundTaskStarted(taskKind=turn, cancellable)", async () => {
    const eventStore = createTestSessionEventStore();
    let modelCalls = 0;
    let releaseFirst!: () => void;
    const modelGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const runtime = new AgentRuntime(
      createSessionId("background-turn-events"),
      { mode: "build", modelSelection: { providerId: "test-provider", modelId: "test-model" } },
      {
        eventStore,
        modelFactory: createTestModelFactory({
          generateText: (async () => {
            modelCalls += 1;
            if (modelCalls === 1) await modelGate;
            return {
              finishReason: "stop",
              text: "done",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            };
          }) as never,
        }),
      },
    );
    const first = await runtime.admitPrompt(
      "event shape probe with   extra spaces",
      undefined,
      admissionOptions("dt-events"),
    );
    if (first.kind !== "started") throw new Error("first prompt was not admitted");
    await waitUntilTurnActive(runtime);
    const foregroundExecutionId = runtime.getActiveForegroundExecutionId();
    const demote = runtime.backgroundActiveForegroundExecution({
      expectedForegroundExecutionId: foregroundExecutionId,
    });
    if (demote?.kind !== "demoted") throw new Error("demote failed");

    // beginDetachedTurnTracking 的事件是 await 链；轮询等它们落库。
    for (let attempt = 0; attempt < 500; attempt += 1) {
      const events = await eventStore.getEvents(runtime.sessionId);
      if (
        events.some((event) => event.type === SessionEventType.BackgroundTurnDemoted) &&
        events.some(
          (event) =>
            event.type === SessionEventType.BackgroundTaskStarted &&
            (event.payload as { taskId?: string }).taskId === demote.workId,
        )
      ) {
        break;
      }
      await new Promise((resolve) => setImmediate(resolve));
    }

    const events = await eventStore.getEvents(runtime.sessionId);
    const demoted = events.find((event) => event.type === SessionEventType.BackgroundTurnDemoted);
    expect(demoted?.payload).toEqual({
      foregroundExecutionId,
      inputId: "dt-events",
      taskId: demote.workId,
      title: "event shape probe with extra spaces",
      turnId: first.turnId,
    });
    const started = events.find(
      (event) =>
        event.type === SessionEventType.BackgroundTaskStarted &&
        (event.payload as { taskId?: string }).taskId === demote.workId,
    );
    expect(started?.payload).toMatchObject({
      cancellable: true,
      description: "event shape probe with extra spaces",
      status: "running",
      taskKind: "turn",
      taskId: demote.workId,
      toolName: "Turn",
    });

    releaseFirst();
    await waitFor(() => !runtime.hasUnsettledBackgroundTurn(), "detached turn never settled");
    await waitFor(
      () => modelCalls >= 2 && runtime.getActiveTurnInfo() === undefined,
      "wake turn never settled",
    );
    const completed = (await eventStore.getEvents(runtime.sessionId)).find(
      (event) =>
        event.type === SessionEventType.BackgroundTaskCompleted &&
        (event.payload as { taskId?: string }).taskId === demote.workId,
    );
    expect(completed?.payload).toMatchObject({
      status: "completed",
      taskKind: "turn",
      taskId: demote.workId,
      toolName: "Turn",
    });
  });
});

// ── DT02：queue drain hold（runtime command queue 的 FIFO 门）+ sendQueuedNow 提升屏障 ──

function promptCommand(id: string, input: string): RuntimeCommand {
  return {
    createdAt: new Date(0),
    id: id as RuntimeCommandId,
    input,
    mode: "prompt",
    priority: "next",
    reject: () => {},
    resolve: () => {},
    traceContext: {
      sessionId: "sess_background_turn_drain",
      spanId: `span_${id}`,
      traceId: "trace_background_turn_drain",
    },
  } as RuntimeCommand;
}

describe("backgroundTurn queue drain hold（DT02）", () => {
  it("未收口的 detached turn 阻塞出队；结算后按 FIFO 恢复；idle-only 提升租约被拒", async () => {
    const registry = new InMemoryRuntimeTaskRegistry();
    registry.register({
      agentId: "turn_exec_1",
      agentType: "local_turn",
      description: "detached head",
      isBackgrounded: true,
      startedAt: new Date(0),
      status: "running",
      taskId: "turn_exec_1",
      taskType: "local_turn",
      turnId: "turn_detached_1",
      type: "local_turn",
    } as never);
    const executed: string[] = [];
    const runtime = {
      activeForegroundExecution: undefined,
      activeTurn: undefined,
      activeTurnStartReservation: undefined,
      executeTurnCommand: vi.fn().mockImplementation(async (input: string) => {
        executed.push(input);
        return {
          response: input,
          events: [],
          projection: undefined,
          traceId: "t",
          turnId: "turn",
        };
      }),
      foregroundPromotionLease: undefined,
      runtimeCommandDrainActive: false,
      runtimeCommandQueue: createRuntimeCommandQueue(),
      runtimeTaskRegistry: registry,
    } as unknown as AgentRuntimeInternal;

    runtime.runtimeCommandQueue.enqueue(promptCommand("queued-b", "queued work b"));

    // sendQueuedNow 的 promote barrier：idle-only 租约在 hold 期间必须 busy。
    expect(
      acquireForegroundPromotionLease.call(runtime, {
        leaseId: "queue-promotion:cmd-dt02",
        mode: "idle-only",
        promotedInputId: "queued-b",
      }),
    ).toEqual({ kind: "busy" });

    // auto-drain 已武装（drain 被显式触发），但队首不启动。
    await drainRuntimeCommandQueue.call(runtime);
    expect(executed).toEqual([]);
    expect(runtime.runtimeCommandQueue.size()).toBe(1);
    expect(runtime.foregroundPromotionLease).toBeUndefined();

    // 结算（settleDetachedTurn 的 registry 终态 + 显式 re-drain）释放 FIFO。
    registry.update("turn_exec_1", (current) => ({ ...current, status: "completed" }));
    await drainRuntimeCommandQueue.call(runtime);
    expect(executed).toEqual(["queued work b"]);
    expect(runtime.runtimeCommandQueue.size()).toBe(0);
    expect(runtime.activeForegroundExecution).toBeUndefined();

    // hold 释放后 idle-only 租约可获取（队列为空、无前台执行）。
    expect(
      acquireForegroundPromotionLease.call(runtime, {
        leaseId: "queue-promotion:cmd-dt02",
        mode: "idle-only",
        promotedInputId: "queued-b",
      }),
    ).toEqual({ kind: "acquired", leaseId: "queue-promotion:cmd-dt02" });
  });

  it("armed（尚未 demote）的前台 turn 不阻塞 drain：isBackgrounded=false 不算后台事实", async () => {
    const registry = new InMemoryRuntimeTaskRegistry();
    registry.register({
      agentId: "turn_exec_armed",
      agentType: "local_turn",
      description: "armed foreground turn",
      isBackgrounded: false,
      startedAt: new Date(0),
      status: "running",
      taskId: "turn_exec_armed",
      taskType: "local_turn",
      turnId: "turn_armed_1",
      type: "local_turn",
    } as never);
    const executed: string[] = [];
    const runtime = {
      activeForegroundExecution: undefined,
      activeTurn: undefined,
      activeTurnStartReservation: undefined,
      executeTurnCommand: vi.fn().mockImplementation(async (input: string) => {
        executed.push(input);
        return {
          response: input,
          events: [],
          projection: undefined,
          traceId: "t",
          turnId: "turn",
        };
      }),
      foregroundPromotionLease: undefined,
      runtimeCommandDrainActive: false,
      runtimeCommandQueue: createRuntimeCommandQueue(),
      runtimeTaskRegistry: registry,
    } as unknown as AgentRuntimeInternal;

    runtime.runtimeCommandQueue.enqueue(promptCommand("queued-c", "queued work c"));
    await drainRuntimeCommandQueue.call(runtime);

    expect(executed).toEqual(["queued work c"]);
    expect(runtime.runtimeCommandQueue.size()).toBe(0);
  });
});
