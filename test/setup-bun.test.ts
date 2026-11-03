import { afterEach, describe, expect, it } from "bun:test";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const installer = fileURLToPath(new URL("../scripts/setup-bun.sh", import.meta.url));
const revision = "1.4.4-canary.1+3f3a9ff87";
const packageVersion = "1.4.4-canary.20261101.1";
const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true });
});

async function command(directory: string, name: string, source: string) {
  const path = join(directory, name);
  await writeFile(path, `#!${process.execPath}\n${source}`);
  await chmod(path, 0o755);
}

async function fixture({ os = "Darwin", arch = "arm64" } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "claudex-setup-bun-test-"));
  directories.push(directory);
  const commands = join(directory, "commands");
  const scripts = join(directory, "scripts");
  const temporary = join(directory, "temporary");
  const home = join(directory, "home with spaces");
  const bin = join(home, ".local", "bin");
  await Promise.all(
    [commands, scripts, temporary, bin].map((path) => mkdir(path, { recursive: true })),
  );
  const script = join(scripts, "setup-bun.sh");
  const pin = join(directory, ".bun-aot-version");
  const requests = join(directory, "requests");
  const extracted = join(directory, "extracted");
  const checked = join(directory, "checked");
  await copyFile(installer, script);
  await writeFile(pin, `${revision}\n`);
  await command(
    commands,
    "uname",
    `console.log(process.argv[2] === '-s' ? process.env.STUB_OS : process.env.STUB_ARCH);`,
  );
  await command(
    commands,
    "curl",
    `
import { appendFile, writeFile } from 'node:fs/promises';
const args = process.argv.slice(2);
if (args[args.indexOf('--connect-timeout') + 1] !== '15' || args[args.indexOf('--max-time') + 1] !== '180') process.exit(2);
await appendFile(process.env.REQUESTS, args.find(arg => arg.startsWith('https://')) + '\\n');
if (process.env.FAIL_AT === 'download') process.exit(22);
await writeFile(args[args.indexOf('--output') + 1], 'fixture archive');
`,
  );
  await command(
    commands,
    "shasum",
    `
import { writeFile } from 'node:fs/promises';
await writeFile(process.env.CHECKED, JSON.stringify({ args: process.argv.slice(2), input: await Bun.stdin.text() }));
if (process.env.FAIL_AT === 'checksum') process.exit(1);
`,
  );
  await command(
    commands,
    "tar",
    `
import { writeFile } from 'node:fs/promises';
await writeFile(process.env.EXTRACTED, JSON.stringify(process.argv.slice(2)));
if (process.env.FAIL_AT === 'extract') process.exit(2);
process.stdout.write(process.env.FAIL_AT === 'revision' ? '#!/bin/sh\\nexit 1\\n' : ${JSON.stringify(`#!/bin/sh\nprintf '%s\\n' '${revision}'\n`)});
`,
  );
  const env = {
    PATH: `${commands}:${process.env.PATH}`,
    HOME: home,
    TMPDIR: temporary,
    STUB_OS: os,
    STUB_ARCH: arch,
    REQUESTS: requests,
    EXTRACTED: extracted,
    CHECKED: checked,
  };
  return {
    directory,
    temporary,
    bin,
    pin,
    requests,
    extracted,
    checked,
    runtime: join(bin, "bun-canary"),
    run: async (overrides: NodeJS.ProcessEnv = {}) => {
      const child = Bun.spawn(["sh", script], {
        env: { ...env, ...overrides },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      return { code, stdout, stderr };
    },
  };
}

async function installed(path: string, output: string) {
  await writeFile(path, `#!/bin/sh\nprintf '%s\\n' '${output}'\n`);
  await chmod(path, 0o755);
}

async function expectClean(setup: Awaited<ReturnType<typeof fixture>>) {
  expect(await readdir(setup.temporary)).toEqual([]);
  expect((await readdir(setup.bin)).filter((name) => name !== "bun-canary")).toEqual([]);
}

describe("pinned Bun compiler setup", () => {
  it.each([
    {
      os: "Darwin",
      arch: "arm64",
      platform: "darwin-aarch64",
      checksum: "ac6f96498c8e514366f3e1713064211c068faadff60e7d7238dd17313ee09519",
    },
    {
      os: "Darwin",
      arch: "x86_64",
      platform: "darwin-x64",
      checksum: "444f95088a711b148e5f74a67b9500d1e9dc4df2f9dc477fe97d038895c639f8",
    },
    {
      os: "Linux",
      arch: "aarch64",
      platform: "linux-aarch64",
      checksum: "b9b779eaa1f80cf5935e3ae5669e52b78efa12b5f57dfb1b6bc321248e1def2a",
    },
    {
      os: "Linux",
      arch: "x86_64",
      platform: "linux-x64",
      checksum: "a451026236522d11b59794609f837766d8dc16eede99d93b3c1843b887b249b4",
    },
  ])("installs the exact package for $os $arch with checksum verification", async (platform) => {
    const setup = await fixture(platform);
    const result = await setup.run();
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`bun-canary ${revision} installed`);
    expect(await readFile(setup.requests, "utf8")).toBe(
      `https://registry.npmjs.org/@oven/bun-${platform.platform}/-/bun-${platform.platform}-${packageVersion}.tgz\n`,
    );
    expect(await readFile(setup.checked, "utf8")).toContain(platform.checksum);
    expect(await readFile(setup.checked, "utf8")).toContain('"-a","256","--check","--status"');
    expect(await readFile(setup.extracted, "utf8")).toContain("package/bin/bun");
    expect((await stat(setup.runtime)).mode & 0o777).toBe(0o755);
    await expectClean(setup);
  });

  it("accepts a pin without a final newline", async () => {
    const setup = await fixture();
    await writeFile(setup.pin, revision);
    expect((await setup.run()).code).toBe(0);
  });

  it("rejects an empty pin before downloading", async () => {
    const setup = await fixture();
    await writeFile(setup.pin, "");
    const result = await setup.run();
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(".bun-aot-version is empty");
    expect(await Bun.file(setup.requests).exists()).toBe(false);
  });

  it("reuses an installed compiler only when its revision matches", async () => {
    const setup = await fixture();
    await installed(setup.runtime, revision);
    expect((await setup.run()).code).toBe(0);
    expect(await Bun.file(setup.requests).exists()).toBe(false);
  });

  it("preserves a different existing compiler without downloading", async () => {
    const setup = await fixture();
    await installed(setup.runtime, "different-revision");
    const original = await readFile(setup.runtime, "utf8");
    const result = await setup.run();
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("has not been replaced");
    expect(await readFile(setup.runtime, "utf8")).toBe(original);
    expect(await Bun.file(setup.requests).exists()).toBe(false);
  });

  it("preserves an existing compiler that cannot report its revision", async () => {
    const setup = await fixture();
    await writeFile(setup.runtime, "#!/bin/sh\nexit 1\n");
    await chmod(setup.runtime, 0o755);
    const result = await setup.run();
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("has not been replaced");
    expect(await Bun.file(setup.requests).exists()).toBe(false);
  });

  it("does not overwrite a broken compiler symlink", async () => {
    const setup = await fixture();
    await symlink(join(setup.directory, "missing"), setup.runtime);
    const result = await setup.run();
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("has not been replaced");
    expect(await Bun.file(setup.requests).exists()).toBe(false);
  });

  it("rejects unsupported platforms before downloading", async () => {
    const setup = await fixture({ os: "FreeBSD" });
    expect((await setup.run()).code).toBe(1);
    expect(await Bun.file(setup.requests).exists()).toBe(false);
  });

  it.each([
    { failure: "download", diagnostic: "Could not download" },
    { failure: "checksum", diagnostic: "checksum mismatch" },
    { failure: "extract", diagnostic: "Could not extract" },
  ])("reports $failure failure and removes temporary files", async ({ failure, diagnostic }) => {
    const setup = await fixture();
    const result = await setup.run({ FAIL_AT: failure });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(diagnostic);
    expect(await Bun.file(setup.runtime).exists()).toBe(false);
    if (failure !== "extract") expect(await Bun.file(setup.extracted).exists()).toBe(false);
    await expectClean(setup);
  });

  it("rejects a downloaded compiler that cannot report its revision", async () => {
    const setup = await fixture();
    const result = await setup.run({ FAIL_AT: "revision" });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Could not read the downloaded Bun revision");
    expect(await Bun.file(setup.runtime).exists()).toBe(false);
    await expectClean(setup);
  });

  it("rejects a downloaded compiler with a different revision", async () => {
    const setup = await fixture();
    await writeFile(setup.pin, "different-revision\n");
    const result = await setup.run();
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("does not match .bun-aot-version");
    expect(await Bun.file(setup.runtime).exists()).toBe(false);
    await expectClean(setup);
  });
});
