// The raw git diff of a comparison as JSON, with no analysis.
//
// For every changed file: path, status, +/- counts and whether the right side's .gitattributes
// marks it linguist-generated. Generated files (that, or a pattern of the adapters and
// .review.yaml) get stats only; every other file gets its unified-diff hunks (-U3), exactly as
// git produced them.
import YAML from 'yaml';
import { generatedGlobs } from '../../analysis/adapters.js';
import type { Diff, DiffFile } from '../../analysis/analyze.js';
import '../../viewer/core.js';
import { git, gitMaybe, run } from '../exec.js';

const C = globalThis.ReviewCore;

type Hunk = NonNullable<DiffFile['hunks']>[number];

/** The generated-file patterns that apply to a commit: the adapters' and .review.yaml's. */
export function generatedPatterns(repo: string, rev: string): string[] {
  const paths = git(repo, 'ls-tree', '-r', '--name-only', rev).split('\n').filter(Boolean);
  let review: unknown = {};
  try {
    review = YAML.parse(gitMaybe(repo, 'show', `${rev}:.review.yaml`) || '') || {};
  } catch {
    // The analysis reports an invalid .review.yaml.
  }
  return generatedGlobs(paths, review).map(([glob]) => glob);
}

export function parseHunks(text: string): Hunk[] {
  const hunks: Hunk[] = [];
  let cur: Hunk | null = null;
  for (const line of text.split('\n')) {
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(line);
    if (m) {
      cur = { o: +m[1], n: +m[3], h: m[5].trim(), l: [] };
      hunks.push(cur);
    } else if (cur && (line[0] === ' ' || line[0] === '-' || line[0] === '+')) {
      cur.l.push(line);
    }
    // "\ No newline at end of file" is dropped.
  }
  return hunks;
}

/** One file's hunks between two commits. */
export const fileHunks = (repo: string, left: string, right: string, p: string) => parseHunks(git(repo, 'diff', '--no-renames', '-U3', left, right, '--', p));

export function exportDiff(repo: string, compares: Record<string, { left: string; right: string; label: string }>, generated: string[]): Diff {
  const patterns = generated.map((g) => C.globToRegExp(g));
  const result: Diff = { compares: {} };
  for (const [name, { left, right, label }] of Object.entries(compares)) {
    const status = new Map<string, string>();
    for (const row of git(repo, 'diff', '--no-renames', '--name-status', left, right).split('\n').filter(Boolean)) {
      const tab = row.indexOf('\t');
      status.set(row.slice(tab + 1), row.slice(0, tab));
    }
    const numstat = new Map<string, [number, number]>();
    for (const row of git(repo, 'diff', '--no-renames', '--numstat', left, right).split('\n').filter(Boolean)) {
      const [a, d, ...rest] = row.split('\t');
      numstat.set(rest.join('\t'), [a === '-' ? 0 : +a, d === '-' ? 0 : +d]);
    }
    const paths = [...status.keys()].sort();
    const attrs = new Map<string, string>();
    const attrOut = paths.length ? run('git', ['-C', repo, 'check-attr', '--source', right, '--stdin', 'linguist-generated'], { input: paths.join('\n') }) : '';
    for (const row of attrOut.split('\n').filter(Boolean)) {
      const v = row.lastIndexOf(': '), k = row.lastIndexOf(': ', v - 1);
      attrs.set(row.slice(0, k), row.slice(v + 2));
    }
    const files: DiffFile[] = paths.map((p) => {
      const [a, d] = numstat.get(p) || [0, 0];
      const f: DiffFile = { p, s: status.get(p)!, a, d, ga: attrs.get(p) || 'unspecified' };
      if (attrs.get(p) !== 'true' && !patterns.some((rx) => rx.test(p))) f.hunks = fileHunks(repo, left, right, p);
      return f;
    });
    result.compares[name] = { left, right, label, files };
  }
  return result;
}
