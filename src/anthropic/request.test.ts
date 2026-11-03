import { describe, expect, it } from "bun:test";

import { InvalidAnthropicRequest, normalizeAnthropicRequest } from "./request.ts";

const BASE = {
  model: "gpt-6.1-sol",
  max_tokens: 1024,
  messages: [{ role: "user", content: "Hi" }],
};

describe("normalizeAnthropicRequest", () => {
  it("normalizes a basic request through the shared Codex constraints", () => {
    expect(normalizeAnthropicRequest(BASE)).toEqual({
      model: "gpt-6.1-sol",
      stream: false,
      upstream: {
        model: "gpt-6.1-sol",
        instructions: "You are a helpful assistant.",
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Hi" }] }],
        stream: true,
        store: false,
      },
    });
  });

  it("retains the caller model while resolving suffixes and explicit effort precedence", () => {
    const result = normalizeAnthropicRequest({
      ...BASE,
      model: "gpt-6.1-sol-high",
      stream: true,
      reasoning_effort: "future-effort",
      output_config: { effort: "low" },
    });
    expect(result.model).toBe("gpt-6.1-sol-high");
    expect(result.stream).toBe(true);
    expect(result.upstream.model).toBe("gpt-6.1-sol");
    expect(result.upstream.reasoning).toEqual({ effort: "future-effort", summary: "auto" });
    expect(
      normalizeAnthropicRequest({ ...BASE, output_config: { effort: "max" } }).upstream.reasoning,
    ).toEqual({ effort: "max", summary: "auto" });
    expect(
      normalizeAnthropicRequest({ ...BASE, model: "claude-sonnet-custom" }).upstream.model,
    ).toBe("claude-sonnet-custom");
  });

  it("moves cached system text into instructions without claiming caching", () => {
    const { upstream } = normalizeAnthropicRequest({
      ...BASE,
      system: [
        { type: "text", text: "Be terse.", cache_control: { type: "ephemeral", ttl: "1h" } },
        { type: "text", text: "Use Spanish." },
      ],
      cache_control: { type: "ephemeral" },
      metadata: { user_id: "private-user" },
    });
    expect(upstream.instructions).toBe("Be terse.\n\nUse Spanish.");
    expect(upstream).not.toHaveProperty("cache_control");
    expect(upstream).not.toHaveProperty("metadata");
  });

  it("preserves text, tool calls, tool results and images in conversation order", () => {
    const { upstream } = normalizeAnthropicRequest({
      ...BASE,
      messages: [
        { role: "user", content: "Find the file." },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Looking." },
            { type: "tool_use", id: "toolu_1", name: "read", input: { path: "notes.txt" } },
            { type: "text", text: "Waiting." },
          ],
        },
        {
          role: "user",
          content: [
            { type: "text", text: "Result follows." },
            {
              type: "tool_result",
              tool_use_id: "toolu_1",
              content: [
                { type: "text", text: "Contents" },
                { type: "text", text: "More" },
              ],
            },
            { type: "text", text: "Summarize it." },
          ],
        },
      ],
    });
    expect(upstream.input).toEqual([
      { type: "message", role: "user", content: [{ type: "input_text", text: "Find the file." }] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "Looking." }] },
      {
        type: "function_call",
        call_id: "toolu_1",
        name: "read",
        arguments: '{"path":"notes.txt"}',
      },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "Waiting." }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "Result follows." }] },
      { type: "function_call_output", call_id: "toolu_1", output: "Contents\nMore" },
      { type: "message", role: "user", content: [{ type: "input_text", text: "Summarize it." }] },
    ]);
  });

  it("translates HTTPS and base64 image sources without dropping surrounding text", () => {
    const { upstream } = normalizeAnthropicRequest({
      ...BASE,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Compare:" },
            { type: "image", source: { type: "url", url: "https://example.com/image.png" } },
            { type: "image", source: { type: "base64", media_type: "image/png", data: "AQID" } },
          ],
        },
      ],
    });
    expect(upstream.input).toEqual([
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "Compare:" },
          { type: "input_image", image_url: "https://example.com/image.png" },
          { type: "input_image", image_url: "data:image/png;base64,AQID" },
        ],
      },
    ]);
  });

  it("preserves tool errors and structured image tool results", () => {
    const { upstream } = normalizeAnthropicRequest({
      ...BASE,
      messages: [
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "toolu_1", name: "capture", input: {} },
            { type: "tool_use", id: "toolu_2", name: "read", input: {} },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_1",
              is_error: true,
              content: [
                { type: "text", text: "Partial capture" },
                { type: "image", source: { type: "url", url: "https://example.com/capture.png" } },
              ],
            },
            {
              type: "tool_result",
              tool_use_id: "toolu_2",
              is_error: true,
              content: "Permission denied",
            },
          ],
        },
      ],
    });
    expect(upstream.input).toMatchObject([
      { type: "function_call", call_id: "toolu_1" },
      { type: "function_call", call_id: "toolu_2" },
      {
        type: "function_call_output",
        call_id: "toolu_1",
        output: [
          { type: "input_text", text: "[Tool error] " },
          { type: "input_text", text: "Partial capture" },
          { type: "input_image", image_url: "https://example.com/capture.png" },
        ],
      },
      {
        type: "function_call_output",
        call_id: "toolu_2",
        output: "[Tool error] Permission denied",
      },
    ]);
  });

  it.each([
    [{ type: "auto" }, "auto"],
    [{ type: "any" }, "required"],
    [{ type: "none" }, "none"],
    [
      { type: "tool", name: "read" },
      { type: "function", name: "read" },
    ],
  ])("maps custom tools and tool choice %j", (tool_choice, expected) => {
    const { upstream } = normalizeAnthropicRequest({
      ...BASE,
      tools: [{ name: "read", description: "Read a file", input_schema: { type: "object" } }],
      tool_choice: { ...tool_choice, disable_parallel_tool_use: true },
    });
    expect(upstream.tools).toEqual([
      {
        type: "function",
        name: "read",
        description: "Read a file",
        parameters: { type: "object" },
        strict: false,
      },
    ]);
    expect(upstream.tool_choice).toEqual(expected);
    expect(upstream.parallel_tool_calls).toBe(false);
  });

  it.each([{ tools: undefined }, { tools: [] }])(
    "omits tool options for an absent or empty tool list %j",
    ({ tools }) => {
      const { upstream } = normalizeAnthropicRequest({ ...BASE, tools });
      expect(upstream).not.toHaveProperty("tools");
      expect(upstream).not.toHaveProperty("tool_choice");
      expect(upstream).not.toHaveProperty("parallel_tool_calls");
    },
  );

  it.each(["auto", "none"])("accepts tool_choice %s without declared tools", (type) => {
    const { upstream } = normalizeAnthropicRequest({ ...BASE, tool_choice: { type } });
    expect(upstream.tool_choice).toBe(type);
    expect(upstream).not.toHaveProperty("tools");
    expect(upstream).not.toHaveProperty("parallel_tool_calls");
  });

  it("preserves tool order, empty descriptions and explicit parallel calls", () => {
    const { upstream } = normalizeAnthropicRequest({
      ...BASE,
      tools: [
        { name: "write", input_schema: { type: "object" } },
        { name: "read", description: "", input_schema: {}, strict: true },
      ],
      tool_choice: { type: "tool", name: "read", disable_parallel_tool_use: false },
    });
    expect(upstream.tools).toEqual([
      { type: "function", name: "write", parameters: { type: "object" }, strict: false },
      { type: "function", name: "read", description: "", parameters: {}, strict: true },
    ]);
    expect(upstream.tool_choice).toEqual({ type: "function", name: "read" });
    expect(upstream.parallel_tool_calls).toBe(true);
  });

  it.each([
    { tools: undefined, tool_choice: { type: "any" }, message: "tool_choice any requires tools." },
    { tools: [], tool_choice: { type: "any" }, message: "tool_choice any requires tools." },
    {
      tools: [{ name: "read", input_schema: {} }],
      tool_choice: { type: "tool", name: "private-tool" },
      message: "Named tool_choice must reference a declared tool.",
    },
    {
      tools: [
        { name: "read", input_schema: {} },
        { name: "read", input_schema: {} },
      ],
      tool_choice: { type: "tool", name: "private-tool" },
      message: "Tool names must be unique.",
    },
  ])("rejects invalid tool dependencies with $message", ({ tools, tool_choice, message }) => {
    expect(() => normalizeAnthropicRequest({ ...BASE, tools, tool_choice })).toThrow(
      new InvalidAnthropicRequest(message),
    );
  });

  it("validates conversation history before tool options", () => {
    expect(() =>
      normalizeAnthropicRequest({
        ...BASE,
        messages: [
          { role: "user", content: [{ type: "tool_use", id: "call", name: "read", input: {} }] },
        ],
        tools: [
          { name: "read", input_schema: {} },
          { name: "read", input_schema: {} },
        ],
      }),
    ).toThrow(new InvalidAnthropicRequest("Content block is unsupported for this message role."));
  });

  it("maps structured output and accepts validated sampling limits without forwarding them", () => {
    const { upstream } = normalizeAnthropicRequest({
      ...BASE,
      temperature: 0,
      top_p: 0.9,
      top_k: 10,
      stop_sequences: [],
      thinking: { type: "disabled" },
      output_config: {
        format: {
          type: "json_schema",
          schema: { type: "object", properties: { answer: { type: "string" } } },
        },
      },
    });
    expect(upstream.text).toEqual({
      format: {
        type: "json_schema",
        name: "anthropic_response",
        schema: { type: "object", properties: { answer: { type: "string" } } },
        strict: false,
      },
    });
    for (const field of [
      "max_tokens",
      "max_output_tokens",
      "temperature",
      "top_p",
      "top_k",
      "stop_sequences",
      "thinking",
    ])
      expect(upstream).not.toHaveProperty(field);
  });

  it.each([undefined, null, "custom"])(
    "accepts the SDK custom tool type %j and preserves strict mode",
    (type) => {
      const { upstream } = normalizeAnthropicRequest({
        ...BASE,
        tools: [{ type, name: "read", input_schema: { type: "object" }, strict: true }],
      });
      expect(upstream.tools).toEqual([
        { type: "function", name: "read", parameters: { type: "object" }, strict: true },
      ]);
    },
  );

  it("rejects nontext/nonimage tool results and duplicate or replayed tool IDs", () => {
    const call = { type: "tool_use", id: "toolu_1", name: "read", input: {} };
    const result = { type: "tool_result", tool_use_id: "toolu_1", content: "ok" };
    for (const messages of [
      [{ role: "assistant", content: [call, call] }],
      [
        { role: "assistant", content: [call] },
        { role: "user", content: [result, result] },
      ],
      [
        { role: "assistant", content: [call] },
        {
          role: "user",
          content: [
            {
              ...result,
              content: [{ type: "document", source: { type: "text", data: "private-value" } }],
            },
          ],
        },
      ],
    ])
      expect(() => normalizeAnthropicRequest({ ...BASE, messages })).toThrow(
        InvalidAnthropicRequest,
      );
  });

  it.each(
    [
      null,
      [],
      {},
      { ...BASE, model: " " },
      { ...BASE, max_tokens: 0 },
      { ...BASE, max_tokens: 1.5 },
      { ...BASE, messages: [] },
      { ...BASE, messages: [{ role: "system", content: "Hi" }] },
      { ...BASE, temperature: 2 },
      { ...BASE, top_p: -1 },
      { ...BASE, top_k: 1.2 },
      { ...BASE, stream: "true" },
      { ...BASE, reasoning_effort: " " },
      { ...BASE, tool_choice: { type: "tool", name: "missing" } },
    ].map((body) => ({ body })),
  )("rejects malformed requests: %j", ({ body }) => {
    expect(() => normalizeAnthropicRequest(body)).toThrow(InvalidAnthropicRequest);
  });

  it.each(["document", "server_tool_use", "thinking", "redacted_thinking", "search_result"])(
    "rejects unsupported content rather than dropping %s",
    (type) => {
      expect(() =>
        normalizeAnthropicRequest({
          ...BASE,
          messages: [{ role: "user", content: [{ type, text: "private-input" }] }],
        }),
      ).toThrow(InvalidAnthropicRequest);
    },
  );

  it.each([
    { stop_sequences: ["END"] },
    { thinking: { type: "enabled", budget_tokens: 1000 } },
    { thinking: { type: "adaptive" } },
    { mcp_servers: [] },
    { container: null },
    { context_management: {} },
    { unsupported_semantics: "private-key" },
  ])("rejects unsupported semantic options: %j", (extra) => {
    expect(() => normalizeAnthropicRequest({ ...BASE, ...extra })).toThrow(InvalidAnthropicRequest);
  });

  it("rejects invalid content roles, images and tool histories with safe errors", () => {
    for (const messages of [
      [
        {
          role: "assistant",
          content: [{ type: "image", source: { type: "url", url: "https://example.com/a.png" } }],
        },
      ],
      [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "url", url: "http://example.com/private-key" } },
          ],
        },
      ],
      [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: "application/pdf", data: "private-key" },
            },
          ],
        },
      ],
      [{ role: "user", content: [{ type: "tool_use", id: "toolu_1", name: "read", input: {} }] }],
      [
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "missing", content: "private-key" }],
        },
      ],
    ]) {
      try {
        normalizeAnthropicRequest({ ...BASE, messages });
        throw new Error("Expected validation failure");
      } catch (error) {
        expect(error).toBeInstanceOf(InvalidAnthropicRequest);
        expect((error as Error).message).not.toContain("private-key");
      }
    }
  });
});
