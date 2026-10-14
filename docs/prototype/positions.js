// Identifier positions on the head side (context and added lines) of Dart files.
// With the head worktree, also the called function of every changed argument list, even when
// its name sits above the hunk: a call's name line often stays unchanged while an argument
// line below it changes.
//   node positions.js <diff.json> <positions.json> [<head-worktree>]
require('./core.js');
const C = globalThis.ReviewCore;
const fs = require('fs');
const path = require('path');
const [IN, OUT, HEADDIR] = process.argv.slice(2);
const data = JSON.parse(fs.readFileSync(IN, 'utf8'));
const DEPS = process.env.BCR_DEPS || path.join(__dirname, 'node_modules');

(async () => {
  let parser = null;
  if (HEADDIR) {
    const { Parser, Language } = require(DEPS + '/web-tree-sitter/tree-sitter.cjs');
    await Parser.init();
    parser = new Parser();
    parser.setLanguage(await Language.load(DEPS + '/tree-sitter-wasms/out/tree-sitter-dart.wasm'));
  }
  const STATEMENT = /statement|declaration|signature|^program$|^block$|^class_body$/;
  const calleeOf = (args) => {
    const p = args.parent;
    if (p && p.type === 'argument_part' && p.parent && p.parent.type === 'selector') {
      const prev = p.parent.previousNamedSibling;
      if (!prev) return null;
      if (prev.type === 'identifier') return prev;
      const ids = prev.descendantsOfType('identifier');
      return ids.length ? ids[ids.length - 1] : null;
    }
    if (p && (p.type === 'new_expression' || p.type === 'const_object_expression')) {
      const ids = p.children.filter((c) => c.type === 'identifier' || c.type === 'type_identifier');
      return ids.length ? ids[ids.length - 1] : null;
    }
    return null;
  };
  const out = {};
  let count = 0, callees = 0;
  for (const cmp of Object.values(data.compares)) {
    for (const f of cmp.files) {
      if (!f.hunks || !/\.dart$/.test(f.p)) continue;
      const per = (out[f.p] = out[f.p] || {});
      let tree = null;
      if (parser) { try { tree = parser.parse(fs.readFileSync(path.join(HEADDIR, f.p), 'utf8')); } catch {} }
      const add = (line, col, len) => {
        const list = (per[line] = per[line] || []);
        if (!list.some(([c]) => c === col)) { list.push([col, len]); return true; }
        return false;
      };
      for (const h of f.hunks) {
        let n = h.n;
        for (const raw of h.l) {
          const type = raw[0];
          if (type === '-') continue;
          C.tokenize(raw.slice(1), 'dart').filter((t) => t.k === 'id' || t.k === 'ty' || t.k === 'ann').forEach((t) => {
            if (add(n, t.k === 'ann' ? t.c + 1 : t.c, t.k === 'ann' ? t.t.length - 1 : t.t.length)) count++;
          });
          if (tree && type === '+') {
            const col = raw.slice(1).search(/\S/);
            for (let x = col < 0 ? null : tree.rootNode.descendantForPosition({ row: n - 1, column: col }); x && !STATEMENT.test(x.type); x = x.parent) {
              if (x.type !== 'arguments') continue;
              const callee = calleeOf(x);
              if (callee && add(callee.startPosition.row + 1, callee.startPosition.column, callee.endIndex - callee.startIndex)) { count++; callees++; }
            }
          }
          n++;
        }
      }
    }
  }
  fs.writeFileSync(OUT, JSON.stringify(out));
  console.log('files', Object.keys(out).length, 'identifier positions', count, parser ? `(${callees} called functions above their argument lines)` : '');
})();
