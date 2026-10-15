import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import type { Answers, LiveResult } from './live.ts';

export function normalize(value: unknown, roots: { headDir: string; baseDir: string }): unknown {
  if (typeof value === 'string') {
    let result = value;
    for (const [root, label] of [[roots.headDir, '<head>'], [roots.baseDir, '<base>']]) {
      result = result.replaceAll(pathToFileURL(root).href, label).replaceAll(root, label);
    }
    return result;
  }
  if (Array.isArray(value)) return value.map((item) => normalize(item, roots));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'ext').sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, key === 'symbols' && Array.isArray(item)
        ? item.map((symbol) => normalize(symbol, roots)).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
        : normalize(item, roots)]));
  }
  return value;
}

export function difference(a: Record<string, unknown>, b: Record<string, unknown>) {
  const counts = { same: 0, missing: 0, extra: 0, different: 0 };
  const examples: Record<string, unknown[]> = { missing: [], extra: [], different: [] };
  for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
    const kind = !(key in a) ? 'extra' : !(key in b) ? 'missing' : isDeepStrictEqual(a[key], b[key]) ? 'same' : 'different';
    counts[kind]++;
    if (kind !== 'same' && examples[kind].length < 20) examples[kind].push({ key, a: a[key], b: b[key] });
  }
  return { ...counts, examples };
}

function load(dir: string) {
  const result = JSON.parse(fs.readFileSync(path.join(dir, 'result.json'), 'utf8'));
  const answers = JSON.parse(fs.readFileSync(path.join(dir, 'answers.json'), 'utf8')) as Answers;
  const n = (value: unknown) => normalize(value, answers) as Record<string, unknown>;
  return { result, answers, sections: {
    'defs.raw': n(answers.defs.raw),
    'defsOld.raw': n(answers.defsOld.raw),
    'calls.seeds': Object.fromEntries(answers.calls.seeds.map((seed) => [seed, true])),
    'calls.graph': n(Object.fromEntries(Object.entries(answers.calls.graph).map(([key, values]) => [key, [...values].sort()]))),
    'supers': n(answers.supers),
    'live': n(Object.fromEntries((result.live as LiveResult[]).map((item) => [item.id, {
      kind: item.kind, query: item.query, status: item.status, answer: item.answer,
      source: item.source && { status: (item.source as any).status, answer: (item.source as any).answer },
    }]))),
  } };
}

function facts(dir: string): Record<string, Record<string, unknown>> {
  const { result, answers, sections } = load(dir);
  const graph: Record<string, unknown> = {};
  for (const [node, edges] of Object.entries(answers.calls.graph)) {
    graph[`node:${node}`] = true;
    for (const edge of edges) graph[`edge:${node}\n${edge}`] = true;
  }
  const probes: Record<string, unknown> = {};
  const targets: Record<string, unknown> = {};
  const symbols: Record<string, unknown> = {};
  for (const item of result.live as LiveResult[]) {
    probes[item.id] = { query: normalize(item.query, answers), status: item.status };
    const answer = item.answer as { target?: { abs: string; l: number; c: number }; symbols?: unknown[] } | null;
    const source = item.source as { answer?: { target?: { abs: string; l: number; c: number } } } | null;
    for (const [key, target] of [[item.id, answer?.target], [`${item.id}:source`, source?.answer?.target]] as const) {
      if (target) targets[key] = normalize([target.abs, target.l, target.c], answers);
    }
    for (const symbol of answer?.symbols ?? []) {
      const value = normalize(symbol, answers);
      symbols[`${item.id}\n${JSON.stringify(value)}`] = value;
    }
  }
  return { 'defs.raw': sections['defs.raw'], 'defsOld.raw': sections['defsOld.raw'],
    'calls.seeds': sections['calls.seeds'], 'calls.graph': graph, supers: sections.supers,
    'live.probes': probes, 'live.targets': targets, 'live.symbols': symbols };
}

export function unionDifferences(baselines: Array<Record<string, Record<string, unknown>>>, candidate: Record<string, Record<string, unknown>>) {
  const expected: Record<string, Record<string, unknown>> = {};
  const conflicts: Array<{ section: string; key: string; a: unknown; b: unknown }> = [];
  for (const baseline of baselines) {
    for (const [section, rows] of Object.entries(baseline)) {
      const union = expected[section] ??= {};
      for (const [key, value] of Object.entries(rows)) {
        if (key in union && !isDeepStrictEqual(union[key], value)) conflicts.push({ section, key, a: union[key], b: value });
        else union[key] = value;
      }
    }
  }
  const sections = Object.fromEntries([...new Set([...Object.keys(expected), ...Object.keys(candidate)])].map((section) =>
    [section, difference(expected[section] ?? {}, candidate[section] ?? {})]));
  return { sections, conflicts, passes: conflicts.length === 0 && Object.values(sections).every((section) => !section.missing && !section.different) };
}

/** Only the SDK and Flutter's identical SDK source copies may share a target identity. */
export function sdkTargets() {
  const verified = new Map<string, boolean>();
  return (target: unknown): unknown => {
    if (!Array.isArray(target) || target.length !== 3 || typeof target[0] !== 'string') return target;
    const match = /^(.*\/bin\/cache\/)(?:dart-sdk|pkg\/sky_engine)\/lib\/(.+)$/.exec(target[0]);
    if (!match) return target;
    const canonical = match[1] + 'dart-sdk/lib/' + match[2];
    if (!verified.has(canonical)) {
      let same = false;
      try {
        const sdk = fs.readFileSync(canonical);
        const flutter = fs.readFileSync(match[1] + 'pkg/sky_engine/lib/' + match[2]);
        same = sdk.equals(flutter);
      } catch { /* A missing copy is not an alias. */ }
      verified.set(canonical, same);
    }
    return verified.get(canonical) ? [canonical, target[1], target[2]] : target;
  };
}

export function compareUnion(baselineDirs: string[], candidateDir: string) {
  if (!baselineDirs.length) throw new Error('At least one baseline run is required.');
  const results = [...baselineDirs, candidateDir].map((dir) => load(dir).result);
  const sameScenario = results.every((r) => r.scenario.base === results[0].scenario.base && r.scenario.head === results[0].scenario.head);
  const originals = baselineDirs.map(facts);
  const candidate = facts(candidateDir);
  const canonical = sdkTargets();
  const targetSections = new Set(['defs.raw', 'defsOld.raw', 'supers', 'live.targets']);
  const equivalent = (sections: Record<string, Record<string, unknown>>) => Object.fromEntries(
    Object.entries(sections).map(([section, rows]) => [section, targetSections.has(section)
      ? Object.fromEntries(Object.entries(rows).map(([key, value]) => [key, canonical(value)])) : rows]));
  const compared = unionDifferences(originals.map(equivalent), equivalent(candidate));
  const sdkAliases: Array<{ section: string; key: string; baseline: unknown; candidate: unknown }> = [];
  for (const section of targetSections) for (const [key, value] of Object.entries(candidate[section])) {
    const values = originals.flatMap((baseline) => key in baseline[section] ? [baseline[section][key]] : []);
    if (values.some((expected) => isDeepStrictEqual(expected, value))) continue;
    const expected = values.find((expected) => isDeepStrictEqual(canonical(expected), canonical(value)));
    if (expected !== undefined) sdkAliases.push({ section, key, baseline: expected, candidate: value });
  }
  return { baselines: baselineDirs, candidate: candidateDir, sameScenario, ...compared, sdkAliases,
    passes: sameScenario && results.every((r) => r.status === 'completed') && compared.passes };
}

export function compare(aDir: string, bDir: string) {
  const a = load(aDir);
  const b = load(bDir);
  const sections = Object.fromEntries(Object.keys(a.sections).map((name) => [name,
    difference(a.sections[name as keyof typeof a.sections], b.sections[name as keyof typeof b.sections]) ]));
  const names = [...new Set([...a.result.steps, ...b.result.steps].map((step: { label: string }) => step.label))];
  const rows = names.map((name) => ({ metric: `${name} (s)`,
    a: a.result.steps.find((step: { label: string }) => step.label === name)?.durationMs / 1000,
    b: b.result.steps.find((step: { label: string }) => step.label === name)?.durationMs / 1000 }));
  for (const name of ['headDefinitions', 'baseDefinitions', 'testCalls', 'overrides']) {
    rows.push({ metric: `${name} (s)`, a: a.result.traffic?.stages[name]?.durationMs / 1000, b: b.result.traffic?.stages[name]?.durationMs / 1000 });
  }
  for (const [label, key, field] of [['build peak', 'served', 'hwmBytes'], ['served', 'served', 'rssBytes'], ['after live', 'afterLive', 'rssBytes']]) {
    rows.push({ metric: `${label} (MiB)`, a: a.result.memory[key]?.[field] / 2 ** 20, b: b.result.memory[key]?.[field] / 2 ** 20 });
  }
  const sameScenario = a.result.scenario.base === b.result.scenario.base && a.result.scenario.head === b.result.scenario.head;
  return { a: aDir, b: bDir, sameScenario, sections, rows,
    equal: sameScenario && a.result.status === 'completed' && b.result.status === 'completed'
      && Object.values(sections).every((section) => section.missing === 0 && section.extra === 0 && section.different === 0) };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  if (args[0] === '--union') {
    const at = args.indexOf('--candidate');
    if (at < 2 || at !== args.length - 2) throw new Error('Usage: node bench/compare.ts --union <baselineA> [baselineB ...] --candidate <run>');
    const result = compareUnion(args.slice(1, at), args[at + 1]);
    console.log(JSON.stringify(result, null, 2));
    console.table(compare(args[1], args[at + 1]).rows);
    if (!result.passes) process.exitCode = 1;
  } else {
    const [a, b] = args;
    if (!a || !b) throw new Error('Usage: node bench/compare.ts <runA> <runB>');
    const result = compare(a, b);
    console.log(JSON.stringify({ a: result.a, b: result.b, sameScenario: result.sameScenario, sections: result.sections, equal: result.equal }, null, 2));
    console.table(result.rows.map((row) => ({ metric: row.metric,
      A: Number.isFinite(row.a) ? row.a.toFixed(3) : 'unmeasured', B: Number.isFinite(row.b) ? row.b.toFixed(3) : 'unmeasured' })));
    if (!result.equal) process.exitCode = 1;
  }
}
