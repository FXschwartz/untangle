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

untangle serves the review on `127.0.0.1` and opens it: in Orca's browser when it runs in one
of Orca's terminals (a tab in that terminal's worktree), else in your default browser; `BROWSER`
overrides both. The link carries a token, as Jupyter's does. An open page keeps working after untangle stops, but marks are only saved while
it runs.

## Install

Needs Node 22 or later, git 2.40 or later, and the Dart SDK (`dart` on `PATH`; Flutter's works).
`gh` is optional: it finds a directory's pull request, reads private repositories, and carries the
pull request's comments and reviews. untangle asks GitHub through `gh`, as your own login, so it
never handles a token. Without `gh`, GitHub's public API answers for public repositories, without
comments.

```
npm install
npm run build   # the TypeScript, and the highlighter bundle (dist/highlight.js)
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
4. **Serving.** The page shows progress while the review builds, then the review. The language
   server stays up for the page's live requests.

The first review of a pair of commits takes from a few seconds to a few minutes, mostly the
language server. Its answers and the analysis are cached per pair of commits, so opening the
same review again is immediate.

## In the page

- **Go to definition anywhere.** Names on changed lines answer at once (computed ahead). Any
  other name, in a whole file, inside a peek or on a removed line, asks the language server;
  in a peek, clicking a name moves the peek there and Back returns.
- **More of the file.** The band above each hunk stands for the lines hidden above it: click it
  for 20 more (up from the hunk, or down from the one before), or all of them when 20 or fewer
  are left, as on GitHub. The band after the last hunk shows the rest of the file. Chain views
  grow the same way. An exported page grows only within hunks.
- **Whole files.** A file's map icon shows the whole file around its diff, and back to the
  changed chunks. "Open file" in a peek or a search result opens a changed file that way, at
  the line; any other file, at either side or outside the repository (a package, the SDK),
  opens on its own with the lines the review changes marked. Names in them go to definition.
- **Tools** in each view's header, with VS Code's icons: open in the editor, previous and next
  change, the whole file or only its changed chunks, and inline or side by side.
- **The Files tab** is a folder tree, folders first; a folder holding only one folder shows with
  it (`lib/src/mcp`), as VS Code compacts them.
- **Search** the changed lines, or the whole repository at the head or the base (`git grep`).
- **Highlighting** with [Shiki](https://shiki.style): VS Code's grammars and its Dark+ theme.
  Names a grammar leaves plain (variables, properties, parameters) are colored as VS Code's
  semantic highlighting does.
- **Status bar:** whether the language server is up, and untangle's and the language server's
  memory and CPU (hover for the details), as px0 shows them.
- **Open in editor** from a view's tools and from peeks: a `vscode://` link by default (through WSL
  when untangle runs there), or `-editor` with a command such as `code -g {file}:{line}:{col}`
  or a URL template such as `cursor://file{file}:{line}:{col}`.
- **The pull request's comments, as on GitHub** (through `gh`): threads under the lines they're
  on, with replies, reactions and suggestions; the Comments tab lists the open and resolved ones,
  and the conversation (the description, comments and reviews).
  - **Writing:** the **+** over a line's number starts a comment; drag it over more lines of the
    hunk (or shift-click another line's) for a range. "Add single comment" posts it now; "Start a review" keeps it, and
    the comments after it, in your pending review. Write and Preview, Ctrl+Enter, and
    "Suggest a change" for lines on the new side. Comment on a whole file from its tools.
  - **Threads:** reply, resolve and unresolve, edit and delete your comments, react. A reviewed
    hunk stays open while a conversation in it is.
  - **Finishing:** "Finish your review" in the top bar submits it as a comment, an approval or a
    request for changes, or discards it.
  - What you type is kept in the browser until it's sent. The page checks GitHub every minute.
    When the pull request has newer commits than the review, comments on lines wait for a
    refresh; replies, file comments and reviews don't.
- **Refreshing without a restart.** When the pull request (or the branch) gets new commits, a
  banner offers to refresh, as GitHub does; the button next to the title looks for them anytime.
  untangle builds the new review while the page keeps working on the current one, then the page
  reloads on the same view, with marks carried over and unsent comments kept. A page left on the
  old review, in another tab, is told to reload instead of saving marks onto the new one.
- **Marks on a branch.** Your review is a local git branch, `untangle/pr-<number>` (or
  `untangle/<branch>`): the base plus every change you marked reviewed, a commit per save.
  `git diff untangle/pr-123 <head>` shows what's left. Marks come back from the branch's
  content, so a new push to the pull request only brings back what changed since you looked.
  When the base moves (a rebase), the branch is replayed onto the new base with a 3-way merge,
  [mergiraf](https://mergiraf.org) first when it's installed; what still conflicts goes back to
  unreviewed. For a URL, the branch lives in the cached clone; for a directory, in your
  repository. Marks on part of a change stay next to the analysis.

`-export review.html` writes the same page as one HTML file, for sharing a review read-only:
everything computed ahead, marks kept in the reader's browser, and the generated diffs that fit
in 1 MB.

## Flags

| Flag | |
|---|---|
| `-base string` | compare with this branch or commit instead of the pull request's base |
| `-base-path string` | URL path prefix to serve from (e.g. `/rev-123/`), behind a proxy |
| `-editor string` | a command or URL template to open locations with; `{file}`, `{line}` and `{col}` are replaced (also `UNTANGLE_EDITOR`) |
| `-export string` | write the review to this HTML file and exit |
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
  (`review.json`), and marks on parts of a change with the layout (`state.json`). Whole marks
  live on the review's branch.

## Layout

| Path | |
|---|---|
| `src/` | The CLI, the server and the pipeline, in TypeScript |
| `analysis/` | The analysis rules (`analyze.js`) and the generated-code adapters, shared with the prototype |
| `viewer/` | The page: `index.html`, `viewer.js`, `highlight.js` (Shiki, bundled by the build), and `core.js` (the tokenizer and diff, used by both sides) |

The page's icons are VS Code's [Codicons](https://github.com/microsoft/vscode-codicons) (CC BY 4.0).
| `docs/` | The UX proposal, the test runs, and the prototype pipeline that produced them |
