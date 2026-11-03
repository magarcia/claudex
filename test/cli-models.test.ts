import { afterEach, describe, expect, it, vi } from "bun:test";

import { main } from "../src/cli.ts";

const stdout: string[] = [];
const stderr: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  stdout.length = 0;
  stderr.length = 0;
});

function fixture() {
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdout.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
    return true;
  });
  const codex = {
    models: vi.fn(async () => [
      { id: "gpt-6-sol", displayName: "Old Sol" },
      { id: "gpt-6.1-sol", displayName: "Sol", contextWindow: 1_000_000 },
      { id: "gpt-6-luna", displayName: "Luna", contextWindow: 200_000 },
      { id: "gpt-7", displayName: "Generic model" },
      { id: "gpt-5-terra", displayName: "Old Terra" },
    ]),
    responses: vi.fn(async () => new Response("unused")),
  };
  const claudeModels = vi.fn(async () => [
    { id: "claude-opus-5-5", display_name: "Opus", description: "Complex tasks" },
    { id: "claude-sonnet-5-5", display_name: "Sonnet", description: "Routine tasks" },
  ]);
  return { codex, claudeModels };
}

describe("models command", () => {
  it("prints native Claude and filtered Codex IDs on stdout without inference", async () => {
    const dependencies = fixture();
    expect(await main(["models"], dependencies)).toBe(0);
    expect(stdout.join("")).toBe(
      "claude-opus-5-5\nclaude-sonnet-5-5\ncodex/gpt-6.1-sol\ncodex/gpt-6.1-sol[1m]\ncodex/gpt-6-luna\n",
    );
    expect(stderr).toEqual([]);
    expect(dependencies.claudeModels).toHaveBeenCalledOnce();
    expect(dependencies.codex.models).toHaveBeenCalledOnce();
    expect(dependencies.codex.responses).not.toHaveBeenCalled();
  });

  it("prints parseable JSON with the picker names and descriptions", async () => {
    const dependencies = fixture();
    expect(await main(["models", "--json"], dependencies)).toBe(0);
    expect(JSON.parse(stdout.join(""))).toMatchObject([
      { id: "claude-opus-5-5", display_name: "Opus", description: "Complex tasks" },
      { id: "claude-sonnet-5-5", display_name: "Sonnet", description: "Routine tasks" },
      { id: "codex/gpt-6.1-sol", display_name: "Sol", description: "For coding and everyday work" },
      { id: "codex/gpt-6.1-sol[1m]", display_name: "Sol (1M context)" },
      { id: "codex/gpt-6-luna", display_name: "Luna" },
    ]);
    expect(stderr).toEqual([]);
  });

  it.each([
    { signal: "SIGINT", code: 130 },
    { signal: "SIGTERM", code: 143 },
  ] as const)(
    "returns $code and removes signal handlers after $signal",
    async ({ signal, code }) => {
      const dependencies = fixture();
      const interrupts = process.listenerCount("SIGINT");
      const terminations = process.listenerCount("SIGTERM");
      dependencies.codex.models.mockImplementationOnce(async () => {
        process.emit(signal);
        throw new Error("Model discovery interrupted.");
      });
      expect(await main(["models"], dependencies)).toBe(code);
      expect(stdout).toEqual([]);
      expect(stderr).toEqual([]);
      expect(process.listenerCount("SIGINT")).toBe(interrupts);
      expect(process.listenerCount("SIGTERM")).toBe(terminations);
    },
  );

  it("fails without partial output when no supported models are available", async () => {
    const dependencies = fixture();
    dependencies.codex.models.mockResolvedValueOnce([]);
    await expect(main(["models"], dependencies)).rejects.toThrow(
      "No supported Codex coding models",
    );
    expect(stdout).toEqual([]);
  });

  it("propagates discovery failure without printing a partial catalog", async () => {
    const dependencies = fixture();
    dependencies.codex.models.mockRejectedValueOnce(new Error("Synthetic catalog failure."));
    await expect(main(["models", "--json"], dependencies)).rejects.toThrow(
      "Synthetic catalog failure.",
    );
    expect(stdout).toEqual([]);
  });

  it("fails without partial output when native Claude discovery fails", async () => {
    const dependencies = fixture();
    dependencies.claudeModels.mockRejectedValueOnce(
      new Error("Synthetic Claude discovery failure."),
    );
    await expect(main(["models", "--json"], dependencies)).rejects.toThrow(
      "Synthetic Claude discovery failure.",
    );
    expect(stdout).toEqual([]);
  });
});
