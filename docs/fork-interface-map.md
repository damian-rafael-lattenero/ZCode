# Fork interface map

The surface the fork adds on top of upstream ZCode, and the contract each
surface carries. This file is the index: normative shapes live in
`packages/shared/src/` (and win over prose), the operational spec for the
daemon channel lives in [`fork/DAEMON-CHANNEL.md`](./fork/DAEMON-CHANNEL.md),
and the architecture map in [`fork/ARCHITECTURE.md`](./fork/ARCHITECTURE.md).

Everything here is **additive**: new optional fields, new frames on the
daemon channel, new native v4 commands. Existing consumers keep working; a
surface is only removed together with its upstream counterpart.

## 1. Daemon-local channel (`~/.zcode/daemon-local.sock`)

The single read/write path between the Kotlin Telegram daemon and the real
conversation (ADR-022). Server: `packages/services/src/bots/daemonChannel.ts`.
Shapes: `packages/shared/src/daemon-channel.ts`. Frame loop: JSONL, one
object per line, `hello` first, token in `~/.zcode/daemon-local.token`.

### 1.1 Client → server frames

| Frame | Shape | What it does |
| --- | --- | --- |
| `hello` | `{protocolVersion, token, clientId?}` | Authenticates; answer is `hello_ok` + capabilities. |
| `inbound` | `{text, messageId?, commandText?, attachments?, receivedAt?, taskId?, bindTaskId?}` | Free text into the conversation. `bindTaskId` binds first (the `/task` law, refusals in `inbound_result.replies`); `taskId` sends the text DIRECT to that session (`sendPrompt`). |
| `respond` | `{taskId, requestId, kind: permission\|elicitation\|plan, optionId?, response?, action?, content?, messageId?}` | The owner answers a pending permission/elicitation/plan from the phone. Dedupe by `messageId`. |
| `steer` | `{taskId, text}` | Redirects a RUNNING turn (delivery `guide`): injected inside the live turn at the next tool boundary; idle starts a normal turn. |
| `subscribe` / `unsubscribe` | `{taskId, workspacePath, workspaceIdentity?}` | Continuous stream (`bot-channel-continuous`) for a task; `stream_event`/`stream_keepalive` frames carry `seq`. |
| `query` | `{kind: string, ...}` | See queries below. Answer: `query_result {id, result}` or `error`. |
| `ping` | `{id}` | Health check; `pong {id, at}`. |

### 1.2 Queries and control ops

| `query.kind` | Service call | Notes |
| --- | --- | --- |
| `listTasks`, `taskList`, `activeTaskIds`, `taskMeta`, `taskSnapshot`, `taskUsage` | task index / snapshots | `/task`, `/status`, `/cot`, `/usage`. |
| `quota` | `IUsageStatsService.getEntitlementSnapshot` | `taskId?` selects the conversation's provider (dynamic account access). |
| `botStatus` | bot config + context | `/status` of the channel. |
| `modelSelection`, `setModelSelection` | `botsService` model selection | `/plan`; `setModelSelection` writes the conversation/config default. |
| `contextWindow` | task snapshot `runtime.contextUsage` | Real meter, registry window precedence. |
| `stop`, `stopAll` | `stopGeneration` | ⏹️. `taskId` may be a subagent id (see 2.1). |
| `compact` | `compactSession` | `/compact`. |

### 1.3 Capabilities announced in `hello_ok`

`inbound`, `bind`, `subagents`, `stream`, `queries:*`, `control:*`, `respond`.
`bind` = `inbound.bindTaskId` (atomic binding + `/task` law). `subagents` =
`inbound`/`steer`/`stop` accept `sess_subagent_<agentId>` targets (section 2).

## 2. Subagent child sessions (A4)

**The convention.** The CLI stores a background subagent's child session as
`sess_subagent_<agentId>` (`createSessionId("subagent_" + agentId)` in
`apps/zcode-cli/packages/core/src/subagent/runner.ts`). The harness `agentId`
arrives in the Agent/Task launch ACK and is projected once as
`tool_call_update.subagentAgentId`
(`packages/shared/src/zcode-task-types-core.ts`). The parser lives in
`packages/shared/src/subagent-session.ts` (`subagentAgentIdFromSessionId`,
`subagentSessionIdFor`, `SUBAGENT_SESSION_PREFIX`).

**Why a child cannot be written directly.** A running child owns no v4
session record (`sessionExists` is false → the inbox rejects with
`proto.sessionNotFound`), and even a cold child is read-only for input
admission (`guard.subagentReadOnly`; `subagent_child` sessions are driven by
their parent). Cold-resuming a running child would materialise a second
runtime over the same event log — explicitly forbidden. The owner session's
runtime task registry is the only live door: it is what the model's
`SendMessage` tool uses.

**Resolution (fork side).** `packages/services/src/zcode-agent/subagentSessionRouting.ts`:
parse the id → read the child's persisted row through the sessions-index
reconcile RPC (the child's `parentSessionId` + `taskType=subagent_child`
travel on that read, additive) → return the OWNER session id. Unresolvable
(unknown/deleted/not a subagent_child/no parent) → honest error
`ZCODE_SUBAGENT_SESSION_UNRESOLVED`; never a fall-through to the parent
conversation.

### 2.1 Orders and stops

| Daemon frame | Fork routing | CLI command |
| --- | --- | --- |
| `inbound {taskId: "sess_subagent_<agentId>", text}` | `sendPrompt` → resolve owner → deliver | v4 `sendSubagentMessage {agentId, text}` against the OWNER session |
| `steer {taskId: "sess_subagent_<agentId>", text}` | same as inbound (guide semantics ride inside the child) | v4 `sendSubagentMessage` |
| `query {kind: "stop", taskId: "sess_subagent_<agentId>"}` | `stopGeneration` → resolve owner → cancel that child | v4 `cancelBackgroundWork {workId: agentId}` against the OWNER session |

`sendSubagentMessage` is a native v4 command
(`apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/commands/handlers/subagent-message.ts`):
it calls the owner app's `sendSubagentMessage` → the runtime's
`subagentPort.sendMessage` — the same port as the `SendMessage` tool, so a
running child is steered/queued and a terminal child resumes in the
background. Rejections carry
`fault.command.subagentMessageRejected.<reason>`. `cancelBackgroundWork`
with `not_running` is treated as an honest no-op (nothing left to stop).

## 3. Live-io sidecars (bot telemetry)

`<workspace>/.zcode/live-io-<session>.jsonl` — reasoning deltas, text deltas
and tool-argument composition, flushed mid-request (≤1/s). Fields are
schema-additive (`toolName`, `toolChars`, `toolTail` since F81b). The daemon
channel's continuous stream supersedes this for the Kotlin daemon; the
sidecar remains the file-based tap.

## 4. Chat surface additions

`model:` frontmatter per custom command (`packages/shared/src/command-types.ts`
+ `packages/services/src/commands/commandFileParser.ts`), client-side `/diff`
into the Diff Ask plugin, and plugin recommendations injected in the
side-pane grid. HISTORICAL detail lives in `FORK.md`.

## 5. Native v4 commands added by the fork

| Command | Envelope `sessionId` | Payload | Purpose |
| --- | --- | --- | --- |
| `sendSubagentMessage` | owner (parent) session | `{agentId, text, summary?}` | Deliver a message to a local subagent (2.1). |

All other v4 commands are upstream. Command payloads are validated by
`commandPayloadSchemas` in `packages/shared/src/zcode-protocol-v4/command.ts`.
