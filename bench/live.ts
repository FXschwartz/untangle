import fs from 'node:fs';
import path from 'node:path';
import { dartParser } from '../analysis/dart.js';
import { reviewClient } from '../test/helpers/http.ts';
import { git } from './scenarios.ts';

export type Raw = Record<string, [string, number, number]>;
export interface Answers {
  headDir: string;
  baseDir: string;
  defs: { raw: Raw };
  defsOld: { raw: Raw };
  calls: { seeds: string[]; graph: Record<string, string[]>; requests: number; depth: number };
  supers: Raw;
}
type Query = Record<string, string>;
interface Position { id: string; query: Query; target: [string, number, number] }
interface Plan {
  seed: number;
  definitions: Position[];
  onward: Array<{ id: string; origin: Position; line: number; col: number; identifier: string }>;
  symbols: Array<{ id: string; name: string; p: string; line: number }>;
}
interface Target { abs: string; side: string | null; p: string; ext?: number; l: number; c: number }
export interface LiveResult { kind: string; id: string; query: unknown; ms: number; status: number; answer: unknown; matches?: boolean; source?: unknown }

const packages = new Map<string, string | null>();

export function packageOf(file: string): string | null {
  const start = path.dirname(file);
  if (packages.has(start)) return packages.get(start)!;
  let dir = start;
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, 'pubspec.yaml'))) {
      packages.set(start, dir);
      return dir;
    }
    dir = path.dirname(dir);
  }
  packages.set(start, null);
  return null;
}

function hash(text: string): number {
  let n = 0x5eed1234;
  for (const char of text) n = Math.imul(n ^ char.charCodeAt(0), 16777619);
  return n >>> 0;
}

function spread<T>(items: T[], group: (item: T) => string, key: (item: T) => string, count: number): T[] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const name = group(item);
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name)!.push(item);
  }
  const lists = [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([, list]) => list.sort((a, b) => hash(key(a)) - hash(key(b)) || key(a).localeCompare(key(b))));
  const result: T[] = [];
  for (let i = 0; result.length < count && lists.some((list) => i < list.length); i++) {
    for (const list of lists) if (list[i] && result.length < count) result.push(list[i]);
  }
  return result;
}

export async function makePlan(answers: Answers, opened: Set<string>, repo: string, base: string, head: string): Promise<Plan> {
  const positions: Position[] = [];
  for (const [side, raw] of [['head', answers.defs.raw], ['base', answers.defsOld.raw]] as const) {
    for (const [key, target] of Object.entries(raw)) {
      const match = /^(.*):(\d+):(\d+)$/.exec(key)!;
      positions.push({ id: `${side}:${key}`, query: { side, p: match[1], l: match[2], c: match[3] }, target });
    }
  }
  const group = (item: Position) => {
    const root = item.query.side === 'head' ? answers.headDir : answers.baseDir;
    return `${item.query.side}:${path.relative(root, packageOf(path.join(root, item.query.p)) ?? root)}`;
  };
  const definitions = spread(positions, group, (item) => item.id, 100);
  const unique = new Map<string, Position>();
  for (const item of [...positions].sort((a, b) => a.id.localeCompare(b.id))) {
    if (!opened.has(item.target[0]) && fs.existsSync(item.target[0]) && !unique.has(item.target[0])) unique.set(item.target[0], item);
  }
  const onwardCandidates: Plan['onward'] = [];
  for (const origin of unique.values()) {
    const lines = fs.readFileSync(origin.target[0], 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^\s*(\/|\*|import\b|export\b|part\b)/.test(line)) continue;
      const match = /\b(String|int|double|bool|Future|List|Map|Set|Iterable)\b/.exec(line);
      if (!match) continue;
      onwardCandidates.push({ id: `onward:${origin.id}:${i + 1}:${match.index}`, origin, line: i + 1, col: match.index, identifier: match[0] });
      break;
    }
  }
  const onward = spread(onwardCandidates, (item) => {
    const file = item.origin.target[0];
    return file.startsWith(answers.headDir + '/') ? 'head' : file.startsWith(answers.baseDir + '/') ? 'base' : file.includes('/dart-sdk/') ? 'sdk' : 'package';
  }, (item) => item.id, 20);

  const changed = new Set(git(repo, 'diff', '--name-only', base, head).split('\n'));
  const active = new Set([...opened].map(packageOf).filter(Boolean));
  const candidates: Plan['symbols'] = [];
  const parser = await dartParser();
  for (const file of git(repo, 'ls-tree', '-r', '--name-only', head).split('\n')) {
    if (!file.endsWith('.dart') || changed.has(file) || file.includes('/generated/')) continue;
    const abs = path.join(answers.headDir, file);
    if (!active.has(packageOf(abs)) || !fs.existsSync(abs)) continue;
    const tree = parser.parse(fs.readFileSync(abs, 'utf8'));
    for (const node of tree!.rootNode.namedChildren) {
      if (!node || node.type !== 'class_definition') continue;
      const name = node.childForFieldName('name')?.text;
      if (name && !name.startsWith('_')) candidates.push({ id: `symbols:${file}:${name}`, name, p: file, line: node.startPosition.row + 1 });
    }
    tree!.delete();
  }
  parser.delete();
  const symbols = spread(candidates, (item) => packageOf(path.join(answers.headDir, item.p)) ?? '', (item) => item.id, 5);
  return { seed: 0x5eed1234, definitions, onward, symbols };
}

export async function checkLive(url: string, plan: Plan): Promise<LiveResult[]> {
  const client = reviewClient(url);
  const opened = await client.open();
  if (opened.status !== 302) throw new Error(`Review token returned ${opened.status}.`);
  const results: LiveResult[] = [];
  const definition = async (query: Query) => {
    const start = performance.now();
    const response = await client.call('definition', { query });
    return { ms: performance.now() - start, status: response.status, answer: response.data, target: (response.data as { target?: Target }).target };
  };

  for (const item of plan.definitions) {
    const result = await definition(item.query);
    const target = result.target;
    results.push({ kind: 'definition', id: item.id, query: item.query, ms: result.ms, status: result.status, answer: result.answer,
      matches: !!target && target.abs === item.target[0] && target.l === item.target[1] + 1 && target.c === item.target[2] });
  }
  for (const item of plan.onward) {
    const source = await definition(item.origin.query);
    if (!source.target) {
      results.push({ kind: 'onward', id: item.id, query: item, ms: source.ms, status: source.status, answer: null, source, matches: false });
      continue;
    }
    const target = source.target;
    const where: Query = target.ext === undefined ? { side: target.side!, p: target.p } : { ext: String(target.ext) };
    const result = await definition({ ...where, l: String(item.line), c: String(item.col) });
    results.push({ kind: 'onward', id: item.id, query: item, ms: result.ms, status: result.status, answer: result.answer,
      source: { status: source.status, answer: source.answer, ms: source.ms }, matches: !!result.target });
  }
  for (const item of plan.symbols) {
    const start = performance.now();
    const response = await client.call('symbols', { query: { q: item.name } });
    const symbols = (response.data as { symbols?: Array<{ name: string; p: string; l: number }> }).symbols ?? [];
    results.push({ kind: 'symbols', id: item.id, query: item, ms: performance.now() - start, status: response.status, answer: response.data,
      matches: symbols.some((symbol) => symbol.name === item.name && symbol.p === item.p) });
  }
  return results;
}
