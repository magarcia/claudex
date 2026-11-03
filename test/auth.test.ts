import { spawn, spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, setSystemTime, vi } from "bun:test";
import { CodexAuth } from "../src/codex/auth.ts";
import type { Fetch } from "../src/fetch.ts";

function jwt(expires: number, label = "access"): string {
  return `header.${Buffer.from(JSON.stringify({ exp: Math.floor(expires / 1_000), label })).toString("base64url")}.signature`;
}

function credentials(access: string, refresh = "refresh-old") {
  return {
    auth_mode: "chatgpt",
    tokens: {
      access_token: access,
      refresh_token: refresh,
      id_token: "id-old",
      account_id: "account-1",
    },
    retained: true,
  };
}

describe("CodexAuth", () => {
  let directory: string;
  let home: string;
  let fallbackHome: string;
  const originalPath = process.env.PATH;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "proxy-auth-test-"));
    home = join(directory, "managed");
    fallbackHome = join(directory, "shared");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    setSystemTime();
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    await rm(directory, { recursive: true });
  });

  async function save(target: string, value: unknown): Promise<void> {
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "auth.json"), JSON.stringify(value));
  }

  it("uses a fresh shared token without copying or exchanging its refresh grant", async () => {
    const expiry = Math.floor((Date.now() + 3_600_000) / 1_000) * 1_000;
    const token = jwt(expiry);
    await save(fallbackHome, credentials(token));
    const before = await readFile(join(fallbackHome, "auth.json"), "utf8");
    const fetch = vi.fn<Fetch>();
    const auth = new CodexAuth({ home, fallbackHome, fetch });

    expect(await auth.getAccessToken()).toBe(token);
    expect(await auth.getAccessToken({ forceRefresh: true })).toBe(token);
    expect(await auth.status()).toEqual({
      source: "shared",
      authenticated: true,
      expiresAt: new Date(expiry).toISOString(),
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(await readFile(join(fallbackHome, "auth.json"), "utf8")).toBe(before);
    await expect(stat(home)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rereads shared credentials on forceRefresh without exchanging an expired grant", async () => {
    const token = jwt(Date.now() + 3_600_000);
    await save(fallbackHome, credentials(token));
    const fetch = vi.fn<Fetch>();
    const auth = new CodexAuth({ home, fallbackHome, fetch });
    expect(await auth.getAccessToken()).toBe(token);
    await save(fallbackHome, credentials(jwt(Date.now() - 1_000)));
    const before = await readFile(join(fallbackHome, "auth.json"), "utf8");

    await expect(auth.getAccessToken({ forceRefresh: true })).rejects.toThrow("Run claudex login");
    expect(fetch).not.toHaveBeenCalled();
    expect(await readFile(join(fallbackHome, "auth.json"), "utf8")).toBe(before);
    expect(await auth.status()).toMatchObject({ source: "shared", authenticated: false });
  });

  it("reports missing auth and rejects API keys and malformed subscription files safely", async () => {
    const auth = new CodexAuth({ home, fallbackHome, fetch: vi.fn<Fetch>() });
    expect(await auth.status()).toEqual({ source: "none", authenticated: false });
    await expect(auth.getAccessToken()).rejects.toThrow("Run claudex login");
    await save(home, { auth_mode: "apikey", OPENAI_API_KEY: "private-key-that-must-not-leak" });
    await expect(auth.getAccessToken()).rejects.toThrow("Run claudex login");
    expect(await auth.status()).toEqual({ source: "managed", authenticated: false });
    await writeFile(join(home, "auth.json"), "invalid-secret-json");
    await expect(auth.getAccessToken()).rejects.toThrow(/^Codex subscription login required\./);
  });

  it("rotates managed credentials once across separate instances and persists private atomic state", async () => {
    const expired = jwt(Date.now() - 60_000);
    const fresh = jwt(Date.now() + 3_600_000, "rotated");
    await save(home, credentials(expired));
    let release: (() => void) | undefined;
    const started = Promise.withResolvers<void>();
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetch = vi.fn<Fetch>(async (url, init) => {
      expect(url).toBe("https://auth.openai.com/oauth/token");
      expect(init?.redirect).toBe("error");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(JSON.parse(String(init?.body))).toEqual({
        grant_type: "refresh_token",
        refresh_token: "refresh-old",
        client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
      });
      started.resolve();
      await gate;
      return Response.json({
        access_token: fresh,
        refresh_token: "refresh-new",
        id_token: "id-new",
      });
    });
    const first = new CodexAuth({ home, fallbackHome, fetch });
    const second = new CodexAuth({ home, fallbackHome, fetch });
    const one = first.getAccessToken();
    await started.promise;
    const two = second.getAccessToken();
    expect(JSON.parse(await readFile(join(home, "auth.json"), "utf8")).tokens.access_token).toBe(
      expired,
    );
    release?.();

    expect(await Promise.all([one, two])).toEqual([fresh, fresh]);
    expect(fetch).toHaveBeenCalledTimes(1);
    const saved = JSON.parse(await readFile(join(home, "auth.json"), "utf8"));
    expect(saved).toMatchObject({
      retained: true,
      auth_mode: "chatgpt",
      tokens: {
        access_token: fresh,
        refresh_token: "refresh-new",
        id_token: "id-new",
        account_id: "account-1",
      },
    });
    expect(saved.last_refresh).toEqual(expect.any(String));
    expect((await stat(join(home, "auth.json"))).mode & 0o777).toBe(0o600);
    expect(await readdir(home)).toEqual(["auth.json"]);
  });

  it("coalesces force refresh and preserves optional tokens absent from the OAuth response", async () => {
    const original = jwt(Date.now() + 3_600_000);
    const fresh = jwt(Date.now() + 3_600_000, "new");
    await save(home, credentials(original));
    const fetch = vi.fn<Fetch>(async () => Response.json({ access_token: fresh }));
    const auth = new CodexAuth({ home, fallbackHome, fetch });
    expect(await auth.getAccessToken()).toBe(original);
    expect(
      await Promise.all([
        auth.getAccessToken({ forceRefresh: true }),
        auth.getAccessToken({ forceRefresh: true }),
      ]),
    ).toEqual([fresh, fresh]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(await readFile(join(home, "auth.json"), "utf8")).tokens).toMatchObject({
      refresh_token: "refresh-old",
      id_token: "id-old",
    });
  });

  it("serializes refresh-token rotation across independent Bun processes", async () => {
    await save(home, credentials(jwt(Date.now() - 1_000)));
    const fresh = jwt(Date.now() + 3_600_000, "cross-process");
    const exchanges = join(directory, "exchanges");
    const worker = join(directory, "refresh.mjs");
    await writeFile(
      worker,
      `
import { appendFile } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';
import { CodexAuth } from ${JSON.stringify(pathToFileURL(join(process.cwd(), "src/codex/auth.ts")).href)};
const auth = new CodexAuth({
  home: ${JSON.stringify(home)}, fallbackHome: ${JSON.stringify(fallbackHome)},
  fetch: async () => {
    await appendFile(${JSON.stringify(exchanges)}, 'exchange\\n');
    await setTimeout(150);
    return Response.json({ access_token: ${JSON.stringify(fresh)}, refresh_token: 'rotated-once' });
  },
});
if (await auth.getAccessToken() !== ${JSON.stringify(fresh)}) process.exitCode = 1;
`,
    );
    function run(): Promise<void> {
      return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [worker], { stdio: "ignore" });
        child.once("error", reject);
        child.once("exit", (code) =>
          code === 0 ? resolve() : reject(new Error("Synthetic auth worker failed")),
        );
      });
    }
    await Promise.all([run(), run()]);
    expect(await readFile(exchanges, "utf8")).toBe("exchange\n");
    expect(JSON.parse(await readFile(join(home, "auth.json"), "utf8")).tokens.refresh_token).toBe(
      "rotated-once",
    );
  });

  it("recovers a lock abandoned by a dead process", async () => {
    await save(home, credentials(jwt(Date.now() - 1_000)));
    const exited = spawnSync(process.execPath, ["-e", ""]);
    expect(exited.status).toBe(0);
    const lock = join(home, "auth-refresh.lock");
    await mkdir(lock);
    await writeFile(join(lock, `owner-${exited.pid}-aabbcc`), "");
    const fresh = jwt(Date.now() + 3_600_000);
    const fetch = vi.fn<Fetch>(async () => Response.json({ access_token: fresh }));
    expect(await new CodexAuth({ home, fallbackHome, fetch }).getAccessToken()).toBe(fresh);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("fails within the deadline without removing a live owner lock", async () => {
    await save(home, credentials(jwt(Date.now() - 1_000)));
    const lock = join(home, "auth-refresh.lock");
    await mkdir(lock);
    const owner = `owner-${process.pid}-aabbcc`;
    await writeFile(join(lock, owner), "");
    const now = Date.now();
    setSystemTime(now);
    const fetch = vi.fn<Fetch>();
    const request = new CodexAuth({ home, fallbackHome, fetch })
      .getAccessToken()
      .catch((error: unknown) => error);
    await new Promise<void>((resolve) => setTimeout(resolve, 60));
    setSystemTime(now + 20_000);
    const error = await request;
    expect(error).toBeInstanceOf(Error);
    expect(error).toHaveProperty("message", expect.stringContaining("credentials are busy"));
    expect(await readdir(lock)).toEqual([owner]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["http", "invalid", "expired", "network"])(
    "keeps original credentials and releases locks after a %s refresh error",
    async (failure) => {
      await save(home, credentials(jwt(Date.now() - 1_000)));
      const before = await readFile(join(home, "auth.json"), "utf8");
      const fetch = vi.fn<Fetch>(async () => {
        if (failure === "network") throw new Error("private-refresh-token-and-body");
        if (failure === "http")
          return new Response("private-refresh-token-and-body", { status: 401 });
        if (failure === "expired") return Response.json({ access_token: jwt(Date.now() - 1_000) });
        return Response.json({ access_token: "private-refresh-token-and-body" });
      });
      const auth = new CodexAuth({ home, fallbackHome, fetch });
      await expect(auth.getAccessToken()).rejects.toThrow(
        /^Cannot refresh Codex subscription credentials\. Retry or run claudex login\.$/,
      );
      expect(await readFile(join(home, "auth.json"), "utf8")).toBe(before);
      expect(await readdir(home)).toEqual(["auth.json"]);
    },
  );

  it("uses a ten second abort signal for OAuth requests", async () => {
    await save(home, credentials(jwt(Date.now() - 1_000)));
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const fetch = vi.fn<Fetch>(async () =>
      Response.json({ access_token: jwt(Date.now() + 3_600_000) }),
    );
    await new CodexAuth({ home, fallbackHome, fetch }).getAccessToken();
    expect(timeout).toHaveBeenCalledWith(10_000);
  });

  it("runs the installed CLI with isolated CODEX_HOME and the file store", async () => {
    const bin = join(directory, "bin");
    await mkdir(bin);
    const codex = join(bin, "codex");
    const token = jwt(Date.now() + 3_600_000);
    await writeFile(
      codex,
      `#!${process.execPath}\nconst fs = require('node:fs');\nconst path = require('node:path');\nfs.writeFileSync(path.join(process.env.CODEX_HOME, 'invocation.json'), JSON.stringify({args: process.argv.slice(2), home: process.env.CODEX_HOME}));\nfs.writeFileSync(path.join(process.env.CODEX_HOME, 'auth.json'), ${JSON.stringify(JSON.stringify(credentials(token)))});\n`,
    );
    await chmod(codex, 0o700);
    process.env.PATH = `${bin}:${process.env.PATH ?? ""}`;
    await save(fallbackHome, credentials(jwt(Date.now() + 3_600_000), "shared-grant"));
    const shared = await readFile(join(fallbackHome, "auth.json"), "utf8");
    const fetch = vi.fn<Fetch>();
    const auth = new CodexAuth({ home, fallbackHome, fetch });
    await auth.login();
    expect(JSON.parse(await readFile(join(home, "invocation.json"), "utf8"))).toEqual({
      args: ["-c", 'cli_auth_credentials_store="file"', "login"],
      home,
    });
    expect(await auth.getAccessToken()).toBe(token);
    expect((await stat(join(home, "auth.json"))).mode & 0o777).toBe(0o600);
    expect(await readFile(join(fallbackHome, "auth.json"), "utf8")).toBe(shared);
    expect(fetch).not.toHaveBeenCalled();
  });
});
