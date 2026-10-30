import { describe, expect, it } from "vitest";

import { subagentAgentIdFromLaunchAck } from "../src/zcode-agent/zcodeTaskServiceAdapter.js";

/**
 * The dispatch lane → child session link: the launch ACK's agentId is the
 * ONLY real join key (the CLI stores the child session as
 * `sess_subagent_<agentId>` — the bot constructs + verifies against its
 * own read of that store). Every ACK format from legacy to current must
 * yield the id; the oldest backgroundTaskId one honestly yields null.
 */
describe("subagentAgentIdFromLaunchAck", () => {
  it("parses the current ACK format", () => {
    const ack =
      "Async agent launched successfully.\nagentId: agent_419b5d75-bcf3-4343-9b9f-64c718249330\n" +
      "The agent is working in the background. You will be notified automatically when it completes";
    expect(subagentAgentIdFromLaunchAck("Task", { content: ack })).toBe(
      "agent_419b5d75-bcf3-4343-9b9f-64c718249330",
    );
  });

  it("parses the previous ACK format", () => {
    const ack =
      "Agent agent_183d46e5-8e28-4c53-badf-bf9937897ed8 started in background.\n" +
      "agentId: agent_183d46e5-8e28-4c53-badf-bf9937897ed8\noutputFile: /tmp/out\n" +
      "You will be notified when the Agent completes.";
    expect(subagentAgentIdFromLaunchAck("Agent", { content: ack })).toBe(
      "agent_183d46e5-8e28-4c53-badf-bf9937897ed8",
    );
  });

  it("parses a JSON-shaped launch result", () => {
    const result = {
      content: JSON.stringify({
        status: "async_launched",
        agentId: "agent_b7dae601-cacf-42f5-bcbb-6d2f0c676495",
        outputFile: "/tmp/out",
      }),
    };
    expect(subagentAgentIdFromLaunchAck("Task", result)).toBe(
      "agent_b7dae601-cacf-42f5-bcbb-6d2f0c676495",
    );
  });

  it("yields null for a plain completed tool result", () => {
    expect(subagentAgentIdFromLaunchAck("Task", { content: "done" })).toBeNull();
  });

  it("yields null for the legacy backgroundTaskId ACK (no agentId in it)", () => {
    const legacy =
      "backgroundTaskId: bg-123\nRuntime will wait for this background Agent to finish before continuing the turn.";
    expect(subagentAgentIdFromLaunchAck("Task", { content: legacy })).toBeNull();
  });
});
