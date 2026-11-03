import { spawn } from "node:child_process";
import { chmod, mkdtemp, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CodexClient, CodexModel } from "./codex/client.ts";
import { codexModels, selectCodingModels } from "./models.ts";
import { startProxy } from "./server.ts";

export class LauncherUsageError extends Error {}

export function validateClaudeArguments(args: string[], environment: NodeJS.ProcessEnv): void {
  for (const argument of args) {
    if (argument === "--") break;
    if (argument === "--settings" || argument.startsWith("--settings=")) {
      throw new LauncherUsageError(
        "The launcher supplies --settings for the model picker. Remove your --settings argument; existing user and project settings still load.",
      );
    }
  }
  for (const key of [
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
    "CLAUDE_CODE_USE_MANTLE",
  ]) {
    if (environment[key] === "1") {
      throw new LauncherUsageError(
        `Unset ${key} before using this launcher; it bypasses the local Anthropic proxy.`,
      );
    }
  }
}

export async function launchClaude({
  args,
  codex,
  signal,
  env = process.env,
  start = startProxy,
  executable = "claude",
  tempRoot = tmpdir(),
}: {
  args: string[];
  codex: Pick<CodexClient, "models" | "responses">;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  start?: typeof startProxy;
  executable?: string;
  tempRoot?: string;
}): Promise<number> {
  validateClaudeArguments(args, env);
  signal?.throwIfAborted();
  const claudeExecutable = Bun.which(executable, { PATH: env.PATH ?? "" });
  if (!claudeExecutable) {
    throw new Error(
      "Claude Code was not found on PATH. Install it and ensure claude is executable.",
    );
  }
  const proxy = await start({ codex, port: 0 });
  await using resources = new AsyncDisposableStack();
  resources.defer(proxy.close);
  const timeout = AbortSignal.timeout(15_000);
  const catalog = selectCodingModels(
    await codex.models(signal ? AbortSignal.any([signal, timeout]) : timeout),
  );
  const models = codexModels(catalog);
  if (models.length === 0)
    throw new Error("No GPT 6+ Luna, Terra, Sol, or Astra models are available for this account.");
  signal?.throwIfAborted();
  const directory = await mkdtemp(join(tempRoot, "claudex-"));
  resources.defer(() => rmdir(directory));
  await chmod(directory, 0o700);
  const settingsFile = join(directory, "settings.json");
  resources.defer(async () => {
    try {
      await unlink(settingsFile);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
      throw error;
    }
  });
  await writePickerSettings(settingsFile, models);
  signal?.throwIfAborted();
  return await runClaude({
    executable: claudeExecutable,
    args: ["--settings", settingsFile, ...args],
    env: childEnvironment({ env, proxyUrl: proxy.url, catalog }),
    signal,
  });
}

async function writePickerSettings(settingsFile: string, models: ReturnType<typeof codexModels>) {
  await writeFile(
    settingsFile,
    JSON.stringify({
      modelPicker: {
        replaceBuiltInOptions: false,
        options: models.map((model) => ({
          model: model.id,
          label: model.display_name,
          ...(model.description ? { description: model.description } : {}),
        })),
      },
    }),
    { mode: 0o600, flag: "wx" },
  );
}

function childEnvironment({
  env,
  proxyUrl,
  catalog,
}: {
  env: NodeJS.ProcessEnv;
  proxyUrl: string;
  catalog: readonly CodexModel[];
}): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...env, ANTHROPIC_BASE_URL: proxyUrl };
  environment.CLAUDE_CODE_MAX_CONTEXT_TOKENS ??= String(
    Math.min(...catalog.map((model) => model.contextWindow ?? 200_000)),
  );
  delete environment.ANTHROPIC_API_KEY;
  delete environment.ANTHROPIC_AUTH_TOKEN;
  return environment;
}

function runClaude({
  executable,
  args,
  env,
  signal,
}: {
  executable: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const child = spawn(executable, args, { env, stdio: "inherit" });
    let escalation: ReturnType<typeof setTimeout> | undefined;
    const abort = () => {
      const reason = signal?.reason === "SIGINT" ? "SIGINT" : "SIGTERM";
      child.kill(reason);
      escalation = setTimeout(() => child.kill("SIGKILL"), 5_000);
      escalation.unref();
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const cleanup = () => {
      signal?.removeEventListener("abort", abort);
      clearTimeout(escalation);
    };
    child.once("error", () => {
      cleanup();
      reject(new Error("Could not start Claude Code. Install it and ensure claude is on PATH."));
    });
    child.once("close", (code, childSignal) => {
      cleanup();
      resolve(childExitCode({ code, childSignal, signal }));
    });
  });
}

function childExitCode({
  code,
  childSignal,
  signal,
}: {
  code: number | null;
  childSignal: NodeJS.Signals | null;
  signal?: AbortSignal;
}): number {
  if (signal?.aborted) return signal.reason === "SIGINT" ? 130 : 143;
  if (code !== null) return code;
  if (childSignal === "SIGINT" || signal?.reason === "SIGINT") return 130;
  if (childSignal === "SIGTERM" || signal?.reason === "SIGTERM") return 143;
  return 1;
}
