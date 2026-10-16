// Where each identifier on a side of the diff is defined, from the Dart analysis server, with a
// snippet of every definition for the page's peek.
import fs from 'node:fs';
import path from 'node:path';
import type { RawDefinitions } from '../../analysis/analyze.js';
import type { DartServer, Location } from '../lsp/dart.js';
import type { Positions } from './positions.js';
import { ModelDefinitions } from '../model-definitions.js';

export interface Target {
  /** Path: relative to the checkout, inside a package, or dart:… for the SDK. */
  p: string;
  /** Where: repo, package, sdk or other. */
  w: 'repo' | 'package' | 'sdk' | 'other';
  /** Line (1-based), column, first snippet line and the snippet. */
  l: number;
  c: number;
  s: number;
  code: string[];
}

export interface Definitions {
  targets: Target[];
  /** path -> line -> [column, length, target index]. */
  defs: Record<string, Record<string, Array<[number, number, number]>>>;
  raw: RawDefinitions;
}

/** What the page embeds: snippets of at most 10 lines of 160 characters, no raw answers. */
export interface SlimDefinitions {
  targets: Array<Omit<Target, 'c'>>;
  defs: Definitions['defs'];
}

export const slim = (d: Definitions): SlimDefinitions => ({
  targets: d.targets.map((t) => ({ p: t.p, w: t.w, l: t.l, s: t.s, code: t.code.slice(0, 10).map((c) => c.slice(0, 160)) })),
  defs: d.defs,
});

function short(file: string, root: string): [string, Target['w']] {
  if (file.startsWith(root + '/')) return [file.slice(root.length + 1), 'repo'];
  const pub = file.indexOf('/.pub-cache/');
  if (pub >= 0) return [file.slice(pub + '/.pub-cache/'.length).split('/').slice(2).join('/'), 'package'];
  const sdk = /\/(?:dart-sdk|pkg\/sky_engine)\/lib\/(.+)$/.exec(file);
  if (sdk) return ['dart:' + sdk[1], 'sdk'];
  return [path.basename(file), 'other'];
}

export async function definitions(server: DartServer, root: string, positions: Positions, onProgress?: (done: number, total: number) => void): Promise<Definitions> {
  const items: Array<[string, number, number, number]> = [];
  for (const [p, lines] of Object.entries(positions)) for (const [line, cols] of Object.entries(lines)) for (const [col, len] of cols) items.push([p, +line, col, len]);
  const results = await server.askFiles(items, ([p]) => path.join(root, p),
    ([p, line, col]) => server.definition(path.join(root, p), line - 1, col).catch(() => null),
    (done) => onProgress?.(done, items.length));

  const collector = definitionCollector(root);
  items.forEach(([p, line, col, len], i) => {
    const result = results[i];
    if (result) collector.add(p, line, col, len, result);
  });
  return collector.data;
}

/** Builds the compact peek index from resolved facts without retaining the analyzer AST. */
export function definitionCollector(root: string): {
  data: Definitions;
  add(p: string, line: number, col: number, len: number, res: Location | null): void;
} {
  const models = new ModelDefinitions(root);
  const targets: Target[] = [], index = new Map<string, number>(), files = new Map<string, string[] | null>();
  const lines = (file: string) => {
    if (!files.has(file)) {
      if (files.size >= 64) files.delete(files.keys().next().value!);
      try {
        files.set(file, fs.readFileSync(file, 'utf8').split('\n'));
      } catch {
        files.set(file, null);
      }
    }
    return files.get(file);
  };
  const defs: Definitions['defs'] = {}, raw: RawDefinitions = {};
  return {
    data: { targets, defs, raw },
    add(p, line, col, len, res) {
      const original = res;
      res = models.resolve(path.join(root, p), line - 1, col, res) || res;
      if (!res) return;
      const key = `${res.path}\n${res.line}\n${res.col}`;
      if (!index.has(key)) {
        const src = lines(res.path) || [];
        // The snippet starts at the doc comments and annotations above the definition.
        let start = res.line;
        while (start > 0 && start > res.line - 6 && /^(\/\/\/|@|#)/.test((src[start - 1] || '').trim())) start--;
        const [p2, w] = short(res.path, root);
        index.set(key, targets.length);
        targets.push({ p: p2, w, l: res.line + 1, c: res.col, s: start + 1, code: src.slice(start, Math.min(src.length, res.line + 8)) });
      }
      ((defs[p] ??= {})[line] ??= []).push([col, len, index.get(key)!]);
      if (original) raw[`${p}:${line}:${col}`] = [original.path, original.line, original.col];
    },
  };
}
