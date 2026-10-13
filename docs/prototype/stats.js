const m = require('./model.json');
for (const [name, c] of Object.entries(m.compares)) {
  const blocks = c.files.flatMap((f) => f.blocks).filter((b) => b.edits.length);
  const inChain = new Set(c.chains.flatMap((x) => x.blocks));
  const multi = c.chains.filter((x) => x.files > 1).length;
  const lines = blocks.reduce((s, b) => s + b.adds + b.dels, 0);
  const g0 = c.groups[0], e0 = c.edits[g0.parts[0]];
  const gen = c.generated;
  console.log(name, JSON.stringify({ files: c.files.length, blocks: blocks.length, lines, edits: c.edits.length, groups: c.groups.length, groupedEdits: c.groups.reduce((s, g) => s + g.edits.length, 0), chains: c.chains.length, multiFile: multi, singleFile: c.chains.length - multi, inChain: inChain.size, notInChain: blocks.length - inChain.size, top: c.chains.slice(0, 4).map((x) => `${x.name} ${x.blocks.length}/${x.files}f/${x.graph.nodes.length}n`), g0: `${e0.op} ${e0.where} ${e0.from}→${e0.to} x${g0.count}`, generated: gen.length, peekable: gen.filter((g) => g.hunks).length, genLines: gen.reduce((s, g) => s + g.a + g.d, 0) }));
}
