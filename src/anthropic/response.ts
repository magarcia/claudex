import { parseUpstreamStreamError, UpstreamStreamError } from "../openai/errors.ts";
import type { SSEEvent } from "../openai/sse.ts";

type Body = Record<string, unknown>;
type StopReason = "end_turn" | "tool_use" | "max_tokens" | "refusal";

export interface AnthropicUsage {
  input_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  output_tokens: number;
}

type ContentBlock =
  { type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: Body };

export interface AnthropicMessage {
  id: string;
  type: "message";
  role: "assistant";
  model: string;
  content: ContentBlock[];
  stop_reason: StopReason | null;
  stop_sequence: null;
  usage: AnthropicUsage;
}

export type AnthropicEvent =
  | { type: "message_start"; data: { type: "message_start"; message: AnthropicMessage } }
  | {
      type: "content_block_start";
      data: { type: "content_block_start"; index: number; content_block: ContentBlock };
    }
  | {
      type: "content_block_delta";
      data: {
        type: "content_block_delta";
        index: number;
        delta:
          { type: "text_delta"; text: string } | { type: "input_json_delta"; partial_json: string };
      };
    }
  | { type: "content_block_stop"; data: { type: "content_block_stop"; index: number } }
  | {
      type: "message_delta";
      data: {
        type: "message_delta";
        delta: { stop_reason: StopReason; stop_sequence: null };
        usage: AnthropicUsage;
      };
    }
  | { type: "message_stop"; data: { type: "message_stop" } };

function object(value: unknown): Body | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Body) : undefined;
}

function string(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function messageId(id?: string): string {
  return id?.startsWith("msg_") ? id : `msg_${id ?? crypto.randomUUID().replaceAll("-", "")}`;
}

function usage(value: unknown): AnthropicUsage {
  const source = object(value);
  const input = count(source?.input_tokens);
  const cached = Math.min(input, count(object(source?.input_tokens_details)?.cached_tokens));
  return {
    input_tokens: input - cached,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: cached,
    output_tokens: count(source?.output_tokens),
  };
}

function invalidOutput(detail: string): never {
  throw new UpstreamStreamError(detail, null);
}

function toolInput(value: string): Body {
  try {
    const parsed = object(JSON.parse(value));
    if (parsed) return parsed;
  } catch {
    // Tool arguments can contain private values, so parsing failures expose no payload.
  }
  return invalidOutput("Codex returned invalid tool arguments: expected a JSON object.");
}

function toolIdentity(item: Body): { id: string; name: string } {
  const id = string(item.call_id) || string(item.id);
  const name = string(item.name);
  if (!id || !name) return invalidOutput("Codex returned a tool call without an ID or name.");
  return { id, name };
}

function stopReason(response: Body, tools: boolean, refusal: boolean): StopReason {
  const reason = object(response.incomplete_details)?.reason;
  if (reason === "max_output_tokens") return "max_tokens";
  if (reason === "content_filter" || refusal) return "refusal";
  if (response.status === "incomplete" || reason) {
    return invalidOutput("Codex returned an unsupported incomplete response.");
  }
  if (response.status && response.status !== "completed") {
    return invalidOutput("Codex response did not complete.");
  }
  return tools ? "tool_use" : "end_turn";
}

function message(
  model: string,
  id: string,
  content: ContentBlock[],
  response: Body,
  refusal = false,
): AnthropicMessage {
  return {
    id,
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: stopReason(
      response,
      content.some((block) => block.type === "tool_use"),
      refusal,
    ),
    stop_sequence: null,
    usage: usage(response.usage),
  };
}

/** Maps visible Responses output without inventing Claude thinking or signatures. */
export function toAnthropicMessage(response: Body, model: string, id?: string): AnthropicMessage {
  if (response.status === "failed" || response.error) {
    throw parseUpstreamStreamError({ type: "response.failed", data: { response } });
  }
  const content: ContentBlock[] = [];
  let refusal = false;
  for (const value of Array.isArray(response.output) ? response.output : []) {
    const item = object(value);
    if (item?.type === "function_call") {
      content.push({
        type: "tool_use",
        ...toolIdentity(item),
        input: toolInput(string(item.arguments)),
      });
    } else if (item?.type === "message") {
      for (const rawPart of Array.isArray(item.content) ? item.content : []) {
        const part = object(rawPart);
        if (part?.type === "output_text") content.push({ type: "text", text: string(part.text) });
        else if (part?.type === "refusal") {
          refusal = true;
          content.push({ type: "text", text: string(part.refusal) });
        }
      }
    }
  }
  return message(model, messageId(id), content, response, refusal);
}

interface TextState {
  index: number;
  length: number;
  closed: boolean;
}

interface ToolState {
  index?: number;
  id: string;
  name: string;
  arguments: string;
  sent: number;
  closed: boolean;
}

interface ItemState {
  texts: Map<number, TextState>;
  tool?: ToolState;
}

function itemIdentity(data: Body, raw?: Body) {
  const id = string(raw?.id) || string(data.item_id);
  const index = typeof data.output_index === "number" ? data.output_index : id ? undefined : 0;
  return { id, index };
}

/** Keeps text lengths, rather than whole transcripts, to reconcile final-output fallbacks. */
export class AnthropicStreamTranslator {
  readonly #model: string;
  readonly #id: string;
  readonly #byId = new Map<string, ItemState>();
  readonly #byIndex = new Map<number, ItemState>();
  readonly #items = new Set<ItemState>();
  #nextIndex = 0;
  #started = false;
  #completed = false;
  #refusal = false;
  #tools = false;

  constructor(model: string, id?: string) {
    this.#model = model;
    this.#id = messageId(id);
  }

  #item(data: Body, raw?: Body): ItemState {
    const { id, index } = itemIdentity(data, raw);
    const byId = this.#byId.get(id);
    const byIndex = index === undefined ? undefined : this.#byIndex.get(index);
    if (byId && byIndex && byId !== byIndex) {
      return invalidOutput("Codex returned inconsistent output item identities.");
    }
    const item = byId ?? byIndex ?? { texts: new Map<number, TextState>() };
    this.#items.add(item);
    if (id) this.#byId.set(id, item);
    if (index !== undefined) this.#byIndex.set(index, item);
    return item;
  }

  #text(item: ItemState, contentIndex: number, events: AnthropicEvent[]): TextState {
    let text = item.texts.get(contentIndex);
    if (!text) {
      text = { index: this.#nextIndex++, length: 0, closed: false };
      item.texts.set(contentIndex, text);
      events.push({
        type: "content_block_start",
        data: {
          type: "content_block_start",
          index: text.index,
          content_block: { type: "text", text: "" },
        },
      });
    }
    return text;
  }

  #textDelta(text: TextState, delta: string, events: AnthropicEvent[]): void {
    if (!delta) return;
    if (text.closed) return invalidOutput("Codex updated a completed text block.");
    text.length += delta.length;
    events.push({
      type: "content_block_delta",
      data: {
        type: "content_block_delta",
        index: text.index,
        delta: { type: "text_delta", text: delta },
      },
    });
  }

  #fullText(text: TextState, value: string, events: AnthropicEvent[]): void {
    if (value.length < text.length)
      return invalidOutput("Codex returned inconsistent text output.");
    this.#textDelta(text, value.slice(text.length), events);
  }

  #stopText(text: TextState, events: AnthropicEvent[]): void {
    if (text.closed) return;
    text.closed = true;
    events.push({
      type: "content_block_stop",
      data: { type: "content_block_stop", index: text.index },
    });
  }

  #tool(item: ItemState): ToolState {
    this.#tools = true;
    return (item.tool ??= { id: "", name: "", arguments: "", sent: 0, closed: false });
  }

  #toolMetadata(tool: ToolState, raw: Body, events: AnthropicEvent[]): void {
    const id = string(raw.call_id) || string(raw.id);
    const name = string(raw.name);
    if (tool.index !== undefined && ((id && id !== tool.id) || (name && name !== tool.name))) {
      return invalidOutput("Codex returned inconsistent tool call metadata.");
    }
    if (id) tool.id = id;
    if (name) tool.name = name;
    if (tool.index === undefined && tool.id && tool.name) {
      tool.index = this.#nextIndex++;
      events.push({
        type: "content_block_start",
        data: {
          type: "content_block_start",
          index: tool.index,
          content_block: { type: "tool_use", id: tool.id, name: tool.name, input: {} },
        },
      });
    }
    this.#sendArguments(tool, events);
  }

  #sendArguments(tool: ToolState, events: AnthropicEvent[]): void {
    if (tool.index === undefined || tool.sent === tool.arguments.length) return;
    if (tool.closed) return invalidOutput("Codex updated a completed tool call.");
    events.push({
      type: "content_block_delta",
      data: {
        type: "content_block_delta",
        index: tool.index,
        delta: { type: "input_json_delta", partial_json: tool.arguments.slice(tool.sent) },
      },
    });
    tool.sent = tool.arguments.length;
  }

  #fullArguments(tool: ToolState, value: string, events: AnthropicEvent[]): void {
    if (!value.startsWith(tool.arguments))
      return invalidOutput("Codex returned inconsistent tool arguments.");
    tool.arguments = value;
    this.#sendArguments(tool, events);
  }

  #stopTool(tool: ToolState, events: AnthropicEvent[]): void {
    if (tool.closed) return;
    toolInput(tool.arguments);
    if (tool.index === undefined)
      return invalidOutput("Codex returned a tool call without an ID or name.");
    tool.closed = true;
    events.push({
      type: "content_block_stop",
      data: { type: "content_block_stop", index: tool.index },
    });
  }

  #part(item: ItemState, index: number, part: Body, done: boolean, events: AnthropicEvent[]): void {
    if (part.type !== "output_text" && part.type !== "refusal") return;
    if (part.type === "refusal") this.#refusal = true;
    const text = this.#text(item, index, events);
    this.#fullText(text, string(part.type === "refusal" ? part.refusal : part.text), events);
    if (done) this.#stopText(text, events);
  }

  #outputItem(data: Body, raw: Body, done: boolean, events: AnthropicEvent[]): void {
    if (raw.type !== "message" && raw.type !== "function_call") return;
    const item = this.#item(data, raw);
    if (raw.type === "function_call") {
      const tool = this.#tool(item);
      this.#toolMetadata(tool, raw, events);
      if (typeof raw.arguments === "string") this.#fullArguments(tool, raw.arguments, events);
      if (done) this.#stopTool(tool, events);
    } else {
      for (const [index, value] of (Array.isArray(raw.content) ? raw.content : []).entries()) {
        const part = object(value);
        if (part) this.#part(item, index, part, done, events);
      }
      if (done) for (const text of item.texts.values()) this.#stopText(text, events);
    }
  }

  #complete(response: Body, incomplete: boolean, events: AnthropicEvent[]): void {
    if (response.status === "failed" || response.error) {
      throw parseUpstreamStreamError({ type: "response.failed", data: { response } });
    }
    for (const [output_index, value] of (Array.isArray(response.output)
      ? response.output
      : []
    ).entries()) {
      const raw = object(value);
      if (raw) this.#outputItem({ output_index }, raw, true, events);
    }
    for (const item of this.#items) {
      for (const text of item.texts.values()) this.#stopText(text, events);
      if (item.tool) this.#stopTool(item.tool, events);
    }
    const reason = stopReason(
      { ...response, ...(incomplete ? { status: "incomplete" } : {}) },
      this.#tools,
      this.#refusal,
    );
    events.push(
      {
        type: "message_delta",
        data: {
          type: "message_delta",
          delta: { stop_reason: reason, stop_sequence: null },
          usage: usage(response.usage),
        },
      },
      { type: "message_stop", data: { type: "message_stop" } },
    );
    this.#completed = true;
  }

  #textEvent(type: string, data: Body, events: AnthropicEvent[]): void {
    const index = typeof data.content_index === "number" ? data.content_index : 0;
    if (type.startsWith("response.content_part.")) {
      const part = object(data.part);
      if (part) this.#part(this.#item(data), index, part, type.endsWith(".done"), events);
      return;
    }
    const refusal = type.startsWith("response.refusal.");
    if (refusal) this.#refusal = true;
    const text = this.#text(this.#item(data), index, events);
    if (type.endsWith(".delta")) this.#textDelta(text, string(data.delta), events);
    else {
      this.#fullText(text, string(refusal ? data.refusal : data.text), events);
      this.#stopText(text, events);
    }
  }

  #start(response: unknown, events: AnthropicEvent[]): void {
    if (this.#started) return;
    this.#started = true;
    const initial = message(this.#model, this.#id, [], {});
    initial.stop_reason = null;
    initial.usage = { ...usage(object(response)?.usage), output_tokens: 0 };
    events.push({ type: "message_start", data: { type: "message_start", message: initial } });
  }

  #argumentsDelta(data: Body, events: AnthropicEvent[]): void {
    const tool = this.#tool(this.#item(data));
    if (tool.closed) return invalidOutput("Codex updated a completed tool call.");
    tool.arguments += string(data.delta);
    this.#sendArguments(tool, events);
  }

  #argumentsDone(data: Body, events: AnthropicEvent[]): void {
    const tool = this.#tool(this.#item(data));
    this.#fullArguments(tool, string(data.arguments), events);
    if (tool.index !== undefined) this.#stopTool(tool, events);
  }

  handle(upstream: SSEEvent): AnthropicEvent[] {
    const { type, data } = upstream;
    if (type === "error" || type === "response.failed") throw parseUpstreamStreamError(upstream);
    if (this.#completed) return [];
    const events: AnthropicEvent[] = [];
    this.#start(data.response, events);
    switch (type) {
      case "response.output_item.added":
      case "response.output_item.done": {
        const raw = object(data.item);
        if (raw) this.#outputItem(data, raw, type.endsWith(".done"), events);
        break;
      }
      case "response.content_part.added":
      case "response.content_part.done":
      case "response.output_text.delta":
      case "response.refusal.delta":
      case "response.output_text.done":
      case "response.refusal.done":
        this.#textEvent(type, data, events);
        break;
      case "response.function_call_arguments.delta":
        this.#argumentsDelta(data, events);
        break;
      case "response.function_call_arguments.done":
        this.#argumentsDone(data, events);
        break;
      case "response.completed":
      case "response.incomplete":
        this.#complete(object(data.response) ?? {}, type === "response.incomplete", events);
        break;
      default:
        break;
    }
    return events;
  }

  finish(): void {
    if (!this.#completed) {
      throw new UpstreamStreamError("Codex stream ended before the response completed.", null);
    }
  }
}
