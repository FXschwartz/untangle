require('./core.js');
const C = globalThis.ReviewCore;
const fs = require('fs');
const refs = require('./refs.json');
const GEN = [C.globToRegExp('**/migrations/**')];
for (const name of ['base', 'since']) {
  const data = JSON.parse(fs.readFileSync('diff.json', 'utf8'));
  const cmp = data.compares[name];
  const gen = cmp.files.filter((f) => f.ga === 'true' || GEN.some((rx) => rx.test(f.p)));
  const genByAttr = gen.filter((f) => f.ga === 'true');
  const files = cmp.files.filter((f) => !gen.includes(f)).map((f) => C.analyzeFile(f));
  const blocks = files.flatMap((f) => f.blocks);
  const real = blocks.filter((b) => b.atoms.length);
  const lines = real.reduce((s, b) => s + b.adds + b.dels, 0);
  const res = { files: files.length, blocks: real.length, layoutOnly: blocks.length - real.length, lines,
    commentOnlyBlocks: real.filter((b) => b.atoms.every((a) => a.commentOnly)).length,
    generated: gen.length, generatedByAttr: genByAttr.length, generatedLines: gen.reduce((s, f) => s + f.a + f.d, 0) };
  for (const mode of ['tokens', 'next']) {
    const groups = C.groupAtoms(files, mode);
    const inGroup = new Set(groups.flatMap((g) => g.atoms));
    const covered = real.filter((b) => b.atoms.every((a) => inGroup.has(a)));
    res[mode] = { groups: groups.length, covered: covered.length, coveredLines: covered.reduce((s, b) => s + b.adds + b.dels, 0), top: groups[0].key.replace(/^dart /, '') + ' ×' + groups[0].count + ' in ' + new Set(groups[0].atoms.map((a) => a.block.file.p)).size + ' files' };
  }
  res.usages = Object.fromEntries(Object.entries(refs[name]).filter(([k]) => /database.dart:180:15|engine.dart:251:23/.test(k)).map(([k, v]) => [k.split('/').pop(), v.length]));
  console.log(name, JSON.stringify(res, null, 1));
}
