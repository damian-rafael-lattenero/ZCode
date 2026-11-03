/* [fork] A4 — subagent child sessions as ADDRESSABLE daemon targets.
 *
 * The Kotlin daemon addresses a subagent exactly like the CLI store does:
 * `taskId = sess_subagent_<agentId>` (the convention proven in the live
 * session db: `subagent_child` rows whose `parent_id` is the owner session).
 * Two facts shape the routing below:
 *
 * 1. The child session id needs no translation — it IS the real sid. The
 *    "resolution" that matters is the OWNER: a running child owns no session
 *    record (the v4 inbox answers `proto.sessionNotFound`), and input
 *    admission keeps subagent sessions read-only (`guard.subagentReadOnly`).
 *    The only live door to the child is its owner's runtime task registry.
 * 2. The owner is persisted on the child's store row (`parent_id`), and the
 *    sessions-index reconcile read already proves "does this session exist" —
 *    [fork] it now also returns the row's `parentSessionId`/`taskType`.
 *
 * `resolveSubagentOwner` therefore: parses the convention, reads the store
 * row through the reconcile RPC, and returns the owner ONLY when the row is
 * a persisted `subagent_child` with a parent. Anything else resolves to null
 * and the caller must reject honestly — never fall through to a parent
 * conversation.
 */
import type { SessionsIndexReconcileResult } from "@zcode/shared/zcode-protocol-v4";

export interface SubagentOwnerTarget {
  taskId: string;
  workspacePath: string;
  workspaceIdentity?: string;
}

export interface SubagentOwnerResolution {
  /** Harness agentId from the launch ACK — the child registry key. */
  agentId: string;
  /** The child session id (`sess_subagent_<agentId>`) — unchanged by design. */
  childSessionId: string;
  /** The owner (parent) session id — the v4 command target. */
  parentSessionId: string;
}

export interface ResolveSubagentOwnerInput {
  agentId: string;
  childSessionId: string;
  workspacePath: string;
  workspaceIdentity?: string;
  reconcile: (
    input: SubagentOwnerTarget & { sessionIds: string[] },
  ) => Promise<SessionsIndexReconcileResult>;
}

/**
 * Best-effort resolution of the child's owner. Null = unresolvable (unknown
 * session, not a subagent_child row, deleted, or no persisted parent) — the
 * caller must surface an honest error.
 */
export async function resolveSubagentOwner(
  input: ResolveSubagentOwnerInput,
): Promise<SubagentOwnerResolution | null> {
  let result: SessionsIndexReconcileResult;
  try {
    result = await input.reconcile({
      taskId: input.childSessionId,
      workspacePath: input.workspacePath,
      ...(input.workspaceIdentity ? { workspaceIdentity: input.workspaceIdentity } : {}),
      sessionIds: [input.childSessionId],
    });
  } catch {
    return null;
  }
  const row = result.sessions.find((session) => session.sessionId === input.childSessionId);
  if (!row || !row.exists || row.deleted) {
    return null;
  }
  // Task type proves the row is an agent-driven child; an id that merely LOOKS
  // like the convention must not be routed to some unrelated parent.
  if (row.taskType !== undefined && row.taskType !== "subagent_child") {
    return null;
  }
  const parentSessionId = row.parentSessionId;
  if (!parentSessionId || parentSessionId.length === 0) {
    return null;
  }
  return {
    agentId: input.agentId,
    childSessionId: input.childSessionId,
    parentSessionId,
  };
}

/** Honest failure for an order/stop whose child cannot be resolved fork-side. */
export function subagentSessionUnresolvedError(taskId: string, agentId: string): Error {
  return Object.assign(
    new Error(
      `subagent session ${taskId} (agentId=${agentId}) is not a persisted subagent_child with a parent — ` +
        "the order was NOT delivered (no fall-through to a parent conversation)",
    ),
    { code: "ZCODE_SUBAGENT_SESSION_UNRESOLVED" },
  );
}
