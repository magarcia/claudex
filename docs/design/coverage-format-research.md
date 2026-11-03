# Bun and Fallow coverage formats

Checked 2026-11-02. Local Bun is `1.4.4`; the cached native Fallow binary is `3.38.1`. These are also the latest official stable releases checked on this date. This note describes tool capabilities, not an integration implementation. [Bun release](https://github.com/oven-sh/bun/releases/tag/bun-v1.4.4), [Fallow release](https://github.com/fallow-rs/fallow/releases/tag/v3.38.1), [Fallow npm metadata](https://registry.npmjs.org/fallow/latest)

## Direct answers

- **Bun cannot directly emit Istanbul `coverage-final.json`.** Its built-in coverage reporters are `text` and `lcov`. The `1.4.4` CLI rejects other values. `json` and `json-summary` are requests, not released features. [Versioned CLI parser](https://github.com/oven-sh/bun/blob/bun-v1.4.4/src/runtime/cli/Arguments.rs#L1752-L1774), [official coverage docs](https://bun.com/docs/test/code-coverage), [JSON reporter request](https://github.com/oven-sh/bun/issues/47168)
- **Fallow cannot directly read LCOV.** In `3.38.1`, `health --coverage` accepts Istanbul coverage-map JSON or raw V8 coverage JSON. Its format detector checks for V8; every other file goes to the Istanbul JSON parser. There is no LCOV sniffing or parser branch. [Versioned loader](https://github.com/fallow-rs/fallow/blob/v3.38.1/crates/engine/src/health/scoring.rs#L1680-L1773), [JSON parsing](https://github.com/fallow-rs/fallow/blob/v3.38.1/crates/engine/src/health/scoring.rs#L1862-L1876), [official CLI reference](https://fallow.tools/docs/cli/health/)
- **Upgrading currently does not resolve the mismatch.** The latest releases match these versions. The checked development snapshots still have only the same Bun reporters and Fallow input formats. Development code is not a released guarantee. [Bun development parser at `271b65ec608a50eca96a894c6bbff1e65849d920`](https://github.com/oven-sh/bun/blob/271b65ec608a50eca96a894c6bbff1e65849d920/src/runtime/cli/Arguments.rs#L2186-L2198), [Fallow development loader at `a550c19d705a143ab0aae27ab318022fefd99b6d`](https://github.com/fallow-rs/fallow/blob/a550c19d705a143ab0aae27ab318022fefd99b6d/crates/engine/src/health/scoring.rs#L1680-L1773)

## What Bun LCOV contains

The `1.4.4` LCOV writer emits these records:

| Records          | Meaning                                     |
| ---------------- | ------------------------------------------- |
| `TN`, `SF`       | Test name and source path                   |
| `FNF`, `FNH`     | Aggregate functions found and functions hit |
| `DA`, `LF`, `LH` | Executable-line hit counts and line totals  |
| `end_of_record`  | File terminator                             |

It does **not** emit `FN` or `FNDA`, so the report has no function names, source ranges, or individual function hit counts. It also does not emit branch records `BRDA`, `BRF`, or `BRH`. The source explicitly identifies these limitations. This describes Bun's emitted subset, not limits of the LCOV format itself. [Complete versioned LCOV writer](https://github.com/oven-sh/bun/blob/bun-v1.4.4/src/sourcemap_jsc/CodeCoverage.rs#L472-L538)

Bun's native coverage collector uses JavaScriptCore's control-flow profiler and function execution cache. This is not V8 coverage. The Node-compatible `node:v8` methods `takeCoverage()` and `stopCoverage()` are unimplemented in `1.4.4`; neither the documented reporters nor their CLI parser exposes a raw V8 export. Setting `NODE_V8_COVERAGE` is therefore not a supported route to Fallow-compatible output from `bun test`. [JavaScriptCore collector](https://github.com/oven-sh/bun/blob/bun-v1.4.4/src/jsc/bindings/CodeCoverage.cpp#L1-L46), [unimplemented V8 APIs](https://github.com/oven-sh/bun/blob/bun-v1.4.4/src/js/node/v8.ts#L316-L321), [reporter options](https://github.com/oven-sh/bun/blob/bun-v1.4.4/src/options_types/code_coverage_options.rs)

Branch reporting has a proposed implementation in Bun PR `#46534`. It was open and unmerged when checked. Its proposed `BRDA` output must not be described as supported in `1.4.4`, and the proposal does not add Istanbul JSON reporting. [Branch coverage PR](https://github.com/oven-sh/bun/pull/46534), [separate JSON reporter request](https://github.com/oven-sh/bun/issues/47168)

## What Fallow needs

`fallow health --coverage <PATH>` accepts:

- An Istanbul coverage-map JSON file, usually `coverage-final.json`.
- A directory containing `coverage-final.json`.
- A raw V8 coverage JSON file.
- A directory containing raw V8 coverage dumps. If `coverage-final.json` is present, it takes priority.

These are measured CRAP inputs. They do not change the separate static `--coverage-gaps` analysis. `--coverage-root` rebases paths from another environment; it does not convert formats. [Versioned input detector](https://github.com/fallow-rs/fallow/blob/v3.38.1/crates/engine/src/health/scoring.rs#L1732-L1773), [official CLI reference](https://fallow.tools/docs/cli/health/)

Fallow computes coverage **per function from statement counters and statement ownership**, then applies the CRAP formula. When a mapped function has no owned statements, it falls back to that function's hit counter. Functions that cannot be matched retain estimated coverage. This is not file-level line coverage, and branch percentage is not the direct CRAP input. [CRAP calculation and fallback](https://github.com/fallow-rs/fallow/blob/v3.38.1/crates/engine/src/health/scoring.rs#L415-L422), [function coverage map construction](https://github.com/fallow-rs/fallow/blob/v3.38.1/crates/engine/src/health/scoring.rs#L1784-L1831), [statement coverage calculation](https://github.com/fallow-rs/fallow/blob/v3.38.1/crates/engine/src/health/scoring.rs#L2387-L2398), [official health explanation](https://fallow.tools/docs/explanations/health/#crap-score)

## Conversion and collection choices

**A lossless full Istanbul map cannot be recovered from Bun's LCOV alone.** Line records can be retained exactly as line records, but the report has no statement boundaries, function identities, or branch counters to recover. Parsing source code can invent locations, but it cannot determine which individual statements or functions ran when several share a line. Turning each covered line into an Istanbul statement changes the measured quantity. Supplying function locations inferred from source does not recover their missing execution counts. Such output is an approximation, not native support or exact per-function statement coverage. [Bun LCOV output](https://github.com/oven-sh/bun/blob/bun-v1.4.4/src/sourcemap_jsc/CodeCoverage.rs#L472-L538), [Fallow coverage calculation](https://github.com/fallow-rs/fallow/blob/v3.38.1/crates/engine/src/health/scoring.rs#L1784-L1831), [Fallow statement coverage](https://github.com/fallow-rs/fallow/blob/v3.38.1/crates/engine/src/health/scoring.rs#L2387-L2398)

For measured Fallow scores while keeping the Bun runtime, the technically appropriate route is **separate Istanbul-compatible instrumentation before execution**, followed by collection of the resulting coverage map. Istanbul inserts statement, function, and branch counters with source locations into the code. Those counters differ from Bun's built-in coverage collector and do not require a V8 engine. Source-map handling, original-file paths, and collection across test processes still need verification. The upstream instrumenter supports the instrumentation mechanism; this research did not establish a ready-made, officially documented Bun test integration or validate one. [Istanbul instrumenter API](https://github.com/istanbuljs/istanbuljs/blob/main/packages/istanbul-lib-instrument/src/instrumenter.js), [counter insertion and global coverage state](https://github.com/istanbuljs/istanbuljs/blob/main/packages/istanbul-lib-instrument/src/visitor.js)

A second option is a separate coverage run under a supported producer such as Vitest, Jest, or Node/V8, if the code and tests can run there. This produces inputs Fallow documents, but it is a different runtime execution and may require adapting Bun-specific tests. Do not claim that running `c8` around Bun obtains V8 counters: c8 depends on Node/V8 coverage. [Fallow producer documentation](https://fallow.tools/docs/cli/health/), [c8 upstream description](https://github.com/bcoe/c8)

Until real compatible counters are collected, keep Bun LCOV for line-level reporting and keep Fallow's estimate labeled as an estimate. Do not substitute file-line coverage for per-function statement coverage. [Fallow coverage models](https://fallow.tools/docs/explanations/health/#crap-score)

## Verified command interfaces

Local help verifies this command shape for Bun LCOV generation:

```sh
bun test --coverage --coverage-reporter=lcov --coverage-dir=coverage
```

The documented output is `coverage/lcov.info`. This is **not** a file Fallow accepts. [Bun coverage docs](https://bun.com/docs/test/code-coverage), [versioned CLI flags](https://github.com/oven-sh/bun/blob/bun-v1.4.4/src/runtime/cli/Arguments.rs#L603-L609)

Once a producer has generated an actual Istanbul map, Fallow's verified interface is:

```sh
fallow health --coverage coverage/coverage-final.json
```

This command consumes a report; it does not instrument or run the tests. No Bun instrumentation command is supplied because no complete integration was executed or verified in this research. [Fallow CLI reference](https://fallow.tools/docs/cli/health/)

## Verification scope

Checked local `bun --version`, `bun test --help`, native `fallow --version`, and `fallow health --help`. Checked version-tagged source, live official docs, GitHub release metadata, npm metadata, and the development snapshots linked above. No project tests, real-account calls, dependency installation, or configuration changes were needed for this format investigation. The only repository change from this research is this note.
