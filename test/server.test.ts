import { once } from "node:events";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";

import * as v from "valibot";
import { afterEach, describe, expect, it } from "bun:test";

import { CodexClient } from "../src/codex/client.ts";
import { startProxy } from "../src/server.ts";

type Captured = { path: string; method: string; headers: IncomingMessage["headers"]; body: Buffer };
type Handler = (request: IncomingMessage, response: ServerResponse) => void | Promise<void>;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function body(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) if (Buffer.isBuffer(chunk)) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function capture(request: IncomingMessage): Promise<Captured> {
  return {
    path: request.url ?? "/",
    method: request.method ?? "GET",
    headers: request.headers,
    body: await body(request),
  };
}

function json(response: ServerResponse, value: unknown, status = 200) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

async function listen(handler: Handler) {
  const server = createServer((request, response) => {
    Promise.resolve(handler(request, response)).catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Stub did not bind TCP.");
  cleanups.push(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  );
  return `http://127.0.0.1:${address.port}`;
}

const nativeModels = [
  {
    id: "claude-native-a",
    type: "model",
    display_name: "Native A",
    created_at: "2026-01-01T00:00:00Z",
    capabilities: { thinking: true },
  },
  {
    id: "claude-native-b",
    type: "model",
    display_name: "Native B",
    created_at: "2026-02-01T00:00:00Z",
    native_extra: "preserved",
    description: null,
  },
];
const token = `synthetic.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "synthetic-codex-account" } })).toString("base64url")}.signature`;
const nativeHeaders = {
  authorization: "Bearer synthetic-claude-subscription",
  "anthropic-beta": "oauth-2025-04-20,synthetic-beta",
  "anthropic-version": "2023-06-01",
};
const message = {
  model: "codex/gpt-6-luna",
  max_tokens: 32000,
  messages: [{ role: "user", content: "Synthetic question." }],
  thinking: { type: "adaptive", display: "omitted" },
  context_management: { edits: [{ type: "clear_thinking_20251015", keep: "all" }] },
  output_config: { effort: "high" },
  stream: false,
};

function event(type: string, data: Record<string, unknown> = {}): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
}

function completion(text = "Synthetic answer.") {
  const item = {
    id: "message-1",
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text }],
  };
  return event("response.completed", {
    response: {
      id: "response-1",
      status: "completed",
      output: [item],
      usage: { input_tokens: 20, output_tokens: 10 },
    },
  });
}

async function fixture() {
  const nativeRequests: Captured[] = [];
  const codexRequests: Captured[] = [];
  const state: {
    nativeStream?: Handler;
    nativeReply?: (request: Captured, response: ServerResponse) => void | Promise<void>;
    codexReply?: (request: Captured, response: ServerResponse) => void | Promise<void>;
    catalogReply?: (request: Captured, response: ServerResponse) => void | Promise<void>;
  } = {};
  const native = await listen(async (request, response) => {
    if (state.nativeStream) return state.nativeStream(request, response);
    const captured = await capture(request);
    nativeRequests.push(captured);
    if (state.nativeReply) return state.nativeReply(captured, response);
    const url = new URL(captured.path, "http://stub");
    if (url.pathname === "/v1/models") {
      const after = url.searchParams.get("after_id");
      return json(response, {
        data: after ? nativeModels.slice(1) : nativeModels.slice(0, 1),
        has_more: !after,
        last_id: after ? "claude-native-b" : "claude-native-a",
      });
    }
    if (url.pathname.startsWith("/v1/models/")) return json(response, nativeModels[0]);
    return json(response, { native: true });
  });
  const codexOrigin = await listen(async (request, response) => {
    const captured = await capture(request);
    codexRequests.push(captured);
    if (captured.path.startsWith("/models")) {
      if (state.catalogReply) return state.catalogReply(captured, response);
      return json(response, {
        models: [
          { slug: "gpt-6-luna", display_name: "Luna" },
          { slug: "gpt-6-sol", display_name: "Sol" },
          { slug: "gpt-6.1-sol", display_name: "Sol 6.1" },
          { slug: "gpt-5.6-terra", display_name: "Old Terra" },
          { slug: "codex-auto-review", display_name: "Auto Review" },
        ],
      });
    }
    if (state.codexReply) return state.codexReply(captured, response);
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(completion());
  });
  const codex = new CodexClient({ getAccessToken: async () => token }, { baseUrl: codexOrigin });
  const proxy = await startProxy({ codex, port: 0, anthropicOrigin: native });
  cleanups.push(proxy.close);
  const post = (payload: unknown, path = "/v1/messages?beta=true") =>
    fetch(`${proxy.url}${path}`, {
      method: "POST",
      headers: {
        ...nativeHeaders,
        "content-type": "application/json",
        "x-api-key": "synthetic-claude-api-key",
      },
      body: JSON.stringify(payload),
    });
  return { proxy, state, nativeRequests, codexRequests, post };
}

async function rawRequest(
  url: string,
  options: { method?: string; path?: string; headers?: Record<string, string> } = {},
) {
  const target = new URL(url);
  return new Promise<{ status: number; text: string }>((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: target.hostname,
        port: target.port,
        method: options.method ?? "GET",
        path: options.path ?? "/health",
        headers: options.headers,
      },
      async (response) => {
        try {
          resolve({ status: response.statusCode ?? 0, text: (await body(response)).toString() });
        } catch (error) {
          reject(error);
        }
      },
    );
    request.on("error", reject);
    request.on("connect", (response, socket) => {
      socket.destroy();
      resolve({ status: response.statusCode ?? 0, text: "" });
    });
    request.on("upgrade", (response, socket) => {
      socket.destroy();
      resolve({ status: response.statusCode ?? 0, text: "" });
    });
    request.end();
  });
}

describe("local proxy HTTP behavior", () => {
  it("serves and routes 1M variants without sending the suffix to Codex", async () => {
    const setup = await fixture();
    setup.state.catalogReply = (_request, response) =>
      json(response, {
        models: [{ slug: "gpt-6-astra", display_name: "Astra", context_window: 1_000_000 }],
      });
    const id = "codex/gpt-6-astra[1m]";
    const lookup = await fetch(`${setup.proxy.url}/v1/models/${encodeURIComponent(id)}`);
    expect(lookup.status).toBe(200);
    expect(await lookup.json()).toMatchObject({ id, display_name: "Astra (1M context)" });
    const catalog = await fetch(`${setup.proxy.url}/v1/models`, { headers: nativeHeaders });
    expect(await catalog.json()).toMatchObject({
      data: expect.arrayContaining([
        {
          id,
          type: "model",
          display_name: "Astra (1M context)",
          description: "For your most demanding tasks",
          created_at: "1970-01-01T00:00:00.000Z",
        },
      ]),
    });
    for (const model of [id, "codex/gpt-6-astra"]) {
      const reply = await setup.post({ ...message, model });
      expect(reply.status).toBe(200);
      expect(await reply.json()).toMatchObject({ model });
    }
    const requests = setup.codexRequests.filter((request) => request.path === "/responses");
    expect(requests).toHaveLength(2);
    for (const request of requests)
      expect(JSON.parse(request.body.toString())).toMatchObject({ model: "gpt-6-astra" });
  });

  it.each(["codex/missing", "codex/gpt-6-luna[1m]", "codex/gpt-6-sol"])(
    "uses the same helpful model error for lookup and inference: %s",
    async (id) => {
      const setup = await fixture();
      const lookup = await fetch(`${setup.proxy.url}/v1/models/${encodeURIComponent(id)}`);
      const inference = await setup.post({ ...message, model: id });
      const ErrorBody = v.object({ error: v.object({ message: v.string() }) });
      const expected = `Unknown Codex model ${JSON.stringify(id)}. Available models: codex/gpt-6-luna, codex/gpt-6.1-sol.`;
      for (const response of [lookup, inference]) {
        expect(response.status).toBe(404);
        expect(v.parse(ErrorBody, await response.json()).error.message).toBe(expected);
      }
      expect(setup.codexRequests.some((request) => request.path === "/responses")).toBe(false);
      expect(setup.nativeRequests).toHaveLength(0);
    },
  );

  it("passes native request bytes, credentials, version/beta/query, errors, and usage headers unchanged", async () => {
    const setup = await fixture();
    const error =
      '{ "type": "error", "error": { "type": "rate_limit_error", "message": "native wording" } }\n';
    setup.state.nativeReply = (_request, response) => {
      response.writeHead(429, {
        "content-type": "application/json",
        "retry-after": "3",
        "x-should-retry": "false",
        "anthropic-ratelimit-unified-5h-utilization": "0.75",
      });
      response.end(error);
    };
    const payload = '{\n "model": "claude-native-a", "messages":[], "future_native_field":true }\n';
    const response = await fetch(`${setup.proxy.url}/v1/messages?beta=true&native=1`, {
      method: "POST",
      headers: { ...nativeHeaders, "content-type": "application/json" },
      body: payload,
    });
    expect(response.status).toBe(429);
    expect(await response.text()).toBe(error);
    expect(response.headers.get("retry-after")).toBe("3");
    expect(response.headers.get("x-should-retry")).toBe("false");
    expect(response.headers.get("anthropic-ratelimit-unified-5h-utilization")).toBe("0.75");
    expect(setup.nativeRequests[0]).toMatchObject({
      path: "/v1/messages?beta=true&native=1",
      headers: nativeHeaders,
    });
    expect(setup.nativeRequests[0]?.body.toString()).toBe(payload);
    expect(setup.codexRequests).toHaveLength(0);
  });

  it("leaves malformed JSON and missing or invalid models to native validation", async () => {
    const setup = await fixture();
    const payloads = ['{ "model": "codex/gpt-6-luna",', '{ "messages": [] }\n', '{ "model": 123 }'];
    for (const path of ["/v1/messages?beta=true", "/v1/messages/count_tokens?beta=true"]) {
      for (const payload of payloads) {
        const response = await fetch(`${setup.proxy.url}${path}`, {
          method: "POST",
          headers: { ...nativeHeaders, "content-type": "application/json" },
          body: payload,
        });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ native: true });
        expect(setup.nativeRequests.at(-1)).toMatchObject({ path, headers: nativeHeaders });
        expect(setup.nativeRequests.at(-1)?.body.toString()).toBe(payload);
      }
    }
    expect(setup.nativeRequests).toHaveLength(payloads.length * 2);
    expect(setup.codexRequests).toHaveLength(0);
  });

  it("relays native SSE incrementally, including pings and the final events", async () => {
    const setup = await fixture();
    const finish = deferred();
    const first = 'event: ping\ndata: {"type":"ping"}\n\n';
    const last =
      'event: message_delta\ndata: {"type":"message_delta"}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n';
    setup.state.nativeStream = async (_request, response) => {
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "x-native-stream": "preserved",
      });
      response.write(first);
      await finish.promise;
      response.end(last);
    };
    const response = await fetch(`${setup.proxy.url}/native-events`, { headers: nativeHeaders });
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Missing native stream.");
    try {
      const chunk = await reader.read();
      expect(new TextDecoder().decode(chunk.value)).toBe(first);
      expect(response.headers.get("x-native-stream")).toBe("preserved");
      finish.resolve();
      let tail = "";
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        tail += new TextDecoder().decode(chunk.value);
      }
      expect(tail).toBe(last);
    } finally {
      finish.resolve();
      reader.releaseLock();
    }
  });

  it("combines the native catalog with latest coding models and paginates/retrieves public IDs", async () => {
    const setup = await fixture();
    const first = await fetch(`${setup.proxy.url}/v1/models?limit=2`, { headers: nativeHeaders });
    expect(await first.json()).toEqual({
      data: nativeModels,
      has_more: true,
      first_id: "claude-native-a",
      last_id: "claude-native-b",
    });
    const next = await fetch(`${setup.proxy.url}/v1/models?limit=2&after_id=claude-native-b`, {
      headers: nativeHeaders,
    });
    expect(await next.json()).toMatchObject({
      data: [
        {
          id: "codex/gpt-6-luna",
          display_name: "Luna",
          description: "Fast and affordable for quick tasks",
        },
        {
          id: "codex/gpt-6.1-sol",
          display_name: "Sol 6.1",
          description: "For coding and everyday work",
        },
      ],
      has_more: false,
    });
    const codex = await fetch(
      `${setup.proxy.url}/v1/models/${encodeURIComponent("codex/gpt-6-luna")}`,
      { headers: nativeHeaders },
    );
    expect(await codex.json()).toMatchObject({ id: "codex/gpt-6-luna", type: "model" });
    for (const hidden of ["gpt-6-sol", "gpt-5.6-terra", "codex-auto-review"]) {
      const response = await fetch(
        `${setup.proxy.url}/v1/models/${encodeURIComponent(`codex/${hidden}`)}`,
        {
          headers: nativeHeaders,
        },
      );
      expect(response.status).toBe(404);
    }
    const native = await fetch(`${setup.proxy.url}/v1/models/claude-native-a`, {
      headers: nativeHeaders,
    });
    expect(await native.json()).toEqual(nativeModels[0]);
    expect(
      setup.nativeRequests.some((request) => request.path.includes("after_id=claude-native-a")),
    ).toBe(true);
    expect(
      setup.nativeRequests.every(
        (request) => request.headers.authorization === nativeHeaders.authorization,
      ),
    ).toBe(true);
  });

  it("returns native catalog failures unchanged without presenting a partial union", async () => {
    const setup = await fixture();
    setup.state.nativeReply = (_request, response) => {
      response.writeHead(401, { "content-type": "application/json", "x-native-error": "original" });
      response.end('{"native_error":"sign in"}');
    };
    const response = await fetch(`${setup.proxy.url}/v1/models`, { headers: nativeHeaders });
    expect(response.status).toBe(401);
    expect(await response.text()).toBe('{"native_error":"sign in"}');
    expect(response.headers.get("x-native-error")).toBe("original");
    expect(setup.codexRequests).toHaveLength(0);
  });

  it("reports Codex catalog failure instead of silently returning native models", async () => {
    const setup = await fixture();
    setup.state.catalogReply = (_request, response) =>
      json(response, { error: "synthetic failure" }, 503);
    const response = await fetch(`${setup.proxy.url}/v1/models`, { headers: nativeHeaders });
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ type: "error", error: { type: "api_error" } });
  });

  it("translates captured Claude Code controls and a streamed tool call, then accepts its tool result", async () => {
    const setup = await fixture();
    const call = {
      id: "item-call",
      type: "function_call",
      call_id: "call-1",
      name: "Bash",
      arguments: '{"command":"pwd"}',
    };
    const text = {
      id: "item-text",
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "Checking." }],
    };
    setup.state.codexReply = (_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        event("response.created", { response: { id: "response-tool" } }) +
          event("response.output_item.added", { output_index: 0, item: { ...text, content: [] } }) +
          event("response.output_text.delta", {
            output_index: 0,
            item_id: text.id,
            content_index: 0,
            delta: "Checking.",
          }) +
          event("response.output_item.done", { output_index: 0, item: text }) +
          event("response.output_item.added", {
            output_index: 1,
            item: { ...call, arguments: "" },
          }) +
          event("response.function_call_arguments.delta", {
            item_id: call.id,
            delta: call.arguments,
          }) +
          event("response.output_item.done", { output_index: 1, item: call }) +
          event("response.completed", {
            response: {
              status: "completed",
              output: [text, call],
              usage: { input_tokens: 20, output_tokens: 10 },
            },
          }),
      );
    };
    const tools = [
      {
        name: "Bash",
        description: "Run a command.",
        input_schema: {
          type: "object",
          properties: { command: { type: "string" } },
          required: ["command"],
        },
      },
    ];
    const toolUpdate = {
      role: "system",
      content: [
        { type: "text", text: "The project command tool is now available." },
        { type: "tool_addition", tool: { type: "tool_definition", definition: tools[0] } },
      ],
    };
    const response = await setup.post({
      ...message,
      stream: true,
      messages: [...message.messages, toolUpdate],
    });
    const stream = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(stream).toContain('"model":"codex/gpt-6-luna"');
    expect(stream).toContain('"type":"tool_use","id":"call-1","name":"Bash"');
    expect(stream).toContain('"stop_reason":"tool_use"');
    expect(stream).toContain("event: message_stop");
    expect(stream).not.toContain("[DONE]");
    const sent: unknown = JSON.parse(setup.codexRequests[1]?.body.toString() ?? "null");
    expect(sent).toMatchObject({
      model: "gpt-6-luna",
      store: false,
      stream: true,
      reasoning: { effort: "high" },
      tools: [{ type: "function", name: "Bash" }],
    });
    expect(sent).not.toHaveProperty("thinking");
    expect(sent).not.toHaveProperty("context_management");
    expect(setup.codexRequests[1]?.headers.authorization).toBe(`Bearer ${token}`);
    expect(setup.codexRequests[1]?.headers["x-api-key"]).toBeUndefined();
    expect(setup.codexRequests[1]?.headers["anthropic-beta"]).toBeUndefined();
    expect(setup.nativeRequests).toHaveLength(0);
    setup.state.codexReply = (_request, output) => {
      output.writeHead(200, { "content-type": "text/event-stream" });
      output.end(completion("Done."));
    };
    const result = await setup.post({
      ...message,
      messages: [
        message.messages[0],
        toolUpdate,
        {
          role: "assistant",
          content: [
            {
              type: "thinking",
              thinking: "Previous visible thought.",
              signature: "native-only-signature",
            },
            { type: "tool_use", id: "call-1", name: "Bash", input: { command: "pwd" } },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "call-1", content: "Synthetic working directory." },
          ],
        },
      ],
    });
    expect(await result.json()).toMatchObject({
      model: "codex/gpt-6-luna",
      content: [{ type: "text", text: "Done." }],
      stop_reason: "end_turn",
    });
    const followup: unknown = JSON.parse(setup.codexRequests[2]?.body.toString() ?? "null");
    expect(followup).toMatchObject({
      input: expect.arrayContaining([
        { type: "function_call", call_id: "call-1", name: "Bash", arguments: '{"command":"pwd"}' },
        { type: "function_call_output", call_id: "call-1", output: "Synthetic working directory." },
      ]),
    });
  });

  it("returns unsupported Codex token counting and bounded upstream errors with retry hints", async () => {
    const setup = await fixture();
    const count = await setup.post(message, "/v1/messages/count_tokens?beta=true");
    expect(count.status).toBe(501);
    expect(setup.codexRequests).toHaveLength(0);
    setup.state.codexReply = (_request, response) => {
      response.writeHead(429, { "content-type": "text/html", "retry-after": "4" });
      response.end("<html>private-upstream-page</html>");
    };
    const response = await setup.post(message);
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("4");
    expect(await response.text()).not.toContain("private-upstream-page");
  });

  it("rejects browser origins, external Host, absolute targets, CONNECT, and upgrade requests", async () => {
    const setup = await fixture();
    const results = await Promise.all([
      rawRequest(setup.proxy.url, { headers: { origin: "https://external.example" } }),
      rawRequest(setup.proxy.url, { headers: { host: "external.example" } }),
      rawRequest(setup.proxy.url, { path: "https://external.example/v1/messages" }),
      rawRequest(setup.proxy.url, { method: "CONNECT", path: "external.example:443" }),
      rawRequest(setup.proxy.url, { headers: { connection: "Upgrade", upgrade: "websocket" } }),
    ]);
    expect(results.map((response) => response.status)).toEqual([403, 403, 400, 405, 400]);
    expect(setup.nativeRequests).toHaveLength(0);
    expect(setup.codexRequests).toHaveLength(0);
  });

  it.each(["/v1/models", "/v1/models/codex%2Fgpt-6-luna"])(
    "checks loopback access before serving model routes: %s",
    async (path) => {
      const setup = await fixture();
      const results = await Promise.all([
        rawRequest(setup.proxy.url, { path, headers: { origin: "https://external.example" } }),
        rawRequest(setup.proxy.url, { path, headers: { host: "external.example" } }),
      ]);
      expect(results.map((response) => response.status)).toEqual([403, 403]);
      expect(setup.nativeRequests).toHaveLength(0);
      expect(setup.codexRequests).toHaveLength(0);
    },
  );

  it("aborts the Codex upstream when the streaming client disconnects", async () => {
    const setup = await fixture();
    const closed = deferred();
    setup.state.codexReply = (_request, response) => {
      response.once("close", closed.resolve);
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(event("response.created", { response: { id: "slow-response" } }));
    };
    const controller = new AbortController();
    const response = await fetch(`${setup.proxy.url}/v1/messages`, {
      method: "POST",
      headers: { ...nativeHeaders, "content-type": "application/json" },
      body: JSON.stringify({ ...message, stream: true }),
      signal: controller.signal,
    });
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Missing translated stream.");
    await reader.read();
    controller.abort();
    await closed.promise;
    reader.releaseLock();
  });

  it("streams unknown native uploads immediately and accepts bodies larger than the routing parser limit", async () => {
    const setup = await fixture();
    const received = deferred();
    let bytes = 0;
    setup.state.nativeStream = async (request, response) => {
      for await (const chunk of request) {
        if (Buffer.isBuffer(chunk)) bytes += chunk.length;
        received.resolve();
      }
      json(response, { bytes });
    };
    const target = new URL(setup.proxy.url);
    const request = httpRequest({
      hostname: target.hostname,
      port: target.port,
      method: "POST",
      path: "/v1/files?beta=true",
      headers: { ...nativeHeaders, "content-type": "application/octet-stream" },
    });
    const result = new Promise<IncomingMessage>((resolve, reject) => {
      request.once("response", resolve);
      request.once("error", reject);
    });
    request.write(Buffer.from("x"));
    await received.promise;
    const chunk = Buffer.alloc(64 * 1024, 120);
    for (let index = 0; index < 320; index++) {
      if (!request.write(chunk)) await once(request, "drain");
    }
    request.end();
    const response = await result;
    expect(response.statusCode).toBe(200);
    const parsed = v.parse(
      v.object({ bytes: v.number() }),
      JSON.parse((await body(response)).toString()),
    );
    expect(parsed.bytes).toBe(20 * 1024 * 1024 + 1);
  });
});
