// Identifier positions on the head side (context and added lines) of Dart files.
require('./core.js');
const C = globalThis.ReviewCore;
// node positions.js <diff.json> <positions.json>
const [IN, OUT] = process.argv.slice(2);
const data = JSON.parse(require('fs').readFileSync(IN, 'utf8'));
const out = {};
let count = 0;
for (const cmp of Object.values(data.compares)) {
  for (const f of cmp.files) {
    if (!f.hunks || !/\.dart$/.test(f.p)) continue;
    const per = (out[f.p] = out[f.p] || {});
    for (const h of f.hunks) {
      let n = h.n;
      for (const raw of h.l) {
        const type = raw[0];
        if (type === '-') continue;
        if (!per[n]) {
          per[n] = C.tokenize(raw.slice(1), 'dart').filter((t) => t.k === 'id' || t.k === 'ty' || t.k === 'ann').map((t) => (t.k === 'ann' ? [t.c + 1, t.t.length - 1] : [t.c, t.t.length]));
          count += per[n].length;
        }
        n++;
      }
    }
  }
}
require('fs').writeFileSync(OUT, JSON.stringify(out));
console.log('files', Object.keys(out).length, 'identifier positions', count);
