# untangle

Review a pull request chain by chain, in your browser.

untangle opens a review on a map of chains: each chain follows one change across files (a new
parameter, the calls that now pass it, the function that had to take a parameter in turn). Every
chain, group and count comes from fixed rules over git, tree-sitter and the Dart analysis server.
The rules and the design are in [docs/01-ux-proposal.md](docs/01-ux-proposal.md).

```
untangle [flags] [directory]
untangle [flags] <pr-url>
```

- **A directory** (default `.`) reviews the pull request of its current branch, found with `gh`.
  Without one, it reviews what the branch adds to the default branch, or to `-base <branch>`.
- **A pull request URL** (`https://github.com/<owner>/<repo>/pull/<number>`) is cloned first. The
  clone is kept in the cache, so the next pull request of the same repository only fetches.

untangle serves the review on `127.0.0.1` and opens your browser. The link carries a token, as
Jupyter's does. An open page keeps working after untangle stops, but marks are only saved while
it runs.

## Install

Needs Node 22 or later, git 2.40 or later, and the Dart SDK (`dart` on `PATH`; Flutter's works).
`gh` is optional: it finds a directory's pull request and reads private repositories. Without it,
GitHub's public API answers for public ones.

```
npm install
npm run build
npm link        # puts `untangle` on PATH
```

## What it does

1. **Checkouts.** The base side (the merge base) is a git worktree that shares objects with the
   repository. The head side is the directory itself when nothing in it is uncommitted and its
   packages are resolved; otherwise a worktree too. Worktrees get `dart pub get` (or `flutter pub
   get`); untangle never runs it in your own checkout.
2. **Language server.** One Dart analysis server opens both checkouts. It answers where every
   identifier on a changed line is defined (on both sides), what changed tests call, and what
   changed methods override. Like an editor, it only analyzes the packages the review touches.
3. **Analysis.** The rules in [analysis/analyze.js](analysis/analyze.js) build edits, same-change
   groups, chains and the chain map.
4. **Serving.** The page shows progress while the review builds, then the review. Review marks are
   saved by untangle, next to the analysis. Generated files load their diffs when you open them.

The first review of a pair of commits takes from a few seconds to a few minutes, mostly the
language server. Its answers and the analysis are cached per pair of commits, so opening the
same review again is immediate.

## Flags

| Flag | |
|---|---|
| `-base string` | compare with this branch or commit instead of the pull request's base |
| `-base-path string` | URL path prefix to serve from (e.g. `/rev-123/`), behind a proxy |
| `-host string` | address to bind (default `127.0.0.1`) |
| `-port int` | port (default `7778`; a busy default falls back to a free one; `0` picks one) |
| `-no-open` | do not launch a browser |
| `-no-cache` | build the review again, even when it is cached |
| `-quiet` | print only the review's URL |
| `-verbose` | log the language server, `pub get` and requests |
| `-no-color` | disable colour output |
| `-v`, `-version` | print the version |

## Cache

`~/.cache/untangle` (`$XDG_CACHE_HOME`, `~/Library/Caches` on macOS, `%LOCALAPPDATA%` on Windows;
`UNTANGLE_CACHE` overrides it):

- `repos/`: clones made for pull request URLs (bare, blobs on demand).
- `worktrees/`: checkouts of base and head commits. A worktree of your own repository is listed
  by `git worktree list`; `git worktree remove` or deleting the folder is safe.
- `reviews/`: per pair of commits, the language server's answers (`answers.json`), the review
  (`review.json`) and your marks (`state.json`).

## Layout

| Path | |
|---|---|
| `src/` | The CLI, the server and the pipeline, in TypeScript |
| `analysis/` | The analysis rules (`analyze.js`) and the generated-code adapters, shared with the prototype |
| `viewer/` | The page: `index.html`, `viewer.js`, and `core.js` (the tokenizer and diff, used by both sides) |
| `docs/` | The UX proposal, the test runs, and the prototype pipeline that produced them |
