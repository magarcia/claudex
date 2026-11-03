import { afterEach, describe, expect, it, vi } from "bun:test";

import metadata from "../package.json" with { type: "json" };
import type { CodexAuth } from "../src/codex/auth.ts";
import { CodexClient } from "../src/codex/client.ts";
import type { Fetch } from "../src/fetch.ts";

function token(account = "account-A"): string {
  return `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: account } })).toString("base64url")}.signature`;
}

function auth(account = "account-A") {
  return { getAccessToken: vi.fn<CodexAuth["getAccessToken"]>(async () => token(account)) };
}

afterEach(() => vi.restoreAllMocks());

describe("CodexClient", () => {
  it("sends only its own Codex authentication to the fixed production origin", async () => {
    const credentials = auth();
    const signal = new AbortController().signal;
    const result = new Response("synthetic stream");
    const body = { model: "gpt-6-luna", input: "synthetic prompt", stream: true };
    const fetch = vi.fn<Fetch>(async (url, init) => {
      expect(url).toBe("https://chatgpt.com/backend-api/codex/responses");
      expect(init?.signal).toBe(signal);
      expect(init?.redirect).toBe("error");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual(body);
      expect(Object.fromEntries(new Headers(init?.headers))).toEqual({
        authorization: `Bearer ${token()}`,
        "chatgpt-account-id": "account-A",
        "openai-beta": "responses=experimental",
        originator: "claudex",
        "user-agent": `claudex/${metadata.version}`,
        accept: "text/event-stream",
        "content-type": "application/json",
      });
      return result;
    });
    expect(await new CodexClient(credentials, { fetch }).responses(body, signal)).toBe(result);
    expect(credentials.getAccessToken).toHaveBeenCalledTimes(1);
    expect(credentials.getAccessToken).toHaveBeenCalledWith({ forceRefresh: false });
  });

  it("cancels a 401 and retries once with the refreshed token and its account", async () => {
    const credentials = auth();
    credentials.getAccessToken
      .mockResolvedValueOnce(token("old"))
      .mockResolvedValueOnce(token("new"));
    let cancelled = false;
    const denied = new Response(
      new ReadableStream({
        cancel() {
          cancelled = true;
        },
      }),
      { status: 401 },
    );
    const accepted = new Response("accepted");
    const fetch = vi
      .fn<Fetch>()
      .mockResolvedValueOnce(denied)
      .mockImplementationOnce(async (_url, init) => {
        expect(cancelled).toBe(true);
        expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${token("new")}`);
        expect(new Headers(init?.headers).get("chatgpt-account-id")).toBe("new");
        return accepted;
      });
    const client = new CodexClient(credentials, { fetch });
    expect(await client.responses({ model: "raw-model" }, new AbortController().signal)).toBe(
      accepted,
    );
    expect(credentials.getAccessToken.mock.calls).toEqual([
      [{ forceRefresh: false }],
      [{ forceRefresh: true }],
    ]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("returns the second 401 without an unbounded retry loop", async () => {
    const credentials = auth();
    const final = new Response("upstream error", { status: 401 });
    const fetch = vi
      .fn<Fetch>()
      .mockResolvedValueOnce(new Response("denied", { status: 401 }))
      .mockResolvedValueOnce(final);
    expect(
      await new CodexClient(credentials, { fetch }).responses({}, new AbortController().signal),
    ).toBe(final);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("associates model caches with the account that actually fetched the catalog", async () => {
    const credentials = auth();
    credentials.getAccessToken
      .mockResolvedValueOnce(token("A"))
      .mockResolvedValueOnce(token("B"))
      .mockResolvedValueOnce(token("A"))
      .mockResolvedValueOnce(token("A"));
    const fetch = vi.fn<Fetch>(async (_url, init) => {
      const account = new Headers(init?.headers).get("chatgpt-account-id");
      return Response.json({ models: [{ slug: `${account}-only` }] });
    });
    const client = new CodexClient(credentials, { fetch });
    expect(await client.models()).toEqual([{ id: "B-only", displayName: "B-only" }]);
    expect(await client.models()).toEqual([{ id: "A-only", displayName: "A-only" }]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("uses the refreshed account for a model catalog fetched after a 401", async () => {
    const credentials = auth();
    credentials.getAccessToken
      .mockResolvedValueOnce(token("A"))
      .mockResolvedValueOnce(token("A"))
      .mockResolvedValueOnce(token("B"))
      .mockResolvedValue(token("B"));
    const fetch = vi
      .fn<Fetch>()
      .mockResolvedValueOnce(new Response("denied", { status: 401 }))
      .mockResolvedValueOnce(Response.json({ models: [{ slug: "B-only" }] }));
    const client = new CodexClient(credentials, { fetch });
    expect(await client.models()).toEqual([{ id: "B-only", displayName: "B-only" }]);
    expect(await client.models()).toEqual([{ id: "B-only", displayName: "B-only" }]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("caches for sixty seconds, preserves upstream metadata and raw model IDs, and deduplicates", async () => {
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const credentials = auth();
    const fetch = vi.fn<Fetch>(async (url, init) => {
      expect(url).toBe("https://chatgpt.com/backend-api/codex/models?client_version=0.166.0");
      const headers = new Headers(init?.headers);
      expect(headers.get("accept")).toBe("application/json");
      expect(headers.get("originator")).toBe("claudex");
      expect(headers.get("user-agent")).toBe(`claudex/${metadata.version}`);
      return Response.json({
        models: [
          {
            slug: "gpt-6-luna",
            display_name: "Luna",
            description: "Fast model",
            context_window: 128000,
          },
          { slug: "gpt-6-luna", display_name: "duplicate" },
          { slug: "another", display_name: "" },
        ],
      });
    });
    const client = new CodexClient(credentials, { fetch });
    const expected = [
      { id: "gpt-6-luna", displayName: "Luna", description: "Fast model", contextWindow: 128000 },
      { id: "another", displayName: "another" },
    ];
    expect(await client.models()).toEqual(expected);
    now += 59_999;
    expect(await client.models()).toEqual(expected);
    expect(fetch).toHaveBeenCalledTimes(1);
    now += 1;
    expect(await client.models()).toEqual(expected);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("invalidates cached models when a response request receives a 401", async () => {
    let catalogs = 0;
    let responses = 0;
    const fetch = vi.fn<Fetch>(async (url) => {
      if (String(url).includes("/models?"))
        return Response.json({ models: [{ slug: `catalog-${++catalogs}` }] });
      return new Response("result", { status: ++responses === 1 ? 401 : 200 });
    });
    const client = new CodexClient(auth(), { fetch });
    expect((await client.models())[0]?.id).toBe("catalog-1");
    await client.responses({}, new AbortController().signal);
    expect((await client.models())[0]?.id).toBe("catalog-2");
  });

  it.each([
    "private-not-json",
    JSON.stringify({ models: [] }),
    JSON.stringify({ models: [{ slug: "" }] }),
    JSON.stringify({ models: [{ slug: "valid", context_window: -1 }] }),
    JSON.stringify({ models: [{ slug: "valid", context_window: 1.5 }] }),
    JSON.stringify({ data: [{ id: "wrong-protocol" }] }),
  ])("rejects an invalid catalog without echoing its raw content", async (body) => {
    const fetch = vi.fn<Fetch>(async () => new Response(body));
    await expect(new CodexClient(auth(), { fetch }).models()).rejects.toThrow(
      /^Codex returned an invalid/,
    );
  });

  it("cancels a catalog that exceeds the bounded JSON size", async () => {
    let cancelled = false;
    const fetch = vi.fn<Fetch>(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(4 * 1024 * 1024 + 1));
            },
            cancel() {
              cancelled = true;
            },
          }),
        ),
    );
    await expect(new CodexClient(auth(), { fetch }).models()).rejects.toThrow(
      "invalid or oversized model catalog",
    );
    expect(cancelled).toBe(true);
  });

  it("rejects malformed account claims without sending the token upstream", async () => {
    const credentials = auth();
    credentials.getAccessToken.mockResolvedValue("private-malformed-token");
    const fetch = vi.fn<Fetch>();
    await expect(new CodexClient(credentials, { fetch }).models()).rejects.toThrow(
      /^The Codex login has no ChatGPT account\./,
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects HTTP catalog failures without exposing upstream error bodies", async () => {
    const fetch = vi.fn<Fetch>(
      async () => new Response("private-upstream-error-body", { status: 503 }),
    );
    await expect(new CodexClient(auth(), { fetch }).models()).rejects.toThrow(
      /^Codex model discovery returned HTTP 503\. Run claudex doctor\.$/,
    );
  });
});
