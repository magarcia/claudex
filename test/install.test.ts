import { afterEach, describe, expect, it } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const installer = fileURLToPath(new URL("../scripts/install.sh", import.meta.url));
const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true });
});

async function execute(command: string[], env: NodeJS.ProcessEnv, cwd: string) {
  const child = Bun.spawn(command, { env, cwd, stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

async function fixture({ os = "Darwin", arch = "arm64" } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "claudex-install-test-"));
  directories.push(directory);
  const commands = join(directory, "commands");
  const payload = join(directory, "payload");
  const destination = join(directory, "bin with spaces");
  const archive = join(directory, "archive.tar.gz");
  const manifest = join(directory, "manifest");
  const requests = join(directory, "requests");
  await Promise.all([commands, payload, destination].map((path) => mkdir(path)));
  await writeFile(join(payload, "claudex"), "#!/bin/sh\nprintf 'fixture-claudex\\n'\n");
  await chmod(join(payload, "claudex"), 0o755);
  const packed = await execute(
    ["tar", "-czf", archive, "-C", payload, "claudex"],
    process.env,
    directory,
  );
  if (packed.code !== 0) throw new Error(packed.stderr);
  const platform = `${os === "Darwin" ? "darwin" : "linux"}-${arch === "x86_64" ? "x64" : "arm64"}`;
  const asset = `claudex-${platform}.tar.gz`;
  const checksum = new Bun.CryptoHasher("sha256")
    .update(await Bun.file(archive).arrayBuffer())
    .digest("hex");
  await writeFile(manifest, `${checksum}  ${asset}\n`);
  await writeFile(
    join(commands, "uname"),
    '#!/bin/sh\ncase "$1" in -s) printf "%s\\n" "$STUB_OS" ;; -m) printf "%s\\n" "$STUB_ARCH" ;; *) exit 1 ;; esac\n',
  );
  await writeFile(
    join(commands, "curl"),
    `#!${process.execPath}
import { appendFile, copyFile } from 'node:fs/promises';
const args = process.argv.slice(2);
const url = args.find(arg => arg.startsWith('https://'));
const output = args[args.indexOf('--output') + 1];
if (!url || !output || !url.startsWith('https://github.com/magarcia/claudex/releases/')) process.exit(2);
await appendFile(process.env.REQUESTS, url + '\\n');
if (url.endsWith('/SHA256SUMS')) await copyFile(process.env.MANIFEST, output);
else if (url.endsWith('/' + process.env.ASSET)) await copyFile(process.env.ARCHIVE, output);
else process.exit(22);
`,
  );
  await Promise.all(["uname", "curl"].map((name) => chmod(join(commands, name), 0o755)));
  const env = {
    PATH: `${commands}:${process.env.PATH}`,
    HOME: directory,
    TMPDIR: directory,
    STUB_OS: os,
    STUB_ARCH: arch,
    MANIFEST: manifest,
    ARCHIVE: archive,
    REQUESTS: requests,
    ASSET: asset,
  };
  return {
    directory,
    destination,
    archive,
    manifest,
    requests,
    asset,
    run: (args: string[] = []) =>
      execute(["sh", installer, "--bin-dir", destination, ...args], env, directory),
  };
}

describe("release installer", () => {
  it.each([
    { os: "Darwin", arch: "arm64" },
    { os: "Darwin", arch: "x86_64" },
    { os: "Linux", arch: "aarch64" },
    { os: "Linux", arch: "x86_64" },
  ])("installs a verified executable for $os $arch without a Bun dependency", async (platform) => {
    const setup = await fixture(platform);
    const result = await setup.run();
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(`Installed claudex at ${setup.destination}/claudex.`);
    const binary = join(setup.destination, "claudex");
    expect((await stat(binary)).mode & 0o777).toBe(0o755);
    expect((await execute([binary], { PATH: "/usr/bin:/bin" }, setup.directory)).stdout).toBe(
      "fixture-claudex\n",
    );
    expect(await readFile(setup.requests, "utf8")).toContain(
      `/releases/latest/download/${setup.asset}`,
    );
  });

  it("uses a pinned release URL and replaces an existing executable", async () => {
    const setup = await fixture();
    await writeFile(join(setup.destination, "claudex"), "old executable");
    expect((await setup.run(["--version", "v0.1.0"])).code).toBe(0);
    expect(await readFile(setup.requests, "utf8")).toContain("/releases/download/v0.1.0/");
    expect(await readFile(join(setup.destination, "claudex"), "utf8")).toContain("fixture-claudex");
  });

  it("keeps the installed binary unchanged when the archive checksum is wrong", async () => {
    const setup = await fixture();
    const binary = join(setup.destination, "claudex");
    await writeFile(binary, "old executable");
    await writeFile(setup.manifest, `${"0".repeat(64)}  ${setup.asset}\n`);
    const result = await setup.run();
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Release checksum mismatch");
    expect(await readFile(binary, "utf8")).toBe("old executable");
  });

  it("fails when the manifest omits the requested architecture", async () => {
    const setup = await fixture();
    await writeFile(setup.manifest, `${"0".repeat(64)}  wrong.tar.gz\n`);
    expect((await setup.run()).code).not.toBe(0);
    expect(await Bun.file(join(setup.destination, "claudex")).exists()).toBe(false);
  });

  it("rejects unsupported platforms before attempting a download", async () => {
    const setup = await fixture({ os: "FreeBSD", arch: "x86_64" });
    const result = await setup.run();
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Supported systems");
    expect(await Bun.file(setup.requests).exists()).toBe(false);
  });

  it("rejects invalid options before attempting a download", async () => {
    const setup = await fixture();
    for (const args of [["--version", "../../bad"], ["--version"], ["--unknown"]]) {
      expect((await setup.run(args)).code).toBe(2);
    }
    expect(await Bun.file(setup.requests).exists()).toBe(false);
    expect((await setup.run(["--help"])).code).toBe(0);
  });
});
