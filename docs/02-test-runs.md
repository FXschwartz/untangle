# Test runs: the rules on seven other PRs

> 2026-10-13. The rules of [UX proposal v9](01-ux-proposal.md), run unchanged on three more
> PRs of serverpod_offline_sync. Every rule was written while looking at #168 only; this
> checks how much of that was overfitting.
> Harness: [`prototype/run_pr.sh`](prototype/run_pr.sh). The only code change was taking
> commits and paths as arguments. #168's model is byte-identical after it.

## What ran

| PR | Files (hand-written / generated) | Changes | Edits | Same-change groups | Chains (across files) | Changes in a chain |
|---|---:|---:|---:|---:|---:|---:|
| #168 fix: Own HLC clocks per user (the reference) | 87 (66 / 21) | 387 | 549 | 25 | 65 (36) | 359 (93%) |
| #157 perf: Batch projection reads and engine writes | 10 (10 / 0) | 52 | 71 | 6 | 13 (5) | 44 (85%) |
| #166 fix: Capture outbound changes in a consistent snapshot | 12 (12 / 0) | 58 | 75 | 4 | 12 (8) | 43 (74%) |
| #162 fix: Support Serverpod 4.1 watches | 102 (19 / 83) | 64 | 92 | 4 | 5 (4) | 53 (83%) |

Each run took about 30 seconds of language-server time on top of `dart pub get`. The
analysis itself took under 2 seconds.

## What held up

- **No failures.** All three ran without errors or special cases.
- **Generated files:** #162's 83 regenerated files (7,422 lines) were set aside and stayed
  peekable.
- **Same changes stayed meaningful:**
  - #166: `transaction` threaded through 8 signatures and their calls (4 groups);
  - #162: the Serverpod constraint bump in 21 places across 9 `pubspec.yaml` files, and
    `include → queryInclude` ×9;
  - no punctuation groups anywhere.
- **Not exercised:** model links (no `.spy.yaml` changes) and file renames (none).

## What broke, most damaging first

1. **Call sites whose text didn't change are never linked.** In two PRs, a change the
   description names sits outside every chain:
   - **#166:** the central fix in `collectPendingChanges` passes `transaction` positionally
     to `_streamPendingChanges`, which gained that parameter. A positional argument resolves
     to the local variable, not to the parameter, so nothing links. In #168 the call sites
     used named arguments, whose labels resolve to the parameter.
   - **#162:** the clock fix. `currentNode: currentNode.node` kept its text, but it now
     binds to the new parameter of `HlcManager.forSpace` instead of to `copyWith`'s. Only
     tokens whose text changed are followed.
   - *Fix:* a changed argument list links to the function it calls when that function's
     signature changed. A token whose definition differs between the two sides counts as
     changed; both sides already have a language server.
2. **Moved code shows as removed and added.** #157 moves `_PendingInsertAttempts` from
   `merge.dart` to the new `merge_write_batch.dart`. The only change is one dropped 2-line
   getter. The tool shows:
   - 63 removed lines;
   - five "removed" chains, one for the class and one per method;
   - the copy buried inside a 154-line block.
   - *Fix:* pair a removed declaration with an added one of the same name and kind, show it
     as moved, and diff the two bodies. Here that leaves 2 lines to review.
3. **A big block is one change, credited to one member.** A new file or a removed class is a
   single run of lines, so it gets whichever member holds the most lines:
   - `merge_write_batch.dart`, which holds two classes, is labeled `_PendingInsertAttempts.take`;
   - `watch.dart` (101 lines) joins three chains whole;
   - each new test file is a single change, not one per `test(…)`.

   Blocks of 40 or more lines: 7 in #157, 6 in #166, 5 in #162, and 8 in #168.
   - *Fix:* split blocks at declaration boundaries: each top-level declaration, each member,
     and each `test(…)`.
4. **A chain is named after its most-used declaration, which can be a minor one.** #162's main
   chain holds the new `watch` support (`OfflineSyncDatabase.watch`, `watch.dart`,
   `watch_test.dart`). It is named `− _walkIncludeGraphForTombstone(tableIdForName)`, a
   removed parameter of a private helper.
   - *Fix:* prefer a new or changed public declaration, and fall back to the most-used one.
5. **Duplicate chains, and one chain per member.**
   - Chains with exactly the same changes: two pairs in #166
     (`_captureDatabase` / `_captureSession`, `captureInterleavingProbability` /
     `collectionInterleavingProbability`), and one pair each in #157 and #168.
   - A new or removed class gives a chain per member: five for `_PendingInsertAttempts` and
     three for `_MergeWriteBatch` in #157.
   - *Fix:* merge chains that have the same changes, and fold the members of a new or removed
     type into the type's chain.
6. **Behavior tests stay outside.** New test files that test through entry points the PR left
   unchanged (`mergeChanges`, `collect`) have no link to the changed code:
   - #157's two new test files (562 lines);
   - #166's `outbound_snapshot_test.dart` (271 lines).

   This is an open question rather than a bug: linking them takes a rule beyond the language
   server.
7. **Small ones:**
   - `part` directives don't link the way imports do (#157 ×2, #162 ×1).
   - YAML and Markdown edits are keyed only on the changed tokens. So `0.0.10 → 0.0.11` is
     "10 → 11", and the version-bump label prints tokens with spaces:
     `' > = 4 . 0 . 4 < 4 . 1 . 0 '`.

## Verdict

Nothing in the rules is specific to #168, but several of them only worked because of how
#168 was written:
- its call sites used named arguments;
- its renames happened in place;
- it moved no code.

The fixes above are general. Each one should be run against all four PRs with the harness
before it's adopted, and the next PRs to add are ones with moved files and large new
features.

## After the fixes

Every problem above became a rule, and all four PRs ran again with the same rules
([UX proposal v10](01-ux-proposal.md)). Changes went up because each declaration and each
test is now a change of its own.

| PR | Changes | Chains | Changes in a chain | Outside | Identical chains | Moved declarations |
|---|---:|---:|---:|---:|---:|---:|
| #168 | 387 → 580 | 65 → 56 | 93% → 95% | 28 → 30 | 1 → 0 | 0 |
| #157 | 52 → 102 | 13 → 11 | 85% → 97% | 8 → 3 | 1 → 0 | 6 |
| #166 | 58 → 123 | 12 → 14 | 74% → 91% | 15 → 11 | 2 → 0 | 0 |
| #162 | 64 → 104 | 5 → 12 | 83% → 94% | 11 → 6 | 0 | 0 |

1. **Call sites.** A changed call links to the function it calls when that signature
   changed: a positional argument joins the parameter in the same position, and the called
   function is resolved even when its name sits above the hunk (35 such calls in #168). A
   token whose definition differs between the two sides counts as changed.
   - #166: `collectPendingChanges` is in the `_streamPendingChanges` chain with the whole
     `transaction` ripple, through eight functions.
   - #162: the clock fix is the chain `HlcManager(currentNode)`.
2. **Moved code.** #157 shows `_PendingInsertAttempts` as moved: four members unchanged,
   the header with one change, and `isEmpty` as the only removal. `_flushInsertAttempts`
   moved into `_MergeWriteBatch` with 8 changes.
3. **Big blocks.** Blocks split at declarations and tests. `merge_write_batch.dart` is 14
   changes, one per declaration, and each new test file splits per `test(...)`.
4. **Names.** #162's main chains are `_OfflineSyncDatabaseWatch`, `mergeWhereWithVisibility`
   and `copyInclude`. #166's ripple is named after the parameter where it enters.
5. **Duplicates.** No two chains have the same changes. A new or removed type is one chain
   with its members (`_MergeWriteBatch`, `_ProjectionReader`).
6. **Behavior tests.** Tests follow the language server's call hierarchy up to three calls
   deep: #157's new tests reach `_MergeWriteBatch.apply` and `_applyMergeInsert` through
   `mergeChanges`. Tests in a chain: #157 34/34, #166 84/89, #162 33/33, #168 417/424.
7. **Small ones.** `part` directives link to their part file's chains. YAML edits read as
   whole words: `0.0.10 → 0.0.11` ×5 and `'>=4.0.4 <4.1.0' → ^4.1.0-beta.3` ×21.

Two rules had to be narrowed after the first try, both found by these runs:
- Linking a call to every changed parameter of the callee merged #168 into one chain of 397
  changes; matching the argument's position fixed it.
- Locals in shared test setup, and parameters of brand-new helpers, tied whole test files
  together; a local now only links inside its own member, and a new function's parameters
  don't ripple.

**Overrides (Q6, decided after these runs):** changed methods that override the same
method join one chain. In #162 the real database's `watch` and the benchmark's query
counter are now one chain, `overrides Database.watch`, and so are their `unsafeWatch`.

**Q1–Q5 (decided after these runs):** member cohesion now applies only to changes nothing
else links. Every PR keeps the same coverage, and the chains it inflated shrink (#168's
`− OfflineSyncSpace.currentNode` 66 → 48). Generated-code adapters for part files and
protobuf are checked on a fixture (`prototype/make_fixture.sh`), since none of these PRs uses
those generators.

**Still open:** moves are detected for whole declarations only, and only in Dart.

## Round 2: four Serverpod PRs

> 2026-10-14. The v12 rules, unchanged, on a different and much larger repository: Serverpod,
> a pub workspace of 165 packages. Each PR was fetched by commit only; its diff starts at the
> merge base GitHub reports.

| PR | Files (reviewed / generated) | Changes | Chains | In a chain | Tests in chains | Run time |
|---|---:|---:|---:|---:|---:|---:|
| #5864 MCP `tail_runner_logs` tool (normal) | 8 / 0 | 29 | 5 | 38% | 0 / 8 | 21 s |
| #5706 Embedded Postgres over TCP and socket (dense) | 29 / 1 | 261 | 56 | 81% | 89 / 112 | 66 s |
| #5471 Custom class column types (normal, bigger) | 17 / 1 | 146 | 23 | 99% | 85 / 86 | 58 s |
| #5630 Model projections (generated-heavy) | 37 / 476 | 264 | 78 | 80% | 28 / 49 | 132 s |

"Tests" here counts `*_test.dart` files and files under `test*/` directories; the current
rule only knows `test/`.

### Pipeline fixes needed to run them

- **Generated files were read from the wrong place.** `git check-attr` read `.gitattributes`
  from whatever was checked out, not from the PR head. In a fetch-only repository nothing
  is checked out, so Serverpod's own markers (`**/generated/**`, `**/protocol/**`) were
  ignored, and #5630's 331,588 generated lines would have gone through the language server.
  Fixed with `check-attr --source <head>`, and the adapters' generated patterns now reach
  the export step too (`adapters.js`, `generated_globs.js`).
- **References were too slow.** In a 165-package workspace each references request took
  about 2 seconds. The changed-usage badges now come from inverting the definitions
  (`refs_from_defs.py`): the same output with no request, and it also finds usages the
  references request missed (locals used in another block of the same function).
- **Workspaces with Flutter packages** fall back to `flutter pub get`; monorepos without a
  workspace get one `pub get` per package that holds a changed Dart file.

### What held up

- **Scale:** 21 to 132 seconds per PR, with definitions taking 8 to 78 seconds even in this
  workspace.
- **Generated code:** #5630's 476 generated files are set aside and 443 stay peekable.
- **New code stays together:** #5471's new `CustomClassAnalyzer` is one chain of 66 changes
  with its new file, and #5471 has 99% of its changes in chains.

### What broke, most damaging first

1. **Names in strings link nothing.** The language server can't see a name used as a string:
   - #5864's feature is an MCP tool called by name. Its tests (`callTool(name:
     'tail_runner_logs')`), the error message and three docs only share that string, so 18
     of its 29 changes stay outside.
   - #5630's generator tests assert generated class names as strings (`'FullModelInclude'`),
     which are names of changed declarations.
   - *Proposed rule (needs a decision; it goes beyond the language server):* an
     identifier-like string literal on a changed line links to a changed declaration with
     that name, or to the other changes that introduce the same literal; a backticked span
     in Markdown counts the same way.
2. **Test detection is too narrow.** Only `test/` directories count. Serverpod's
   integration tests live in `test_integration/`, so #5630's integration tests got no
   per-test changes and no call-graph links.
   - *Fix:* a test is a `*_test.dart` file, or a file under a `test*/` or
     `integration_test/` directory.
3. **Calls through unchanged test helpers aren't followed.** The call graph only starts
   from production declarations. #5864's tests build the server through `_makeBridgePair`, a
   helper whose call reaches the changed `BridgeMcpServer` constructor; #5630's go through
   `CompilationUnitHelpers`. Both runs had no starting point at all.
   - *Fix:* start the call graph from test helpers too.
4. **Import prefixes become chains.** `import 'package:path/path.dart' as p` makes a chain
   named `p` of every change that calls `p.join`: 34 changes in #5471 (its third-largest
   chain), 11 in #5706, and `pg` and `path` besides.
   - *Fix:* an import prefix starts no chain; its import joins the chains that use it.
5. **A field and the parameter that sets it are two declarations.** An existing class with
   new fields becomes a chain per field: `EmbeddedPostgresOptions` is six chains in #5706,
   `TypeDefinition` five in #5471.
   - *Fix:* a field and its `this.field` constructor parameter are one declaration.
6. **Each field of a new model is a chain.** #5630's six largest chains are single fields
   of four new test models (`ProjectedAddress.street`, `ProjectedUser.name`…).
   - *Fix:* fold a new model's field chains into one chain per model, as for new types.
7. **Serverpod model files ending in `.spy` or `.spy.yml` are missed**; only `.spy.yaml`
   is known. #5630's `projected_json_field.spy` got no model links.
8. **Families ignore shared changes,** although the rule says chains that share changes
   are one family. #5864's feature is two chains that share two changes, in two families.
9. **Imports from the same package don't link.** `import 'package:serverpod_cli/…'` inside
   `serverpod_cli` isn't treated like a relative import.
   - *Fix:* resolve `package:` imports of workspace packages through the package config.

**Still untested:** none of these PRs renames a file, and none touches freezed or protobuf
generated code.

### After the fixes

All nine became rules ([UX proposal v13](01-ux-proposal.md)), and all eight PRs ran again,
the Serverpod ones and the offline_sync ones.

| PR | Chains | Changes in a chain | Outside | Tests in chains | Families |
|---|---:|---:|---:|---:|---:|
| #5864 | 5 → 7 | 38% → 93% | 18 → 2 | 0 / 8 → 7 / 8 | 2 → 2 |
| #5706 | 56 → 50 | 81% | 49 | 89 / 112 | 25 → 5 |
| #5471 | 23 → 22 | 99% | 2 | 85 / 86 | 12 → 3 |
| #5630 | 78 → 80 | 80% → 85% | 52 → 39 | 28 / 49 → 36 / 49 | 38 → 7 |
| #168 | 56 → 62 | 95% | 30 → 29 | 417 / 424 | 17 → 2 |
| #157 | 11 | 97% | 3 | 34 / 34 | 8 → 4 |
| #166 | 14 | 91% | 11 | 84 / 89 | 5 → 1 |
| #162 | 12 → 13 | 94% | 6 | 33 / 33 | 8 → 4 |

1. **Names in strings.** #5864's tool name is a chain, `“tail_runner_logs”`, of 14 changes:
   the tool, its tests, its error message and the docs. `“runner.log”` is another of 3.
   A string links only when it looks like a name: 4 to 80 characters, no spaces, and a
   capital after the first letter, an underscore, a dot, a dash or a digit. When it names a
   changed declaration it links to it; otherwise two or more changes that introduce it, one
   of them code, form a chain.
2. **Test detection.** #5630's `test_integration/` files now split per test, and tests in
   chains went from 28 to 36 of 49.
3. **Test helpers.** The call graph starts from unchanged test helpers too: #5864's tests
   reach the changed `BridgeMcpServer` constructor through `_makeBridgePair`.
4. **Import prefixes.** The chains `p`, `pg` and `path` are gone (34 changes in #5471, 11 in
   #5706). Each import joins the chains that use its prefix.
5. **Fields and `this.field`.** `EmbeddedPostgresOptions()` is one chain instead of six,
   `TypeDefinition()` one of 44 changes instead of four, and `ResolvedEmbeddedPostgres()`
   one instead of three.
6. **New models.** #5630's thirteen field chains of new test models are now one chain per
   model, the largest `ProjectedOrder` with 16 changes.
7. **`.spy` files.** `projected_json_field.spy` is in the `ProjectedJsonField` chain.
8. **Families.** #5864's feature, six chains that share changes, is one family. On large PRs
   almost everything becomes one family: 61 of #168's 62 chains, and all 14 of #166's. Most
   of the shared changes are tests that reach two chains. The map draws one dashed line per
   group of chains joined this way. Counting only shared changes outside tests would leave
   #168 with 4 families, #166 with 5 and #5471 with 10. That's an open question in v13.
9. **Same-package imports.** `package:` imports resolve to the workspace package that has
   the file. Serverpod keeps a second `serverpod_cli` pubspec under `templates/`, which first
   took the name, so the fix only worked after that. #5864's `runner_paths.dart` import now
   joins the `serverpodRunnerLogName` chain.

**Three bugs in the test rule, found while checking these runs:**
- **The call graph was walked depth first.** A function first met three calls away, through
  a new test-helper seed, was never expanded when met again one call away. It's breadth first
  now; #157's graph went from 47 to 96 functions.
- **A method changed only in its body didn't count as changed.** Its body hangs off its outer
  signature node, which the check missed, so only top-level functions worked. Tests skipped
  past changed methods to the next one whose signature changed. Now the rule does what it
  says, the first changed function on each path:
  - #157's batch tests link to `mergeChanges`, the method they call, instead of
    `_MergeWriteBatch` and `_applyMergeInsert` behind it;
  - #166's 26 tests link to `collectPendingChanges`, which shares its signature change with
    the `transaction` ripple of `_streamPendingChanges`;
  - #5706's 26 tests link to `EmbeddedPostgresImpl.start`, which now names the PR's largest
    chain (79 changes).
- **A reached function stood for its first change, even a comment.** It now stands for its
  first change with code in it.

**Still outside:**
- **Generator tests that check generated code as strings**, such as
  `'CompanyInclude? company'` or `'_${testClassName}JsonInclude'`: 13 of #5630's test changes.
- **Test edits that touch no changed code** (#5706's 19 test changes): reworded test and
  group names, removed assertions, and setup that only uses the SDK, such as reserving a
  free port.
- **Imports of another workspace package's barrel file**
  (`package:serverpod_embedded_postgres/serverpod_embedded_postgres.dart`): the rule doesn't
  follow `export`s yet.

Freezed and protobuf adapters are still checked only on the fixture
(`prototype/make_fixture.sh`), which gives the same result as before.
