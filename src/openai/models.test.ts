import { describe, expect, it } from "bun:test";

import { resolveModel } from "./models.ts";

describe("resolveModel", () => {
  it("passes a plain model through", () => {
    expect(resolveModel("gpt-5.5")).toEqual({ model: "gpt-5.5" });
  });

  it("reads the effort from a suffix", () => {
    expect(resolveModel("gpt-5.5-high")).toEqual({ model: "gpt-5.5", effort: "high" });
  });

  it("prefers an explicit effort over the suffix", () => {
    expect(resolveModel("gpt-5.5-high", "low")).toEqual({ model: "gpt-5.5", effort: "low" });
  });

  it("passes explicit future effort values to Codex for model-specific validation", () => {
    expect(resolveModel("future-model", "future-effort")).toEqual({
      model: "future-model",
      effort: "future-effort",
    });
  });

  it.each(["max", "ultra", "persistent"])(
    "supports the current Codex effort %s in a suffix and explicit field",
    (effort) => {
      expect(resolveModel(`gpt-6.1-sol-${effort}`)).toEqual({ model: "gpt-6.1-sol", effort });
      expect(resolveModel("gpt-6.1-sol", effort)).toEqual({ model: "gpt-6.1-sol", effort });
    },
  );

  it.each([undefined, "", " ", 7, {}, null])(
    "ignores an absent or invalid effort value: %j",
    (effort) => {
      expect(resolveModel("gpt-6.1-sol-high", effort)).toEqual({
        model: "gpt-6.1-sol",
        effort: "high",
      });
    },
  );

  it("leaves a model whose last segment is not an effort alone", () => {
    expect(resolveModel("gpt-5.4-mini")).toEqual({ model: "gpt-5.4-mini" });
    expect(resolveModel("gpt-5.3-codex-spark")).toEqual({ model: "gpt-5.3-codex-spark" });
  });
});
