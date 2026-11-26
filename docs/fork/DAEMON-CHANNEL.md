# B3a: "daemon local" channel — ADR and protocol spec

Date: 2026-10-29 · Status: implemented (`damian` branch) · Parent:
[ADR-022](https://github.com/) (`~/Projects/bot/docs/adr/022-live-mode-fork-channel.md`)

> This document is **the contract** for the daemon's Kotlin client (B3b).
> The normative TypeScript shapes live in
> `packages/shared/src/daemon-channel.ts` (exported by `@zcode/shared`); if
> this text and that file disagree, **the file wins** — and this text gets
> corrected. The protocol is additive: new fields are optional and old
> readers ignore them. Breaking compatibility requires a bump of
> `DAEMON_CHANNEL_PROTOCOL_VERSION`.

## 1. Context and decision

ADR-022: live mode is the default. The Kotlin bot talks to the app's REAL
conversation over a local unix socket — just like z.ai's official embedded bot,
which is a feature INSIDE the app (`packages/services/src/bots/`) — instead
of the zoo of sidecars/headless queue. This channel (B3a) is the fork-side
piece: it exposes inbound, a continuous stream and queries. Live/headless
routing is the daemon's problem (B3b), not the channel's.

**What was decided here:**

1. **The socket's owner is the Host (utility process)**, next to `BotsService`.
   Never the Electron main. The socket lives and dies with the host: if the
   host dies, the file is left orphaned and the next boot cleans it up; the
   daemon reconnects (retry belongs to the client — B3b).
2. **Transport**: unix socket at `~/.zcode/daemon-local.sock` (honors
   `ZCODE_DATA_BASE_DIR`), **JSONL** framing (one JSON object per line,
   UTF-8, `\n`), line ≤ 24 MiB.
3. **Mandatory auth** (parity-and-engineering.md §5): token in
   `~/.zcode/daemon-local.token` (mode 0600, 64 hex, **rotated on every host
   boot**). `hello` is the mandatory first line; without it, within 10 s the
   connection closes. Timing-safe comparison. The socket is also 0600 —
   only the user owning the session can even connect (defense in
   depth).
4. **The channel is one more bot in BotsService** — provider `"daemon"` in
   `botProviders` — with a **null** adapter: `handleInboundMessage` replies
   come back over the socket as the request's response
   (there is no provider `send`), and it does not take part in the private-sync
   of formatted replies (`privateSyncSupported` does not list it). It
   self-provisions **add-if-absent** in `bot-config.v3.json` (id `daemon-local`,
   providerUserId `daemon`, already "bound"): if Damian deletes or disables it
   from the Bots dialog, the decision persists — **that is the gate**
   ("gated like the other channels"). Emergency kill-switch:
   `ZCODE_DAEMON_LOCAL_CHANNEL=0`.
5. **Multiple windows/hosts**: the first live host wins the socket. If on
   boot the file exists and answers the probe, this host does NOT touch it
   (state `conflict`, warn in the log) — nor does it rotate the token, which
   belongs to the process that owns the socket.

## 2. Lifecycle and reconnection semantics

| Event | What happens |
| --- | --- |
| Host boots | new socket + token; bot provisioned if missing |
| Daemon connects | `hello` → `hello_ok` (or fatal error and close) |
| Host closes cleanly | `bye {reason:"host-shutdown"}` best-effort, close, unlink socket+token |
| Host dies abruptly | orphaned socket; the next boot detects it (probe) and replaces it; new token ⇒ old credential useless |
| Daemon drops | the host only sees `close`; its stream subscriptions die with the connection |

**In-flight (what B3b must assume):**

- `inbound` is **at-least-once** as seen from the daemon side: if the connection
  dies after the prompt entered the CommandInbox but before the
  response arrives, resending can duplicate it. Server-side mitigation: dedupe
  by `messageId` (TTL 2 min, parity with Telegram's offset window) —
  the duplicate answers `inbound_result {duplicate:true, replies:[]}` and does NOT
  resend the prompt. The daemon must still dedupe by its own
  `update_id` (same F2d doctrine as the Python bot).
- The stream is **continuous, with no replay**: events lost during a
  disconnection are NOT resent (red line in
  docs/zcode-agent-next-steps.md — never replayable on a bot channel). After
  reconnecting: re-`subscribe` + re-sync state with `taskSnapshot`.
  `seq` is monotonic per connection: if the daemon sees a jump, something was lost —
  resynchronize.
- Requests without a response (e.g. a `query` in flight when the link drops) are lost;
  they are idempotent, retry them without worry.
- `inbound_result` can arrive **much later** (the turn can take a while):
  correlate by `id`, do not block the daemon's pipeline waiting for it —
  the live render comes from the stream, not from the reply.

## 3. Protocol (v1)

### 3.1 Handshake

```json
→ {"type":"hello","protocolVersion":1,"token":"<64 hex>","clientId":"bot-kotlin"}
← {"type":"hello_ok","protocolVersion":1,
   "server":{"pid":1234,"startedAt":1761700000000,"appVersion":"3.16.2"},
   "bot":{"id":"daemon-local","enabled":true},
   "capabilities":["inbound","stream","queries:listTasks", ...]}
```

Handshake errors (all close the connection): `auth_failed`,
`unsupported_version` (with `supported:[1]`), `auth_timeout` (no hello within 10 s).
A later `hello` re-sends `hello_ok` (idempotent, useful as a health check).
`bot.enabled:false` means the gate is closed: inbound requests will return
the "bot disabled" reply.

### 3.2 Inbound — free text on the SAME path as the composer

```json
→ {"type":"inbound","id":"r1","text":"fix the login","messageId":"tg-1001",
   "attachments":[{"id":"a1","kind":"image","filename":"photo.png",
                   "mimeType":"image/png","dataBase64":"..."}],
   "receivedAt":1761700000123}
← {"type":"inbound_result","id":"r1","replies":[{"text":"..."}]}
```

- It goes through `BotsService.handleInboundMessage` with actor
  `{provider:"daemon", botId:"daemon-local", providerUserId:"daemon",
  chatType:"private"}` ⇒ the SAME composer pipeline: draft/task,
  deleted-task tombstone, `sendPrompt` → V4 `sendText` → CommandInbox.
  A running task rejects with the "task running" reply (same rule
  as the official bot).
- Optional `commandText` overrides command detection (text that starts
  with `/` but is not a botsService command). The `/commands` that the
  botsService understands (`/stop`, `/new`, `/status`, `/model`, `/approve`,
  `/deny`, `/bind`...) work as-is — **but they belong to the botsService**;
  the Telegram bot's commands (`/task`, `/deploy`, `/brain`...) are
  resolved by the daemon (B3b) and must NEVER be forwarded as text.
- `attachments`: ≤ 4 × 5 MiB (the botsService limit), `dataBase64` or
  `localPath` (absolute, readable by the host). The service materializes them
  in `bot-attachments/` — never in the workspace.
- Replies: `{text, locale?, selection?, elicitation?}` — what the daemon
  would show as a system bubble (notices, questions, keyboards).

### 3.3 Continuous stream — bot-channel-continuous

```json
→ {"type":"subscribe","id":"s1","taskId":"task-9",
   "workspacePath":"/Users/damian/Projects/app"}
← {"type":"subscribed","id":"s1","taskId":"task-9"}
← {"type":"stream_event","taskId":"task-9","seq":1,"at":1761700004567,
   "event":{"type":"agent_thought_chunk","taskId":"task-9","traceId":"...",
            "parentToolUseId":null,"content":"I think that..."}}
→ {"type":"unsubscribe","id":"u1","taskId":"task-9"}
← {"type":"unsubscribed","id":"u1","taskId":"task-9"}
```

Subscribes via `onDynamicTaskEvent(deliveryKind:"bot-channel-continuous")` —
**the same delivery as the embedded bot**, which at the agent level projects as
`desktop-continuous` (zcodeTaskServiceAdapter.toZCodeDeliveryKind): deltas
included, no replayable filtering. Re-subscribing to the same task replaces the
subscription. `at` = host receive time (epoch ms) — V4 events
carry no timestamp of their own.

**Which events arrive and how to compute accumulated progress (the owner's MVP:
"if it is writing, the lines grow; if it is thinking, the chars grow,
all of them with their timer"):**

| The daemon sees (ZCodeStreamEvent.type) | Comes from | Daemon counter |
| --- | --- | --- |
| `agent_thought_chunk` (`content` delta, `parentToolUseId`) | model reasoning_delta | thinking chars += `content.length` (per agent: `parentToolUseId` null = main) |
| `agent_message_chunk` (`content` delta) | text_delta | text chars += length |
| `tool_call` (implicit status pending, `toolName`, `input:{}`) | `tool_input_start` | opens the tool box: name = `toolName`, timer from `at` |
| `tool_call_update` status `pending` + partial `input` | `tool_input_delta` (projected with ~1 s sampling and budget) | written lines = line count of `input.content` (Write) / `input.new_string` (Edit); raw chars = `raw.streamingRawInputLength` |
| final `tool_call` | model `tool_call` | full input (authority) |
| `tool_call_update` status `completed/failed/denied/stopped` + `content` | tool execution | closes the box; output in `content` |
| `task_run_started` | turn/input start | starts the turn timer |
| `task_complete` (`stopReason`, `usage`), `task_error` | turn end | seals boxes, emits the result |
| `permission_request` / `elicitation_request` (+ their responses) | blocks | 🔐/❓ of the MVP; response via `/approve` `/deny` or `/elicitation` as inbound |
| `usage_update`, `session_info_update`, `task_network_debug_status`, … | the rest of the `ZCodeStreamEvent` union | /usage, /ctx, zconn episodes (parity §1) |

Live subagents: the SAME stream; every chunk/tool call carries
`parentToolUseId` (the id of the parent `Task` tool call). Grouping by that id =
per-agent boxes. At the task-list level, a task's parent is
`forkedFromTaskId` (see the `taskList` query).

**Documented gaps** (today only in the live-io sidecar): none. The
`live-io-*.jsonl` sidecar becomes obsolete for the daemon in live mode: CoT
(`agent_thought_chunk`) and tool-args (`tool_input_*` → projection
`tool_call[_update]`, with `toolName` and `raw.streamingRawInputLength`) travel
over the channel. The only loss vs the sidecar: the sidecar carried the COMPLETE
raw tool-input; the projection publishes the best-effort parsed input
+ the LENGTH of the raw (enough for counters; the full input
arrives with the final `tool_call`).

**Heartbeat ("never radio silence"): a design decision.** The channel does NOT
manufacture synthetic heartbeats on the stream. The daemon: (a) ticks its
spinner/timer locally (it is presentation state — the Python's blinking
line always ticked locally), (b) uses `ping`→`pong {at}` (every ~30 s)
as a channel health check — it distinguishes "channel healthy but the model is not
emitting" from "channel dead". Reasons: the stream must reflect EXACTLY what
the desktop renders (a second series of synthetic events would create
its own dialect and break desktop/daemon parity — lesson 4.5
of the map); and a `tool_input_delta` already carries ~1 s sampling from the agent.

### 3.4 Queries and control ops

```json
→ {"type":"query","id":"q1","query":{"kind":"quota"}}
← {"type":"query_result","id":"q1","result":{ ...UsageEntitlementSnapshot... }}
```

| `query.kind` | Fork service | Bot command |
| --- | --- | --- |
| `listTasks {workspacePath, workspaceIdentity?}` | `listTasks` → `ZCodeTaskMeta[]` | `/task` (focused) |
| `taskList {listKind: pinned\|archived\|timeline\|active, workspaceScopes[], sortBy?, search?, limit?}` | `listTaskList` (global, with `forkedFromTaskId` for parents) | `/all_tasks`, search |
| `activeTaskIds {workspacePath}` | `listActiveTaskIds` — what runs NOW (sessions-index, not tasks-index) | `/status` ("what is running") |
| `taskMeta {taskId, workspacePath?}` | `getTaskMeta` (fallback: the bot's context) | titles/`how long ago` (`updatedAt`) |
| `taskSnapshot {taskId, messageLimit?, ...}` | `getTaskSnapshot` | resync after reconnect, `/cot` (history) |
| `taskUsage {taskId, workspacePath?}` | `getTaskTokenUsage` | `/usage` `/ctx` |
| `quota {invalidateBalanceCache?}` | `IUsageStatsService.getEntitlementSnapshot` (5h pool, `remaining.percentage`, `nextResetTime`) | `/quota` |
| `botStatus {}` | bot daemon: config + context (active workspace, mode, activeTaskId, pendings) | the channel's `/status` |
| `modelSelection {workspacePath?, workspaceIdentity?}` | `botsService.getBotModelSelection` — the conversation's current selection (plan/model/effort) + global default + registry plans | `/plan` (read) |
| `setModelSelection {scope: conversation\|default, workspacePath?, workspaceIdentity?, plan?, model?, effort?}` | scope `conversation` → `botsService.setBotModelSelection` (draft: `writeDraftOptions`; task: `setModel`/`setConfigOption` — the SAME write path as /model and /effort); scope `default` → `NodeModelSelectionConfigRepository.saveConfiguredDefault` (the app's global default, effort completed with the model's max tier) | `/plan` (change) |
| `stop {taskId, workspacePath?, runId?}` | `stopGeneration` — the SAME V4 stop as the UI button (owner/lease/stale-run protection on the service side) | `/stop` |
| `stopAll {workspacePath?}` | `listActiveTaskIds` × `stopGeneration` | first half of `/nuclear` |
| `compact {taskId, instructions?, expectedRevision?}` | `compactSession` | `/compact` |
| `setMode {taskId, mode}` | `setMode` → v4 `switchCollaborationMode` (same revision convergence as the UI switch) | `/mode`: `mode` ∈ `build\|edit\|plan\|yolo\|guarded` (`DAEMON_CHANNEL_MODES`); an unknown mode is rejected `bad_request` — never a silent downgrade to build |

**Steerable subagents (A4, additive 2026-11-02).** `inbound`/`steer` with
`taskId = sess_subagent_<agentId>` and `stop` with that same taskId no longer
bounce with `proto.sessionNotFound`: the fork parses the convention
(`packages/shared/src/subagent-session.ts`), resolves the OWNING session through the
child's persisted row (`parentSessionId` in the sessions-index reconcile) and
delivers through the owner's runtime registry —
`sendSubagentMessage` for the order (running → steer/queue, terminal →
resume in background: the SAME port as the SendMessage tool) and
`cancelBackgroundWork` for the ⏹️ (workId ≡ agentId; `not_running` =
honest no-op). An unresolvable child is rejected with
`ZCODE_SUBAGENT_SESSION_UNRESOLVED` — it **never** falls back to the parent's
conversation. Announced capability: `subagents`. Detail: `docs/fork-interface-map.md` §2.

`stop`/`stopAll` interrupt the VISIBLE turn — the one the screen shows.
The other half of `/nuclear` (restarting the bot stack, LaunchAgents, etc.)
belongs to the daemon and NEVER to the channel: the channel does not kill app
processes (the golden rule of 2026-10-13 — the headless bot never kills its host;
⌘Q is still Damian's gesture). There is no "restart app" service op today nor is
one needed for the MVP; if B4 asks for it, it is added as a new fork-side query.

Errors: `unknown_query` (invalid kind), `internal` (execution failed,
`message` with the detail), `bad_request` (params). Without `usageStatsService`
available, `quota` resolves to `internal` with an explicit message.

### 3.5 Other frames

`ping`→`pong {id, at}` (health check). `error {id?, code, message?, fatal?}`:
`fatal:true` = the server closes afterwards. Line errors (invalid JSON)
do NOT close the connection; violated protocols (no hello, giant line)
do.

## 4. Implementation (reference)

- `packages/services/src/bots/daemonChannel.ts` — the server: socket, auth,
  dispatch, dedupe, subscriptions, queries. `createDaemonLocalChannel()`.
- `packages/services/src/node.ts` — Host wiring: creates the channel with the
  SAME `BotsService` instance registered in the collection (+ task
  service + usage stats), starts it unless `isDesktopAttachedRemote`, and
  disposes it in `disposeServiceResources[AndWait]`.
- `packages/shared/src/daemon-channel.ts` — contract (constants + types).
- `packages/shared/src/bots.ts` — `botProviders` += `"daemon"`.
- `packages/services/src/bots/botsService.ts` — providers registry:
  `daemon: null`.
- UI: `bots.channel.daemon` labels (en-US/zh-CN) so the provisioned bot
  shows a name in the Bots dialog (and its toggle is the
  visible gate).
- Tests: `packages/services/test/daemonChannel.test.ts` (hermetic: real socket
  in a tmpdir, real token, zero network, zero `~/.zcode`).

## 5. Deploy

The repo pipeline (`pnpm typecheck` + `pnpm lint` + affected vitest) and the
fork's standard deploy. **Do not run `build-install.nu` from the agent**
(it restarts the app Damian is using). Command for when Damian can:

```
cd /Users/lattenero/Projects/ZCode && git pull --ff-only origin damian && \
  pnpm typecheck && pnpm lint && \
  npx vitest run packages/services/test/daemonChannel.test.ts && \
  scripts/build-install.nu --yes   # Damian presses ⌘Q when told
```

Post-swap verification (`scripts/verify-deploy.nu` PASS) + manual handshake:

```
TOKEN=$(cat ~/.zcode/daemon-local.token)
printf '{"type":"hello","protocolVersion":1,"token":"%s","clientId":"smoke"}\n' "$TOKEN" \
  | nc -U ~/.zcode/daemon-local.sock | head -1      # → {"type":"hello_ok",...}
```

Rollback: any earlier fork build simply lacks the channel —
the daemon sees `ECONNREFUSED`/a missing file and degrades (the Kotlin bot
must treat "no socket" as automatic headless mode, not as an error).
