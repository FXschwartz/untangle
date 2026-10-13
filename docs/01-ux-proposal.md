# UX proposal v5: start from the chain map, end in the code

> Draft v5, 2026-10-13. Replaces v4 (see "History" at the end).
> Starting point: [00-original-prompt.md](00-original-prompt.md).
> Working prototype on serverpod_offline_sync #168: https://claude.ai/artifact/MEkRBmhVGgqBPUB5QYAFVB (version 6).
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

From the review of v3:
- **A hunk folds on its own** when its last change is marked reviewed.
- **Renames and same changes belong in chains,** for example `userId → spaceId`,
  `spaceIdFor` and `withCurrentNodeHlc → withUserClock`.
- **Syntax highlighting** must be clearly visible.
- **The palette is dark,** black and dark grey instead of blue.
- **Each chain shows its total diff.**
- **Clicking a graph node focuses on it and filters the code** instead of jumping to it.
- **Chains form a hierarchy,** shown as a chain-of-chains view.
- **Folding one hunk must never fold another.**

From the review of v4:
- **Removed code links the same way as added code,** with its own language server for go
  to definition and linking.
- **The chain map is the first screen.**

## Decisions (answers to the v2 questions)

1. **Same edit** = the same tree-sitter change. For example, one token replaced by
   another.
2. **Rebase conflicts** go back to unreviewed. A syntax-aware merge such as
   [mergiraf](https://mergiraf.org) runs first to resolve the simple ones.
3. **Snapshots live locally first.**
4. **A whole chain can be marked reviewed at once.**
5. **No `reviewedWith`.** Generated files are not reviewed, but they can be peeked for
   reference.
6. **Language servers on both sides.** This revises the v2 answer: removed lines get go
   to definition and link into chains like added lines.
7. **The diff layout is choosable,** unified by default.

## Rules

### Chains

1. Each changed line's identifiers are resolved with a language server:
   - added lines by one running on the PR head;
   - removed lines by one running on the comparison's old side, in its own checkout.
2. A changed token on one change that resolves to a declaration on a changed line of
   another change links the two changes, on either side.
   - A declaration whose name token was replaced (a rename) is one declaration, so its
     old and new usages link to it.
   - Chains rooted at a removed declaration are named with "−".
3. **Parameters and local variables pass a chain on.** Union-find runs over changes: a
   parameter or local declared in one change joins it with every change that uses it.
4. **A changed function, method, field or type starts a chain:** its declaration plus the
   changes that use it. A member's chain and the ripple of its own parameters merge.
5. **A same-change group that names an identifier is a chain,** so a rename like
   `withCurrentNodeHlc → withUserClock` is tracked together.
6. **Member cohesion.** A chain takes every change of the members it touches.
   - In test files, the member is the enclosing `test(...)`.
   - A comment-only change belongs to the declaration it documents.
7. **Imports and docs.**
   - A new relative import joins the chains that, in the same file, use declarations
     from the imported file.
   - A Markdown change that names a chain's member or declaration in backticks joins
     that chain.
8. A chain needs at least two members; same-change chains need two changes. Changes in
   no chain are listed by file.
9. **Name:** the declaration with the most usages inside the chain, or the edit itself
   for a same-change chain.
10. **Graph:**
    - one node per member;
    - nodes that are all the same change, 3 or more times, collapse into one;
    - arrows go from a change to what it uses;
    - layers are the distance from the root.
11. **Totals:** each chain shows its total diff (+/−) and how many changes are reviewed.

### Chain of chains

- A chain's **core** is the changes of its root's member, or all its changes when it has
  no root.
- **Chain A uses chain B** when A's core uses a function, method, field or type in B's
  core.
- **Depth** is the longest path from a chain that nothing uses, ignoring back edges of
  cycles.
- **Families** are chains connected by "uses".
- **The chain map** lays a family out by depth:
  - it draws only direct dependencies (a transitive reduction);
  - arrows that skip levels are faint.

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
- **Only hunks collapse, and they collapse automatically when their last change is
  reviewed.** The user can reopen them or collapse any hunk by hand. In a chain view,
  hunks over 150 lines start collapsed, with buttons that jump to the lines that belong
  to the chain.
- **Each view has its own hunks.** A chain section shows each change with 3 lines of
  context, merged when they touch. Folding a hunk in one place never folds another.
- **Clicking a graph node** shows only that node's code and dims unrelated nodes.
- **Dark palette** with VS Code Dark+-style syntax colors. Function names are told apart
  from other identifiers.
- **Unified by default, split on demand.** Split pairs removed and added lines per
  change and wraps long lines.

## Numbers on #168 (computed by the prototype)

| | vs main (e0598c1) | vs snapshot at 0540639 |
|---|---:|---:|
| Hand-written files with changes | 66 | 24 |
| Change blocks | 387 | 180 |
| Edits | 822 | 581 |
| Same-change groups | 53 | 36 |
| Chains (across files / within a file) | 64 (34 / 30) | 38 (10 / 28) |
| Changes in a chain / not in a chain | 343 / 44 | 124 / 56 |
| Generated files (lines) | 21 (25,731) | 3 (42) |

- **Largest chain:** `OfflineSyncDatabase.mergeChanges(userId)`, with 184 changes in 38
  files (+2,130 −191), drawn as 11 nodes. The 154 identical call-site edits are one node.
- **`OfflineSyncDatabase.recordSyncCheckpoint(spaceId)`,** the `userId → spaceId`
  rename, has 16 changes in 6 files.
- **Removed declarations:** 10 chains start at one, such as
  `− OfflineSyncSpaceManager._getOrCreate(transaction)` with 14 changes.
- **Old-side language server:** it resolved 1,795 of 1,846 removed-line identifiers
  (main) and 1,223 of 1,246 (snapshot).
- **Chain of chains:** the main family has 52 chains in 9 levels. Tests use
  `mergeChanges(userId)`, which uses `_transactionAs` and the recorder wrappers. Those use
  the space manager and context locks, which use `_UserClock` and the cache fields.
- **Still outside a chain (44):**

  | Reason | Changes |
  |---|---:|
  | Markdown or model YAML, naming nothing in a chain | 13 |
  | Comment-only edits of members in no chain | 12 |
  | Dart edits that use only unchanged code (many use `OfflineSyncSpace.currentNode`, a field that only exists in generated code) | 19 |

- **Tooling limit:** the YAML grammar from `tree-sitter-wasms` doesn't load with
  `web-tree-sitter` 0.25. The `.spy.yaml` and Markdown files fall back to plain token
  edits.

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

- **Q1.** Should usages of generated declarations link back to the model change they come
  from, such as the removed `currentNode` field in `space.spy.yaml`?
- **Q2.** Member cohesion makes chains complete but larger (`persistedUserClock` spans
  15 test nodes). Should it stay, or should those changes show as linked but outside?
- **Q3.** How should chains inside a family be ordered: by level (as now), or by what is
  left to review?
- **Q4.** For large graphs, should busy levels collapse into "+N more" (as now), or
  should nodes be grouped by file?
- **Q5.** The old side needs its own checkout and `pub get`. Should its language server
  run on demand, or always in the background?

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
- **v3:** chains as the main navigation, tree-sitter same changes, a graph per chain.
  - Feedback:
    - too many changes outside chains;
    - weak highlighting, and a blue look;
    - add chain totals;
    - focus on node click instead of jumping;
    - show a chain of chains;
    - fold hunks on review;
    - collapsing one hunk folded others.
- **v4:** the chain map, focus on node click, auto-folding hunks, dark palette.
  - Feedback: removed code should link the same way, with a language server of its own,
    and the map should be the first screen.

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
