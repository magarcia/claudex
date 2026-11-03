#!/usr/bin/env -S bun --no-env-file
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import metadata from "../package.json" with { type: "json" };
import { claudeModels } from "./anthropic/models.ts";
import { CodexAuth } from "./codex/auth.ts";
import { CodexClient } from "./codex/client.ts";
import { launchClaude, LauncherUsageError, validateClaudeArguments } from "./launcher.ts";
import { codexModels } from "./models.ts";
import { startProxy } from "./server.ts";

const execute = promisify(execFile);
const HELP = `claudex: Claude Code with Claude and Codex subscription models

Examples:
  claudex
  claudex --model codex/gpt-6-luna
  claudex -p 'Say hello.'
  claudex login
  claudex serve --port 8788
  claudex doctor --json
  claudex models --json

Usage: claudex [Claude arguments...]
       claudex <command> [options]

With no arguments, opens Claude Code with the local proxy enabled.
Finds the first executable named claude on PATH. Claude flags and prompts
are forwarded unchanged.

Commands:
  serve [--port <port>]   Listen on 127.0.0.1 (default: 8788)
  login                  Sign in to a dedicated Codex subscription session
  doctor [--json]        Check local tools and Codex sign-in status
  models [--json]        List native Claude and Codex coding models

Options:
  -h, --help             Show this help without starting the proxy
  -v, --version          Print the installed version

Claude keeps its subscription sign-in. The launcher removes inherited
ANTHROPIC_API_KEY and ANTHROPIC_AUTH_TOKEN only from its child environment.
Existing --settings arguments are rejected; user/project settings still load.
Exit codes: 0 success, 1 failure, 2 usage error, 130 SIGINT, 143 SIGTERM.
`;

type Command =
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "login" }
  | { kind: "serve"; port: number }
  | { kind: "doctor"; json: boolean }
  | { kind: "models"; json: boolean }
  | { kind: "claude"; args: string[] };

function parseServePort(args: string[]): number {
  let value = "8788";
  if (args.length === 2 && (args[0] === "--port" || args[0] === "-p")) value = args[1] ?? "";
  else if (args.length === 1 && args[0]?.startsWith("--port=")) value = args[0].slice(7);
  else if (args.length > 0) throw new LauncherUsageError("Use claudex serve [--port <1-65535>].");
  const port = Number(value);
  if (!/^\d+$/u.test(value) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new LauncherUsageError("--port must be an integer from 1 to 65535.");
  }
  return port;
}

function parseJsonOption(args: string[]): boolean {
  if (args.length === 0) return false;
  if (args.length === 1 && args[0] === "--json") return true;
  throw new LauncherUsageError("Invalid command options. Run claudex --help.");
}

export function parseCommand(args: string[]): Command {
  const [command, ...rest] = args;
  if (
    ["serve", "login", "doctor", "models"].includes(command ?? "") &&
    rest.length === 1 &&
    (rest[0] === "--help" || rest[0] === "-h")
  ) {
    return { kind: "help" };
  }
  switch (command) {
    case "--help":
    case "-h":
    case "help":
      if (rest.length > 0) throw new LauncherUsageError("Run claudex --help for command usage.");
      return { kind: "help" };
    case "--version":
    case "-v":
      if (rest.length > 0) throw new LauncherUsageError("--version does not accept arguments.");
      return { kind: "version" };
    case "login":
      if (rest.length > 0)
        throw new LauncherUsageError("Invalid command options. Run claudex --help.");
      return { kind: "login" };
    case "doctor":
    case "models":
      return { kind: command, json: parseJsonOption(rest) };
    case "serve":
      return { kind: "serve", port: parseServePort(rest) };
    default:
      validateClaudeArguments(args, process.env);
      return { kind: "claude", args };
  }
}

async function toolVersion(command: string): Promise<string | null> {
  try {
    const result = await execute(command, ["--version"], { timeout: 5_000, maxBuffer: 32 * 1024 });
    return result.stdout.trim();
  } catch {
    return null;
  }
}

function processSignal() {
  const controller = new AbortController();
  const interrupt = () => controller.abort("SIGINT");
  const terminate = () => controller.abort("SIGTERM");
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  return {
    signal: controller.signal,
    dispose() {
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", terminate);
    },
  };
}

type Dependencies = {
  codex?: Pick<CodexClient, "models" | "responses">;
  claudeModels?: typeof claudeModels;
};

type ProxyContext = {
  codex: Pick<CodexClient, "models" | "responses">;
  signal: AbortSignal;
};

async function runDoctor(command: Extract<Command, { kind: "doctor" }>, auth: CodexAuth) {
  const [claude, codex, authentication] = await Promise.all([
    toolVersion("claude"),
    toolVersion("codex"),
    auth.status(),
  ]);
  const result = {
    bun: Bun.version,
    revision: Bun.revision,
    claude,
    codex,
    authentication,
    network: "not tested",
  };
  if (command.json) process.stdout.write(`${JSON.stringify(result)}\n`);
  else {
    process.stdout.write(
      `Bun: ${result.bun} (${result.revision.slice(0, 9)})\nClaude Code: ${claude ?? "not found"}\nCodex: ${codex ?? "not found"}\nCodex sign-in: ${authentication.authenticated ? authentication.source : "unavailable"}\nNetwork: not tested\n`,
    );
  }
  if (!authentication.authenticated)
    process.stderr.write("Run claudex login to sign in to Codex.\n");
  return claude && codex && authentication.authenticated ? 0 : 1;
}

async function runModels(
  command: Extract<Command, { kind: "models" }>,
  context: ProxyContext & Pick<Dependencies, "claudeModels">,
) {
  validateClaudeArguments([], process.env);
  const signal = AbortSignal.any([context.signal, AbortSignal.timeout(15_000)]);
  const [native, catalog] = await Promise.all([
    (context.claudeModels ?? claudeModels)({ signal }),
    context.codex.models(signal),
  ]);
  const coding = codexModels(catalog);
  if (coding.length === 0) throw new Error("No supported Codex coding models are available.");
  const models = [...native, ...coding];
  process.stdout.write(
    command.json
      ? `${JSON.stringify(models)}\n`
      : `${models.map((model) => model.id).join("\n")}\n`,
  );
  return 0;
}

async function runServe(command: Extract<Command, { kind: "serve" }>, context: ProxyContext) {
  const proxy = await startProxy({ codex: context.codex, port: command.port });
  try {
    process.stdout.write(`${proxy.url}\n`);
    process.stderr.write("Listening on loopback only. Press Ctrl+C to stop.\n");
    await new Promise<void>((resolve) => {
      if (context.signal.aborted) resolve();
      else context.signal.addEventListener("abort", () => resolve(), { once: true });
    });
    return context.signal.reason === "SIGINT" ? 130 : 143;
  } finally {
    await proxy.close();
  }
}

export async function main(
  args = process.argv.slice(2),
  dependencies: Dependencies = {},
): Promise<number> {
  const command = parseCommand(args);
  if (command.kind === "help") {
    process.stdout.write(HELP);
    return 0;
  }
  if (command.kind === "version") {
    process.stdout.write(`${metadata.version}\n`);
    return 0;
  }
  const auth = new CodexAuth();
  if (command.kind === "login") {
    await auth.login();
    process.stderr.write("Codex subscription sign-in saved in the dedicated local store.\n");
    return 0;
  }
  if (command.kind === "doctor") return await runDoctor(command, auth);
  const codex = dependencies.codex ?? new CodexClient(auth);
  const shutdown = processSignal();
  const context = { codex, signal: shutdown.signal };
  try {
    if (command.kind === "models") {
      return await runModels(command, { ...context, claudeModels: dependencies.claudeModels });
    }
    if (command.kind === "claude") {
      process.stderr.write("Starting the local proxy and loading Codex models.\n");
      return await launchClaude({ args: command.args, ...context });
    }
    return await runServe(command, context);
  } catch (error) {
    if (shutdown.signal.aborted) return shutdown.signal.reason === "SIGINT" ? 130 : 143;
    throw error;
  } finally {
    shutdown.dispose();
  }
}

if (import.meta.main) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(
        `Error: ${error instanceof Error ? error.message : "The command failed."}\n`,
      );
      process.exitCode = error instanceof LauncherUsageError ? 2 : 1;
    },
  );
}
