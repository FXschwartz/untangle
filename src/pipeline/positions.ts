// Identifier positions the language server is asked about.
import fs from 'node:fs';
import path from 'node:path';
import type { Node } from 'web-tree-sitter';
import { dartParser } from '../../analysis/dart.js';
import type { Diff } from '../../analysis/analyze.js';
import '../../viewer/core.js';

const C = globalThis.ReviewCore;

/** path -> line -> [column, length] of each identifier. */
export type Positions = Record<string, Record<string, Array<[number, number]>>>;

const isName = (k: string) => k === 'id' || k === 'ty' || k === 'ann';
// An annotation's position is its name, after the @.
const at = (t: { t: string; k: string; c: number }): [number, number] => (t.k === 'ann' ? [t.c + 1, t.t.length - 1] : [t.c, t.t.length]);

const STATEMENT = /statement|declaration|signature|^program$|^block$|^class_body$/;

// The called function of an argument list: a call's name line often stays unchanged while an
// argument line below it changes.
function calleeOf(args: Node): Node | null {
  const p = args.parent;
  if (p && p.type === 'argument_part' && p.parent && p.parent.type === 'selector') {
    const prev = p.parent.previousNamedSibling;
    if (!prev) return null;
    if (prev.type === 'identifier') return prev;
    const ids = prev.descendantsOfType('identifier').filter((x): x is Node => !!x);
    return ids.length ? ids[ids.length - 1] : null;
  }
  if (p && (p.type === 'new_expression' || p.type === 'const_object_expression')) {
    const ids = p.children.filter((c): c is Node => !!c && (c.type === 'identifier' || c.type === 'type_identifier'));
    return ids.length ? ids[ids.length - 1] : null;
  }
  return null;
}

/** Context and added lines of Dart files, plus the called function of every changed argument list. */
export async function headPositions(diff: Diff, headDir: string): Promise<{ positions: Positions; count: number }> {
  const parser = await dartParser();
  const out: Positions = {};
  let count = 0;
  for (const cmp of Object.values(diff.compares)) {
    for (const f of cmp.files) {
      if (!f.hunks || !/\.dart$/.test(f.p)) continue;
      const per = (out[f.p] = out[f.p] || {});
      let tree = null;
      try {
        tree = parser.parse(fs.readFileSync(path.join(headDir, f.p), 'utf8'));
      } catch {
        // A file that can't be read gets its identifiers only.
      }
      const add = (line: number, col: number, len: number) => {
        const list = (per[line] = per[line] || []);
        if (list.some(([c]) => c === col)) return false;
        list.push([col, len]);
        return true;
      };
      for (const h of f.hunks) {
        let n = h.n;
        for (const raw of h.l) {
          const type = raw[0];
          if (type === '-') continue;
          C.tokenize(raw.slice(1), 'dart').filter((t) => isName(t.k)).forEach((t) => { if (add(n, ...at(t))) count++; });
          if (tree && type === '+') {
            const col = raw.slice(1).search(/\S/);
            for (let x: Node | null = col < 0 ? null : tree.rootNode.descendantForPosition({ row: n - 1, column: col }); x && !STATEMENT.test(x.type); x = x.parent) {
              if (x.type !== 'arguments') continue;
              const callee = calleeOf(x);
              if (callee && add(callee.startPosition.row + 1, callee.startPosition.column, callee.endIndex - callee.startIndex)) count++;
            }
          }
          n++;
        }
      }
    }
  }
  return { positions: out, count };
}

/** Identifiers on removed lines of Dart files, by old line number, for one comparison. */
export function oldPositions(diff: Diff, name: string): { positions: Positions; count: number } {
  const out: Positions = {};
  let count = 0;
  for (const f of diff.compares[name].files) {
    if (!f.hunks || !/\.dart$/.test(f.p)) continue;
    const per = (out[f.p] = out[f.p] || {});
    for (const h of f.hunks) {
      let o = h.o;
      for (const raw of h.l) {
        if (raw[0] === '+') continue;
        if (raw[0] === '-') {
          per[o] = C.tokenize(raw.slice(1), 'dart').filter((t) => isName(t.k)).map(at);
          count += per[o].length;
        }
        o++;
      }
    }
  }
  return { positions: out, count };
}
