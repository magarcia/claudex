type AnthropicErrorType =
  | "invalid_request_error"
  | "authentication_error"
  | "permission_error"
  | "not_found_error"
  | "request_too_large"
  | "rate_limit_error"
  | "api_error"
  | "overloaded_error"
  | "timeout_error";

function anthropicErrorType(status: number): AnthropicErrorType {
  switch (status) {
    case 401:
      return "authentication_error";
    case 403:
      return "permission_error";
    case 404:
      return "not_found_error";
    case 413:
      return "request_too_large";
    case 429:
      return "rate_limit_error";
    case 504:
      return "timeout_error";
    case 529:
      return "overloaded_error";
    default:
      return status >= 500 ? "api_error" : "invalid_request_error";
  }
}

export function anthropicErrorBody(status: number, message: string, requestId: string) {
  return {
    type: "error" as const,
    error: {
      type: anthropicErrorType(status),
      message: safeErrorDetails(new Error(message))
        .message.replaceAll(
          /data:image\/[\w.+-]+;base64,[A-Za-z0-9+/_=-]+/giu,
          "[redacted image data]",
        )
        .replaceAll(/[A-Za-z0-9+/]{200,}={0,2}/gu, "[redacted image data]"),
    },
    request_id: requestId,
  };
}

export function anthropicError(
  status: number,
  message: string,
  requestId: string,
  extraHeaders?: ConstructorParameters<typeof Headers>[0],
): Response {
  const headers = new Headers(extraHeaders);
  headers.set("request-id", requestId);
  headers.set("cache-control", "no-store");
  headers.set("x-content-type-options", "nosniff");
  return Response.json(anthropicErrorBody(status, message, requestId), { status, headers });
}

export class AnthropicHttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
import { safeErrorDetails } from "../openai/errors.ts";
