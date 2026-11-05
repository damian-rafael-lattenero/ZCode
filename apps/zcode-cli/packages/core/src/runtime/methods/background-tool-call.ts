import { traceContextToLogContext } from "../deps.js";
import type { TraceContext } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { RuntimeBackgroundRunningToolCallResult } from "../types.js";
import { supportsBashBackgroundRequestByToolCallId } from "../../tool/handlers/bash-background-lifecycle.js";

/**
 * BT（2026-11-05，OpenCode ctrl+b 复刻）：把仍在跑的前台 Bash tool call 移交后台。
 *
 * 守卫与移交都在 executionPort（adapter）的 toolCallId 登记表里：条目存在且
 * state==="foreground" 且未 aborted 才命中——身份不符/已终态一律 NOOP，绝不 abort。
 * 命中后进程信号不动，前台 tool call 以合成 "backgrounded" 输出立即 resolve（模型在
 * 同一 turn 继续下一步）；进程完成时沿用既有 BackgroundTaskCompleted → backgroundResult
 * 唤醒管线送达输出。turn 不降级，只有 tool call 移交。
 */
export function backgroundRunningToolCall(
  this: AgentRuntimeInternal,
  toolCallId: string,
  options: { traceContext?: TraceContext } = {},
): RuntimeBackgroundRunningToolCallResult {
  if (!supportsBashBackgroundRequestByToolCallId(this.executionPort)) {
    // executionPort 缺外部移交能力（stub / 旧端口）：调用方据此报 unsupported fault。
    return { kind: "unsupported" };
  }
  const workId = this.executionPort.requestBackgroundByToolCallId?.(toolCallId);
  if (workId === undefined) {
    // 无在跑前台 / 已移交 / 已终态：与 demote 的 idle 守卫同义，noop 不抛错。
    return { kind: "noop" };
  }
  this.logger?.info?.("Running Bash tool call moved to background by user", {
    ...traceContextToLogContext(options.traceContext ?? this.rootTraceContext),
    event: "runtime.background_tool_call.backgrounded",
    module: "core.runtime",
    toolCallId,
    workId,
  });
  return { kind: "backgrounded", workId };
}
