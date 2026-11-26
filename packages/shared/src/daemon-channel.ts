/* [fork] B3a — "daemon local" channel (ADR-022).
 * Line contract for the unix socket that exposes handleInboundMessage, the
 * bot-channel-continuous stream and the service queries to the bot's Kotlin
 * daemon. The full narrative spec (auth, reconnection semantics, at-least-once)
 * lives in docs/fork/DAEMON-CHANNEL.md; these types are the normative source of
 * the shapes. The protocol is additive: new fields are optional and old
 * readers ignore them; breaking compatibility requires a bump of
 * DAEMON_CHANNEL_PROTOCOL_VERSION.
 */
import type { ZCodeStreamEvent } from "./zcode-task-types-core.js";
import type { ZCodePermissionResponse } from "./zcode-protocol-legacy-types.js";

export const DAEMON_CHANNEL_PROTOCOL_VERSION = 1;

/** Paths relative to the data root (~/.zcode by default). */
export const DAEMON_CHANNEL_SOCKET_FILENAME = "daemon-local.sock";
export const DAEMON_CHANNEL_TOKEN_FILENAME = "daemon-local.token";
/** The token and the socket are created 0600: only the owning user can talk. */
export const DAEMON_CHANNEL_FILE_MODE = 0o600;
/** Limit of one JSONL line (attachments travel base64 inside the frame). */
export const DAEMON_CHANNEL_MAX_LINE_BYTES = 24 * 1024 * 1024;
/** The hello must arrive on the first line, inside this window. */
export const DAEMON_CHANNEL_HANDSHAKE_TIMEOUT_MS = 10_000;
/** Inbound dedupe window by messageId (parity with Telegram's offset). */
export const DAEMON_CHANNEL_INBOUND_DEDUPE_TTL_MS = 2 * 60_000;

/**
 * Continuous-stream heartbeat interval (stream_keepalive). 15s leaves a
 * 4× margin under the consumer's 60s watchdog (the bot re-subscribes after
 * 60s of raw silence; with the heartbeat it keys on "3+ intervals without frames").
 */
export const DAEMON_CHANNEL_STREAM_KEEPALIVE_INTERVAL_MS = 15_000;

/** Synthetic provider for the channel: one more bot entry in bot-config.v3.json. */
export const DAEMON_CHANNEL_PROVIDER = "daemon";
export const DAEMON_CHANNEL_DEFAULT_BOT_ID = "daemon-local";
export const DAEMON_CHANNEL_PROVIDER_USER_ID = "daemon";

// ---- client → server ---------------------------------------------------------

export interface DaemonChannelHelloRequest {
  type: "hello";
  protocolVersion: number;
  token: string;
  clientId?: string;
}

export interface DaemonChannelInboundAttachment {
  id: string;
  kind: "image" | "audio" | "video" | "file";
  filename: string;
  mimeType: string;
  sizeBytes?: number;
  /** Embedded content (the service materializes it in bot-attachments/). */
  dataBase64?: string;
  /** Absolute path readable by the host; preferred over dataBase64 when present. */
  localPath?: string;
}

export interface DaemonChannelInboundRequest {
  type: "inbound";
  id: string;
  /** Free text as it would go to the composer; botsService parses the /commands. */
  text: string;
  /** Overrides command detection (text that starts with "/" but is not a command). */
  commandText?: string;
  /** Stable id of the source update (e.g. Telegram's update_id) for dedupe. */
  messageId?: string;
  attachments?: DaemonChannelInboundAttachment[];
  receivedAt?: number;
  /**
   * DESTINATION session for the text (additive, 2026-10-30): present → the channel sends the
   * prompt DIRECT to that task (sendPrompt) instead of going through the botsService — it is the
   * owner's ORDER to an attached subagent; the response comes back over the
   * session's stream (the attached card shows it). Absent → the
   * usual routing (the bound conversation).
   */
  taskId?: string;
  /**
   * THE ATOMIC BIND (additive, 2026-11-02): present → the bot's context is
   * pointed FIRST at that task (the SAME /task command law — the
   * project/fixed-cwd boundary and the taskRunning verdict included)
   * and the text flies afterwards over the usual routing. The refusal travels
   * as the single inbound_result reply ("taskRunning" / "Task not
   * found") — the same verdict the bot's sendInboundAwait already knows how to
   * read; the text is NOT delivered if the bind fails. Incompatible with
   * taskId (the order wins); old readers ignore it.
   */
  bindTaskId?: string;
}

export interface DaemonChannelSubscribeRequest {
  type: "subscribe";
  id: string;
  taskId: string;
  workspacePath: string;
  workspaceIdentity?: string;
}

export interface DaemonChannelUnsubscribeRequest {
  type: "unsubscribe";
  id: string;
  taskId: string;
}

export interface DaemonChannelTaskListQuery {
  kind: "taskList";
  listKind: "pinned" | "archived" | "timeline" | "active";
  workspaceScopes: Array<{
    workspacePath: string;
    workspaceIdentity?: string;
  }>;
  sortBy?: "created" | "updated";
  search?: string;
  limit?: number;
}

export type DaemonChannelQuery =
  | { kind: "listTasks"; workspacePath: string; workspaceIdentity?: string }  | DaemonChannelTaskListQuery
  | { kind: "activeTaskIds"; workspacePath: string; workspaceIdentity?: string }
  | {
      kind: "taskMeta";
      taskId: string;
      workspacePath?: string;
      workspaceIdentity?: string;
    }
  | {
      kind: "taskSnapshot";
      taskId: string;
      workspacePath?: string;
      workspaceIdentity?: string;
      messageLimit?: number;
      byteBudget?: number;
      toolLimit?: number;
    }
  | {
      kind: "taskUsage";
      taskId: string;
      workspacePath?: string;
      workspaceIdentity?: string;
    }
  | {
      kind: "quota";
      invalidateBalanceCache?: boolean;
      /**
       * The bot's active conversation (additive, 2026-10-30): its model
       * selection yields the providerId → the accountAccess hint
       * ({mode: start-plan | individual-coding-plan}) that makes the
       * provider resolve the real DYNAMIC access at the edge — without it the
       * Start Plan path never enters and the answer is the lying
       * not_configured (measured live 2026-10-30).
       */
      taskId?: string;
      /**
       * [fork] The plan whose quota is being read (additive, 11/11): the
       * bot's /plan rows show the quota OF EACH PLAN, not just the active
       * one. Present → the accountAccess hint comes from THIS providerId
       * and the taskId is no longer consulted; absent → the usual
       * behavior. Advertised with the queries:quotaProvider capability —
       * an old host ignores the field and answers the ACTIVE plan, and
       * the bot (which reads the caps) never asks per-plan, so no row
       * can ever show another plan's quota.
       */
      providerId?: string;
    }
  | { kind: "botStatus" }
  | {
      kind: "modelSelection";
      workspacePath?: string;
      workspaceIdentity?: string;
    }
  | {
      kind: "setModelSelection";
      /** "conversation" = the bot's focused conversation; "default" = the app's global default. */
      scope: "conversation" | "default";
      workspacePath?: string;
      workspaceIdentity?: string;
      /** Plan = account providerId (e.g. account:zai-individual-coding-plan). */
      plan?: string;
      /** modelId within the plan. */
      model?: string;
      /** Reasoning level ("effort"). */
      effort?: string;
    }
  | {
      kind: "stop";
      taskId: string;
      workspacePath?: string;
      workspaceIdentity?: string;
      runId?: string;
    }
  | { kind: "stopAll"; workspacePath?: string; workspaceIdentity?: string }
  | {
      kind: "compact";
      taskId: string;
      workspacePath?: string;
      workspaceIdentity?: string;
      instructions?: string;
      expectedRevision?: number;
    }
  | {
      /**
       * setMode (additive, 2026-11-02 — the bot's /mode: plan 🗺 / yolo 🔓).
       * Changes the conversation's collaboration MODE through the SAME path
       * as the UI switch (v4 switchCollaborationMode, with revision
       * convergence). A mode outside `DAEMON_CHANNEL_MODES` or an unknown
       * task is rejected honestly (error, never a silent downgrade).
       */
      kind: "setMode";
      taskId: string;
      /** Only the modes the user can change (same set as the UI). */
      mode: (typeof DAEMON_CHANNEL_MODES)[number];
      workspacePath?: string;
      workspaceIdentity?: string;
    }
  | {
      /**
       * [fork] backgroundTurn (additive, 14/11 — "go to background" from the
       * phone): demote of the RUNNING primaryTurn (the same v4
       * `backgroundTurn` command the desktop composer button sends). The turn
       * keeps executing — the model stream and any in-flight tool are NEVER
       * aborted — it only stops being the foreground owner of the session.
       * Non-CAS: `expectedForegroundExecutionId` is the stop-style courtesy
       * guard (mismatch/idle → noop ACK). Success mirrors `stop`:
       * `{ backgrounded: ["<taskId>"] }`; a noop answers
       * `{ backgrounded: [], reasonCode: "<ack.reasonCode>" }` (e.g.
       * "guard.stopTargetChanged"). Old servers answer `unknown_query`.
       */
      kind: "backgroundTurn";
      taskId: string;
      /** Foreground execution identity observed by the caller (stop-style guard). */
      expectedForegroundExecutionId?: string;
      workspacePath?: string;
      workspaceIdentity?: string;
    }
  | {
      /**
       * [fork] backgroundToolCall (additive, 16/11 — per-tool "go to
       * background" from the phone): move ONE running tool call to the
       * background (the same v4 `backgroundToolCall` command the desktop tool
       * cards send). Different granularity from `backgroundTurn`: the tool
       * call resolves at once with a synthetic result so the model continues
       * in the same turn, while the execution itself keeps running. Today the
       * runtime answers for foreground Bash calls and for in-flight Agent
       * (subagent) calls addressed by their parent toolCallId.
       * Non-CAS. Success mirrors the demote's wire shape but names the tool
       * call: `{ backgrounded: ["<toolCallId>"] }`; a noop answers
       * `{ backgrounded: [], reasonCode: "<ack.reasonCode>" }` (e.g.
       * "guard.stopTargetChanged"). Old servers answer `unknown_query`.
       */
      kind: "backgroundToolCall";
      taskId: string;
      /** The running tool call to hand off (Agent: the parent Agent/Task call). */
      toolCallId: string;
      workspacePath?: string;
      workspaceIdentity?: string;
    }
  | {
      kind: "contextWindow";
      taskId: string;
      workspacePath?: string;
      workspaceIdentity?: string;
    }
  | {
      /**
       * codingPlanGifts (additive, 2026-11-03 — the bot's /quota 🎁): READ
       * of the two gift surfaces that already exist in the services —
       * the already-granted quota resets (status) and the claimable offers
       * (preview). taskId is optional but recommended: its model selection
       * yields the accountAccess that resolves the coding plan's real account;
       * without a plan account, the host tries the app's plan and the
       * registry. It NEVER calls /opportunity (a server-side quota mutation).
       */
      kind: "codingPlanGifts";
      taskId?: string;
    }
  | {
      /**
       * useCodingPlanReset (additive, 2026-11-03 — the bot's 🎁 with confirmation):
       * spends ONE already-granted reset (POST /coding-plan/reset/use). It is
       * IRREVERSIBLE and carries an idempotency key: the client sends the key and a
       * retry of the same key does not consume twice. A resetType outside
       * FIVE_HOUR|WEEK and empty or >64 keys are rejected at the edge.
       */
      kind: "useCodingPlanReset";
      taskId?: string;
      resetType: "FIVE_HOUR" | "WEEK";
      idempotencyKey: string;
    }
  | {
      /**
       * claimCodingPlan (additive, 2026-11-03 — "Claim" from the phone): the
       * SAME `claimManualPlan` of the app's marketing banner
       * (POST /zcode-plan/billing/claim). The service answers
       * {success, code, message, plan?, reason?} — it never invents a success: a
       * code 1001-1005 is the server saying "no more"/"it ended". `reason`
       * (additive 2026-11-04) is the narrow literal `verification-unavailable`: the
       * server asked for a captcha (3007) and this build cannot solve it; the bot
       * treats it as a final verdict, NOT as a retry. An empty planId is
       * rejected at the edge.
       */
      kind: "claimCodingPlan";
      planId: string;
    };

/**
 * The modes a user can change from the UI (a subset of
 * `ZCodeTaskMode`; `auto` and the legacy aliases are not switchable). The bot
 * exposes them as plan 🗺 / yolo 🔓; the rest remain for parity with the desktop
 * switch.
 */
export const DAEMON_CHANNEL_MODES = ["build", "edit", "plan", "yolo", "guarded"] as const;

export type DaemonChannelMode = (typeof DAEMON_CHANNEL_MODES)[number];

/**
 * `contextWindow` result (the conversation's REAL context meter — the same
 * source that restores the desktop meter: runtime.contextUsage of the
 * snapshot). Honest by contract: null = the host does not know; it is NEVER
 * estimated on the host or the client side.
 */
export interface DaemonChannelContextWindowResult {
  /** Current modelId of the conversation (settings.model of the task, or meta). */
  model: string | null;
  /** Tokens of the current context (last usage projection from the runtime). */
  usedTokens: number | null;
  /** The model's context window; null = unknown. */
  windowTokens: number | null;
  /**
   * Where the window came from (additive, 2026-10-30): "model" = the registry's
   * contextWindow (the model's REAL window — the runtime size turned out to be
   * a per-segment cap, not the window); "runtime" = the runtime's size when
   * the registry does not cover the model; "owner_default" = the owner's
   * calibration (his models are 1M maximum) when nothing exposes it — the bot
   * marks it with (~). Absent = old servers.
   */
  windowSource?: "model" | "runtime" | "owner_default";
}

/**
 * `codingPlanGifts` result (additive, 2026-11-03): the coding plan's two gift
 * surfaces, as the app paints them —
 *  - `reset`: the 🎁 pill (resets ALREADY granted with their expiration, plus the
 *    usage history). null = the host could not read the plane (see
 *    `unavailable.reset`);
 *  - `claimable`: the "claimable offer" banner (preview with its
 *    entitlements). null = it could not be read.
 * One surface going down does NOT kill the other. No secrets: only the values the
 * app shows. `expireAt`/`serverTime` in ms; `effectiveAt` in Unix
 * seconds (that is how the server sends it).
 */
export interface DaemonChannelCodingPlanGiftsResult {
  reset: {
    fiveHour: Array<{ expireAt: number }>;
    week: Array<{ expireAt: number }>;
    latestFiveHourUsedAt: number | null;
    latestWeekUsedAt: number | null;
    hasUnreadHistory: boolean;
  } | null;
  claimable: {
    serverTime?: number;
    plans: Array<{
      planId: string;
      name: string;
      description: string;
      priority: number;
      entitlements: Array<{
        entitlementId: string;
        showName: string;
        meter: string;
        unitType: string;
        capabilities: string[];
        grantUnits: number;
        period: string;
        effectiveAt?: number;
      }>;
    }>;
  } | null;
  /** Stable reason per plan that is down — never the server's raw message. */
  unavailable?: {
    reset?: "not_authenticated" | "not_configured" | "request_failed";
    claimable?: "not_authenticated" | "request_failed";
  };
  /**
   * The marketing banner's offers with the "claim_zcode_plan" action (what
   * the owner SEES in the app: "ZCODE GLOBAL BUILD · 300,000,000 tokens ·
   * Claim"). The plan_id IS the claim's; the label is the server's button copy
   * (text as-is). Absent = the channel could not read it.
   */
  offers?: Array<{
    planId: string;
    label: string;
    campaignId: string;
  }>;
}

export interface DaemonChannelQueryRequest {
  type: "query";
  id: string;
  query: DaemonChannelQuery;
}

export interface DaemonChannelPingRequest {
  type: "ping";
  id: string;
}

/**
 * The owner's ANSWER to a pending question (additive 2026-10-30): the
 * loop closes — the permission_request / elicitation_request that arrived over
 * the stream is answered FROM THE PHONE with this frame, routed to the SAME
 * taskId as the event (respondPermission / respondElicitation of the task service
 * — the same methods the desktop UI calls; the event's requestId IS the
 * v4 broker's interactionId). kind "plan" is the ExitPlanMode
 * approval: it travels as an elicitation with action accept/decline.
 */
export interface DaemonChannelRespondRequest {
  type: "respond";
  id: string;
  /** The task owning the interaction (the taskId of the question event). */
  taskId: string;
  /** The event's requestId — interactionId in the CLI interaction-broker. */
  requestId: string;
  kind: "permission" | "elicitation" | "plan";
  /** permission: the optionId of the chosen option (the event's option). */
  optionId?: string;
  /**
   * permission: the event option's `response`, returned as-is
   * (decision + extras). Absent → the host derives {decision} from the optionId
   * (deny → deny, anything else → allow — the SAME rule as
   * permissionResolvedPayloadToStreamEvents).
   */
  response?: ZCodePermissionResponse;
  /** elicitation/plan: accept | decline | cancel (plan without action → accept). */
  action?: "accept" | "decline" | "cancel";
  /** elicitation: the content {answers, answer_0, answer} (buildBotElicitationContent's shape). */
  content?: Record<string, unknown>;
  /** Stable id of the source tap — the SAME dedupe law as inbound. */
  messageId?: string;
}

/**
 * STEER (additive, 2026-10-30): redirect ONE turn IN PROGRESS from the phone.
 * The text travels to the task service with delivery "guide" (v4 sendText
 * requestedDelivery=guide → the CLI admission injects it INSIDE the
 * running turn — turn.steerQueued → turn.steerDrained at the next
 * tool boundary). Idle → the CLI starts a normal turn with the
 * same text (the guide is not lost; the client says so honestly). The ACK
 * is the SAME inbound_result as inbound (empty replies).
 */
export interface DaemonChannelSteerRequest {
  type: "steer";
  id: string;
  taskId: string;
  text: string;
}

export type DaemonChannelClientMessage =
  | DaemonChannelHelloRequest
  | DaemonChannelInboundRequest
  | DaemonChannelSubscribeRequest
  | DaemonChannelUnsubscribeRequest
  | DaemonChannelQueryRequest
  | DaemonChannelPingRequest
  | DaemonChannelRespondRequest
  | DaemonChannelSteerRequest;

// ---- server → client ---------------------------------------------------------

export interface DaemonChannelServerInfo {
  pid: number;
  startedAt: number;
  appVersion?: string;
}

export interface DaemonChannelHelloOk {
  type: "hello_ok";
  protocolVersion: number;
  server: DaemonChannelServerInfo;
  /** The channel's bot entry (stable id for building the inbound actor). */
  bot: { id: string; enabled: boolean };
  capabilities: string[];
}

/** Minimal BotOutboundMessage projection: what the daemon renders. */
export interface DaemonChannelReply {
  text: string;
  locale?: string;
  selection?: unknown;
  elicitation?: unknown;
}

export interface DaemonChannelInboundResult {
  type: "inbound_result";
  id: string;
  /** Duplicated by messageId: ok=true with empty replies. */
  duplicate?: boolean;
  replies: DaemonChannelReply[];
}

/**
 * The honest ACK of a respond (additive 2026-10-30): the response ARRIVED at the
 * task service (ok=true) or failed (ok=false + error — the tap edits the question
 * message with the truth; a duplicated respond for an already resolved
 * interaction fails in the CLI and the error travels, never a lying ok).
 */
export interface DaemonChannelRespondResult {
  type: "respond_result";
  id: string;
  taskId: string;
  requestId: string;
  kind: string;
  ok: boolean;
}

export interface DaemonChannelSubscribed {
  type: "subscribed";
  id: string;
  taskId: string;
}

export interface DaemonChannelUnsubscribed {
  type: "unsubscribed";
  id: string;
  taskId: string;
}

export interface DaemonChannelQueryResult {
  type: "query_result";
  id: string;
  result: unknown;
}

// ---- plan / model / effort (model selection) ---------------------------------
// The protocol is additive: new query kinds travel through the same `query`
// frame; old clients never send them and old servers answer
// `unknown_query`.

/** Current projected selection: plan (provider) + model + effort. */
export interface DaemonChannelModelSelectionInfo {
  providerId: string;
  modelId: string;
  reasoningLevel?: string;
}

/** An available plan with its models (tap-to-change row of the bot's /plan). */
export interface DaemonChannelModelSelectionPlan {
  providerId: string;
  label: string;
  models: Array<{
    id: string;
    label: string;
    /**
     * Efforts ("reasoningLevel") the model accepts, from lowest to highest
     * (the SAME catalog that validates setModelSelection: optionSpecs). Additive and
     * optional: old servers do not send it and the client falls back to its vocabulary.
     */
    reasoningLevels?: string[];
  }>;
}

/** Result of `modelSelection` and `setModelSelection`. */
export interface DaemonChannelModelSelectionResult {
  scope: "conversation" | "default";
  /** Current selection of the requested scope (conversation or global default). */
  selection: DaemonChannelModelSelectionInfo | null;
  /** The app's global default (`defaultModelSelection` of the personal config). */
  default: DaemonChannelModelSelectionInfo | null;
  /** Available plans with their models, to build the menus. */
  plans: DaemonChannelModelSelectionPlan[];
}

export interface DaemonChannelPong {
  type: "pong";
  id: string;
  at: number;
}

export type DaemonChannelErrorCode =
  | "auth_failed"
  | "auth_timeout"
  | "unsupported_version"
  | "bad_request"
  | "unknown_request"
  | "unknown_query"
  | "not_ready"
  | "internal";

export interface DaemonChannelError {
  type: "error";
  /** Absent on errors that do not answer a request (e.g. auth). */
  id?: string;
  code: DaemonChannelErrorCode;
  message?: string;
  /** Versions accepted by the server (only unsupported_version). */
  supported?: number[];
  /** true = the server closes the connection after this error. */
  fatal?: boolean;
}

/** Continuous-stream push. `at` is the host's receive time (epoch ms). */
export interface DaemonChannelStreamEventFrame {
  type: "stream_event";
  taskId: string;
  /** Monotonic per connection; detects gaps after a reconnection. */
  seq: number;
  at: number;
  event: ZCodeStreamEvent;
}

/**
 * Continuous-stream heartbeat (additive 2026-10-30): one frame per live
 * subscription every DAEMON_CHANNEL_STREAM_KEEPALIVE_INTERVAL_MS while there are no
 * events to resend.
 *
 * CONSUMER CONTRACT: the PURE absence of frames (neither stream_event nor
 * stream_keepalive) for more than ~3 intervals = dead stream, even if the
 * model is quiet. A quiet model does NOT break the heartbeat; only the channel's
 * real death (host down, broken socket, lost subscription) does.
 * The consumer's watchdog must key on the heartbeat, not on raw
 * silence — raw silence confuses "pensive model" with "dead bus"
 * (measured 2026-10-30: burst on subscribe, then silence on a LIVE turn).
 */
export interface DaemonChannelStreamKeepaliveFrame {
  type: "stream_keepalive";
  taskId: string;
  /** The SAME per-connection monotonic counter as stream_event: gaps are detected the same way. */
  seq: number;
  at: number;
}

/** Best-effort before a clean host shutdown. */
export interface DaemonChannelBye {
  type: "bye";
  reason: string;
}

export type DaemonChannelServerMessage =
  | DaemonChannelHelloOk
  | DaemonChannelInboundResult
  | DaemonChannelRespondResult
  | DaemonChannelSubscribed
  | DaemonChannelUnsubscribed
  | DaemonChannelQueryResult
  | DaemonChannelPong
  | DaemonChannelError
  | DaemonChannelStreamEventFrame
  | DaemonChannelStreamKeepaliveFrame
  | DaemonChannelBye;
