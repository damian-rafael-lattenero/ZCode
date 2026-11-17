// ============================================================
// Detached tool tasks — the executor-owned registry for user-backgrounded tool calls
// ============================================================
//
// BT (2026-11-17): generic read-only tool backgrounding. A running call of a tool whose
// ToolEntry declares the `backgrounding` capability can be moved to the background by the
// user. The foreground tool call resolves at once with a synthetic result, while the
// original handler keeps running in this store.
//
// Why this lives in the executor: the executor owns the handler promise, its AbortController
// and its timeout deadline. Nothing outside can safely hand those over; the store's handles
// are the only way to flip a running call without racing the handler's own settlement.
//
// The store is deliberately small and synchronous on the mutation side: `requestBackground`,
// `track` and `stop` never await. Only `waitForTerminal` returns a promise, and it resolves
// exactly once, when the task records a terminal state.

import { CoreErrorType, createCoreError } from "@zcode/contracts";
import type { ToolRegistry } from "../registry.js";
import type { ExecutableToolCall } from "../types.js";

export type ToolBackgroundRequestResult =
  | { kind: "backgrounded"; workId: string }
  | { kind: "noop" }
  | { kind: "unsupported" };

/**
 * A call currently executing in this executor. `requestDetach` is the only mutation a
 * foreign caller may trigger; it returns the task id when the call flipped to detached and
 * `undefined` for every guard miss (not backgroundable, already settled, already detached).
 */
export interface ActiveToolCallHandle {
  toolCallId: string;
  toolName: string;
  requestDetach(): string | undefined;
}

export type DetachedToolTaskStatus =
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "timed_out"
  | "lost";

/**
 * The terminal snapshot handed to the background task tracker, TaskOutput projection and
 * the notification formatter. Shaped like the other background snapshots on purpose: the
 * tracker only reads `status`, `startedAt`, `completedAt`, `error`, `description` and
 * `outputFile`, and it must be able to consume this one without a special case.
 */
export interface DetachedToolTaskSnapshot {
  taskId: string;
  toolCallId: string;
  toolName: string;
  description: string;
  status: DetachedToolTaskStatus;
  startedAt: Date;
  completedAt?: Date;
  /** Bounded by the capability's maxResultChars. */
  resultText?: string;
  error?: string;
  outputFile?: string;
  resultTruncated?: boolean;
}

/** What the executor's completion chain reports back to the store. */
export interface DetachedToolTaskTerminal {
  status: "completed" | "failed";
  resultText?: string;
  error?: string;
  outputFile?: string;
  resultTruncated?: boolean;
}

export interface DetachedToolTaskTrackInput {
  taskId: string;
  toolCall: ExecutableToolCall;
  /** Resolves when the detached handler settles; rejection is recorded as failed. */
  terminal: Promise<DetachedToolTaskTerminal>;
  /** The handler's own AbortController. `stop` and the watchdog abort through it. */
  controller: AbortController;
  /** Watchdog bound. Absent = no watchdog (the capability did not declare one). */
  maxRuntimeMs?: number;
  /** Bound applied to `resultText` when the terminal settles. */
  maxResultChars?: number;
}

interface DetachedToolTaskTerminalResolvers {
  promise: Promise<DetachedToolTaskSnapshot>;
  resolve(value: DetachedToolTaskSnapshot): void;
}

interface DetachedToolTaskRecord {
  controller: AbortController;
  maxResultChars: number | undefined;
  settled: boolean;
  snapshot: DetachedToolTaskSnapshot;
  terminal: DetachedToolTaskTerminalResolvers;
  timer: ReturnType<typeof setTimeout> | undefined;
}

export class DetachedToolTaskStore {
  private readonly active = new Map<string, ActiveToolCallHandle>();
  private readonly tasks = new Map<string, DetachedToolTaskRecord>();

  /**
   * Registers an in-flight call. The disposer is idempotent and only removes the same
   * handle, so a late disposer can never evict a newer call that reused the toolCallId.
   */
  registerActive(handle: ActiveToolCallHandle): () => void {
    this.active.set(handle.toolCallId, handle);
    return () => {
      if (this.active.get(handle.toolCallId) === handle) {
        this.active.delete(handle.toolCallId);
      }
    };
  }

  /**
   * Flips a running registered call to detached. The handle owns the guards (capability,
   * running state, not settled); every miss is a noop, never an abort.
   */
  requestBackground(toolCallId: string): ToolBackgroundRequestResult {
    const handle = this.active.get(toolCallId);
    if (!handle) return { kind: "noop" };
    const taskId = handle.requestDetach();
    return taskId === undefined ? { kind: "noop" } : { kind: "backgrounded", workId: taskId };
  }

  /**
   * Starts tracking a detached task. Must be called before the tracker can ask for a
   * terminal snapshot (the tracker's direct waiter resolves only once a record exists).
   */
  track(input: DetachedToolTaskTrackInput): void {
    if (this.tasks.has(input.taskId)) return;
    const record: DetachedToolTaskRecord = {
      controller: input.controller,
      maxResultChars: input.maxResultChars,
      settled: false,
      snapshot: {
        taskId: input.taskId,
        toolCallId: input.toolCall.id,
        toolName: input.toolCall.name,
        description: detachedToolDescription(input.toolCall),
        status: "running",
        startedAt: new Date(),
      },
      terminal: Promise.withResolvers<DetachedToolTaskSnapshot>(),
      timer: undefined,
    };
    this.tasks.set(input.taskId, record);

    if (input.maxRuntimeMs !== undefined && input.maxRuntimeMs > 0) {
      const timer = setTimeout(() => {
        record.timer = undefined;
        const error = createCoreError(
          CoreErrorType.ToolTimeout,
          `${input.toolCall.name} background call exceeded its ${input.maxRuntimeMs}ms runtime limit`,
          { recoverable: true },
        );
        // Abort first so a cooperating handler stops, then settle regardless: the
        // watchdog exists precisely for handlers that ignore their abort signal.
        if (!record.controller.signal.aborted) record.controller.abort(error);
        this.settle(record, { error: error.message, status: "timed_out" });
      }, input.maxRuntimeMs);
      timer.unref?.();
      record.timer = timer;
    }

    void input.terminal.then(
      (terminal) => this.settle(record, terminal),
      (error: unknown) =>
        this.settle(record, {
          error: error instanceof Error ? error.message : String(error),
          status: "failed",
        }),
    );
  }

  getSnapshot(taskId: string): DetachedToolTaskSnapshot | undefined {
    const record = this.tasks.get(taskId);
    return record === undefined ? undefined : { ...record.snapshot };
  }

  /** Resolves once with the terminal snapshot; never rejects. */
  waitForTerminal(taskId: string): Promise<DetachedToolTaskSnapshot | undefined> {
    const record = this.tasks.get(taskId);
    if (record === undefined) return Promise.resolve(undefined);
    if (record.settled) return Promise.resolve({ ...record.snapshot });
    return record.terminal.promise;
  }

  /**
   * Aborts the handler and records the user stop. Terminal tasks are returned untouched,
   * so a late stop never rewrites a completion.
   */
  stop(taskId: string): DetachedToolTaskSnapshot | undefined {
    const record = this.tasks.get(taskId);
    if (record === undefined) return undefined;
    if (!record.settled) {
      if (!record.controller.signal.aborted) {
        record.controller.abort(
          createCoreError(CoreErrorType.ToolCancelled, "Tool background call stopped", {
            recoverable: true,
          }),
        );
      }
      this.settle(record, { status: "cancelled" });
    }
    return { ...record.snapshot };
  }

  private settle(
    record: DetachedToolTaskRecord,
    outcome:
      | DetachedToolTaskTerminal
      | { status: "cancelled" | "timed_out"; error?: string },
  ): void {
    if (record.settled) return;
    record.settled = true;
    if (record.timer !== undefined) {
      clearTimeout(record.timer);
      record.timer = undefined;
    }
    const bounded = boundResultText(
      "resultText" in outcome ? outcome.resultText : undefined,
      record.maxResultChars,
    );
    const snapshot: DetachedToolTaskSnapshot = {
      ...record.snapshot,
      completedAt: new Date(),
      status: outcome.status,
      ...(bounded === undefined
        ? {}
        : { resultText: bounded.text, resultTruncated: bounded.truncated }),
      ...(outcome.error === undefined ? {} : { error: outcome.error }),
      ...("outputFile" in outcome && outcome.outputFile !== undefined
        ? { outputFile: outcome.outputFile }
        : {}),
    };
    // A terminal outcome can also carry its own truncation flag (the executor's
    // serializer may have truncated the content already); keep the true either way.
    if ("resultTruncated" in outcome && outcome.resultTruncated === true && bounded !== undefined) {
      snapshot.resultTruncated = true;
    }
    record.snapshot = snapshot;
    record.terminal.resolve(snapshot);
  }
}

export function supportsToolBackgrounding(
  registry: ToolRegistry | undefined,
  toolName: string,
): boolean {
  return registry?.get(toolName)?.backgrounding?.supported === true;
}

function boundResultText(
  resultText: string | undefined,
  maxResultChars: number | undefined,
): { text: string; truncated: boolean } | undefined {
  if (resultText === undefined) return undefined;
  if (maxResultChars === undefined || maxResultChars <= 0 || resultText.length <= maxResultChars) {
    return { text: resultText, truncated: false };
  }
  return {
    text: `${resultText.slice(0, maxResultChars)}\n[truncated]`,
    truncated: true,
  };
}

function detachedToolDescription(toolCall: ExecutableToolCall): string {
  const input =
    typeof toolCall.input === "object" && toolCall.input !== null
      ? (toolCall.input as Record<string, unknown>)
      : undefined;
  for (const key of ["description", "command", "query", "pattern", "url", "prompt"] as const) {
    const value = input?.[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return toolCall.name;
}
