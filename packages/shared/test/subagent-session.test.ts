/* [fork] A4 — the subagent child-session convention. */
import { describe, expect, it } from "vitest";
import {
  SUBAGENT_SESSION_PREFIX,
  subagentAgentIdFromSessionId,
  subagentSessionIdFor,
} from "@zcode/shared";

describe("subagent session convention (A4)", () => {
  it("constructs the id the CLI session store uses (sess_subagent_<agentId>)", () => {
    const agentId = "agent_e8222910-5324-4ca3-8095-58f949b7abbd";
    expect(subagentSessionIdFor(agentId)).toBe(`sess_subagent_${agentId}`);
    expect(SUBAGENT_SESSION_PREFIX).toBe("sess_subagent_");
  });

  it("reads the agentId back from a child session id", () => {
    expect(
      subagentAgentIdFromSessionId("sess_subagent_agent_e8222910-5324-4ca3-8095-58f949b7abbd"),
    ).toBe("agent_e8222910-5324-4ca3-8095-58f949b7abbd");
  });

  it("round-trips an agentId", () => {
    const agentId = "agent_6bee6ea3-967c-448d-b59d-69b69aaab4c2";
    expect(subagentAgentIdFromSessionId(subagentSessionIdFor(agentId))).toBe(agentId);
  });

  it("returns null for every other id shape (main, fork, workflow children)", () => {
    expect(subagentAgentIdFromSessionId("sess_2d5c72a70ca658a9dc9c0f12689f8901")).toBeNull();
    expect(subagentAgentIdFromSessionId("session_2d5c72a70ca658a9dc9c0f12689f8901")).toBeNull();
    expect(subagentAgentIdFromSessionId("task-9")).toBeNull();
    expect(subagentAgentIdFromSessionId("")).toBeNull();
  });

  it("returns null for a prefix with no agentId (never routes an empty child)", () => {
    expect(subagentAgentIdFromSessionId(SUBAGENT_SESSION_PREFIX)).toBeNull();
  });
});
