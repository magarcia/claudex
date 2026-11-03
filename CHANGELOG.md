# Changelog

## Unreleased

- Launch Claude Code with native Claude models and the newest GPT 6+ Luna, Terra, Sol, and Astra models from a Codex subscription.
- Keep Claude and Codex credentials separate. Use honest `claudex` client identity for Codex.
- Support text, images, client tools, tool search, structured output, and streamed responses on the Codex path.
- List native Claude and Codex coding model IDs with `claudex models` and `claudex models --json`.
- Report valid model IDs for unknown Codex lookup and inference requests.
- Size custom-model context from the catalog and offer `[1m]` variants when the model supports at least one million tokens.
- Preserve Claude's Opus, Sonnet, Haiku, and small-fast model environment overrides.
- Build native Bun AOT executables. Prepare four-platform CI, manual release builds, checksums, attestations, and a release installer.
