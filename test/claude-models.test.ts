import { afterEach, describe, expect, it } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as v from "valibot";

import { claudeModels } from "../src/anthropic/models.ts";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true });
});

async function fixture(mode = "success") {
  const directory = await mkdtemp(join(tmpdir(), "claudex-claude-models-"));
  directories.push(directory);
  const executable = join(directory, "claude");
  const capture = join(directory, "capture.json");
  await writeFile(
    executable,
    `#!${process.execPath}
import { writeFile } from 'node:fs/promises';
const input = await Bun.stdin.text();
const requests = input.trim().split('\\n').map(line => JSON.parse(line));
await writeFile(process.env.CAPTURE_FILE, JSON.stringify({
  args:process.argv.slice(2), requests,
  environment:{baseUrl:process.env.ANTHROPIC_BASE_URL ?? null,apiKey:process.env.ANTHROPIC_API_KEY ?? null,authToken:process.env.ANTHROPIC_AUTH_TOKEN ?? null,oauthToken:process.env.CLAUDE_CODE_OAUTH_TOKEN,disabledTraffic:process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC},
}));
const mode = process.env.PROBE_MODE;
if (mode === 'hang') { process.on('SIGTERM',()=>{}); setInterval(()=>{},1000); }
else if (mode === 'exit') { process.stderr.write('synthetic-private-error'); process.exit(1); }
else if (mode === 'oversized') process.stdout.write('x'.repeat(4 * 1024 * 1024 + 1));
else if (mode === 'malformed') process.stdout.write('synthetic-private-error');
else {
  let models = [
    {value:'default',resolvedModel:'claude-opus-5-5',displayName:'Default (recommended)',description:'Default model'},
    {value:'opus',resolvedModel:'claude-opus-5-5',displayName:'Opus',description:'Complex tasks'},
    {value:'sonnet',resolvedModel:'claude-sonnet-5-5',displayName:'Sonnet',description:'Routine tasks'},
    {value:'claude-fable-5-1[1m]',resolvedModel:'claude-fable-5-1',displayName:'Fable',description:'Long tasks'},
    {value:'claude-haiku-4-5',displayName:'Haiku',description:'Quick tasks'},
    {value:'opus',resolvedModel:'codex/gpt-6-astra',displayName:'Remapped Opus',description:'Codex alias'},
  ];
  if (mode === 'empty') models = [];
  if (mode === 'invalid') models = [{value:123}];
  if (mode === 'default-only') models = models.slice(0,1);
  const response = {type:'control_response',response:{subtype:mode === 'error' ? 'error' : 'success',request_id: mode === 'wrong-id' ? 'other-request' : requests[0].request_id,response:{models,account:{email:'synthetic-private-email'}}}};
  const preceding = mode === 'unrelated-responses'
    ? JSON.stringify({type:'control_response',response:{subtype:'error',request_id:'other-request'}}) + '\\n' + JSON.stringify({type:'control_response',response:{request_id:requests[0].request_id}}) + '\\n'
    : mode === 'malformed-before' ? 'synthetic-private-error\\n' : '';
  const following = mode === 'malformed-after' ? 'synthetic-private-error\\n' : '';
  process.stdout.write(JSON.stringify({type:'system',subtype:'init'}) + '\\n' + preceding + JSON.stringify(response) + '\\n' + following);
}
`,
  );
  await chmod(executable, 0o755);
  const env: NodeJS.ProcessEnv = {
    PATH: directory,
    CAPTURE_FILE: capture,
    PROBE_MODE: mode,
    ANTHROPIC_BASE_URL: "https://synthetic-gateway.invalid",
    ANTHROPIC_API_KEY: "synthetic-api-key",
    ANTHROPIC_AUTH_TOKEN: "synthetic-auth-token",
    CLAUDE_CODE_OAUTH_TOKEN: "synthetic-oauth-token",
  };
  return {
    executable,
    capture,
    env,
    run: (signal = AbortSignal.timeout(5000)) => claudeModels({ signal, env }),
  };
}

describe("Claude model discovery", () => {
  it("resolves native aliases, keeps explicit IDs, removes duplicates and Codex overrides", async () => {
    const setup = await fixture();
    expect(await setup.run()).toEqual([
      { id: "claude-opus-5-5", display_name: "Opus", description: "Complex tasks" },
      { id: "claude-sonnet-5-5", display_name: "Sonnet", description: "Routine tasks" },
      { id: "claude-fable-5-1", display_name: "Fable", description: "Long tasks" },
      { id: "claude-haiku-4-5", display_name: "Haiku", description: "Quick tasks" },
    ]);
    const captured = v.parse(
      v.object({
        args: v.array(v.string()),
        requests: v.array(v.unknown()),
        environment: v.unknown(),
      }),
      JSON.parse(await readFile(setup.capture, "utf8")),
    );
    expect(captured.requests).toEqual([
      {
        type: "control_request",
        request_id: expect.any(String),
        request: { subtype: "initialize" },
      },
    ]);
    expect(captured.args).toEqual([
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
    ]);
    expect(captured.environment).toEqual({
      baseUrl: null,
      apiKey: null,
      authToken: null,
      oauthToken: "synthetic-oauth-token",
      disabledTraffic: "1",
    });
    expect(setup.env.ANTHROPIC_API_KEY).toBe("synthetic-api-key");
  });

  it("uses a native default row if it has no duplicate alias", async () => {
    const setup = await fixture("default-only");
    expect(await setup.run()).toEqual([
      {
        id: "claude-opus-5-5",
        display_name: "Default (recommended)",
        description: "Default model",
      },
    ]);
  });

  it.each(["unrelated-responses", "malformed-after"])(
    "uses the first matching response with %s output",
    async (mode) => {
      const setup = await fixture(mode);
      expect((await setup.run()).map((model) => model.id)).toEqual([
        "claude-opus-5-5",
        "claude-sonnet-5-5",
        "claude-fable-5-1",
        "claude-haiku-4-5",
      ]);
    },
  );

  it.each([
    "exit",
    "oversized",
    "malformed",
    "malformed-before",
    "empty",
    "invalid",
    "error",
    "wrong-id",
  ])("rejects %s output without revealing private process data", async (mode) => {
    const setup = await fixture(mode);
    const error: unknown = await setup.run().catch((error: unknown) => error);
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({
      message:
        "Could not discover native Claude models. Check `claude auth status` and update Claude Code.",
    });
    expect(error).not.toHaveProperty("cause");
  });

  it("kills a stalled discovery process when its deadline expires", async () => {
    const setup = await fixture("hang");
    const error: unknown = await setup
      .run(AbortSignal.timeout(100))
      .catch((error: unknown) => error);
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({
      message: expect.stringContaining("Could not discover native Claude models"),
    });
  });

  it("reports a missing Claude executable before starting a process", async () => {
    const error: unknown = await claudeModels({
      signal: AbortSignal.timeout(5000),
      env: { PATH: "" },
    }).catch((error: unknown) => error);
    expect(error).toMatchObject({
      message: expect.stringContaining("Claude Code was not found on PATH"),
    });
  });

  it("honors an already aborted signal before discovery", async () => {
    const setup = await fixture();
    const reason = new Error("Synthetic cancellation");
    const error: unknown = await setup
      .run(AbortSignal.abort(reason))
      .catch((error: unknown) => error);
    expect(error).toBe(reason);
    expect(await Bun.file(setup.capture).exists()).toBe(false);
  });
});
