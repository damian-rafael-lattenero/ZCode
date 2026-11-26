/* [fork] B3a — "daemon local" channel (ADR-022): the ONLY read and write path
 * into the REAL conversation for the bot's Kotlin daemon.
 * A unix socket (~/.zcode/daemon-local.sock) exposed by the Host (utility
 * process — NEVER Electron's main):
 *   inbound   → IBotsService.handleInboundMessage (the SAME path as the composer)
 *   stream    → IZCodeTaskService.onDynamicTaskEvent("bot-channel-continuous"),
 *               the raw V4 events the desktop renders, with no replay.
 *   queries   → listTasks/taskList/meta/snapshot/usage/quota/botStatus/modelSelection
 *   control   → stop / stopAll / compact / setModelSelection (V4 & friends)
 *   respond   → the owner answers permission/elicitation/plan from the phone
 *   steer     → the owner redirects a RUNNING turn with guidance text
 * Auth: token in ~/.zcode/daemon-local.token (0600, rotated on every host
 * boot); hello mandatory on the first line. The socket is also 0600.
 * Full spec: docs/fork/DAEMON-CHANNEL.md.
 *
 * oxlint-disable eslint(max-lines) -- the channel IS the protocol's complete
 * surface (frame loop, auth, queries, control, respond, steer) split into
 * cohesive handlers; extracting it into sibling files would break the linear
 * reading of a single message flow. Same as botsService.ts / node.ts.
 */
/* oxlint-disable eslint(max-lines) */
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
  DAEMON_CHANNEL_MODES,
  DAEMON_CHANNEL_PROTOCOL_VERSION,
  DAEMON_CHANNEL_PROVIDER,
  DAEMON_CHANNEL_PROVIDER_USER_ID,
  DAEMON_CHANNEL_SOCKET_FILENAME,
  DAEMON_CHANNEL_STREAM_KEEPALIVE_INTERVAL_MS,
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
  type DaemonChannelCodingPlanGiftsResult,
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
import type { ICodingPlanSubscriptionService } from "../coding-plan-subscription/codingPlanSubscription.js";
import type { IMarketingTouchService } from "../marketing-touch/marketingTouch.js";
import type { ServiceLogger } from "../logger/serviceLogger.js";
import { createServiceLogger } from "../logger/serviceLogger.js";
import { getZCodeDataRootDir } from "../paths.js";

/** [fork] env kill-switch for the channel (default: enabled). */
export const DAEMON_CHANNEL_DISABLE_ENV = "ZCODE_DAEMON_LOCAL_CHANNEL";

export interface DaemonLocalChannelDeps {
  botsService: IBotsService;
  zcodeTaskService: IZCodeTaskService;
  usageStatsService?: Pick<
    IUsageStatsService,
    "getEntitlementSnapshot" | "getCodingPlanResetStatus" | "useCodingPlanReset"
  >;
  /** [fork] The claimable-offers plane (preview) — additive 2026-11-03 (A5). */
  codingPlanSubscriptionService?: Pick<
    ICodingPlanSubscriptionService,
    "getManualClaimPlanPreviews" | "claimManualPlan"
  >;
  /** [fork] The marketing banner offers (claim_zcode_plan) — additive 2026-11-03. */
  marketingTouchService?: Pick<IMarketingTouchService, "query">;
  /** View of the plans/models registry and the global default (for the bot's /plan). */
  modelSelectionService?: DaemonChannelModelSelectionDeps["modelSelectionService"];
  modelSelectionDefault?: DaemonChannelModelSelectionDeps["modelSelectionDefault"];
  logger?: ServiceLogger;
  /** Injectable for hermetic tests; default: the real data root (~/.zcode). */
  dataRootDir?: () => string;
  env?: Record<string, string | undefined>;
  now?: () => number;
  /** Injectable for tests; default: DAEMON_CHANNEL_HANDSHAKE_TIMEOUT_MS. */
  handshakeTimeoutMs?: number;
  /**
   * stream_keepalive heartbeat interval per live subscription (additive 2026-10-30).
   * Injectable for tests; default: DAEMON_CHANNEL_STREAM_KEEPALIVE_INTERVAL_MS.
   * 0 disables it. Old consumers ignore the new frame: the default
   * can stay always on.
   */
  streamKeepaliveIntervalMs?: number;
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
 * The accountAccess hint for the conversation's ACTIVE providerId: the
 * static shape with `mode` triggers the DYNAMIC resolution of the real access
 * in the provider (resolveRequestAccountAccess reads the current account
 * connection — the hint points, the service answers with the truth). Null for
 * providers that are not plan-based (the generic path is the right one there).
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

/** [fork] A5 — the resets plane's error → a STABLE reason (never the raw msg). */
function resetUnavailableReason(
  error: unknown,
): "not_authenticated" | "not_configured" | "request_failed" {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("account_access_required") || message.includes("not_configured")) {
    return "not_configured";
  }
  if (message.includes("jwt_required") || message.includes("not_authenticated")) {
    return "not_authenticated";
  }
  const status =
    typeof error === "object" && error !== null && "status" in error
      ? (error as { status?: unknown }).status
      : undefined;
  if (status === 401 || status === 403) return "not_authenticated";
  return "request_failed";
}

/** [fork] A5 — the offers preview's error → a STABLE reason. */
function claimUnavailableReason(error: unknown): "not_authenticated" | "request_failed" {
  const message = error instanceof Error ? error.message : String(error);
  if (
    message.includes("not_authenticated") ||
    message.includes("jwt") ||
    message.includes("unauthorized") ||
    message.includes("login")
  ) {
    return "not_authenticated";
  }
  const status =
    typeof error === "object" && error !== null && "status" in error
      ? (error as { status?: unknown }).status
      : undefined;
  if (status === 401 || status === 403) return "not_authenticated";
  return "request_failed";
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
  // [fork] "go to background" — demote of the running primaryTurn (v4
  // backgroundTurn); the turn keeps executing, ownership moves to background.
  "backgroundTurn",
  // [fork] per-tool "go to background" (v4 backgroundToolCall): one running
  // tool call (Bash process or in-flight Agent) moves to the background.
  "backgroundToolCall",
  "compact",
  "contextWindow",
  // [fork] A4 — the bot's /mode (plan 🗺 / yolo 🔓).
  "setMode",
  // [fork] A5 — the coding plan gifts: read them, SPEND a reset and
  // CLAIM an offer.
  "codingPlanGifts",
  "useCodingPlanReset",
  "claimCodingPlan",
]);

function buildDaemonBotConfig(existing?: BotConfig): BotConfig {
  return (
    existing ?? {
      id: DAEMON_CHANNEL_DEFAULT_BOT_ID,
      name: "Daemon local",
      provider: DAEMON_CHANNEL_PROVIDER,
      enabled: true,
      // The socket actor is fixed: provider "daemon", user "daemon".
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
      // Irrelevant in practice: the null adapter discards the outputs.
      replyMode: "assistant_changes",
    }
  );
}

/** true if someone is listening on the path (another live host owns it). */
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
  // Ownership of the on-disk files: ONLY whoever did listen+token may
  // delete them in dispose. A host that lost the race (conflict) must not
  // unlink the live host's socket/token.
  let ownsFiles = false;
  const liveSockets = new Set<Socket>();
  const startedAt = now();
  const daemonBotIdCache = { id: DAEMON_CHANNEL_DEFAULT_BOT_ID, enabled: true };
  // Inbound dedupe by messageId, with the same window as Telegram's offset.
  const recentInboundByMessageId = new Map<string, number>();
  // Respond dedupe by messageId (the same law — additive 2026-10-30, a daemon
  // retry after losing the ACK does not re-resolve the interaction).
  const recentRespondByMessageId = new Map<string, number>();
  const capabilities = [
    "inbound",
    // THE ATOMIC BIND (additive, 2026-11-02): inbound.bindTaskId — the context is
    // pointed with the /task law and the text flies afterwards; the refusal travels
    // in the inbound_result replies.
    "bind",
    // STEERABLE SUBAGENTS (additive, 2026-11-02): inbound/steer with
    // taskId = sess_subagent_<agentId> deliver the order to the LIVE subagent
    // (through its owning session's runtime — the SAME door as the SendMessage tool)
    // and the stop query with that taskId stops THAT subagent, not the parent. An
    // unresolvable child is rejected honestly: it never falls back to the parent.
    "subagents",
    "stream",
    "queries:listTasks",
    "queries:taskList",
    "queries:taskMeta",
    "queries:taskSnapshot",
    "queries:taskUsage",
    "queries:quota",
    // [fork] additive 11/11: per-plan quota — the quota frame accepts a
    // providerId overriding the active selection's (the bot's /plan rows
    // ask each plan's quota before choosing one).
    "queries:quotaProvider",
    "queries:botStatus",
    "queries:modelSelection",
    "queries:contextWindow",
    "control:setModelSelection",
    "control:setMode",
    // A5 (additive 2026-11-03): the /quota 🎁 — read the gifts plane and
    // spend ONE granted reset (irreversible, idempotency-keyed).
    "queries:codingPlanGifts",
    "control:useCodingPlanReset",
    "control:claimCodingPlan",
    "control:stop",
    "control:stopAll",
    "control:compact",
    "respond",
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
    // Add-if-absent only: if Damian disables or deletes it from the Bots dialog,
    // the decision persists (the gates are "enabled" and the env kill-switch).
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
    // writeFile does not change an existing file's mode: explicit chmod.
    await chmod(tokenPath(), DAEMON_CHANNEL_FILE_MODE);
  }

  /** Workspace fallback for the queries that require it: the bot's active context. */
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
   * The conversation's REAL context meter (query `contextWindow`, the bot's
   * /context_window): runtime.contextUsage of the snapshot — the SAME
   * source that restores the desktop meter (contextUsageFromRuntime ??
   * contextUsageFromProjection of the adapter), NEVER the summary's running
   * total (getTaskTokenUsage is another thing). Fallback window: the model
   * registry's properties.contextWindow. Honest by contract: what the
   * host does not know travels null — used=0 is initialization, not data.
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
      // Only the meter matters: 1 message keeps the payload light.
      messageLimit: 1,
    });
    if (!snapshot) {
      throw new Error(`task ${taskId} has no snapshot to read the context meter from`);
    }
    const selection = await taskService.getTaskModelSelection({ taskId }).catch(() => null);
    const usage = snapshot.runtime?.contextUsage;
    const usedTokens = usage && usage.used > 0 ? usage.used : null;
    // The window PRECEDENCE, corrected 2026-10-30 (the owner saw 200K/200K
    // with 1M models): the registry's contextWindow is the model's REAL window
    // — the runtime size turned out to be a per-segment cap.
    // Registry first, runtime as fallback, and the owner's calibration
    // (his models are 1M maximum) when nothing exposes it — marked so the
    // client shows it as approximate, never as a fact.
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

  /**
   * [fork] A5 — the coding plan's account for the gifts. The reset requires
   * `preferredProviderId` + accountAccess; the bot's conversation may be
   * on ANOTHER provider (e.g. OpenCode), so they are tried in order:
   * the conversation's selection, the app's default and the registry.
   * Only real coding plan plans (Start Plan is left out: it has no
   * resets). Null → the host says not_configured (honest, it never guesses).
   */
  async function codingPlanProviderIdFor(taskId?: string): Promise<string | null> {
    const candidates: string[] = [];
    if (taskId) {
      const selection = await deps.zcodeTaskService
        .getTaskModelSelection({ taskId })
        .catch(() => null);
      if (selection?.providerId) candidates.push(selection.providerId);
    }
    const configured = await deps.modelSelectionDefault?.read().catch(() => undefined);
    if (configured?.providerId) candidates.push(configured.providerId);
    const view = await deps.modelSelectionService?.getView().catch(() => undefined);
    if (view) candidates.push(...view.providers.map((provider) => provider.providerId));
    return (
      candidates.find(
        (providerId) =>
          isCodingPlanModelProviderId(providerId) && !isStartPlanModelProviderId(providerId),
      ) ?? null
    );
  }

  /** [fork] A5 — the gifts plane: two independent reads, one failing does not kill the other. */
  async function readCodingPlanGifts(taskId?: string): Promise<DaemonChannelCodingPlanGiftsResult> {
    const usage = deps.usageStatsService;
    const subscription = deps.codingPlanSubscriptionService;
    const providerId = await codingPlanProviderIdFor(taskId);
    const hint = providerId ? accountAccessHintFor(providerId) : null;
    const resetPromise =
      usage?.getCodingPlanResetStatus && providerId && hint
        ? usage.getCodingPlanResetStatus({ preferredProviderId: providerId, accountAccess: hint })
        : Promise.reject(new Error("coding_plan_reset_account_access_required"));
    const claimPromise = subscription
      ? subscription.getManualClaimPlanPreviews()
      : Promise.reject(new Error("coding_plan_claim_preview_unavailable"));
    const offersPromise = readMarketingOffers();
    const [reset, claim, offers] = await Promise.allSettled([
      resetPromise,
      claimPromise,
      offersPromise,
    ]);
    const unavailable: NonNullable<DaemonChannelCodingPlanGiftsResult["unavailable"]> = {};
    const result: DaemonChannelCodingPlanGiftsResult = { reset: null, claimable: null };
    if (reset.status === "fulfilled") {
      result.reset = {
        fiveHour: reset.value.availableFiveHourResets.map((item) => ({ expireAt: item.expireAt })),
        week: reset.value.availableWeekResets.map((item) => ({ expireAt: item.expireAt })),
        latestFiveHourUsedAt: reset.value.latestFiveHourResetHistory?.usedAt ?? null,
        latestWeekUsedAt: reset.value.latestWeekResetHistory?.usedAt ?? null,
        hasUnreadHistory: reset.value.hasUnreadHistory,
      };
    } else {
      unavailable.reset = resetUnavailableReason(reset.reason);
    }
    if (claim.status === "fulfilled") {
      result.claimable = {
        ...(claim.value.serverTime !== undefined ? { serverTime: claim.value.serverTime } : {}),
        plans: claim.value.plans.map((plan) => ({
          planId: plan.planId,
          name: plan.name,
          description: plan.description,
          priority: plan.priority,
          entitlements: plan.entitlements.map((entitlement) => ({
            entitlementId: entitlement.entitlementId,
            showName: entitlement.showName,
            meter: entitlement.meter,
            unitType: entitlement.unitType,
            capabilities: [...entitlement.capabilities],
            grantUnits: entitlement.grantUnits,
            period: entitlement.period,
            ...(entitlement.effectiveAt !== undefined
              ? { effectiveAt: entitlement.effectiveAt }
              : {}),
          })),
        })),
      };
    } else {
      unavailable.claimable = claimUnavailableReason(claim.reason);
    }
    if (offers.status === "fulfilled" && offers.value.length > 0) {
      result.offers = offers.value;
    }
    if (Object.keys(unavailable).length > 0) result.unavailable = unavailable;
    return result;
  }

  /**
   * [fork] A5 — the marketing banner offers whose action is
   * "claim_zcode_plan" (the SAME surface as the app's "Claim" button).
   * It is only read when the client already asked for gifts (/quota): no service or
   * no banner means silence — never an error in the owner's face.
   */
  async function readMarketingOffers(): Promise<
    Array<{ planId: string; label: string; campaignId: string }>
  > {
    const service = deps.marketingTouchService;
    if (!service) return [];
    const snapshot = await service.query({ locale: "en-US" });
    const offers: Array<{ planId: string; label: string; campaignId: string }> = [];
    for (const delivery of snapshot.deliveries) {
      const buttons =
        delivery.resource_position === "banner" ? delivery.banner.buttons : delivery.popup.buttons;
      for (const button of buttons) {
        if (button.action.type !== "claim_zcode_plan") continue;
        offers.push({
          planId: button.action.args.plan_id,
          label: button.text.content.trim(),
          campaignId: delivery.campaign_id,
        });
        break;
      }
    }
    return offers;
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
        // The bot reads the OWNER's quota: the providerId comes from its active
        // conversation's model selection → the {mode: …} hint whose shape triggers the
        // DYNAMIC resolution of the real access in the provider (resolveRequest-
        // AccountAccess). Without the hint, the Start Plan path never enters and the
        // answer is the lying not_configured (measured live 2026-10-30).
        // [fork] The per-plan override (additive, 11/11): when the frame
        // carries a providerId, THAT plan's quota is the one being read —
        // the accountAccess hint comes from it and the active selection is
        // no longer consulted. Without it, the historical path: the active
        // conversation's provider decides.
        const requested = query.providerId?.trim();
        const selection =
          !requested && query.taskId
            ? await taskService.getTaskModelSelection({ taskId: query.taskId }).catch(() => null)
            : null;
        const providerId = requested || selection?.providerId;
        const hint = providerId ? accountAccessHintFor(providerId) : null;
        return deps.usageStatsService.getEntitlementSnapshot({
          ...(query.invalidateBalanceCache ? { invalidateBalanceCache: true } : {}),
          ...(providerId && hint
            ? {
                preferredProviderId: providerId,
                accountAccess: hint,
                allowDisabledPreferredProvider: true,
              }
            : {}),
        });
      }
      case "codingPlanGifts":
        return readCodingPlanGifts(query.taskId);
      case "useCodingPlanReset": {
        const usage = deps.usageStatsService;
        if (!usage?.useCodingPlanReset) throw new Error("usage stats service is unavailable");
        const providerId = await codingPlanProviderIdFor(query.taskId);
        const hint = providerId ? accountAccessHintFor(providerId) : null;
        if (!providerId || !hint) {
          throw new Error("coding_plan_reset_account_access_required");
        }
        return usage.useCodingPlanReset({
          preferredProviderId: providerId,
          accountAccess: hint,
          resetType: query.resetType,
          idempotencyKey: query.idempotencyKey.trim(),
        });
      }
      case "claimCodingPlan": {
        const subscription = deps.codingPlanSubscriptionService;
        if (!subscription?.claimManualPlan) {
          throw new Error("coding plan subscription service is unavailable");
        }
        // The service answers {success, code, message, plan?}: a 401 without
        // a JWT or a 1001-1005 from the server is the verdict, not an exception.
        return subscription.claimManualPlan({ planId: query.planId.trim() });
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
      case "backgroundTurn": {
        // [fork] "go to background" (v4 backgroundTurn): demote of the RUNNING
        // primaryTurn — the turn keeps executing, only foreground ownership
        // moves. Non-CAS; idle/mismatch comes back as a noop ACK (the CLI's
        // "guard.stopTargetChanged") instead of an error, and the wire result
        // mirrors stop's: `{ backgrounded: [...] }` on success, an empty list
        // + reasonCode on the noop.
        const ack = await taskService.backgroundTurn({
          taskId: query.taskId,
          ...(query.expectedForegroundExecutionId
            ? { expectedForegroundExecutionId: query.expectedForegroundExecutionId }
            : {}),
        });
        return ack.status === "noop"
          ? { backgrounded: [], reasonCode: ack.reasonCode ?? "guard.stopTargetChanged" }
          : { backgrounded: [query.taskId] };
      }
      case "backgroundToolCall": {
        // [fork] per-tool "go to background" (v4 backgroundToolCall): ONE
        // running tool call (Bash process or in-flight Agent) moves to the
        // background and the model continues in the same turn. Same honest
        // noop contract as backgroundTurn, but the wire names the tool call.
        const ack = await taskService.backgroundToolCall({
          taskId: query.taskId,
          toolCallId: query.toolCallId,
        });
        return ack.status === "noop"
          ? { backgrounded: [], reasonCode: ack.reasonCode ?? "guard.stopTargetChanged" }
          : { backgrounded: [query.toolCallId] };
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
      case "setMode": {
        // [fork] A4 — the conversation's collaboration MODE (plan/yolo/…)
        // through the SAME path as the UI switch (the task service validates the
        // mode against its vocabulary and uses switchCollaborationMode with
        // revision convergence). The channel already rejected unknown modes as
        // bad_request; a task that is not loaded throws the service's honest error
        // (ZCODE_SESSION_TARGET_NOT_FOUND).
        await taskService.setMode({ taskId: query.taskId, mode: query.mode });
        return { taskId: query.taskId, mode: query.mode };
      }
      default: {
        // Exhaustiveness: a new shared query without a branch here is a host bug.
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
    // Dedupe by messageId: a daemon retry after losing the response does NOT
    // resend the prompt to the real conversation (at-least-once with idempotency
    // on the expensive part — same window as Telegram's confirmed offset).
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
    // THE ATOMIC BIND (additive, 2026-11-02): with bindTaskId the bot's context is
    // pointed FIRST at that task (bindTaskForDaemonChannel — the full /task
    // law: project/fixed-cwd boundary + taskRunning verdict) and the
    // text flies AFTERWARDS over the usual routing. The refusal travels as the
    // SINGLE inbound_result reply ("taskRunning" / "Task not found") — the
    // verdict the bot's sendInboundAwait already knows how to read; the text is
    // NOT delivered if the bind fails. The order (taskId) wins if both come.
    if (message.bindTaskId && !message.taskId) {
      void deps.botsService
        .bindTaskForDaemonChannel(inbound, message.bindTaskId)
        .then(async (bind) => {
          if (!bind.ok) {
            send(connection.socket, {
              type: "inbound_result",
              id: message.id,
              duplicate: false,
              replies: bind.refusals.map(toWireReply),
            });
            return;
          }
          const replies = await deps.botsService.handleInboundMessage(inbound);
          send(connection.socket, {
            type: "inbound_result",
            id: message.id,
            replies: replies.map(toWireReply),
          });
        })
        .catch((error: unknown) => {
          logger.warn(
            undefined,
            `bind inbound failed messageId=${message.messageId ?? ""}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          sendError(connection, connection.socket, {
            type: "error",
            id: message.id,
            code: "internal",
            message: `bind to ${message.bindTaskId} failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          });
        });
      return;
    }
    // THE DIRECTED ORDER (additive, 2026-10-30): with taskId the text goes DIRECT to
    // that session (sendPrompt) — the owner's order to an attached subagent;
    // its response comes back over the session's stream, which the attached card
    // already shows. Without taskId: the usual routing (botsService).
    if (message.taskId) {
      void deps.zcodeTaskService
        .sendPrompt({
          taskId: message.taskId,
          traceId: `daemon-ord-${message.id}`,
          content: message.text,
          clientId: connection.clientId ?? "daemon-channel",
          clientLabel: "daemon-channel-order",
        })
        .then(() => {
          send(connection.socket, {
            type: "inbound_result",
            id: message.id,
            duplicate: false,
            replies: [],
          });
        })
        .catch((error: unknown) => {
          sendError(connection, connection.socket, {
            type: "error",
            id: message.id,
            code: "internal",
            message: `order to ${message.taskId} failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          });
        });
      return;
    }
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

  /**
   * The owner's ANSWER (additive 2026-10-30): the loop closes. The `respond`
   * frame routes to the SAME API the desktop UI calls for the event's task —
   * respondPermission (optionId + the event option's response, or the
   * derived {decision} when the client does not carry it) /
   * respondElicitation (action + content; kind "plan" is the ExitPlanMode
   * approval through the SAME elicitation door — the CLI interaction-broker
   * maps action accept/decline). The event's requestId IS the
   * broker's interactionId (same registration source).
   *
   * Dedupe by messageId: the SAME inbound law — a daemon retry
   * after losing the ACK does NOT re-resolve the interaction. The ACK is HONEST:
   * respond_result ok=true ONLY after the v4 command's ACK; the failure
   * (unknown interactionId, already-resolved interaction, task without a target —
   * the turn sealed and the buttons were left orphaned) travels AS AN ERROR and the
   * client edits the question message with the truth: never a lying ok,
   * never a silent tap.
   */
  function handleRespondRequest(
    connection: DaemonConnection,
    message: Extract<DaemonChannelClientMessage, { type: "respond" }>,
  ): void {
    if (message.kind === "permission" && !message.optionId) {
      sendError(connection, connection.socket, {
        type: "error",
        id: message.id,
        code: "bad_request",
        message: "respond permission requires optionId",
      });
      return;
    }
    if (message.kind === "elicitation" && !message.action) {
      sendError(connection, connection.socket, {
        type: "error",
        id: message.id,
        code: "bad_request",
        message: "respond elicitation requires action",
      });
      return;
    }
    if (message.messageId) {
      const key = `respond:${daemonBotIdCache.id}:${message.messageId}`;
      const seenAt = recentRespondByMessageId.get(key);
      const current = now();
      if (seenAt !== undefined && current - seenAt < DAEMON_CHANNEL_INBOUND_DEDUPE_TTL_MS) {
        recentRespondByMessageId.set(key, current);
        send(connection.socket, {
          type: "respond_result",
          id: message.id,
          taskId: message.taskId,
          requestId: message.requestId,
          kind: message.kind,
          ok: true,
        });
        return;
      }
      recentRespondByMessageId.set(key, current);
      if (recentRespondByMessageId.size > 512) {
        const cutoff = current - DAEMON_CHANNEL_INBOUND_DEDUPE_TTL_MS;
        for (const [entryKey, at] of recentRespondByMessageId) {
          if (at < cutoff) recentRespondByMessageId.delete(entryKey);
        }
      }
    }
    const answer: Promise<boolean> =
      message.kind === "permission"
        ? deps.zcodeTaskService.respondPermission({
            taskId: message.taskId,
            requestId: message.requestId,
            optionId: message.optionId as string,
            response:
              message.response ??
              // The host's own rule (permissionResolvedPayloadToStreamEvents):
              // deny → deny, anything else → allow.
              { decision: message.optionId === "deny" ? "deny" : "allow" },
          })
        : deps.zcodeTaskService.respondElicitation({
            taskId: message.taskId,
            requestId: message.requestId,
            action: message.action ?? "accept",
            ...(message.content ? { content: message.content } : {}),
          });
    void answer
      .then((ok) => {
        send(connection.socket, {
          type: "respond_result",
          id: message.id,
          taskId: message.taskId,
          requestId: message.requestId,
          kind: message.kind,
          ok,
        });
      })
      .catch((error: unknown) => {
        logger.warn(
          undefined,
          `respond ${message.kind} task=${message.taskId} request=${message.requestId} failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        sendError(connection, connection.socket, {
          type: "error",
          id: message.id,
          code: "internal",
          message: `respond ${message.kind} ${message.requestId} failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        });
      });
  }

  /**
   * STEER (additive, 2026-10-30): redirect the turn IN PROGRESS — the `steer`
   * frame {taskId, text} sends the text to the task service with delivery "guide"
   * (requestedDelivery=guide in the v4 sendText payload), and the CLI
   * admission injects it INSIDE the running turn (turn.steerQueued →
   * turn.steerDrained at the next tool boundary). Idle → the CLI
   * starts a normal turn with the same text (the guide is not lost). The
   * ACK is the SAME inbound_result as inbound (empty replies) — the
   * turn's fate is told by the STREAM, not by the ack. The failure travels AS AN
   * ERROR (unknown task, no target) — never a lying ok.
   */
  function handleSteerRequest(
    connection: DaemonConnection,
    message: Extract<DaemonChannelClientMessage, { type: "steer" }>,
  ): void {
    if (!message.taskId || !message.text.trim()) {
      sendError(connection, connection.socket, {
        type: "error",
        id: message.id,
        code: "bad_request",
        message: "steer requires taskId and text",
      });
      return;
    }
    void deps.zcodeTaskService
      .sendPrompt({
        taskId: message.taskId,
        traceId: `daemon-steer-${message.id}`,
        content: message.text,
        clientId: connection.clientId ?? "daemon-channel",
        clientLabel: "daemon-channel-steer",
        requestedDelivery: "guide",
      })
      .then(() => {
        send(connection.socket, {
          type: "inbound_result",
          id: message.id,
          duplicate: false,
          replies: [],
        });
      })
      .catch((error: unknown) => {
        logger.warn(
          undefined,
          `steer task=${message.taskId} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        sendError(connection, connection.socket, {
          type: "error",
          id: message.id,
          code: "internal",
          message: `steer to ${message.taskId} failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
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
    // Re-subscribing the same task replaces the previous subscription.
    connection.subscriptions.get(message.taskId)?.dispose();
    const dynamicTaskEvent =
      (deps.zcodeTaskService as Partial<Pick<IZCodeTaskService, "onDynamicTaskEvent">>)
        .onDynamicTaskEvent;
    // deliveryKind bot-channel-continuous: the same V4 events as the desktop
    // (the tool_input_* projection included), with no mobile snapshot/gap replay.
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
      // Broken socket: the subscription dies with the connection (continuous, no replay).
      if (!delivered) {
        connection.subscriptions.get(message.taskId)?.dispose();
        connection.subscriptions.delete(message.taskId);
      }
    });
    // [fork 2026-10-30] Heartbeat per live subscription: the consumer tells
    // "quiet model" from "dead bus" (contract in DaemonChannelStreamKeepaliveFrame).
    // The seq shares the connection's monotonic counter; a broken socket kills the
    // subscription just like in stream_event. The timer is unref'd: it never blocks the
    // host shutdown on its own.
    const keepaliveIntervalMs = deps.streamKeepaliveIntervalMs ?? DAEMON_CHANNEL_STREAM_KEEPALIVE_INTERVAL_MS;
    let keepaliveTimer: ReturnType<typeof setInterval> | undefined;
    if (keepaliveIntervalMs > 0) {
      keepaliveTimer = setInterval(() => {
        connection.seq += 1;
        const delivered = send(connection.socket, {
          type: "stream_keepalive",
          taskId: message.taskId,
          seq: connection.seq,
          at: now(),
        });
        if (!delivered) {
          connection.subscriptions.get(message.taskId)?.dispose();
          connection.subscriptions.delete(message.taskId);
        }
      }, keepaliveIntervalMs);
      keepaliveTimer.unref?.();
    }
    const disposableWithKeepalive = {
      dispose() {
        if (keepaliveTimer) {
          clearInterval(keepaliveTimer);
          keepaliveTimer = undefined;
        }
        disposable.dispose();
      },
    };
    connection.subscriptions.set(message.taskId, disposableWithKeepalive);
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
      case "respond":
        handleRespondRequest(connection, message);
        return;
      case "steer":
        handleSteerRequest(connection, message);
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
        // [fork] A4 — setMode validates the mode AT THE EDGE: the adapter maps an
        // unknown mode to "build" (its historical fallback), and a /mode with a
        // typo must not silently degrade the conversation.
        if (
          message.query.kind === "setMode" &&
          !(DAEMON_CHANNEL_MODES as readonly string[]).includes(
            (message.query as { mode?: unknown }).mode as string,
          )
        ) {
          sendError(connection, socket, {
            type: "error",
            id: message.id,
            code: "bad_request",
            message: `unknown mode: ${JSON.stringify((message.query as { mode?: unknown }).mode)} — expected one of ${DAEMON_CHANNEL_MODES.join(", ")}`,
          });
          return;
        }
        // [fork] A5 — useCodingPlanReset validates AT THE EDGE: an unknown
        // resetType or an invalid idempotency key is rejected BEFORE
        // touching the account — spending a reset is irreversible.
        if (message.query.kind === "useCodingPlanReset") {
          const candidate = message.query as { resetType?: unknown; idempotencyKey?: unknown };
          const key =
            typeof candidate.idempotencyKey === "string" ? candidate.idempotencyKey.trim() : "";
          if (candidate.resetType !== "FIVE_HOUR" && candidate.resetType !== "WEEK") {
            sendError(connection, socket, {
              type: "error",
              id: message.id,
              code: "bad_request",
              message: `unknown resetType: ${JSON.stringify(candidate.resetType)} — expected FIVE_HOUR or WEEK`,
            });
            return;
          }
          if (key.length === 0 || key.length > 64) {
            sendError(connection, socket, {
              type: "error",
              id: message.id,
              code: "bad_request",
              message: "idempotencyKey must be 1..64 chars",
            });
            return;
          }
        }
        // [fork] A5 — claimCodingPlan: an empty planId never travels to billing.
        if (message.query.kind === "claimCodingPlan") {
          const planId =
            typeof (message.query as { planId?: unknown }).planId === "string"
              ? (message.query as { planId: string }).planId.trim()
              : "";
          if (planId.length === 0 || planId.length > 128) {
            sendError(connection, socket, {
              type: "error",
              id: message.id,
              code: "bad_request",
              message: "planId must be 1..128 chars",
            });
            return;
          }
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
        // Already authenticated: answering hello_ok keeps the session alive (idempotent re-handshake).
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

    // First live host wins the socket: probe the old file BEFORE rotating
    // the token (the live token must belong to the process that owns the socket).
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
    // From here on the socket is ours (listen ok): dispose may unlink it,
    // even if the token step fails afterwards.
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
    // bye best-effort: the host is leaving; the daemon reconnects (retry is its job).
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
    // Only the owner deletes its files: in `conflict` the live socket/token
    // belong to the host that won the race.
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
