# Claude Code with a local native-Claude and Codex proxy

Checked 2026-11-01. Installed Claude Code: `2.1.316`, native arm64 executable at `~/.local/bin/claude`. No real credentials were read. No inference request left the local stub. No repository or user Claude settings were changed.

## Captured custom-model request

The temporary harness `/private/tmp/claude-codex-wire-check.mjs` starts an HTTP stub bound to `127.0.0.1` and launches:

```text
claude --bare --no-session-persistence --model codex/gpt-6-luna --system-prompt 'Local request-format test.' -p 'Say OK.'
```

The child receives a fresh temporary `CLAUDE_CONFIG_DIR`, a dummy `ANTHROPIC_API_KEY`, and a loopback `ANTHROPIC_BASE_URL`. Nonessential traffic and updates are disabled. `--bare` explicitly avoids OAuth and keychain reads. The stub returns a synthetic Anthropic SSE response. The CLI exits 0 and prints `OK`.

The actual request is `POST /v1/messages?beta=true`, not a query-free URL. Top-level keys are `model`, `messages`, `system`, `tools`, `metadata`, `max_tokens`, `thinking`, `context_management`, `output_config`, and `stream`. The relevant values are:

```json
{
  "model": "codex/gpt-6-luna",
  "max_tokens": 32000,
  "thinking": { "type": "adaptive", "display": "omitted" },
  "context_management": {
    "edits": [{ "type": "clear_thinking_20251015", "keep": "all" }]
  },
  "output_config": { "effort": "high" },
  "stream": true
}
```

The default `--bare` toolset contains `Bash`, `Edit`, and `Read`. Every tool has only `name`, `description`, and `input_schema`. A separate run restricted to `--tools Bash` produced the same request controls. The synthetic capture, with authorization headers omitted, is `/private/tmp/claude-codex-wire-capture.json`. It contains no real credentials. The initial sandbox bind failed with `EPERM`; the successful capture ran with localhost network permission.

The beta header includes `claude-code-20250219`, `interleaved-thinking-2025-05-14`, `context-management-2025-06-27`, `thinking-token-count-2026-05-13`, and `effort-2025-11-24`. The request also contains `anthropic-version: 2023-06-01` and `x-app: cli`. This observed beta list is a fixture, not a permanent allowlist.

## Existing gateway codec gaps

The following facts come from the local `codex-gateway` source, not a deployment probe. The direct local Codex design can reuse the behavior rather than depending on this hosted gateway.

| Feature                                               | Existing behavior                                                                                                                        | Required local Codex handling                                                                                                                                                                                                         |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ordinary text, images, tools, tool results, streaming | `src/anthropic/request.ts` converts these to Responses. `response.ts` translates tool calls and text back to Anthropic events.           | Preserve the normal client tool loop and tool IDs. Execute tools in Claude Code, not the proxy.                                                                                                                                       |
| `thinking` config                                     | Only `{type:"disabled"}` accepted. Adaptive/enabled is rejected before schema parsing.                                                   | Remove Claude-only config on the Codex branch. Map explicit effort to Codex reasoning separately. Do not synthesize signed Claude thinking.                                                                                           |
| Thinking history                                      | Neither `thinking` nor `redacted_thinking` content blocks is accepted.                                                                   | Filter these blocks for Codex calls, including after switching from Claude to Codex. Preserve the original request on native Claude calls.                                                                                            |
| Mid-conversation system entries                       | Messages schema allows only user and assistant roles. Message-level `cache_control` and per-message `output_config` are also rejected.   | Preserve instruction order when converting system entries. Resolve per-turn effort deliberately. Drop cache metadata only in the Codex branch.                                                                                        |
| `context_management`                                  | Top-level strict schema rejects it. The captured default request contains it.                                                            | Consume the observed `clear_thinking` edit locally or omit it when thinking history is already removed. Reject unsupported semantics rather than claiming native context editing.                                                     |
| MCP tool search                                       | Strict tool definitions reject `defer_loading`; content schema rejects `tool_reference`, server search blocks, and search-result blocks. | Either materialize all ordinary tool definitions and handle history references, or use a documented capability rejection that lets Claude retry with tools loaded upfront. An adapter that drops deferred tools entirely loses tools. |
| `output_config.effort`                                | Already maps to Responses `reasoning.effort`.                                                                                            | Keep this conversion. Model suffix effort can remain a second input.                                                                                                                                                                  |
| `output_config.format`                                | JSON schema translation exists. `task_budget` is rejected.                                                                               | Preserve format where supported. Do not claim enforcement of Anthropic task budgets.                                                                                                                                                  |
| `cache_control`                                       | Recognized on common blocks/tools but intentionally ignored.                                                                             | No Anthropic cache accounting claims for Codex. Native Claude branch preserves cache markers exactly.                                                                                                                                 |
| Token count                                           | `/messages/count_tokens` returns 501.                                                                                                    | Exact Codex token counting is not required for a working client. Return an explicit unsupported response and retain client estimates.                                                                                                 |
| Compaction                                            | No dedicated native compaction endpoint.                                                                                                 | Claude Code compaction can use ordinary message requests. Do not treat native compaction/edit blocks as plain user text without an explicit policy.                                                                                   |

## Official protocol constraints

The current [gateway compatibility guide](https://code.claude.com/docs/en/llm-gateway-protocol) confirms that native Anthropic forwarding must preserve body fields and `anthropic-*` headers, including OAuth's beta header. Preserve upstream errors, retry hints, usage-limit headers, and the complete SSE event sequence. Token counting is optional; Claude Code estimates when unavailable. Compaction summary calls use ordinary inference traffic with an optional routing hint. Mid-conversation system messages are part of the current protocol.

Tool search sends every definition even when deferred. A native backend expands `tool_reference` blocks; a Codex adapter must load the definitions itself or trigger the client fallback. [Anthropic tool-search contract](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool).

`CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1` does not remove adaptive thinking, effort, or mid-conversation system messages. `CLAUDE_CODE_DISABLE_THINKING=1` omits thinking entirely. Applying either globally changes native Claude behavior, so a mixed proxy should normally adapt only Codex-routed requests. [Environment reference](https://code.claude.com/docs/en/env-vars).

## Picker configuration

Automatic model discovery keeps only IDs containing `claude` or `anthropic`. Plain `codex/gpt-6-luna` is filtered out, despite being accepted by `--model`. Do not rely on `/v1/models` alone for Codex entries. [Discovery response filtering](https://code.claude.com/docs/en/llm-gateway-protocol#request-and-response).

Use a launcher-owned `--settings` value with an additive picker. `modelPicker` works in `--settings`, user, and managed settings; project/local settings ignore it. Omit `replaceBuiltInOptions`, or leave it false, to preserve normal Claude rows. [Settings reference](https://code.claude.com/docs/en/settings-reference#modelpicker).

```json
{
  "modelPicker": {
    "replaceBuiltInOptions": false,
    "options": [
      { "model": "codex/gpt-6-luna", "label": "Luna (Codex subscription)" },
      { "model": "codex/gpt-6-sol", "label": "Sol (Codex subscription)" }
    ]
  }
}
```

For one entry, `ANTHROPIC_CUSTOM_MODEL_OPTION`, `_NAME`, and `_DESCRIPTION` provide a smaller alternative. Avoid replacing Opus/Sonnet/Haiku defaults, which would silently route native selections to Codex. [Custom option](https://code.claude.com/docs/en/model-config#add-a-custom-model-option).

The CLI warns that the custom Codex ID has an assumed 200K context window. Do not advertise a larger window unless actual model metadata establishes it. The catalog-backed shared override and its effect on recognized native Claude models are checked in [context-and-aliases.md](context-and-aliases.md). [Model and context configuration](https://code.claude.com/docs/en/model-config#correct-the-window-for-a-gateway-or-custom-model-id).

## Smallest truthful architecture

Route only explicit `codex/` model IDs to the Codex subscription transport. Strip that routing prefix before inference and preserve it in the client-facing response model. Keep the Codex credential independent from incoming Anthropic authorization. For every native Claude selection, forward the original bytes, path/query, headers, errors, and streaming response through to Anthropic. Do not parse and rebuild that branch's JSON or install global compatibility downgrades.

For Codex, translate the observed thinking/context controls, regular message history, ordinary tools, images, and effort. Add a complete Anthropic SSE translator, cancellation, and periodic SSE pings while Codex is silent. Keep unsupported hosted tools and newer history block types explicit rather than dropping them silently. The capture proves the basic custom-model request/response exchange; it does not test live subscription auth, actual Codex tool calls, MCP search history, compaction, or interactive picker rendering.

## Interactive system history and client tool search

The real interactive request after `/model codex/gpt-6.1-sol` contained system text mixed with eight `tool_addition` blocks. Each addition wrapped an ordinary custom definition in `{type:"tool_definition",definition:{name,description,input_schema}}`. Accepting only text caused `Malformed system history message.` Inline definitions now join the callable tool list. Replacement, removal, and re-addition apply in history order. [Inline tool contract](https://platform.claude.com/docs/en/build-with-claude/mid-conversation-system-messages).

Claude Code's `ToolSearch` is an ordinary client tool. Rejecting it triggered a fallback that loaded 1,384 tools. The Codex backend then returned `response.incomplete`, reason `max_output_tokens`, with zero input/output tokens and no output items. Claude's displayed 32,000-token limit was the requested limit, not measured generation. Increasing it did not follow from that evidence.

A separate isolated Claude Code capture used dummy authorization, a localhost model stub, and one synthetic MCP server. Its search follow-up put the selected definition in top-level `tools` with `defer_loading:true`, and returned `{type:"tool_reference",tool_name:"..."}` inside an ordinary `tool_result`. The adapter keeps client search callable, withholds deferred definitions, and enables those referenced by search. It also handles definitions introduced by later inline additions. [Custom client search contract](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool#custom-tool-search-implementation).

Local replay of the original request now produces 22 callable functions and retains ToolSearch. The isolated search follow-up produces three: Read, ToolSearch, and the selected synthetic MCP tool. Real interactive Sol checks completed `/model`, cancelled `/effort`, read a synthetic marker file, and returned `INLINE_TOOL_OK`: first with only Read and an empty session-scoped MCP config, then with the normal MCP configuration after explicit approval. The latter completed in five seconds. No MCP tools were executed, and no saved MCP settings were changed. All 198 project tests passed.
