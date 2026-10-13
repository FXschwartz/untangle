// Why is each change outside every chain?
const fs = require('fs'), path = require('path');
const HEAD = path.resolve(__dirname, '../head') + '/';
const m = require('./model.json').compares.base;
const defs = JSON.parse(fs.readFileSync(__dirname + '/defs.json', 'utf8')).raw;
const blocks = new Map(); const plus = new Map();
m.files.forEach((f) => { f.blocks.forEach((b) => { b.f = f; blocks.set(b.id, b); }); f.hunks.forEach((h, hi) => { let n = h.n; h.rows.forEach(([t, text, ranges], ri) => { if (t !== '-') { if (t === '+') plus.set(f.p + ':' + n, { f, hi, ri, ranges, text }); n++; } }); }); });
const blockAt = (f, hi, ri) => f.blocks.find((b) => b.hunk === hi && ri >= b.first && ri < b.first + b.len);
const inChain = new Set(m.chains.flatMap((c) => c.blocks));
const stand = [...blocks.values()].filter((b) => b.edits.length && !inChain.has(b.id));
const reasons = {};
const examples = {};
const add = (r, b, extra) => { reasons[r] = (reasons[r] || 0) + 1; (examples[r] = examples[r] || []).push(`${b.f.p.split('/').pop()}:${b.member || '-'} ${extra || ''}`); };
for (const b of stand) {
  const lang = b.f.lang;
  if (lang !== 'dart') { add('not Dart (no language server)', b, lang); continue; }
  const edits = b.edits.map((id) => m.edits[id]);
  if (edits.every((e) => e.comment)) { add('only comments changed', b); continue; }
  // links from changed tokens
  const targets = [];
  for (const [key, plusRow] of plus) {
    if (blockAt(plusRow.f, plusRow.hi, plusRow.ri) !== b) continue;
    (plusRow.ranges || []).forEach(([s]) => {
      const t = defs[`${key}:${s}`] || defs[`${key}:${s + 1}`];
      if (!t) return;
      const rel = t[0].startsWith(HEAD) ? t[0].slice(HEAD.length) : null;
      const tp = rel && plus.get(rel + ':' + (t[1] + 1));
      targets.push({ rel, changed: !!tp, same: tp && blockAt(tp.f, tp.hi, tp.ri) === b, name: (plusRow.text.slice(s).match(/^[\w$@]+/) || [''])[0] });
    });
  }
  const grouped = edits.some((e) => e.group != null);
  const toOther = targets.filter((t) => t.changed && !t.same);
  if (toOther.length) add('links to another change, but the chain was dropped (one member)', b, toOther.map((t) => t.name).slice(0, 3).join(','));
  else if (targets.some((t) => t.changed && t.same)) add('uses only declarations in the same change', b, targets.filter((t) => t.same).map((t) => t.name).slice(0, 3).join(','));
  else if (grouped) add('same change as other places, but nothing changed is referenced', b, edits.filter((e) => e.group != null).map((e) => `${e.from}→${e.to}`.slice(0, 50)).slice(0, 2).join(' | '));
  else if (targets.length) add('uses only unchanged declarations', b, targets.map((t) => t.name).slice(0, 3).join(','));
  else add('no resolvable changed identifier (removed lines, literals, keywords)', b, edits.map((e) => `${e.op}`).join(','));
}
console.log('standalone:', stand.length);
Object.entries(reasons).sort((a, b) => b[1] - a[1]).forEach(([r, n]) => { console.log(String(n).padStart(4), r); examples[r].slice(0, 6).forEach((x) => console.log('        ', x.slice(0, 130))); });
