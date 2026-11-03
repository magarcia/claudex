import * as v from "valibot";

import type { resolveModel } from "../openai/models.ts";
import { normalizeResponsesRequest } from "../openai/responses.ts";

export class InvalidAnthropicRequest extends Error {}

const nonblank = () =>
  v.pipe(
    v.string(),
    v.check((value) => value.trim().length > 0),
  );
const object = () => v.record(v.string(), v.unknown());
const CacheControl = v.nullish(
  v.strictObject({
    type: v.literal("ephemeral"),
    ttl: v.optional(v.picklist(["5m", "1h"])),
  }),
);
const TextBlock = v.strictObject({
  type: v.literal("text"),
  text: v.string(),
  cache_control: CacheControl,
});
const ImageSource = v.variant("type", [
  v.strictObject({
    type: v.literal("base64"),
    media_type: v.picklist(["image/png", "image/jpeg", "image/webp", "image/gif"]),
    data: v.pipe(
      nonblank(),
      v.regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}(?:==)?|[A-Za-z0-9+/]{3}=?)?$/u),
    ),
  }),
  v.strictObject({
    type: v.literal("url"),
    url: v.pipe(v.string(), v.url(), v.regex(/^https:\/\/[^/@]+(?:[/?#]|$)/iu)),
  }),
]);
const ImageBlock = v.strictObject({
  type: v.literal("image"),
  source: ImageSource,
  cache_control: CacheControl,
});
const ToolUseBlock = v.strictObject({
  type: v.literal("tool_use"),
  id: nonblank(),
  name: nonblank(),
  input: object(),
  cache_control: CacheControl,
});
const ToolResultBlock = v.strictObject({
  type: v.literal("tool_result"),
  tool_use_id: nonblank(),
  content: v.optional(v.union([v.string(), v.array(v.variant("type", [TextBlock, ImageBlock]))])),
  is_error: v.optional(v.boolean()),
  cache_control: CacheControl,
});
const ContentBlock = v.variant("type", [TextBlock, ImageBlock, ToolUseBlock, ToolResultBlock]);
const parallel = { disable_parallel_tool_use: v.optional(v.boolean()) };
export const AnthropicTool = v.strictObject({
  type: v.nullish(v.literal("custom")),
  name: nonblank(),
  description: v.optional(v.string()),
  input_schema: object(),
  strict: v.optional(v.boolean()),
  cache_control: CacheControl,
});
const ToolChoice = v.variant("type", [
  v.strictObject({ type: v.literal("auto"), ...parallel }),
  v.strictObject({ type: v.literal("any"), ...parallel }),
  v.strictObject({ type: v.literal("none"), ...parallel }),
  v.strictObject({ type: v.literal("tool"), name: nonblank(), ...parallel }),
]);

// Codex doesn't accept sampling or output-length controls. Validate these Anthropic fields, then drop them.
const Request = v.strictObject({
  model: nonblank(),
  max_tokens: v.pipe(v.number(), v.integer(), v.minValue(1)),
  messages: v.pipe(
    v.array(
      v.strictObject({
        role: v.picklist(["user", "assistant"]),
        content: v.union([v.string(), v.pipe(v.array(ContentBlock), v.minLength(1))]),
      }),
    ),
    v.minLength(1),
  ),
  system: v.optional(v.union([v.string(), v.array(TextBlock)])),
  stream: v.optional(v.boolean()),
  tools: v.optional(v.array(AnthropicTool)),
  tool_choice: v.optional(ToolChoice),
  reasoning_effort: v.optional(nonblank()),
  output_config: v.optional(
    v.strictObject({
      effort: v.optional(nonblank()),
      format: v.nullish(v.strictObject({ type: v.literal("json_schema"), schema: object() })),
    }),
  ),
  temperature: v.optional(v.pipe(v.number(), v.minValue(0), v.maxValue(1))),
  top_p: v.optional(v.pipe(v.number(), v.minValue(0), v.maxValue(1))),
  top_k: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
  stop_sequences: v.optional(v.array(v.string())),
  thinking: v.optional(v.strictObject({ type: v.literal("disabled") })),
  metadata: v.nullish(object()),
  cache_control: CacheControl,
});
type AnthropicRequest = v.InferOutput<typeof Request>;
type Block = v.InferOutput<typeof ContentBlock>;
type Image = v.InferOutput<typeof ImageBlock>;
type InputPart =
  { type: "input_text" | "output_text"; text: string } | { type: "input_image"; image_url: string };
type InputItem = Record<string, unknown>;

function imagePart(block: Image): InputPart {
  const source = block.source;
  return {
    type: "input_image",
    image_url:
      source.type === "url" ? source.url : `data:${source.media_type};base64,${source.data}`,
  };
}

function toolOutput(block: v.InferOutput<typeof ToolResultBlock>): string | InputPart[] {
  const prefix = block.is_error ? "[Tool error] " : "";
  if (typeof block.content === "string" || block.content === undefined)
    return prefix + (block.content ?? "");
  if (!block.content.some((part) => part.type === "image")) {
    return prefix + block.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
  }
  return [
    ...(prefix ? [{ type: "input_text" as const, text: prefix }] : []),
    ...block.content.map((part): InputPart =>
      part.type === "image" ? imagePart(part) : { type: "input_text", text: part.text },
    ),
  ];
}

function toolItem(
  block: Block,
  role: "user" | "assistant",
  calls: Set<string>,
  completed: Set<string>,
): InputItem {
  if (block.type === "tool_use" && role === "assistant") {
    if (calls.has(block.id)) throw new InvalidAnthropicRequest("Duplicate tool_use ID.");
    calls.add(block.id);
    let args: string;
    try {
      args = JSON.stringify(block.input);
    } catch {
      throw new InvalidAnthropicRequest("Tool input must be a JSON object.");
    }
    return { type: "function_call", call_id: block.id, name: block.name, arguments: args };
  }
  if (block.type === "tool_result" && role === "user") {
    if (!calls.has(block.tool_use_id) || completed.has(block.tool_use_id)) {
      throw new InvalidAnthropicRequest(
        "tool_result must match a preceding, unanswered tool_use ID.",
      );
    }
    completed.add(block.tool_use_id);
    return { type: "function_call_output", call_id: block.tool_use_id, output: toolOutput(block) };
  }
  throw new InvalidAnthropicRequest("Content block is unsupported for this message role.");
}

function conversationInput(messages: AnthropicRequest["messages"]): InputItem[] {
  const input: InputItem[] = [];
  const calls = new Set<string>();
  const completed = new Set<string>();
  for (const message of messages) {
    let parts: InputPart[] = [];
    const flush = () => {
      if (parts.length > 0) input.push({ type: "message", role: message.role, content: parts });
      parts = [];
    };
    const blocks: Block[] =
      typeof message.content === "string"
        ? [{ type: "text", text: message.content }]
        : message.content;
    for (const block of blocks) {
      if (block.type === "text") {
        parts.push({
          type: message.role === "user" ? "input_text" : "output_text",
          text: block.text,
        });
      } else if (block.type === "image" && message.role === "user") {
        parts.push(imagePart(block));
      } else {
        flush();
        input.push(toolItem(block, message.role, calls, completed));
      }
    }
    flush();
  }
  return input;
}

function toolChoice(
  choice: NonNullable<AnthropicRequest["tool_choice"]>,
  toolNames: ReadonlySet<string>,
): "auto" | "none" | "required" | { type: "function"; name: string } {
  if (choice.type === "tool") {
    if (!toolNames.has(choice.name))
      throw new InvalidAnthropicRequest("Named tool_choice must reference a declared tool.");
    return { type: "function", name: choice.name };
  }
  if (choice.type === "any") {
    if (toolNames.size === 0) throw new InvalidAnthropicRequest("tool_choice any requires tools.");
    return "required";
  }
  return choice.type;
}

function toolOptions(request: AnthropicRequest): Record<string, unknown> {
  const tools = request.tools ?? [];
  const toolNames = new Set(tools.map((tool) => tool.name));
  if (toolNames.size !== tools.length)
    throw new InvalidAnthropicRequest("Tool names must be unique.");

  const options: Record<string, unknown> = {};
  if (tools.length > 0) {
    options.tools = tools.map((tool) => ({
      type: "function",
      name: tool.name,
      ...(tool.description === undefined ? {} : { description: tool.description }),
      parameters: tool.input_schema,
      strict: tool.strict ?? false,
    }));
  }
  const choice = request.tool_choice;
  if (!choice) return options;
  options.tool_choice = toolChoice(choice, toolNames);
  if (choice.disable_parallel_tool_use !== undefined)
    options.parallel_tool_calls = !choice.disable_parallel_tool_use;
  return options;
}

function parseRequest(body: unknown): AnthropicRequest {
  if (body && typeof body === "object" && "thinking" in body) {
    const thinking = body.thinking;
    if (
      thinking &&
      typeof thinking === "object" &&
      "type" in thinking &&
      thinking.type !== "disabled"
    ) {
      throw new InvalidAnthropicRequest(
        "Claude extended thinking and signed thinking blocks are unsupported; use reasoning_effort instead.",
      );
    }
  }
  const parsed = v.safeParse(Request, body);
  if (!parsed.success) {
    throw new InvalidAnthropicRequest(
      "Invalid Anthropic request: malformed or unsupported fields or content blocks.",
    );
  }
  const request = parsed.output;
  if (request.stop_sequences?.length)
    throw new InvalidAnthropicRequest("Nonempty stop_sequences are unsupported by Codex.");
  return request;
}

export function normalizeAnthropicRequest(
  body: unknown,
  modelResolver?: typeof resolveModel,
): {
  upstream: Record<string, unknown>;
  model: string;
  stream: boolean;
} {
  const request = parseRequest(body);
  const effort = request.reasoning_effort ?? request.output_config?.effort;
  const format = request.output_config?.format;
  const system =
    typeof request.system === "string"
      ? request.system
      : (request.system ?? []).map((block) => block.text).join("\n\n");
  const { upstream, stream } = normalizeResponsesRequest(
    {
      model: request.model,
      stream: request.stream === true,
      instructions: system,
      input: conversationInput(request.messages),
      ...toolOptions(request),
      ...(effort ? { reasoning: { effort } } : {}),
      ...(format
        ? {
            text: {
              format: {
                type: "json_schema",
                name: "anthropic_response",
                schema: format.schema,
                strict: false,
              },
            },
          }
        : {}),
    },
    modelResolver,
  );
  return { upstream, model: request.model, stream };
}
