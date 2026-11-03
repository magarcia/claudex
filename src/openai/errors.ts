import type { SSEEvent } from "./sse.ts";

/** An upstream SSE `error` or `response.failed` event. */
export class UpstreamStreamError extends Error {
  readonly code: string | null;
  readonly errorType: string;
  readonly param: string | null;
  readonly eventType?: string;

  constructor(
    message: string,
    code: string | null,
    errorType = "api_error",
    param: string | null = null,
    eventType?: string,
  ) {
    super(message);
    this.code = code;
    this.errorType = errorType;
    this.param = param;
    this.eventType = eventType;
  }
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function nonemptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

/** Error events may put their details in `error`, `response.error`, or the event itself. */
export function parseUpstreamStreamError({ type, data }: SSEEvent): UpstreamStreamError {
  const nested = object(object(data.response)?.error) ?? object(data.error);
  const field = (name: string) => nonemptyString(nested?.[name]) ?? nonemptyString(data[name]);
  const errorType =
    nonemptyString(nested?.type) ?? (data.type === type ? undefined : nonemptyString(data.type));
  return new UpstreamStreamError(
    field("message") ??
      (type === "response.failed" ? "Codex response failed." : "Codex stream error."),
    field("code") ?? null,
    errorType ?? "api_error",
    field("param") ?? null,
    type,
  );
}

export interface SafeErrorDetails {
  message: string;
  code: string | null;
  type: string;
  param: string | null;
  eventType?: string;
}

function safeLogString(value: string, limit: number): string {
  return value
    .replaceAll(/\bBearer\s+[^\s"'<>]+/giu, "[redacted]")
    .replaceAll(/\bsk-[^\s"'<>]+/giu, "[redacted]")
    .replaceAll(/\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/gu, "[redacted]")
    .replaceAll(/\p{Cc}/gu, " ")
    .slice(0, limit);
}

/** Logs an allowlist of diagnostic fields without copying request bodies, headers or stacks. */
export function safeErrorDetails(error: unknown): SafeErrorDetails {
  const upstream = error instanceof UpstreamStreamError ? error : undefined;
  return {
    message: safeLogString(
      error instanceof Error ? error.message : "The upstream request failed.",
      500,
    ),
    code: upstream?.code ? safeLogString(upstream.code, 100) : null,
    type: safeLogString(upstream?.errorType ?? "api_error", 100),
    param: upstream?.param ? safeLogString(upstream.param, 200) : null,
    ...(upstream?.eventType ? { eventType: safeLogString(upstream.eventType, 100) } : {}),
  };
}
