// @vitest-environment node
// FORK CHANGE (damian-rafael-lattenero): unit tests for the `model:` frontmatter
// override of custom command turns.
import { describe, expect, it } from "vitest";
import {
  parseCommandModelSpec,
  resolveCommandModelSelection,
} from "@/v4/forkCommandModel.js";
import type { ModelSelectionView } from "@zcode/services";

function view(options?: {
  providers?: Array<{ providerId: string; modelIds: string[]; levels?: string[] }>;
}) {
  return {
    revision: 1,
    providers: (options?.providers ?? [
      { providerId: "account:plan", modelIds: ["GLM-5.3", "GLM-5.3-Flash"], levels: ["low", "high", "max"] },
    ]).map((p) => ({
      providerId: p.providerId,
      models: p.modelIds.map((modelId) => ({
        modelId,
        config: { optionSpecs: { reasoningLevel: { values: p.levels ?? ["low", "high", "max"] } } },
      })),
    })),
  } as unknown as ModelSelectionView;
}

describe("parseCommandModelSpec", () => {
  it("proveedor/modelo con sufijo de thinking", () => {
    expect(parseCommandModelSpec("account:plan/GLM-5.3-Flash$low")).toEqual({
      providerId: "account:plan",
      modelId: "GLM-5.3-Flash",
      thoughtLevel: "low",
    });
  });
  it("modelId pelado y sin nivel", () => {
    expect(parseCommandModelSpec("GLM-5.3")).toEqual({ modelId: "GLM-5.3" });
  });
  it("vacío o sin modelo: null", () => {
    expect(parseCommandModelSpec("  ")).toBeNull();
    expect(parseCommandModelSpec("/x")).toBeNull();
  });
});

describe("resolveCommandModelSelection", () => {
  const map = new Map([["diff", "account:plan/GLM-5.3-Flash$low"]]);

  it("un comando con model: reemplaza la selección congelada", () => {
    expect(resolveCommandModelSelection({ text: "/diff", commandModelMap: map, view: view() })).toEqual({
      providerId: "account:plan",
      modelId: "GLM-5.3-Flash",
      options: { reasoningLevel: "low" },
    });
  });
  it("texto con args sigue siendo el comando; texto normal no toca nada", () => {
    expect(resolveCommandModelSelection({ text: "/diff args extra", commandModelMap: map, view: view() })).toBeTruthy();
    expect(resolveCommandModelSelection({ text: "hola /diff", commandModelMap: map, view: view() })).toBeNull();
  });
  it("comando sin model: o sin vista: null", () => {
    expect(resolveCommandModelSelection({ text: "/diff", commandModelMap: new Map(), view: view() })).toBeNull();
    expect(resolveCommandModelSelection({ text: "/diff", commandModelMap: map, view: null })).toBeNull();
  });
  it("modelo que no existe en la vista: null (nunca enviamos basura)", () => {
    const m = new Map([["x", "account:plan/NOPE"]]);
    expect(resolveCommandModelSelection({ text: "/x", commandModelMap: m, view: view() })).toBeNull();
  });
  it("sin sufijo: hereda el nivel actual si el modelo lo soporta, sino el primero", () => {
    const m = new Map([["x", "GLM-5.3"]]);
    expect(
      resolveCommandModelSelection({ text: "/x", commandModelMap: m, view: view(), currentReasoningLevel: "high" }),
    ).toEqual({ providerId: "account:plan", modelId: "GLM-5.3", options: { reasoningLevel: "high" } });
    expect(
      resolveCommandModelSelection({ text: "/x", commandModelMap: m, view: view(), currentReasoningLevel: "bogus" }),
    ).toEqual({ providerId: "account:plan", modelId: "GLM-5.3", options: { reasoningLevel: "low" } });
  });
  it("modelId pelado resuelve contra cualquier provider que lo tenga", () => {
    const m = new Map([["x", "GLM-5.3-Flash"]]);
    const v = view({
      providers: [
        { providerId: "otro", modelIds: ["X1"] },
        { providerId: "account:plan", modelIds: ["GLM-5.3-Flash"] },
      ],
    });
    expect(resolveCommandModelSelection({ text: "/x", commandModelMap: m, view: v })?.providerId).toBe("account:plan");
  });
});
