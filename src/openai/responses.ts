import { parseUpstreamStreamError, UpstreamStreamError } from "./errors.ts";
import { ensureJsonObjectInput } from "./json-input.ts";
import { resolveModel } from "./models.ts";
import type { SSEEvent } from "./sse.ts";

const DEFAULT_INSTRUCTIONS = "You are a helpful assistant.";

/** Rejected by the Codex backend. */
const UNSUPPORTED = [
  "metadata",
  "stream_options",
  "user",
  "prompt_cache_retention",
  "max_output_tokens",
] as const;

type Body = Record<string, unknown>;

export class InvalidRequest extends Error {}

function isSystemMessage(item: unknown): item is { role: string; content: unknown } {
  if (!item || typeof item !== "object") return false;
  const { role, type } = item as { role?: unknown; type?: unknown };
  return (type === undefined || type === "message") && (role === "system" || role === "developer");
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part: unknown) =>
      part && typeof part === "object" && "text" in part && typeof part.text === "string"
        ? part.text
        : "",
    )
    .filter(Boolean)
    .join("\n");
}

/**
 * Codex accepts the Responses API with fixed constraints: nothing stored,
 * always streamed, instructions present, and system turns in `instructions`
 * rather than in `input`.
 */
export function normalizeResponsesRequest(
  body: Body,
  modelResolver: typeof resolveModel = resolveModel,
): { upstream: Body; stream: boolean } {
  if (typeof body.model !== "string") throw new InvalidRequest("`model` is required.");
  if (body.previous_response_id) {
    throw new InvalidRequest(
      "`previous_response_id` is not supported: nothing is stored upstream, so send the full `input`.",
    );
  }

  const upstream: Body = { ...body };
  for (const key of UNSUPPORTED) delete upstream[key];

  const rawInput = body.input;
  const input: unknown[] =
    typeof rawInput === "string"
      ? [{ type: "message", role: "user", content: [{ type: "input_text", text: rawInput }] }]
      : Array.isArray(rawInput)
        ? rawInput
        : [];

  const instructions = [
    typeof body.instructions === "string" ? body.instructions : "",
    ...input.filter((item) => isSystemMessage(item)).map((item) => contentText(item.content)),
  ]
    .filter(Boolean)
    .join("\n\n");

  const reasoning = (body.reasoning ?? {}) as { effort?: unknown };
  const { model, effort } = modelResolver(body.model, reasoning.effort);
  const format =
    body.text && typeof body.text === "object" && "format" in body.text
      ? body.text.format
      : undefined;

  upstream.model = model;
  upstream.input = ensureJsonObjectInput(
    input.filter((item) => !isSystemMessage(item)),
    format,
  );
  upstream.instructions = instructions || DEFAULT_INSTRUCTIONS;
  upstream.store = false;
  upstream.stream = true;
  if (effort) upstream.reasoning = { summary: "auto", ...reasoning, effort };

  return { upstream, stream: body.stream === true };
}

/** Rebuilds absent or empty final output from output_item.done events. */
export async function collectResponse(events: AsyncIterable<SSEEvent>): Promise<Body> {
  const items: { index: number; item: unknown }[] = [];
  for await (const { type, data } of events) {
    if (type === "response.output_item.done") {
      items.push({ index: Number(data.output_index ?? items.length), item: data.item });
    } else if (type === "response.completed" || type === "response.incomplete") {
      const response = { ...(data.response as Body) };
      if (!Array.isArray(response.output) || response.output.length === 0) {
        response.output = items.toSorted((a, b) => a.index - b.index).map(({ item }) => item);
      }
      return response;
    } else if (type === "response.failed" || type === "error") {
      throw parseUpstreamStreamError({ type, data });
    }
  }
  throw new UpstreamStreamError("Codex stream ended before the response completed.", null);
}
