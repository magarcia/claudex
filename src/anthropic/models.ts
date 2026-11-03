import { execFile } from "node:child_process";
import * as v from "valibot";

const ModelInfo = v.object({
  value: v.string(),
  resolvedModel: v.optional(v.string()),
  displayName: v.string(),
  description: v.string(),
});
const Initialization = v.object({ models: v.array(ModelInfo) });
const ControlResponse = v.object({
  type: v.literal("control_response"),
  response: v.object({
    request_id: v.string(),
    subtype: v.string(),
    response: v.optional(v.unknown()),
  }),
});
const DISCOVERY_ERROR =
  "Could not discover native Claude models. Check `claude auth status` and update Claude Code.";
const DISCOVERY_ARGS = [
  "--print",
  "--input-format",
  "stream-json",
  "--output-format",
  "stream-json",
  "--verbose",
  "--strict-mcp-config",
  "--mcp-config",
  '{"mcpServers":{}}',
  "--tools",
  "",
  "--no-session-persistence",
  "--settings",
  '{"disableAllHooks":true}',
];

function discoveryEnvironment(env: NodeJS.ProcessEnv) {
  const environment: NodeJS.ProcessEnv = {
    ...env,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_AUTOUPDATER: "1",
  };
  delete environment.ANTHROPIC_BASE_URL;
  delete environment.ANTHROPIC_API_KEY;
  delete environment.ANTHROPIC_AUTH_TOKEN;
  return environment;
}

function initializeClaude({
  claude,
  signal,
  env,
  requestId,
}: {
  claude: string;
  signal: AbortSignal;
  env: NodeJS.ProcessEnv;
  requestId: string;
}) {
  const request = JSON.stringify({
    type: "control_request",
    request_id: requestId,
    request: { subtype: "initialize" },
  });
  return new Promise<string>((resolve, reject) => {
    const child = execFile(
      claude,
      DISCOVERY_ARGS,
      {
        env,
        signal,
        timeout: 15_000,
        killSignal: "SIGKILL",
        maxBuffer: 4 * 1024 * 1024,
      },
      (error, stdout) => {
        if (error) reject(new Error(DISCOVERY_ERROR));
        else resolve(stdout);
      },
    );
    child.stdin?.on("error", () => {
      child.kill("SIGKILL");
      reject(new Error(DISCOVERY_ERROR));
    });
    child.stdin?.end(`${request}\n`);
  });
}

function parseInitialization(output: string, requestId: string) {
  for (const line of output.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new Error(DISCOVERY_ERROR);
    }
    const parsed = v.safeParse(ControlResponse, value);
    if (!parsed.success || parsed.output.response.request_id !== requestId) continue;
    if (parsed.output.response.subtype !== "success") throw new Error(DISCOVERY_ERROR);
    const initialized = v.safeParse(Initialization, parsed.output.response.response);
    if (!initialized.success) throw new Error(DISCOVERY_ERROR);
    return initialized.output.models;
  }
  throw new Error(DISCOVERY_ERROR);
}

function nativeModels(choices: v.InferOutput<typeof Initialization>["models"]) {
  const ordered = [
    ...choices.filter((model) => model.value !== "default"),
    ...choices.filter((model) => model.value === "default"),
  ];
  const seen = new Set<string>();
  const models = ordered.flatMap((model) => {
    const id = model.resolvedModel ?? model.value;
    if (!id.startsWith("claude-") || seen.has(id)) return [];
    seen.add(id);
    return [{ id, display_name: model.displayName, description: model.description }];
  });
  if (models.length === 0) throw new Error(DISCOVERY_ERROR);
  return models;
}

export async function claudeModels({
  signal,
  env = process.env,
  executable = "claude",
}: {
  signal: AbortSignal;
  env?: NodeJS.ProcessEnv;
  executable?: string;
}) {
  signal.throwIfAborted();
  const claude = Bun.which(executable, { PATH: env.PATH ?? "" });
  if (!claude)
    throw new Error("Claude Code was not found on PATH. Install it to list native Claude models.");
  const environment = discoveryEnvironment(env);
  const requestId = crypto.randomUUID();
  const output = await initializeClaude({ claude, signal, env: environment, requestId });
  return nativeModels(parseInitialization(output, requestId));
}
