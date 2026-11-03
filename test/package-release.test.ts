import { afterEach, expect, it } from "bun:test";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const project = fileURLToPath(new URL("..", import.meta.url));
const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true });
});

async function execute(args: string[], cwd: string) {
  const child = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "claudex-package-test-"));
  directories.push(directory);
  await Promise.all(["scripts", "dist", "licenses"].map((name) => mkdir(join(directory, name))));
  await Promise.all([
    copyFile(
      join(project, "scripts/package-release.sh"),
      join(directory, "scripts/package-release.sh"),
    ),
    copyFile(join(project, "LICENSE"), join(directory, "LICENSE")),
    copyFile(join(project, "licenses/valibot.txt"), join(directory, "licenses/valibot.txt")),
    writeFile(join(directory, "dist/claudex"), "#!/bin/sh\nprintf 'synthetic executable\\n'\n"),
  ]);
  await chmod(join(directory, "dist/claudex"), 0o755);
  return {
    directory,
    run: (args: string[]) => execute(["sh", "scripts/package-release.sh", ...args], directory),
  };
}

it.each(["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"])(
  "packages the executable and license materials for %s",
  async (platform) => {
    const setup = await fixture();
    expect((await setup.run([platform])).code).toBe(0);
    const archive = join(setup.directory, `release/claudex-${platform}.tar.gz`);
    const listing = await execute(["tar", "-tzf", archive], setup.directory);
    expect(listing.code).toBe(0);
    expect(listing.stdout.split("\n")).toEqual(
      expect.arrayContaining(["LICENSE", "licenses/valibot.txt", "claudex"]),
    );
    const notice = await execute(
      ["tar", "-xOzf", archive, "licenses/valibot.txt"],
      setup.directory,
    );
    expect(notice.code).toBe(0);
    expect(notice.stdout).toBe(
      await readFile(join(project, "node_modules/valibot/LICENSE.md"), "utf8"),
    );
  },
);

it("rejects invalid platform names before creating an archive", async () => {
  const setup = await fixture();
  for (const args of [[], ["../unexpected"], ["linux-x64", "extra"]]) {
    expect((await setup.run(args)).code).toBe(2);
  }
  expect(await Bun.file(join(setup.directory, "release/claudex-linux-x64.tar.gz")).exists()).toBe(
    false,
  );
});

it.each(["dist/claudex", "LICENSE", "licenses/valibot.txt"])(
  "does not package a release when %s is missing",
  async (path) => {
    const setup = await fixture();
    await rm(join(setup.directory, path));
    expect((await setup.run(["linux-x64"])).code).not.toBe(0);
    expect(await Bun.file(join(setup.directory, "release/claudex-linux-x64.tar.gz")).exists()).toBe(
      false,
    );
  },
);
