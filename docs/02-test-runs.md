# Test runs: the rules on three other PRs

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
