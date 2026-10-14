#!/usr/bin/env bash
# Runs the whole pipeline on one PR, unchanged rules, into its own folder.
#   run_pr.sh <repo> <out-dir> <base-sha> <head-sha> [<label>]
# Makes git worktrees of both sides (with `dart pub get`), asks the Dart language server
# about both (definitions, references, outgoing calls), and writes diff.json, defs*.json,
# refs.json, calls.json and model.json into <out-dir>.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$1" && pwd)
mkdir -p "$2"; out=$(cd "$2" && pwd)
base=$3; head=$4; label=${5:-"base · ${3:0:7}"}
for side in head base; do
  sha=$head; [ "$side" = base ] && sha=$base
  [ -d "$out/$side" ] || git -C "$repo" worktree add -q --detach "$out/$side" "$sha"
  (cd "$out/$side" && dart pub get >"$out/pub_get_$side.log" 2>&1) || { echo "dart pub get failed on $side; see $out/pub_get_$side.log"; exit 1; }
done
step() { local t0=$SECONDS; "$@"; echo "  ($((SECONDS - t0)) s) $(basename "$2")"; }
step python3 "$here/export_diff.py" "$repo" "$out/diff.json" "base=$base..$head=$label"
step node "$here/positions.js" "$out/diff.json" "$out/positions.json" "$out/head"
step python3 "$here/lsp_index.py" "$out/head" "$out/positions.json" "$out/defs.json"
step python3 "$here/slim_defs.py" "$out/defs.json" "$out/defs_slim.json"
step python3 "$here/lsp_refs.py" "$out/head" "$out/diff.json" "$out/defs.json" "$out/refs.json"
step python3 "$here/lsp_calls.py" "$out/head" "$out/diff.json" "$out/defs.json" "$out/calls.json"
step node "$here/positions_old.js" base "$out/diff.json" "$out/positions_old_base.json"
step python3 "$here/lsp_index.py" "$out/base" "$out/positions_old_base.json" "$out/defs_old_base.json"
step python3 "$here/slim_defs_old.py" "base=$out/defs_old_base.json" "$out/defs_old_slim.json"
step node "$here/analyze.js" "$repo" "$out/head" "$out/diff.json" "$out/defs.json" "$out/model.json" "base:$out/base:$out/defs_old_base.json" "calls=$out/calls.json"
node "$here/stats.js" "$out/model.json"
node "$here/diag_standalone.js" "$out/head" "$out/model.json" "$out/defs.json"
