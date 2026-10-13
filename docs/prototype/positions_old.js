// Identifier positions on removed lines, keyed by old line number, for one comparison.
require('./core.js');
const C = globalThis.ReviewCore;
const name = process.argv[2];
const data = require('./diff.json');
const out = {};
let count = 0;
for (const f of data.compares[name].files) {
  if (!f.hunks || !/\.dart$/.test(f.p)) continue;
  const per = (out[f.p] = out[f.p] || {});
  for (const h of f.hunks) {
    let o = h.o;
    for (const raw of h.l) {
      if (raw[0] === '+') continue;
      if (raw[0] === '-') {
        per[o] = C.tokenize(raw.slice(1), 'dart').filter((t) => t.k === 'id' || t.k === 'ty' || t.k === 'ann').map((t) => (t.k === 'ann' ? [t.c + 1, t.t.length - 1] : [t.c, t.t.length]));
        count += per[o].length;
      }
      o++;
    }
  }
}
require('fs').writeFileSync(`positions_old_${name}.json`, JSON.stringify(out));
console.log(name, 'removed-line identifier positions', count);
