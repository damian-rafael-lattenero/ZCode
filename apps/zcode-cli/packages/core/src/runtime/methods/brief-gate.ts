// [fork] U5 — the Brief gate: before a turn's first model step, the runtime
// drafts the Brief of the user's request, asks the owner to confirm or correct
// it on the question card (two-minute expiry), and the confirmed Brief rides
// the turn as its own system-reminder entry and is stored in the session.
//
// Every failure path is fail-open: no model, no broker, a broken draft, a
// declined card or a timeout all mean the turn proceeds WITHOUT a Brief, and
// the reason is logged. The gate never throws into the turn.
import {
  BRIEF_DRAFT_QUERY_SOURCE,
  formatBriefCorrectionPrompt,
  formatBriefDraftPrompt,
  formatBriefForPrompt,
  formatBriefQuestion,
  parseBriefDraftText,
  readBriefAnswer,
  type Brief,
  type PermissionBrokerRequest,
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
import type { TurnRequestState } from "./turn-loop-state.js";

const BRIEF_DRAFT_MAX_OUTPUT_TOKENS = 700;
const DEFAULT_BRIEF_TIMEOUT_MS = 120_000;

// One gate run per turn: the loop re-enters on retries and compaction, and the
// card must never be asked twice for the same turn.
const briefAskedTurns = new WeakMap<object, string>();

// The last confirmed Brief of this runtime: the judge (U6) reads it as the
// turn's goal when it wakes. Absent means the judge falls back to the raw
// request text.
const latestConfirmedBrief = new WeakMap<object, Brief>();

export function readConfirmedBriefForJudge(runtime: AgentRuntimeInternal): Brief | null {
  return latestConfirmedBrief.get(runtime) ?? null;
}

type BriefDraftRequest = { brief: Brief | null; reason: string };

// The two model calls the gate makes: the draft and, at most once, the re-draft
// after a correction. A side call that keeps its own trace, usage fact and
// logs; a provider failure returns null and the gate fails open.
async function draftBriefWithModel(
  runtime: AgentRuntimeInternal,
  prompt: string,
  traceContext: TraceContext,
  signal: AbortSignal | undefined,
): Promise<BriefDraftRequest | null> {
  const model = createRuntimeModel(runtime, { selection: runtime.getSessionModelSelection() });
  const modelTraceContext = createChildTraceContext(traceContext, {
    attributes: {
      model: `${model.providerId}/${model.modelId}`,
      querySource: BRIEF_DRAFT_QUERY_SOURCE,
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
              BRIEF_DRAFT_MAX_OUTPUT_TOKENS,
              model.optionSpecs.maxOutputTokens.max,
            ),
          },
        }),
    );
    await recordModelUsageFact(runtime, {
      events,
      model,
      networkEventStartIndex: 0,
      querySource: BRIEF_DRAFT_QUERY_SOURCE,
      result,
      startedAt,
      status: "completed",
      toolCallCount: 0,
      traceContext: modelTraceContext,
    });
    return parseBriefDraftText(result.text);
  } catch (error) {
    runtime.logger?.warn("Brief draft failed open", {
      ...traceContextToLogContext(modelTraceContext),
      error: error instanceof Error ? error.message : String(error),
      event: "brief.draft.failed_open",
      module: "core.runtime",
      status: "failed",
    });
    return null;
  }
}

// The three outcomes of the card, as a value: confirmed, corrected, or none
// (declined, timed out, no surface). The gate dispatches on the tag.
type BriefDecision =
  | { kind: "confirm"; brief: Brief }
  | { kind: "correction"; text: string }
  | { kind: "none" };

// Ask the owner through the same question surface the AskUserQuestion tool
// uses. The answered input comes back as `modifiedInput.answers`.
async function askOwnerToConfirmBrief(
  runtime: AgentRuntimeInternal,
  brief: Brief,
  traceContext: TraceContext,
  signal: AbortSignal | undefined,
): Promise<BriefDecision> {
  const broker = runtime.permissionBroker;
  if (!broker) {
    runtime.logger?.debug("Brief gate has no question surface", {
      event: "brief.card.unavailable",
      module: "core.runtime",
    });
    return { kind: "none" };
  }
  const question = formatBriefQuestion(brief);
  const requestId = `brief:${traceContext.turnId ?? traceContext.traceId}`;
  try {
    const result = await broker.requestPermission(
      {
        input: { questions: [question] },
        mode: runtime.config.mode ?? "build",
        requestId,
        requestedAt: new Date(),
        reason: "Confirm the Brief for this turn",
        riskLevel: "low",
        ruleId: "brief.confirmation",
        sessionId: runtime.sessionId,
        toolCallId: requestId as PermissionBrokerRequest["toolCallId"],
        toolName: "AskUserQuestion",
        traceId: traceContext.traceId,
        ...(traceContext.turnId ? { turnId: traceContext.turnId } : {}),
      },
      {
        signal,
        timeoutMs: runtime.config.briefGate?.timeoutMs ?? DEFAULT_BRIEF_TIMEOUT_MS,
      },
    );
    if (result.decision !== "allow") {
      runtime.logger?.info("Brief card dismissed", {
        ...traceContextToLogContext(traceContext),
        decision: result.decision,
        event: "brief.card.dismissed",
        module: "core.runtime",
      });
      return { kind: "none" };
    }
    const answer = readBriefAnswer(result.modifiedInput, question.question);
    if (answer.kind === "confirm") return { kind: "confirm", brief };
    if (answer.kind === "dismissed") {
      runtime.logger?.info("Brief card dismissed without a correction", {
        ...traceContextToLogContext(traceContext),
        event: "brief.card.dismissed",
        module: "core.runtime",
      });
      return { kind: "none" };
    }
    return { kind: "correction", text: answer.text };
  } catch (error) {
    runtime.logger?.warn("Brief card failed open", {
      ...traceContextToLogContext(traceContext),
      error: error instanceof Error ? error.message : String(error),
      event: "brief.card.failed_open",
      module: "core.runtime",
      status: "failed",
    });
    return { kind: "none" };
  }
}

/**
 * U5: ensure the turn carries a confirmed Brief. Runs once at the start of a
 * regular main-session turn, before the first model step. Fail-open on every
 * path; the turn continues with no Brief and the reason is logged.
 */
export async function ensureBriefForTurn(
  this: AgentRuntimeInternal,
  input: string,
  requestState: TurnRequestState,
  traceContext: TraceContext,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (this.config.briefGate?.enabled === false) return;
  if (this.config.subagentContext) return;
  // The card belongs to the interactive app (desktop and the phone it mirrors);
  // headless harnesses, CLI one-shots and tests stay inert by construction.
  if (this.config.presentationSurface !== "zcode_desktop") return;
  if (!input.trim()) return;
  const turnKey = traceContext.turnId ?? traceContext.traceId;
  if (briefAskedTurns.get(this) === turnKey) return;
  briefAskedTurns.set(this, turnKey);

  const draft = await draftBriefWithModel(
    this,
    formatBriefDraftPrompt(input),
    traceContext,
    signal,
  );
  if (!draft?.brief) {
    this.logger?.info("Brief drafted as no task", {
      ...traceContextToLogContext(traceContext),
      event: "brief.draft.none",
      module: "core.runtime",
      reason: draft?.reason ?? "no draft",
    });
    return;
  }

  const decision = await askOwnerToConfirmBrief(this, draft.brief, traceContext, signal);
  let brief: Brief | null = decision.kind === "confirm" ? decision.brief : null;
  // The owner corrected the draft: one re-draft with their words. If that
  // re-draft fails, the turn rides with NO Brief rather than the rejected one.
  if (decision.kind === "correction") {
    const redraft = await draftBriefWithModel(
      this,
      formatBriefCorrectionPrompt(input, decision.text),
      traceContext,
      signal,
    );
    brief = redraft?.brief ?? null;
  }
  if (!brief) return;

  latestConfirmedBrief.set(this, brief);

  await persistAnnouncements(this, requestState, [
    systemReminderAttachmentEntry("brief", formatBriefForPrompt(brief)),
  ], traceContext);
  if (this.sessionStore?.saveSessionEntry) {
    const timestamp = Date.now();
    try {
      await this.sessionStore.saveSessionEntry({
        id: `${this.sessionId}:runtime-brief:${traceContext.turnId ?? traceContext.traceId}`,
        sessionID: this.sessionId,
        type: "runtime/brief",
        touchSession: false,
        time: { created: timestamp, updated: timestamp },
        data: brief,
      });
    } catch (error) {
      this.logger?.warn("Brief persistence failed", {
        ...traceContextToLogContext(traceContext),
        error: error instanceof Error ? error.message : String(error),
        event: "brief.persist.failed",
        module: "core.runtime",
        status: "failed",
      });
    }
  }
  this.logger?.info("Brief confirmed and riding the turn", {
    ...traceContextToLogContext(traceContext),
    event: "brief.confirmed",
    module: "core.runtime",
    goalLength: brief.goal.length,
  });
}
