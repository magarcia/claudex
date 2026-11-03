# Contributing

Contributions can include bug reports, tests, documentation, and focused fixes. Discuss new features, dependencies, protocol support, or large refactors in an issue before implementing them. Use the repository's issue tracker and pull requests once it is public. Start feature discussions with the [feature request template](.github/ISSUE_TEMPLATE/feature_request.yml). Never post credentials or real request payloads.

For vulnerabilities, follow [SECURITY.md](SECURITY.md) instead of opening a public issue.

## Development setup

Start from a local checkout. Install [Bun](https://bun.com/docs/installation) at the version pinned in `.bun-version`, then run these commands from the repository root:

```sh
bun install --frozen-lockfile
sh scripts/setup-bun.sh
export PATH="$HOME/.local/bin:$PATH"
bun run dev --help
```

Stable Bun `1.4.4` runs TypeScript, tests, formatting, and type checks. A separate `bun-canary` runs AOT builds and lint. Claude Code, Codex CLI, and real subscriptions are not needed for the automated tests. They are needed to use the launcher with real providers.

### Compiler setup

The AOT revision is pinned in `.bun-aot-version`. `scripts/setup-bun.sh` checks the download's checksum and revision, then installs it as `~/.local/bin/bun-canary`. It does not replace stable Bun or a different installed canary. Setup needs `curl`, `unzip`, and `shasum`.

The compiler download uses Bun's moving canary release. If that asset changes, setup fails the checksum check. When upgrading, update `.bun-aot-version` and all four checksums in `scripts/setup-bun.sh` together, then verify all CI platforms. Do not disable verification to make setup pass. If another canary is already installed, resolve the mismatch deliberately instead of overwriting it during setup.

### Run from source or build

```sh
bun run dev --help
bun run build
./dist/claudex --help
```

`bun run dev` runs TypeScript source. The normal launcher uses `dist/claudex`; rebuild it after source changes. Running the launcher without `--help` starts Claude Code and reads the live Codex catalog, so it is not an offline check.

The build uses [Bun's experimental AOT compiler](https://bun.com/docs/compiler/aot), not the JavaScript-bundle mode of `bun build --compile`. It builds for the host platform and embeds the package version and canary runtime. The executable runs from another directory without Bun, Node, `node_modules`, or a nearby `package.json`.

## Checks

Run the relevant test files while developing, then run the full checks before submitting:

```sh
bun check
bun run lint
bun run fmt:check
bun test --reporter=dot
bun run build
```

For a focused test run:

```sh
bun test test/server.test.ts --reporter=dot
```

Run `bun run fmt` to format changes. Use the package scripts for lint and formatting so the correct stable or canary tool runs.

Default tests use local HTTP stubs, synthetic tokens, temporary stores, and a fake Claude executable. They need no real accounts or installed provider CLIs. Binary tests compile an AOT executable, so `bun-canary` must be on `PATH`. Tests open loopback sockets. Installer tests replace network commands with local fixtures.

A real-client subagent routing test is not implemented yet. See the [verification limits](docs/subagents.md#verify-routing) before attempting one; Claude Code's bare mode disables subagents.

Binary tests cover detached help/version, usage errors, loopback HTTP serving, and signal shutdown. Integration tests cover routing, streaming, tool conversion, credential separation, launcher cleanup, and authentication storage. Real subscription checks are separate, optional local checks. Never add real-account calls to CI.

## Find the relevant code

| Path                                | Responsibility                                             |
| ----------------------------------- | ---------------------------------------------------------- |
| `src/cli.ts`                        | Command parsing and dispatch                               |
| `src/launcher.ts`                   | Claude process, temporary settings, environment, cleanup   |
| `src/server.ts`                     | Loopback request validation and provider routing           |
| `src/anthropic/`                    | Claude catalog discovery and Anthropic protocol adaptation |
| `src/codex/`                        | Codex credentials, catalog, and upstream requests          |
| `src/openai/`                       | Responses protocol types, model resolution, and streaming  |
| `test/` and `src/**/*.test.ts`      | Unit and integration tests                                 |
| `scripts/` and `.github/workflows/` | Compiler setup, installation, CI, and releases             |

Read [docs/design/](docs/design/) before changing request normalization, tool discovery, context windows, aliases, or authentication. [docs/releases.md](docs/releases.md) covers release steps, supported targets, and provenance checks.

## Report a bug

Use the [bug report template](.github/ISSUE_TEMPLATE/bug_report.yml). Include:

- What happened and what should have happened.
- A minimal reproduction using synthetic data.
- The operating system, architecture, Claudex version, and relevant Claude Code or Codex CLI versions.
- Relevant errors and a redacted `claudex doctor --json` result. The diagnostic checks local state only; it does not prove that inference works.

Never include access tokens, refresh tokens, auth files, private prompts, or real provider request bodies. Check any output before sharing it. Report suspected security problems privately using [SECURITY.md](SECURITY.md).

## Submit a pull request

Fill in the [pull request template](.github/pull_request_template.md) and complete its checklist. Include verification results, skipped checks, and compatibility or security effects.

1. Keep the change focused. Explain the behavior being fixed or added and link the related issue when one exists.
2. Add or update tests for observable behavior. Use local stubs and synthetic credentials.
3. Run the relevant tests and the checks above. Report which commands passed and any checks that could not run.
4. Update the README, command help, and changelog when user-visible behavior changes. Update design notes when protocol assumptions change.
5. Describe compatibility limits and security effects. Do not claim support for a platform or provider feature without verification.

## Code and protocol rules

- Keep native Claude forwarding transparent. Only the `codex/` namespace uses the Codex adapter.
- Validate provider data with Valibot at boundaries. Keep internal types strict.
- Preserve request ordering, cancellation, cleanup, and explicit capability errors. Do not silently drop unsupported user tools or conversation history.
- Keep credentials out of logs, errors, fixtures, and screenshots.
- Capture changed Claude Code request formats against a local stub with synthetic credentials, not a real account.
- Use plain English and tests that show behavior. Keep dependencies and abstractions limited to what the change needs.
