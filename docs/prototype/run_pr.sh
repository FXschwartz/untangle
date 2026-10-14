#!/usr/bin/env bash
# Runs the whole pipeline on one PR, unchanged rules, into its own folder.
#   run_pr.sh <repo> <out-dir> <base-sha> <head-sha> [<label>]
# Makes git worktrees of both sides (with `dart pub get`), asks the Dart language server
# about both (definitions, references, outgoing calls, overrides), and writes diff.json,
# defs*.json, refs.json, calls.json, supers.json and model.json into <out-dir>.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$1" && pwd)
mkdir -p "$2"; out=$(cd "$2" && pwd)
base=$3; head=$4; label=${5:-"base · ${3:0:7}"}
# Packages: one `pub get` at the root for a pub workspace, otherwise one per package that holds a
# changed Dart file. `flutter pub get` takes over when a package needs Flutter.
pub_get() { (cd "$1" && { dart pub get || { command -v flutter >/dev/null && flutter pub get; }; }); }
changed=$(git -C "$repo" diff --no-renames --name-only "$base" "$head" -- '*.dart')
for side in head base; do
  sha=$head; [ "$side" = base ] && sha=$base
  [ -d "$out/$side" ] || git -C "$repo" worktree add -q --detach "$out/$side" "$sha"
  log="$out/pub_get_$side.log"; : > "$log"
  if [ -f "$out/$side/pubspec.yaml" ] && grep -q '^workspace:' "$out/$side/pubspec.yaml"; then
    pub_get "$out/$side" >>"$log" 2>&1 || { echo "pub get failed on $side; see $log"; exit 1; }
  else
    for d in $(for f in $changed; do p=$(dirname "$f"); while [ "$p" != . ] && [ ! -f "$out/$side/$p/pubspec.yaml" ]; do p=$(dirname "$p"); done; echo "$p"; done | sort -u); do
      [ -f "$out/$side/$d/pubspec.yaml" ] && { pub_get "$out/$side/$d" >>"$log" 2>&1 || echo "pub get failed in $d on $side; see $log"; }
    done
  fi
done
step() { local t0=$SECONDS; "$@"; echo "  ($((SECONDS - t0)) s) $(basename "$2")"; }
globs=$(node "$here/generated_globs.js" "$repo" "$head")
step python3 "$here/export_diff.py" "$repo" "$out/diff.json" "--generated=$globs" "base=$base..$head=$label"
step node "$here/positions.js" "$out/diff.json" "$out/positions.json" "$out/head"
step python3 "$here/lsp_index.py" "$out/head" "$out/positions.json" "$out/defs.json"
step python3 "$here/slim_defs.py" "$out/defs.json" "$out/defs_slim.json"
step python3 "$here/refs_from_defs.py" "$out/head" "$out/diff.json" "$out/defs.json" "$out/refs.json"
step python3 "$here/lsp_calls.py" "$out/head" "$out/diff.json" "$out/defs.json" "$out/calls.json"
step python3 "$here/lsp_supers.py" "$out/head" "$out/diff.json" "$out/defs.json" "$out/supers.json"
step node "$here/positions_old.js" base "$out/diff.json" "$out/positions_old_base.json"
step python3 "$here/lsp_index.py" "$out/base" "$out/positions_old_base.json" "$out/defs_old_base.json"
step python3 "$here/slim_defs_old.py" "base=$out/defs_old_base.json" "$out/defs_old_slim.json"
step node "$here/analyze.js" "$repo" "$out/head" "$out/diff.json" "$out/defs.json" "$out/model.json" "base:$out/base:$out/defs_old_base.json" "calls=$out/calls.json" "supers=$out/supers.json"
node "$here/stats.js" "$out/model.json"
node "$here/diag_standalone.js" "$out/head" "$out/model.json" "$out/defs.json"
