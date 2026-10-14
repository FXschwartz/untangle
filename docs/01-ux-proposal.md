# UX proposal v10: start from the chain map, end in the code

> Draft v10, 2026-10-13. Replaces v9 (see "History" at the end).
> Starting point: [00-original-prompt.md](00-original-prompt.md).
> Working prototype on serverpod_offline_sync #168: https://claude.ai/artifact/MEkRBmhVGgqBPUB5QYAFVB (version 11).
> Prototype sources: [prototype/](prototype/).
> Test runs of these rules on #157, #166 and #162: [02-test-runs.md](02-test-runs.md).

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

From the review of v5:
- **Generated code links back to its model** (`.spy.yaml`).
- **Measure the cost** of the second language server.

From the review of v6:
- **"Same change" triggers too much.** One doc-comment edit showed as "the same change
  ×5", a lone `(` or `!` was a same change, and one rewrite carried up to five badges.

From the review of v7:
- **The first version is a web page,** not a VS Code extension, so it runs anywhere,
  including Orca's built-in browser.

From the review of v8:
- **A changed usage previews inside the peek.** Clicking it shows its code there instead
  of leaving the view; clicking it again goes to it.
- **Usage snippets are syntax highlighted.**

From the review of v9 and the test runs ([02-test-runs.md](02-test-runs.md)):
- **Fix every problem the runs on #157, #166 and #162 found.**

## Decisions (answers to the v2 questions)

1. **Same edit** = the same tree-sitter change. For example, one token replaced by
   another. Since v7, overlapping runs are one edit and punctuation alone never counts.
2. **Rebase conflicts** go back to unreviewed. A syntax-aware merge such as
   [mergiraf](https://mergiraf.org) runs first to resolve the simple ones.
3. **Snapshots live locally first.**
4. **A whole chain can be marked reviewed at once.**
5. **No `reviewedWith`.** Generated files are not reviewed, but they can be peeked for
   reference.
6. **Language servers on both sides.** This revises the v2 answer: removed lines get go
   to definition and link into chains like added lines.
7. **The diff layout is choosable,** unified by default.
8. **Where it runs:** a local web app first, open in any browser. A VS Code extension can
   wrap it later.
9. **Language servers:** one server with both checkouts as workspace folders, so go to
   definition stays live on both sides (about 850 MB on #168).
10. **Server language:** TypeScript on Node, for now.

## Rules

### Changes

1. A change is a run of changed lines in a hunk, split where a declaration unit starts:
   - each top-level declaration (consecutive directives count as one);
   - each member of a class, mixin, extension or enum;
   - each `test(...)`, `group(...)`, `setUp...` or `tearDown...` call.
   A unit starts at its doc comments and annotations. Members written right under each
   other, with no blank line, stay together. A block with removed and added lines keeps its
   removed lines with the added lines they were diffed against.
2. **Moved code.** A removed unit and an added unit with the same full name and kind, or
   the same short name and at least half their tokens alike, are one moved declaration.
   - Its change is the diff between the two bodies. Only the tokens that diff changed count
     as changed, for same changes and for chains.
   - The removed copy is shown as one line pointing at the new place, and its old usages
     link to the moved copy.
   - A move with no changes needs no review.

### Chains

1. Each changed line's identifiers are resolved with a language server:
   - added lines on the PR head, plus the called function of every changed argument
     list, even when its name sits above the hunk;
   - removed lines on the comparison's old side, in its own checkout.
2. A changed token on one change that resolves to a declaration on a changed line of
   another change links the two changes, on either side.
   - A renamed or moved declaration is one declaration, so its old and new usages link
     to it.
   - Chains rooted at a removed declaration are named with "−".
3. **A name that now means something else counts as changed.** A token whose text stayed
   (an argument label, say) but whose definition differs between the two sides (by file,
   name and enclosing member) links like a changed token.
4. **Calls follow signatures.** A call whose argument list changed, to a function whose
   signature changed:
   - a changed positional argument joins the parameter in the same position, when that
     parameter changed (a named argument already resolves to its parameter);
   - with no changed parameter, the call links to the function.
5. **Parameters pass a chain on.** Union-find runs over changes: a changed parameter joins
   its declaration with every change that uses it. A local variable does so only within its
   own member, and a brand-new function's parameters don't (calls link to the function).
6. **A changed function, method, field or type starts a chain:** its declaration plus the
   changes that use it. A member's chain and the ripple of its own parameters merge.
7. **Tests follow their calls.** From each declaration a changed test uses, the language
   server's outgoing calls are followed up to 3 levels inside the repository. The test links
   to the first changed function on each path.
8. **A same-change group that names an identifier is a chain.**
9. **Member cohesion.** A chain takes every change of the members it touches.
   - In test files, the member is the enclosing `test(...)`.
   - A comment-only change belongs to the declaration it documents, unless the block holds
     that declaration itself.
10. **New code stays together.**
    - A new or removed type is one chain with its members; a new type declared in a new
      file folds with that file.
    - Chains that never leave a new file are one chain, named after the file's main new
      type (or the file, for tests).
    - A change of a new file that links to nothing joins that file's main chain.
11. **Imports, parts and docs.**
    - A new relative import joins the chains that, in the same file, use declarations from
      the imported file.
    - A `part` directive joins the chains that have changes in its part file.
    - A Markdown change that names a chain's member or declaration in backticks joins that
      chain.
12. **Generated code leads back to its model.** A usage that resolves into generated code
    (`**/generated/**`) links to the change of the model field it was generated from
    (`**/*.spy.yaml`), on either side.
    - Serverpod adapter: generated `Table`, `Include` and `Repository` classes map to the
      model class, and a relation's `…Id` column maps to the relation field.
    - A doc-comment change in the model belongs to the field below it.
13. A chain needs at least two members; same-change chains need two changes. Chains with
    exactly the same changes are one chain. Changes in no chain are listed by file.
14. **Name:** the best declaration inside the chain: what remains before what was removed,
    members and types before parameters and locals, public before private, then the most
    used. In a ripple, the top parameter comes first: the one whose callers don't pass it on
    from a parameter of their own.
15. **Graph:**
    - one node per member;
    - nodes that are all the same change, 3 or more times, collapse into one;
    - arrows go from a change to what it uses;
    - layers are the distance from the root.
16. **Totals:** each chain shows its total diff (+/−) and how many changes are reviewed.

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
3. For Dart, tree-sitter describes each run of changed tokens:
   - **one token replaced by another,** with its role: a reference, a declaration name
     (the language server resolves it to itself), a named argument, a type or a keyword;
   - **otherwise, the smallest run of complete sibling nodes** that covers the run:
     inserted, removed or replaced, keyed by node types and normalized text.
4. An edit is a piece of syntax, not a token run:
   - **runs whose syntax nodes overlap are one edit,** so five changed words in one doc
     comment line are one edit;
   - **a run of punctuation only** (brackets, commas, `!`, quotes, an empty `///`) joins
     an edit of its innermost statement or declaration, and doesn't change that edit's
     description.
5. Edits with the same description form a group. Groups that always occur in the same
   blocks merge. Punctuation alone never forms a group.
   - In languages without a grammar (YAML, Markdown), an edit is described by its whole
     words as written, so `0.0.10 → 0.0.11` is not "10 → 11".
6. A group instance shows each edit's rows, extended to its whole syntax nodes, with one
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
- **Moved code:** the added copy shows "Moved from file:line" and the diff of the two
  bodies. Unchanged moved lines are tinted and long runs of them fold. The removed copy is
  one line, "N lines moved to file:line".
- **Peek:** the definition on top, the changed usages below. Clicking a usage shows its
  code in the peek, with the usage line marked; clicking it again, or "Go to it", opens
  it. "Back to definition" returns. Usage snippets are highlighted like the code.
- **Dark palette** with VS Code Dark+-style syntax colors. Function names are told apart
  from other identifiers.
- **Unified by default, split on demand.** Split pairs removed and added lines per
  change and wraps long lines.

## Numbers on #168 (computed by the prototype)

| | vs main (e0598c1) | vs snapshot at 0540639 |
|---|---:|---:|
| Hand-written files with changes | 66 | 24 |
| Changes | 580 | 265 |
| Edits | 740 | 432 |
| Same-change groups | 33 | 16 |
| Changes with 2+ same-change badges (most on one) | 5 (2) | 1 (2) |
| Chains (across files / within a file) | 54 (31 / 23) | 40 (15 / 25) |
| Changes in a chain / not in a chain | 550 / 30 | 191 / 74 |
| Generated files (lines) | 21 (25,731) | 3 (42) |

Changes went up from 387 because each declaration and each test is now a change of its own.

- **Largest chain:** `OfflineSyncDatabase.mergeChanges`, with 254 changes in 43 files
  (+1,307 −371), drawn as 52 nodes. The 154 identical call-site edits are one node.
- **Removed declarations:** 8 chains start at one, such as
  `− OfflineSyncSpaceManager._cachedCurrentNode` with 12 changes.
- **Old-side language server:** it resolved 1,795 of 1,846 removed-line identifiers
  (main) and 1,223 of 1,246 (snapshot).
- **Model chains:**

  | Chain | Changes | Files |
  |---|---:|---:|
  | `− OfflineSyncSpace.currentNode` | 66 | 18 |
  | `CrdtNode.localUserUuid` | 31 | 11 |
  | `OfflineSyncSpace.lastHlc` | 11 | 6 |

- **Same change, v6 → v7:**

  | | v6 | v7 |
  |---|---:|---:|
  | Edits (vs main) | 822 | 549 |
  | Same-change groups | 53 | 25 |
  | Edits in a group | 395 | 258 |
  | Changes with 2+ badges | 25 | 5 |
  | Most badges on one change | 5 | 2 |
  | Badges in `sync_cached_clock_receive_test.dart` | 38 | 11 |

  Every group with an identifier survived whole: `spaceId → userId` (156, all at
  `mergeChanges` calls), `hlcManagerFor → spaceIdFor` (14), `nodeUuid → .nodeUuidFor(space)`
  (14). What went away was punctuation (`(` ×9, `!` ×6, `,` ×5, `}` ×4, `'` → `"` ×4, empty
  `///` ×8) and self-repeats (one doc-comment line counted 5 times).
- **Chain of chains:** the main family has 37 chains in 6 levels, with the model chains near
  the bottom. Tests use `mergeChanges`, which uses `_transactionAs` and the recorder
  wrappers. Those use the space manager and context locks, which use `_UserClock` and the
  cache fields. Ten chains link to no other.
- **Still outside a chain (30):**

  | Reason | Changes |
  |---|---:|
  | Comment-only edits of members in no chain | 12 |
  | Markdown or YAML naming nothing in a chain | 9 |
  | One-line Dart edits using only unchanged code | 9 |

## Cost of the language servers (measured on #168)

The web app runs one Dart analysis server with both checkouts as workspace folders.

- **Memory:** about 850 MB peak with both checkouts in one server, so the old side adds
  about 210 MB to the head's 640 MB. Two separate servers would need about 1.3 GB (the old
  side alone peaks at 690 MB). This duplicates memory only when an editor already has the
  PR head open.
- **Time:** the batch that builds chains took 106 s for the head side's 8,526 lookups and
  23 s for the old side's 1,846, about 12 ms per lookup with startup. After that, a click
  is one lookup.
- **Disk:** the old checkout is a git worktree sharing objects with the repo: 18 MB of
  source plus 76 KB of `.dart_tool`. Packages come from the shared pub cache (no new ones
  for this commit).
- **The batch runs once per pair of commits:** its answers are cached with the analysis
  (about 500 KB for the old side here), so reopening a review doesn't redo it. Only the
  page's live requests reach the server after that.

- **Tooling limit:** the YAML grammar from `tree-sitter-wasms` doesn't load with
  `web-tree-sitter` 0.25. The `.spy.yaml` and Markdown files fall back to plain token
  edits.

## Where it runs

**A local web app.** A small command-line tool, `review serve`, serves the page on
localhost. It runs git, tree-sitter and the language servers, and the page asks it for
everything else. Any browser can open it: Orca's, VS Code's Simple Browser, or a remote
machine's through a forwarded port.

| | Prototype page (static) | Served by `review serve` |
|---|---|---|
| Go to definition | Answered ahead of time for the identifiers in the diff (about 8,500 on the new side). A definition outside the diff opens as a snippet of up to 10 lines. | Asked live on click, anywhere: whole files, inside a peek, removed lines. |
| Files | Diff hunks only | Any file at either revision |
| Search | Changed lines | Changed lines, plus the repository at either revision (`git grep`) |
| Highlighting | A regex tokenizer, with real rules for Dart and YAML only | [Shiki](https://shiki.style): VS Code's TextMate grammars and its Dark+ theme |
| Review marks | Browser storage | Commits on the reviewed-snapshot branch |

- **The server:**
  - **Git:** diffs, files at either revision, and the reviewed-snapshot branch, with
    mergiraf on a rebase. It is plain git underneath, so git-tree-compare (full mode) or
    `git diff` can show what's left.
  - **Checkouts:** each side is a git worktree that shares objects with the repo (18 MB
    of source for #168), or an existing checkout of the same commit, such as an agent's
    worktree.
  - **Analysis:** the core from `prototype/analyze.js` (edits, same-change groups, chains
    and the chain map), cached per pair of commits.
  - **Language server:** one Dart analysis server with both checkouts as workspace
    folders. It answers the batch that builds chains, then the page's live requests.
  - **Stack:** TypeScript on Node, reusing this prototype, web-tree-sitter, Shiki and
    `vscode-jsonrpc`, the LSP layer VS Code is built on.
  - **Access:** localhost only, with a random token in the URL, as Jupyter does.
- **Open in editor:** every location links to the editor, `vscode://file/<path>:<line>`
  by default, or a command you configure.
- **Static export:** `review export` writes the page as one HTML file with everything
  computed ahead, as this prototype is, for sharing a review read-only.
- **Later:**
  - **Editor extensions** that show the same page in a webview and add open in editor.
    Sapling's [Interactive Smartlog](https://sapling-scm.com/docs/addons/isl) works this
    way: `sl web` opens it in a browser, and Sapling's VS Code extension embeds it.
  - **Agents** can read the same JSON API the page uses: what's left, and which chain a
    change belongs to.

## Build order

1. **Snapshot CLI:** `review mark`, `status`, and `rebase` with mergiraf, on a local
   branch. git-tree-compare and `git diff` show what's left from day one.
2. **Analysis core:** tree-sitter edits, same-change groups, chains and the chain map from
   the language servers, as in `prototype/analyze.js`, cached per pair of commits.
3. **Local web app:** `review serve`, the page served live. Go to definition on both
   sides, whole files, repository search, Shiki highlighting, open in editor, and marks
   written to the snapshot branch. `review export` writes the same page as one HTML file,
   for sharing a review read-only.
4. **Later:** a VS Code extension around the same page, the API for agents, sharing
   snapshots with teammates, and syncing GitHub's viewed checkboxes.

## Open questions

- **Q1.** Member cohesion makes chains complete but larger
  (`− OfflineSyncSpace.currentNode` reaches 66 changes). Should it stay?
- **Q2.** Model adapters: should each generator ship one (Serverpod, freezed,
  json_serializable, protobuf), or should the mapping be declared in `.review.yaml`?
- **Q3.** How should chains inside a family be ordered: by level, or by what is left to
  review?
- **Q4.** For large graphs, should busy levels collapse into "+N more", or should nodes be
  grouped by file?
- **Q5.** Should a same change also need the same symbol? `userId → spaceId` as a
  declaration is one group of six different parameters. Requiring the language server to
  resolve each instance to the same declaration would split it into six, but it would
  also split a class rename from its constructor calls and an interface method from its
  override.
- **Q6.** Overrides: in #162 a test double overrides the same new `watch` method as the
  real database, and nothing links the two. Should changes that override the same method
  join one chain?

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
- **v5:** old-side language server, map first.
  - Feedback: link generated code to its YAML model, and measure the cost of the second
    server.
- **v6:** model links, measured cost of the second server.
  - Feedback: "same change" triggers too much.
- **v7:** stricter same change.
  - Feedback: make the first version a web page instead of a VS Code extension, so it
    runs anywhere, including Orca's browser.
- **v8:** a local web app instead of a VS Code extension.
  - Decided: one language server with both checkouts, and TypeScript for the server.
  - Feedback: preview a changed usage inside the peek, highlighted, and go to it on a
    second click.
- **v9:** usage previews in the peek.
  - Asked: how hard-coded is it to #168? The rules ran unchanged on #157, #166 and #162 and
    found seven problems ([02-test-runs.md](02-test-runs.md)).
  - Feedback: fix all of them.

## References

- [sem](https://github.com/Ataraxy-Labs/sem): entity-level diff, `impact`, `certify`.
- [inspect](https://github.com/Ataraxy-Labs/inspect): change classification and untangling.
- [dart_source_graph](https://pub.dev/packages/dart_source_graph): Dart dependency graph
  with resolved calls and references.
- [CG-Diff, arXiv 2609.32057](https://arxiv.org/abs/2609.32057): organizing PRs around
  call graphs.
- [mergiraf](https://mergiraf.org): syntax-aware git merge driver.
- [Shiki](https://shiki.style): syntax highlighting with VS Code's TextMate grammars, in
  the browser.
- [Sapling Interactive Smartlog](https://sapling-scm.com/docs/addons/isl): a local web UI
  (`sl web`) that its VS Code extension embeds.
- [git-tree-compare](https://marketplace.visualstudio.com/items?itemName=letmaik.git-tree-compare):
  compares the working tree against any branch, tag or commit; has a full diff mode.
