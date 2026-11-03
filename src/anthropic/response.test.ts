import { describe, expect, it } from "bun:test";

import { UpstreamStreamError } from "../openai/errors.ts";
import type { SSEEvent } from "../openai/sse.ts";
import { type AnthropicEvent, AnthropicStreamTranslator, toAnthropicMessage } from "./response.ts";

const MODEL = "gpt-5.6-sol";
const ID = "msg_test";

function event(type: string, data: Record<string, unknown> = {}): SSEEvent {
  return { type, data: { type, ...data } };
}

function completed(response: Record<string, unknown> = {}): SSEEvent {
  return event("response.completed", { response: { status: "completed", ...response } });
}

function messageItem(text: string, id = "message-1") {
  return { id, type: "message", role: "assistant", content: [{ type: "output_text", text }] };
}

function callItem(id: string, callId: string, name: string, args = "") {
  return { id, type: "function_call", call_id: callId, name, arguments: args };
}

function translated(events: SSEEvent[]): AnthropicEvent[] {
  const translator = new AnthropicStreamTranslator(MODEL, ID);
  const output = events.flatMap((upstream) => translator.handle(upstream));
  translator.finish();
  return output;
}

function textDeltas(events: AnthropicEvent[]): string {
  return events
    .flatMap(({ type, data }) =>
      type === "content_block_delta" && data.delta.type === "text_delta" ? [data.delta.text] : [],
    )
    .join("");
}

describe("Anthropic message conversion", () => {
  it("keeps visible blocks and tool IDs while separating cache hits from input usage", () => {
    const result = toAnthropicMessage(
      {
        status: "completed",
        output: [
          { type: "reasoning", summary: [{ type: "summary_text", text: "Private reasoning" }] },
          messageItem("I will check."),
          callItem("function-item", "call-weather", "weather", '{"city":"Madrid"}'),
        ],
        usage: {
          input_tokens: 120,
          input_tokens_details: { cached_tokens: 80 },
          output_tokens: 35,
          output_tokens_details: { reasoning_tokens: 20 },
        },
      },
      MODEL,
      ID,
    );
    expect(result).toEqual({
      id: ID,
      type: "message",
      role: "assistant",
      model: MODEL,
      content: [
        { type: "text", text: "I will check." },
        { type: "tool_use", id: "call-weather", name: "weather", input: { city: "Madrid" } },
      ],
      stop_reason: "tool_use",
      stop_sequence: null,
      usage: {
        input_tokens: 40,
        cache_read_input_tokens: 80,
        cache_creation_input_tokens: 0,
        output_tokens: 35,
      },
    });
    expect(JSON.stringify(result)).not.toMatch(/Private reasoning|thinking|signature/u);
  });

  it("returns generated message IDs, ordinary text, and safe zero usage defaults", () => {
    const result = toAnthropicMessage({ output: [messageItem("Hello!")] }, MODEL);
    expect(result.id).toMatch(/^msg_[\w]+$/u);
    expect(result.stop_reason).toBe("end_turn");
    expect(result.usage).toEqual({
      input_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: 0,
    });
  });

  it("maps refusals to ordinary visible text and the documented refusal stop reason", () => {
    const result = toAnthropicMessage(
      {
        output: [
          { type: "message", content: [{ type: "refusal", refusal: "I cannot help with that." }] },
        ],
      },
      MODEL,
    );
    expect(result.content).toEqual([{ type: "text", text: "I cannot help with that." }]);
    expect(result.stop_reason).toBe("refusal");
  });

  it.each([
    { reason: "max_output_tokens", expected: "max_tokens" },
    { reason: "content_filter", expected: "refusal" },
  ])("maps incomplete reason %s", ({ reason, expected }) => {
    expect(
      toAnthropicMessage(
        { status: "incomplete", incomplete_details: { reason }, output: [messageItem("Partial")] },
        MODEL,
      ).stop_reason,
    ).toEqual(expected);
  });

  it.each(["[]", "null", '"secret-value"', '{"private-value":'])(
    "rejects non-object or malformed tool arguments without exposing them",
    (args) => {
      const convert = () =>
        toAnthropicMessage({ output: [callItem("item", "call", "lookup", args)] }, MODEL);
      expect(convert).toThrow(UpstreamStreamError);
      expect(convert).toThrow("expected a JSON object");
      expect(convert).not.toThrow(/private-value|secret-value/u);
    },
  );

  it("preserves backend error details and refuses unsupported incomplete results", () => {
    try {
      toAnthropicMessage(
        {
          status: "failed",
          error: { message: "Quota exhausted", type: "rate_limit_error", code: "quota" },
        },
        MODEL,
      );
      throw new Error("Expected upstream error");
    } catch (error) {
      expect(error).toBeInstanceOf(UpstreamStreamError);
      expect(error).toMatchObject({
        message: "Quota exhausted",
        errorType: "rate_limit_error",
        code: "quota",
      });
    }
    expect(() =>
      toAnthropicMessage(
        { status: "incomplete", incomplete_details: { reason: "unknown" } },
        MODEL,
      ),
    ).toThrow(UpstreamStreamError);
  });
});

describe("Anthropic streaming translation", () => {
  it("produces the documented message and text-block lifecycle without repeating done snapshots", () => {
    const item = messageItem("Hello!");
    const output = translated([
      event("response.created", { response: { id: "response-1" } }),
      event("response.output_item.added", { output_index: 0, item: { ...item, content: [] } }),
      event("response.content_part.added", {
        item_id: item.id,
        output_index: 0,
        content_index: 0,
        part: { type: "output_text", text: "" },
      }),
      event("response.output_text.delta", {
        item_id: item.id,
        output_index: 0,
        content_index: 0,
        delta: "Hello",
      }),
      event("response.output_text.delta", {
        item_id: item.id,
        output_index: 0,
        content_index: 0,
        delta: "!",
      }),
      event("response.output_text.done", {
        item_id: item.id,
        output_index: 0,
        content_index: 0,
        text: "Hello!",
      }),
      event("response.content_part.done", {
        item_id: item.id,
        output_index: 0,
        content_index: 0,
        part: item.content[0],
      }),
      event("response.output_item.done", { output_index: 0, item }),
      completed({ output: [item], usage: { input_tokens: 25, output_tokens: 15 } }),
    ]);
    const eventTypes: string[] = output.map(({ type }) => type);
    expect(eventTypes).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    const start = output[0];
    expect(start?.type === "message_start" ? start.data.message : undefined).toMatchObject({
      id: ID,
      model: MODEL,
      content: [],
      stop_reason: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    });
    expect(textDeltas(output)).toBe("Hello!");
    expect(output.at(-2)?.data).toEqual({
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: {
        input_tokens: 25,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        output_tokens: 15,
      },
    });
    expect(eventTypes.some((type) => type === "[DONE]")).toBe(false);
  });

  it("keeps parallel tool calls separate through interleaved argument deltas and stable call IDs", () => {
    const first = callItem("item-a", "call-a", "weather", '{"city":"Madrid"}');
    const second = callItem("item-b", "call-b", "time", '{"zone":"Europe/Madrid"}');
    const output = translated([
      event("response.output_item.added", { output_index: 0, item: { ...first, arguments: "" } }),
      event("response.output_item.added", { output_index: 1, item: { ...second, arguments: "" } }),
      event("response.function_call_arguments.delta", { item_id: "item-a", delta: '{"city":' }),
      event("response.function_call_arguments.delta", {
        item_id: "item-b",
        delta: '{"zone":"Europe/',
      }),
      event("response.function_call_arguments.delta", { item_id: "item-a", delta: '"Madrid"}' }),
      event("response.function_call_arguments.done", {
        item_id: "item-a",
        arguments: first.arguments,
      }),
      event("response.function_call_arguments.delta", { item_id: "item-b", delta: 'Madrid"}' }),
      event("response.output_item.done", { output_index: 1, item: second }),
      event("response.output_item.done", { output_index: 0, item: first }),
      completed({ output: [first, second] }),
    ]);
    expect(
      output
        .filter((entry) => entry.type === "content_block_start")
        .map(({ data }) => data.content_block),
    ).toEqual([
      { type: "tool_use", id: "call-a", name: "weather", input: {} },
      { type: "tool_use", id: "call-b", name: "time", input: {} },
    ]);
    for (const [index, expected] of [first.arguments, second.arguments].entries()) {
      const args = output
        .flatMap(({ type, data }) =>
          type === "content_block_delta" &&
          data.index === index &&
          data.delta.type === "input_json_delta"
            ? [data.delta.partial_json]
            : [],
        )
        .join("");
      expect(args).toBe(expected);
      expect(
        output.filter(({ type, data }) => type === "content_block_stop" && data.index === index),
      ).toHaveLength(1);
    }
    const terminal = output.at(-2);
    expect(terminal?.type === "message_delta" ? terminal.data.delta : undefined).toEqual({
      stop_reason: "tool_use",
      stop_sequence: null,
    });
  });

  it("fills in done-only text and tool items and final-output-only items without duplicating existing blocks", () => {
    const text = messageItem("Done-only text");
    const call = callItem("tool-item", "call-final", "lookup", "{}");
    const last = messageItem("Final-only text", "message-final");
    const output = translated([
      event("response.output_item.done", { output_index: 0, item: text }),
      event("response.output_item.done", { output_index: 1, item: call }),
      completed({ output: [text, call, last] }),
    ]);
    expect(output.filter(({ type }) => type === "content_block_start")).toHaveLength(3);
    expect(output.filter(({ type }) => type === "content_block_stop")).toHaveLength(3);
    expect(textDeltas(output)).toBe("Done-only textFinal-only text");
    expect(
      output.filter((entry) => entry.type === "content_block_delta").map(({ data }) => data.delta),
    ).toContainEqual({ type: "input_json_delta", partial_json: "{}" });
  });

  it("supports a final response as the first event, with known initial input usage", () => {
    const output = translated([
      completed({
        output: [messageItem("Hello")],
        usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 70 }, output_tokens: 8 },
      }),
    ]);
    const start = output[0];
    expect(start?.type === "message_start" ? start.data.message : undefined).toMatchObject({
      usage: { input_tokens: 30, cache_read_input_tokens: 70, output_tokens: 0 },
    });
    expect(textDeltas(output)).toBe("Hello");
    const terminal = output.at(-2);
    expect(terminal?.type === "message_delta" ? terminal.data.usage : undefined).toMatchObject({
      input_tokens: 30,
      cache_read_input_tokens: 70,
      output_tokens: 8,
    });
  });

  it("reconciles a missing final text suffix without retaining the streamed text", () => {
    const output = translated([
      event("response.output_text.delta", { output_index: 0, content_index: 0, delta: "Hello" }),
      completed({ output: [messageItem("Hello world")] }),
    ]);
    expect(textDeltas(output)).toBe("Hello world");
    expect(output.filter(({ type }) => type === "content_block_start")).toHaveLength(1);
  });

  it("does not expose reasoning and maps streamed refusals to visible text", () => {
    const output = translated([
      event("response.reasoning_summary_text.delta", { delta: "Private reasoning" }),
      event("response.refusal.delta", { output_index: 1, delta: "Cannot help." }),
      event("response.refusal.done", { output_index: 1, refusal: "Cannot help." }),
      completed(),
    ]);
    expect(textDeltas(output)).toBe("Cannot help.");
    const terminal = output.at(-2);
    expect(terminal?.type === "message_delta" ? terminal.data.delta : undefined).toEqual({
      stop_reason: "refusal",
      stop_sequence: null,
    });
    expect(JSON.stringify(output)).not.toMatch(/Private reasoning|thinking|signature/u);
  });

  it("returns max_tokens for explicit output truncation while retaining its partial text", () => {
    const output = translated([
      event("response.output_text.delta", { delta: "Partial" }),
      event("response.incomplete", {
        response: { incomplete_details: { reason: "max_output_tokens" } },
      }),
    ]);
    expect(textDeltas(output)).toBe("Partial");
    const terminal = output.at(-2);
    expect(terminal?.type === "message_delta" ? terminal.data.delta : undefined).toEqual({
      stop_reason: "max_tokens",
      stop_sequence: null,
    });
  });

  it("refuses premature EOF, malformed tool arguments, and unsupported incomplete reasons", () => {
    const truncated = new AnthropicStreamTranslator(MODEL);
    truncated.handle(event("response.output_text.delta", { delta: "Partial" }));
    expect(() => truncated.finish()).toThrow("before the response completed");
    const invalid = new AnthropicStreamTranslator(MODEL);
    expect(() =>
      invalid.handle(
        event("response.output_item.done", {
          item: callItem("item", "call", "lookup", '{"secret":'),
        }),
      ),
    ).toThrow("expected a JSON object");
    expect(() => invalid.finish()).toThrow(UpstreamStreamError);
    const incomplete = new AnthropicStreamTranslator(MODEL);
    expect(() => incomplete.handle(event("response.incomplete", { response: {} }))).toThrow(
      "unsupported incomplete",
    );
    expect(() => incomplete.finish()).toThrow(UpstreamStreamError);
  });

  it("joins an index-only item with its later ID without creating another block", () => {
    const output = translated([
      event("response.output_text.delta", { output_index: 3, delta: "Hello" }),
      event("response.output_item.done", { output_index: 3, item: messageItem("Hello!") }),
      completed(),
    ]);
    expect(textDeltas(output)).toBe("Hello!");
    expect(output.filter(({ type }) => type === "content_block_start")).toHaveLength(1);
    expect(output.filter(({ type }) => type === "content_block_stop")).toHaveLength(1);
  });

  it("rejects an event that links two different existing item identities", () => {
    const translator = new AnthropicStreamTranslator(MODEL);
    translator.handle(event("response.output_text.delta", { item_id: "first", delta: "A" }));
    translator.handle(event("response.output_text.delta", { output_index: 1, delta: "B" }));
    expect(() =>
      translator.handle(
        event("response.output_text.delta", { item_id: "first", output_index: 1, delta: "C" }),
      ),
    ).toThrow("Codex returned inconsistent output item identities.");
  });

  it("keeps an ID-only item separate from the default output index", () => {
    const output = translated([
      event("response.output_text.delta", { item_id: "named", delta: "A" }),
      event("response.output_text.delta", { delta: "B" }),
      completed(),
    ]);
    expect(textDeltas(output)).toBe("AB");
    expect(output.filter(({ type }) => type === "content_block_start")).toHaveLength(2);
  });

  it("buffers finished tool arguments until later item metadata arrives", () => {
    const output = translated([
      event("response.function_call_arguments.done", { item_id: "tool", arguments: "{}" }),
      event("response.output_item.done", { item: callItem("tool", "call", "lookup", "{}") }),
      completed(),
    ]);
    expect(output.filter(({ type }) => type === "content_block_start")).toHaveLength(1);
    expect(output.filter(({ type }) => type === "content_block_stop")).toHaveLength(1);
    expect(output.filter(({ type }) => type === "content_block_delta")).toHaveLength(1);
  });

  it("rejects argument deltas after the tool call has stopped", () => {
    const translator = new AnthropicStreamTranslator(MODEL);
    translator.handle(
      event("response.output_item.done", { item: callItem("tool", "call", "lookup", "{}") }),
    );
    expect(() =>
      translator.handle(
        event("response.function_call_arguments.delta", { item_id: "tool", delta: "x" }),
      ),
    ).toThrow("Codex updated a completed tool call.");
  });

  it.each([
    { type: "response.output_item.added", data: { item: null } },
    { type: "response.output_item.done", data: { item: [] } },
    { type: "response.content_part.added", data: { part: null } },
    { type: "response.content_part.done", data: { part: [] } },
    { type: "response.output_text.unknown", data: { delta: "ignored" } },
    { type: "response.function_call_arguments.unknown", data: { delta: "ignored" } },
  ])("ignores malformed or unsupported content in $type", ({ type, data }) => {
    const translator = new AnthropicStreamTranslator(MODEL);
    expect(translator.handle(event(type, data)).map(({ type }) => type)).toEqual(["message_start"]);
    expect(translator.handle(completed()).map(({ type }) => type)).toEqual([
      "message_delta",
      "message_stop",
    ]);
  });

  it("ignores unknown and completed events but still propagates errors after completion", () => {
    const translator = new AnthropicStreamTranslator(MODEL);
    expect(translator.handle(event("response.unknown"))).toHaveLength(1);
    translator.handle(completed());
    expect(translator.handle(event("response.output_text.delta", { delta: "late" }))).toEqual([]);
    expect(() =>
      translator.handle(
        event("response.failed", { response: { error: { message: "Late error" } } }),
      ),
    ).toThrow("Late error");
  });

  it.each(["error", "response.failed"])(
    "rejects an initial %s before starting the message lifecycle",
    (type) => {
      const translator = new AnthropicStreamTranslator(MODEL);
      expect(() =>
        translator.handle(event(type, { error: { message: "Initial failure" } })),
      ).toThrow("Initial failure");
      expect(translator.handle(event("response.created")).map(({ type }) => type)).toEqual([
        "message_start",
      ]);
    },
  );

  it("propagates nested backend errors without emitting a successful terminal event", () => {
    const translator = new AnthropicStreamTranslator(MODEL);
    translator.handle(event("response.created"));
    expect(() =>
      translator.handle(
        event("error", {
          error: {
            message: "Invalid input",
            code: "bad_input",
            type: "invalid_request_error",
            param: "input",
          },
        }),
      ),
    ).toThrow("Invalid input");
    expect(() => translator.finish()).toThrow(UpstreamStreamError);
  });
});
