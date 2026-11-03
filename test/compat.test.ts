import { describe, expect, it } from "bun:test";

import { normalizeClaudeCodeRequest } from "../src/anthropic/claude-code.ts";
import { AnthropicHttpError } from "../src/anthropic/errors.ts";
import { InvalidAnthropicRequest } from "../src/anthropic/request.ts";

const request = {
  model: "codex/gpt-6-luna",
  messages: [{ role: "user", content: "Hello." }],
  system: [
    {
      type: "text",
      text: "Synthetic Claude Code system prompt.",
      cache_control: { type: "ephemeral" },
    },
  ],
  tools: [
    {
      name: "Bash",
      description: "Run a command.",
      input_schema: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
      },
    },
  ],
  metadata: { user_id: "synthetic-local-user" },
  max_tokens: 32000,
  thinking: { type: "adaptive", display: "omitted" },
  context_management: { edits: [{ type: "clear_thinking_20251015", keep: "all" }] },
  output_config: { effort: "high" },
  stream: true,
};

describe("Claude Code Codex request adaptation", () => {
  it.each(["[1m]", "[1M]"])(
    "strips the context suffix %s only from the upstream model",
    (suffix) => {
      expect(
        normalizeClaudeCodeRequest({ ...request, model: `codex/gpt-6-luna${suffix}` }),
      ).toMatchObject({
        model: `codex/gpt-6-luna${suffix}`,
        upstream: { model: "gpt-6-luna" },
      });
    },
  );
  it("accepts the captured adaptive-thinking request and preserves public model IDs", () => {
    const original = structuredClone(request);
    const normalized = normalizeClaudeCodeRequest(request);
    expect(normalized).toMatchObject({
      model: "codex/gpt-6-luna",
      stream: true,
      upstream: {
        model: "gpt-6-luna",
        stream: true,
        store: false,
        reasoning: { effort: "high" },
        instructions: "Synthetic Claude Code system prompt.",
      },
    });
    expect(normalized.upstream).not.toHaveProperty("thinking");
    expect(normalized.upstream).not.toHaveProperty("context_management");
    expect(request).toEqual(original);
  });

  it("maps disabled thinking to no reasoning only when no explicit effort is present", () => {
    const disabled = { ...request, output_config: undefined, thinking: { type: "disabled" } };
    expect(normalizeClaudeCodeRequest(disabled).upstream.reasoning).toMatchObject({
      effort: "none",
    });
    expect(
      normalizeClaudeCodeRequest({ ...disabled, reasoning_effort: "low" }).upstream.reasoning,
    ).toMatchObject({ effort: "low" });
    expect(
      normalizeClaudeCodeRequest({ ...disabled, output_config: { effort: "medium" } }).upstream
        .reasoning,
    ).toMatchObject({ effort: "medium" });
  });

  it("preserves regular tool calls/results, image evidence, literal tool inputs, and input schemas", () => {
    const input = {
      command: "echo synthetic",
      type: "thinking",
      thinking: "literal argument",
      cache_control: "literal argument",
    };
    const inputSchema = {
      type: "object",
      properties: {
        type: { type: "string", const: "tool_reference" },
        cache_control: { type: "boolean" },
      },
    };
    const normalized = normalizeClaudeCodeRequest({
      ...request,
      tools: [
        {
          name: "Bash",
          input_schema: inputSchema,
          defer_loading: false,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [
        {
          role: "user",
          cache_control: { type: "ephemeral" },
          content: [
            { type: "text", text: "Inspect this image.", cache_control: { type: "ephemeral" } },
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" },
              cache_control: { type: "ephemeral" },
            },
          ],
        },
        {
          role: "assistant",
          content: [
            {
              type: "thinking",
              thinking: "Visible prior thought.",
              signature: "signed-native-only",
            },
            { type: "redacted_thinking", data: "redacted-native-only" },
            {
              type: "tool_use",
              id: "call-1",
              name: "Bash",
              input,
              cache_control: { type: "ephemeral" },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "call-1",
              content: [
                { type: "text", text: "Synthetic result", cache_control: { type: "ephemeral" } },
                {
                  type: "image",
                  source: { type: "url", url: "https://example.com/result.png" },
                  cache_control: { type: "ephemeral" },
                },
              ],
              cache_control: { type: "ephemeral" },
            },
          ],
        },
      ],
    });
    expect(normalized.upstream.tools).toEqual([
      { type: "function", name: "Bash", parameters: inputSchema, strict: false },
    ]);
    expect(normalized.upstream.input).toEqual([
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "Inspect this image." },
          { type: "input_image", image_url: "data:image/png;base64,aGVsbG8=" },
        ],
      },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Visible prior thought." }],
      },
      { type: "function_call", call_id: "call-1", name: "Bash", arguments: JSON.stringify(input) },
      {
        type: "function_call_output",
        call_id: "call-1",
        output: [
          { type: "input_text", text: "Synthetic result" },
          { type: "input_image", image_url: "https://example.com/result.png" },
        ],
      },
    ]);
    expect(JSON.stringify(normalized.upstream)).not.toContain("signed-native-only");
    expect(JSON.stringify(normalized.upstream)).not.toContain("redacted-native-only");
  });

  it("keeps history system text ordered and labeled while preserving explicit top-level effort", () => {
    const normalized = normalizeClaudeCodeRequest({
      ...request,
      messages: [
        { role: "user", content: "First question." },
        {
          role: "system",
          cache_control: { type: "ephemeral" },
          content: [{ type: "text", text: "New context.", cache_control: { type: "ephemeral" } }],
        },
        {
          role: "assistant",
          content: [{ type: "compaction", content: "Previous conversation summary." }],
        },
        { role: "system", content: [], output_config: { effort: "low" } },
        { role: "user", content: "Continue." },
      ],
    });
    expect(normalized.upstream.instructions).toBe(
      "Synthetic Claude Code system prompt.\n\n[System context at history position 1]\nNew context.",
    );
    expect(normalized.upstream.reasoning).toMatchObject({ effort: "high" });
    expect(normalized.upstream.input).toEqual([
      { type: "message", role: "user", content: [{ type: "input_text", text: "First question." }] },
      {
        type: "message",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: "[Compacted conversation summary]\nPrevious conversation summary.",
          },
        ],
      },
      { type: "message", role: "user", content: [{ type: "input_text", text: "Continue." }] },
    ]);
  });

  it("uses per-turn effort when no top-level effort is present and omits redacted-only messages", () => {
    const normalized = normalizeClaudeCodeRequest({
      ...request,
      output_config: undefined,
      messages: [
        { role: "user", content: "Continue." },
        { role: "assistant", content: [{ type: "redacted_thinking", data: "hidden" }] },
        { role: "system", content: [], output_config: { effort: "low" } },
      ],
    });
    expect(normalized.upstream.reasoning).toMatchObject({ effort: "low" });
    expect(normalized.upstream.input).toEqual([
      { type: "message", role: "user", content: [{ type: "input_text", text: "Continue." }] },
    ]);
  });

  it.each([
    { block: { type: "thinking", thinking: "Prior thought.", signature: 1 }, kind: "thinking" },
    { block: { type: "redacted_thinking", data: null }, kind: "redacted thinking" },
    { block: { type: "compaction", content: "Summary.", unexpected: true }, kind: "compaction" },
  ])("rejects malformed $kind history before later content errors", ({ block, kind }) => {
    expect(() =>
      normalizeClaudeCodeRequest({
        ...request,
        messages: [{ role: "assistant", content: [block, { type: "tool_search_tool_result" }] }],
      }),
    ).toThrow(`Malformed ${kind} history block.`);
  });

  it.each([
    { type: "thinking", thinking: "Prior thought." },
    { type: "redacted_thinking", data: "hidden" },
    { type: "compaction", content: "Summary." },
  ])("does not convert assistant-only history in user content: %j", (block) => {
    expect(() =>
      normalizeClaudeCodeRequest({
        ...request,
        messages: [{ role: "user", content: [block] }],
      }),
    ).toThrow("Invalid Anthropic request: malformed or unsupported fields or content blocks.");
    expect(() =>
      normalizeClaudeCodeRequest({
        ...request,
        messages: [
          {
            role: "assistant",
            content: [{ type: "tool_use", id: "call-1", name: "Bash", input: {} }],
          },
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "call-1", content: [block] }],
          },
        ],
      }),
    ).toThrow("Invalid Anthropic request: malformed or unsupported fields or content blocks.");
  });

  it("makes inline tools from Claude Code system history callable without losing system text", () => {
    const definition = {
      name: "Read",
      description: "Read a project file.",
      input_schema: {
        type: "object",
        properties: { file_path: { type: "string" }, cache_control: { type: "boolean" } },
        required: ["file_path"],
      },
      cache_control: { type: "ephemeral" },
    };
    const input = {
      ...request,
      messages: [
        { role: "user", content: "How does this project work?" },
        {
          role: "system",
          content: [
            { type: "text", text: "Project tools are now available." },
            { type: "tool_addition", tool: { type: "tool_definition", definition } },
          ],
        },
      ],
    };
    const original = structuredClone(input);
    const normalized = normalizeClaudeCodeRequest(input);
    expect(normalized.upstream.tools).toEqual([
      expect.objectContaining({ name: "Bash" }),
      {
        type: "function",
        name: "Read",
        description: definition.description,
        parameters: definition.input_schema,
        strict: false,
      },
    ]);
    expect(normalized.upstream.instructions).toBe(
      "Synthetic Claude Code system prompt.\n\n[System context at history position 1]\nProject tools are now available.",
    );
    expect(input).toEqual(original);
  });

  it("applies tool replacement, removal, and re-addition in history order", () => {
    const definition = { name: "Read", input_schema: { type: "object" } };
    const replacement = { ...definition, description: "Read the current file." };
    const normalized = normalizeClaudeCodeRequest({
      ...request,
      messages: [
        ...request.messages,
        {
          role: "system",
          content: [
            { type: "tool_addition", tool: { type: "tool_definition", definition } },
            { type: "tool_addition", tool: { type: "tool_definition", definition } },
            {
              type: "tool_addition",
              tool: { type: "tool_definition", definition: replacement },
            },
            { type: "tool_removal", tool: { type: "tool_reference", name: "Read" } },
            { type: "tool_removal", tool: { type: "tool_reference", name: "Bash" } },
          ],
        },
        { role: "assistant", content: "Continue with read access only." },
        { role: "user", content: "Read the file." },
        {
          role: "system",
          content: [{ type: "tool_addition", tool: { type: "tool_reference", name: "Read" } }],
        },
      ],
    });
    expect(normalized.upstream.tools).toEqual([
      {
        type: "function",
        name: "Read",
        description: replacement.description,
        parameters: definition.input_schema,
        strict: false,
      },
    ]);
    expect(normalized.upstream.instructions).toBe("Synthetic Claude Code system prompt.");
  });

  it("keeps replacement positions and appends removed tools when re-added", () => {
    const read = { name: "Read", input_schema: { type: "object" } };
    const edit = { name: "Edit", input_schema: { type: "object" } };
    const replacement = { ...request.tools[0], description: "Run the current command." };
    const normalized = normalizeClaudeCodeRequest({
      ...request,
      tools: [...request.tools, read, edit],
      messages: [
        ...request.messages,
        {
          role: "system",
          content: [
            { type: "tool_addition", tool: { type: "tool_definition", definition: replacement } },
            { type: "tool_removal", tool: { type: "tool_reference", name: "Read" } },
            { type: "tool_addition", tool: { type: "tool_reference", name: "Read" } },
          ],
        },
      ],
    });
    expect(normalized.upstream.tools).toEqual([
      expect.objectContaining({ name: "Bash", description: replacement.description }),
      expect.objectContaining({ name: "Edit" }),
      expect.objectContaining({ name: "Read" }),
    ]);
  });

  it("activates deferred definitions only when already available or discovered", () => {
    const read = { name: "Read", input_schema: { type: "object" }, defer_loading: true };
    const removed = { name: "Removed", input_schema: { type: "object" } };
    const replacement = {
      ...request.tools[0],
      description: "Run the current command.",
      defer_loading: true,
    };
    const normalized = normalizeClaudeCodeRequest({
      ...request,
      tools: [...request.tools, removed],
      messages: [
        ...request.messages,
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "search-1", name: "Bash", input: {} }],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "search-1",
              content: [{ type: "tool_reference", tool_name: "Read" }],
            },
          ],
        },
        {
          role: "system",
          content: [
            { type: "tool_addition", tool: { type: "tool_definition", definition: read } },
            { type: "tool_addition", tool: { type: "tool_definition", definition: replacement } },
            { type: "tool_removal", tool: { type: "tool_reference", name: "Removed" } },
            {
              type: "tool_addition",
              tool: { type: "tool_definition", definition: { ...removed, defer_loading: true } },
            },
            {
              type: "tool_addition",
              tool: {
                type: "tool_definition",
                definition: { ...read, name: "Undiscovered" },
              },
            },
          ],
        },
      ],
    });
    expect(normalized.upstream.tools).toEqual([
      expect.objectContaining({ name: "Bash", description: replacement.description }),
      expect.objectContaining({ name: "Read" }),
    ]);
  });

  it.each([
    { type: "tool_removal", tool: { type: "tool_reference", name: "missing" } },
    { type: "tool_addition", tool: { type: "tool_reference", name: "missing" } },
    {
      type: "tool_addition",
      tool: { type: "tool_definition", definition: { name: "Read" } },
    },
    { type: "tool_addition", tool: { type: "tool_reference", name: "Bash", unexpected: true } },
  ])("rejects unresolved or malformed tool updates: %j", (block) => {
    expect(() =>
      normalizeClaudeCodeRequest({
        ...request,
        messages: [...request.messages, { role: "system", content: [block] }],
      }),
    ).toThrow(InvalidAnthropicRequest);
  });

  it("rejects duplicate initial tool names instead of silently replacing them", () => {
    expect(() =>
      normalizeClaudeCodeRequest({ ...request, tools: [...request.tools, ...request.tools] }),
    ).toThrow("Tool names must be unique.");
  });

  it("keeps client ToolSearch callable while withholding deferred tool definitions", () => {
    const normalized = normalizeClaudeCodeRequest({
      ...request,
      tools: [
        ...request.tools,
        { name: "ToolSearch", input_schema: { type: "object" } },
        { name: "DeferredToolPlaceholder", input_schema: {}, defer_loading: true },
      ],
    });
    expect(normalized.upstream.tools).toEqual([
      expect.objectContaining({ name: "Bash" }),
      expect.objectContaining({ name: "ToolSearch" }),
    ]);
  });

  it("loads search results from deferred declarations and later inline definitions", () => {
    const normalized = normalizeClaudeCodeRequest({
      ...request,
      tools: [
        { name: "ToolSearch", input_schema: { type: "object" } },
        { name: "declared_lookup", input_schema: { type: "object" }, defer_loading: true },
        { name: "unused_lookup", input_schema: {}, defer_loading: true },
      ],
      messages: [
        ...request.messages,
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "search-1", name: "ToolSearch", input: { query: "lookup" } },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "search-1",
              content: [
                { type: "tool_reference", tool_name: "declared_lookup" },
                { type: "tool_reference", tool_name: "inline_lookup" },
              ],
            },
          ],
        },
        {
          role: "system",
          content: [
            {
              type: "tool_addition",
              tool: {
                type: "tool_definition",
                definition: {
                  name: "inline_lookup",
                  input_schema: { type: "object" },
                },
              },
            },
          ],
        },
      ],
    });
    expect(normalized.upstream.tools).toEqual([
      expect.objectContaining({ name: "ToolSearch" }),
      expect.objectContaining({ name: "declared_lookup" }),
      expect.objectContaining({ name: "inline_lookup" }),
    ]);
    expect(normalized.upstream.input).toContainEqual({
      type: "function_call_output",
      call_id: "search-1",
      output: "[Discovered tool: declared_lookup]\n[Discovered tool: inline_lookup]",
    });
  });

  it.each([
    { tools: [{ type: "tool_search_tool_regex_20251119", name: "tool_search_tool_regex" }] },
    {
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "synthetic",
              content: [{ type: "tool_search_tool_result", content: [] }],
            },
          ],
        },
      ],
    },
  ])("rejects tool search with explicit retry guidance: %j", (overrides) => {
    expect(() => normalizeClaudeCodeRequest({ ...request, ...overrides })).toThrow(
      AnthropicHttpError,
    );
    expect(() => normalizeClaudeCodeRequest({ ...request, ...overrides })).toThrow(
      "ENABLE_TOOL_SEARCH=false",
    );
  });

  it.each(["advisor_20260301", "web_search_20250305"])(
    "rejects hosted tool types using Claude capability wording: %s",
    (type) => {
      expect(() =>
        normalizeClaudeCodeRequest({ ...request, tools: [{ type, name: "hosted" }] }),
      ).toThrow(`Input tag '${type}' is not supported`);
    },
  );

  it.each([
    { model: "claude-sonnet-5" },
    { model: "codex/" },
    { future_field: true },
    { tools: [{ name: "Bash", input_schema: {}, defer_loading: "true" }] },
    { messages: [{ role: "user", content: [{ type: "tool_reference", tool_name: "Bash" }] }] },
    {
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "missing",
              content: [{ type: "tool_reference", tool_name: "missing" }],
            },
          ],
        },
      ],
    },
    { messages: [{ role: "user", content: [{ type: "unknown_content", text: "Keep me." }] }] },
    {
      messages: [
        { role: "assistant", content: [{ type: "compaction", content: { unexpected: "shape" } }] },
      ],
    },
    { messages: [{ role: "system", content: "Text", unsupported_context: true }] },
    { tools: [{ name: "Bash", input_schema: {}, future_tool_field: true }] },
  ])("rejects unknown fields and unsupported content instead of dropping them: %j", (overrides) => {
    expect(() => normalizeClaudeCodeRequest({ ...request, ...overrides })).toThrow(
      InvalidAnthropicRequest,
    );
  });
});
