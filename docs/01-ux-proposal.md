# UX proposal v13: start from the chain map, end in the code

> Draft v13, 2026-10-14. Replaces v12 (see "History" at the end).
> Starting point: [00-original-prompt.md](00-original-prompt.md).
> Working prototype on serverpod_offline_sync #168: https://claude.ai/artifact/MEkRBmhVGgqBPUB5QYAFVB (version 14).
> Prototype sources: [prototype/](prototype/).
> Test runs of these rules on #157, #166, #162 and four Serverpod PRs: [02-test-runs.md](02-test-runs.md).

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

From the review of v10:
- **Changes that override the same method join one chain** (Q6).

From the review of v11:
- **Adopt the proposed answers to Q1–Q5.**

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
11. **Overrides:** changed methods that override the same method join one chain.
12. **Member cohesion:** only for changes no other rule links. A chain shows the rest of its
    members folded, as context.
13. **Model adapters:** one per generator, built in and switched on by what the repository
    contains; `.review.yaml` can turn one off, add generated patterns or declare a mapping.
14. **Chain order:** by level, never by review progress, with a "next unreviewed" action.
15. **Large graphs:** a test file's tests are one node; code stays one node per member;
    "+N more" only when a level is still too busy.
16. **Same change across declarations:** syntax only; the group view shows the declaration
    each place resolves to, and each can be marked on its own.
17. **Names in strings:** a string that looks like a name links like one, beyond what the
    language server sees.
18. **The CLI is `untangle`,** used like px0: `untangle [flags] [directory | pr-url]`.
    Serving the review comes first.

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
   changes that use it.
   - A member's chain and the ripple of its own parameters merge.
   - A field and the constructor parameter that sets it (`this.field`) are one declaration:
     the field's chain is the constructor's chain.
7. **Tests follow their calls.** From each declaration a changed test uses, in production
   code or in an unchanged test helper, the language server's outgoing calls are followed
   breadth first, up to 3 levels inside the repository. The test links to the first changed
   function on each path, whether its signature or its body changed.
   - A test is a `*_test.dart` file, or a file under a `test*/` or `integration_test/`
     directory.
8. **A same-change group that names an identifier is a chain.**
9. **Member cohesion.** A change that no other rule links joins the chains of its member.
   Changes that already belong to a chain stay out of other chains.
   - In test files, the member is the enclosing `test(...)`.
   - A comment-only change belongs to the declaration it documents, unless the block holds
     that declaration itself.
10. **New code stays together.**
    - A new or removed type is one chain with its members; a new type declared in a new
      file folds with that file.
    - Chains that never leave a new file are one chain, named after the file's main new
      type (or the file, for tests).
    - A change of a new file that links to nothing joins that file's main chain.
    - The field chains of a new YAML model are one chain per model, as for a new type.
11. **Overrides.** The language server says what each changed method overrides
    (`dart/textDocument/super`).
    - Changed methods that override the same method, a framework's say, join one chain.
    - An override of a changed method links to it.
    - The members of `Object` (`toString`, `==`, `hashCode`) are left out.
12. **Imports, parts and docs.**
    - A new import of a file in the repository joins the chains that, in the same file, use
      declarations from the imported file. A `package:` import counts when the package is in
      the repository; with two pubspecs of the same name, it resolves to the one that has
      the file.
    - An import prefix (`as p`) starts no chain: its import joins the chains that use the
      prefix.
    - A `part` directive joins the chains that have changes in its part file.
    - A Markdown change that names a chain's member or declaration in backticks joins that
      chain.
13. **Names in strings.** A string on a changed line, or a backticked span in Markdown, that
    looks like a name: 4 to 80 characters of letters, digits, `_`, `.` or `-`, with a capital
    after the first letter, an underscore, a dot, a dash or a digit.
    - It links to the changed declaration with that name, when there is one.
    - Otherwise, when two or more changes introduce it and one of them is code, they are a
      chain named after the string (`“tail_runner_logs”`).
    - Strings with `$` interpolation are left out, and so is a string in more than 15
      changes.
14. **Generated code leads back to what it was generated from,** through an adapter per
    generator. Each switches on by what the repository contains, on either side of the diff:
    - **Serverpod** (`*.spy.yaml`, `*.spy.yml`, `*.spy`): generated `Table`, `Include` and `Repository` classes map
      to the model class, a field to the model field, and a relation's `…Id` column to the
      relation. A doc-comment change in the model belongs to the field below it.
    - **Generated part files** (`*.g.dart`, `*.freezed.dart`: freezed, json_serializable,
      built_value and the like): `_$User`, `$UserCopyWith` and `_User` map to `User` in the
      library that owns the part, and their members to `User`'s members or constructor
      parameters.
    - **Protobuf** (`*.proto`): a generated message class maps to its message, and a getter
      or its `has`/`clear`/`ensure` accessor to the field in snake_case.
    - **`.review.yaml`** at the repository root can add `generated:` patterns, turn an
      adapter on or off (`adapters:`), and declare YAML-model mappings of its own (`models:`,
      with `generated`, `source` and `classSuffixes`).
15. A chain needs at least two members; same-change chains need two changes. Chains with
    exactly the same changes are one chain. Changes in no chain are listed by file.
16. **Name:** the best declaration inside the chain: what remains before what was removed,
    members and types before parameters and locals, public before private, then the most
    used. In a ripple, the top parameter comes first: the one whose callers don't pass it on
    from a parameter of their own.
17. **Graph:**
    - one node per member;
    - nodes that are all the same change, 3 or more times, collapse into one;
    - the tests of one test file are one node;
    - arrows go from a change to what it uses;
    - layers are the distance from the root.
18. **Totals:** each chain shows its total diff (+/−) and how many changes are reviewed.

### Chain of chains

- A chain's **core** is the changes of its root's member, or all its changes when it has
  no root.
- **Chain A uses chain B** when A's core uses a function, method, field or type in B's
  core.
- **Depth** is the longest path from a chain that nothing uses, ignoring back edges of
  cycles.
- **Families** are chains connected by "uses" or by shared changes.
- **The chain map** lays a family out by depth:
  - it draws only direct dependencies (a transitive reduction);
  - arrows that skip levels are faint;
  - one dashed line joins each group of chains connected by "uses" to the chain it shares
    the most changes with.

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

- A file is generated when `.gitattributes` marks it `linguist-generated`, when an active
  adapter's patterns match it (Serverpod's `generated/` and `migrations/`, `*.g.dart`,
  `*.freezed.dart`, `*.pb.dart` and the like), or when it matches `generated` patterns in
  `.review.yaml`.
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
- **More of the file, as on GitHub.** The band above a hunk is its header and stands for the
  lines hidden above it. Clicking it shows 20 more, up from the hunk or down from the one
  before, or all of them when 20 or fewer are left; a band after the last hunk shows the rest.
  A chain section grows the same way, across hunks and the lines between them. The map icon
  shows the whole file around the diff, read-only, with go to definition on every name.
- **A view's tools** are icons, as VS Code's diff editor has them: open in the editor,
  previous and next change, the whole file or only its changed chunks, inline or side by side.
- **The Files tab is a folder tree,** folders first, with a folder that holds only one folder
  shown with it (`lib/src/mcp`), as VS Code compacts them.
- **Clicking a graph node** shows only that node's code and dims unrelated nodes.
- **Chain order:** chains keep the map's order, by level and larger first. Reviewed chains
  stay in place, muted. "Next unreviewed" (key `n`) walks the same order.
- **Test files in a chain:** a test file's tests are one node in the graph. A chain made only
  of one test file lists its tests by `group(...)` instead of drawing a graph.
- **The rest of a member:** a chain section folds the member's other changes, which belong to
  other chains ("3 more changes in this member, in other chains").
- **Same change by declaration:** the group view lists its places under the declaration each
  resolves to ("6 places · 6 declarations"), with marking per declaration.
- **Moved code:** the added copy shows "Moved from file:line" and the diff of the two
  bodies. Unchanged moved lines are tinted and long runs of them fold. The removed copy is
  one line, "N lines moved to file:line".
- **Peek:** the definition on top, the changed usages below. Clicking a usage shows its
  code in the peek, with the usage line marked; clicking it again, or "Go to it", opens
  it. "Back to definition" returns. Usage snippets are highlighted like the code.
- **Dark palette** with VS Code Dark+-style syntax colors. Function names are told apart
  from other identifiers.
- **Unified by default, split on demand** from a view's tools. Split pairs removed and added
  lines per change and wraps long lines.

## Numbers on #168 (computed by the prototype)

| | vs main (e0598c1) | vs snapshot at 0540639 |
|---|---:|---:|
| Hand-written files with changes | 66 | 24 |
| Changes | 580 | 265 |
| Edits | 740 | 432 |
| Same-change groups | 33 | 16 |
| Changes with 2+ same-change badges (most on one) | 5 (2) | 1 (2) |
| Chains (across files / within a file) | 62 (39 / 23) | 50 (24 / 26) |
| Changes in a chain / not in a chain | 551 / 29 | 192 / 73 |
| Generated files (lines) | 21 (25,731) | 3 (42) |

Changes went up from 387 because each declaration and each test is now a change of its own.

- **Largest chain:** `OfflineSyncDatabase.mergeChanges`, with 253 changes in 45 files
  (+1,312 −372), drawn as 40 nodes. The 154 identical call-site edits are one node, and so
  are each test file's tests.
- **Removed declarations:** 8 chains start at one, such as
  `− OfflineSyncSpaceManager._cachedCurrentNode` with 7 changes.
- **Old-side language server:** it resolved 1,795 of 1,846 removed-line identifiers
  (main) and 1,223 of 1,246 (snapshot).
- **Model chains:**

  | Chain | Changes | Files |
  |---|---:|---:|
  | `− OfflineSyncSpace.currentNode` | 48 | 18 |
  | `CrdtNode.localUserUuid` | 22 | 11 |
  | `OfflineSyncSpace.lastHlc` | 9 | 6 |

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
- **Chain of chains:** the main family has 61 chains in 7 levels, 10 of them joined only by
  shared changes, with the model chains at the bottom. Tests use `mergeChanges`, which uses
  `transactionForUser`. That one uses the recorder's `getOrCreateUserNode` and the
  `userId → spaceId` group, which lead through `_initializeOnce` to the space manager's
  `getOrCreateUserNode`, and that one uses the model chains and the cache fields. One chain
  links to no other.
- **Member cohesion (Q1):** limiting it to changes no rule links keeps the same 550 changes in
  chains and shrinks the chains it used to inflate: `− OfflineSyncSpace.currentNode` 66 → 48,
  `_transactionAs` 54 → 38, and chain memberships 1,014 → 869.
- **Adapters (Q2):** `prototype/make_fixture.sh` builds a three-commit repo with a
  freezed-style part file and a protobuf message. Both new fields link to the code that
  reads them through the generated files (`User(email)`, `Account.billing_email`), and the
  third commit's `.review.yaml` turns protobuf off, so `.pb.dart` is reviewed as normal
  code.
- **Still outside a chain (29):**

  | Reason | Changes |
  |---|---:|
  | Comment-only edits of members in no chain | 12 |
  | Markdown or YAML naming nothing in a chain | 8 |
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

**A local web app.** A small command-line tool, [`untangle`](../README.md), serves the
page on localhost. It runs git, tree-sitter and the language servers, and the page asks it
for everything else. Any browser can open it: Orca's, VS Code's Simple Browser, or a remote
machine's through a forwarded port. It works like px0: one command,
flags in Go's style, and the target is a directory or a pull request URL.

```
untangle [flags] [directory]   # the branch's pull request, found with gh (default: .)
untangle [flags] <pr-url>      # cloned into the cache first
```

| | Prototype page (static) | Served by `untangle` |
|---|---|---|
| Go to definition | Answered ahead of time for the identifiers in the diff (about 8,500 on the new side). A definition outside the diff opens as a snippet of up to 10 lines. | Asked live on click, anywhere: whole files, inside a peek, removed lines. |
| Files | Diff hunks only (a chain section grows within its hunk) | The whole file around its diff, and any file at either revision |
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
    folders. It answers the batch that builds chains, then the page's live requests. Like
    an editor, it only analyzes the packages of open files, and untangle opens the files
    it asks about: on #157, 2,444 lookups took 10 s instead of 123 s with the same answers.
  - **Stack:** TypeScript on Node, reusing this prototype, web-tree-sitter, Shiki and
    `vscode-jsonrpc`, the LSP layer VS Code is built on.
  - **Access:** localhost only, with a random token in the URL, as Jupyter does.
- **Open in editor:** file headers and peeks link to the editor, `vscode://file/<path>:<line>`
  by default, or a command you configure.
- **Static export:** `untangle -export` writes the page as one HTML file with everything
  computed ahead, as this prototype is, for sharing a review read-only.
- **Later:**
  - **Editor extensions** that show the same page in a webview and add open in editor.
    Sapling's [Interactive Smartlog](https://sapling-scm.com/docs/addons/isl) works this
    way: `sl web` opens it in a browser, and Sapling's VS Code extension embeds it.
  - **Agents** can read the same JSON API the page uses: what's left, and which chain a
    change belongs to.

## Build order

Serving the review came first. Steps 2 and 3 are done in `untangle`, and step 1 is done
through the page.

1. **Snapshot (done, through the page):** marks are commits on a local branch,
   `untangle/pr-<number>`, the base plus every change marked reviewed. A rebase replays the
   branch with mergiraf, then git's line merge; what still conflicts goes back to unreviewed.
   git-tree-compare and `git diff` show what's left. No separate `mark` or `status` command
   yet.
2. **Analysis core (done):** tree-sitter edits, same-change groups, chains and the chain
   map from the language server, as in `prototype/analyze.js`, cached per pair of
   commits. untangle's pipeline gives the prototype's answers exactly, step by step, on
   the eight PRs ([02-test-runs.md](02-test-runs.md)).
3. **Local web app (done):** `untangle` serves the page with progress while it builds, go to
   definition asked live on both sides (whole files, peeks, removed lines), whole files at
   either side or outside the repository, repository search, Shiki highlighting, open in
   editor, marks on the snapshot branch, and generated diffs loaded on demand. `-export`
   writes the same page as one HTML file, for sharing a review read-only.
4. **Later:** a VS Code extension around the same page, the API for agents, sharing
   snapshots with teammates, and syncing GitHub's viewed checkboxes.

## Open questions

1. **Families and shared tests.** Chains that share changes are one family since v13. Most
   shared changes are tests that reach two chains, so on a large PR almost everything is one
   family: 61 of #168's 62 chains, and all 14 of #166's. The map shows each such join as one
   dashed line. Keep counting shared tests, or count only shared changes outside tests? That
   would leave #168 with 4 families, #166 with 5 and Serverpod #5471 with 10, and #5864's
   feature would stay one family.
   - *Suggestion:* keep them. The dashed lines say why chains are together, and every chain
     gets a place on a map; in v12, 15 of #168's chains were on none.

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
- **v10:** the fixes, with the three PRs in the viewer.
  - Decided: overrides of the same method join one chain (Q6).
- **v11:** overrides as one chain.
  - Decided: Q1–Q5 as proposed (cohesion only for unlinked changes, adapters per generator,
    chain order by level, tests grouped by file in graphs, same change by syntax with
    declarations shown).
- **v12:** Q1–Q5 applied.
  - Asked: run the rules on four Serverpod PRs, a much larger repository. They found nine
    problems ([02-test-runs.md](02-test-runs.md)).
  - Feedback: fix all nine as proposed.
- **v13:** the nine fixes.
  - Asked: build the CLI, focused on serving the review, with px0's UX: a directory or a pull
    request URL, cloned into a temporary place. Named `untangle`; clones go to a cache, so the
    next pull request of the same repository only fetches.
  - Asked: the rest of the local web app (live go to definition, whole files, repository
    search, Shiki, open in editor, marks on the snapshot branch, `-export`). Done in
    `untangle`.
  - Asked: bands that show more of the file, as GitHub's; the file whole in the page,
    read-only, with go to definition, and a switch back to the changed chunks; VS Code's
    icons for a view's tools, with unified/split moved there; the Files tab as a tree. Done.

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
