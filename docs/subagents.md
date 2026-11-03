# Subagent model selection

Claudex adds Codex models to Claude Code's model picker. It does not add values to the Agent tool's `model` field. That field accepts only `sonnet`, `opus`, `haiku`, or `fable`, not `luna` or `codex/gpt-6-luna`.

Choose an alias override for all work using that alias, or a custom agent for a specific task. Claudex does not remap subagents automatically. Run `claudex models` before pinning an ID; provider access and model restrictions still apply.

## Option 1: Override the Haiku alias

Opt in for one launch:

```sh
ANTHROPIC_DEFAULT_HAIKU_MODEL=codex/gpt-6-luna claudex
```

Then ask Claude to delegate with the Agent tool's `model` set to `haiku`. Claude Code resolves the alias to `codex/gpt-6-luna`; Claudex routes that ID to Codex. A native Claude parent can stay on its selected model.

This changes **all Haiku-selected work** in that process, including other subagents and background work that selects Haiku. It is not a per-agent override. Without the environment override, Haiku keeps its normal Claude behavior.

## Option 2: Define a custom agent

To opt in for a project, save this template as `.claude/agents/luna-reader.md`. For all projects, use `~/.claude/agents/luna-reader.md` instead. This guide does not install either file.

```markdown
---
name: luna-reader
description: Read a specified file and summarize its contents.
tools: Read
model: codex/gpt-6-luna
---

Read only the file named in the task. Return a short summary.
```

The definition's `model` accepts a full model ID, unlike the Agent call's `model` field. The agent has only the `Read` tool.

Ask Claude to use `luna-reader`. The Agent call selects the definition by its `name` through `subagent_type`, not by its file path:

```json
{
  "subagent_type": "luna-reader",
  "description": "Summarize the README",
  "prompt": "Read README.md and summarize the setup requirements."
}
```

Omit the per-call `model` override to use the definition's model. [`CLAUDE_CODE_SUBAGENT_MODEL_FORCE`](https://code.claude.com/docs/en/sub-agents#run-every-subagent-on-one-model) can override it, and [`availableModels` restrictions](https://code.claude.com/docs/en/model-config#restrict-model-selection) can block the selection.

## Discovery and data sharing

Claude Code watches existing `.claude/agents/` and `~/.claude/agents/` directories and detects file changes within a few seconds. Restart after creating a scope's first agent in a new `agents` directory. If the agent is still unrecognized, check its frontmatter name and scope, then restart. An `agent not found` error alone does not establish the cause. `/agents` is not a documented reload command.

Codex receives the delegated prompt and context, including file contents and tool results the subagent uses. An alias override can send other work there too. Confirm that the provider may receive that data. Separate credentials do not keep conversation content within one provider.

## Verify routing

Inspect the outgoing request's `body.model` and the proxy's selected provider route. Asking a model its identity, or checking an echoed response model, does not prove which provider received the request.

A real-client subagent routing test is not implemented yet. Claude Code's [`--bare` mode](https://code.claude.com/docs/en/env-vars) disables subagents, so it cannot exercise this path. A local synthetic probe confirmed that `--bare --tools Agent` exposes no Agent tool.

Testing delegation requires non-bare mode and a separate credential-isolation approach. A temporary home directory, fresh configuration, and dummy API key do not by themselves guarantee that the process cannot access the system keychain. Existing alias captures in [context and alias behavior](design/context-and-aliases.md) verify top-level requests, not subagent delegation.

## References

- [Claude Code subagent model selection](https://code.claude.com/docs/en/sub-agents#choose-a-model)
- [Custom agent files and discovery](https://code.claude.com/docs/en/sub-agents#write-subagent-files)
- [Claude Code model alias controls](https://code.claude.com/docs/en/model-config#control-the-model-users-run-on)
- [Captured context and alias behavior](design/context-and-aliases.md)
