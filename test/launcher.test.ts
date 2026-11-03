import { execFile } from "node:child_process";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import * as v from "valibot";
import { afterEach, describe, expect, it, vi } from "bun:test";

import { parseCommand } from "../src/cli.ts";
import type { CodexModel } from "../src/codex/client.ts";
import { launchClaude, LauncherUsageError } from "../src/launcher.ts";

const directories: string[] = [];
const execute = promisify(execFile);
const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

const Capture = v.object({
  executable: v.string(),
  args: v.array(v.string()),
  settingsFile: v.string(),
  fileMode: v.number(),
  directoryMode: v.number(),
  settings: v.unknown(),
  environment: v.unknown(),
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "claude-launcher-test-"));
  directories.push(directory);
  const captureFile = join(directory, "capture.json");
  const executable = join(directory, "fake-claude.mjs");
  await writeFile(
    executable,
    `#!${process.execPath}
import { readFile, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
const args = process.argv.slice(2);
const settingsFile = args[args.indexOf('--settings') + 1];
const capture = {
  executable: process.argv[1],
  args, settingsFile,
  fileMode: (await stat(settingsFile)).mode & 0o777,
  directoryMode: (await stat(dirname(settingsFile))).mode & 0o777,
  settings: JSON.parse(await readFile(settingsFile, 'utf8')),
  environment: {
    baseUrl: process.env.ANTHROPIC_BASE_URL,
    apiKey: process.env.ANTHROPIC_API_KEY ?? null,
    authToken: process.env.ANTHROPIC_AUTH_TOKEN ?? null,
    oauthToken: process.env.CLAUDE_CODE_OAUTH_TOKEN ?? null,
    aliases: Object.fromEntries(['ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]])),
    customValue: process.env.CUSTOM_VALUE,
    contextWindow: process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS,
  },
};
if (process.env.WAIT_FOR_SIGNAL) {
  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));
}
await writeFile(process.env.CAPTURE_FILE, JSON.stringify(capture));
if (process.env.CHILD_EXIT_SIGNAL) process.kill(process.pid, process.env.CHILD_EXIT_SIGNAL);
else if (process.env.WAIT_FOR_SIGNAL) setInterval(() => {}, 1000);
else process.exit(Number(process.env.CHILD_EXIT_CODE ?? 0));
`,
  );
  await chmod(executable, 0o700);
  const close = vi.fn(async () => {});
  const start = vi.fn(async () => ({ url: "http://127.0.0.1:49000", close }));
  const codex = {
    models: vi.fn(async (): Promise<CodexModel[]> => [
      { id: "gpt-6-luna", displayName: "Luna", description: "Fast model" },
      { id: "gpt-6-sol", displayName: "Sol" },
      { id: "gpt-6.1-sol", displayName: "Sol 6.1" },
      { id: "gpt-5.6-terra", displayName: "Old Terra" },
      { id: "codex-auto-review", displayName: "Auto Review" },
    ]),
    responses: vi.fn(async () => new Response("unused")),
  };
  const environment: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    CAPTURE_FILE: captureFile,
    ANTHROPIC_BASE_URL: "https://old-gateway.example",
    ANTHROPIC_API_KEY: "synthetic-api-key",
    ANTHROPIC_AUTH_TOKEN: "synthetic-api-token",
    CLAUDE_CODE_OAUTH_TOKEN: "synthetic-subscription-token",
    CUSTOM_VALUE: "preserved",
  };
  return {
    directory,
    captureFile,
    executable,
    start,
    close,
    codex,
    environment,
    capture: async () => v.parse(Capture, JSON.parse(await readFile(captureFile, "utf8"))),
  };
}

describe("CLI arguments", () => {
  it("runs executable help and version without needing a subscription", async () => {
    const environment = { PATH: process.env.PATH };
    const help = await execute(cli, ["--help"], { env: environment });
    expect(help.stdout).toContain("Usage: claudex");
    expect(help.stderr).toBe("");
    const version = await execute(cli, ["--version"], { env: environment });
    expect(version.stdout).toBe("0.1.0\n");
    expect(version.stderr).toBe("");
    await expect(
      execute(cli, ["serve", "--port", "0"], { env: environment }),
    ).rejects.toMatchObject({
      code: 2,
      stderr: "Error: --port must be an integer from 1 to 65535.\n",
    });
  });

  it("parses commands before any runtime work", () => {
    expect(parseCommand([])).toEqual({ kind: "claude", args: [] });
    expect(parseCommand(["--help"])).toEqual({ kind: "help" });
    expect(parseCommand(["--version"])).toEqual({ kind: "version" });
    expect(parseCommand(["serve"])).toEqual({ kind: "serve", port: 8788 });
    expect(parseCommand(["serve", "--port=9000"])).toEqual({ kind: "serve", port: 9000 });
    expect(parseCommand(["serve", "--port", "9001"])).toEqual({ kind: "serve", port: 9001 });
    expect(parseCommand(["doctor", "--json"])).toEqual({ kind: "doctor", json: true });
    expect(parseCommand(["models"])).toEqual({ kind: "models", json: false });
    expect(parseCommand(["models", "--json"])).toEqual({ kind: "models", json: true });
    expect(parseCommand(["models", "--help"])).toEqual({ kind: "help" });
    expect(parseCommand(["login"])).toEqual({ kind: "login" });
  });

  it.each(
    [
      ["serve", "--port", "0"],
      ["serve", "--port", "65536"],
      ["serve", "--port", "1.5"],
      ["serve", "--port"],
      ["serve", "--host", "0.0.0.0"],
      ["login", "--force"],
      ["doctor", "--unknown"],
      ["models", "--unknown"],
      ["models", "--json", "extra"],
      ["--version", "ignored"],
    ].map((args) => ({ args })),
  )("rejects invalid arguments: %j", ({ args }) => {
    expect(() => parseCommand(args)).toThrow(LauncherUsageError);
  });

  it("preserves Claude argument order and literal values", () => {
    const args = ["--model", "codex/gpt-6-luna", "-p", "a prompt with spaces", "--", "--settings"];
    expect(parseCommand(args)).toEqual({ kind: "claude", args });
    expect(parseCommand(["explain this project"])).toEqual({
      kind: "claude",
      args: ["explain this project"],
    });
    expect(parseCommand(["--resume", "some-session"])).toEqual({
      kind: "claude",
      args: ["--resume", "some-session"],
    });
  });
});

describe("Claude launcher", () => {
  it("launches the first Claude executable on the supplied PATH", async () => {
    const setup = await fixture();
    const first = join(setup.directory, "first");
    const second = join(setup.directory, "second");
    await mkdir(first);
    await mkdir(second);
    for (const directory of [first, second]) {
      const executable = join(directory, "claude");
      await copyFile(setup.executable, executable);
      await chmod(executable, 0o700);
    }
    expect(
      await launchClaude({
        args: [],
        codex: setup.codex,
        start: setup.start,
        env: { ...setup.environment, PATH: `${first}:${second}` },
        tempRoot: setup.directory,
      }),
    ).toBe(0);
    expect((await setup.capture()).executable).toBe(await realpath(join(first, "claude")));
  });

  it("uses private additive model settings, keeps OAuth, clears API overrides, and preserves args", async () => {
    const setup = await fixture();
    const args = ["--model", "codex/gpt-6-luna", "-p", "a prompt with spaces"];
    expect(
      await launchClaude({
        args,
        codex: setup.codex,
        start: setup.start,
        executable: setup.executable,
        env: setup.environment,
        tempRoot: setup.directory,
      }),
    ).toBe(0);
    const capture = await setup.capture();
    expect(capture.args.slice(2)).toEqual(args);
    expect(capture.fileMode).toBe(0o600);
    expect(capture.directoryMode).toBe(0o700);
    expect(capture.settings).toEqual({
      modelPicker: {
        replaceBuiltInOptions: false,
        options: [
          {
            model: "codex/gpt-6-luna",
            label: "Luna",
            description: "Fast and affordable for quick tasks",
          },
          {
            model: "codex/gpt-6.1-sol",
            label: "Sol 6.1",
            description: "For coding and everyday work",
          },
        ],
      },
    });
    expect(capture.environment).toEqual({
      baseUrl: "http://127.0.0.1:49000",
      apiKey: null,
      authToken: null,
      oauthToken: "synthetic-subscription-token",
      aliases: {},
      customValue: "preserved",
      contextWindow: "200000",
    });
    expect(setup.environment.ANTHROPIC_API_KEY).toBe("synthetic-api-key");
    expect(setup.start).toHaveBeenCalledWith({ codex: setup.codex, port: 0 });
    expect(setup.close).toHaveBeenCalledOnce();
    await expect(stat(capture.settingsFile)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(dirname(capture.settingsFile))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps Claude alias overrides and adds a catalog-backed 1M picker row", async () => {
    const setup = await fixture();
    const aliases = {
      ANTHROPIC_DEFAULT_OPUS_MODEL: "codex/gpt-6-astra[1m]",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "codex/gpt-6.1-sol",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "codex/gpt-6-luna",
      ANTHROPIC_SMALL_FAST_MODEL: "codex/gpt-6-luna",
    };
    setup.codex.models.mockResolvedValueOnce([
      { id: "gpt-6-luna", displayName: "Luna", contextWindow: 200_000 },
      { id: "gpt-6-astra", displayName: "Astra", contextWindow: 1_000_000 },
    ]);
    expect(
      await launchClaude({
        args: [],
        codex: setup.codex,
        start: setup.start,
        executable: setup.executable,
        env: { ...setup.environment, ...aliases },
        tempRoot: setup.directory,
      }),
    ).toBe(0);
    const capture = await setup.capture();
    expect(capture.environment).toMatchObject({ aliases, contextWindow: "200000" });
    expect(capture.settings).toEqual({
      modelPicker: {
        replaceBuiltInOptions: false,
        options: [
          {
            model: "codex/gpt-6-luna",
            label: "Luna",
            description: "Fast and affordable for quick tasks",
          },
          {
            model: "codex/gpt-6-astra",
            label: "Astra",
            description: "For your most demanding tasks",
          },
          {
            model: "codex/gpt-6-astra[1m]",
            label: "Astra (1M context)",
            description: "For your most demanding tasks",
          },
        ],
      },
    });
  });

  it.each([undefined, "500000"])(
    "uses a safe shared window and preserves an explicit override: %s",
    async (override) => {
      const setup = await fixture();
      setup.codex.models.mockResolvedValueOnce([
        { id: "gpt-6-sol", displayName: "Sol", contextWindow: 500_000 },
        { id: "gpt-6-luna", displayName: "Luna", contextWindow: 272_000 },
      ]);
      const env = {
        ...setup.environment,
        ...(override ? { CLAUDE_CODE_MAX_CONTEXT_TOKENS: override } : {}),
      };
      expect(
        await launchClaude({
          args: [],
          codex: setup.codex,
          start: setup.start,
          executable: setup.executable,
          env,
          tempRoot: setup.directory,
        }),
      ).toBe(0);
      expect((await setup.capture()).environment).toMatchObject({
        contextWindow: override ?? "272000",
      });
    },
  );

  it.each([["--settings", "{}"], ["--settings={}"]].map((args) => ({ args })))(
    "rejects conflicting settings before proxy or catalog work: %j",
    async ({ args }) => {
      const setup = await fixture();
      await expect(
        launchClaude({ args, codex: setup.codex, start: setup.start, tempRoot: setup.directory }),
      ).rejects.toThrow(LauncherUsageError);
      expect(setup.start).not.toHaveBeenCalled();
      expect(setup.codex.models).not.toHaveBeenCalled();
      expect(await readdir(setup.directory)).toEqual(["fake-claude.mjs"]);
    },
  );

  it("rejects provider settings that bypass the local proxy before startup", async () => {
    const setup = await fixture();
    await expect(
      launchClaude({
        args: [],
        codex: setup.codex,
        start: setup.start,
        env: { CLAUDE_CODE_USE_BEDROCK: "1" },
      }),
    ).rejects.toThrow("Unset CLAUDE_CODE_USE_BEDROCK");
    expect(setup.start).not.toHaveBeenCalled();
  });

  it("returns the child exit status and cleans settings after a child failure", async () => {
    const setup = await fixture();
    expect(
      await launchClaude({
        args: [],
        codex: setup.codex,
        start: setup.start,
        executable: setup.executable,
        env: { ...setup.environment, CHILD_EXIT_CODE: "7" },
        tempRoot: setup.directory,
      }),
    ).toBe(7);
    const capture = await setup.capture();
    await expect(stat(capture.settingsFile)).rejects.toMatchObject({ code: "ENOENT" });
    expect(setup.close).toHaveBeenCalledOnce();
  });

  it.each([
    { childSignal: "SIGINT", exitCode: 130 },
    { childSignal: "SIGTERM", exitCode: 143 },
    { childSignal: "SIGKILL", exitCode: 1 },
  ])(
    "maps an unrequested child $childSignal to exit $exitCode",
    async ({ childSignal, exitCode }) => {
      const setup = await fixture();
      expect(
        await launchClaude({
          args: [],
          codex: setup.codex,
          start: setup.start,
          executable: setup.executable,
          env: { ...setup.environment, CHILD_EXIT_SIGNAL: childSignal },
          tempRoot: setup.directory,
        }),
      ).toBe(exitCode);
      expect(setup.close).toHaveBeenCalledOnce();
    },
  );

  it("does not start the proxy or catalog for an already aborted launch", async () => {
    const setup = await fixture();
    const reason = new Error("Synthetic cancellation.");
    await expect(
      launchClaude({
        args: [],
        codex: setup.codex,
        start: setup.start,
        signal: AbortSignal.abort(reason),
        executable: setup.executable,
        env: setup.environment,
        tempRoot: setup.directory,
      }),
    ).rejects.toBe(reason);
    expect(setup.start).not.toHaveBeenCalled();
    expect(setup.codex.models).not.toHaveBeenCalled();
  });

  it("closes the proxy without creating settings when cancellation arrives during catalog loading", async () => {
    const setup = await fixture();
    const controller = new AbortController();
    const reason = new Error("Synthetic cancellation.");
    setup.codex.models.mockImplementationOnce(async () => {
      controller.abort(reason);
      return [{ id: "gpt-6-luna", displayName: "Luna" }];
    });
    await expect(
      launchClaude({
        args: [],
        codex: setup.codex,
        start: setup.start,
        signal: controller.signal,
        executable: setup.executable,
        env: setup.environment,
        tempRoot: setup.directory,
      }),
    ).rejects.toBe(reason);
    expect(setup.close).toHaveBeenCalledOnce();
    expect(await readdir(setup.directory)).toEqual(["fake-claude.mjs"]);
  });

  it("fails before proxy or catalog work when the Claude executable is missing", async () => {
    const setup = await fixture();
    await expect(
      launchClaude({
        args: [],
        codex: setup.codex,
        start: setup.start,
        executable: join(setup.directory, "not-installed"),
        env: setup.environment,
        tempRoot: setup.directory,
      }),
    ).rejects.toThrow("Claude Code was not found on PATH");
    expect(setup.start).not.toHaveBeenCalled();
    expect(setup.codex.models).not.toHaveBeenCalled();
    expect(await readdir(setup.directory)).toEqual(["fake-claude.mjs"]);
  });

  it("closes the proxy on catalog failure without launching a child", async () => {
    const setup = await fixture();
    setup.codex.models.mockRejectedValueOnce(new Error("Synthetic catalog failure."));
    await expect(
      launchClaude({
        args: [],
        codex: setup.codex,
        start: setup.start,
        executable: setup.executable,
        env: setup.environment,
        tempRoot: setup.directory,
      }),
    ).rejects.toThrow("Synthetic catalog failure");
    expect(setup.close).toHaveBeenCalledOnce();
    expect(await readdir(setup.directory)).toEqual(["fake-claude.mjs"]);
  });

  it("retains the catalog error when proxy cleanup also fails", async () => {
    const setup = await fixture();
    const catalogError = new Error("Synthetic catalog failure.");
    const cleanupError = new Error("Synthetic proxy cleanup failure.");
    setup.codex.models.mockRejectedValueOnce(catalogError);
    setup.close.mockRejectedValueOnce(cleanupError);
    await expect(
      launchClaude({
        args: [],
        codex: setup.codex,
        start: setup.start,
        executable: setup.executable,
        env: setup.environment,
      }),
    ).rejects.toMatchObject({
      name: "SuppressedError",
      error: cleanupError,
      suppressed: catalogError,
    });
    expect(setup.close).toHaveBeenCalledOnce();
  });

  it.each([
    { reason: "SIGINT", exitCode: 130 },
    { reason: "SIGTERM", exitCode: 143 },
  ])(
    "keeps cancellation exit $exitCode when a child handles $reason and exits zero",
    async ({ reason, exitCode }) => {
      const setup = await fixture();
      const controller = new AbortController();
      const pending = launchClaude({
        args: [],
        codex: setup.codex,
        start: setup.start,
        executable: setup.executable,
        env: { ...setup.environment, WAIT_FOR_SIGNAL: "1" },
        tempRoot: setup.directory,
        signal: controller.signal,
      });
      const deadline = Date.now() + 2_000;
      while (true) {
        try {
          await setup.capture();
          break;
        } catch (error) {
          if (Date.now() >= deadline) throw error;
          await Bun.sleep(10);
        }
      }
      controller.abort(reason);
      expect(await pending).toBe(exitCode);
      const capture = await setup.capture();
      await expect(stat(capture.settingsFile)).rejects.toMatchObject({ code: "ENOENT" });
      expect(setup.close).toHaveBeenCalledOnce();
    },
  );
});
