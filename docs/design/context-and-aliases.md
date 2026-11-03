# Context windows and alias resolution

Checked 2026-11-01 with Claude Code `2.1.316`. An isolated local HTTP stub returned synthetic Anthropic SSE. Claude ran with a fresh configuration directory, dummy credentials, no tools, and no session persistence. No inference request left the local stub. No user settings changed.

## Observed requests

| Selected model                                | HTTP `body.model`   | Context beta header     | Reported window |
| --------------------------------------------- | ------------------- | ----------------------- | --------------- |
| `codex/gpt-6-astra`                           | `codex/gpt-6-astra` | Absent                  | 200,000         |
| `codex/gpt-6-astra[1m]`                       | `codex/gpt-6-astra` | `context-1m-2025-08-07` | 1,000,000       |
| `opus`, with its alias set to the suffixed ID | `codex/gpt-6-astra` | `context-1m-2025-08-07` | 1,000,000       |
| `sonnet`, mapped to Sol                       | `codex/gpt-6.1-sol` | Absent                  | 200,000         |
| `haiku`, mapped to Luna                       | `codex/gpt-6-luna`  | Absent                  | 200,000         |

All requests completed with the synthetic marker. The other Claude beta headers stayed present. Claude's JSON result reported the selected suffixed model as its model-usage key, even though the outgoing model ID was unsuffixed.

## Catalog limits

A separate authenticated catalog check returned 500,000 tokens for Sol and Terra, and 272,000 for Astra and Luna. It sent no inference prompt. These values do not justify a 1M picker variant. The live catalog owns the limit; family names do not imply one.

Claude exposes a shared environment override for custom model windows. The launcher derives it from the smallest selected catalog window, treating missing metadata as 200K. Existing explicit values remain untouched. This permits safe switching between the offered Codex models. A 1M suffix bypasses that shared sizing in Claude, so the picker and direct-model lookup admit it only for a catalog window of at least 1M.

A second local capture set `CLAUDE_CODE_MAX_CONTEXT_TOKENS=272000`. The custom Astra ID then reported a 272,000-token window. The recognized `claude-sonnet-5-5` ID kept its 1,000,000-token window. Both returned the marker through the local stub.

The adapter also removes a trailing `[1m]` from direct HTTP input. Only the Codex path does this. Native Claude request bytes and beta headers remain unchanged.

## Aliases

The isolated client resolved Opus, Sonnet, and Haiku environment overrides to the expected Codex IDs. Launcher tests execute a fake Claude child and assert all four environment variables survive unchanged, including `ANTHROPIC_SMALL_FAST_MODEL`. The small-fast variable selects background work rather than a public `/model` alias; no separate background inference was triggered by this probe.

## Sources

- [Claude Code model and context configuration](https://code.claude.com/docs/en/model-config)
- [Model picker schema](https://code.claude.com/docs/en/settings-reference#modelpicker)
