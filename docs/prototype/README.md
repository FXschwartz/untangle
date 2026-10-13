# Prototype pipeline (throwaway)

Produces the viewer published at https://claude.ai/artifact/MEkRBmhVGgqBPUB5QYAFVB from the
real diff of serverpod_offline_sync #168. Commit SHAs are hard-coded in `export_diff.py` and
`analyze.js`.

Prerequisites:
- A blobless clone of the repo with `pull/168/head` fetched.
- Worktrees of the PR head and of each comparison's old side (`e0598c1`, `0540639`), each
  with `dart pub get` run, used by the language servers.
- `npm install` in this folder, for `web-tree-sitter` and the prebuilt grammars.

| Step | Command | What it does |
|---|---|---|
| 1 | `python3 export_diff.py <repo> diff.json` | Exports `git diff -U3` hunks per file for main→head and 0540639→head. Generated files get stats only. |
| 2 | `node positions.js` | Identifier positions on the head side of the diff. |
| 3 | `python3 lsp_index.py <head> positions.json defs.json` | Asks `dart language-server` for every identifier's definition. |
| 4 | `python3 slim_defs.py defs.json defs_slim.json` | Keeps only what the page embeds for go to definition. |
| 5 | `python3 lsp_refs.py <head> diff.json defs.json refs.json` | References of declarations on added lines that fall on added lines elsewhere (the "changed usages" badges). |
| 6 | `node analyze.js <repo> <head> diff.json defs.json model.json base:<base-worktree>:defs_old_base.json since:<mid-worktree>:defs_old_since.json` | The core: token edits, tree-sitter identities, same-change groups, chains, their graphs, and the chain hierarchy. Uses `core.js`. |
| 7 | `node stats.js` | Prints the numbers quoted in `../01-ux-proposal.md`. |
| 7b | `node diag_standalone.js <head>` | Explains why each change outside every chain stayed outside. |
| 8 | `python3 build.py . page.html` | Inlines the model, `core.js`, `viewer.js` and `analyze.js` (as text) into `template.html`. |

Set `BCR_DEPS` to another `node_modules` folder if the dependencies live elsewhere.
