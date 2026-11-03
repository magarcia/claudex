# Releases

No public release has been published yet. The repository is `magarcia/claudex`. Pushing commits or tags, running GitHub workflows, and publishing require explicit approval.

## Supported targets

| Archive                       | Native GitHub runner |
| ----------------------------- | -------------------- |
| `claudex-darwin-arm64.tar.gz` | `macos-15`           |
| `claudex-darwin-x64.tar.gz`   | `macos-15-intel`     |
| `claudex-linux-arm64.tar.gz`  | `ubuntu-24.04-arm`   |
| `claudex-linux-x64.tar.gz`    | `ubuntu-24.04`       |

Bun AOT compiles for the host. Each build runs on its target architecture. Linux builds use glibc on Ubuntu 24.04; musl Linux is not supported. Other Linux distributions and older macOS versions require their own checks. Windows binaries are not provided.

## Binary release prerequisites

Do not publish binaries until these checks are complete:

- Verify that all four versioned `@oven` compiler packages remain available and match the checksums in `scripts/setup-bun.sh`. The extracted executable must match `.bun-aot-version`.
- Verify redistribution requirements for the Bun AOT runtime, including bundled third-party components. The packaging script includes the project's `LICENSE` and the `licenses/` directory, including Valibot's MIT notice. Bun's static runtime requires applicable notices and a verified source/relinking distribution route, not just license copies. See [Bun's pinned licensing overview](https://github.com/oven-sh/bun/blob/3f3a9ff87cdccf3d32d7ec6b648c664eddaae840/LICENSE.md) and [JavaScriptCore's pinned GNU Library GPL v2, section 6](https://github.com/oven-sh/WebKit/blob/4d45755fed4aeef19e95beb90d3d0c884a2812bd/Source/JavaScriptCore/COPYING.LIB). These materials and the relinking route remain unverified for the release.
- Run CI and a nonpublishing release build on all four GitHub runners. Local macOS arm64 checks do not establish support for the other targets.

## Prepare and build

1. Enable Actions and private vulnerability reporting in the public repository. Artifact attestations require a supported GitHub plan; public repositories can use them.
2. Verify `.bun-version`, `.bun-aot-version`, the compiler's npm package version, and all four archive checksums in `scripts/setup-bun.sh`. Update these together when upgrading.
3. Update `package.json`, `bun.lock`, and `CHANGELOG.md`. Run CI on all four native targets.
4. Create and push an approved `vX.Y.Z` tag whose version matches `package.json`.
5. Manually run the Release workflow with that tag and `publish=false`. It checks, tests, builds, smoke-tests, and packages all four executables. It creates GitHub attestations for the archives and `SHA256SUMS`. Files remain workflow artifacts for seven days; there is no GitHub Release at this step.
6. Inspect the artifacts and provenance. After publication is approved, rerun the workflow for the same tag with `publish=true`. The publish job runs only after all four builds and checksums succeed. It refuses an existing release instead of overwriting files.

The release workflow is manual. Pushing a tag does not publish a release. Workflow actions use full commit SHA pins, with Dependabot updates enabled. No package registry, Homebrew tap, or repository is created by this workflow.

## Install after the first release

```sh
curl --proto '=https' --tlsv1.2 -fsSL https://raw.githubusercontent.com/magarcia/claudex/main/scripts/install.sh | sh
```

For a pinned version or custom directory, download and inspect the installer first:

```sh
curl --proto '=https' --tlsv1.2 -fsSL https://raw.githubusercontent.com/magarcia/claudex/main/scripts/install.sh -o install-claudex.sh
sh install-claudex.sh --version v0.1.0 --bin-dir "$HOME/.local/bin"
```

The installer needs `curl`, `tar`, `awk`, and `sha256sum` or `shasum`. It chooses the host architecture, verifies the archive checksum, and replaces the executable atomically. It does not use `sudo` or change shell configuration. Keep the destination on `PATH`. Run the same command to update. Existing sessions keep their running executable until restarted.

## Verify provenance

Download the release archive and manifest with GitHub CLI, then verify both before installing:

```sh
gh release download v0.1.0 --repo magarcia/claudex --pattern claudex-darwin-arm64.tar.gz --pattern SHA256SUMS
gh attestation verify SHA256SUMS --repo magarcia/claudex --signer-workflow magarcia/claudex/.github/workflows/release.yml
gh attestation verify claudex-darwin-arm64.tar.gz --repo magarcia/claudex --signer-workflow magarcia/claudex/.github/workflows/release.yml
shasum -a 256 claudex-darwin-arm64.tar.gz
```

Compare the last digest with that archive's line in the verified manifest. Select the archive for the actual host platform. The installer's checksum check alone does not verify provenance. See [GitHub's attestation verification guide](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations).

## Homebrew after the first release

The Homebrew tap is deferred until a real release has all four archives and final checksums. Then create `magarcia/homebrew-tap`, add a `claudex` formula with per-platform URLs and SHA-256 values from the verified release, set the MIT license, install `bin/claudex`, and test `claudex --version`. Run `brew audit` and installation checks before publishing the tap. No placeholder formula or fake checksum is shipped.
