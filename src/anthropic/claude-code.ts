import * as v from "valibot";

import { CODEX_PREFIX, codexModelId } from "../models.ts";
import { AnthropicHttpError } from "./errors.ts";
import { AnthropicTool, InvalidAnthropicRequest, normalizeAnthropicRequest } from "./request.ts";

const ObjectValue = v.record(v.string(), v.unknown());
const ClaudeCodeTool = v.strictObject({
  ...AnthropicTool.entries,
  defer_loading: v.optional(v.boolean()),
});
const SearchReference = v.strictObject({
  type: v.literal("tool_reference"),
  tool_name: v.pipe(v.string(), v.minLength(1)),
});
const Message = v.looseObject({ role: v.string(), content: v.unknown() });
const Text = v.strictObject({ type: v.literal("text"), text: v.string() });
const ToolReference = v.strictObject({ type: v.literal("tool_reference"), name: v.string() });
const ToolAddition = v.strictObject({
  type: v.literal("tool_addition"),
  tool: v.variant("type", [
    ToolReference,
    v.strictObject({ type: v.literal("tool_definition"), definition: v.unknown() }),
  ]),
});
const ToolRemoval = v.strictObject({ type: v.literal("tool_removal"), tool: ToolReference });
const SystemMessage = v.strictObject({
  role: v.literal("system"),
  content: v.union([v.string(), v.array(v.variant("type", [Text, ToolAddition, ToolRemoval]))]),
  output_config: v.optional(v.strictObject({ effort: v.optional(v.string()) })),
});
const Thinking = v.strictObject({
  type: v.literal("thinking"),
  thinking: v.string(),
  signature: v.optional(v.string()),
});
const RedactedThinking = v.strictObject({ type: v.literal("redacted_thinking"), data: v.string() });
const Compaction = v.strictObject({ type: v.literal("compaction"), content: v.string() });

function object(value: unknown): Record<string, unknown> {
  const parsed = v.safeParse(ObjectValue, value, { abortEarly: true });
  if (!parsed.success) throw new InvalidAnthropicRequest("Malformed Claude Code request content.");
  return { ...parsed.output };
}

function withoutCache(value: unknown): Record<string, unknown> {
  const result = object(value);
  delete result.cache_control;
  return result;
}

function toolSearchUnsupported(): never {
  throw new AnthropicHttpError(
    400,
    "Hosted tool_search is not supported for Codex. Use Claude Code's client ToolSearch or retry with ENABLE_TOOL_SEARCH=false.",
  );
}

function normalizeAssistantHistoryBlock(block: Record<string, unknown>): unknown[] {
  switch (block.type) {
    case "thinking": {
      const parsed = v.safeParse(Thinking, block, { abortEarly: true });
      if (!parsed.success) throw new InvalidAnthropicRequest("Malformed thinking history block.");
      return [{ type: "text", text: parsed.output.thinking }];
    }
    case "redacted_thinking":
      if (!v.safeParse(RedactedThinking, block, { abortEarly: true }).success) {
        throw new InvalidAnthropicRequest("Malformed redacted thinking history block.");
      }
      return [];
    case "compaction": {
      const parsed = v.safeParse(Compaction, block, { abortEarly: true });
      if (!parsed.success) throw new InvalidAnthropicRequest("Malformed compaction history block.");
      return [{ type: "text", text: `[Compacted conversation summary]\n${parsed.output.content}` }];
    }
    default:
      return [block];
  }
}

function normalizeBlock(value: unknown, role: string, loadTool: (name: string) => void): unknown[] {
  const block = withoutCache(value);
  if (typeof block.type === "string" && block.type.startsWith("tool_search")) {
    toolSearchUnsupported();
  }
  if (block.type === "tool_reference") {
    const reference = v.safeParse(SearchReference, block, { abortEarly: true });
    if (role !== "tool_result" || !reference.success) {
      throw new InvalidAnthropicRequest("Malformed tool search result reference.");
    }
    loadTool(reference.output.tool_name);
    return [{ type: "text", text: `[Discovered tool: ${reference.output.tool_name}]` }];
  }
  if (role === "assistant") return normalizeAssistantHistoryBlock(block);
  if (role === "user" && block.type === "tool_result" && Array.isArray(block.content)) {
    return [
      {
        ...block,
        content: block.content.flatMap((part: unknown) =>
          normalizeBlock(part, "tool_result", loadTool),
        ),
      },
    ];
  }
  return [block];
}

function normalizeContent(value: unknown, role: string, loadTool: (name: string) => void): unknown {
  return Array.isArray(value)
    ? value.flatMap((part: unknown) => normalizeBlock(part, role, loadTool))
    : value;
}

function normalizeTool(value: unknown) {
  const tool = withoutCache(value);
  if (typeof tool.type === "string" && tool.type.startsWith("tool_search")) {
    toolSearchUnsupported();
  }
  if (typeof tool.type === "string" && tool.type !== "custom") {
    const tag = /^[a-z0-9_]{1,80}$/iu.test(tool.type) ? tool.type : "unsupported";
    throw new AnthropicHttpError(400, `Input tag '${tag}' is not supported for Codex tools.`);
  }
  const parsed = v.safeParse(ClaudeCodeTool, tool, { abortEarly: true });
  if (!parsed.success) throw new InvalidAnthropicRequest("Malformed Claude Code tool definition.");
  const { defer_loading, ...definition } = parsed.output;
  return { definition, deferred: defer_loading === true };
}

class ToolRegistry {
  readonly #definitions = new Map<string, v.InferOutput<typeof AnthropicTool>>();
  readonly #availableTools = new Map<string, v.InferOutput<typeof AnthropicTool>>();
  readonly #unresolvedTools = new Set<string>();

  constructor(tools: unknown) {
    if (tools === undefined) return;
    if (!Array.isArray(tools)) throw new InvalidAnthropicRequest("Tools must be an array.");
    for (const value of tools) {
      const { definition: tool, deferred } = normalizeTool(value);
      if (this.#definitions.has(tool.name))
        throw new InvalidAnthropicRequest("Tool names must be unique.");
      this.#definitions.set(tool.name, tool);
      if (!deferred) this.#availableTools.set(tool.name, tool);
    }
  }

  readonly load = (name: string): void => {
    const definition = this.#definitions.get(name);
    if (definition) this.#availableTools.set(name, definition);
    else this.#unresolvedTools.add(name);
  };

  apply(block: v.InferOutput<typeof ToolAddition> | v.InferOutput<typeof ToolRemoval>): void {
    if (block.type === "tool_addition" && block.tool.type === "tool_definition") {
      const { definition: tool, deferred } = normalizeTool(block.tool.definition);
      const discovered = this.#unresolvedTools.delete(tool.name);
      this.#definitions.set(tool.name, tool);
      if (!deferred || discovered || this.#availableTools.has(tool.name))
        this.#availableTools.set(tool.name, tool);
      return;
    }
    const reference = block.tool;
    if (reference.type !== "tool_reference") {
      throw new InvalidAnthropicRequest("Malformed tool history reference.");
    }
    const tool = this.#definitions.get(reference.name);
    if (!tool) throw new InvalidAnthropicRequest("Tool history reference is unresolved.");
    if (block.type === "tool_removal") this.#availableTools.delete(reference.name);
    else this.#availableTools.set(reference.name, tool);
  }

  available() {
    if (this.#unresolvedTools.size > 0) {
      throw new InvalidAnthropicRequest("Tool search result has no matching tool definition.");
    }
    return [...this.#availableTools.values()];
  }
}

function normalizeSystemHistory(message: Record<string, unknown>, tools: ToolRegistry) {
  const system = v.safeParse(SystemMessage, message, { abortEarly: true });
  if (!system.success) throw new InvalidAnthropicRequest("Malformed system history message.");
  const texts: string[] = [];
  if (typeof system.output.content === "string") texts.push(system.output.content);
  else {
    for (const block of system.output.content) {
      if (block.type === "text") texts.push(block.text);
      else tools.apply(block);
    }
  }
  return { text: texts.join("\n\n"), effort: system.output.output_config?.effort };
}

function normalizeHistory(history: unknown[], tools: ToolRegistry) {
  const messages: unknown[] = [];
  const systemBlocks: v.InferOutput<typeof Text>[] = [];
  let effort: string | undefined;
  for (const [index, value] of history.entries()) {
    const parsed = v.safeParse(Message, value, { abortEarly: true });
    if (!parsed.success) throw new InvalidAnthropicRequest("Malformed Claude Code message.");
    const message = withoutCache(parsed.output);
    message.content = normalizeContent(message.content, parsed.output.role, tools.load);
    if (parsed.output.role === "system") {
      const system = normalizeSystemHistory(message, tools);
      if (system.text.length > 0) {
        systemBlocks.push({
          type: "text",
          text: `[System context at history position ${index}]\n${system.text}`,
        });
      }
      effort = system.effort ?? effort;
    } else if (!(
      parsed.output.role === "assistant" &&
      Array.isArray(message.content) &&
      message.content.length === 0
    )) {
      messages.push(message);
    }
  }
  return { messages, systemBlocks, effort };
}

function appendSystemContext(system: unknown, blocks: v.InferOutput<typeof Text>[]) {
  if (system === undefined) return blocks;
  if (typeof system === "string") return [{ type: "text", text: system }, ...blocks];
  if (Array.isArray(system)) return [...system, ...blocks];
  throw new InvalidAnthropicRequest("Malformed Claude Code system instructions.");
}

export function normalizeClaudeCodeRequest(
  value: unknown,
): ReturnType<typeof normalizeAnthropicRequest> {
  const body = object(value);
  const publicModel = body.model;
  if (
    typeof publicModel !== "string" ||
    !publicModel.startsWith(CODEX_PREFIX) ||
    publicModel.length === CODEX_PREFIX.length
  ) {
    throw new InvalidAnthropicRequest("Select a model in the codex/ namespace.");
  }
  const config = v.safeParse(ObjectValue, body.output_config, { abortEarly: true });
  const thinking = v.safeParse(
    v.looseObject({ type: v.picklist(["disabled", "enabled", "adaptive"]) }),
    body.thinking,
    { abortEarly: true },
  );
  delete body.thinking;
  delete body.context_management;
  delete body.cache_control;
  const tools = new ToolRegistry(body.tools);
  if (body.system !== undefined) body.system = normalizeContent(body.system, "system", tools.load);
  if (Array.isArray(body.messages)) {
    const history = normalizeHistory(body.messages, tools);
    body.messages = history.messages;
    if (
      history.effort !== undefined &&
      !Object.hasOwn(body, "reasoning_effort") &&
      !(config.success && Object.hasOwn(config.output, "effort"))
    ) {
      body.reasoning_effort = history.effort;
    }
    if (history.systemBlocks.length > 0) {
      body.system = appendSystemContext(body.system, history.systemBlocks);
    }
  }
  body.tools = tools.available();
  if (
    thinking.success &&
    thinking.output.type === "disabled" &&
    !Object.hasOwn(body, "reasoning_effort") &&
    !(config.success && Object.hasOwn(config.output, "effort"))
  ) {
    body.reasoning_effort = "none";
  }
  body.model = codexModelId(publicModel);
  return { ...normalizeAnthropicRequest(body), model: publicModel };
}
