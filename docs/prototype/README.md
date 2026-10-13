# Prototype pipeline (throwaway)

Produces the viewer published at https://claude.ai/artifact/MEkRBmhVGgqBPUB5QYAFVB from the
real diff of serverpod_offline_sync #168. Commit SHAs are hard-coded in `export_diff.py`.

| Step | File | What it does |
|---|---|---|
| 1 | `export_diff.py <repo> diff.json` | Exports `git diff -U3` hunks per file as JSON, for main→head and 0540639→head. Generated files get stats only. |
| 2 | `core.js` | The rules: tokenizer, token LCS, edits, repeated-edit groups. Runs in node and in the page. |
| 3 | `positions.js` | Identifier positions on the head side of the diff, for the language server. |
| 4 | `lsp_index.py <head-worktree> positions.json defs.json` | Asks `dart language-server` for each identifier's definition. |
| 4b | `slim_defs.py defs.json defs_slim.json` | Keeps only what the page embeds. |
| 5 | `lsp_refs.py <head-worktree> diff.json defs.json refs.json` | References of declarations on added lines, kept when they fall on added lines elsewhere. |
| 6 | `stats.js` | Prints the numbers quoted in `../01-ux-proposal.md`. |
| 7 | `build.py <dir> page.html` | Inlines `core.js`, `viewer.js` and the JSON into `template.html`. |

The head worktree needs `dart pub get` before steps 4 and 5.
