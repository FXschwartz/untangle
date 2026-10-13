# UX proposal v3: review by chain, end in the code

> Draft v3, 2026-10-13. Replaces v2 (see "History" at the end).
> Starting point: [00-original-prompt.md](00-original-prompt.md).
> Working prototype on serverpod_offline_sync #168: https://claude.ai/artifact/MEkRBmhVGgqBPUB5QYAFVB (version 3).
> Prototype sources: [prototype/](prototype/).

## Requirements

From the review of v1:
- **A view of the diff, not a report.** The same input always gives the same view, and no
  model writes anything.
- **No analysis written for one PR,** and no inferred trust levels.
- **Must have:** syntax highlighting, go to definition, search.

From the review of v2:
- **Chains of related changes are the main navigation,** and each chain has a graph. The
  view starts from the chain and ends in the code. A files panel stays as the secondary
  view.
- **Marking something reviewed never hides code.** Reviewed code stays visible and muted.
  Its diff is hidden by default, with a button to show it again.
- **Only hunks can be collapsed.**
- **Opening a "same edit" shows the whole edit,** including multi-line ones.

## Decisions (answers to the v2 questions)

1. **Same edit** = the same tree-sitter change. For example, one token replaced by
   another.
2. **Rebase conflicts** go back to unreviewed. A syntax-aware merge such as
   [mergiraf](https://mergiraf.org) runs first to resolve the simple ones.
3. **Snapshots live locally first.**
4. **A whole chain can be marked reviewed at once.**
5. **No `reviewedWith`.** Generated files are not reviewed, but they can be peeked for
   reference.
6. **No language server on removed lines** for now.
7. **The diff layout is choosable,** unified by default.

## Rules

### Chains

1. Each changed line's identifiers are resolved with the language server (go to
   definition, on the head side).
2. A changed token on one change that resolves to a declaration on a changed line of
   another change links the two changes.
3. **Parameters and local variables pass a chain on.** Union-find runs over changes: a
   parameter or local declared in one change joins it with every change that uses it.
   That way a new parameter, the calls that pass it, and the parameter those calls needed
   in turn are one chain.
4. **A changed function, method, field or type starts its own chain:** its declaration
   plus the changes that use it. When all of those already sit inside one parameter
   chain, it belongs to that chain instead.
5. A chain needs at least two members (enclosing declarations). Chains with the same
   root name merge.
6. **Name:** the declaration with the most usages inside the chain, such as
   `OfflineSyncDatabase.mergeChanges(userId)`.
7. **Graph:**
   - one node per changed member;
   - changes that are all the same change, 3 or more times in the chain, collapse into
     one node;
   - arrows go from a change to what it uses;
   - layers are the distance from the root;
   - other chains that share changes or roots are listed as linked chains.
8. Changes in no chain are listed by file under "Not in a chain".

### Same change

1. Change blocks are the runs of `-`/`+` lines in a hunk.
2. Their tokens are diffed with an LCS. Brackets match by nesting depth, and words inside
   comments and strings never match code.
3. Each run of changed tokens is an edit. For Dart, tree-sitter describes it:
   - **one token replaced by another,** with its role: a reference, a declaration name
     (the language server resolves it to itself), a named argument, a type or a keyword;
   - **otherwise, the smallest run of complete sibling nodes** that covers the edit:
     inserted, removed or replaced, keyed by node types and normalized text.
4. Edits with the same description form a group. Groups that always occur in the same
   blocks merge.
5. A group instance shows each edit's rows, extended to its whole syntax nodes, with one
   line of context. Small changes are shown whole.

### Reviewed snapshot

- Your review is a local git branch: the base plus every change you marked reviewed. The
  viewer diffs it against the PR head, so a new push only brings back what changed since
  you looked.
- On a rebase, the snapshot is replayed onto the new base with a syntax-aware 3-way
  merge (mergiraf or similar). Regions that still conflict go back to unreviewed.

### Generated files

- A file is generated when `.gitattributes` marks it `linguist-generated`, or when it
  matches `generated` patterns in `.review.yaml`.
- Generated files are never reviewed or counted. They are listed apart and can be opened
  read-only.

### Display

- **Reviewed changes stay visible.** By default their diff is hidden, so the new code
  reads as muted context. Pure deletions become a single "N removed lines, reviewed" row.
  "Show diff" restores the muted diff, either per change or for all changes.
- **Only hunks collapse.** The user can collapse any hunk. In a chain view, hunks over
  150 lines start collapsed, with buttons that jump to the lines that belong to the
  chain.
- **Unified by default, split on demand.** Split pairs removed and added lines per
  change and wraps long lines.

## Numbers on #168 (computed by the prototype)

| | vs main (e0598c1) | vs snapshot at 0540639 |
|---|---:|---:|
| Hand-written files with changes | 66 | 24 |
| Change blocks | 387 | 180 |
| Edits | 822 | 581 |
| Same-change groups | 53 | 36 |
| Chains (across files / within a file) | 50 (26 / 24) | 28 (10 / 18) |
| Changes in a chain / not in a chain | 283 / 104 | 64 / 116 |
| Generated files (lines) | 21 (25,731) | 3 (42) |

- **Largest chain:** `OfflineSyncDatabase.mergeChanges(userId)`, with 170 changes in 37
  files, drawn as 9 nodes. It includes `OfflineSyncEngine.mergeInboundBatch(userId)` and
  `_transactionAs`. The 154 identical call-site edits are one node.
- **Largest same-change groups:**
  - `spaceId → userId` as a named argument: 156.
  - `hlcManagerFor → spaceIdFor` as a reference, together with removing
    `.normalizedSpaceId`: 14.
  - `nodeUuid → .nodeUuidFor(space)`: 15.
- **Tooling limit:** the YAML grammar from `tree-sitter-wasms` doesn't load with
  `web-tree-sitter` 0.25. The `.spy.yaml` and Markdown files therefore fall back to plain
  token edits.

## Where it runs

- **VS Code extension first,** on top of a small core:
  - The chain list and graph live in a side panel (webview).
  - The code opens in the editor's diff with the snapshot on the left.
  - Highlighting, go to definition and search come from the editor and the project's
    language server. That same server provides the links that build chains.
- **Core:** keeps the snapshot and computes edits, groups and chains. It is plain git
  underneath, so git-tree-compare (full mode) or `git diff` can show what's left.

## Build order

1. **Snapshot CLI:** `review mark`, `status`, and `rebase` with mergiraf, on a local
   branch.
2. **Analysis core:** tree-sitter edits, same-change groups, and chains from the language
   server, as in `prototype/analyze.js`.
3. **VS Code extension:** chain panel with graph, diff against the snapshot, mark
   actions, peek, and search in unreviewed changes.
4. **Later:** sharing snapshots with teammates and agents, and syncing GitHub's viewed
   checkboxes.

## Open questions

- **Q1.** Should fields pass a chain on, like parameters? In #168 that would fold
  `_userNodes`, `_participations` and `_knownNodes` into `getOrCreateUserNode`'s chain.
- **Q2.** How should chains be ordered: by size (as now), by dependency, or by what is
  left to review?
- **Q3.** Should tests inside a chain be one node per test file (as now), or one node for
  all tests?
- **Q4.** Should changes in no chain (104 here) be listed by file (as now) or by member?
- **Q5.** For large graphs, should busy layers collapse into "+N more" (as now), or should
  nodes be grouped by file?

## History

- **v1:** each change was a decision or a consequence, folded under trust tiers. It came
  with analysis written by hand for #168.
  - Rejected: it reads like a report, the tiers are hard to make systematic, and it had
    no code navigation.
- **v2:** a deterministic viewer.
  - The left side of the diff became the reviewed snapshot.
  - It added token-level repeated edits, changed usages from the language server, and
    generated-file rules.
  - Feedback: navigate by chains with a graph, never hide reviewed code, collapse only
    hunks, and show whole edits.

## References

- [sem](https://github.com/Ataraxy-Labs/sem): entity-level diff, `impact`, `certify`.
- [inspect](https://github.com/Ataraxy-Labs/inspect): change classification and untangling.
- [dart_source_graph](https://pub.dev/packages/dart_source_graph): Dart dependency graph
  with resolved calls and references.
- [CG-Diff, arXiv 2609.32057](https://arxiv.org/abs/2609.32057): organizing PRs around
  call graphs.
- [mergiraf](https://mergiraf.org): syntax-aware git merge driver.
- [git-tree-compare](https://marketplace.visualstudio.com/items?itemName=letmaik.git-tree-compare):
  compares the working tree against any branch, tag or commit; has a full diff mode.
