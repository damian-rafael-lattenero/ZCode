/* [fork] B3a — plan/model/effort for the "daemon local" channel (the bot's /plan).
 * Reading and writing the model selection across its two scopes:
 *  - "conversation": botsService.get/setBotModelSelection — the SAME write
 *    path as /model and /effort (draftOptions or setModel/setConfigOption).
 *  - "default": NodeModelSelectionConfigRepository.saveConfiguredDefault — the
 *    app's global default (defaultModelSelection of the personal config).
 * Shapes in @zcode/shared (daemon-channel.ts); spec: docs/fork/DAEMON-CHANNEL.md.
 */
import type {
  DaemonChannelModelSelectionInfo,
  DaemonChannelModelSelectionPlan,
  DaemonChannelModelSelectionResult,
  DaemonChannelQuery,
  ModelSelection,
} from "@zcode/shared";
import type { IBotsService } from "./bots.js";
import type {
  IModelSelectionService,
  ModelSelectionView,
} from "../model-provider/providerFacadeServices.js";

export interface DaemonChannelModelSelectionDeps {
  botsService: Pick<IBotsService, "getBotModelSelection" | "setBotModelSelection">;
  /** The channel's bot id (the actor of the selection ops). */
  botId: string;
  modelSelectionService?: Pick<IModelSelectionService, "getView">;
  modelSelectionDefault?: {
    read(): Promise<ModelSelection | undefined>;
    saveConfiguredDefault(
      selection: ModelSelection | undefined,
    ): Promise<ModelSelection | undefined>;
  };
  /** Workspace of the bot's active context (fallback when the frame does not carry it). */
  resolveContextWorkspace(): Promise<
    { workspacePath: string; workspaceIdentity?: string } | undefined
  >;
}

export interface DaemonChannelModelSelectionHandler {
  read(query: Extract<DaemonChannelQuery, { kind: "modelSelection" }>): Promise<DaemonChannelModelSelectionResult>;
  set(query: Extract<DaemonChannelQuery, { kind: "setModelSelection" }>): Promise<DaemonChannelModelSelectionResult>;
}

function projectModelSelectionInfo(
  selection: ModelSelection | undefined | null,
): DaemonChannelModelSelectionInfo | null {
  if (!selection?.providerId || !selection?.modelId) return null;
  return {
    providerId: selection.providerId,
    modelId: selection.modelId,
    ...(selection.options?.reasoningLevel
      ? { reasoningLevel: selection.options.reasoningLevel }
      : {}),
  };
}

function projectModelPlans(view: ModelSelectionView): DaemonChannelModelSelectionPlan[] {
  return view.providers
    .filter((provider) => provider.models.length > 0)
    .map((provider) => ({
      providerId: provider.providerId,
      label: provider.providerName?.trim() || provider.providerId,
      // Each model's real effort vocabulary travels in the response: it is the
      // SAME catalog that validates setModelSelection (setDefault/assertEffortAllowed).
      // Without this the client cannot mark 🎯 on the current effort (e.g. "max").
      models: provider.models.map((model) => {
        const levels = model.config.optionSpecs.reasoningLevel.values;
        return {
          id: model.modelId,
          label: model.modelId,
          ...(levels.length > 0 ? { reasoningLevels: [...levels] } : {}),
        };
      }),
    }));
}

export function createDaemonChannelModelSelectionHandler(
  deps: DaemonChannelModelSelectionDeps,
): DaemonChannelModelSelectionHandler {
  /** Workspace for modelSelection/setModelSelection: explicit or the active context. */
  async function resolveWorkspace(query: {
    workspacePath?: string;
    workspaceIdentity?: string;
  }): Promise<{ workspacePath?: string; workspaceIdentity?: string } | undefined> {
    if (query.workspacePath) {
      return { workspacePath: query.workspacePath, workspaceIdentity: query.workspaceIdentity };
    }
    if (query.workspaceIdentity) return { workspaceIdentity: query.workspaceIdentity };
    return deps.resolveContextWorkspace();
  }

  async function conversationContextRef(query: {
    workspacePath?: string;
    workspaceIdentity?: string;
  }) {
    const workspace = await resolveWorkspace(query);
    return {
      botId: deps.botId,
      ...(workspace?.workspacePath ? { workspacePath: workspace.workspacePath } : {}),
      ...(workspace?.workspaceIdentity
        ? { workspaceIdentity: workspace.workspaceIdentity }
        : {}),
    };
  }

  /** Common result of modelSelection/setModelSelection: selection + global default + plans. */
  async function buildResult(
    scope: "conversation" | "default",
    conversation: Awaited<ReturnType<IBotsService["getBotModelSelection"]>>,
  ): Promise<DaemonChannelModelSelectionResult> {
    const [defaultSelection, view] = await Promise.all([
      deps.modelSelectionDefault?.read().catch(() => undefined),
      deps.modelSelectionService?.getView().catch(() => null),
    ]);
    return {
      scope,
      selection: conversation.selection,
      default: projectModelSelectionInfo(defaultSelection),
      plans: view ? projectModelPlans(view) : [],
    };
  }

  return {
    async read(query) {
      const conversation = await deps.botsService.getBotModelSelection(
        await conversationContextRef(query),
      );
      return buildResult("conversation", conversation);
    },

    async set(query) {
      if (query.scope === "default") {
        return setDefault(query);
      }
      const contextRef = await conversationContextRef(query);
      await deps.botsService.setBotModelSelection({
        ...contextRef,
        ...(query.plan !== undefined ? { plan: query.plan } : {}),
        ...(query.model !== undefined ? { model: query.model } : {}),
        ...(query.effort !== undefined ? { effort: query.effort } : {}),
      });
      const conversation = await deps.botsService.getBotModelSelection(contextRef);
      return buildResult("conversation", conversation);
    },
  };

  /** CONTROL scope="default": the app's global default (defaultModelSelection). */
  async function setDefault(
    query: Extract<DaemonChannelQuery, { kind: "setModelSelection" }>,
  ): Promise<DaemonChannelModelSelectionResult> {
    if (!deps.modelSelectionDefault) {
      throw new Error("model selection default source is unavailable in this host");
    }
    const current = await deps.modelSelectionDefault.read().catch(() => undefined);
    const wantsIdentity = query.plan !== undefined || query.model !== undefined;
    const base = wantsIdentity
      ? {
          providerId: query.plan ?? current?.providerId,
          modelId: query.model ?? current?.modelId,
        }
      : current;
    if (!base?.providerId || !base?.modelId) {
      throw new Error("plan and model are required: no default selection exists yet");
    }
    // Validate the identity against the registry and complete the effort (the same
    // completion as the interactive flow: the chosen model's max tier).
    const view = deps.modelSelectionService ? await deps.modelSelectionService.getView() : null;
    const model = view?.providers
      .find((provider) => provider.providerId === base.providerId)
      ?.models.find((candidate) => candidate.modelId === base.modelId);
    if (!model) {
      throw new Error(`model ${base.providerId}/${base.modelId} is not selectable`);
    }
    const allowedEfforts = model.config.optionSpecs.reasoningLevel.values;
    const effort = query.effort ?? allowedEfforts.at(-1);
    if (!effort) {
      throw new Error(`model ${base.providerId}/${base.modelId} exposes no reasoning levels`);
    }
    if (allowedEfforts.length > 0 && !allowedEfforts.includes(effort)) {
      throw new Error(
        `unknown effort "${query.effort}" — valid values: ${allowedEfforts.join(", ")}`,
      );
    }
    const next = await deps.modelSelectionDefault.saveConfiguredDefault({
      providerId: base.providerId,
      modelId: base.modelId,
      options: { reasoningLevel: effort },
    });
    return {
      scope: "default",
      selection: projectModelSelectionInfo(next),
      default: projectModelSelectionInfo(next),
      plans: view ? projectModelPlans(view) : [],
    };
  }
}
