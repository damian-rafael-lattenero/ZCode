import { OFFICIAL_CUA_FRAME_MODEL_CONTENT_PROTECTION } from "@zcode/zcode-cua/frame-contract";
import { hasOfficialCuaFrameAuthority } from "../../mcp/image-normalization.js";
import type { ToolEntry } from "../types.js";

/**
 * node_repl also carries Browser Use and CUA, so the whole server cannot be marked
 * official at registration time. Only when the CUA SDK result carries producer
 * integrity metadata is atomic frame protection enabled for this serialization;
 * otherwise the generic resultBudget would truncate/reorder image_ref, or a
 * non-authority path would strip the reference.
 *
 * Kept in its own module because both the foreground settlement and the detached
 * completion chain (executor/detached-tool-call.ts) resolve the same entry.
 */
export function resolveModelOutputEntry(entry: ToolEntry, output: unknown): ToolEntry {
  const isSharedNodeRepl =
    entry.metadata.name === "mcp__node_repl__js" ||
    entry.metadata.mcpPresentation?.serverName === "node_repl";
  if (
    entry.modelContentProtection === OFFICIAL_CUA_FRAME_MODEL_CONTENT_PROTECTION ||
    !isSharedNodeRepl ||
    !hasOfficialCuaFrameAuthority(output)
  ) {
    return entry;
  }
  return {
    ...entry,
    modelContentProtection: OFFICIAL_CUA_FRAME_MODEL_CONTENT_PROTECTION,
    resultBudget: {
      ...entry.resultBudget,
      maxInlineBytes: Math.max(entry.resultBudget.maxInlineBytes, 256 * 1024),
      maxModelBytes: Math.max(entry.resultBudget.maxModelBytes, 256 * 1024),
      strategy: "truncate",
      preview: { direction: "head" },
    },
  };
}
