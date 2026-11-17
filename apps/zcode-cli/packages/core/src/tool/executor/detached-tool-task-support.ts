// ============================================================
// Detached tool task support — capability lookup and notification formatting
// ============================================================
//
// Split out of background-tasks.ts to keep that module under the lint max-lines budget and
// to give the two capability questions one answer: "is this a generic backgrounding tool?"
// (host-authoritative ToolEntry.backgrounding, never name inference) and "how does its
// terminal notification read?".

import type { ToolRegistry } from "../registry.js";
import type { ExecutableToolCall } from "../types.js";
import { isSubagentDispatchToolName } from "../compat.js";
import { isDynamicWorkflowRunDispatchToolName } from "./background-task-registry.js";
import { backgroundTaskOutputMetadata } from "./background-task-output.js";
import type { DetachedToolTaskSnapshot } from "./detached-tool-tasks.js";
import { formatTaskNotification } from "../../runtime-task/notification.js";

type BackgroundTaskKind = "bash" | "subagent" | "workflow" | "tool";

/**
 * A tool whose `ToolEntry` declares the host-authoritative `backgrounding` capability.
 * The explicit name exclusions keep the dedicated Bash/Agent/workflow lifecycle providers
 * authoritative even if a future registration mistakenly adds the capability there.
 */
export function isGenericBackgroundingTool(
  registry: ToolRegistry | undefined,
  toolCall: ExecutableToolCall,
): boolean {
  if (
    toolCall.name === "Bash" ||
    toolCall.name === "Workflow" ||
    isSubagentDispatchToolName(toolCall.name) ||
    isDynamicWorkflowRunDispatchToolName(toolCall.name)
  ) {
    return false;
  }
  return registry?.get(toolCall.name)?.backgrounding?.supported === true;
}

/**
 * 后台任务的展示类别（面板分组与图标）。`taskKind` 只是装饰：生命周期语义已经由
 * per-tool 的 lifecycleProvider 分派，所以这里的分类改动不会影响观察/等待/取消。
 *
 * legacy `Workflow`（script workflow）刻意仍归 "bash"：它不可取消、面板上也没有详情页，
 * 与 workflow run 是两种不同的东西，共用一个类别会让面板把两者混在一起。
 */
export function backgroundTaskKindForToolCall(
  registry: ToolRegistry | undefined,
  toolCall: ExecutableToolCall,
): BackgroundTaskKind {
  if (isSubagentDispatchToolName(toolCall.name)) return "subagent";
  // dwf 的两个入口（CreateWorkflow / ResumeWorkflowRun）同归 "workflow"：同一个 run 的
  // 生命周期延续，面板分组与图标不该因入口不同而换类。
  if (isDynamicWorkflowRunDispatchToolName(toolCall.name)) return "workflow";
  return isGenericBackgroundingTool(registry, toolCall) ? "tool" : "bash";
}

export function isDetachedToolTaskSnapshot(
  snapshot: object | undefined,
): snapshot is DetachedToolTaskSnapshot {
  return (
    snapshot !== undefined &&
    "toolCallId" in snapshot &&
    "toolName" in snapshot &&
    "description" in snapshot
  );
}

/**
 * Terminal notification for a detached generic tool call. Reuses the shared
 * `formatTaskNotification` shape with taskType "local_tool": the bounded result text is
 * the useful payload, and the tracker's generic status word stays in `<status>`.
 */
export function formatDetachedToolTaskNotification(input: {
  snapshot: DetachedToolTaskSnapshot | undefined;
  status: string;
  taskId: string;
  toolCall: ExecutableToolCall;
}): string {
  const { snapshot, status, taskId, toolCall } = input;
  return formatTaskNotification({
    ...(snapshot?.description === undefined ? {} : { description: snapshot.description }),
    ...(snapshot?.error === undefined ? {} : { error: snapshot.error }),
    outputFile: backgroundTaskOutputMetadata(snapshot).outputFile,
    ...(snapshot?.resultText === undefined ? {} : { result: snapshot.resultText }),
    status: normalizeBackgroundTaskNotificationStatus(status),
    summary: buildDetachedToolTaskSummary({
      status,
      subject: snapshot?.description,
      toolName: toolCall.name,
    }),
    taskId,
    taskType: "local_tool",
    toolUseId: toolCall.id,
  });
}

function buildDetachedToolTaskSummary(input: {
  status: string;
  subject?: string;
  toolName: string;
}): string {
  const prefix = `Background ${input.toolName} call${
    input.subject === undefined ? "" : ` "${input.subject}"`
  }`;
  switch (input.status) {
    case "completed":
      return `${prefix} completed`;
    case "timed_out":
      return `${prefix} timed out`;
    case "cancelled":
    case "killed":
    case "stopped":
      return `${prefix} was stopped`;
    case "lost":
      return `${prefix} failed because its in-process state was lost`;
    default:
      return `${prefix} failed`;
  }
}

function normalizeBackgroundTaskNotificationStatus(status: string): string {
  switch (status) {
    case "completed":
      return "completed";
    case "cancelled":
    case "timed_out":
    case "killed":
    case "stopped":
      return "killed";
    default:
      return "failed";
  }
}
