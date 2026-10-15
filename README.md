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
npm run build   # the TypeScript, the highlighter (dist/highlight.js) and the fonts (dist/fonts.css)
npm link        # puts `untangle` on PATH
```

## Tests

```
npm test         # build, then the unit and server tests
npm run test:e2e # build, then the browser tests
npm run test:all # build, then every test
npm run check    # type-check the program and the tests
```

The tests use Node's runner (`node:test`) and need Node 22.18 or later, which runs `.ts` files without a flag. They stay offline. A missing `dart` or Chromium skips the tests that need it.

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

The page is dark and quiet: the code sits on a sheet over a darker ground, amber marks what's
left to review, a check what's done, blue what comes from GitHub, and red and green stay in the
diff. The interface is set in Schibsted Grotesk and code in JetBrains Mono, both bundled.

- **Getting around.**
  - **The review pill** under the code says where you are among the view's changes to review
    ("3 of 14"), with the previous and next one, and **Mark and go to the next** (Space).
  - **Jump to** (Ctrl K, or the box in the top bar) finds a chain, a file, a thread, or a
    declaration anywhere in the repository (from the language server), by a few letters of its
    name; Tab narrows it to one kind. It also searches the changed lines, or the whole
    repository at the head or the base (`git grep`).
  - **Keys:** j and k for the next and previous change to review, Space to mark it and go on,
    Shift+Space for its hunk (its member, in a chain), n and p for the next and previous chain
    with changes to review, c to comment on the line, Ctrl B for the sidebar, Esc to close; `?`
    lists them.
  - **A view's header** is one row: where you are (Map / chain, or Files / folder / file), what
    it holds, ↑ and ↓ for every change, a chain's graph button, a ⋯ menu, and the view's one
    action (Mark chain reviewed). The menu holds open in the editor, the whole file, side by
    side, the diffs of reviewed code, the minimap, a comment on the file and the chains a chain
    uses or is used by. A file's "In 3 chains" lists its chains.
  - **A chain** shows its members as a row of pills, by level, each with what's left in it,
    pinned under the header with the one you're reading marked: click one, then another, without
    scrolling back. Its graph is above the code (the header's button hides it, and the browser
    keeps that): clicking a member shows only its code, without moving the page, and names what
    its arrows use. A member's counts and "Mark reviewed" show on hover.
- **The code** has one gutter: the review mark (muted until the pointer is on its line), one
  line number (the old one, in red, for a removed line) and the sign. Same changes elsewhere and
  changed usages are grey notes at the line's end.
- **Go to definition anywhere.** Names on changed lines answer at once (computed ahead). Any
  other name, in a whole file, inside a peek or on a removed line, asks the language server;
  in a peek, clicking a name changes the peek in place to its definition (Back returns), and
  leaves it as it is when that's the definition it already shows. A click outside a peek closes
  it.
- **More of the file.** The divider above each hunk (its first line and context, in grey)
  stands for the lines hidden above it: click it for 20 more (up from the hunk, or down from the
  one before), or all of them when 20 or fewer are left, as on GitHub. Its buttons, and "Mark
  hunk reviewed", show under the pointer. The divider after the last hunk shows the rest of the
  file. Chain views grow the same way. An exported page grows only within hunks.
- **Whole files.** "Show the whole file" in a file's ⋯ menu shows it around its diff, and back
  to the changed chunks. "Open file" in a peek or a search result opens a changed file that way, at
  the line; any other file, at either side or outside the repository (a package, the SDK),
  opens on its own with the lines the review changes marked. Names in them go to definition.
- **The Files tab** is a folder tree, folders first; a folder holding only one folder shows with
  it (`lib/src/mcp`), as VS Code compacts them.
- **Panels:** drag the sidebar's edge to resize it (double-click it, or Ctrl B, to hide it). A
  **minimap** at the right of the code shows the view small, with the diff's colors, amber for
  what's left to review and blue for threads; click or drag it to move. Both are kept in the
  browser.
- **Motion:** marking a hunk reviewed fills its check, settles its diff and folds it into its
  divider while the code below glides up; lines shown from a divider open downward from it; a
  peek grows from its line; going to a change scrolls to it and pulses it. After a refresh, the
  lines the new commits changed glow once. With "reduce motion" set in the system, none of it.
- **Highlighting** with [Shiki](https://shiki.style): VS Code's grammars and its Dark+ theme.
  Names a grammar leaves plain (variables, properties, parameters) are colored as VS Code's
  semantic highlighting does.
- **The language server's dot** in the top bar: green when it's up; hover for its process id,
  and untangle's and the language server's memory and CPU, as px0 shows them.
- **Open in editor** from a view's ⋯ menu and from peeks: a `vscode://` link by default (through WSL
  when untangle runs there), or `-editor` with a command such as `code -g {file}:{line}:{col}`
  or a URL template such as `cursor://file{file}:{line}:{col}`.
- **The pull request's comments, as on GitHub** (through `gh`): threads under the lines they're
  on, with replies, reactions and suggestions; the Threads tab lists the open and resolved ones,
  and the conversation (the description, comments and reviews). A thread is one quiet block with
  GitHub's blue on its edge: the author once per run of comments, tools under the pointer, and
  Reply and Resolve on one row.
  - **Writing:** the **+** over a line's number starts a comment; drag it over more lines of the
    hunk (or shift-click another line's) for a range. "Add single comment" posts it now; "Start a review" keeps it, and
    the comments after it, in your pending review. Write and Preview, Ctrl+Enter, and
    "Suggest a change" for lines on the new side. Comment on a whole file from its ⋯ menu.
    Typing `@` suggests people and teams to mention, `#` issues and pull requests to link
    (↑/↓, Enter or Tab, Esc), as on GitHub.
  - **Threads:** reply, resolve and unresolve, edit and delete your comments, react. A reviewed
    hunk stays open while a conversation in it is.
  - **Finishing:** Review in the top bar ("Finish review" while comments are pending) submits it
    as a comment, an approval or a request for changes, or discards it.
  - What you type is kept in the browser until it's sent. The page checks GitHub every minute.
    When the pull request has newer commits than the review, comments on lines wait for a
    refresh; replies, file comments and reviews don't.
- **Refreshing without a restart.** When the pull request (or the branch) gets new commits, a
  banner offers to refresh, as GitHub does; the button next to the commit looks for them anytime.
  untangle builds the new review while the page keeps working on the current one, then the page
  reloads on the same view, with marks carried over and unsent comments kept. A page left on the
  old review, in another tab, is told to reload instead of saving marks onto the new one.
- **The commits, as a lens.** The sidebar's Commits tab draws the pull request's commits as a
  graph, newest on top: each with its message, its date and what's left to review of it (a check
  when it's all reviewed, a hollow dot when none of its lines made it to the head). The head
  commit in the top bar opens the same graph as a menu, "Changes from", as GitHub's does: all
  changes, since your review or the branch's last commit with changes, then a line per commit.
  - **A lens:** click a commit (Shift-click another for a range) and every view shows the
    review through it. Lines from other commits fade, and the counts, the review pill, the
    minimap and j and k go through what's in it. Under a commit's lens, marking a change marks
    the lines that commit wrote: a change is reviewed once all its commits are. The top bar
    names the lens in place of the head commit; "All changes" or Esc turns it off. `git blame`
    over the pull request's commits says which commit wrote each line, once per review.
  - **Since your review:** after new commits, a chip offers what changed since the head your last
    save recorded (on the marks branch), and the graph flags that commit. Marks there cover whole
    changes, since you saw the rest before.
  - **The History view** (from the tab, or under the chain map) shows each commit with what it
    touched, the commits a merge brought from the base (listed under it), and from GitHub, its
    checks and the reviews made on it. Click a commit for its details, as Git Graph shows them:
    its parents, author, committer and dates, its whole message, and the files it changed (a
    tree or a list) with their lines and what's left to review of the commit in each. A file
    opens with the commit as the lens. A force push draws the head before it as a dashed lane,
    with a lens of what changed since. The lanes are drawn as VS Code's Source Control Graph
    draws them.
- **Marks on a branch.** Your review is a local git branch, `untangle/pr-<number>` (or
  `untangle/<branch>`): the base plus every change you marked reviewed, a commit per save.
  `git diff untangle/pr-123 <head>` shows what's left. Marks come back from the branch's
  content, so a new push to the pull request only brings back what changed since you looked.
  When the base moves (a rebase), the branch is replayed onto the new base with a 3-way merge,
  [mergiraf](https://mergiraf.org) first when it's installed; what still conflicts goes back to
  unreviewed. For a URL, the branch lives in the cached clone; for a directory, in your
  repository. Marks on part of a change stay next to the analysis. The sidebar's ··· says where
  they are, with a button to reset them.

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
| `viewer/` | The page: `index.html`, `viewer.js`, `highlight.js` (Shiki, bundled by the build), `fonts.css` (the two faces, bundled by the build), and `core.js` (the tokenizer and diff, used by both sides) |
| `docs/` | The UX proposal, the test runs, and the prototype pipeline that produced them |

The page's icons are VS Code's [Codicons](https://github.com/microsoft/vscode-codicons) (CC BY 4.0).
Its faces are [Schibsted Grotesk](https://github.com/schibsted/schibsted-grotesk) and
[JetBrains Mono](https://github.com/JetBrains/JetBrainsMono), both under the SIL Open Font
License 1.1, from [Fontsource](https://fontsource.org).
