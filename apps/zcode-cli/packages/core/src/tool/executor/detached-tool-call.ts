// ============================================================
// Detached tool call handoff — gate, synthetic result and completion chain
// ============================================================
//
// BT 2.0 (2026-11-17): the call runner races a backgrounding-capable handler against a
// detach gate. This module owns both halves of that handoff so call-runner.ts stays a
// runner instead of growing a second execution lifecycle:
//
// - createToolCallDetachGate registers the active handle and exposes the gate promise;
// - completeDetachedToolCall builds the synthetic result the model sees, moves the still
//   running handler into the executor store's terminal tracking and re-enters the shared
//   background task pipeline (tracker, runtime registry, notification).

import {
  traceContextToLogContext,
  type SkillTelemetryMetadata,
  type ToolExecutionSpanWriter,
  type TraceContext,
  type TurnId,
} from "@zcode/contracts";
import type {
  ExecutableToolCall,
  ToolEntry,
  ToolExecutionResult,
  ToolResultSerialization,
} from "../types.js";
import type { BackgroundTaskTracker } from "./background-tasks.js";
import type { ToolExecutorDeps } from "./types.js";
import {
  DetachedToolTaskStore,
  type DetachedToolTaskTerminal,
} from "./detached-tool-tasks.js";
import { createToolHandlerFailureError, isToolHandlerFailure } from "./errors.js";
import { emitToolCallResult } from "./events.js";
import { resolveModelOutputEntry } from "./model-output-entry.js";
import { createToolResultDisplay } from "./result-display.js";
import { serializeOutput } from "./result-serialization.js";
import { ToolDeadline } from "./timeout.js";
import { withTerminalToolTurnStop } from "./turn-control.js";
import { validateOutput } from "./validation.js";
import { mergeToolExecutionTelemetry } from "../handlers/tool-perf.js";

export interface ToolCallDetachGate {
  /** Resolves with the detached task id when the gate wins the race. */
  promise: Promise<string>;
  /** Marks the handler as settled so a late detach request loses. */
  markHandlerSettled(): void;
  /** Removes the active handle from the executor store. */
  unregister(): void;
}

/**
 * Registers a running call in the executor store and owns the detach guards:
 * only a backgrounding-capable entry, still foreground and not yet settled, may flip.
 * On a flip the foreground deadline is cleared — it must not kill the detached handler;
 * the store's maxRuntimeMs watchdog replaces it.
 */
export function createToolCallDetachGate(input: {
  deadline: ToolDeadline;
  entry: ToolEntry;
  store: DetachedToolTaskStore | undefined;
  toolCall: ExecutableToolCall;
}): ToolCallDetachGate {
  const gate = Promise.withResolvers<string>();
  let state: "foreground" | "detached" = "foreground";
  let settled = false;
  let unregister: (() => void) | undefined;

  if (input.store !== undefined && input.entry.backgrounding?.supported) {
    unregister = input.store.registerActive({
      requestDetach: () => {
        if (state !== "foreground" || settled) return undefined;
        state = "detached";
        input.deadline.clear();
        const taskId = `toolbg_${crypto.randomUUID()}`;
        gate.resolve(taskId);
        return taskId;
      },
      toolCallId: input.toolCall.id,
      toolName: input.toolCall.name,
    });
  }

  return {
    markHandlerSettled: () => {
      settled = true;
    },
    promise: gate.promise,
    unregister: () => unregister?.(),
  };
}

export interface DetachedToolCallHandoffInput {
  backgroundTasks: BackgroundTaskTracker;
  controller: AbortController;
  deps: ToolExecutorDeps;
  entry: ToolEntry;
  formatPreToolHookContexts: () => Promise<string[]>;
  permissionWaitMs: number | undefined;
  pluginId: string | undefined;
  readFileStateMetadata: ToolExecutionResult["readFileStateMetadata"];
  releaseLifetime: () => void;
  skillTelemetryMetadata: SkillTelemetryMetadata | undefined;
  startTime: number;
  taskId: string;
  telemetry: ToolExecutionSpanWriter | undefined;
  toolCall: ExecutableToolCall;
  totalStartedAt: number;
  traceContext: TraceContext;
  trackedHandler: Promise<unknown>;
  turnId: TurnId | undefined;
}

/**
 * Settles the foreground call as a successful handoff and hands the still-running handler
 * to the detached task store. The caller has already won the gate race.
 */
export async function completeDetachedToolCall(
  input: DetachedToolCallHandoffInput,
): Promise<ToolExecutionResult> {
  const { deps, entry, taskId, toolCall, traceContext, turnId } = input;
  const syntheticOutput = {
    status: "backgrounded",
    backgroundTaskId: taskId,
    backgroundedByUser: true,
  };
  const syntheticText = buildDetachedToolModelContent(toolCall.name, taskId);
  const syntheticSerialization: ToolResultSerialization = {
    content: syntheticText,
    modelContent: syntheticText,
    originalBytes: Buffer.byteLength(syntheticText, "utf8"),
    returnedBytes: Buffer.byteLength(syntheticText, "utf8"),
    truncated: false,
    budgetStrategy: entry.resultBudget?.strategy ?? "truncate",
  };
  const durationMs = Date.now() - input.startTime;
  const performance = mergeToolExecutionTelemetry(undefined, {
    permissionWaitMs: input.permissionWaitMs,
    totalMs: Date.now() - input.totalStartedAt,
  });

  // Attach the completion chain before anything below can throw: the handler is already
  // running and must always reach a terminal state (and release its lifetime). The
  // rejection case is handled here, so the detached promise never goes unhandled.
  const terminal = (async (): Promise<DetachedToolTaskTerminal> => {
    try {
      const output = await input.trackedHandler;
      if (isToolHandlerFailure(output)) {
        throw createToolHandlerFailureError(toolCall, output);
      }
      validateOutput(output, entry);
      const serialization = await serializeOutput(
        deps,
        output,
        resolveModelOutputEntry(entry, output),
        traceContext,
        toolCall.id,
        input.controller.signal,
      );
      const notice = entry.formatBatchNotice?.(output);
      return {
        status: "completed",
        resultText:
          notice === undefined
            ? serialization.content
            : `${serialization.content}\n\n${notice.content}`,
        resultTruncated: serialization.truncated,
        ...(serialization.artifactPath === undefined
          ? {}
          : { outputFile: serialization.artifactPath }),
      };
    } catch (error) {
      return {
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      input.releaseLifetime();
    }
  })();
  deps.detachedToolTasks?.track({
    taskId,
    toolCall,
    terminal,
    controller: input.controller,
    maxRuntimeMs: entry.backgrounding?.maxRuntimeMs,
    maxResultChars: entry.backgrounding?.maxResultChars,
  });

  const hookContexts = await input.formatPreToolHookContexts();
  const syntheticResult: ToolExecutionResult = withTerminalToolTurnStop(
    withHookAdditionalContexts(
      {
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        success: true,
        output: syntheticOutput,
        display: createToolResultDisplay(toolCall.name, syntheticOutput, {
          mcp: entry.metadata.mcpPresentation,
        }),
        modelContent: syntheticText,
        ...(input.readFileStateMetadata === undefined
          ? {}
          : { readFileStateMetadata: input.readFileStateMetadata }),
        performance,
        serialization: syntheticSerialization,
        durationMs,
        startedAt: new Date(input.startTime),
        completedAt: new Date(),
      },
      hookContexts,
    ),
    { entry },
  );

  // Report the handoff as an ordinary successful result, then hand tracking to the shared
  // background pipeline (runtime task registry, started event, terminal waiter).
  await emitToolCallResult(
    deps,
    toolCall,
    traceContext,
    turnId,
    syntheticSerialization,
    durationMs,
    syntheticResult.display,
    performance,
    input.skillTelemetryMetadata,
    input.pluginId,
  );
  await input.backgroundTasks.trackBackgroundTask(
    toolCall,
    syntheticOutput,
    traceContext,
    turnId,
  );
  deps.logger?.info?.("Tool call backgrounded by user", {
    ...traceContextToLogContext(traceContext),
    event: "tool.call.backgrounded",
    module: "core.tool.executor",
    status: "completed",
    taskId,
    toolCallId: toolCall.id,
    toolName: toolCall.name,
  });
  input.telemetry?.setOutputBytes(syntheticSerialization.returnedBytes);
  input.telemetry?.setOutputTruncated(false);
  input.telemetry?.finishCompleted();
  return syntheticResult;
}

/**
 * Model-visible text for a user-detached tool call. Deliberately tool-agnostic: the
 * contract is "it is still running, do not poll, you will be notified", and the completion
 * arrives through the shared background task notification pipeline.
 */
function buildDetachedToolModelContent(toolName: string, taskId: string): string {
  return `Tool call was manually backgrounded by user with ID: ${taskId}. User moved this ${toolName} call to the background. It is still running. Do not wait, sleep, or poll for it. Continue with other useful work, or finish your response \u2014 you will be notified with its result when it completes.`;
}

function withHookAdditionalContexts(
  result: ToolExecutionResult,
  hookAdditionalContexts: readonly string[],
): ToolExecutionResult {
  if (hookAdditionalContexts.length === 0) return result;
  return { ...result, hookAdditionalContexts: [...hookAdditionalContexts] };
}
