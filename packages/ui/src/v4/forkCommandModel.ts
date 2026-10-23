/*
 * FORK CHANGE (damian-rafael-lattenero): honor a custom command's `model:`
 * frontmatter for the turn it triggers. Upstream runs command turns on the
 * session model (the key was parsed nowhere); this module parses
 * `model: <providerId>/<modelId>[$<level>]` (or a bare modelId), validates it
 * against the live model selection view, and produces the frozen
 * ModelSelection that replaces the submission's for that single send.
 */
import type { ModelSelection } from "@zcode/shared";
import type { ModelSelectionView } from "@zcode/services";
import { validateModelSelectionOptions } from "@zcode/provider";

const COMMAND_NAME_RE = /^\/([A-Za-z0-9_-]+)(?:\s|$)/;

export interface CommandModelSpec {
  providerId?: string;
  modelId: string;
  thoughtLevel?: string;
}

export function parseCommandModelSpec(raw: string): CommandModelSpec | null {
  const value = raw.trim();
  if (!value) return null;
  let rest = value;
  let thoughtLevel: string | undefined;
  const levelMatch = /\$([A-Za-z]+)$/.exec(rest);
  if (levelMatch) {
    thoughtLevel = levelMatch[1]?.toLowerCase();
    rest = rest.slice(0, levelMatch.index).trim();
  }
  const slash = rest.indexOf("/");
  if (slash >= 0) {
    const providerId = rest.slice(0, slash).trim();
    const modelId = rest.slice(slash + 1).trim();
    if (!providerId || !modelId) return null;
    return { providerId, modelId, thoughtLevel };
  }
  return rest ? { modelId: rest, thoughtLevel } : null;
}

// Text → command name → raw model spec → validated ModelSelection (or null
// when the text is not a bare command, the command declares no model, or the
// model/level is not selectable in the current view).
export function resolveCommandModelSelection(options: {
  text: string;
  commandModelMap: ReadonlyMap<string, string>;
  view: ModelSelectionView | null;
  currentReasoningLevel?: string;
}): ModelSelection | null {
  const name = COMMAND_NAME_RE.exec(options.text.trim())?.[1]?.toLowerCase();
  if (!name || !options.view) return null;
  const raw = options.commandModelMap.get(name);
  if (!raw) return null;
  const spec = parseCommandModelSpec(raw);
  if (!spec) return null;
  for (const provider of options.view.providers) {
    if (spec.providerId && provider.providerId !== spec.providerId) continue;
    const model = provider.models.find((candidate) => candidate.modelId === spec.modelId);
    if (!model) continue;
    const supported = model.config?.optionSpecs?.reasoningLevel?.values;
    // candidatos de nivel en orden: el declarado, el actual de la sesión, el
    // primero soportado por el modelo — gana el primero que valide.
    for (const level of [spec.thoughtLevel, options.currentReasoningLevel, supported?.[0]]) {
      if (!level) continue;
      const selection: ModelSelection = {
        providerId: provider.providerId,
        modelId: model.modelId,
        options: { reasoningLevel: level },
      };
      if (validateModelSelectionOptions(model, selection).ok) return Object.freeze(selection);
    }
  }
  return null;
}
