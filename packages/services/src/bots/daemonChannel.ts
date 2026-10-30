/* [fork] B3a — canal «daemon local» (ADR-022): el único camino de lectura y
 * escritura hacia la conversación REAL para el daemon Kotlin del bot.
 * Un unix socket (~/.zcode/daemon-local.sock) expuesto por el Host (utility
 * process — NUNCA el main de Electron):
 *   inbound   → IBotsService.handleInboundMessage (el MISMO camino que el composer)
 *   stream    → IZCodeTaskService.onDynamicTaskEvent("bot-channel-continuous"),
 *               los eventos V4 crudos que renderiza el desktop, sin replay.
 *   queries   → listTasks/taskList/meta/snapshot/usage/quota/botStatus/modelSelection
 *   control   → stop / stopAll / compact / setModelSelection (V4 & compañía)
 * Auth: token en ~/.zcode/daemon-local.token (0600, rota en cada arranque del
 * host); hello obligatorio en la primera línea. El socket también es 0600.
 * Spec completa: docs/fork/DAEMON-CHANNEL.md.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, rm, unlink, writeFile } from "node:fs/promises";
import { connect, createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import {
  DAEMON_CHANNEL_DEFAULT_BOT_ID,
  DAEMON_CHANNEL_FILE_MODE,
  DAEMON_CHANNEL_HANDSHAKE_TIMEOUT_MS,
  DAEMON_CHANNEL_INBOUND_DEDUPE_TTL_MS,
  DAEMON_CHANNEL_MAX_LINE_BYTES,
  DAEMON_CHANNEL_PROTOCOL_VERSION,
  DAEMON_CHANNEL_PROVIDER,
  DAEMON_CHANNEL_PROVIDER_USER_ID,
  DAEMON_CHANNEL_SOCKET_FILENAME,
  DAEMON_CHANNEL_TOKEN_FILENAME,
  ZCODE_VERSION,
  isCodingPlanModelProviderId,
  isStartPlanModelProviderId,
  type BotConfig,
  type BotInboundMessage,
  type BotOutboundMessage,
  type ZCodeAccountAccess,
  type ZCodeStreamEvent,
  type DaemonChannelClientMessage,
  type DaemonChannelContextWindowResult,
  type DaemonChannelError,
  type DaemonChannelQuery,
  type DaemonChannelServerMessage,
} from "@zcode/shared";
import type { IBotsService } from "./bots.js";
import type { IZCodeTaskService } from "../session/zcodeTaskService.js";
import { createDaemonChannelModelSelectionHandler } from "./daemonChannelModelSelection.js";
import type { DaemonChannelModelSelectionDeps } from "./daemonChannelModelSelection.js";
import type { IUsageStatsService } from "../usage-stats/usageStats.js";
import type { ServiceLogger } from "../logger/serviceLogger.js";
import { createServiceLogger } from "../logger/serviceLogger.js";
import { getZCodeDataRootDir } from "../paths.js";

/** [fork] env kill-switch del canal (default: activado). */
export const DAEMON_CHANNEL_DISABLE_ENV = "ZCODE_DAEMON_LOCAL_CHANNEL";

export interface DaemonLocalChannelDeps {
  botsService: IBotsService;
  zcodeTaskService: IZCodeTaskService;
  usageStatsService?: Pick<IUsageStatsService, "getEntitlementSnapshot">;
  /** Vista del registry de planes/modelos y default global (para el /plan del bot). */
  modelSelectionService?: DaemonChannelModelSelectionDeps["modelSelectionService"];
  modelSelectionDefault?: DaemonChannelModelSelectionDeps["modelSelectionDefault"];
  logger?: ServiceLogger;
  /** Inyectable para tests herméticos; default: raíz de datos real (~/.zcode). */
  dataRootDir?: () => string;
  env?: Record<string, string | undefined>;
  now?: () => number;
  /** Inyectable para tests; default: DAEMON_CHANNEL_HANDSHAKE_TIMEOUT_MS. */
  handshakeTimeoutMs?: number;
}

export type DaemonLocalChannelState =
  | "created"
  | "disabled"
  | "conflict"
  | "listening"
  | "disposed"
  | "error";

interface DaemonConnection {
  socket: Socket;
  clientId?: string;
  subscriptions: Map<string, { dispose(): void }>;
  seq: number;
}

export interface DaemonLocalChannel {
  start(): Promise<void>;
  dispose(): Promise<void>;
  getState(): DaemonLocalChannelState;
  getSocketPath(): string;
}

/**
 * El hint de accountAccess del providerId ACTIVO de la conversación: el
 * shape estático con `mode` dispara la resolución DINÁMICA del acceso real
 * en el provider (resolveRequestAccountAccess lee la conexión de cuenta
 * vigente — el hint apunta, el servicio responde con la verdad). Null para
 * providers que no son de plan (el camino genérico es el correcto ahí).
 */
function accountAccessHintFor(providerId: string): ZCodeAccountAccess | null {
  if (isStartPlanModelProviderId(providerId)) {
    return {
      type: "zhipu-account",
      family: "zai",
      planKind: "start-plan",
    };
  }
  if (isCodingPlanModelProviderId(providerId)) {
    return {
      type: "zhipu-account",
      family: "zai",
      planKind: "individual-coding-plan",
    };
  }
  return null;
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function tokensMatch(expected: string, received: string): boolean {
  return timingSafeEqual(sha256(expected), sha256(received));
}

function toWireReply(message: BotOutboundMessage) {
  return {
    text: message.text,
    ...(message.locale ? { locale: message.locale as string } : {}),
    ...(message.selection ? { selection: message.selection } : {}),
    ...(message.elicitation ? { elicitation: message.elicitation } : {}),
  };
}

const KNOWN_QUERY_KINDS = new Set([
  "listTasks",
  "taskList",
  "activeTaskIds",
  "taskMeta",
  "taskSnapshot",
  "taskUsage",
  "quota",
  "botStatus",
  "modelSelection",
  "setModelSelection",
  "stop",
  "stopAll",
  "compact",
  "contextWindow",
]);

function buildDaemonBotConfig(existing?: BotConfig): BotConfig {
  return (
    existing ?? {
      id: DAEMON_CHANNEL_DEFAULT_BOT_ID,
      name: "Daemon local",
      provider: DAEMON_CHANNEL_PROVIDER,
      enabled: true,
      // El actor del socket es fijo: proveedor «daemon», usuario «daemon».
      providerUserId: DAEMON_CHANNEL_PROVIDER_USER_ID,
      displayName: "Local daemon",
      allowedWorkspaces: ["*"],
      allowedCommands: {
        status: true,
        new: true,
        workspace: true,
        model: true,
        mode: true,
        thoughtLevel: true,
        sandboxMode: true,
        approvalPolicy: true,
        reply: true,
      },
      currentOptions: {},
      // Irrelevante en la práctica: el adapter null descarta las salidas.
      replyMode: "assistant_changes",
    }
  );
}

/** true si alguien está escuchando en el path (otro host vivo lo posee). */
async function isSocketAlive(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = connect(socketPath);
    probe.once("connect", () => {
      probe.destroy();
      resolve(true);
    });
    probe.once("error", () => resolve(false));
  });
}

export function createDaemonLocalChannel(
  deps: DaemonLocalChannelDeps,
): DaemonLocalChannel {
  const logger = deps.logger ?? createServiceLogger("daemon-channel");
  const now = deps.now ?? Date.now;
  const dataRootDir = deps.dataRootDir ?? getZCodeDataRootDir;
  const env = deps.env ?? process.env;
  const socketPath = () => join(dataRootDir(), DAEMON_CHANNEL_SOCKET_FILENAME);
  const tokenPath = () => join(dataRootDir(), DAEMON_CHANNEL_TOKEN_FILENAME);

  let state: DaemonLocalChannelState = "created";
  let server: Server | undefined;
  let currentToken = "";
  // Ownership de los archivos en disco: SOLO quien hizo listen+token puede
  // borrarlos en dispose. Un host que perdió la carrera (conflict) no debe
  // unlink el socket/token del host vivo.
  let ownsFiles = false;
  const liveSockets = new Set<Socket>();
  const startedAt = now();
  const daemonBotIdCache = { id: DAEMON_CHANNEL_DEFAULT_BOT_ID, enabled: true };
  // Dedupe de inbound por messageId, con la misma ventana que el offset de Telegram.
  const recentInboundByMessageId = new Map<string, number>();
  const capabilities = [
    "inbound",
    "stream",
    "queries:listTasks",
    "queries:taskList",
    "queries:taskMeta",
    "queries:taskSnapshot",
    "queries:taskUsage",
    "queries:quota",
    "queries:botStatus",
    "queries:modelSelection",
    "queries:contextWindow",
    "control:setModelSelection",
    "control:stop",
    "control:stopAll",
    "control:compact",
  ];

  function send(socket: Socket, message: DaemonChannelServerMessage): boolean {
    if (socket.destroyed || !socket.writable) return false;
    try {
      socket.write(`${JSON.stringify(message)}\n`);
      return true;
    } catch {
      return false;
    }
  }

  function sendError(
    connection: DaemonConnection | undefined,
    socket: Socket,
    error: DaemonChannelError,
  ): void {
    send(socket, error);
    if (error.fatal) {
      connection?.subscriptions.forEach((subscription) => subscription.dispose());
      connection?.subscriptions.clear();
      socket.destroy();
    }
  }

  async function ensureDaemonBot(): Promise<{ id: string; enabled: boolean }> {
    const config = await deps.botsService.getConfig();
    const existing = config.bots.find((bot) => bot.provider === DAEMON_CHANNEL_PROVIDER);
    // Add-if-absent solamente: si Damian la deshabilita o borra desde el diálogo
    // de Bots, la decisión persiste (la gates son «enabled» y el env kill-switch).
    if (existing) return { id: existing.id, enabled: existing.enabled };
    const created = await deps.botsService.saveBot({
      bot: buildDaemonBotConfig(),
    });
    logger.info(undefined, `daemon bot provisioned id=${created.id}`);
    return { id: created.id, enabled: created.enabled };
  }

  async function writeTokenFile(): Promise<void> {
    currentToken = randomBytes(32).toString("hex");
    await mkdir(dataRootDir(), { recursive: true });
    await writeFile(tokenPath(), `${currentToken}\n`, { encoding: "utf8", mode: DAEMON_CHANNEL_FILE_MODE });
    // writeFile no cambia el modo de un archivo existente: chmod explícito.
    await chmod(tokenPath(), DAEMON_CHANNEL_FILE_MODE);
  }

  /** Fallback de workspace para queries que lo exigen: el contexto activo del bot. */
  async function resolveContextWorkspace(): Promise<
    { workspacePath: string; workspaceIdentity?: string } | undefined
  > {
    const states = await deps.botsService.getBotStates();
    const context = states.find((entry) => entry.botId === daemonBotIdCache.id);
    return context?.workspacePath
      ? { workspacePath: context.workspacePath, workspaceIdentity: context.workspaceIdentity }
      : undefined;
  }

  const modelSelection = createDaemonChannelModelSelectionHandler({
    botsService: deps.botsService,
    botId: daemonBotIdCache.id,
    modelSelectionService: deps.modelSelectionService,
    modelSelectionDefault: deps.modelSelectionDefault,
    resolveContextWorkspace,
  });

  /**
   * El medidor de contexto REAL de la conversación (query `contextWindow`,
   * /context_window del bot): runtime.contextUsage del snapshot — la MISMA
   * fuente que restaura el meter del desktop (contextUsageFromRuntime ??
   * contextUsageFromProjection del adapter), NUNCA el acumulado del resumen
   * (getTaskTokenUsage es otra cosa). Ventana de respaldo: el
   * properties.contextWindow del registry del modelo. Honesto por contrato:
   * lo que el host no sabe viaja null — used=0 es inicialización, no dato.
   */
  async function contextWindowResult(
    taskId: string,
    workspacePath: string,
    workspaceIdentity?: string,
  ): Promise<DaemonChannelContextWindowResult> {
    const taskService = deps.zcodeTaskService;
    const snapshot = await taskService.getTaskSnapshot({
      taskId,
      workspacePath,
      ...(workspaceIdentity ? { workspaceIdentity } : {}),
      // Solo el medidor importa: 1 mensaje mantiene el paquete liviano.
      messageLimit: 1,
    });
    if (!snapshot) {
      throw new Error(`task ${taskId} has no snapshot to read the context meter from`);
    }
    const selection = await taskService.getTaskModelSelection({ taskId }).catch(() => null);
    const usage = snapshot.runtime?.contextUsage;
    const usedTokens = usage && usage.used > 0 ? usage.used : null;
    // La PRECEDENCIA de la ventana, corregida 30/10 (el dueño vio 200K/200K
    // con modelos de 1M): el contextWindow del registry es la ventana REAL
    // del modelo — el size del runtime resultó ser un tope por segmento.
    // Registry primero, runtime de respaldo, y la calibración del dueño
    // (sus modelos son 1M máximo) cuando nada la expone — marcada para que
    // el cliente la muestre aproximada, nunca como hecho.
    let windowTokens: number | null = null;
    let windowSource: "model" | "runtime" | "owner_default" | null = null;
    if (deps.modelSelectionService && selection) {
      const view = await deps.modelSelectionService.getView().catch(() => null);
      const configured = view?.providers
        .find((provider) => provider.providerId === selection.providerId)
        ?.models.find((model) => model.modelId === selection.modelId)?.config.properties
        .contextWindow;
      if (typeof configured === "number" && configured > 0) {
        windowTokens = configured;
        windowSource = "model";
      }
    }
    if (windowTokens === null && usage && usage.size > 0) {
      windowTokens = usage.size;
      windowSource = "runtime";
    }
    if (windowTokens === null && usedTokens !== null) {
      windowTokens = 1_000_000;
      windowSource = "owner_default";
    }
    return {
      model: selection?.modelId ?? snapshot.meta.model ?? null,
      usedTokens,
      windowTokens,
      ...(windowSource ? { windowSource } : {}),
    };
  }

  async function runQuery(query: DaemonChannelQuery): Promise<unknown> {
    const taskService = deps.zcodeTaskService;
    switch (query.kind) {
      case "listTasks":
        return taskService.listTasks({
          workspacePath: query.workspacePath,
          ...(query.workspaceIdentity ? { workspaceIdentity: query.workspaceIdentity } : {}),
        });
      case "taskList":
        return taskService.listTaskList({
          kind: query.listKind,
          workspaceScopes: query.workspaceScopes,
          sortBy: query.sortBy ?? "updated",
          ...(query.search ? { search: query.search } : {}),
          ...(query.limit ? { limit: query.limit } : {}),
        });
      case "activeTaskIds":
        return taskService.listActiveTaskIds({
          workspacePath: query.workspacePath,
          ...(query.workspaceIdentity ? { workspaceIdentity: query.workspaceIdentity } : {}),
        });
      case "taskMeta":
      case "taskSnapshot":
      case "taskUsage": {
        let workspacePath = query.workspacePath;
        let workspaceIdentity = query.workspaceIdentity;
        if (!workspacePath) {
          const fallback = await resolveContextWorkspace();
          if (!fallback) {
            throw new Error("workspacePath is required when the daemon bot has no active context");
          }
          workspacePath = fallback.workspacePath;
          workspaceIdentity = workspaceIdentity ?? fallback.workspaceIdentity;
        }
        if (query.kind === "taskMeta") {
          const meta = await taskService.getTaskMeta({ taskId: query.taskId, workspacePath, ...(workspaceIdentity ? { workspaceIdentity } : {}) });
          return meta;
        }
        if (query.kind === "taskUsage") {
          return taskService.getTaskTokenUsage({
            taskId: query.taskId,
            workspacePath,
            ...(workspaceIdentity ? { workspaceIdentity } : {}),
          });
        }
        return taskService.getTaskSnapshot({
          taskId: query.taskId,
          workspacePath,
          ...(workspaceIdentity ? { workspaceIdentity } : {}),
          ...(query.messageLimit ? { messageLimit: query.messageLimit } : {}),
          ...(query.byteBudget ? { byteBudget: query.byteBudget } : {}),
          ...(query.toolLimit ? { toolLimit: query.toolLimit } : {}),
        });
      }
      case "quota": {
        if (!deps.usageStatsService) throw new Error("usage stats service is unavailable");
        // El bot lee la cuota del DUEÑO: del model selection de su conversación
        // activa sale el providerId → el hint {mode: …} cuyo shape dispara la
        // resolución DINÁMICA del acceso real en el provider (resolveRequest-
        // AccountAccess). Sin hint, el camino Start Plan nunca entra y la
        // respuesta es el mentiroso not_configured (medido en vivo 30/10).
        const selection = query.taskId
          ? await taskService.getTaskModelSelection({ taskId: query.taskId }).catch(() => null)
          : null;
        const hint = selection ? accountAccessHintFor(selection.providerId) : null;
        return deps.usageStatsService.getEntitlementSnapshot({
          ...(query.invalidateBalanceCache ? { invalidateBalanceCache: true } : {}),
          ...(selection && hint
            ? {
                preferredProviderId: selection.providerId,
                accountAccess: hint,
                allowDisabledPreferredProvider: true,
              }
            : {}),
        });
      }
      case "botStatus": {
        const config = await deps.botsService.getConfig();
        const bot = config.bots.find((entry) => entry.provider === DAEMON_CHANNEL_PROVIDER);
        const context = (await deps.botsService.getBotStates()).find(
          (entry) => entry.botId === daemonBotIdCache.id,
        );
        return {
          bot: bot ? { id: bot.id, enabled: bot.enabled } : null,
          context: context ?? null,
        };
      }
      case "modelSelection":
        return modelSelection.read(query);
      case "setModelSelection":
        return modelSelection.set(query);
      case "stop": {
        await taskService.stopGeneration({
          taskId: query.taskId,
          ...(query.workspacePath ? { workspacePath: query.workspacePath } : {}),
          ...(query.workspaceIdentity ? { workspaceIdentity: query.workspaceIdentity } : {}),
          ...(query.runId ? { runId: query.runId } : {}),
        });
        return { stopped: [query.taskId] };
      }
      case "stopAll": {
        let workspacePath = query.workspacePath;
        let workspaceIdentity = query.workspaceIdentity;
        if (!workspacePath) {
          const fallback = await resolveContextWorkspace();
          if (!fallback) throw new Error("workspacePath is required when the daemon bot has no active context");
          workspacePath = fallback.workspacePath;
          workspaceIdentity = workspaceIdentity ?? fallback.workspaceIdentity;
        }
        const activeIds = await taskService.listActiveTaskIds({
          workspacePath,
          ...(workspaceIdentity ? { workspaceIdentity } : {}),
        });
        for (const taskId of activeIds) {
          await taskService.stopGeneration({ taskId, workspacePath, ...(workspaceIdentity ? { workspaceIdentity } : {}) });
        }
        return { stopped: activeIds };
      }
      case "compact": {
        return taskService.compactSession({
          taskId: query.taskId,
          ...(query.workspacePath ? { workspacePath: query.workspacePath } : {}),
          ...(query.workspaceIdentity ? { workspaceIdentity: query.workspaceIdentity } : {}),
          ...(query.instructions ? { instructions: query.instructions } : {}),
          ...(query.expectedRevision !== undefined ? { expectedRevision: query.expectedRevision } : {}),
        });
      }
      case "contextWindow": {
        let workspacePath = query.workspacePath;
        let workspaceIdentity = query.workspaceIdentity;
        if (!workspacePath) {
          const fallback = await resolveContextWorkspace();
          if (!fallback) {
            throw new Error("workspacePath is required when the daemon bot has no active context");
          }
          workspacePath = fallback.workspacePath;
          workspaceIdentity = workspaceIdentity ?? fallback.workspaceIdentity;
        }
        return contextWindowResult(query.taskId, workspacePath, workspaceIdentity);
      }
      default: {
        // Exhaustividad: una query nueva del shared sin rama acá es un bug del host.
        const exhaustive: never = query;
        throw new Error(`unhandled daemon query: ${JSON.stringify(exhaustive)}`);
      }
    }
  }

  function handleInboundRequest(
    connection: DaemonConnection,
    message: Extract<DaemonChannelClientMessage, { type: "inbound" }>,
  ): void {
    const hasContent = message.text.trim().length > 0 || (message.attachments?.length ?? 0) > 0;
    if (!hasContent) {
      sendError(connection, connection.socket, {
        type: "error",
        id: message.id,
        code: "bad_request",
        message: "inbound requires text or attachments",
      });
      return;
    }
    // Dedupe por messageId: un retry del daemon tras perder la respuesta NO
    // reenvía el prompt a la conversación real (at-least-once con idempotencia
    // de la parte costosa — misma ventana que el offset confirmado de Telegram).
    if (message.messageId) {
      const key = `${daemonBotIdCache.id}:${message.messageId}`;
      const seenAt = recentInboundByMessageId.get(key);
      const current = now();
      if (seenAt !== undefined && current - seenAt < DAEMON_CHANNEL_INBOUND_DEDUPE_TTL_MS) {
        recentInboundByMessageId.set(key, current);
        send(connection.socket, {
          type: "inbound_result",
          id: message.id,
          duplicate: true,
          replies: [],
        });
        return;
      }
      recentInboundByMessageId.set(key, current);
      if (recentInboundByMessageId.size > 512) {
        const cutoff = current - DAEMON_CHANNEL_INBOUND_DEDUPE_TTL_MS;
        for (const [entryKey, at] of recentInboundByMessageId) {
          if (at < cutoff) recentInboundByMessageId.delete(entryKey);
        }
      }
    }
    const inbound: BotInboundMessage = {
      botId: daemonBotIdCache.id,
      text: message.text,
      ...(message.commandText !== undefined ? { commandText: message.commandText } : {}),
      ...(message.receivedAt !== undefined ? { receivedAt: message.receivedAt } : {}),
      ...(message.attachments?.length
        ? {
            attachments: message.attachments.map((attachment) => ({
              id: attachment.id,
              kind: attachment.kind,
              filename: attachment.filename,
              mimeType: attachment.mimeType,
              ...(attachment.sizeBytes !== undefined ? { sizeBytes: attachment.sizeBytes } : {}),
              ...(attachment.dataBase64 ? { dataBase64: attachment.dataBase64 } : {}),
              ...(attachment.localPath ? { localPath: attachment.localPath } : {}),
            })),
          }
        : {}),
      actor: {
        provider: DAEMON_CHANNEL_PROVIDER,
        botId: daemonBotIdCache.id,
        providerUserId: DAEMON_CHANNEL_PROVIDER_USER_ID,
        ...(connection.clientId ? { displayName: connection.clientId } : {}),
        chatType: "private",
        ...(message.messageId ? { providerMessageId: message.messageId } : {}),
      },
    };
    void deps.botsService
      .handleInboundMessage(inbound)
      .then((replies) => {
        send(connection.socket, {
          type: "inbound_result",
          id: message.id,
          replies: replies.map(toWireReply),
        });
      })
      .catch((error: unknown) => {
        logger.warn(
          undefined,
          `inbound failed messageId=${message.messageId ?? ""}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        sendError(connection, connection.socket, {
          type: "error",
          id: message.id,
          code: "internal",
          message: error instanceof Error ? error.message : String(error),
        });
      });
  }

  function handleSubscribe(
    connection: DaemonConnection,
    message: Extract<DaemonChannelClientMessage, { type: "subscribe" }>,
  ): void {
    if (!message.taskId || !message.workspacePath) {
      sendError(connection, connection.socket, {
        type: "error",
        id: message.id,
        code: "bad_request",
        message: "subscribe requires taskId and workspacePath",
      });
      return;
    }
    // Re-subscribir la misma task reemplaza la suscripción anterior.
    connection.subscriptions.get(message.taskId)?.dispose();
    const dynamicTaskEvent =
      (deps.zcodeTaskService as Partial<Pick<IZCodeTaskService, "onDynamicTaskEvent">>)
        .onDynamicTaskEvent;
    // deliveryKind bot-channel-continuous: mismos eventos V4 que el desktop
    // (la proyección de tool_input_* incluida), sin snapshot/gap replay móvil.
    const subscribe = dynamicTaskEvent
      ? dynamicTaskEvent({
          workspacePath: message.workspacePath,
          ...(message.workspaceIdentity ? { workspaceIdentity: message.workspaceIdentity } : {}),
          taskId: message.taskId,
          deliveryKind: "bot-channel-continuous",
        })
      : deps.zcodeTaskService.onDynamicStreamEvent(message.taskId);
    const disposable = subscribe((event: ZCodeStreamEvent) => {
      connection.seq += 1;
      const delivered = send(connection.socket, {
        type: "stream_event",
        taskId: message.taskId,
        seq: connection.seq,
        at: now(),
        event,
      });
      // Socket roto: la suscripción muere con la conexión (continuous, no replay).
      if (!delivered) {
        connection.subscriptions.get(message.taskId)?.dispose();
        connection.subscriptions.delete(message.taskId);
      }
    });
    connection.subscriptions.set(message.taskId, disposable);
    send(connection.socket, { type: "subscribed", id: message.id, taskId: message.taskId });
  }

  function handleAuthenticatedLine(
    connection: DaemonConnection,
    socket: Socket,
    parsed: unknown,
  ): void {
    const message = parsed as DaemonChannelClientMessage;
    switch (message?.type) {
      case "inbound":
        handleInboundRequest(connection, message);
        return;
      case "subscribe":
        handleSubscribe(connection, message);
        return;
      case "unsubscribe": {
        connection.subscriptions.get(message.taskId)?.dispose();
        connection.subscriptions.delete(message.taskId);
        send(socket, { type: "unsubscribed", id: message.id, taskId: message.taskId });
        return;
      }
      case "query": {
        if (!message.query || typeof message.query.kind !== "string") {
          sendError(connection, socket, {
            type: "error",
            id: message.id,
            code: "bad_request",
            message: "query.kind is required",
          });
          return;
        }
        if (!KNOWN_QUERY_KINDS.has(message.query.kind)) {
          sendError(connection, socket, {
            type: "error",
            id: message.id,
            code: "unknown_query",
            message: `unknown query kind: ${message.query.kind}`,
          });
          return;
        }
        void runQuery(message.query)
          .then((result) => {
            send(socket, { type: "query_result", id: message.id, result });
          })
          .catch((error: unknown) => {
            sendError(connection, socket, {
              type: "error",
              id: message.id,
              code: "internal",
              message: error instanceof Error ? error.message : String(error),
            });
          });
        return;
      }
      case "ping":
        send(socket, { type: "pong", id: message.id, at: now() });
        return;
      case "hello":
        // Ya autenticado: responder hello_ok mantiene viva la sesión (re-handshake idempotente).
        send(socket, {
          type: "hello_ok",
          protocolVersion: DAEMON_CHANNEL_PROTOCOL_VERSION,
          server: { pid: process.pid, startedAt, appVersion: ZCODE_VERSION },
          bot: daemonBotIdCache,
          capabilities,
        });
        return;
      default:
        sendError(connection, socket, {
          type: "error",
          code: "unknown_request",
          message: `unknown request type: ${JSON.stringify((parsed as { type?: unknown })?.type)}`,
        });
    }
  }

  function handleConnection(socket: Socket): void {
    liveSockets.add(socket);
    const connection: DaemonConnection = {
      socket,
      subscriptions: new Map(),
      seq: 0,
    };
    let authenticated = false;
    let buffer = "";
    const handshakeTimeout = setTimeout(() => {
      if (!authenticated) {
        send(socket, { type: "error", code: "auth_timeout", message: "hello expected", fatal: true });
        socket.destroy();
      }
    }, deps.handshakeTimeoutMs ?? DAEMON_CHANNEL_HANDSHAKE_TIMEOUT_MS);
    // handshakeTimeout keeps the open handle alive while waiting for hello on
    // an idle socket; unref so a pending handshake cannot block host shutdown.
    handshakeTimeout.unref();

    const disposeConnection = () => {
      clearTimeout(handshakeTimeout);
      connection.subscriptions.forEach((subscription) => subscription.dispose());
      connection.subscriptions.clear();
      buffer = "";
    };
    socket.on("data", (chunk: Buffer) => {
      if (buffer.length + chunk.length > DAEMON_CHANNEL_MAX_LINE_BYTES) {
        send(socket, {
          type: "error",
          code: "bad_request",
          message: "line too long",
          fatal: true,
        });
        socket.destroy();
        return;
      }
      buffer += chunk.toString("utf8");
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf("\n");
        if (!line) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          send(socket, { type: "error", code: "bad_request", message: "invalid JSON line" });
          continue;
        }
        if (!authenticated) {
          const hello = parsed as Extract<DaemonChannelClientMessage, { type: "hello" }>;
          if (hello?.type !== "hello") {
            send(socket, { type: "error", code: "auth_failed", message: "hello expected first", fatal: true });
            socket.destroy();
            return;
          }
          if (hello.protocolVersion !== DAEMON_CHANNEL_PROTOCOL_VERSION) {
            send(socket, {
              type: "error",
              code: "unsupported_version",
              supported: [DAEMON_CHANNEL_PROTOCOL_VERSION],
              fatal: true,
            });
            socket.destroy();
            return;
          }
          if (typeof hello.token !== "string" || !tokensMatch(currentToken, hello.token)) {
            logger.warn(undefined, "daemon channel auth failed");
            send(socket, { type: "error", code: "auth_failed", fatal: true });
            socket.destroy();
            return;
          }
          authenticated = true;
          clearTimeout(handshakeTimeout);
          connection.clientId = hello.clientId;
          logger.info(undefined, `daemon client connected clientId=${hello.clientId ?? ""}`);
          send(socket, {
            type: "hello_ok",
            protocolVersion: DAEMON_CHANNEL_PROTOCOL_VERSION,
            server: { pid: process.pid, startedAt, appVersion: ZCODE_VERSION },
            bot: daemonBotIdCache,
            capabilities,
          });
          continue;
        }
        handleAuthenticatedLine(connection, socket, parsed);
      }
    });
    socket.on("error", (error: Error) => {
      logger.debug(undefined, `daemon connection error: ${error.message}`);
    });
    socket.on("close", () => {
      liveSockets.delete(socket);
      disposeConnection();
      logger.info(undefined, `daemon client disconnected clientId=${connection.clientId ?? ""}`);
    });
  }

  async function start(): Promise<void> {
    if (state !== "created") return;
    if (env[DAEMON_CHANNEL_DISABLE_ENV] === "0") {
      state = "disabled";
      logger.info(undefined, "daemon channel disabled by env");
      return;
    }
    const bot = await ensureDaemonBot().catch((error: unknown) => {
      throw new Error(
        `daemon bot provisioning failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
    daemonBotIdCache.id = bot.id;
    daemonBotIdCache.enabled = bot.enabled;

    // Primer host vivo gana el socket: sondear el archivo viejo ANTES de rotar
    // el token (el token vivo debe pertenecer al proceso que posee el socket).
    try {
      await mkdir(dataRootDir(), { recursive: true });
      if (await isSocketAlive(socketPath())) {
        state = "conflict";
        logger.warn(undefined, `daemon channel socket already owned by a live host: ${socketPath()}`);
        return;
      }
      await rm(socketPath(), { force: true });
    } catch (error: unknown) {
      state = "error";
      logger.error(undefined, "daemon channel startup path check failed", error);
      return;
    }

    let listenConflict = false;
    await new Promise<void>((resolve, reject) => {
      const created = createServer(handleConnection);
      created.once("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "EADDRINUSE") {
          listenConflict = true;
          logger.warn(undefined, "daemon channel lost the socket race (EADDRINUSE)");
          resolve();
          return;
        }
        state = "error";
        logger.error(undefined, "daemon channel listen failed", error);
        reject(error);
      });
      created.listen(socketPath(), () => {
        server = created;
        resolve();
      });
    });
    if (listenConflict) {
      state = "conflict";
      return;
    }
    // Desde acá el socket es nuestro (listen ok): dispose puede unlinklo,
    // incluso si el paso de token falla después.
    ownsFiles = true;

    try {
      await chmod(socketPath(), DAEMON_CHANNEL_FILE_MODE);
      await writeTokenFile();
    } catch (error: unknown) {
      state = "error";
      logger.error(undefined, "daemon channel socket/token setup failed", error);
      await dispose();
      return;
    }
    state = "listening";
    logger.info(
      undefined,
      `daemon channel listening socket=${socketPath()} token=${tokenPath()} bot=${daemonBotIdCache.id}`,
    );
  }

  async function dispose(): Promise<void> {
    if (state === "disposed") return;
    state = "disposed";
    const closing = server;
    server = undefined;
    // bye best-effort: el host se va; el daemon reconecta (el retry es suyo).
    for (const socket of Array.from(liveSockets)) {
      send(socket, { type: "bye", reason: "host-shutdown" });
      socket.destroy();
    }
    liveSockets.clear();
    if (closing) {
      await new Promise<void>((resolve) => {
        closing.close(() => resolve());
      });
    }
    // Solo el dueño borra sus archivos: en `conflict` el socket/token vivos
    // pertenecen al host que ganó la carrera.
    if (ownsFiles) {
      await unlink(socketPath()).catch(() => undefined);
      await unlink(tokenPath()).catch(() => undefined);
      ownsFiles = false;
    }
    currentToken = "";
  }

  return {
    start,
    dispose,
    getState: () => state,
    getSocketPath: socketPath,
  };
}
