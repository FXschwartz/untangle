# Prototype pipeline (throwaway)

Produces the viewer published at https://claude.ai/artifact/MEkRBmhVGgqBPUB5QYAFVB from the
real diff of serverpod_offline_sync #168. Commits and paths are arguments, so the same
scripts run on any PR of the repo.

Prerequisites:
- A blobless clone of the repo with `pull/168/head` fetched.
- Worktrees of the PR head and of each comparison's old side (`e0598c1`, `0540639`), each
  with `dart pub get` run, used by the language servers.
- `npm install` in this folder, for `web-tree-sitter` and the prebuilt grammars.

| Step | Command | What it does |
|---|---|---|
| 1 | `python3 export_diff.py <repo> diff.json base=<base>..<head>=<label> [since=<snapshot>..<head>=<label>]` | Exports `git diff -U3` hunks per file for each comparison. Generated files get stats only. |
| 2 | `node positions.js diff.json positions.json <head>` | Identifier positions on the head side of the diff, plus the called function of every changed argument list, even above the hunk. |
| 3 | `python3 lsp_index.py <head> positions.json defs.json` | Asks `dart language-server` for every identifier's definition. |
| 4 | `python3 slim_defs.py defs.json defs_slim.json` | Keeps only what the page embeds for go to definition. |
| 5 | `python3 lsp_refs.py <head> diff.json defs.json refs.json` | References of declarations on added lines that fall on added lines elsewhere (the "changed usages" badges). |
| 5a | `python3 lsp_calls.py <head> diff.json defs.json calls.json` | Outgoing calls (call hierarchy), up to 3 levels, from what changed tests call. Tests link to the first changed function on each path. |
| 5b | `python3 lsp_supers.py <head> diff.json defs.json supers.json` | What each declaration on an added line overrides (`dart/textDocument/super`). Changed overrides of the same method join one chain. |
| 5b | `node positions_old.js base diff.json positions_old_base.json`, then `python3 lsp_index.py <base-worktree> positions_old_base.json defs_old_base.json` | The same for removed lines, on the old side's checkout. Repeat per comparison. |
| 5c | `python3 slim_defs_old.py base=defs_old_base.json [since=defs_old_since.json] defs_old_slim.json` | What the page embeds for the old side. |
| 6 | `node analyze.js <repo> <head> diff.json defs.json model.json base:<base-worktree>:defs_old_base.json [since:<mid-worktree>:defs_old_since.json] [calls=calls.json] [supers=supers.json]` | The core: token edits, tree-sitter identities, same-change groups, chains, their graphs, and the chain hierarchy. Uses `core.js`. |
| 7 | `node stats.js model.json` | Prints the numbers quoted in `../01-ux-proposal.md`. |
| 7b | `node diag_standalone.js <head> model.json defs.json` | Explains why each change outside every chain stayed outside. |
| 8 | `python3 build.py <dir> page.html` | Inlines the model, `core.js`, `viewer.js` and `analyze.js` (as text) into `template.html`. |
| 8a | `python3 combine_runs.py <dir> <name>=<run-dir>[:<compare>]=<title> ...` | Puts several analysed PRs into one page, each as a comparison of its own (how the page shows #157, #166 and #162 next to #168). |

#168's page uses two comparisons: `base=e0598c1577db2d55c9af7d0d165be6332256910d..a45f9aee30bcb170b863373840e63a0e42a0092b=main · e0598c1`
and `since=0540639..a45f9aee30bcb170b863373840e63a0e42a0092b=Reviewed at 0540639`.

**Any other PR, steps 1 to 7b in one go:** `./run_pr.sh <repo> <out-dir> <base-sha> <head-sha> [<label>]`.
It makes worktrees of both sides, runs `dart pub get`, and writes every file into `<out-dir>`.
The results on #157, #166 and #162 are in [../02-test-runs.md](../02-test-runs.md).

**Generated code and adapters.** `analyze.js` sets generated files aside and links usages that resolve
into them back to their source, through an adapter per generator: Serverpod (`*.spy.yaml`),
generated part files (`*.g.dart`, `*.freezed.dart`) and protobuf (`*.proto`). Each switches on by
what the repository contains. A `.review.yaml` at the repository root can override them:

```yaml
generated:            # more generated patterns
  - '**/*.gen.dart'
adapters:             # turn an adapter on or off
  protobuf: false
models:               # a YAML-model mapping of your own
  - generated: ['**/gen/**']
    source: '**/*.model.yaml'
    classSuffixes: 'Table|Repository'
```

`make_fixture.sh <dir>` builds a three-commit repository that exercises the part-file and protobuf
adapters (the third commit turns protobuf off with `.review.yaml`); run `run_pr.sh` on it.

Set `BCR_DEPS` to another `node_modules` folder if the dependencies live elsewhere (`npm install` here
installs `web-tree-sitter`, the grammars and `yaml`).

Cost measurements: `measure_lsp.sh <worktree> <positions.json>` reports the language server's
peak memory and time. `lsp_two_roots.py <head> <old> positions.json positions_old_base.json`
measures one server with both checkouts as workspace folders.
