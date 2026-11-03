/* [fork] A4 — owner resolution for `sess_subagent_<agentId>` daemon targets.
 *
 * The child session id is already the real store id; what this resolver adds
 * is the OWNER (persisted `parent_id`) and the proofs that make delivery safe:
 * the row exists, is a `subagent_child`, and carries a parent. Nothing here
 * falls back to "use the parent session as if it were the child".
 */
import { describe, expect, it, vi } from "vitest";
import type { SessionsIndexReconcileResult } from "@zcode/shared/zcode-protocol-v4";
import {
  resolveSubagentOwner,
  subagentSessionUnresolvedError,
} from "../src/zcode-agent/subagentSessionRouting.js";

const CHILD = "sess_subagent_agent_e8222910-5324-4ca3-8095-58f949b7abbd";
const AGENT = "agent_e8222910-5324-4ca3-8095-58f949b7abbd";
const PARENT = "session_2d5c72a70ca658a9dc9c0f12689f8901";

function reconcileWith(
  row: Partial<Extract<SessionsIndexReconcileResult["sessions"][number], { exists: true }>> | null,
): (input: { sessionIds: string[] }) => Promise<SessionsIndexReconcileResult> {
  return async (input) => ({
    sessions: [
      row === null
        ? { sessionId: input.sessionIds[0]!, exists: false as const, deleted: false as const }
        : {
            sessionId: input.sessionIds[0]!,
            exists: true as const,
            deleted: false,
            title: "subagent",
            titleSource: "generated",
            createdAt: 1,
            updatedAt: 2,
            ...row,
          },
    ],
  });
}

describe("resolveSubagentOwner (A4)", () => {
  it("resolves a persisted subagent_child row to its parent session", async () => {
    const resolution = await resolveSubagentOwner({
      agentId: AGENT,
      childSessionId: CHILD,
      workspacePath: "/tmp/ws",
      reconcile: reconcileWith({
        parentSessionId: PARENT,
        taskType: "subagent_child",
      }) as never,
    });
    expect(resolution).toEqual({
      agentId: AGENT,
      childSessionId: CHILD,
      parentSessionId: PARENT,
    });
  });

  it("asks the store about exactly the child id (no id translation)", async () => {
    const reconcile = vi.fn(reconcileWith({ parentSessionId: PARENT, taskType: "subagent_child" }));
    await resolveSubagentOwner({
      agentId: AGENT,
      childSessionId: CHILD,
      workspacePath: "/tmp/ws",
      workspaceIdentity: "remote://box",
      reconcile: reconcile as never,
    });
    expect(reconcile).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionIds: [CHILD],
        workspacePath: "/tmp/ws",
        workspaceIdentity: "remote://box",
      }),
    );
  });

  it("returns null when the store does not know the session", async () => {
    const resolution = await resolveSubagentOwner({
      agentId: AGENT,
      childSessionId: CHILD,
      workspacePath: "/tmp/ws",
      reconcile: reconcileWith(null) as never,
    });
    expect(resolution).toBeNull();
  });

  it("returns null for a deleted row", async () => {
    const resolution = await resolveSubagentOwner({
      agentId: AGENT,
      childSessionId: CHILD,
      workspacePath: "/tmp/ws",
      reconcile: reconcileWith({ parentSessionId: PARENT, deleted: true }) as never,
    });
    expect(resolution).toBeNull();
  });

  it("returns null when the row is not a subagent_child (look-alike ids must not route)", async () => {
    const resolution = await resolveSubagentOwner({
      agentId: AGENT,
      childSessionId: CHILD,
      workspacePath: "/tmp/ws",
      reconcile: reconcileWith({ parentSessionId: PARENT, taskType: "interactive" }) as never,
    });
    expect(resolution).toBeNull();
  });

  it("returns null when the child has no persisted parent", async () => {
    const resolution = await resolveSubagentOwner({
      agentId: AGENT,
      childSessionId: CHILD,
      workspacePath: "/tmp/ws",
      reconcile: reconcileWith({ taskType: "subagent_child" }) as never,
    });
    expect(resolution).toBeNull();
  });

  it("returns null when the reconcile RPC itself fails (honest, not a crash)", async () => {
    const resolution = await resolveSubagentOwner({
      agentId: AGENT,
      childSessionId: CHILD,
      workspacePath: "/tmp/ws",
      reconcile: async () => {
        throw new Error("cli down");
      },
    });
    expect(resolution).toBeNull();
  });

  it("surfaces a coded honest error for an unresolvable target", () => {
    const error = subagentSessionUnresolvedError(CHILD, AGENT) as Error & { code: string };
    expect(error.code).toBe("ZCODE_SUBAGENT_SESSION_UNRESOLVED");
    expect(error.message).toContain(CHILD);
    expect(error.message).toContain(AGENT);
    expect(error.message).toContain("NOT delivered");
  });
});
