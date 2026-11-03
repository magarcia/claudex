import { describe, expect, it } from "bun:test";

import type { CodexModel } from "../src/codex/client.ts";
import {
  codexModelDescription,
  codexModels,
  requireCodexModel,
  selectCodingModels,
} from "../src/models.ts";

function model(id: string): CodexModel {
  return { id, displayName: id, contextWindow: 200000 };
}

describe("coding model selection", () => {
  it("offers 1M variants only for catalog windows of at least one million tokens", () => {
    const models = codexModels([
      { ...model("gpt-6-sol"), contextWindow: 1_000_000 },
      { ...model("gpt-6-astra"), contextWindow: 2_000_000 },
      { ...model("gpt-6-terra"), contextWindow: 400_000 },
      { id: "gpt-6-luna", displayName: "Luna" },
    ]);
    expect(models.map((model) => model.id)).toEqual([
      "codex/gpt-6-sol",
      "codex/gpt-6-sol[1m]",
      "codex/gpt-6-astra",
      "codex/gpt-6-astra[1m]",
      "codex/gpt-6-terra",
      "codex/gpt-6-luna",
    ]);
    expect(models[1]?.display_name).toBe("gpt-6-sol (1M context)");
    expect(() => requireCodexModel("codex/gpt-6-luna[1m]", [model("gpt-6-luna")])).toThrow(
      "Available models: codex/gpt-6-luna.",
    );
  });
  it("keeps the latest GPT 6+ release of each named family and preserves model metadata", () => {
    const catalog = [
      model("gpt-6-sol"),
      model("gpt-6-astra"),
      model("gpt-5.6-terra"),
      model("gpt-6.1-terra"),
      model("gpt-6.1-sol"),
      model("gpt-6-luna"),
      model("gpt-reserve"),
      model("codex-auto-review"),
      model("gpt-7"),
      model("gpt-8-image"),
    ];
    const original = structuredClone(catalog);
    expect(selectCodingModels(catalog)).toEqual([
      model("gpt-6.1-sol"),
      model("gpt-6-astra"),
      model("gpt-6.1-terra"),
      model("gpt-6-luna"),
    ]);
    expect(catalog).toEqual(original);
  });

  it.each([
    ["gpt-6.9-sol", "gpt-6.10-sol"],
    ["gpt-9-sol", "gpt-10-sol"],
    ["gpt-6.1-sol", "gpt6.5-sol"],
    ["gpt-6.5-sol", "gpt-7-sol"],
    ["gpt-7.1-sol", "gpt-7.1.1-sol"],
  ])("selects a future numeric release regardless of catalog order: %s -> %s", (older, newer) => {
    expect(selectCodingModels([model(newer), model(older)])).toEqual([model(newer)]);
    expect(selectCodingModels([model(older), model(newer)])).toEqual([model(newer)]);
  });

  it("keeps the first catalog entry for equal numeric versions", () => {
    expect(selectCodingModels([model("gpt-7-sol"), model("gpt-7.0-sol")])).toEqual([
      model("gpt-7-sol"),
    ]);
  });

  it("omits older releases, unknown families, unlabelled models, and malformed IDs", () => {
    expect(
      selectCodingModels(
        [
          "gpt-5.99-sol",
          "gpt-5.6-terra",
          "gpt-7",
          "gpt-7-other",
          "gpt-reserve",
          "codex-auto-review",
          "gpt-7-sol-preview",
          "gpt-7..1-sol",
          "gpt-NaN-sol",
          "gpt-9007199254740992-sol",
        ].map(model),
      ),
    ).toEqual([]);
    expect(selectCodingModels([])).toEqual([]);
  });

  it("uses the same family descriptions for future releases", () => {
    expect(codexModelDescription(model("gpt-7-sol"))).toBe("For coding and everyday work");
    expect(codexModelDescription(model("gpt6.5-luna"))).toBe("Fast and affordable for quick tasks");
    expect(codexModelDescription(model("gpt-8-terra"))).toBe("For focused coding tasks");
    expect(codexModelDescription(model("gpt-10-astra"))).toBe("For your most demanding tasks");
  });
});
