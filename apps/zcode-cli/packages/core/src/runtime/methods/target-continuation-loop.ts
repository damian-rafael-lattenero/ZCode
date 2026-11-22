import {
  telemetryInputOrigin,
  TELEMETRY_INPUT_ORIGIN_ATTRIBUTE,
} from "./input-intent-persistence.js";
import { traceContextToLogContext } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { ContinueActiveTargetLoopOptions, TurnResult } from "../types.js";
import { createRuntimeCommandId } from "../command-queue.js";
import type { TargetContinuationLoopRuntimeCommand } from "../command-queue.js";
import { executeTargetContinuationCommand } from "./target.js";
import { enqueueCancellableRuntimeCommand } from "./runtime-command-submit.js";

interface RunActiveTargetContinuationLoopOptions extends ContinueActiveTargetLoopOptions {
  yieldBeforeFirstContinue?: boolean;
}

/** The auto-continuation loop's default convergence budget — rounds. */
const DEFAULT_TARGET_CONTINUATION_MAX_ROUNDS = 240;

/** The auto-continuation loop's default convergence budget — wall-clock. */
const DEFAULT_TARGET_CONTINUATION_MAX_MS = 8 * 60 * 60 * 1000;

/** A positive finite budget number, or the default when absent/invalid. */
function budgetOr(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

export async function continueActiveTargetLoop(
  this: AgentRuntimeInternal,
  options: ContinueActiveTargetLoopOptions,
): Promise<TurnResult | null> {
  const traceContext = options.traceContext ?? this.rootTraceContext;

  return await enqueueCancellableRuntimeCommand<
    TurnResult | null,
    TargetContinuationLoopRuntimeCommand
  >(this, {
    abortSignal: options.abortSignal,
    createCommand: ({ reject, resolve }) => ({
      createdAt: new Date(),
      id: createRuntimeCommandId(),
      mode: "target-continuation-loop",
      options: {
        ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
        ...(options.inputId !== undefined ? { inputId: options.inputId } : {}),
        ...(options.intent ? { intent: options.intent } : {}),
        traceContext,
        trigger: options.trigger,
        ...(options.verifyBeforeFirstContinue !== undefined
          ? { verifyBeforeFirstContinue: options.verifyBeforeFirstContinue }
          : {}),
      },
      priority: "next",
      reject,
      resolve,
      traceContext,
    }),
  });
}

export async function runActiveTargetContinuationLoop(
  this: AgentRuntimeInternal,
  options: RunActiveTargetContinuationLoopOptions,
): Promise<TurnResult | null> {
  const originalTrace = options.traceContext ?? this.rootTraceContext;
  const inputOrigin = telemetryInputOrigin(options.intent, originalTrace.attributes);
  // continuationIntent 只在第一轮保留，来源则必须沿整个自动续跑的因果链传递。
  const traceContext = inputOrigin
    ? {
        ...originalTrace,
        attributes: {
          ...originalTrace.attributes,
          [TELEMETRY_INPUT_ORIGIN_ATTRIBUTE]: inputOrigin,
        },
      }
    : originalTrace;
  let verifyBeforeContinue = options.verifyBeforeFirstContinue === true;
  let lastResult: TurnResult | null = null;
  let yieldToPendingCommands = options.yieldBeforeFirstContinue !== false;
  let continuationIntent = options.intent;
  // THE CONVERGENCE BUDGET (22/11, measured live: a zombie session ran one
  // verification round every ~47s for 1.5 DAYS — the verifier kept answering
  // "not passed, next: ..." and nothing bounded the loop). Rounds and
  // wall-clock are counted PER LOOP RUN: a fresh user submission starts a
  // new loop with a full budget. Exhaustion stops the loop and leaves the
  // target active — the honest, observable stop, resumable by the next
  // user input; never a silent one.
  const budget = this.config.targetContinuationBudget;
  const maxRounds = budgetOr(budget?.maxRounds, DEFAULT_TARGET_CONTINUATION_MAX_ROUNDS);
  const maxMs = budgetOr(budget?.maxMs, DEFAULT_TARGET_CONTINUATION_MAX_MS);
  const startedAtMs = Date.now();
  let rounds = 0;

  while (!options.abortSignal?.aborted) {
    if (yieldToPendingCommands && this.runtimeCommandQueue.hasPending()) {
      return lastResult;
    }

    if (
      options.trigger === "task-notification" &&
      verifyBeforeContinue &&
      this.config.targetCompletionVerification?.enabled === false
    ) {
      return lastResult;
    }

    const result = await executeTargetContinuationCommand.call(this, {
      ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
      ...(options.inputId !== undefined ? { inputId: options.inputId } : {}),
      ...(continuationIntent ? { intent: continuationIntent } : {}),
      traceContext,
      verifyBeforeContinue,
    });
    if (!result) return lastResult;

    lastResult = result;
    rounds += 1;
    const elapsedMs = Date.now() - startedAtMs;
    if (rounds >= maxRounds || elapsedMs >= maxMs) {
      this.logger?.warn(
        "Target continuation budget exhausted — the auto loop stops here; the target stays active until the next user input",
        {
          ...traceContextToLogContext(traceContext),
          elapsedMs,
          event: "target.continuation.budget_exhausted",
          maxMs,
          maxRounds,
          module: "core.runtime",
          rounds,
        },
      );
      return lastResult;
    }
    // 第一次 continuation 应用并持久化本次 Submission；后续自动轮次读取新的
    // Session Selection，从而沿用上一轮，也允许中间插入的用户 Turn 成为新权威。
    continuationIntent = undefined;
    verifyBeforeContinue = true;
    yieldToPendingCommands = true;
  }

  return lastResult;
}
