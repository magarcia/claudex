import * as v from "valibot";

import metadata from "../../package.json" with { type: "json" };
import type { Fetch } from "../fetch.ts";
import type { CodexAuth } from "./auth.ts";

export interface CodexModel {
  id: string;
  displayName: string;
  description?: string;
  contextWindow?: number;
}

const MAX_CATALOG_BYTES = 4 * 1024 * 1024;
const CODEX_CATALOG_VERSION = "0.166.0";
const Catalog = v.object({
  models: v.array(
    v.object({
      slug: v.pipe(v.string(), v.minLength(1)),
      display_name: v.nullish(v.string()),
      description: v.nullish(v.string()),
      context_window: v.nullish(v.pipe(v.number(), v.integer(), v.minValue(1))),
    }),
  ),
});
const Claims = v.object({
  "https://api.openai.com/auth": v.object({
    chatgpt_account_id: v.pipe(v.string(), v.minLength(1)),
  }),
});

function accountId(token: string): string {
  try {
    const payload = token.split(".")[1];
    if (!payload) throw new Error();
    const claims: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return v.parse(Claims, claims, { abortEarly: true })["https://api.openai.com/auth"]
      .chatgpt_account_id;
  } catch {
    throw new Error("The Codex login has no ChatGPT account. Run `claudex login`.");
  }
}

async function readCatalog(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Codex returned an invalid model catalog.");
  try {
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_CATALOG_BYTES) {
        await reader.cancel();
        throw new Error();
      }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks, bytes).toString("utf8"));
  } catch {
    throw new Error("Codex returned an invalid or oversized model catalog.");
  } finally {
    reader.releaseLock();
  }
}

export class CodexClient {
  #auth: Pick<CodexAuth, "getAccessToken">;
  #fetch: Fetch;
  #baseUrl: string;
  #cache: { account: string; expires: number; models: CodexModel[] } | undefined;

  constructor(
    auth: Pick<CodexAuth, "getAccessToken">,
    options: { baseUrl?: string; fetch?: Fetch } = {},
  ) {
    this.#auth = auth;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#baseUrl = options.baseUrl ?? "https://chatgpt.com/backend-api/codex";
  }

  async #request(
    path: string,
    init: RequestInit,
    signal: AbortSignal,
  ): Promise<{ response: Response; account: string }> {
    for (const forceRefresh of [false, true]) {
      const token = await this.#auth.getAccessToken({ forceRefresh });
      const account = accountId(token);
      const headers = new Headers({
        authorization: `Bearer ${token}`,
        "chatgpt-account-id": account,
        "openai-beta": "responses=experimental",
        originator: metadata.name,
        "user-agent": `${metadata.name}/${metadata.version}`,
        accept: path === "responses" ? "text/event-stream" : "application/json",
        "content-type": "application/json",
      });
      const response = await this.#fetch(`${this.#baseUrl}/${path}`, {
        ...init,
        headers,
        signal,
        redirect: "error",
      });
      if (response.status !== 401 || forceRefresh) return { response, account };
      await response.body?.cancel();
      this.#cache = undefined;
    }
    throw new Error("Codex authentication failed. Run `claudex login`.");
  }

  async models(signal: AbortSignal = AbortSignal.timeout(30_000)): Promise<CodexModel[]> {
    const account = accountId(await this.#auth.getAccessToken());
    if (this.#cache?.account === account && this.#cache.expires > Date.now()) {
      return this.#cache.models;
    }
    const { response, account: requestedAccount } = await this.#request(
      `models?client_version=${CODEX_CATALOG_VERSION}`,
      { method: "GET" },
      signal,
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(
        `Codex model discovery returned HTTP ${response.status}. Run claudex doctor.`,
      );
    }
    const json = await readCatalog(response);
    const parsed = v.safeParse(Catalog, json, { abortEarly: true });
    if (!parsed.success || parsed.output.models.length === 0) {
      throw new Error("Codex returned an invalid or empty model catalog.");
    }
    const seen = new Set<string>();
    const models: CodexModel[] = [];
    for (const model of parsed.output.models) {
      if (seen.has(model.slug)) continue;
      seen.add(model.slug);
      models.push({
        id: model.slug,
        displayName: model.display_name || model.slug,
        ...(model.description != null ? { description: model.description } : {}),
        ...(model.context_window != null ? { contextWindow: model.context_window } : {}),
      });
    }
    this.#cache = { account: requestedAccount, expires: Date.now() + 60_000, models };
    return models;
  }

  async responses(body: Record<string, unknown>, signal: AbortSignal): Promise<Response> {
    return (
      await this.#request("responses", { method: "POST", body: JSON.stringify(body) }, signal)
    ).response;
  }
}
