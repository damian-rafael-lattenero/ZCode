// [fork] U6 — the judge: one measured look at a turn's direction. The fork's
// own event flow decides when it wakes — the repeated-tool-call streak twice
// past the static anomaly guard, or the owner having stopped the previous
// attempt after real work (recorded here, judged at the START of the next
// turn, so a dead attempt never spawns a call from teardown). One model call
// reads the goal (the confirmed Brief when the Brief gate has one, the raw
// request otherwise) plus a compact window of the turn. minor_drift speaks a
// note to the agent; drift — or the same session's repeated minor drift —
// asks the owner one question on the card surface. A judge that fails, times
// out or speaks nonsense is aligned: the turn never waits on a broken judge,
// and every outcome is logged to be counted.
import {
  VERDICT_QUERY_SOURCE,
  MAX_VERDICT_WINDOW_ENTRIES,
  formatVerdictNote,
  formatVerdictPrompt,
  formatVerdictQuestion,
  parseVerdictText,
  readVerdictAnswer,
  type TurnVerdict,
  type VerdictAnswer,
  type VerdictTriggerEvidence,
} from "@zcode/contracts";
import type { PermissionBrokerRequest } from "@zcode/contracts";
import {
  createChildTraceContext,
  runWithModelInvocationContext,
  traceContextToLogContext,
  type ModelInputMessage,
  type SessionEvent,
  type TraceContext,
} from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import {
  isRuntimeAttachmentEntry,
  systemReminderAttachmentEntry,
  type RuntimeMessageEntry,
} from "../../agent/message-history.js";
import { createRuntimeModel } from "./runtime-model.js";
import { createRefreshRuntimeHeadersBeforeModelAttempt } from "./model-runtime-headers.js";
import { recordModelUsageFact } from "./usage-observability.js";
import { persistAnnouncements } from "./context-refresh.js";
import { readConfirmedBriefForJudge } from "./brief-gate.js";
import type { RegularTurnLoopState } from "./turn-loop-state.js";

const VERDICT_MAX_OUTPUT_TOKENS = 500;
const DEFAULT_VERDICT_TIMEOUT_MS = 120_000;
// The measured trigger points: the static anomaly guard already spoke at its
// own threshold; the judge only wakes twice past it. And a stop before real
// work (a mistyped prompt, an immediate change of mind) is not drift evidence.
const REPEATED_CALL_JUDGE_FACTOR = 2;
export const MIN_STEPS_FOR_INTERRUPT_VERDICT = 2;
const MAX_GOAL_CHARS = 4_000;

// One judgement per turn (retries and compaction re-enter the loop), and the
// session's intervention count so a repeated minor drift escalates to the
// owner's card. Runtime-scoped: restart resets it, the logs keep the count.
const verdictTurns = new WeakMap<object, { turnKey: string; interventions: number }>();

// The interrupted attempt's measured facts, parked here by the interrupt
// marker and consumed by the first turn that starts afterwards.
const pendingInterruptVerdict = new WeakMap<object, { steps: number; toolCalls: number }>();

export function recordInterruptForVerdict(runtime: AgentRuntimeInternal, state: {
  modelStepCount: number;
  toolCallCount: number;
}): void {
  if (state.modelStepCount < MIN_STEPS_FOR_INTERRUPT_VERDICT) return;
  pendingInterruptVerdict.set(runtime, {
    steps: state.modelStepCount,
    toolCalls: state.toolCallCount,
  });
}

// The next turn's start: if the previous attempt was stopped mid-flight, the
// judge reads it once and its note rides the fresh turn.
export async function consumeInterruptVerdictForTurn(
  this: AgentRuntimeInternal,
  state: RegularTurnLoopState,
): Promise<void> {
  const pending = pendingInterruptVerdict.get(this);
  if (!pending) return;
  pendingInterruptVerdict.delete(this);
  await maybeRunTurnVerdict.call(this, state, {
    trigger: "owner_interrupt",
    facts: [
      `the owner stopped the previous attempt after ${pending.steps} model steps and ${pending.toolCalls} tool calls`,
    ],
    window: buildVerdictWindow(state.turnRequestState.entries),
  }, state.turnTraceContext);
}

// The mid-turn trigger: the repeated-call streak twice past the static guard's
// threshold, in the same settlement where that guard spoke once already.
export async function maybeJudgeRepeatedToolCalls(
  runtime: AgentRuntimeInternal,
  state: RegularTurnLoopState,
  options: {
    modelTraceContext: TraceContext;
    toolName: string;
  },
): Promise<void> {
  const threshold =
    runtime.config.modelAnomalyGuard?.repeatedToolCallWarningThreshold ?? 3;
  if (state.repeatedToolCallStreakCount < threshold * REPEATED_CALL_JUDGE_FACTOR) return;
  await maybeRunTurnVerdict.call(runtime, state, {
    trigger: "repeated_tool_calls",
    facts: [
      `the same ${options.toolName} call repeated ${state.repeatedToolCallStreakCount} times in a row (the anomaly guard warned at ${threshold})`,
      `${state.modelStepCount} model steps, ${state.toolCallCount} tool calls so far`,
    ],
    window: buildVerdictWindow(state.turnRequestState.entries),
  }, state.turnTraceContext);
}

/**
 * U6: run the judge for one measured trigger. One judgement per turn, one
 * model call, fail-open on every path; the outcome is logged to be counted.
 */
export async function maybeRunTurnVerdict(
  this: AgentRuntimeInternal,
  state: RegularTurnLoopState,
  evidence: VerdictTriggerEvidence,
  traceContext: TraceContext,
): Promise<void> {
  if (this.config.verdictGate?.enabled === false) return;
  if (this.config.subagentContext) return;
  // The card belongs to the interactive app; headless harnesses, CLI one-shots
  // and tests stay inert by construction.
  if (this.config.presentationSurface !== "zcode_desktop") return;
  const book = verdictTurns.get(this);
  if (book?.turnKey === state.turnId) return;
  verdictTurns.set(this, { turnKey: state.turnId, interventions: book?.interventions ?? 0 });

  const brief = readConfirmedBriefForJudge(this);
  const goalSource: "brief" | "request" = brief ? "brief" : "request";
  const goal = brief?.goal ?? Array.from(state.input.trim()).slice(0, MAX_GOAL_CHARS).join("");
  this.logger?.info("The judge wakes on a measured trigger", {
    ...traceContextToLogContext(traceContext),
    event: "verdict.run.started",
    module: "core.runtime",
    status: "started",
    trigger: evidence.trigger,
    goalSource,
  });
  const verdict = await runVerdictWithModel(
    this,
    formatVerdictPrompt(goal, goalSource, evidence),
    traceContext,
    state.turnAbortSignal,
  );
  if (!verdict) {
    this.logger?.warn("The judge failed open", {
      ...traceContextToLogContext(traceContext),
      event: "verdict.run.failed_open",
      module: "core.runtime",
      status: "failed",
      trigger: evidence.trigger,
    });
    return;
  }
  if (verdict.kind === "aligned") {
    this.logger?.info("The judge read the turn as aligned", {
      ...traceContextToLogContext(traceContext),
      event: "verdict.aligned",
      module: "core.runtime",
      trigger: evidence.trigger,
    });
    return;
  }
  // Dispatch on the tag: a note speaks; a question is for live turns only,
  // and a repeated minor drift earns it too.
  const needsQuestion =
    evidence.trigger !== "owner_interrupt" &&
    (verdict.kind === "drift" || (book?.interventions ?? 0) >= 1);
  if (needsQuestion) {
    const answer = await askOwnerAboutDrift(this, verdict, state, traceContext);
    if (answer.kind === "finish") {
      countIntervention(this, verdictTurns.get(this));
      this.logger?.info("The owner let the turn finish", {
        ...traceContextToLogContext(traceContext),
        event: "verdict.owner_finish",
        module: "core.runtime",
        trigger: evidence.trigger,
      });
      return;
    }
    if (answer.kind === "redirect") {
      countIntervention(this, verdictTurns.get(this));
      await injectVerdictNote(this, state, verdict, evidence.trigger, answer.text, traceContext, {
        resolution: answer.text ? "owner_redirect" : "judge_redirect",
      });
      return;
    }
    // Dismissed or timed out: the judge's own note rides, conservatively.
    await injectVerdictNote(this, state, verdict, evidence.trigger, undefined, traceContext, {
      resolution: "card_dismissed",
    });
    return;
  }
  await injectVerdictNote(this, state, verdict, evidence.trigger, undefined, traceContext, {
    resolution: "note",
  });
}

function countIntervention(
  runtime: AgentRuntimeInternal,
  book: { turnKey: string; interventions: number } | undefined,
): void {
  if (!book) return;
  verdictTurns.set(runtime, {
    turnKey: book.turnKey,
    interventions: book.interventions + 1,
  });
}

// The note is the verdict's only word to the agent: persisted first (resume
// replays it), committed to the current request, and stored as the session's
// runtime/verdict entry so it can be counted later.
async function injectVerdictNote(
  runtime: AgentRuntimeInternal,
  state: RegularTurnLoopState,
  verdict: TurnVerdict,
  trigger: VerdictTriggerEvidence["trigger"],
  redirectText: string | undefined,
  traceContext: TraceContext,
  meta: { resolution: string },
): Promise<void> {
  await persistAnnouncements(
    runtime,
    state.turnRequestState,
    [systemReminderAttachmentEntry("verdict", formatVerdictNote(verdict, trigger, redirectText))],
    traceContext,
  );
  if (runtime.sessionStore?.saveSessionEntry) {
    const timestamp = Date.now();
    try {
      await runtime.sessionStore.saveSessionEntry({
        id: `${runtime.sessionId}:runtime-verdict:${state.turnId}:${timestamp}`,
        sessionID: runtime.sessionId,
        type: "runtime/verdict",
        touchSession: false,
        time: { created: timestamp, updated: timestamp },
        data: { ...verdict, resolution: meta.resolution, trigger },
      });
    } catch (error) {
      runtime.logger?.warn("Verdict persistence failed", {
        ...traceContextToLogContext(traceContext),
        error: error instanceof Error ? error.message : String(error),
        event: "verdict.persist.failed",
        module: "core.runtime",
        status: "failed",
      });
    }
  }
  runtime.logger?.info("The judge spoke", {
    ...traceContextToLogContext(traceContext),
    event: "verdict.spoke",
    module: "core.runtime",
    resolution: meta.resolution,
    trigger,
    verdictKind: verdict.kind,
  });
}

// One question, on the same surface the Brief confirmation uses. No answer or
// a timeout returns `dismissed` and the gate fails open.
async function askOwnerAboutDrift(
  runtime: AgentRuntimeInternal,
  verdict: TurnVerdict,
  state: RegularTurnLoopState,
  traceContext: TraceContext,
): Promise<VerdictAnswer> {
  const broker = runtime.permissionBroker;
  if (!broker) return { kind: "dismissed" };
  const question = formatVerdictQuestion(verdict);
  const requestId = `verdict:${state.turnId}`;
  try {
    const result = await broker.requestPermission(
      {
        input: { questions: [question] },
        mode: runtime.config.mode ?? "build",
        requestId,
        requestedAt: new Date(),
        reason: "The judge read this turn as drifting",
        riskLevel: "low",
        ruleId: "verdict.redirection",
        sessionId: runtime.sessionId,
        toolCallId: requestId as PermissionBrokerRequest["toolCallId"],
        toolName: "AskUserQuestion",
        traceId: traceContext.traceId,
        ...(traceContext.turnId ? { turnId: traceContext.turnId } : {}),
      },
      {
        signal: state.turnAbortSignal,
        timeoutMs: runtime.config.verdictGate?.timeoutMs ?? DEFAULT_VERDICT_TIMEOUT_MS,
      },
    );
    if (result.decision !== "allow") return { kind: "dismissed" };
    return readVerdictAnswer(result.modifiedInput, question.question);
  } catch (error) {
    runtime.logger?.warn("The judge's card failed open", {
      ...traceContextToLogContext(traceContext),
      error: error instanceof Error ? error.message : String(error),
      event: "verdict.card.failed_open",
      module: "core.runtime",
      status: "failed",
    });
    return { kind: "dismissed" };
  }
}

// The judge's one model call. A side call with its own trace, usage fact and
// logs; a provider failure returns null and the gate fails open.
async function runVerdictWithModel(
  runtime: AgentRuntimeInternal,
  prompt: string,
  traceContext: TraceContext,
  signal: AbortSignal | undefined,
): Promise<TurnVerdict | null> {
  const model = createRuntimeModel(runtime, { selection: runtime.getSessionModelSelection() });
  const modelTraceContext = createChildTraceContext(traceContext, {
    attributes: {
      model: `${model.providerId}/${model.modelId}`,
      querySource: VERDICT_QUERY_SOURCE,
    },
  });
  const events: SessionEvent[] = [];
  const messages: ModelInputMessage[] = [{ role: "system", content: prompt }];
  const startedAt = Date.now();
  try {
    using statusSink = runtime.createModelStatusSink(modelTraceContext, events, {
      persist: false,
    });
    const result = await runWithModelInvocationContext(
      {
        metadata: traceContextToLogContext(modelTraceContext),
        modelRequestSessionType: "other",
        modelCall: { operation: "workspace_generate_text" },
        statusSink,
        traceContext: modelTraceContext,
        refreshRuntimeHeadersBeforeAttempt: createRefreshRuntimeHeadersBeforeModelAttempt(runtime, {
          abortSignal: signal,
          model,
          traceContext: modelTraceContext,
        }),
      },
      () =>
        model.generateText({
          abortSignal: signal,
          messages,
          options: {
            maxOutputTokens: Math.min(
              VERDICT_MAX_OUTPUT_TOKENS,
              model.optionSpecs.maxOutputTokens.max,
            ),
          },
        }),
    );
    await recordModelUsageFact(runtime, {
      events,
      model,
      networkEventStartIndex: 0,
      querySource: VERDICT_QUERY_SOURCE,
      result,
      startedAt,
      status: "completed",
      toolCallCount: 0,
      traceContext: modelTraceContext,
    });
    return parseVerdictText(result.text);
  } catch (error) {
    runtime.logger?.warn("The judge's model call failed open", {
      ...traceContextToLogContext(modelTraceContext),
      error: error instanceof Error ? error.message : String(error),
      event: "verdict.model.failed_open",
      module: "core.runtime",
      status: "failed",
    });
    return null;
  }
}

// The compact witness of the recent steps: tool calls with their input, and
// assistant text, each on one truncated line. The goal and the measured facts
// carry the rest; this window is only what the judge can quote as evidence.
export function buildVerdictWindow(
  entries: readonly RuntimeMessageEntry[],
): string[] {
  const lines: string[] = [];
  for (const entry of entries) {
    if (isRuntimeAttachmentEntry(entry)) continue;
    const { message } = entry;
    if (message.role === "assistant" && message.toolCalls && message.toolCalls.length > 0) {
      for (const call of message.toolCalls) {
        lines.push(compactStepLine(`tool ${call.name}`, call.input));
      }
      continue;
    }
    if (message.role === "assistant" && typeof message.content === "string") {
      const text = message.content.trim();
      if (text.length > 0) lines.push(compactStepLine("assistant", text));
    }
  }
  return lines.slice(-MAX_VERDICT_WINDOW_ENTRIES);
}

function compactStepLine(label: string, value: unknown): string {
  const raw =
    typeof value === "string"
      ? value
      : safeJson(value);
  const flat = raw.split(/\s+/).filter((part) => part.length > 0).join(" ");
  const bounded = Array.from(flat).slice(0, 200).join("");
  return `${label}: ${bounded}`;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}
