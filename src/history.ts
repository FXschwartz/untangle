// The pull request's commits, and which commit wrote each changed line.
//
// git log lists the commits between the base and the head; git blame over the same range gives
// each added line the commit that last wrote it, and blame --reverse each removed line the last
// commit that still had it (the commit after it removed it). The page uses both for a lens: the
// changes of some commits, or of everything since an older head (your last review, or the head
// before a force push), which a content diff answers instead.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gitAsync, gitMaybe } from './exec.js';

export interface HistoryCommit {
  sha: string;
  /** Parents in the history, the first one first. */
  parents: string[];
  /** Parents outside it: where the branch starts, or what a merge brought in. */
  outside: string[];
  /** Commits a merge brought in from outside the review (from its first parent to the others). */
  brought: number;
  subject: string;
  body: string;
  author: string;
  email: string;
  /** Author time, in seconds. */
  at: number;
}

export interface History {
  version: string;
  base: string;
  head: string;
  /** Newest first, in topological order. */
  commits: HistoryCommit[];
  /**
   * For each file of the review (by index), each hunk's rows: the commit (an index into
   * commits) that wrote an added line or removed a line, -1 for context and the unknown.
   */
  rows: Array<number[][] | null>;
}

interface ModelFile {
  p: string;
  s: string;
  hunks?: Array<{ o: number; n: number; rows: Array<[string, ...unknown[]]> }> | null;
}

const VERSION = crypto.createHash('sha256').update(fs.readFileSync(fileURLToPath(import.meta.url))).digest('hex').slice(0, 12);
const BODY_MAX = 4000;
const WIDTH = 6;

async function pool<T>(items: T[], width: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => { while (next < items.length) await fn(items[next++]); };
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, worker));
}

/** Final line -> the commit blame gives it, from porcelain output. */
function blameLines(out: string): Map<number, string> {
  const lines = new Map<number, string>();
  for (const line of out.split('\n')) {
    const m = /^([0-9a-f]{40}) \d+ (\d+)/.exec(line);
    if (m) lines.set(Number(m[2]), m[1]);
  }
  return lines;
}

/** The commits of base..head, newest first. */
async function readCommits(repo: string, base: string, head: string): Promise<HistoryCommit[]> {
  const out = await gitAsync(repo, ['log', '--topo-order', '--format=%H%x00%P%x00%an%x00%ae%x00%at%x00%s%x00%b%x1e', `${base}..${head}`]);
  const list = out.split('\x1e').map((r) => r.replace(/^\n/, '')).filter((r) => r.trim()).map((r) => {
    const [sha, parents, author, email, at, subject, body] = r.split('\x00');
    return { sha, all: parents.split(' ').filter(Boolean), author, email, at: Number(at), subject, body: (body || '').trim().slice(0, BODY_MAX) };
  });
  const inRange = new Set(list.map((c) => c.sha));
  const commits = list.map((c) => ({ sha: c.sha, parents: c.all.filter((p) => inRange.has(p)), outside: c.all.filter((p) => !inRange.has(p)), brought: 0, subject: c.subject, body: c.body, author: c.author, email: c.email, at: c.at }));
  // A merge from outside: the commits its other parents brought that its first parent didn't have.
  await Promise.all(commits.map(async (c, i) => {
    const all = list[i].all;
    if (all.length < 2 || !inRange.has(all[0])) return;
    const others = all.slice(1).filter((p) => !inRange.has(p));
    if (!others.length) return;
    const counts = await Promise.all(others.map((p) => gitAsync(repo, ['rev-list', '--count', `${all[0]}..${p}`]).then((x) => Number(x.trim()) || 0, () => 0)));
    c.brought = counts.reduce((a, b) => a + b, 0);
  }));
  return commits;
}

/** Which commit wrote each added and removed line of the review's diff. */
async function attribute(repo: string, base: string, head: string, commits: HistoryCommit[], files: ModelFile[]): Promise<Array<number[][] | null>> {
  const index = new Map(commits.map((c, i) => [c.sha, i]));
  // Who has a commit as a parent: the commit that removed a line is the child of the last one
  // that had it.
  const children = new Map<string, number[]>();
  commits.forEach((c, i) => [...c.parents, ...c.outside].forEach((p) => { if (!children.has(p)) children.set(p, []); children.get(p)!.push(i); }));
  const childOf = (sha: string): number => {
    const kids = children.get(sha) || [];
    const first = kids.find((k) => commits[k].parents[0] === sha || commits[k].outside[0] === sha);
    return first != null ? first : kids.length ? kids[kids.length - 1] : -1;
  };
  // A line at the head that blame traces to outside the range differs from the base only
  // through a merge from outside (main's newer version wasn't taken): the latest such merge.
  const lastMerge = commits.findIndex((c) => c.brought > 0);
  // Where the branch starts: its oldest commits.
  const start = commits.length - 1;
  const rows: Array<number[][] | null> = files.map(() => null);
  await pool(files.map((f, fi) => ({ f, fi })), WIDTH, async ({ f, fi }) => {
    if (!f.hunks || !f.hunks.length) return;
    const adds = f.hunks.some((h) => h.rows.some((r) => r[0] === '+'));
    const dels = f.hunks.some((h) => h.rows.some((r) => r[0] === '-'));
    const blame = (args: string[]) => gitAsync(repo, ['blame', '--porcelain', ...args, '--', f.p]).then(blameLines, () => new Map<number, string>());
    const [added, removed] = await Promise.all([
      adds && f.s !== 'D' ? blame([`${base}..${head}`]) : Promise.resolve(new Map<number, string>()),
      dels && f.s !== 'A' ? blame(['--reverse', `${base}..${head}`]) : Promise.resolve(new Map<number, string>()),
    ]);
    rows[fi] = f.hunks.map((h) => {
      let o = h.o, n = h.n;
      return h.rows.map((r) => {
        let at = -1;
        if (r[0] === '+') {
          const sha = added.get(n);
          at = sha && index.has(sha) ? index.get(sha)! : sha ? lastMerge : -1;
        } else if (r[0] === '-') {
          const last = removed.get(o);
          at = last ? childOf(last) : -1;
          if (at < 0 && last && !index.has(last)) at = start;
        }
        if (r[0] !== '+') o++;
        if (r[0] !== '-') n++;
        return at;
      });
    });
  });
  return rows;
}

/**
 * The review's history: read from history.json in the review's folder when it holds these
 * commits, else from git (and written there).
 */
export async function readHistory(repo: string, base: string, head: string, files: ModelFile[], dir: string | null): Promise<History> {
  const file = dir ? path.join(dir, 'history.json') : null;
  if (file) {
    try {
      const h = JSON.parse(fs.readFileSync(file, 'utf8')) as History;
      if (h.version === VERSION && h.base === base && h.head === head && h.rows.length === files.length) return h;
    } catch {
      // Not read yet.
    }
  }
  const commits = await readCommits(repo, base, head);
  const rows = await attribute(repo, base, head, commits, files);
  const history: History = { version: VERSION, base, head, commits, rows };
  if (file) {
    try {
      fs.writeFileSync(file, JSON.stringify(history));
    } catch {
      // A cache: the next run reads git again.
    }
  }
  return history;
}

/**
 * The hunks of a diff made with --unified=0, by path: the new side's lines (`plus`, under the
 * +++ path) or the old side's (`minus`, under the --- path), as [first, count] pairs. Headers are
 * read only after a "diff --git" line: inside a hunk, a removed line "-- x" reads "--- x".
 */
export function diffHunks(text: string, side: 'plus' | 'minus'): Map<string, Array<[number, number]>> {
  const out = new Map<string, Array<[number, number]>>();
  let file: string | null = null, header = false;
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) { header = true; file = null; continue; }
    if (header) {
      if (line.startsWith('--- ') && side === 'minus') file = line.startsWith('--- a/') ? line.slice(6) : null;
      else if (line.startsWith('+++ ')) { if (side === 'plus') file = line.startsWith('+++ b/') ? line.slice(6) : null; header = false; }
      continue;
    }
    if (!file || !line.startsWith('@@')) continue;
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!m) continue;
    const first = side === 'plus' ? Number(m[3]) : Number(m[1]);
    const count = side === 'plus' ? (m[4] == null ? 1 : Number(m[4])) : (m[2] == null ? 1 : Number(m[2]));
    if (count) { if (!out.has(file)) out.set(file, []); out.get(file)!.push([first, count]); }
  }
  return out;
}
function diffLines(text: string, side: 'plus' | 'minus'): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  diffHunks(text, side).forEach((list, file) => {
    const set = new Set<number>();
    list.forEach(([first, count]) => { for (let k = 0; k < count; k++) set.add(first + k); });
    out.set(file, set);
  });
  return out;
}

export const hasCommit = (repo: string, sha: string) => /^[0-9a-f]{7,40}$/.test(sha) && gitMaybe(repo, 'cat-file', '-e', `${sha}^{commit}`) !== null;

/**
 * The review's rows that changed since an older head: added lines that differ from it, and
 * removed lines it still had. By file (index), hunk and row; null when that head isn't here.
 */
export async function sinceRows(repo: string, base: string, head: string, from: string, files: ModelFile[]): Promise<Record<number, Record<number, number[]>> | null> {
  if (!hasCommit(repo, from)) return null;
  const opts = ['diff', '--unified=0', '--no-renames', '--no-color', '--no-ext-diff'];
  const [toHead, atFrom] = await Promise.all([gitAsync(repo, [...opts, from, head]), gitAsync(repo, [...opts, base, from])]);
  const changed = diffLines(toHead, 'plus'), gone = diffLines(atFrom, 'minus');
  const out: Record<number, Record<number, number[]>> = {};
  files.forEach((f, fi) => {
    if (!f.hunks) return;
    f.hunks.forEach((h, hi) => {
      let o = h.o, n = h.n;
      const hit: number[] = [];
      h.rows.forEach((r, ri) => {
        if (r[0] === '+' && changed.get(f.p)?.has(n)) hit.push(ri);
        if (r[0] === '-' && !gone.get(f.p)?.has(o)) hit.push(ri);
        if (r[0] !== '+') o++;
        if (r[0] !== '-') n++;
      });
      if (hit.length) (out[fi] ??= {})[hi] = hit;
    });
  });
  return out;
}

/**
 * Your last review of another head: the head the newest save on the marks branch recorded,
 * among the saves made before the review moved to this head.
 */
export function reviewedHead(repo: string, ref: string, head: string): { head: string; at: number } | null {
  const out = gitMaybe(repo, 'log', '-n', '5000', '--format=%ct%x09%(trailers:key=Untangle-Head,valueonly,separator=%x2C)', ref, '--');
  if (!out) return null;
  for (const line of out.split('\n')) {
    const [at, h] = line.split('\t');
    const sha = (h || '').trim();
    if (/^[0-9a-f]{40}$/.test(sha) && sha !== head) return { head: sha, at: Number(at) };
  }
  return null;
}

/** The commits a merge brought in: from its first parent to another parent, newest first. */
export async function broughtBy(repo: string, merge: string, max = 200): Promise<{ commits: Array<{ sha: string; subject: string; author: string; at: number }>; more: boolean } | null> {
  if (!hasCommit(repo, merge)) return null;
  const parents = (gitMaybe(repo, 'rev-list', '--parents', '-n', '1', merge) || '').trim().split(' ').slice(1);
  if (parents.length < 2) return { commits: [], more: false };
  const out = await gitAsync(repo, ['log', '--topo-order', `--max-count=${max + 1}`, '--format=%H%x00%an%x00%at%x00%s', ...parents.slice(1), `^${parents[0]}`]);
  const commits = out.split('\n').filter(Boolean).map((r) => { const [sha, author, at, subject] = r.split('\x00'); return { sha, author, at: Number(at), subject }; });
  return { commits: commits.slice(0, max), more: commits.length > max };
}
