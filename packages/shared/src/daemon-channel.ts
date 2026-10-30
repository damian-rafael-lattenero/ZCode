/* [fork] B3a — canal «daemon local» (ADR-022).
 * Contrato de línea del unix socket que expone handleInboundMessage, el stream
 * bot-channel-continuous y las service queries al daemon Kotlin del bot.
 * La spec narrativa completa (auth, semántica de reconexión, at-least-once)
 * vive en docs/fork/DAEMON-CHANNEL.md; estos tipos son la fuente normativa de
 * los shapes. El protocolo es aditivo: campos nuevos son opcionales y los
 * lectores viejos los ignoran; romper compat exige bump de DAEMON_CHANNEL_PROTOCOL_VERSION.
 */
import type { ZCodeStreamEvent } from "./zcode-task-types-core.js";

export const DAEMON_CHANNEL_PROTOCOL_VERSION = 1;

/** Rutas relativas a la raíz de datos (~/.zcode por defecto). */
export const DAEMON_CHANNEL_SOCKET_FILENAME = "daemon-local.sock";
export const DAEMON_CHANNEL_TOKEN_FILENAME = "daemon-local.token";
/** El token y el socket se crean 0600: solo el usuario dueño puede hablar. */
export const DAEMON_CHANNEL_FILE_MODE = 0o600;
/** Límite de una línea JSONL (los attachments viajan base64 dentro del frame). */
export const DAEMON_CHANNEL_MAX_LINE_BYTES = 24 * 1024 * 1024;
/** El hello debe llegar en la primera línea, dentro de esta ventana. */
export const DAEMON_CHANNEL_HANDSHAKE_TIMEOUT_MS = 10_000;
/** Ventana de dedupe de inbound por messageId (paridad con el offset de Telegram). */
export const DAEMON_CHANNEL_INBOUND_DEDUPE_TTL_MS = 2 * 60_000;

/** Provider sintético del canal: una bot entry más en bot-config.v3.json. */
export const DAEMON_CHANNEL_PROVIDER = "daemon";
export const DAEMON_CHANNEL_DEFAULT_BOT_ID = "daemon-local";
export const DAEMON_CHANNEL_PROVIDER_USER_ID = "daemon";

// ---- cliente → servidor ------------------------------------------------------

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
  /** Contenido embebido (el servicio lo materializa en bot-attachments/). */
  dataBase64?: string;
  /** Ruta absoluta legible por el host; preferida sobre dataBase64 si existe. */
  localPath?: string;
}

export interface DaemonChannelInboundRequest {
  type: "inbound";
  id: string;
  /** Texto libre tal como iría al composer; los /comandos los parsea botsService. */
  text: string;
  /** Anula la detección de comandos (texto que empieza con «/» pero no es comando). */
  commandText?: string;
  /** Id estable del update origen (p. ej. update_id de Telegram) para dedupe. */
  messageId?: string;
  attachments?: DaemonChannelInboundAttachment[];
  receivedAt?: number;
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
  | { kind: "listTasks"; workspacePath: string; workspaceIdentity?: string }
  | DaemonChannelTaskListQuery
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
  | { kind: "quota"; invalidateBalanceCache?: boolean }
  | { kind: "botStatus" }
  | {
      kind: "modelSelection";
      workspacePath?: string;
      workspaceIdentity?: string;
    }
  | {
      kind: "setModelSelection";
      /** «conversation» = la conversación enfocada del bot; «default» = el default global de la app. */
      scope: "conversation" | "default";
      workspacePath?: string;
      workspaceIdentity?: string;
      /** Plan = providerId de cuenta (p. ej. account:zai-individual-coding-plan). */
      plan?: string;
      /** modelId dentro del plan. */
      model?: string;
      /** Reasoning level («effort»). */
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
    };

export interface DaemonChannelQueryRequest {
  type: "query";
  id: string;
  query: DaemonChannelQuery;
}

export interface DaemonChannelPingRequest {
  type: "ping";
  id: string;
}

export type DaemonChannelClientMessage =
  | DaemonChannelHelloRequest
  | DaemonChannelInboundRequest
  | DaemonChannelSubscribeRequest
  | DaemonChannelUnsubscribeRequest
  | DaemonChannelQueryRequest
  | DaemonChannelPingRequest;

// ---- servidor → cliente ------------------------------------------------------

export interface DaemonChannelServerInfo {
  pid: number;
  startedAt: number;
  appVersion?: string;
}

export interface DaemonChannelHelloOk {
  type: "hello_ok";
  protocolVersion: number;
  server: DaemonChannelServerInfo;
  /** La bot entry del canal (id estable para armar el actor de inbound). */
  bot: { id: string; enabled: boolean };
  capabilities: string[];
}

/** Proyección mínima de BotOutboundMessage: lo que el daemon renderiza. */
export interface DaemonChannelReply {
  text: string;
  locale?: string;
  selection?: unknown;
  elicitation?: unknown;
}

export interface DaemonChannelInboundResult {
  type: "inbound_result";
  id: string;
  /** Duplicado por messageId: ok=true con replies vacías. */
  duplicate?: boolean;
  replies: DaemonChannelReply[];
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

// ---- plan / modelo / effort (selección de modelo) -----------------------------
// El protocolo es aditivo: las query kinds nuevas viajan por el mismo frame
// `query`; clientes viejos jamás las envían y servidores viejos responden
// `unknown_query`.

/** Selección vigente proyectada: plan (provider) + modelo + effort. */
export interface DaemonChannelModelSelectionInfo {
  providerId: string;
  modelId: string;
  reasoningLevel?: string;
}

/** Un plan disponible con sus modelos (fila tap-to-change del /plan del bot). */
export interface DaemonChannelModelSelectionPlan {
  providerId: string;
  label: string;
  models: Array<{ id: string; label: string }>;
}

/** Resultado de `modelSelection` y `setModelSelection`. */
export interface DaemonChannelModelSelectionResult {
  scope: "conversation" | "default";
  /** Selección vigente del alcance pedido (conversación o default global). */
  selection: DaemonChannelModelSelectionInfo | null;
  /** Default global de la app (`defaultModelSelection` del personal config). */
  default: DaemonChannelModelSelectionInfo | null;
  /** Planes disponibles con sus modelos, para armar los menús. */
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
  /** Ausente en errores que no responden a un request (p. ej. auth). */
  id?: string;
  code: DaemonChannelErrorCode;
  message?: string;
  /** Versiones aceptadas por el servidor (solo unsupported_version). */
  supported?: number[];
  /** true = el servidor cierra la conexión después de este error. */
  fatal?: boolean;
}

/** Push del stream continuo. `at` es el tiempo de recepción del host (epoch ms). */
export interface DaemonChannelStreamEventFrame {
  type: "stream_event";
  taskId: string;
  /** Monótono por conexión; detecta gaps tras una reconexión. */
  seq: number;
  at: number;
  event: ZCodeStreamEvent;
}

/** Best-effort antes de un cierre limpio del host. */
export interface DaemonChannelBye {
  type: "bye";
  reason: string;
}

export type DaemonChannelServerMessage =
  | DaemonChannelHelloOk
  | DaemonChannelInboundResult
  | DaemonChannelSubscribed
  | DaemonChannelUnsubscribed
  | DaemonChannelQueryResult
  | DaemonChannelPong
  | DaemonChannelError
  | DaemonChannelStreamEventFrame
  | DaemonChannelBye;
