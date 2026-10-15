// Which code the whole suite never ran: the regions of untangle's code (dist/, analysis/) and of
// the page's script (viewer/viewer.js) that no test process, untangle server or page executed.
//
//   node test/coverage.ts <node coverage dir> <page coverage dir> [min lines]
//
// The node directory holds NODE_V8_COVERAGE files of every process; the page directory, the
// snapshots test/helpers/browser.ts takes when UNTANGLE_VIEWER_COV names it. A line counts as run
// when any of its code ran anywhere; regions of lines that never ran are listed with the
// function they start in. A page that reloads itself (a refresh) loses what it ran before the
// reload: refresh.test.ts checks those effects instead.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

interface Range { startOffset: number; endOffset: number; count: number }
interface FunctionCoverage { functionName: string; ranges: Range[] }
interface ScriptCoverage { url: string; functions: FunctionCoverage[] }

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [nodeDir, pageDir, minArg] = process.argv.slice(2);
const minLines = Number(minArg || 1);

// 0: no code reported here, 1: reported and never ran, 2: ran in some process or page.
function paint(state: Uint8Array, functions: FunctionCoverage[], shift: number): void {
  const ranges = functions.flatMap((fn) => fn.ranges.map((r) => [r.startOffset - shift, r.endOffset - shift, r.count] as const));
  ranges.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const here = new Uint8Array(state.length);
  for (const [start, end, count] of ranges) here.fill(count > 0 ? 2 : 1, Math.max(0, start), Math.min(state.length, end));
  for (let i = 0; i < here.length; i++) if (here[i] > state[i]) state[i] = here[i];
}

/** The named function a line falls in: the last declaration that starts before it. */
function functionStarts(text: string): Array<[number, string]> {
  const out: Array<[number, string]> = [];
  for (const m of text.matchAll(/(?:function\s+([A-Za-z_$][\w$]*)|(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(|^\s+(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{)/gm)) {
    const name = m[1] || m[2] || m[3];
    if (!['if', 'for', 'while', 'switch', 'catch', 'return'].includes(name)) out.push([m.index ?? 0, name]);
  }
  return out;
}

function report(label: string, text: string, state: Uint8Array): number {
  const lines = text.split('\n');
  const status: Array<boolean | null> = [];
  const starts: number[] = [];
  let at = 0;
  for (const line of lines) {
    starts.push(at);
    let code = false, ran = false, reported = false;
    for (let i = 0; i < line.length; i++) {
      if (/\s/.test(line[i])) continue;
      code = true;
      if (state[at + i] === 2) ran = true;
      if (state[at + i] > 0) reported = true;
    }
    status.push(!code || !reported ? null : ran);
    at += line.length + 1;
  }
  const known = status.filter((s) => s !== null);
  const pct = (100 * known.filter(Boolean).length) / Math.max(1, known.length);
  const fns = functionStarts(text);
  const regions: string[] = [];
  let never = 0;
  for (let i = 0; i < status.length; i++) {
    if (status[i] !== false) continue;
    let j = i;
    while (j + 1 < status.length && status[j + 1] !== true) j++;
    const n = status.slice(i, j + 1).filter((s) => s === false).length;
    if (n >= minLines) {
      const inside = fns.filter(([pos]) => pos <= starts[i]).pop();
      regions.push(`   ${i + 1}-${j + 1} (${n}) in ${inside ? inside[1] : '(top)'}: ${lines[i].trim().slice(0, 110)}`);
      never += n;
    }
    i = j;
  }
  console.log(`== ${label}: ${pct.toFixed(1)}% of ${known.length} code lines ran; ${never} lines never ran, in ${regions.length} regions`);
  for (const r of regions) console.log(r);
  return regions.length;
}

// untangle's own code, in every process.
const byFile = new Map<string, FunctionCoverage[][]>();
for (const name of fs.readdirSync(nodeDir)) {
  const data = JSON.parse(fs.readFileSync(path.join(nodeDir, name), 'utf8')) as { result?: ScriptCoverage[] };
  for (const script of data.result ?? []) {
    if (!script.url.startsWith('file://')) continue;
    const rel = path.relative(root, fileURLToPath(script.url));
    if (!/^(dist|analysis)\/.*\.js$/.test(rel)) continue;
    if (!byFile.has(rel)) byFile.set(rel, []);
    byFile.get(rel)!.push(script.functions);
  }
}
let regions = 0;
for (const rel of [...byFile.keys()].sort()) {
  const text = fs.readFileSync(path.join(root, rel), 'utf8');
  const state = new Uint8Array(text.length);
  for (const functions of byFile.get(rel)!) paint(state, functions, 0);
  regions += report(rel, text, state);
}

// The page's script: the inline <script> that holds viewer.js, found by one of its functions.
const viewer = fs.readFileSync(path.join(root, 'viewer/viewer.js'), 'utf8');
const state = new Uint8Array(viewer.length);
// V8 leaves out functions it never compiled, so a page that never opened History has no
// renderHistory in its snapshot. Any of these, present in both the file and the snapshot, lines
// the script up with viewer.js. (Where V8 leaves a function out, its parent reports that span
// as not run, so a missing function never counts as run.)
const anchors = ['function renderHistory(', 'function renderStandalone(', 'function render(', 'function api(']
  .map((source) => ({ source, name: /function\s+([A-Za-z_$][\w$]*)/.exec(source)![1], at: viewer.indexOf(source) }))
  .filter((item) => item.at >= 0);
let snapshots = 0;
for (const name of fs.existsSync(pageDir) ? fs.readdirSync(pageDir) : []) {
  for (const script of JSON.parse(fs.readFileSync(path.join(pageDir, name), 'utf8')) as ScriptCoverage[]) {
    const anchorOf = anchors.find((item) => script.functions.some((fn) => fn.functionName === item.name));
    const fn = anchorOf && script.functions.find((item) => item.functionName === anchorOf.name);
    if (!anchorOf || !fn) continue;
    paint(state, script.functions, fn.ranges[0].startOffset - anchorOf.at);
    snapshots++;
  }
}
console.log(`\n(the page: ${snapshots} snapshots)`);
regions += report('viewer/viewer.js', viewer, state);
console.log(`\n${regions} regions never ran.`);
