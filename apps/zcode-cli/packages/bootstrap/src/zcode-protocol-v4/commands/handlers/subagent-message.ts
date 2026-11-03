// [fork] A4 — sendSubagentMessage: the protocol door to a LOCAL SUBAGENT.
//
// Why a command of its own: a background subagent's child session
// (`sess_subagent_<agentId>`, the CLI store convention) has NO session record
// of its own — running children deliberately own no bootstrap record, and the
// input-admission law keeps subagent sessions read-only
// (`guard.subagentReadOnly`). Addressing the child directly with sendText can
// only ever produce `proto.sessionNotFound` / `guard.subagentReadOnly`.
//
// The supported owner of a child is its PARENT session's runtime task
// registry: the same `subagentPort.sendMessage` the model's SendMessage tool
// uses (running child → steered/queued; terminal child → resumed in the
// background). So the envelope addresses the parent (`envelope.sessionId`)
// and this handler forwards the text to `record.app.sendSubagentMessage`,
// which walks the exact same port the tool does.
//
// Failure is never a fake ok: an unknown/closed agent rejects the ACK with
// `fault.command.subagentMessageRejected.<reason>`; a runtime without the
// capability → capabilityUnsupported (same class as cancelBackgroundWork).
import type {
  CommandEnvelope,
  CommandPayloadMap,
  CommandResult,
} from "@zcode/shared/zcode-protocol-v4";
import { V4CapabilityUnsupportedError } from "./interaction-background.js";
import { requireRecord } from "../record-access.js";
import type { V4CommandCoreHost } from "../types.js";

/** Rejection prefix vocabulary: `fault.command.subagentMessageRejected.<reason>`. */
export const SUBAGENT_MESSAGE_REJECTED_FAULT_PREFIX = "fault.command.subagentMessageRejected.";

export class V4SubagentMessageRejectedError extends Error {
  readonly reasonCode: string;
  constructor(reason: string, agentId: string, detail?: string) {
    super(detail ?? `subagent ${agentId} could not be reached: ${reason}`);
    this.name = "V4SubagentMessageRejectedError";
    this.reasonCode = `${SUBAGENT_MESSAGE_REJECTED_FAULT_PREFIX}${reason}`;
  }
}

async function sendSubagentMessage(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["sendSubagentMessage"];
  const record = requireRecord(host, envelope.sessionId);
  if (!record.app.sendSubagentMessage) {
    throw new V4CapabilityUnsupportedError("sendSubagentMessage", record.app.sessionId);
  }
  const result = await record.app.sendSubagentMessage({
    to: payload.agentId,
    message: payload.text,
    ...(payload.summary ? { summary: payload.summary } : {}),
  });
  if (result.status !== "success") {
    // The port's error text is the authoritative reason ("No active local_agent
    // task found for target ...", resume failures, ...); carry it verbatim and
    // let the reasonCode carry the class for clients that branch structurally.
    const reason = result.error?.trim().length ? result.error.trim() : "not_found";
    throw new V4SubagentMessageRejectedError(reason, payload.agentId, result.error);
  }
  return undefined;
}

export const subagentMessageHandlers = { sendSubagentMessage };
