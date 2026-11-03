import { describe, expect, it } from "bun:test";

import { UpstreamStreamError } from "./errors.ts";
import { collectResponse, InvalidRequest, normalizeResponsesRequest } from "./responses.ts";
import type { SSEEvent } from "./sse.ts";

describe("normalizeResponsesRequest", () => {
  it("wraps a string input and forces an unstored stream", () => {
    const { upstream, stream } = normalizeResponsesRequest({ model: "gpt-5.5", input: "Hi" });

    expect(stream).toBe(false);
    expect(upstream).toEqual({
      model: "gpt-5.5",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Hi" }] }],
      instructions: "You are a helpful assistant.",
      store: false,
      stream: true,
    });
  });

  it("remembers that the caller asked for a stream", () => {
    expect(normalizeResponsesRequest({ model: "gpt-5.5", input: "Hi", stream: true }).stream).toBe(
      true,
    );
  });

  it("merges system turns from input into instructions", () => {
    const { upstream } = normalizeResponsesRequest({
      model: "gpt-5.5",
      instructions: "Be terse.",
      input: [
        { role: "system", content: "Answer in Spanish." },
        { role: "user", content: "Hi" },
      ],
    });

    expect(upstream.instructions).toBe("Be terse.\n\nAnswer in Spanish.");
    expect(upstream.input).toEqual([{ role: "user", content: "Hi" }]);
  });

  it("keeps JSON mode valid after system-only JSON instructions leave the input", () => {
    const input = [
      { role: "developer", content: [{ type: "input_text", text: "Return JSON." }] },
      { role: "user", content: "Summarize these headlines." },
    ];
    const { upstream } = normalizeResponsesRequest({
      model: "gpt-5.5",
      input,
      text: { format: { type: "json_object" } },
    });

    expect(upstream.instructions).toBe("Return JSON.");
    expect(upstream.input).toEqual([
      { role: "user", content: "Summarize these headlines." },
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Respond with a JSON object." }],
      },
    ]);
    expect(input).toHaveLength(2);
    expect(input[0]?.role).toBe("developer");
  });

  it("adds the JSON input instruction even when JSON is already in separate instructions", () => {
    const { upstream } = normalizeResponsesRequest({
      model: "gpt-5.5",
      instructions: "Return JSON.",
      input: "Summarize this.",
      text: { format: { type: "json_object" } },
    });
    expect(upstream.instructions).toBe("Return JSON.");
    expect(upstream.input).toEqual([
      { type: "message", role: "user", content: [{ type: "input_text", text: "Summarize this." }] },
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Respond with a JSON object." }],
      },
    ]);
  });

  it("preserves multipart and tool items without counting JSON in metadata or tool data", () => {
    const input = Object.freeze([
      {
        role: "user",
        content: [
          {
            type: "input_image",
            image_url: "https://example.com/json.png",
            text: "JSON image metadata",
          },
          { type: "input_text", text: "Describe this image." },
        ],
        metadata: "JSON",
      },
      {
        type: "function_call",
        call_id: "call_1",
        name: "json_lookup",
        arguments: '{"format":"json"}',
      },
      { type: "function_call_output", call_id: "call_1", output: "JSON tool output" },
    ]);
    const original = structuredClone(input);
    const { upstream } = normalizeResponsesRequest({
      model: "gpt-5.5",
      input,
      text: { format: { type: "json_object" } },
    });
    expect(upstream.input).toEqual([
      ...original,
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Respond with a JSON object." }],
      },
    ]);
    expect(input).toEqual(original);
    expect(normalizeResponsesRequest(upstream).upstream).toEqual(upstream);
  });

  it.each([
    { role: "user", content: "Return jSoN." },
    { type: "message", role: "user", content: [{ type: "input_text", text: "Return JSON." }] },
    {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "The previous JSON answer." }],
    },
  ])("leaves actual JSON text in input messages unchanged: %j", (message) => {
    const input = [message];
    expect(
      normalizeResponsesRequest({
        model: "gpt-5.5",
        input,
        text: { format: { type: "json_object" } },
      }).upstream.input,
    ).toEqual(input);
  });

  it.each([{ type: "text" }, { type: "json_schema", name: "answer", schema: { type: "object" } }])(
    "leaves input unchanged for the %j text format",
    (format) => {
      const input = [{ role: "user", content: "Hi" }];
      expect(
        normalizeResponsesRequest({ model: "gpt-5.5", input, text: { format } }).upstream.input,
      ).toEqual(input);
    },
  );

  it("strips the fields Codex rejects", () => {
    const { upstream } = normalizeResponsesRequest({
      model: "gpt-5.5",
      input: "Hi",
      max_output_tokens: 10,
      metadata: { a: 1 },
      user: "me",
    });

    expect(upstream).not.toHaveProperty("max_output_tokens");
    expect(upstream).not.toHaveProperty("metadata");
    expect(upstream).not.toHaveProperty("user");
  });

  it("reads a reasoning suffix, keeping other reasoning fields", () => {
    const { upstream } = normalizeResponsesRequest({
      model: "gpt-5.5-xhigh",
      input: "Hi",
      reasoning: { summary: "detailed" },
    });

    expect(upstream.model).toBe("gpt-5.5");
    expect(upstream.reasoning).toEqual({ summary: "detailed", effort: "xhigh" });
  });

  it("rejects previous_response_id, since nothing is stored", () => {
    expect(() =>
      normalizeResponsesRequest({ model: "gpt-5.5", input: "Hi", previous_response_id: "resp_1" }),
    ).toThrow(InvalidRequest);
  });
});

async function* events(...list: SSEEvent[]): AsyncGenerator<SSEEvent> {
  yield* list;
}

describe("collectResponse", () => {
  it("returns the completed response as Codex sent it", async () => {
    const response = { id: "resp_1", status: "completed", output: [{ type: "message" }] };

    expect(
      await collectResponse(
        events({ type: "response.completed", data: { type: "response.completed", response } }),
      ),
    ).toEqual(response);
  });

  it("rebuilds an empty output from the finished items, in output order", async () => {
    const result = await collectResponse(
      events(
        { type: "response.output_item.done", data: { output_index: 1, item: { id: "b" } } },
        { type: "response.output_item.done", data: { output_index: 0, item: { id: "a" } } },
        { type: "response.completed", data: { response: { id: "resp_1", output: [] } } },
      ),
    );

    expect(result.output).toEqual([{ id: "a" }, { id: "b" }]);
  });

  it("throws when the stream ends without completing", async () => {
    await expect(collectResponse(events())).rejects.toThrow(UpstreamStreamError);
  });

  it("preserves nested error details from a rejected upstream stream", async () => {
    await expect(
      collectResponse(
        events({
          type: "error",
          data: {
            type: "error",
            error: {
              message: "JSON input is required.",
              code: null,
              type: "invalid_request_error",
              param: "input",
            },
          },
        }),
      ),
    ).rejects.toMatchObject({
      message: "JSON input is required.",
      code: null,
      errorType: "invalid_request_error",
      param: "input",
      eventType: "error",
    });
  });

  it.each([
    {
      type: "error",
      data: {
        type: "invalid_request_error",
        message: "Invalid input.",
        code: "invalid_input",
        param: "input",
      },
    },
    {
      type: "response.failed",
      data: {
        type: "response.failed",
        response: {
          error: {
            message: "Invalid input.",
            code: "invalid_input",
            type: "invalid_request_error",
            param: "input",
          },
        },
      },
    },
  ])("preserves top-level and response.failed details: %j", async (event) => {
    await expect(collectResponse(events(event))).rejects.toMatchObject({
      message: "Invalid input.",
      code: "invalid_input",
      errorType: "invalid_request_error",
      param: "input",
    });
  });
});
