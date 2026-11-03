# Claude Code subscription passthrough and model selection

Checked 2026-11-01 against the live official docs below. Installed CLI: `~/.local/bin/claude`, `2.1.316 (Claude Code)`, verified with `--version` and `--help`. No credentials, keychain, or settings were read; no login, inference, or configuration change was performed. Docs are live references, not a versioned protocol guarantee.

## Keep native Claude subscription authentication

Set only `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>` to route inference through the local relay while keeping the saved subscription login active. Setting `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY`, or `apiKeyHelper` instead makes that credential replace subscription authentication. The gateway overview now documents this distinction explicitly. [Subscriptions and gateways](https://code.claude.com/docs/en/llm-gateway#subscriptions-and-gateways)

Claude Code owns its existing login and renewal. Provider credentials, explicit bearer/API keys, helper output, long-lived OAuth environment tokens, and selected Anthropic profiles can outrank the saved subscription login. A launcher should not silently introduce one of these or use `--bare`: installed help says bare mode never reads subscription OAuth/keychain. [Authentication precedence](https://code.claude.com/docs/en/authentication#authentication-precedence)

OAuth browser sign-in reaches `claude.com`/`claude.ai`; token exchange, refresh, and revocation reach `platform.claude.com`, including for subscription accounts. These remain CLI-owned connections; this inference relay need not implement OAuth grant or refresh endpoints. [Official network requirements](https://code.claude.com/docs/en/network-config#network-access-requirements)

## Native forwarding and discovery constraints

Forward subscription authorization, `anthropic-version`, and the entire `anthropic-beta` value unchanged. The latter contains required OAuth capability information; stripping it causes 401. Preserve Anthropic request fields as an open set and the system array unchanged. Serve `POST /v1/messages`, preserving query strings such as `?beta=true`; token counting is optional. A best-effort `HEAD /api/hello` probe can be rejected. Preserve streaming, errors, `retry-after`, `x-should-retry`, and `anthropic-ratelimit-unified-*`.

Gateway discovery is opt-in: `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1`. It requests `GET /v1/models?limit=1000`, defaults to 3 seconds, rejects redirects, and reads `data[].id/display_name/description`. Critically, it skips when no gateway API/helper credential resolves, and filters IDs unless they contain `claude` or `anthropic`. Therefore a union endpoint alone does not make ordinary Codex IDs selectable in a subscription-only session. [Protocol, forwarding, and discovery reference](https://code.claude.com/docs/en/llm-gateway-protocol)

## Add multiple Codex models without replacing Claude authentication

Use `modelPicker.options` through user settings, managed settings, or `claude --settings <file-or-json>`. It is ignored in repository project/local settings. Leave `replaceBuiltInOptions` false or omitted to retain the native Claude lineup. Each row takes a verbatim `model` plus optional `label`, `description`, and `behavesAs`. `availableModels` policy still filters it. This feature requires 2.1.242, so the installed CLI qualifies. [Model picker schema and scope](https://code.claude.com/docs/en/settings-reference#modelpicker)

Example launcher-generated overlay, with IDs replaced by actual IDs exposed by the new proxy:

```json
{
  "modelPicker": {
    "options": [
      { "model": "gpt-6-luna", "label": "Codex Luna" },
      { "model": "gpt-6-sol", "label": "Codex Sol" }
    ]
  }
}
```

Then launch `ANTHROPIC_BASE_URL=http://127.0.0.1:<port> claude --settings <overlay.json>`. This requires no edit to existing user settings and no extra Anthropic credential. Installed help verifies the `--settings <file-or-json>` syntax.

`ANTHROPIC_CUSTOM_MODEL_OPTION` adds only one extra entry; use `modelPicker` for several. Unknown IDs have assumed context/capability defaults, so do not label GPT models as a Claude family with `behavesAs` merely to enable features. An actual supported request verifies backend access; the picker is not an entitlement proof. [Custom option and unknown-model behavior](https://code.claude.com/docs/en/model-config#add-a-custom-model-option)

Anthropic explicitly does not support non-Claude models through gateways; format compatibility is technically distinct from product support. [Gateway support boundary](https://code.claude.com/docs/en/llm-gateway)

## Remaining implementation checks

- Keep the Anthropic OAuth bearer confined to the fixed native Anthropic upstream. Replace it with separate Codex credentials only on the Codex branch; never relay it to OpenAI.
- Native requests should retain their bytes/headers rather than pass through the gateway's stricter Codex translator.
- A non-Anthropic base URL disables Remote Control even when subscription login remains active. [Per-surface limitations](https://code.claude.com/docs/en/llm-gateway-connect#slack-cloud-sessions-and-remote-control)
- Validate custom model selection and tool/thinking compatibility against the local proxy. No interactive picker or authenticated traffic was tested in this read-only investigation.
