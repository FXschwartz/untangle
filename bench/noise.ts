import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { normalize } from './compare.ts';
import type { Answers } from './live.ts';
import { messages, type Message } from './traffic.ts';

// Keep every differing position and every attempt, even when the console comparison is capped.
const [aDir, bDir] = process.argv.slice(2);
if (!aDir || !bDir) throw new Error('Usage: node bench/noise.ts <runA> <runB>');

function load(dir: string) {
  const result = JSON.parse(fs.readFileSync(path.join(dir, 'result.json'), 'utf8'));
  const answers = JSON.parse(fs.readFileSync(path.join(dir, 'answers.json'), 'utf8')) as Answers;
  return { result, answers };
}

const a = load(aDir);
const b = load(bDir);
const selections: Array<{ section: string; key: string; a: unknown; b: unknown; method: string; file: string; line: number; col: number }> = [];
for (const [section, aRows, bRows] of [
  ['defs.raw', a.answers.defs.raw, b.answers.defs.raw],
  ['defsOld.raw', a.answers.defsOld.raw, b.answers.defsOld.raw],
  ['supers', a.answers.supers, b.answers.supers],
  ['calls.graph', a.answers.calls.graph, b.answers.calls.graph],
  ['calls.seeds', Object.fromEntries(a.answers.calls.seeds.map((key) => [key, true])), Object.fromEntries(b.answers.calls.seeds.map((key) => [key, true]))],
] as const) {
  for (const key of [...new Set([...Object.keys(aRows), ...Object.keys(bRows)])].sort()) {
    const av = normalize(aRows[key], a.answers);
    const bv = normalize(bRows[key], b.answers);
    if (isDeepStrictEqual(av, bv)) continue;
    const match = /^(.*):(\d+):(\d+)$/.exec(key)!;
    const root = section === 'defsOld.raw' ? '<base>' : '<head>';
    const method = section === 'supers' ? 'dart/textDocument/super' : section === 'calls.graph' ? 'callHierarchy/outgoingCalls'
      : section === 'calls.seeds' ? 'textDocument/prepareCallHierarchy' : 'textDocument/definition';
    selections.push({ section, key, a: av ?? null, b: bv ?? null, method, file: `${root}/${match[1]}`,
      line: Number(match[2]) - (section.startsWith('calls.') ? 0 : 1), col: Number(match[3]) });
  }
}

async function evidence(dir: string, run: ReturnType<typeof load>) {
  const selected = new Map(selections.map((s) => [`${s.method}\n${s.file}\n${s.line}\n${s.col}`, `${s.section}:${s.key}`]));
  const attempts: Record<string, unknown[]> = {};
  const pending = new Map<string | number, { row: Message; key: string | null; analyzing: unknown }>();
  const status: Array<{ ms: number; params: unknown }> = [];
  const opens: Array<{ ms: number; file: unknown }> = [];
  const symbols: unknown[] = [];
  let analyzing: unknown = null;
  for await (const row of messages(path.join(dir, 'traffic.jsonl'))) {
    if (row.method === '$/analyzerStatus') {
      analyzing = (row.params as { isAnalyzing?: boolean } | undefined)?.isAnalyzing ?? null;
      status.push({ ms: row.ms, params: row.params ?? null });
    }
    if (row.method === 'textDocument/didOpen' && row.uri) opens.push({ ms: row.ms, file: normalize(fileURLToPath(row.uri), run.answers) });
    if (row.direction === 'client' && row.kind === 'request') {
      const file = row.uri ? normalize(fileURLToPath(row.uri), run.answers) : '';
      const key = selected.get(`${row.method}\n${file}\n${row.position?.line}\n${row.position?.character}`) ?? null;
      if (key || row.method === 'workspace/symbol') pending.set(row.id!, { row, key, analyzing });
    }
    if (row.direction === 'server' && row.kind === 'response' && pending.has(row.id!)) {
      const request = pending.get(row.id!)!;
      pending.delete(row.id!);
      const attempt = { id: row.id, requestedMs: request.row.ms, answeredMs: row.ms, empty: row.empty, size: row.size, error: row.error ?? null,
        analyzingAtRequest: request.analyzing, analyzingAtResponse: analyzing,
        phase: run.result.trafficBoundaryMs != null
          ? request.row.ms <= run.result.trafficBoundaryMs ? 'batch' : 'live'
          : request.row.epochMs < run.result.servedAt ? 'batch' : 'live' };
      if (request.key) (attempts[request.key] ??= []).push(attempt);
      else symbols.push({ ...attempt, query: request.row.query ?? null });
    }
  }
  return { attempts, analyzerStatus: status, opens, symbols };
}

const liveA = new Map<string, any>(a.result.live.map((item: any) => [item.id, item]));
const liveB = new Map<string, any>(b.result.live.map((item: any) => [item.id, item]));
const live = [];
for (const id of [...new Set([...liveA.keys(), ...liveB.keys()])].sort()) {
  const av = liveA.get(id);
  const bv = liveB.get(id);
  const answerA = normalize(av?.answer, a.answers);
  const answerB = normalize(bv?.answer, b.answers);
  const symbolA: unknown[] = av?.answer?.symbols ?? [];
  const symbolB: unknown[] = bv?.answer?.symbols ?? [];
  const setA = new Set(symbolA.map((item) => JSON.stringify(normalize(item, a.answers))));
  const setB = new Set(symbolB.map((item) => JSON.stringify(normalize(item, b.answers))));
  const orderChanged = !isDeepStrictEqual(symbolA.map((item) => normalize(item, a.answers)), symbolB.map((item) => normalize(item, b.answers)));
  if (isDeepStrictEqual(answerA, answerB) && !orderChanged) continue;
  const setChanged = setA.size !== setB.size || [...setA].some((item) => !setB.has(item));
  live.push({ id, kind: av?.kind ?? bv?.kind, a: answerA, b: answerB,
    ...(av?.kind === 'symbols' || bv?.kind === 'symbols' ? {
      counts: [symbolA.length, symbolB.length], capReached: symbolA.length >= 200 || symbolB.length >= 200,
      setChanged, orderOnly: orderChanged && !setChanged,
      removed: [...setA].filter((item) => !setB.has(item)).map((item) => JSON.parse(item)),
      added: [...setB].filter((item) => !setA.has(item)).map((item) => JSON.parse(item)),
    } : {}) });
  const item = av ?? bv;
  if (item.kind === 'definition' || item.kind === 'onward') {
    const file = item.kind === 'definition' ? `<${item.query.side}>/${item.query.p}`
      : normalize(item.query.origin.target[0], av ? a.answers : b.answers) as string;
    const line = Number(item.kind === 'definition' ? item.query.l : item.query.line) - 1;
    const col = Number(item.kind === 'definition' ? item.query.c : item.query.col);
    if (!selections.some((s) => s.method === 'textDocument/definition' && s.file === file && s.line === line && s.col === col)) {
      selections.push({ section: 'live', key: id, a: answerA, b: answerB, method: 'textDocument/definition', file, line, col });
    }
  }
}

console.log(JSON.stringify({ a: aDir, b: bDir, differences: selections, live,
  evidenceA: await evidence(aDir, a), evidenceB: await evidence(bDir, b) }, null, 2));
