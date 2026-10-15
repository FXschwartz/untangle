# Dart language-server benchmark

This harness drives the compiled untangle CLI through a complete review and the page's HTTP
API. It records the analyzer's traffic, time, memory and answers in disposable clones. These
are local measurements; the host load and available memory are saved with every run.

## Scripts

| File | Purpose |
| --- | --- |
| `run.ts` | Prepares a pinned scenario, runs the CLI, samples the real analyzer through Linux `/proc`, exercises live navigation, and stops its own processes. |
| `scenarios.ts` | Creates the small fixture or clones and pins S, M and L. |
| `dart-shim.mjs` | Forwards Dart arguments and LSP bytes unchanged, supplies the isolated analyzer cache, and logs requests and responses. Non-server Dart commands pass through. |
| `traffic.ts` | Counts requests, empty answers, opens and closes; measures stages and per-file request costs. |
| `live.ts` | Creates a deterministic plan of 100 head/base definitions, 20 onward jumps and five symbol searches; later runs reuse that plan. |
| `compare.ts` | Compares answers and prints timing/memory tables. Supports strict pairs and the baseline union. |
| `noise.ts` | Lists every differing query and its traffic attempts, including symbol order versus membership changes. |
| `harness.test.ts` | Tests framing, process cleanup, timing boundaries, comparisons and SDK source equivalence. |

## Prerequisites and isolation

Use Linux, Git, npm dependencies installed in this checkout, and a Node version that runs
TypeScript directly (the recorded runs used Node 25.2.0). Supply a copy of a Flutter SDK,
including its Dart SDK and `sky_engine` sources. The recorded runs used Flutter 3.44.4 and
Dart 3.12.2. Keep the same toolchain and package versions for both sides of a comparison.

`UNTANGLE_BENCH_SCRATCH` chooses the scratch root. Its default is `untangle-perf` under
`os.tmpdir()`. All run outputs must be inside it. Copy the SDK and any existing pub cache there
before running, so neither the analyzer nor pub writes to the user's caches:

```sh
export UNTANGLE_BENCH_SCRATCH="$(mktemp -d -t untangle-perf-XXXXXX)"
mkdir -p "$UNTANGLE_BENCH_SCRATCH/toolchain"
cp -a /path/to/flutter "$UNTANGLE_BENCH_SCRATCH/toolchain/flutter"
cp -a /path/to/pub-cache "$UNTANGLE_BENCH_SCRATCH/pub-cache"
```

An empty pub cache also works when dependency downloads are available. No browser opens:
every CLI run gets `-no-open -port 0`, and the runner removes `BROWSER` and every `ORCA_*`
variable. It gives each scenario a scratch HOME, analyzer cache and untangle cache. Every build
uses `-no-cache`; cold/warm below refers only to the analyzer cache. Cold does not flush the
operating system's file cache, the pub cache or the SDK.

The runner refuses an existing output directory. A `run.lock` permits one benchmark at a time
in a scratch root. Do not remove a lock while its recorded PID is running. Stop an active run
with SIGINT to the runner so its cleanup executes. It records process IDs, start identities,
process groups, exit status and survivors; it signals only processes that it started. Do not
run two harnesses in different scratch roots at once on a shared host just to bypass the lock.

## Scenarios

| Name | Shape | Base | Head |
| --- | --- | --- | --- |
| fixture | Generated two-package pub workspace plus a separate package; cross-package and SDK targets, old lines, test calls and overrides. | Generated deterministically | Generated deterministically |
| S | Serverpod PR 5864, a small CLI change. | `d65d22e0ede6` | `ac5ee4834410` |
| M | Serverpod PR 5866, a larger CLI change with tests and overrides. | `7645c5b5d9fc` | `b70d2354aa2a` |
| L | A caller-supplied large repository. | `UNTANGLE_BENCH_L_BASE` | `UNTANGLE_BENCH_L_HEAD` |

S and M fetch the public Serverpod repository. L requires `UNTANGLE_BENCH_L_REPO`,
`UNTANGLE_BENCH_L_BASE` and `UNTANGLE_BENCH_L_HEAD`, with no defaults. Point the repository
at a local source containing both selected commits. Only the scratch clone is checked out
or resolved; the source repository is read by `git clone`.

```sh
export UNTANGLE_BENCH_L_REPO=/path/to/local/source-repository
export UNTANGLE_BENCH_L_BASE='<base-commit>'
export UNTANGLE_BENCH_L_HEAD='<head-commit>'
```

`scenarios/<name>/scenario.json` saves the full commit IDs and clone path. Subsequent runs use
that manifest. The checked-out head must match it and have no tracked changes. To benchmark a
different commit pair, update the scenario inputs and use a fresh scratch root; never
reuse results or a live plan across different inputs.

Keep results for non-public repositories outside this repository. Published validation
evidence must use public repositories or synthetic fixtures.

## Build and run

Build each candidate separately and preserve its source and build hashes. The baseline used
for the original reports was commit `5160855`; it can be built without changing this checkout:

```sh
mkdir -p "$UNTANGLE_BENCH_SCRATCH/builds/5160855"
git archive 5160855 | tar -x -C "$UNTANGLE_BENCH_SCRATCH/builds/5160855"
ln -s "$PWD/node_modules" "$UNTANGLE_BENCH_SCRATCH/builds/5160855/node_modules"
git rev-parse 5160855 > "$UNTANGLE_BENCH_SCRATCH/builds/5160855/bench-commit.txt"
npm --prefix "$UNTANGLE_BENCH_SCRATCH/builds/5160855" run build
npm run build
```

A separate build directory outside a Git checkout needs `bench-commit.txt` with its source
commit. The runner also records the CLI hash; save a source manifest or patch yourself for an
uncommitted candidate. The reporting runs used frozen build copies rather than rebuilding
files while a measurement was in progress.

Run cold before warm, with unique output names. For example:

```sh
node bench/run.ts --build "$UNTANGLE_BENCH_SCRATCH/builds/5160855/dist/cli.js" --scenario fixture --out "$UNTANGLE_BENCH_SCRATCH/runs/baseline-fixture-cold" --cache cold
node bench/run.ts --build "$UNTANGLE_BENCH_SCRATCH/builds/5160855/dist/cli.js" --scenario fixture --out "$UNTANGLE_BENCH_SCRATCH/runs/baseline-fixture-warm" --cache warm
node bench/run.ts --build dist/cli.js --scenario fixture --out "$UNTANGLE_BENCH_SCRATCH/runs/candidate-fixture-cold" --cache cold
node bench/run.ts --build dist/cli.js --scenario fixture --out "$UNTANGLE_BENCH_SCRATCH/runs/candidate-fixture-warm" --cache warm
```

Repeat those four commands with `--scenario S`, `M` and `L` and corresponding output names.
A warm run requires a prior run's analyzer cache. It still starts a new analyzer process and
rebuilds the review. The first shim run creates `scenarios/<name>/live-plan.json`; preserve it
for every baseline and candidate. `--no-shim` measures instrumentation overhead using that
existing plan, but cannot produce traffic counts or create the plan.

Each output contains `result.json`, `answers.json`, the frozen live plan, `traffic.jsonl`,
`rss.csv`, stdout/stderr and process metadata. `result.json` contains environment conditions,
CLI arguments, printed step times, protocol stage times, live latencies and cleanup results.
The analyzer's sampled high-water mark is reported as build peak; served and after-live RSS
measure the retained process. The saved monotonic boundary separates batch from live traffic.
Do not add protocol times to printed wall-clock times: these clocks can diverge on a shared
host.

## Compare answers

Compare cold only with cold, and warm only with warm, on the same commits, generated files,
resolved packages, SDK and live plan. Use the union when a baseline has repeat-run variation:
every target found by any baseline must remain. Extras are listed and do not fail the union;
missing or different targets, conflicting baselines, incomplete runs, and commit mismatches
fail it. Inspect and explain all extras and aliases in the report. Supply only baselines with
the same cache state; the CLI does not infer which runs belong together.

```sh
node bench/compare.ts --union "$UNTANGLE_BENCH_SCRATCH/runs/baseline-fixture-cold" --candidate "$UNTANGLE_BENCH_SCRATCH/runs/candidate-fixture-cold"
node bench/compare.ts --union "$UNTANGLE_BENCH_SCRATCH/runs/baseline-fixture-warm" --candidate "$UNTANGLE_BENCH_SCRATCH/runs/candidate-fixture-warm"
node bench/compare.ts --union /path/to/warm-baseline-A /path/to/warm-baseline-B --candidate /path/to/warm-candidate
```

The union checks raw head/base definitions, call seeds/graphs, overrides, live targets and
symbol membership. Checkout roots normalize to `<head>` and `<base>`. SDK targets may refer to
`dart-sdk/lib` or Flutter's `pkg/sky_engine/lib` copies: these are equivalent only when the
relative library path, target line and target column match **and both files exist with exactly
the same bytes**. The comparator checks the files on each invocation and lists every alias.
It never treats arbitrary dependency paths or changed SDK bytes as equivalent. Keep the SDK
copy available while comparing archived runs.

Strict pair comparison also checks target descriptions and symbol ordering. It intentionally
reports additions and label changes that a union can accept:

```sh
node bench/compare.ts /path/to/run-A /path/to/run-B
node bench/noise.ts /path/to/run-A /path/to/run-B > /path/to/noise.json
```

Both comparison modes exit 0 on success and 1 on a mismatch. Save their actual stdout and exit
status alongside each run. A green union is correctness evidence for the captured batch and
live plan, not a claim about every possible page request.

## Harness validation

```sh
node --test bench/harness.test.ts
node_modules/.bin/tsc --noEmit --strict --noUnusedLocals --noUnusedParameters --skipLibCheck --target es2023 --module nodenext --moduleResolution nodenext --allowImportingTsExtensions --types node bench/*.ts
```

The harness tests use unique folders under `os.tmpdir()` and clean them up. They do not require
the large scenario, the copied SDK, or any machine-specific directory.
