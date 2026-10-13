#!/bin/bash
# Peak resident memory of the language server(s) running in a worktree while lsp_index.py
# resolves the given positions. Usage: measure_lsp.sh <worktree> <positions.json>
WT=$(realpath "$1"); POS="$2"
python3 -I "$(dirname "$0")/lsp_index.py" "$WT" "$POS" /dev/null >/tmp/lsp_measure.log 2>&1 &
PY=$!
peak=0; start=$(date +%s.%N)
while kill -0 $PY 2>/dev/null; do
  sum=0
  for p in /proc/[0-9]*; do
    [ "$(readlink $p/cwd 2>/dev/null)" = "$WT" ] || continue
    grep -q 'language-server\|analysis_server\|dart' $p/cmdline 2>/dev/null || continue
    r=$(awk '/VmRSS/{print $2}' $p/status 2>/dev/null); sum=$((sum + ${r:-0}))
  done
  [ $sum -gt $peak ] && peak=$sum
  sleep 0.3
done
end=$(date +%s.%N)
echo "$(basename $WT): peak RSS $((peak / 1024)) MB, wall $(printf '%.0f' $(echo "$end - $start" | bc)) s"
