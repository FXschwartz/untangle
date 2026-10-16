// Replay pinned language-server answers through both rule sets. This measures grouping,
// independently of analyzer readiness, package resolution, network access and host load.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { analyze } from '../analysis/analyze.js';
import { dartParser } from '../analysis/dart.js';

interface Case {
  name: string;
  answers: string;
  baselineReview?: string;
  state?: string;
}

const [manifestPath, outputPath, baselineModule] = process.argv.slice(2);
if (!manifestPath || !outputPath || !baselineModule) {
  throw new Error('Usage: node bench/cohesion.ts <manifest.json> <output-directory> <baseline-analyze.mjs>');
}

const baselineAnalyze = (await import(pathToFileURL(path.resolve(baselineModule)).href)).analyze;
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { cases: Case[] };
fs.mkdirSync(outputPath, { recursive: true });
const isTestFile = (file: string) => !/\.(md|markdown|rst|pen)$/i.test(file)
  && /(^|\/)(test|test_[a-z0-9_]+|integration_test)\/|_test\.dart$/.test(file);

function metrics(model: any, reviewed: Set<string>) {
  const blocks = model.files.flatMap((file: any) => file.blocks).filter((block: any) => block.edits.length);
  const byId = new Map<string, any>(blocks.map((block: any) => [block.id, block]));
  const linked = new Set<string>(model.chains.flatMap((chain: any) => chain.blocks));
  const reading = (list: any[]) => new Set(list.map((block) => block.unit || block.id)).size;
  const families = new Map<number, number>();
  model.chains.forEach((chain: any) => families.set(chain.family, (families.get(chain.family) || 0) + 1));

  return {
    files: model.files.length,
    generated: model.generated.length,
    blocks: blocks.length,
    changes: reading(blocks),
    remaining: reading(blocks.filter((block: any) => !reviewed.has(block.id))),
    units: model.units?.length || 0,
    chains: model.chains.length,
    singleChangeChains: model.chains.filter((chain: any) => reading(chain.blocks.map((id: string) => byId.get(id)).filter(Boolean)) === 1).length,
    singleNodeChains: model.chains.filter((chain: any) => chain.graph.nodes.length === 1).length,
    newCodeFileLocalChains: model.chains.filter((chain: any) => chain.kind === 'declaration' && chain.files === 1).length,
    outside: reading(blocks.filter((block: any) => !linked.has(block.id))),
    outsideTests: reading(model.files.filter((file: any) => isTestFile(file.p)).flatMap((file: any) => file.blocks)
      .filter((block: any) => block.edits.length && !linked.has(block.id))),
    outsideScenarios: model.units.filter((unit: any) => unit.kind === 'test' && unit.blocks.every((id: string) => !linked.has(id))).length,
    largestFamily: Math.max(0, ...families.values()),
    largestChains: model.chains.map((chain: any) => ({
      name: chain.name, files: chain.files,
      changes: reading(chain.blocks.map((id: string) => byId.get(id)).filter(Boolean)),
      blocks: chain.blocks.length,
    })).sort((a: any, b: any) => b.changes - a.changes).slice(0, 10),
  };
}

function atomIdentity(model: any) {
  return model.files.map((file: any) => ({
    path: file.p, hunks: file.hunks,
    blocks: file.blocks.map((block: any) => ({
      id: block.id, hunk: block.hunk, first: block.first, len: block.len,
      adds: block.adds, dels: block.dels, edits: block.edits, move: block.move, movedTo: block.movedTo,
    })),
  }));
}

function verifyUnits(model: any) {
  const blocks = new Map<string, any>(model.files.flatMap((file: any) => file.blocks.map((block: any) => [block.id, { ...block, file: file.p }])));
  for (const unit of model.units) {
    const owners = model.chains.filter((chain: any) => chain.blocks.some((id: string) => unit.blocks.includes(id)));
    assert.ok(isTestFile(unit.file) || owners.length <= 1, `${unit.file}: ${unit.name} must not have multiple implementation owners`);
    assert.ok(unit.blocks.every((id: string) => blocks.get(id)?.unit === unit.id), `${unit.name} must retain its block ownership`);
    if (!owners.length) continue;

    for (const owner of owners) {
      assert.ok(unit.blocks.every((id: string) => owner.blocks.includes(id)), `${unit.name} must be complete`);
      const nodes = owner.graph.nodes.filter((node: any) => node.unit === unit.id);
      assert.equal(nodes.length, 1, `${unit.name} must be one graph node`);
      assert.deepEqual(new Set(nodes[0].blocks), new Set(unit.blocks));
    }
  }
  for (const chain of model.chains) {
    assert.ok(chain.graph.nodes.length > 1, `${chain.name} must connect more than one node`);
    const changes = new Set(chain.blocks.filter((id: string) => blocks.get(id)?.edits.length).map((id: string) => blocks.get(id).unit || id));
    assert.ok(changes.size > 1, `${chain.name} must contain more than one reading unit`);
    if (chain.kind !== 'declaration') continue;

    assert.ok(chain.blocks.every((id: string) => blocks.get(id)?.unit || isTestFile(blocks.get(id)?.file || '')), `${chain.name} must contain complete introduced implementation units`);
    assert.ok(chain.files > 1, `${chain.name}: file-local new code is not a chain`);
    const reached = new Set<string>([chain.graph.root]);
    let previous = 0;
    while (reached.size !== previous) {
      previous = reached.size;
      for (const edge of chain.graph.edges) {
        if (reached.has(edge.from)) reached.add(edge.to);
        if (reached.has(edge.to)) reached.add(edge.from);
      }
    }
    assert.equal(reached.size, chain.graph.nodes.length, `${chain.name}: every introduced node must be connected by a resolved dependency`);
  }
}

// Independently inspect introduced source types, including ones the grouping pass might
// have missed. Checking only model.units would not catch an omitted class or member.
async function verifyIntroducedTypes(model: any, headDir: string) {
  const parser = await dartParser();
  const types = ['class_definition', 'mixin_declaration', 'extension_declaration', 'enum_declaration', 'extension_type_declaration', 'type_alias'];
  let count = 0;

  for (const file of model.files.filter((file: any) => file.p.endsWith('.dart') && file.s !== 'D')) {
    const source = fs.readFileSync(path.join(headDir, file.p), 'utf8');
    const tree = parser.parse(source)!;
    const lineBlocks = new Map<number, any>();
    const added = new Set<number>();

    file.hunks.forEach((hunk: any, hi: number) => {
      let line = hunk.n;
      hunk.rows.forEach((row: any, ri: number) => {
        if (row[0] === '-') return;
        if (row[0] === '+') {
          added.add(line);
          const block = file.blocks.find((block: any) => block.hunk === hi && ri >= block.first && ri < block.first + block.len);
          if (block) lineBlocks.set(line, block);
        }
        line++;
      });
    });

    try {
      for (const node of tree.rootNode.descendantsOfType(types)) {
        if (!node) continue;
        const start = node.startPosition.row + 1, end = node.endPosition.row + 1;
        const lines = source.split('\n').slice(start - 1, end);
        if (!lines.every((line, i) => /^[\s{}();,]*$/.test(line) || added.has(start + i))) continue;
        const blocks = [...new Set(lines.flatMap((line, i) => line.trim() && lineBlocks.has(start + i) ? [lineBlocks.get(start + i)] : []))];
        if (!blocks.length || blocks.some((block) => block.move || block.movedTo || block.dels)) continue;

        const unit = model.units.find((unit: any) => unit.file === file.p && unit.start <= start && unit.end >= end);
        assert.ok(unit, `${file.p}:${start}: introduced type must have a reading unit`);
        assert.ok(blocks.every((block) => block.unit === unit.id), `${file.p}:${start}: introduced type must include every changed member`);
        count++;
      }
    } finally {
      tree.delete();
    }
  }

  return count;
}

const results: any[] = [];
for (const [index, item] of manifest.cases.entries()) {
  console.log('Replaying', item.name);
  const answers = JSON.parse(fs.readFileSync(item.answers, 'utf8'));
  const input = {
    repo: answers.headDir, headDir: answers.headDir, diff: answers.diff,
    defsRaw: answers.defs.raw, structure: answers.structure,
    old: { base: { dir: answers.baseDir, raw: answers.defsOld.raw, structure: answers.structureOld } },
    calls: answers.calls, supers: answers.supers,
  };
  const started = performance.now();
  const before = (await baselineAnalyze(input)).compares.base;
  const baselineMs = performance.now() - started;
  const changed = performance.now();
  const after = (await analyze(input)).compares.base;
  const analysisMs = performance.now() - changed;
  const failures: string[] = [];
  let introducedTypes = 0;
  try {
    assert.deepEqual(atomIdentity(after), atomIdentity(before), 'edit blocks and saved mark identities must remain unchanged');
    assert.deepEqual(after.generated, before.generated, 'generated code handling must remain unchanged');
    verifyUnits(after);
    introducedTypes = await verifyIntroducedTypes(after, answers.headDir);
  } catch (error) {
    failures.push((error as Error).message);
  }

  const state = item.state ? JSON.parse(fs.readFileSync(item.state, 'utf8')) : null;
  const reviewed = new Set<string>(state?.snapshot?.blocks || []);
  const comparison = answers.diff.compares.base;
  const result = {
    name: item.name, base: comparison.left, head: comparison.right,
    answers: path.resolve(item.answers), baselineMs, analysisMs,
    before: metrics(before, reviewed), after: metrics(after, reviewed), introducedTypes, failures,
    examples: after.units.filter((unit: any) => unit.kind === 'type' || unit.kind === 'model').slice(0, 12),
  };
  fs.writeFileSync(path.join(outputPath, `${index}-model.json`), JSON.stringify({ compares: { base: after } }));
  results.push(result);
  fs.writeFileSync(path.join(outputPath, 'results.json'), JSON.stringify(results, null, 2));
  console.log(JSON.stringify({ name: item.name, before: result.before.changes, after: result.after.changes, units: result.after.units, failures }));
}

if (results.some((result) => result.failures.length)) process.exitCode = 1;
