// The language-server answers that the chains need beyond definitions: changed usages, the
// calls that changed tests reach, and what changed declarations override.
import path from 'node:path';
import type { CallGraph, Diff, RawDefinitions } from '../../analysis/analyze.js';
import { askAll, uriPath, type CallHierarchyItem, type DartServer } from '../lsp/dart.js';

/** How many calls deep a test is followed. */
export const CALL_DEPTH = 3;
const TEST_FILE = /(^|\/)(test|test_[a-z0-9_]+|integration_test)\/|_test\.dart$/;
const WINDOW = 16;

const splitKey = (key: string): [string, number, number] => {
  const i1 = key.lastIndexOf(':'), i0 = key.lastIndexOf(':', i1 - 1);
  return [key.slice(0, i0), +key.slice(i0 + 1, i1), +key.slice(i1 + 1)];
};
const cmp = (a: string | number, b: string | number) => (a < b ? -1 : a > b ? 1 : 0);

/** "path:line" of every added line in the diff. */
function addedLines(diff: Diff): Set<string> {
  const plus = new Set<string>();
  for (const c of Object.values(diff.compares)) for (const f of c.files) for (const h of f.hunks || []) {
    let n = h.n;
    for (const line of h.l) {
      if (line[0] === '+') plus.add(`${f.p}:${n}`);
      if (line[0] !== '-') n++;
    }
  }
  return plus;
}

/**
 * Changed usages, without asking the language server again: every identifier on a changed line
 * already knows its declaration, so inverting that map gives, for each declaration on an added
 * line, its usages on added lines of other changes (the "changed usages" badges).
 */
export function changedUsages(diff: Diff, head: string, raw: RawDefinitions): Record<string, Record<string, Array<[string, number, number]>>> {
  const result: Record<string, Record<string, Array<[string, number, number]>>> = {};
  for (const [name, c] of Object.entries(diff.compares)) {
    const added = new Set<string>(), blockOf = new Map<string, string>();
    for (const f of c.files) (f.hunks || []).forEach((h, hi) => {
      let n = h.n, block = 0, prev = ' ';
      for (const raw of h.l) {
        const t = raw[0];
        if (t !== ' ' && prev === ' ') block++;
        if (t === '+') { added.add(`${f.p}:${n}`); blockOf.set(`${f.p}:${n}`, `${hi}:${block}`); }
        if (t !== '-') n++;
        prev = t;
      }
    });
    const decls = new Set<string>();
    for (const [key, [tpath, tl, tc]] of Object.entries(raw)) {
      const [p, line, col] = splitKey(key);
      if (added.has(`${p}:${line}`) && tpath === path.join(head, p) && tl === line - 1 && tc === col) decls.add(`${p}:${line}:${col}`);
    }
    const usages: Record<string, Array<[string, number, number]>> = {};
    for (const [key, [tpath, tl, tc]] of Object.entries(raw)) {
      const [p, line, col] = splitKey(key);
      if (!added.has(`${p}:${line}`) || !tpath.startsWith(head + '/')) continue;
      const dp = tpath.slice(head.length + 1), dk = `${dp}:${tl + 1}:${tc}`;
      if (!decls.has(dk) || dk === key || (dp === p && blockOf.get(`${p}:${line}`) === blockOf.get(`${dp}:${tl + 1}`))) continue;
      (usages[dk] ??= []).push([p, line, col]);
    }
    for (const list of Object.values(usages)) list.sort((x, y) => cmp(x[0], y[0]) || x[1] - y[1] || x[2] - y[2]);
    result[name] = usages;
  }
  return result;
}

/**
 * Calls reachable from what changed tests call. For each declaration that a changed test line
 * uses (production code or an unchanged test helper), follow the outgoing calls breadth first
 * up to CALL_DEPTH levels, inside the repository only. The analysis links the test to the first
 * changed function on each path.
 */
export async function testCalls(server: DartServer, diff: Diff, head: string, raw: RawDefinitions): Promise<CallGraph & { requests: number }> {
  const plus = addedLines(diff);
  const nodeKey = (item: CallHierarchyItem) => {
    if (!item.uri.startsWith('file:')) return null;
    const file = uriPath(item.uri);
    if (!file.startsWith(head + '/')) return null;
    const rel = file.slice(head.length + 1);
    if (rel.includes('/generated/')) return null;
    return `${rel}:${item.selectionRange.start.line}:${item.selectionRange.start.character}`;
  };
  const seeds = new Map<string, [string, number, number]>();
  for (const [key, [tpath, tl, tc]] of Object.entries(raw)) {
    const [p, line] = splitKey(key);
    if (!TEST_FILE.test(p) || !plus.has(`${p}:${line}`) || !tpath.startsWith(head + '/')) continue;
    const rel = tpath.slice(head.length + 1);
    // Unchanged test helpers count too: a test often reaches changed code through one.
    if (rel.includes('/generated/') || plus.has(`${rel}:${tl + 1}`)) continue;
    seeds.set(`${rel}\n${tl}\n${tc}`, [rel, tl, tc]);
  }
  const sorted = [...seeds.values()].sort((a, b) => cmp(a[0], b[0]) || a[1] - b[1] || a[2] - b[2]);
  let requests = sorted.length;
  server.openAll(sorted.map(([rel]) => path.join(head, rel)));
  const prepared = await askAll(sorted, WINDOW, ([rel, tl, tc]) => server.prepareCallHierarchy(path.join(head, rel), tl, tc).catch(() => []), (r) => !r.length);
  const items = new Map<string, CallHierarchyItem>();
  prepared.forEach((res) => { const k = res[0] && nodeKey(res[0]); if (k) items.set(k, res[0]); });
  // Breadth first, so each function is expanded at its shortest distance from a seed.
  const graph: Record<string, string[]> = {}, seen = new Set<string>();
  let level = [...items];
  for (let depth = 0; level.length; depth++) {
    const fresh = level.filter(([k]) => !seen.has(k) && (seen.add(k), true));
    if (depth >= CALL_DEPTH) break;
    const next: Array<[string, CallHierarchyItem]> = [];
    server.openAll(fresh.filter(([, item]) => item.uri.startsWith('file:')).map(([, item]) => uriPath(item.uri)));
    const calls = await askAll(fresh, WINDOW, ([, item]) => server.outgoingCalls(item).catch(() => []), (r) => !r.length);
    requests += fresh.length;
    fresh.forEach(([k], i) => {
      const callees = new Set<string>();
      for (const to of calls[i]) {
        const ck = nodeKey(to);
        if (ck) { callees.add(ck); next.push([ck, to]); }
      }
      graph[k] = [...callees].sort();
    });
    level = next;
  }
  return { depth: CALL_DEPTH, seeds: [...items.keys()].sort(), graph, requests };
}

/**
 * What each declaration on an added line overrides. The analysis links changed overrides of the
 * same method into one chain, and an override to its base when the base changed too.
 */
export async function overrides(server: DartServer, diff: Diff, head: string, raw: RawDefinitions): Promise<RawDefinitions> {
  const plus = addedLines(diff);
  const keys = Object.keys(raw).sort().filter((key) => {
    const [p, line, col] = splitKey(key);
    const [tpath, tl, tc] = raw[key];
    return plus.has(`${p}:${line}`) && tpath === path.join(head, p) && tl === line - 1 && tc === col;
  });
  server.openAll(keys.map((key) => raw[key][0]));
  const res = await askAll(keys, WINDOW, (key) => server.superOf(raw[key][0], raw[key][1], raw[key][2]).catch(() => null), (r) => !r);
  const out: RawDefinitions = {};
  keys.forEach((key, i) => { const r = res[i]; if (r) out[key] = [r.path, r.line, r.col]; });
  return out;
}
