/* [fork] B3a — canal «daemon local» (ADR-022).
 * Contrato de línea del unix socket que expone handleInboundMessage, el stream
 * bot-channel-continuous y las service queries al daemon Kotlin del bot.
 * La spec narrativa completa (auth, semántica de reconexión, at-least-once)
 * vive en docs/fork/DAEMON-CHANNEL.md; estos tipos son la fuente normativa de
 * los shapes. El protocolo es aditivo: campos nuevos son opcionales y los
 * lectores viejos los ignoran; romper compat exige bump de DAEMON_CHANNEL_PROTOCOL_VERSION.
 */
import type { ZCodeStreamEvent } from "./zcode-task-types-core.js";
import type { ZCodePermissionResponse } from "./zcode-protocol-legacy-types.js";

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

/**
 * Intervalo del latido del stream continuo (stream_keepalive). 15s da un
 * margen 4× bajo el watchdog de 60s del consumidor (el bot re-suscribe a los
 * 60s de silencio crudo; con el latido keyará en «3+ intervalos sin frames»).
 */
export const DAEMON_CHANNEL_STREAM_KEEPALIVE_INTERVAL_MS = 15_000;

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
  /**
   * Sesión DESTINO del texto (aditivo, 30/10): presente → el canal envía el
   * prompt DIRECTO a esa task (sendPrompt) en vez del botsService — es la
   * ÓRDEN del dueño a un subagente attachado; la respuesta vuelve por el
   * stream de la sesión (la carta attachada la muestra). Ausente → el
   * routing de siempre (la conversación bindeada).
   */
  taskId?: string;
  /**
   * EL BIND ATÓMICO (aditivo, 2/11): presente → el contexto del bot se
   * apunta PRIMERO a esa task (la MISMA ley del comando /task — la
   * frontera de proyecto/fixed-cwd y el veredicto taskRunning incluidos)
   * y el texto vuela después por el routing de siempre. El refusal viaja
   * como única reply del inbound_result («taskRunning» / «Task not
   * found») — el mismo veredicto que el sendInboundAwait del bot ya sabe
   * leer; el texto NO se entrega si el bind falla. Incompatible con
   * taskId (la orden gana); los lectores viejos lo ignoran.
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
       * La conversación activa del bot (aditivo, 30/10): de su model
       * selection sale el providerId → el hint de accountAccess
       * ({mode: start-plan | individual-coding-plan}) que hace que el
       * provider resuelva el acceso DINÁMICO real en el borde — sin él el
       * camino Start Plan nunca entra y la respuesta es el mentiroso
       * not_configured (medido en vivo 30/10).
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
    }
  | {
      /**
       * setMode (aditivo, 2/11 — el /mode del bot: plan 🗺 / yolo 🔓).
       * Cambia el MODO de colaboración de la conversación por el MISMO camino
       * del switch de la UI (v4 switchCollaborationMode, con convergencia de
       * revisión). Un modo fuera de `DAEMON_CHANNEL_MODES` o una task
       * desconocida se rechazan honestos (error, nunca un downgrade silencioso).
       */
      kind: "setMode";
      taskId: string;
      /** Solo los modos que el usuario puede cambiar (mismo set que la UI). */
      mode: (typeof DAEMON_CHANNEL_MODES)[number];
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
       * codingPlanGifts (aditivo, 3/11 — el 🎁 del /quota del bot): LECTURA
       * de las dos superficies de regalo que ya existen en los services —
       * los resets de cuota ya otorgados (status) y las ofertas reclamables
       * (preview). taskId es opcional pero recomendado: de su model selection
       * sale el accountAccess que resuelve la cuenta real del coding plan;
       * sin una cuenta de plan, el host prueba el plan de la app y el
       * registry. NUNCA llama /opportunity (mutación con cupo server-side).
       */
      kind: "codingPlanGifts";
      taskId?: string;
    }
  | {
      /**
       * useCodingPlanReset (aditivo, 3/11 — el 🎁 con confirmación del bot):
       * gasta UN reset ya otorgado (POST /coding-plan/reset/use). Es
       * IRREVERSIBLE y con idempotency key: el cliente manda la key y un
       * retry del mismo key no consume dos veces. resetType fuera de
       * FIVE_HOUR|WEEK y keys vacías o >64 se rechazan en el borde.
       */
      kind: "useCodingPlanReset";
      taskId?: string;
      resetType: "FIVE_HOUR" | "WEEK";
      idempotencyKey: string;
    }
  | {
      /**
       * claimCodingPlan (aditivo, 3/11 — «Reclamar» desde el teléfono): el
       * MISMO `claimManualPlan` del banner de marketing de la app
       * (POST /zcode-plan/billing/claim). El servicio responde
       * {success, code, message, plan?, reason?} — nunca inventa un éxito: un
       * code 1001-1005 es el server diciendo «ya no»/«terminó». `reason`
       * (aditivo 4/11) es el narrow literal `verification-unavailable`: el
       * server pidió captcha (3007) y este build no puede resolverlo; el bot
       * lo trata como veredicto final, NO como un reintento. planId vacío se
       * rechaza en el borde.
       */
      kind: "claimCodingPlan";
      planId: string;
    };

/**
 * Los modos que un usuario puede cambiar desde la UI (subconjunto de
 * `ZCodeTaskMode`; `auto` y los alias legacy no son conmutables). El bot los
 * expone como plan 🗺 / yolo 🔓; el resto queda para paridad con el switch
 * del desktop.
 */
export const DAEMON_CHANNEL_MODES = ["build", "edit", "plan", "yolo", "guarded"] as const;

export type DaemonChannelMode = (typeof DAEMON_CHANNEL_MODES)[number];

/**
 * Resultado de `contextWindow` (el medidor de contexto REAL de la
 * conversación — la misma fuente que restaura el meter del desktop:
 * runtime.contextUsage del snapshot). Honesto por contrato: null = el host
 * no lo sabe; NUNCA se estima del lado del host ni del cliente.
 */
export interface DaemonChannelContextWindowResult {
  /** modelId vigente de la conversación (settings.model del task, o meta). */
  model: string | null;
  /** Tokens del contexto actual (última proyección de usage del runtime). */
  usedTokens: number | null;
  /** Ventana de contexto del modelo; null = desconocida. */
  windowTokens: number | null;
  /**
   * De dónde salió la ventana (aditivo, 30/10): "model" = el contextWindow
   * del registry (la ventana REAL del modelo — el size del runtime resultó
   * ser un tope por segmento, no la ventana); "runtime" = el size del
   * runtime cuando el registry no cubre el modelo; "owner_default" = la
   * calibración del dueño (sus modelos son 1M máximo) cuando nada lo
   * expone — el bot la marca con (~). Ausente = servers viejos.
   */
  windowSource?: "model" | "runtime" | "owner_default";
}

/**
 * Resultado de `codingPlanGifts` (aditivo, 3/11): las dos superficies de
 * regalo del coding plan, tal como la app las pinta —
 *  - `reset`: el pill 🎁 (resets YA otorgados con su expiración, más el
 *    historial de uso). null = el host no pudo leer el plano (ver
 *    `unavailable.reset`);
 *  - `claimable`: el banner «oferta reclamable» (preview con sus
 *    entitlements). null = no se pudo leer.
 * Una superficie caída NO mata a la otra. Sin secretos: solo los valores que
 * la app muestra. `expireAt`/`serverTime` en ms; `effectiveAt` en segundos
 * Unix (así lo manda el server).
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
  /** Razón estable por plano caído — nunca el mensaje crudo del server. */
  unavailable?: {
    reset?: "not_authenticated" | "not_configured" | "request_failed";
    claimable?: "not_authenticated" | "request_failed";
  };
  /**
   * Las ofertas del banner de marketing con acción «claim_zcode_plan» (lo
   * que el dueño VE en la app: «ZCODE GLOBAL BUILD · 300,000,000 tokens ·
   * Claim»). El plan_id ES el del claim; el label es la copia del botón del
   * server (texto tal cual). Ausente = el canal no la pudo leer.
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
 * La RESPUESTA del dueño a una pregunta pendiente (aditivo 30/10/2026): el
 * loop se cierra — la permission_request / elicitation_request que llegó por
 * el stream se contesta DESDE EL TELÉFONO con esta frame, enrutada al MISMO
 * taskId del evento (respondPermission / respondElicitation del task service
 * — los mismos métodos que el desktop UI llama; el requestId del evento ES el
 * interactionId del broker v4). kind «plan» es la aprobación de
 * ExitPlanMode: viaja como elicitation con action accept/decline.
 */
export interface DaemonChannelRespondRequest {
  type: "respond";
  id: string;
  /** La task dueña de la interacción (el taskId del evento de la pregunta). */
  taskId: string;
  /** El requestId del evento — interactionId en el CLI interaction-broker. */
  requestId: string;
  kind: "permission" | "elicitation" | "plan";
  /** permission: el optionId de la opción elegida (la opción del evento). */
  optionId?: string;
  /**
   * permission: la `response` de la opción del evento, devuelta tal cual
   * (decision + extras). Ausente → el host deriva {decision} del optionId
   * (deny → deny, cualquier otra cosa → allow — la MISMA regla de
   * permissionResolvedPayloadToStreamEvents).
   */
  response?: ZCodePermissionResponse;
  /** elicitation/plan: accept | decline | cancel (plan sin action → accept). */
  action?: "accept" | "decline" | "cancel";
  /** elicitation: el content {answers, answer_0, answer} (buildBotElicitationContent's shape). */
  content?: Record<string, unknown>;
  /** Id estable del tap origen — la MISMA ley de dedupe del inbound. */
  messageId?: string;
}

/**
 * STEER (aditivo, 30/10): redirigir UN turno EN CURSO desde el teléfono.
 * El texto viaja al task service con delivery «guide» (v4 sendText
 * requestedDelivery=guide → el admission del CLI lo inyecta DENTRO del
 * turno corriendo — turn.steerQueued → turn.steerDrained en el próximo
 * límite de herramienta). Idle → el CLI arranca un turno normal con el
 * mismo texto (la guía no se pierde; el cliente lo dice honesto). El ACK
 * es el MISMO inbound_result del inbound (replies vacías).
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

/**
 * El ACK honesto de un respond (aditivo 30/10/2026): la respuesta LLEGÓ al
 * task service (ok=true) o falló (ok=false + error — el tap edita el mensaje
 * de la pregunta con la verdad; un respond duplicado de una interacción ya
 * resuelta falla en el CLI y el error viaja, nunca un ok mentiroso).
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
  models: Array<{
    id: string;
    label: string;
    /**
     * Efforts («reasoningLevel») que el modelo acepta, de menor a mayor
     * (el MISMO catálogo que valida setModelSelection: optionSpecs). Aditivo y
     * opcional: servers viejos no lo mandan y el cliente cae a su vocabulario.
     */
    reasoningLevels?: string[];
  }>;
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

/**
 * Latido del stream continuo (aditivo 30/10/2026): una frame por suscripción
 * viva cada DAEMON_CHANNEL_STREAM_KEEPALIVE_INTERVAL_MS mientras no haya
 * eventos que reenviar.
 *
 * CONTRATO DEL CONSUMIDOR: la ausencia PURA de frames (ni stream_event ni
 * stream_keepalive) durante más de ~3 intervalos = stream muerto, aunque el
 * modelo esté callado. Un modelo callado NO rompe el latido; solo la muerte
 * real del canal (host caído, socket roto, suscripción perdida) lo hace.
 * El watchdog del consumidor debe keyar en el latido, no en el silencio
 * crudo — el silencio crudo confunde «modelo pensativo» con «bus muerto»
 * (medido 30/10: burst on subscribe, then silence on a LIVE turn).
 */
export interface DaemonChannelStreamKeepaliveFrame {
  type: "stream_keepalive";
  taskId: string;
  /** El MISMO contador monótono por conexión que stream_event: los gaps se detectan igual. */
  seq: number;
  at: number;
}

/** Best-effort antes de un cierre limpio del host. */
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
