# Security

## Report a vulnerability

After the repository is public, use [GitHub private vulnerability reporting](https://github.com/magarcia/claudex/security/advisories/new). The maintainer must enable this feature before publication. Avoid public issues for credential leaks. Include the affected version, a minimal synthetic example, and the impact. Never include access tokens, refresh tokens, real request bodies, or auth files.

Security fixes target the latest release. There is no response-time guarantee.

## Credentials

Claude Code owns Claude sign-in and renewal. The proxy forwards native authorization to Anthropic in memory. It does not save Claude tokens. Incoming Claude credentials never reach Codex. Codex credentials never reach Anthropic or the downstream client.

Codex uses a separate store under `$XDG_DATA_HOME/claudex/codex`, or `~/.local/share/claudex/codex`. Credential writes use mode `0600` and atomic replacement. Managed refreshes use a process lock. The existing `CODEX_HOME` or `~/.codex` store is a read-only fallback for unexpired access tokens. Its refresh token is never copied, exchanged, or written back.

Request bodies and credentials are not logged. Reports and diagnostics must keep that rule. Local files and memory remain accessible to processes with the same operating-system permissions.

## Local server

The proxy binds `127.0.0.1`. It rejects browser Origin headers, foreign Host values, absolute request targets, CONNECT, and upgrades. There is no remote mode or shared-token authentication. Other local processes can use the port while it is open. Loopback binding does not protect against malicious software on the same computer.

Provider destinations are fixed in the CLI. Redirects cannot move Codex authorization to another origin. Native redirects are returned to the client. Routing request bodies and model catalogs have size limits and deadlines.

## Temporary settings

The launcher creates a private `0700` directory and a `0600` settings file. The file contains model picker rows, never credentials. Normal exit and handled signals remove both. An uncatchable kill can leave the directory behind.

## Release downloads

The installer checks the archive against the release's SHA-256 manifest before extracting it. Installation uses a temporary file and atomic replacement. Downloaded checksums detect corruption; GitHub artifact attestations provide a separate provenance check. The installer does not verify attestations automatically. See [release verification](docs/releases.md).
