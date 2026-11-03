import {
  createServer,
  type IncomingMessage,
  type RequestListener,
  type ServerResponse,
} from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import * as v from "valibot";

import { anthropicError, anthropicErrorBody, AnthropicHttpError } from "./anthropic/errors.ts";
import { normalizeClaudeCodeRequest } from "./anthropic/claude-code.ts";
import { InvalidAnthropicRequest } from "./anthropic/request.ts";
import { AnthropicStreamTranslator, toAnthropicMessage } from "./anthropic/response.ts";
import type { CodexClient } from "./codex/client.ts";
import {
  CODEX_PREFIX,
  codexModels,
  modelPage,
  NativeCatalogPage,
  requireCodexModel,
  type Model,
} from "./models.ts";
import { collectResponse } from "./openai/responses.ts";
import { readSSE } from "./openai/sse.ts";

const MAX_BODY_BYTES = 20 * 1024 * 1024;
const HOP_HEADERS = new Set([
  "host",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "te",
  "trailer",
  "proxy-authenticate",
  "proxy-authorization",
  "content-length",
]);
const encoder = new TextEncoder();
type Codex = Pick<CodexClient, "models" | "responses">;
type RequestContext = {
  request: IncomingMessage;
  signal: AbortSignal;
  abort: () => void;
};
type RoutedRequest = RequestContext & { target: URL; headers: Headers };

function requestTarget({
  request,
  port,
  origin,
}: {
  request: IncomingMessage;
  port: number;
  origin: string;
}): URL {
  const host = request.headers.host?.toLowerCase();
  if (!host || ![`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(host))
    throw new AnthropicHttpError(403, "Only loopback requests are accepted.");
  if (request.headers.origin !== undefined)
    throw new AnthropicHttpError(403, "Browser-origin requests are not accepted.");
  const path = request.url ?? "/";
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\"))
    throw new AnthropicHttpError(400, "Use a relative API path.");
  const target = new URL(path, origin);
  if (target.origin !== origin) throw new AnthropicHttpError(400, "Invalid API target.");
  return target;
}

function codexRequestBody(body: Buffer) {
  let value: unknown;
  try {
    value = JSON.parse(body.toString("utf8"));
  } catch {
    return;
  }
  const routed = v.safeParse(v.object({ model: v.string() }), value);
  if (routed.success && routed.output.model.startsWith(CODEX_PREFIX))
    return { value, model: routed.output.model };
  return;
}

async function forwardNative(
  { request, target, headers, signal }: RoutedRequest,
  body?: Buffer<ArrayBuffer>,
): Promise<Response> {
  const nativeBody =
    body ??
    (request.method !== "GET" && request.method !== "HEAD" ? Readable.toWeb(request) : undefined);
  return fetch(target, {
    method: request.method,
    headers,
    ...(nativeBody ? { body: nativeBody, duplex: "half" } : {}),
    signal,
    redirect: "manual",
  });
}

function requestHeaders(request: IncomingMessage): Headers {
  const headers = new Headers();
  const connectionFields = new Set(
    request.headers.connection?.split(",").map((value) => value.trim().toLowerCase()),
  );
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined || HOP_HEADERS.has(name) || connectionFields.has(name)) continue;
    headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  return headers;
}

async function readBody(
  request: IncomingMessage,
  signal: AbortSignal,
): Promise<Buffer<ArrayBuffer>> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const value of request) {
    signal.throwIfAborted();
    if (!Buffer.isBuffer(value)) throw new AnthropicHttpError(400, "Invalid request body.");
    bytes += value.byteLength;
    if (bytes > MAX_BODY_BYTES)
      throw new AnthropicHttpError(413, "Requests must not exceed 20 MiB.");
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

async function send(
  response: Response,
  output: ServerResponse,
  signal: AbortSignal,
): Promise<void> {
  const headers = new Headers(response.headers);
  const connectionFields = new Set(
    headers
      .get("connection")
      ?.split(",")
      .map((value) => value.trim().toLowerCase()),
  );
  for (const [name, value] of headers) {
    if (!HOP_HEADERS.has(name) && !connectionFields.has(name) && name !== "content-encoding")
      output.setHeader(name, value);
  }
  const cookies = headers.getSetCookie();
  if (cookies.length && !connectionFields.has("set-cookie"))
    output.setHeader("set-cookie", cookies);
  output.writeHead(response.status);
  output.flushHeaders();
  if (response.body) await pipeline(Readable.fromWeb(response.body), output, { signal });
  else output.end();
}

async function nativeCatalog(origin: string, headers: Headers, signal: AbortSignal) {
  const models: Model[] = [];
  const seen = new Set<string>();
  let after: string | undefined;
  for (let page = 0; page < 20; page++) {
    const url = new URL("/v1/models", origin);
    url.searchParams.set("limit", "1000");
    if (after) url.searchParams.set("after_id", after);
    const response = await fetch(url, { headers, signal, redirect: "manual" });
    if (!response.ok) return { error: response };
    let value: unknown;
    let bytes = 0;
    const bounded = response.body?.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          bytes += chunk.byteLength;
          if (bytes > 4 * 1024 * 1024) throw new Error("Oversized model catalog.");
          controller.enqueue(chunk);
        },
      }),
    );
    if (!bounded) throw new AnthropicHttpError(502, "Anthropic returned an empty model catalog.");
    try {
      value = await new Response(bounded).json();
    } catch {
      throw new AnthropicHttpError(502, "Anthropic returned an invalid model catalog.");
    }
    const parsed = v.safeParse(NativeCatalogPage, value, { abortEarly: true });
    if (!parsed.success)
      throw new AnthropicHttpError(502, "Anthropic returned an invalid model catalog.");
    for (const model of parsed.output.data) {
      if (!seen.has(model.id)) models.push(model);
      seen.add(model.id);
    }
    if (!parsed.output.has_more) return { models };
    if (!parsed.output.last_id || parsed.output.last_id === after) break;
    after = parsed.output.last_id;
  }
  throw new AnthropicHttpError(502, "Anthropic model pagination did not complete.");
}

async function codexError(upstream: Response, requestId: string): Promise<Response> {
  const status = upstream.status === 401 || upstream.status === 403 ? 502 : upstream.status;
  const headers = new Headers();
  const retry = upstream.headers.get("retry-after");
  if (retry) headers.set("retry-after", retry);
  let message = `Codex returned HTTP ${upstream.status}.`;
  if (upstream.body) {
    const reader = upstream.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > 16 * 1024) break;
        chunks.push(next.value);
      }
      if (size <= 16 * 1024) {
        const text = Buffer.concat(chunks).toString("utf8");
        const parsed: unknown = JSON.parse(text);
        const error = v.safeParse(v.object({ error: v.object({ message: v.string() }) }), parsed);
        if (error.success) message = error.output.error.message;
      }
    } catch {
      /* Non-JSON upstream errors keep the HTTP summary. */
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
  return anthropicError(status >= 400 ? status : 502, message, requestId, headers);
}

function codexStream(
  upstream: Response,
  model: string,
  requestId: string,
  abort: () => void,
): Response {
  if (!upstream.body) return anthropicError(502, "Codex returned no response stream.", requestId);
  const events = readSSE(upstream.body);
  const translator = new AnthropicStreamTranslator(model);
  let heartbeat: ReturnType<typeof setInterval>;
  let finished = false;
  const finish = () => {
    finished = true;
    clearInterval(heartbeat);
  };
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      heartbeat = setInterval(() => {
        if (!finished && (controller.desiredSize ?? 0) > 0)
          controller.enqueue(encoder.encode(": keepalive\n\n"));
      }, 15_000);
      heartbeat.unref();
    },
    async pull(controller) {
      try {
        while (!finished) {
          const next = await events.next();
          if (next.done) {
            translator.finish();
            finish();
            controller.close();
            return;
          }
          const translated = translator.handle(next.value);
          for (const event of translated)
            controller.enqueue(
              encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`),
            );
          if (translated.some((event) => event.type === "message_stop")) {
            finish();
            controller.close();
            return;
          }
          if (translated.length) return;
        }
      } catch {
        if (!finished) {
          controller.enqueue(
            encoder.encode(
              `event: error\ndata: ${JSON.stringify(anthropicErrorBody(502, "The Codex stream failed or was interrupted.", requestId))}\n\n`,
            ),
          );
          finish();
          controller.close();
        }
      }
    },
    async cancel() {
      finish();
      abort();
      await events.return(null).catch(() => {});
    },
  });
  return new Response(body, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      "request-id": requestId,
    },
  });
}

type RoutingOptions = { codex: Codex; origin: string; port: number };

async function modelRoute(
  { request, target, headers, signal }: RoutedRequest,
  { codex, origin }: RoutingOptions,
) {
  if (request.method !== "GET") return;
  if (target.pathname === "/v1/models") {
    const native = await nativeCatalog(origin, headers, signal);
    if (native.error) return native.error;
    const models = [...native.models, ...codexModels(await codex.models(signal))];
    return Response.json(modelPage(models, target.searchParams), {
      headers: { "cache-control": "no-store" },
    });
  }
  if (!target.pathname.startsWith("/v1/models/")) return;
  let id: string;
  try {
    id = decodeURIComponent(target.pathname.slice("/v1/models/".length));
  } catch {
    throw new AnthropicHttpError(400, "Invalid model ID.");
  }
  if (!id.startsWith(CODEX_PREFIX)) return;
  const model = requireCodexModel(id, await codex.models(signal));
  return Response.json(model, { headers: { "cache-control": "no-store" } });
}

async function codexMessage(
  { target, signal, abort }: RoutedRequest,
  { value, model, codex }: { value: unknown; model: string; codex: Codex },
): Promise<Response> {
  const requestId = `req_${crypto.randomUUID()}`;
  if (target.pathname.endsWith("/count_tokens"))
    return anthropicError(
      501,
      "Exact token counting is unavailable for Codex; use the client estimate.",
      requestId,
    );
  const translated = normalizeClaudeCodeRequest(value);
  requireCodexModel(model, await codex.models(signal));
  const upstream = await codex.responses(translated.upstream, signal);
  if (!upstream.ok) return codexError(upstream, requestId);
  if (translated.stream) return codexStream(upstream, translated.model, requestId, abort);
  if (!upstream.body) throw new AnthropicHttpError(502, "Codex returned no response stream.");
  const result = await collectResponse(readSSE(upstream.body));
  return Response.json(toAnthropicMessage(result, translated.model), {
    headers: { "cache-control": "no-store", "request-id": requestId },
  });
}

async function routeRequest(context: RequestContext, options: RoutingOptions): Promise<Response> {
  const { request, signal } = context;
  const target = requestTarget({ request, port: options.port, origin: options.origin });
  if (request.method === "GET" && target.pathname === "/health") return Response.json({ ok: true });
  const routed = { ...context, target, headers: requestHeaders(request) };
  const model = await modelRoute(routed, options);
  if (model) return model;
  const shouldInspect =
    request.method === "POST" &&
    ["/v1/messages", "/v1/messages/count_tokens"].includes(target.pathname);
  if (!shouldInspect) return forwardNative(routed);
  const body = await readBody(request, signal);
  const codexBody = codexRequestBody(body);
  return codexBody
    ? codexMessage(routed, { ...codexBody, codex: options.codex })
    : forwardNative(routed, body);
}

function requestListener({
  handle,
  active,
}: {
  handle: (context: RequestContext) => Promise<Response>;
  active: Set<AbortController>;
}): RequestListener {
  return (request, output) => {
    const controller = new AbortController();
    active.add(controller);
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(600_000)]);
    request.once("aborted", () => controller.abort());
    output.once("close", () => {
      if (!output.writableEnded) controller.abort();
    });
    void handle({ request, signal, abort: () => controller.abort() })
      .then((response) => send(response, output, signal))
      .catch(async (error) => {
        if (output.destroyed) return;
        if (output.headersSent) {
          output.destroy();
          return;
        }
        const status =
          error instanceof AnthropicHttpError
            ? error.status
            : error instanceof InvalidAnthropicRequest
              ? 400
              : signal.aborted
                ? 504
                : 502;
        const message =
          error instanceof AnthropicHttpError || error instanceof InvalidAnthropicRequest
            ? error.message
            : "The proxy request failed. Check the provider login with `claudex doctor`.";
        await send(
          anthropicError(status, message, `req_${crypto.randomUUID()}`),
          output,
          new AbortController().signal,
        ).catch(() => output.destroy());
      })
      .finally(() => {
        active.delete(controller);
        controller.abort();
      });
  };
}

export async function startProxy({
  codex,
  port = 8788,
  anthropicOrigin = "https://api.anthropic.com",
}: {
  codex: Codex;
  port?: number;
  anthropicOrigin?: string;
}): Promise<{ url: string; close(): Promise<void> }> {
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error("Port must be an integer from 0 to 65535.");
  const origin = new URL(anthropicOrigin).origin;
  const active = new Set<AbortController>();
  let boundPort = port;
  const server = createServer(
    requestListener({
      handle: (context) => routeRequest(context, { codex, origin, port: boundPort }),
      active,
    }),
  );
  server.on("connect", (_request, socket) =>
    socket.end("HTTP/1.1 405 Method Not Allowed\r\nConnection: close\r\n\r\n"),
  );
  server.on("upgrade", (_request, socket) =>
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n"),
  );
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("The loopback server did not start.");
  boundPort = address.port;
  let closing: Promise<void> | undefined;
  return {
    url: `http://127.0.0.1:${boundPort}`,
    close() {
      closing ??= new Promise<void>((resolve, reject) => {
        for (const controller of active) controller.abort();
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
      return closing;
    },
  };
}
