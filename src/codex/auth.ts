import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rmdir, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import * as v from "valibot";
import type { Fetch } from "../fetch.ts";

const TOKEN_ENDPOINT = "https://auth.openai.com/oauth/token";
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const REFRESH_TIMEOUT_MS = 10_000;
const LOCK_TIMEOUT_MS = 12_000;
const EMPTY_LOCK_GRACE_MS = 2_000;
const REFRESH_MARGIN_MS = 60_000;
const LOGIN_REQUIRED = "Codex subscription login required. Run claudex login.";
const NONEMPTY_STRING = v.pipe(v.string(), v.minLength(1));
const authSchema = v.looseObject({
  auth_mode: v.optional(v.literal("chatgpt")),
  tokens: v.looseObject({
    access_token: NONEMPTY_STRING,
    refresh_token: v.optional(NONEMPTY_STRING),
    id_token: v.optional(v.string()),
  }),
});
const sharedAuthSchema = v.object({
  auth_mode: v.optional(v.literal("chatgpt")),
  tokens: v.object({ access_token: NONEMPTY_STRING }),
});
const tokenResponseSchema = v.object({
  access_token: NONEMPTY_STRING,
  refresh_token: v.optional(NONEMPTY_STRING),
  id_token: v.optional(v.string()),
});
const expirySchema = v.object({
  exp: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(8_640_000_000_000)),
});

type ManagedAuth = v.InferOutput<typeof authSchema>;
type AuthOptions = { home?: string; fallbackHome?: string; fetch?: Fetch };
type AuthStatus = {
  source: "managed" | "shared" | "none";
  authenticated: boolean;
  expiresAt?: string;
};

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function expiresAt(token: string): number | undefined {
  try {
    const payload = token.split(".")[1];
    if (!payload) return undefined;
    const result = v.safeParse(
      expirySchema,
      JSON.parse(Buffer.from(payload, "base64url").toString()),
    );
    return result.success ? result.output.exp * 1_000 : undefined;
  } catch {
    return undefined;
  }
}

function isFresh(token: string, margin = 0): boolean {
  const expiry = expiresAt(token);
  return expiry !== undefined && expiry > Date.now() + margin;
}

async function readAuthJson(home: string): Promise<unknown | undefined> {
  let contents: string;
  try {
    contents = await readFile(join(home, "auth.json"), "utf8");
  } catch (error) {
    if (hasCode(error, "ENOENT")) return undefined;
    throw new Error("Cannot read Codex credentials. Check the local credential file permissions.", {
      cause: error,
    });
  }
  try {
    return JSON.parse(contents);
  } catch {
    throw new Error(LOGIN_REQUIRED);
  }
}

async function readManagedAuth(home: string): Promise<ManagedAuth | undefined> {
  const json = await readAuthJson(home);
  if (json === undefined) return undefined;
  const parsed = v.safeParse(authSchema, json);
  if (!parsed.success) throw new Error(LOGIN_REQUIRED);
  return parsed.output;
}

async function saveAuth(home: string, auth: ManagedAuth): Promise<void> {
  const temporary = join(home, `auth-${randomUUID()}.tmp`);
  try {
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(`${JSON.stringify(auth)}\n`);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, join(home, "auth.json"));
  } catch {
    throw new Error(
      "Cannot save Codex credentials. Check the local credential directory permissions.",
    );
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

function ownerIsDead(filename: string): boolean {
  const match = /^owner-(\d+)-[a-f0-9-]+$/.exec(filename);
  if (!match?.[1]) return false;
  const pid = Number(match[1]);
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return hasCode(error, "ESRCH");
  }
}

async function removeOwner(lock: string, owner: string): Promise<void> {
  await unlink(join(lock, owner)).catch(() => {});
  await rmdir(lock).catch(() => {});
}

async function recoverLock(lock: string): Promise<void> {
  try {
    const owners = await readdir(lock);
    if (owners.length === 0) {
      const metadata = await stat(lock);
      if (Date.now() - metadata.mtimeMs < EMPTY_LOCK_GRACE_MS) return;
    }
    for (const owner of owners) {
      if (ownerIsDead(owner)) await unlink(join(lock, owner)).catch(() => {});
    }
    await rmdir(lock).catch(() => {});
  } catch (error) {
    if (!hasCode(error, "ENOENT")) {
      throw new Error(
        "Cannot lock Codex credentials. Check the local credential directory permissions.",
        { cause: error },
      );
    }
  }
}

async function acquireLock(home: string): Promise<() => Promise<void>> {
  await mkdir(home, { recursive: true, mode: 0o700 });
  const lock = join(home, "auth-refresh.lock");
  const owner = `owner-${process.pid}-${randomUUID()}`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      await mkdir(lock, { mode: 0o700 });
    } catch (error) {
      if (!hasCode(error, "EEXIST")) {
        throw new Error(
          "Cannot lock Codex credentials. Check the local credential directory permissions.",
          { cause: error },
        );
      }
      await recoverLock(lock);
      await delay(40);
      continue;
    }
    try {
      const marker = await open(join(lock, owner), "wx", 0o600);
      await marker.close();
      const owners = await readdir(lock);
      // Empty-lock recovery can race marker creation; only a sole owner may enter.
      if (owners.length === 1 && owners[0] === owner) return () => removeOwner(lock, owner);
    } catch (error) {
      if (!hasCode(error, "ENOENT")) {
        await removeOwner(lock, owner);
        throw new Error(
          "Cannot lock Codex credentials. Check the local credential directory permissions.",
          { cause: error },
        );
      }
    }
    await removeOwner(lock, owner);
    await delay(40);
  }
  throw new Error("Codex credentials are busy. Retry shortly.");
}

async function runLogin(home: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("codex", ["-c", 'cli_auth_credentials_store="file"', "login"], {
      env: { ...process.env, CODEX_HOME: home },
      stdio: "inherit",
    });
    child.once("error", () =>
      reject(new Error("Cannot start codex login. Install the official Codex CLI.")),
    );
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error("Codex login did not complete. Run claudex login to retry."));
    });
  });
}

export class CodexAuth {
  #home: string;
  #fallbackHome: string;
  #fetch: Fetch;
  #refresh: Promise<string> | undefined;
  #lastToken: string | undefined;

  constructor(options: AuthOptions = {}) {
    this.#home =
      options.home ??
      join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "claudex", "codex");
    this.#fallbackHome =
      options.fallbackHome ?? process.env.CODEX_HOME ?? join(homedir(), ".codex");
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async getAccessToken(options: { forceRefresh?: boolean } = {}): Promise<string> {
    const expectedToken = options.forceRefresh ? this.#lastToken : undefined;
    const managed = await readManagedAuth(this.#home);
    let token: string;
    if (!managed) {
      const parsed = v.safeParse(sharedAuthSchema, await readAuthJson(this.#fallbackHome));
      if (!parsed.success || !isFresh(parsed.output.tokens.access_token))
        throw new Error(LOGIN_REQUIRED);
      token = parsed.output.tokens.access_token;
    } else if (!options.forceRefresh && isFresh(managed.tokens.access_token, REFRESH_MARGIN_MS)) {
      token = managed.tokens.access_token;
    } else {
      if (!this.#refresh) {
        this.#refresh = this.#refreshManaged(
          options.forceRefresh ? (expectedToken ?? managed.tokens.access_token) : undefined,
        ).finally(() => {
          this.#refresh = undefined;
        });
      }
      token = await this.#refresh;
    }
    this.#lastToken = token;
    return token;
  }

  async #refreshManaged(expectedToken: string | undefined): Promise<string> {
    const release = await acquireLock(this.#home);
    try {
      const auth = await readManagedAuth(this.#home);
      if (!auth) throw new Error(LOGIN_REQUIRED);
      const token = auth.tokens.access_token;
      if (
        isFresh(token, REFRESH_MARGIN_MS) &&
        (expectedToken === undefined || token !== expectedToken)
      )
        return token;
      if (!auth.tokens.refresh_token) throw new Error(LOGIN_REQUIRED);
      let refreshed: v.InferOutput<typeof tokenResponseSchema>;
      try {
        const response = await this.#fetch(TOKEN_ENDPOINT, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            grant_type: "refresh_token",
            refresh_token: auth.tokens.refresh_token,
            client_id: CLIENT_ID,
          }),
          signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
          redirect: "error",
        });
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error("refresh failed");
        }
        const parsed = v.safeParse(tokenResponseSchema, await response.json());
        if (!parsed.success || !isFresh(parsed.output.access_token))
          throw new Error("invalid refresh response");
        refreshed = parsed.output;
      } catch {
        throw new Error(
          "Cannot refresh Codex subscription credentials. Retry or run claudex login.",
        );
      }
      const tokens = { ...auth.tokens, ...refreshed };
      await saveAuth(this.#home, { ...auth, tokens, last_refresh: new Date().toISOString() });
      return tokens.access_token;
    } finally {
      await release();
    }
  }

  async login(): Promise<void> {
    const release = await acquireLock(this.#home);
    try {
      await runLogin(this.#home);
      const auth = await readManagedAuth(this.#home);
      if (!auth || !isFresh(auth.tokens.access_token)) throw new Error(LOGIN_REQUIRED);
      await saveAuth(this.#home, auth);
    } finally {
      await release();
    }
  }

  async status(): Promise<AuthStatus> {
    for (const [source, home] of [
      ["managed", this.#home],
      ["shared", this.#fallbackHome],
    ] as const) {
      let json: unknown;
      try {
        json = await readAuthJson(home);
      } catch {
        return { source, authenticated: false };
      }
      if (json === undefined) continue;
      const parsed = v.safeParse(sharedAuthSchema, json);
      if (!parsed.success) return { source, authenticated: false };
      const expiry = expiresAt(parsed.output.tokens.access_token);
      return {
        source,
        authenticated: expiry !== undefined && expiry > Date.now(),
        ...(expiry === undefined ? {} : { expiresAt: new Date(expiry).toISOString() }),
      };
    }
    return { source: "none", authenticated: false };
  }
}
