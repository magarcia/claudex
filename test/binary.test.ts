import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import metadata from "../package.json" with { type: "json" };

const project = fileURLToPath(new URL("..", import.meta.url));
let directory: string;
let binary: string;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "claudex-aot-test-"));
  binary = join(directory, "claudex");
  const build = Bun.spawn(
    [
      "bun-canary",
      "compile",
      join(project, "src/cli.ts"),
      "--outfile",
      binary,
      "--no-compile-autoload-dotenv",
      "--no-compile-autoload-bunfig",
    ],
    { cwd: project, stdout: "pipe", stderr: "pipe" },
  );
  const [code, stdout, stderr] = await Promise.all([
    build.exited,
    new Response(build.stdout).text(),
    new Response(build.stderr).text(),
  ]);
  if (code !== 0) throw new Error(`AOT build failed:\n${stdout}\n${stderr}`);
}, 30000);

afterAll(async () => {
  if (directory) await rm(directory, { recursive: true });
});

async function execute(args: string[]) {
  const child = Bun.spawn([binary, ...args], {
    cwd: directory,
    env: { PATH: "/usr/bin:/bin" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

async function unusedPort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No TCP port was allocated.");
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

describe("standalone AOT executable", () => {
  it("launches Claude by default and fails early when no Claude executable is on PATH", async () => {
    const result = await execute([]);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Claude Code was not found on PATH");
  });

  it("runs help and the embedded version without Bun, Node, or package files in its directory", async () => {
    expect(await execute(["--version"])).toEqual({
      code: 0,
      stdout: `${metadata.version}\n`,
      stderr: "",
    });
    const help = await execute(["--help"]);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("Usage: claudex");
    expect(help.stderr).toBe("");
  });

  it("preserves usage errors and exit codes", async () => {
    const result = await execute(["serve", "--port", "0"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toBe("Error: --port must be an integer from 1 to 65535.\n");
  });

  it("serves loopback health requests and exits cleanly on SIGTERM", async () => {
    const port = await unusedPort();
    const child = Bun.spawn([binary, "serve", "--port", String(port)], {
      cwd: directory,
      env: { PATH: "/usr/bin:/bin", XDG_DATA_HOME: directory },
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      const reader = child.stdout.getReader();
      const first = await reader.read();
      reader.releaseLock();
      expect(new TextDecoder().decode(first.value).trim()).toBe(`http://127.0.0.1:${port}`);
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(2000),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
      child.kill("SIGTERM");
      expect(await child.exited).toBe(143);
    } finally {
      if (child.exitCode === null) {
        child.kill("SIGTERM");
        await child.exited;
      }
    }
  });
});
