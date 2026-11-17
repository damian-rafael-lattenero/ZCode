import { CoreErrorType, type AgentTelemetryErrorCategory } from "@zcode/contracts";
import type { ToolExecutionResult } from "../types.js";

export function errorCategoryForToolError(type: string | undefined): AgentTelemetryErrorCategory {
  switch (type) {
    case CoreErrorType.ConfigurationError:
    case CoreErrorType.ToolNotFound:
      return "configuration";
    case CoreErrorType.PermissionDenied:
    case CoreErrorType.PermissionEscalation:
    case CoreErrorType.PermissionTimeout:
      return "permission";
    case CoreErrorType.InvalidInput:
      return "parse";
    case CoreErrorType.ToolCancelled:
      return "cancelled";
    case CoreErrorType.ToolTimeout:
      return "timeout";
    default:
      return "internal";
  }
}

/**
 * 成功、失败与提前返回的失败（PreToolUse 拒绝、Hook 改写后校验失败、权限拒绝）都带上 Hook context。
 * PreToolUse deny 和权限拒绝会在 handler 前提前返回，旧逻辑只在 handler 的成功/异常路径带 context，
 * 导致 Hook 明明返回了 additionalContext，模型却看不到。
 */
export function withHookAdditionalContexts(
  result: ToolExecutionResult,
  hookAdditionalContexts: readonly string[],
): ToolExecutionResult {
  if (hookAdditionalContexts.length === 0) return result;
  return { ...result, hookAdditionalContexts: [...hookAdditionalContexts] };
}
