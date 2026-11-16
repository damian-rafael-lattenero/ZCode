import { traceContextToLogContext } from "../deps.js";
import type { TraceContext } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { RuntimeBackgroundRunningToolCallResult } from "../types.js";
import { isTerminalRuntimeTask } from "../../runtime-task/registry.js";
import { supportsBashBackgroundRequestByToolCallId } from "../../tool/handlers/bash-background-lifecycle.js";

/**
 * BT (2026-11-05, OpenCode ctrl+b parity): move a still-running foreground tool
 * call to the background. Two legs, checked in order:
 *
 * 1. Bash — the handoff lives in the execution adapter's toolCallId registry:
 *    the entry must exist, be state "foreground" and not aborted. A miss
 *    (unknown id / already moved / terminal) is a NOOP; nothing is ever aborted.
 *    The process keeps its signal and file descriptors; the tool call resolves
 *    at once with a synthetic "backgrounded" output so the model continues in
 *    the same turn, and completion re-enters through the existing
 *    BackgroundTaskCompleted → backgroundResult pipeline.
 *
 * 2. Agent — the runtime task registry is authoritative for in-flight subagent
 *    runs: a local_agent task whose parentToolCallId is this call and which is
 *    still foreground. Requesting background flips the registry entry, the
 *    subagent runner's ownership race wins, the handler resolves with an
 *    async_launched output and the parent turn continues immediately — the
 *    child keeps running and notifies on completion. The off-peak borrowed
 *    foreground guard (modelOverride.background === "deny") refuses by leaving
 *    the entry untouched, which surfaces here as NOOP.
 *
 * `unsupported` means neither capability exists in this runtime (stub / old
 * port). Any other miss is `noop`, the same guard semantics as the demote path.
 */
export async function backgroundRunningToolCall(
  this: AgentRuntimeInternal,
  toolCallId: string,
  options: { traceContext?: TraceContext } = {},
): Promise<RuntimeBackgroundRunningToolCallResult> {
  const logContext = () => ({
    ...traceContextToLogContext(options.traceContext ?? this.rootTraceContext),
    event: "runtime.background_tool_call.backgrounded",
    module: "core.runtime",
    toolCallId,
  });

  let bashHandoffSupported = false;
  if (supportsBashBackgroundRequestByToolCallId(this.executionPort)) {
    bashHandoffSupported = true;
    const workId = this.executionPort.requestBackgroundByToolCallId?.(toolCallId);
    if (workId !== undefined) {
      this.logger?.info?.("Running Bash tool call moved to background by user", {
        ...logContext(),
        workId,
      });
      return { kind: "backgrounded", workId };
    }
  }

  let agentHandoffSupported = false;
  const subagentPort = this.subagentPort;
  if (subagentPort?.backgroundTask) {
    agentHandoffSupported = true;
    const agentTask = Object.values(this.runtimeTaskRegistry.all()).find(
      (task) =>
        task.type === "local_agent" &&
        task.parentToolCallId === toolCallId &&
        task.isBackgrounded !== true &&
        !isTerminalRuntimeTask(task),
    );
    if (agentTask) {
      await subagentPort.backgroundTask(agentTask.taskId);
      // The port returns the public subagent snapshot; the runtime task
      // registry is the local_agent truth and the off-peak borrowed guard
      // refuses by leaving it untouched.
      const backgroundedTask = this.runtimeTaskRegistry.get(agentTask.taskId);
      if (backgroundedTask?.isBackgrounded === true) {
        this.logger?.info?.("Running Agent tool call moved to background by user", {
          ...logContext(),
          agentId: agentTask.taskId,
          workId: agentTask.taskId,
        });
        return { kind: "backgrounded", workId: agentTask.taskId };
      }
      // Terminal race or the off-peak borrowed guard: the request changed
      // nothing, so answer with the same noop the demote path uses.
      return { kind: "noop" };
    }
  }

  if (!bashHandoffSupported && !agentHandoffSupported) {
    // Neither port exposes a handoff: the caller reports an unsupported fault.
    return { kind: "unsupported" };
  }
  return { kind: "noop" };
}
