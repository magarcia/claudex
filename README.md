# claudex

Use Claude and Codex subscription models in the same Claude Code session.

Claudex starts a local proxy and opens Claude Code with extra GPT models in its model picker. Native Claude models keep their normal Anthropic protocol and subscription sign-in. Only models with a `codex/` prefix use the Codex adapter and separate Codex credentials. Tools still run in Claude Code.

```text
Claude Code -> local proxy on 127.0.0.1
               |-- Claude model -> Anthropic, original Claude credentials
               `-- codex/model  -> Codex backend, separate Codex subscription
```

Requests go directly from this computer to the selected provider. No hosted gateway, Docker, or background service is needed.

**Status:** No public release is available yet. Build from a local checkout using the steps below. The intended public repository is `magarcia/claudex`.

[Quick start](#quick-start) · [Commands](#commands) · [Configuration](#configuration) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md)

## Requirements

- macOS or glibc Linux on arm64 or x64. Live checks have run on macOS arm64 only. Windows and musl Linux are not supported.
- [Claude Code](https://code.claude.com/docs/en/overview) installed as `claude` on `PATH`, signed in through its normal subscription login.
- [Codex CLI](https://developers.openai.com/codex/cli) installed as `codex` on `PATH`, with a subscription that supports the requested models.
- [Bun 1.4.4](https://bun.com/docs/installation) to build from source. The compiled executable does not need Bun, Node, or `node_modules`. Claude Code and Codex CLI remain external requirements.

This is an independent project, not affiliated with Anthropic or OpenAI. Review the providers' current terms and your account permissions before use. Model access and subscription limits are controlled by each provider.

## Quick start

### 1. Build and install

Run these commands from the repository root of a local checkout:

```sh
bun install --frozen-lockfile
sh scripts/setup-bun.sh
export PATH="$HOME/.local/bin:$PATH"
bun run build
install -m 755 dist/claudex "$HOME/.local/bin/claudex"
claudex --version
```

The setup script installs a separate, checksum-verified `bun-canary` compiler in `~/.local/bin`. It leaves stable Bun unchanged. If setup reports a checksum or revision mismatch, stop and see [compiler setup](CONTRIBUTING.md#compiler-setup). Do not disable verification.

Keep `~/.local/bin` on `PATH` in new shells. Rebuild and repeat the `install` command after source changes. After the first release, the [binary installer](docs/releases.md#install-after-the-first-release) will avoid the local build. Homebrew is not available yet.

### 2. Sign in and check setup

Keep Claude Code signed in normally. Create a separate Codex session for Claudex:

```sh
claudex login
claudex doctor
```

`login` opens the installed Codex CLI with a dedicated credential store. `doctor` checks local tool versions and Codex sign-in status. It does not test network access or send inference requests.

### 3. Start Claude Code

```sh
claudex
```

Run `/model` in Claude Code. Its normal Claude options remain, followed by the newest Luna, Terra, Sol, and Astra releases available to the Codex account. A catalog entry does not guarantee that every operation is available to the account.

Press `s` in the model picker to select a model for the current session only. Enter or `/model <id>` saves it as Claude Code's default, including for sessions started without Claudex.

Switching providers sends the conversation history, including prompts and tool results, to the selected provider. The Codex adapter translates that history to its protocol. Provider credentials stay separate; conversation content does not. Check that the selected provider may receive that content before switching.

Claude arguments and prompts pass through to the first `claude` executable on `PATH`:

```sh
claudex --model codex/gpt-6-luna
claudex --model codex/gpt-6-luna -p 'Say hello.'
```

Run `claudex models` to get current model IDs before pinning one. A newer catalog release can replace an older family version.

## Commands

| Command                         | Purpose                                                                    |
| ------------------------------- | -------------------------------------------------------------------------- |
| `claudex [Claude arguments...]` | Open Claude Code with an ephemeral local proxy; stop it when Claude exits. |
| `claudex login`                 | Sign in to a dedicated Codex subscription session.                         |
| `claudex doctor [--json]`       | Check local tools and Codex sign-in status without inference.              |
| `claudex models [--json]`       | List native Claude models and supported Codex coding models.               |
| `claudex serve [--port 8788]`   | Run the proxy on `127.0.0.1`; print its URL to stdout.                     |
| `claudex --help`                | Show usage without starting the proxy.                                     |
| `claudex --version`             | Print the installed version.                                               |

Status messages and errors go to stderr. Exit codes are `0` for success, `1` for a runtime or diagnostic failure, `2` for invalid arguments, `130` for SIGINT, and `143` for SIGTERM. The launcher preserves other Claude exit codes.

`models` reads Claude Code's SDK initialization metadata and the live Codex catalog. It sends no prompt or inference request and runs no tools or hooks. Plain output has one ID per line. JSON output is an array with `id`, `display_name`, and `description`; Codex entries also have `type` and `created_at`. A provider failure returns no partial catalog and exits with code `1`.

## Configuration

No config file is needed. The launcher uses a private temporary settings file to add `codex/` picker rows. Existing user and project settings still load. It does not edit `~/.claude/settings.json` or install a shell alias.

- Existing `--settings` arguments are rejected rather than silently replaced or partly merged.
- Provider overrides such as `CLAUDE_CODE_USE_BEDROCK=1` are rejected because they bypass the local proxy.
- Inherited `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` are removed from the child environment so they cannot replace subscription sign-in. The parent shell is unchanged. Existing authentication helpers in Claude settings can still affect sign-in.
- `claude --bare` disables Claude's OAuth discovery. It is for isolated protocol tests, not normal subscription use.

<details>
<summary>Credentials and sign-in behavior</summary>

Claude Code owns Claude sign-in and renewal. Claudex forwards its original authorization to Anthropic in memory and does not read Claude's credential store.

`claudex login` uses file-backed credentials under `$XDG_DATA_HOME/claudex/codex`, or `~/.local/share/claudex/codex` when `XDG_DATA_HOME` is unset. Managed refreshes serialize access and save rotated credentials atomically with private permissions.

Before a dedicated login exists, an unexpired access token from `CODEX_HOME`, or `~/.codex`, can be used as a read-only fallback. Claudex never refreshes that grant, copies its refresh token, or writes to that store. Run `claudex login` when the shared access token expires.

Claude credentials never reach Codex. Codex credentials never reach Anthropic or the downstream client. This project uses subscription authentication, not OpenAI Platform API keys.

</details>

<details>
<summary>Model selection, context windows, and Claude aliases</summary>

The picker and `/v1/models` show only the newest GPT 6+ release in each of the Luna, Terra, Sol, and Astra families. Versions compare numerically: `gpt-6.10-sol` replaces `gpt-6.9-sol`, and `gpt-7-sol` replaces both. Other families, GPT 5 models, and plain IDs such as `gpt-7` are excluded. Each family keeps its short task description across versions. The catalog refreshes on each launch.

Claude Code's gateway discovery filters plain GPT IDs. Additive `modelPicker.options` rows make `codex/` models visible without replacing built-in Claude choices. Native aliases resolve to full `claude-` IDs, with duplicate IDs removed. These are Claude Code's advertised models, not Anthropic's complete historical catalog. Unknown Codex lookup and inference requests return HTTP `404` with the valid Codex IDs.

Claude Code assumes 200K tokens for unknown custom IDs. The launcher sets `CLAUDE_CODE_MAX_CONTEXT_TOKENS` to the smallest context window among the selected Codex models. A missing catalog window counts as 200K. The tested catalog reports 272K for Luna and Astra and 500K for Sol and Terra, giving a shared limit of 272K. Recognized native Claude windows keep Claude Code's normal behavior.

An explicit `CLAUDE_CODE_MAX_CONTEXT_TOKENS` is preserved. Set a larger model's actual limit only for a session that stays on that model:

```sh
CLAUDE_CODE_MAX_CONTEXT_TOKENS=500000 claudex --model codex/gpt-6.1-sol
```

Switching to a smaller model with that override can exceed its limit. Claude's context and compaction settings still apply. A separate `codex/<id>[1m]` picker row appears only when the catalog reports at least 1,000,000 tokens. Claude Code strips that suffix and adds a context beta header; the adapter also strips it for direct HTTP clients. The tested catalog has no qualifying 1M model.

The launcher preserves `ANTHROPIC_DEFAULT_OPUS_MODEL`, `ANTHROPIC_DEFAULT_SONNET_MODEL`, `ANTHROPIC_DEFAULT_HAIKU_MODEL`, and `ANTHROPIC_SMALL_FAST_MODEL`. Claude Code resolves aliases; the proxy routes the resulting `codex/` ID:

```sh
ANTHROPIC_DEFAULT_OPUS_MODEL=codex/gpt-6-astra \
ANTHROPIC_DEFAULT_SONNET_MODEL=codex/gpt-6.1-sol \
ANTHROPIC_DEFAULT_HAIKU_MODEL=codex/gpt-6-luna \
ANTHROPIC_SMALL_FAST_MODEL=codex/gpt-6-luna \
claudex
```

Set only aliases that should use Codex. Overrides affect background and subagent choices too. Without them, native aliases keep their normal Claude behavior.

See [subagent model selection](docs/subagents.md) for alias overrides, custom agents, and routing checks. See [Claude Code's context configuration](https://code.claude.com/docs/en/model-config#correct-the-window-for-a-gateway-or-custom-model-id) and [captured context and alias behavior](docs/design/context-and-aliases.md).

</details>

## Compatibility and limits

| Component   | Tested version             | Coverage                                                                      |
| ----------- | -------------------------- | ----------------------------------------------------------------------------- |
| Claude Code | `2.1.316`                  | Subscription forwarding, model picker, tools, aliases, context request format |
| Codex CLI   | `0.166.0`                  | Dedicated login, shared read-only credentials, live catalog and inference     |
| Bun stable  | `1.4.4`                    | Source runtime, tests, type checks, formatting                                |
| Bun canary  | `1.4.4-canary.1+3f3a9ff87` | Native AOT builds and lint                                                    |

Live checks ran locally on macOS arm64. Four-platform CI and release workflows are prepared but have not run on GitHub yet. Provider catalogs and protocols can change. Linux release builds target Ubuntu 24.04 glibc; other distributions and older macOS versions need their own checks. See [release targets](docs/releases.md#supported-targets).

The Codex adapter supports text, images, ordinary client tools, tool results, structured JSON output, and effort controls. It does not make Anthropic-only features native Codex features. Switching models can expose incompatible history or capabilities; unsupported requests return explicit errors.

<details>
<summary>Protocol behavior and unsupported features</summary>

Native Claude traffic keeps its original request bytes, query parameters, authorization, beta headers, errors, usage headers, and streamed events. Codex traffic uses an Anthropic-to-Responses adapter and returns Anthropic messages or named SSE events through `message_stop`.

Claude-only thinking and context-management fields are adapted on the Codex branch. Previous visible thinking can become assistant text. Signed and redacted thinking metadata is not represented as native Claude thinking.

System-history tool additions, replacements, removals, and re-additions determine the tools available for the next Codex response. Inline custom definitions become Codex functions. System instructions and historical tool calls and results stay in the conversation. See [Anthropic's mid-conversation tool changes](https://platform.claude.com/docs/en/build-with-claude/mid-conversation-system-messages).

Claude Code's client-side `ToolSearch` remains callable. Deferred definitions stay out of the Codex request until discovered. Search-result references become text acknowledgments, and their matching declarations or inline definitions become callable functions. Search and tool execution stay in Claude Code.

Anthropic prompt caching, exact token counting, hosted server tools and hosted tool search, signed thinking, and provider context-editing semantics are not native Codex features. Hosted tool search receives explicit capability errors. Token counting returns an unsupported response, so Claude Code uses estimates. Some sampling and output-length fields are accepted only as compatibility input and do not enforce generation limits. Unsupported history must not silently drop actual user tools.

Codex requests send `originator: claudex` and `User-Agent: claudex/0.1.0`. The catalog compatibility query uses `client_version=0.166.0`. Protocol research and captured behavior live in [docs/design/](docs/design/).

</details>

## Security

The proxy binds only `127.0.0.1` and rejects foreign Host values, browser Origin headers, CONNECT, upgrades, and absolute request targets. Provider destinations are fixed. There is no remote-host flag or shared-token authentication.

Other processes on this computer can use the open port. Use Claudex as a personal local tool, not a shared service. Request bodies and credentials are not logged. Bodies inspected for routing and model catalogs have size limits. Native forwarded uploads stream without that routing-body limit, and upstream SSE buffering has no per-event size limit.

Temporary picker settings use a private directory and a `0600` file. Normal exit and handled signals remove them; an uncatchable kill can leave model names, but no credentials, in the file.

See [SECURITY.md](SECURITY.md) for credential boundaries, release verification, and private vulnerability reporting.

## Contributing

Bug reports, tests, documentation, and focused fixes are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md) for setup, checks, issue reports, and pull request guidance. Review [design notes](docs/design/) before changing protocol behavior. Release preparation and provenance checks are in [docs/releases.md](docs/releases.md).

### Related project

[raine/claude-code-proxy](https://github.com/raine/claude-code-proxy) focuses on replacing Claude's backend with another provider. Claudex keeps native Claude and Codex available in the same session and routes only the `codex/` namespace through its adapter.

## License

[MIT](LICENSE).
