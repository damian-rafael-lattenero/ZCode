/* [fork] El par plan/modelo de un set parcial del canal daemon.
 * Medido 3/11 19:57: el bot manda `pl:opencode-go-chat` y el merge con el
 * modelo vigente (GLM-5.3-Flash, de z.ai) producía «model
 * opencode-go-chat/GLM-5.3-Flash is not selectable from this context».
 * `resolveModelPair` resuelve el sibling contra el catálogo: un plan solo
 * conserva el modelo actual únicamente si ese plan lo expone, y si no toma
 * el primer modelo del plan destino; un modelo solo viaja con su dueño.
 */
import { describe, expect, it } from "vitest";
import { resolveModelPair } from "../src/bots/botsService.js";

const view = {
  providers: [
    {
      providerId: "account:zai-start-plan",
      providerName: "Start Plan",
      config: { visibility: "visible" },
      models: [
        { modelId: "GLM-5.3-Flash", label: "GLM-5.3-Flash" },
        { modelId: "GLM-5.3", label: "GLM-5.3" },
      ],
    },
    {
      providerId: "opencode-go-chat",
      providerName: "OpenCode Go",
      config: { visibility: "visible" },
      models: [
        { modelId: "deepseek-v4.1-flash", label: "deepseek-v4.1-flash" },
        { modelId: "kimi-k2", label: "kimi-k2" },
      ],
    },
    {
      providerId: "hidden-provider",
      providerName: "Hidden",
      config: { visibility: "hidden" },
      models: [{ modelId: "secret-model", label: "secret-model" }],
    },
  ],
} as never;

const zai = { providerId: "account:zai-start-plan", modelId: "GLM-5.3-Flash" };
const opencode = { providerId: "opencode-go-chat", modelId: "deepseek-v4.1-flash" };

describe("resolveModelPair", () => {
  it("a plan alone lands with the new plan's OWN first model, never the stale sibling", () => {
    expect(resolveModelPair(view, { plan: "opencode-go-chat" }, zai)).toEqual({
      providerId: "opencode-go-chat",
      modelId: "deepseek-v4.1-flash",
    });
  });

  it("a plan alone keeps the current model only when that plan exposes it", () => {
    expect(resolveModelPair(view, { plan: "account:zai-start-plan" }, opencode)).toEqual({
      providerId: "account:zai-start-plan",
      modelId: "GLM-5.3-Flash",
    });
    // y con el modelo vigente ya dentro del plan destino, lo conserva
    expect(resolveModelPair(view, { plan: "opencode-go-chat" }, opencode)).toEqual(opencode);
  });

  it("a model alone rides its OWNER's plan (the current plan first)", () => {
    expect(resolveModelPair(view, { model: "kimi-k2" }, zai)).toEqual({
      providerId: "opencode-go-chat",
      modelId: "kimi-k2",
    });
  });

  it("an explicit pair is honored only when it exists in the catalog", () => {
    expect(resolveModelPair(view, { plan: "opencode-go-chat", model: "kimi-k2" }, zai)).toEqual({
      providerId: "opencode-go-chat",
      modelId: "kimi-k2",
    });
    expect(resolveModelPair(view, { plan: "opencode-go-chat", model: "GLM-5.3" }, zai)).toBeUndefined();
  });

  it("hidden providers are never selectable", () => {
    expect(resolveModelPair(view, { plan: "hidden-provider" }, zai)).toBeUndefined();
    expect(resolveModelPair(view, { model: "secret-model" }, zai)).toBeUndefined();
  });

  it("an unknown plan or an empty request is undefined, never a guess", () => {
    expect(resolveModelPair(view, { plan: "nope" }, zai)).toBeUndefined();
    expect(resolveModelPair(view, {}, zai)).toBeUndefined();
  });

  it("a context with no current selection still resolves a plan's first model", () => {
    expect(resolveModelPair(view, { plan: "opencode-go-chat" }, undefined)).toEqual(opencode);
  });
});
