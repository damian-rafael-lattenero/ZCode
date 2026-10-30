/* [fork] B3a — plan/modelo/effort del canal «daemon local» (/plan del bot).
 * Lectura y escritura de la selección de modelo en sus dos alcances:
 *  - «conversation»: botsService.get/setBotModelSelection — el MISMO camino de
 *    escritura que /model y /effort (draftOptions o setModel/setConfigOption).
 *  - «default»: NodeModelSelectionConfigRepository.saveConfiguredDefault — el
 *    default global de la app (defaultModelSelection del personal config).
 * Shapes en @zcode/shared (daemon-channel.ts); spec: docs/fork/DAEMON-CHANNEL.md.
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
  /** El bot id del canal (el actor de las ops de selección). */
  botId: string;
  modelSelectionService?: Pick<IModelSelectionService, "getView">;
  modelSelectionDefault?: {
    read(): Promise<ModelSelection | undefined>;
    saveConfiguredDefault(
      selection: ModelSelection | undefined,
    ): Promise<ModelSelection | undefined>;
  };
  /** Workspace del contexto activo del bot (fallback cuando el frame no lo trae). */
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
      models: provider.models.map((model) => ({ id: model.modelId, label: model.modelId })),
    }));
}

export function createDaemonChannelModelSelectionHandler(
  deps: DaemonChannelModelSelectionDeps,
): DaemonChannelModelSelectionHandler {
  /** Workspace para modelSelection/setModelSelection: explícito o el contexto activo. */
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

  /** Resultado común de modelSelection/setModelSelection: selección + default global + planes. */
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

  /** CONTROL scope=«default»: el default global de la app (defaultModelSelection). */
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
    // Validar el identity contra el registry y completar el effort (el mismo
    // completion que el flujo interactivo: la máxima tier del modelo elegido).
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
