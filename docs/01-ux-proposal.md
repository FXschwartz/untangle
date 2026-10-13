# UX proposal v2: the diff you haven't reviewed yet

> Draft v2, 2026-10-13. Replaces v1 (see "Changes from v1" at the end).
> Starting point: [00-original-prompt.md](00-original-prompt.md).
> Working prototype on serverpod_offline_sync #168: https://claude.ai/artifact/MEkRBmhVGgqBPUB5QYAFVB (version 2).
> Prototype sources: [prototype/](prototype/).

## Requirements (from the review of v1)

- **A view of the diff, not a report.** Opening it must not ask a model to write anything.
  The same diff always produces the same view.
- **No analysis written for one PR, and no inferred trust levels.** v1's "reproduced /
  matched / declared / outlier" tiers are dropped because they are hard to make systematic.
- **Must have:** syntax highlighting, go to definition, search.

## The idea

The left side of the diff is your **reviewed snapshot**, not the base branch. The snapshot
is a git commit holding the base plus every change you have marked reviewed. The viewer
always shows `diff(snapshot → PR head)`:

- Marking a change reviewed applies it to the snapshot, so it leaves the diff.
- A new push brings back only what changed since you reviewed it.

Everything else the viewer hides or groups follows the fixed rules below.

## Four rules

### Rule 1: Reviewed snapshot

Pain: a viewed file resets whenever it changes, and you have to hunt for the new part.

- Your review state is a commit, stored as a branch (for example `review/168`) or under
  `refs/reviews/<pr>/<user>`.
- **Mark reviewed** applies the hunk, or a smaller edit, to the snapshot.
- **New commits** move the head and leave the snapshot alone:
  - A reviewed region that didn't change has no diff.
  - A region that changed shows the diff from what you reviewed to what is there now.
- **Rebase** replays the snapshot onto the new base with a 3-way merge (`git merge-file`
  semantics). Regions that conflict go back to unreviewed.
- **Any diff tool works.** `git diff review/168 pr/168` shows what is left.
  git-tree-compare can compare against any branch in its full (non-merge-base) mode, so
  it could show the remaining review without new UI.

### Rule 2: Repeated edits

Pain: a changed signature rewrites the same thing at every call site.

1. Split each hunk into change blocks: runs of `-`/`+` lines between context lines.
2. Tokenize each block with the grammar used for highlighting (tree-sitter in the real
   core) and drop whitespace.
3. Diff the token sequences with an LCS. When choosing between equal-length matches,
   prefer deleting first, so the result never changes. Two rules decide what counts as
   the same token:
   - words inside comments and strings are tagged with their kind, so they never match
     code;
   - brackets carry their nesting depth, so a `)` only matches the `)` that closes the
     same level.
4. An **edit** is a maximal run of removed and added tokens between unchanged tokens. An
   edit whose removed and added text is identical (a bracket whose depth changed) is
   dropped.
5. **Key** = language + removed tokens + added tokens. Edits with the same key form a
   group of at least two.
6. Groups whose edits always occur in the same blocks merge into one group of edits that
   always appear together.
7. Marking a group reviewed marks every one of its edits. A block is reviewed when all of
   its edits are.

### Rule 3: Changed usages

Pain: a new parameter means a different argument at each call site, so rule 2 can't group
those edits.

For each declaration on an added line, ask the language server for its references. Keep
the references that fall on added lines in other change blocks. They are listed under the
declaration and can be marked reviewed together.

### Rule 4: Generated files

Pain: generated files still sit in the file list and the counts.

- A file is generated when `.gitattributes` marks it `linguist-generated`, or when it
  matches a `generated` pattern in the review config.
- Generated files are listed with their size, and they are never diffed or counted.
- `reviewedWith` (optional) marks them reviewed once every changed source file matching a
  pattern is reviewed.

```yaml
# .review.yaml
generated:
  - "**/migrations/**"     # adds to .gitattributes
reviewedWith:
  "**/migrations/**": "**/*.spy.yaml"
```

### Two fixed filters

- Blocks whose tokens are identical once whitespace is ignored (changes that only move
  whitespace or line breaks) are always hidden.
- A toggle hides blocks whose remaining edits only touch comments.

## Numbers on #168 (computed by the prototype)

| | vs main (e0598c1) | vs snapshot at 0540639 |
|---|---:|---:|
| Hand-written files with changes | 66 | 24 |
| Change blocks | 387 | 180 |
| Changed lines | 4,200 | 2,604 |
| Repeated-edit groups (same tokens) | 48 | 28 |
| Blocks covered by groups | 226 | 34 |
| Lines in those blocks | 542 | 97 |
| Comment-only blocks | 24 | 49 |
| Whitespace-only blocks | 0 | 0 |

- **Largest group:** `spaceId → userId`, 157 places in 32 files. Requiring the same next
  token as well gives 156; the extra one is the `spaceId ??` line inside `mergeChanges`.
- **Changed usages** (Dart language server):
  - `userId` of `mergeChanges`: 173.
  - `userId` of `mergeInboundBatch`: 9.
- **Generated files:** 21, totalling 25,731 lines. Ten come from `.gitattributes`. The
  other 11 come from the config pattern; these are the test migrations, which
  `.gitattributes` marks `linguist-generated=false`.
- **Go to definition:** the Dart analysis server resolved 8,260 of the 8,526 identifiers
  on the head side of the diff, in 89 s.

## Where it runs

- **VS Code extension first**, on top of a core CLI/library. The three must-haves come from
  the editor:
  - **Syntax highlighting:** the editor's grammar on both sides of the diff.
  - **Go to definition:** the right side of the diff is the real file in a checkout of the
    PR head, so the project's language server handles definition, references and hover.
    The left side is the read-only snapshot.
  - **Search:** the editor's own search covers the repository. The extension adds a search
    over unreviewed changes only.
- **Core:** keeps the snapshot and computes groups, usages and generated files. Commands:
  `status`, `mark`, `unmark`, `rebase`, `groups`. Plain git underneath.
- **Extension:** a review tree (files, repeated edits, generated files), the multi-file
  diff editor with the snapshot on the left, mark actions on hunks, and the peek view for
  groups and changed usages.
- **Nothing else:** no server, no model, and no index beyond the language server the
  editor already runs.

## Build order

1. **Snapshot CLI:** `review mark <file>[:<hunk>]`, `review status` and `review rebase`,
   with the snapshot as a branch. Usable with git-tree-compare and `git diff` right away.
2. **Groups and generated files in the core:** `review groups` and
   `review mark --group`, plus the `.review.yaml` rules.
3. **VS Code extension:** the tree, the diff against the snapshot, mark actions, peek,
   search in unreviewed changes, and changed usages.
4. **Sharing:** push snapshots so teammates and agents can see what was reviewed, and
   optionally sync GitHub's viewed checkboxes.

## Open questions

- **Q1.** What counts as the same edit? Same tokens (157), same tokens plus the next
  token (156), or tree-sitter node types?
- **Q2.** Rebase conflicts: should a conflicting region go back to unreviewed, or keep
  the old review and get a flag?
- **Q3.** Where do snapshots live: a local branch only, pushed `refs/reviews/*`, or
  mirrored to GitHub's viewed checkboxes?
- **Q4.** Should marking a declaration reviewed offer to mark its changed usages in one
  click, or always go through the list?
- **Q5.** Is `reviewedWith` worth it, or should generated files simply never need review?
- **Q6.** Is go to definition on removed lines needed in v1? It needs a base checkout and
  a second language-server run.
- **Q7.** Should the diff be unified or side by side by default?

## Changes from v1

v1 made each change a decision or a consequence and folded consequences under trust tiers
(reproduced / matched / declared / outlier). Its mockups contained analysis written by hand
for #168: a schema summary of the migrations, a cross-check against the PR description,
and judgments about specific call sites.

The v1 review rejected that approach:
- it reads like a report that would need a model to regenerate on every change;
- the trust tiers are hard to make systematic;
- it lacked code navigation.

v2 keeps the goals and replaces the mechanisms with the fixed rules above.

## References

- [sem](https://github.com/Ataraxy-Labs/sem): entity-level diff, `impact`, `certify`.
- [inspect](https://github.com/Ataraxy-Labs/inspect): change classification and untangling.
- [dart_source_graph](https://pub.dev/packages/dart_source_graph): Dart dependency graph
  with resolved calls and references.
- [CG-Diff, arXiv 2609.32057](https://arxiv.org/abs/2609.32057): organizing PRs around
  call graphs.
- [git-tree-compare](https://marketplace.visualstudio.com/items?itemName=letmaik.git-tree-compare):
  compares the working tree against any branch, tag or commit; has a full diff mode.
