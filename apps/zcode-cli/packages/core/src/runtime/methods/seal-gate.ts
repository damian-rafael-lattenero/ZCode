// [fork] U7 — the seal: when a turn that carries a confirmed Brief finishes
// its final reply, the seal measures it once — acceptance met, and the reply
// carrying result · evidence · next. A miss bounces the turn ONCE with the
// gaps and the shape; the second miss is one notice to the owner, whose tap
// alone can send the work back again. A seal that fails, times out or speaks
// nonsense passes the turn: it measures, it never traps. No Brief on the
// turn (conversational prompts, declined cards, harnesses) means the seal is
// silent; in subagents the law of the system prompt and the oracles act.
// One measurement per finish, one bounce per turn, one notice per turn —
// and every outcome is logged to be counted.
import {
  SEAL_QUERY_SOURCE,
  escapeGoalPromptText,
  formatSealBounceNote,
  formatSealNoticeQuestion,
  formatSealPrompt,
  parseSealText,
  readSealNoticeAnswer,
  type Brief,
  type PermissionBrokerRequest,
  type SealCheck,
} from "@zcode/contracts";
import {
  createChildTraceContext,
  runWithModelInvocationContext,
  traceContextToLogContext,
  type ModelInputMessage,
  type SessionEvent,
  type TraceContext,
} from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { systemReminderAttachmentEntry } from "../../agent/message-history.js";
import { createRuntimeModel } from "./runtime-model.js";
import { createRefreshRuntimeHeadersBeforeModelAttempt } from "./model-runtime-headers.js";
import { recordModelUsageFact } from "./usage-observability.js";
import { persistAnnouncements } from "./context-refresh.js";
import { readConfirmedBriefForJudge } from "./brief-gate.js";
import type { RegularTurnLoopState } from "./turn-loop-state.js";

const SEAL_MAX_OUTPUT_TOKENS = 400;
const DEFAULT_SEAL_TIMEOUT_MS = 120_000;

// The seal's lane per turn: idle until it bounces, bounced until the turn
// ends. The second measurement on a bounced turn reads the owner's card.
type SealTurnState = { turnKey: string; bounced: boolean };
const sealTurns = new WeakMap<object, SealTurnState>();

/**
 * U7: measure the finished turn against the confirmed Brief. Returns true
 * when the turn must continue (the one bounce, or an owner-ordered return);
 * false when it ends. Fail-open on every path.
 */
export async function runSealForTurn(
  this: AgentRuntimeInternal,
  state: RegularTurnLoopState,
  traceContext: TraceContext,
): Promise<boolean> {
  if (this.config.sealGate?.enabled === false) return false;
  if (this.config.subagentContext) return false;
  // The card belongs to the interactive app; harnesses, CLI one-shots and
  // tests stay inert by construction.
  if (this.config.presentationSurface !== "zcode_desktop") return false;
  // The stop hook's continuation lane is active — no stacking of bounces.
  if (state.stopHookContinuationCount > 0) return false;
  const brief = readConfirmedBriefForJudge(this);
  if (!brief) return false;

  const book = sealTurns.get(this);
  const turnKey = state.turnId;
  const phase = book?.turnKey === turnKey ? (book.bounced ? "bounced" : "idle") : "idle";

  this.logger?.info("The seal measures the finished turn", {
    ...traceContextToLogContext(traceContext),
    event: "seal.run.started",
    module: "core.runtime",
    status: "started",
    phase,
  });
  const check = await runSealCheckWithModel(this, formatSealPrompt(brief, state.modelResponse), traceContext, state.turnAbortSignal);
  if (!check) {
    this.logger?.warn("The seal failed open", {
      ...traceContextToLogContext(traceContext),
      event: "seal.run.failed_open",
      module: "core.runtime",
      status: "failed",
      phase,
    });
    return false;
  }
  const passed = check.complete && check.replyShapeOk;
  recordSealEntry(this, state, brief, check, passed ? "passed" : phase === "idle" ? "bounced" : "notice", traceContext);
  if (passed) {
    this.logger?.info("The seal passed the turn", {
      ...traceContextToLogContext(traceContext),
      event: phase === "idle" ? "seal.passed" : "seal.passed_after_bounce",
      module: "core.runtime",
    });
    sealTurns.set(this, { turnKey, bounced: false });
    return false;
  }

  if (phase === "idle") {
    // First miss: the turn goes back once, with the gaps and the shape.
    sealTurns.set(this, { turnKey, bounced: true });
    await persistAnnouncements(this, state.turnRequestState, [
      systemReminderAttachmentEntry("seal", formatSealBounceNote(check)),
    ], traceContext);
    this.logger?.info("The seal bounced the turn once", {
      ...traceContextToLogContext(traceContext),
      event: "seal.bounced",
      module: "core.runtime",
      gaps: check.gaps.length,
      replyShapeOk: check.replyShapeOk,
    });
    return true;
  }

  // Second miss: the notice is the owner's. End, or one ordered return.
  const answer = await askOwnerAboutSeal(this, check, state, traceContext);
  if (answer.kind === "return") {
    const ownerLine = answer.text
      ? `\n\nThe owner added: ${escapeGoalPromptText(answer.text)}`
      : "";
    await persistAnnouncements(this, state.turnRequestState, [
      systemReminderAttachmentEntry("seal", formatSealBounceNote(check) + ownerLine),
    ], traceContext);
    this.logger?.info("The owner sent the turn back", {
      ...traceContextToLogContext(traceContext),
      event: "seal.owner_return",
      module: "core.runtime",
      withWords: answer.text.length > 0,
    });
    return true;
  }
  this.logger?.info(answer.kind === "end" ? "The owner ended the turn" : "The seal notice was dismissed", {
    ...traceContextToLogContext(traceContext),
    event: answer.kind === "end" ? "seal.owner_end" : "seal.notice_dismissed",
    module: "core.runtime",
  });
  return false;
}

// The card: end the turn, or one more bounce ordered by the owner's own tap.
async function askOwnerAboutSeal(
  runtime: AgentRuntimeInternal,
  check: SealCheck,
  state: RegularTurnLoopState,
  traceContext: TraceContext,
): Promise<{ kind: "end" } | { kind: "return"; text: string } | { kind: "dismissed" }> {
  const broker = runtime.permissionBroker;
  if (!broker) return { kind: "dismissed" };
  const question = formatSealNoticeQuestion(check);
  const requestId = `seal:${state.turnId}`;
  try {
    const result = await broker.requestPermission(
      {
        input: { questions: [question] },
        mode: runtime.config.mode ?? "build",
        requestId,
        requestedAt: new Date(),
        reason: "The seal read the finished turn as still incomplete",
        riskLevel: "low",
        ruleId: "seal.notice",
        sessionId: runtime.sessionId,
        toolCallId: requestId as PermissionBrokerRequest["toolCallId"],
        toolName: "AskUserQuestion",
        traceId: traceContext.traceId,
        ...(traceContext.turnId ? { turnId: traceContext.turnId } : {}),
      },
      {
        signal: state.turnAbortSignal,
        timeoutMs: runtime.config.sealGate?.timeoutMs ?? DEFAULT_SEAL_TIMEOUT_MS,
      },
    );
    if (result.decision !== "allow") return { kind: "dismissed" };
    return readSealNoticeAnswer(result.modifiedInput, question.question);
  } catch (error) {
    runtime.logger?.warn("The seal's card failed open", {
      ...traceContextToLogContext(traceContext),
      error: error instanceof Error ? error.message : String(error),
      event: "seal.card.failed_open",
      module: "core.runtime",
      status: "failed",
    });
    return { kind: "dismissed" };
  }
}

async function recordSealEntry(
  runtime: AgentRuntimeInternal,
  state: RegularTurnLoopState,
  brief: Brief,
  check: SealCheck,
  outcome: string,
  traceContext: TraceContext,
): Promise<void> {
  if (!runtime.sessionStore?.saveSessionEntry) return;
  const timestamp = Date.now();
  try {
    await runtime.sessionStore.saveSessionEntry({
      id: `${runtime.sessionId}:runtime-seal:${state.turnId}:${timestamp}`,
      sessionID: runtime.sessionId,
      type: "runtime/seal",
      touchSession: false,
      time: { created: timestamp, updated: timestamp },
      data: { ...check, outcome },
    });
  } catch (error) {
    runtime.logger?.warn("Seal persistence failed", {
      ...traceContextToLogContext(traceContext),
      error: error instanceof Error ? error.message : String(error),
      event: "seal.persist.failed",
      module: "core.runtime",
      status: "failed",
    });
  }
}

// The seal's one model call. A side call with its own trace, usage fact and
// logs; a provider failure returns null and the gate fails open.
async function runSealCheckWithModel(
  runtime: AgentRuntimeInternal,
  prompt: string,
  traceContext: TraceContext,
  signal: AbortSignal | undefined,
): Promise<SealCheck | null> {
  const model = createRuntimeModel(runtime, { selection: runtime.getSessionModelSelection() });
  const modelTraceContext = createChildTraceContext(traceContext, {
    attributes: {
      model: `${model.providerId}/${model.modelId}`,
      querySource: SEAL_QUERY_SOURCE,
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
              SEAL_MAX_OUTPUT_TOKENS,
              model.optionSpecs.maxOutputTokens.max,
            ),
          },
        }),
    );
    await recordModelUsageFact(runtime, {
      events,
      model,
      networkEventStartIndex: 0,
      querySource: SEAL_QUERY_SOURCE,
      result,
      startedAt,
      status: "completed",
      toolCallCount: 0,
      traceContext: modelTraceContext,
    });
    return parseSealText(result.text);
  } catch (error) {
    runtime.logger?.warn("The seal's model call failed open", {
      ...traceContextToLogContext(modelTraceContext),
      error: error instanceof Error ? error.message : String(error),
      event: "seal.model.failed_open",
      module: "core.runtime",
      status: "failed",
    });
    return null;
  }
}
