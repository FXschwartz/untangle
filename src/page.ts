// The review page: the viewer with the review's data inlined, as one HTML document.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ReviewData } from './build.js';
import { ROOT } from './version.js';

export interface PageConfig {
  /** Served by untangle: marks, live definitions, whole files and search go through its API. */
  served: boolean;
  /** This review, for keys in browser storage. */
  key: string;
  /** The saved marks and layout. */
  state: unknown;
  /** The pull request's page, and where the comparison runs (repo · base → head). */
  url: string | null;
  where: string;
  /** Absolute paths of the head and base checkouts, for links to the editor (null until they exist). */
  roots?: { head: string; base: string } | null;
  /** How "Open in editor" works: a link built from a template, or a command untangle runs. */
  editor?: { mode: 'uri'; template: string } | { mode: 'command' };
  /** The branch that holds the marks. */
  snapshot?: { branch: string; commit: string | null; note: string | null };
  head?: string;
  base?: string;
}

const read = (f: string) => fs.readFileSync(path.join(ROOT, 'viewer', f), 'utf8');
// JSON inside <script>: no "<" at all, so nothing in it can close or open a tag.
const inline = (data: unknown) => JSON.stringify(data).replace(/</g, '\\u003c');
const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** The highlighter bundle (dist/highlight.js), built by `npm run build`. */
export const highlighter = () => {
  try {
    return fs.readFileSync(path.join(ROOT, 'dist', 'highlight.js'));
  } catch {
    return null;
  }
};

// Generated diffs kept in an exported page, smallest files first: the rest are listed without.
const EXPORT_GENERATED_BUDGET = 1_000_000;

/**
 * Renders the page for a review: everything but the config is inlined once, up front. Served,
 * the page loads the highlighter from untangle and asks for generated diffs when they open;
 * exported, it carries both, within a budget for the generated diffs.
 */
export function reviewPage(data: ReviewData, title: string, mode: 'served' | 'export'): (config: PageConfig) => string {
  const template = read('index.html'), core = read('core.js'), viewer = read('viewer.js');
  const shiki = highlighter();
  for (const [name, src] of [['core.js', core], ['viewer.js', viewer], ['highlight.js', shiki ? shiki.toString('utf8') : '']]) if (/<\/script/i.test(src)) throw new Error(`${name} contains </script`);
  type Generated = { p: string; hunks: unknown };
  // Exported, the smallest generated diffs stay within the budget; served, none: the page asks.
  const generated = (list: Generated[]): Generated[] => {
    if (mode === 'served') return list.map((g) => ({ ...g, hunks: null }));
    const size = (g: Generated) => (g.hunks ? JSON.stringify(g.hunks).length : 0);
    let used = 0;
    const kept = new Set<Generated>();
    [...list].sort((a, b) => size(a) - size(b)).forEach((g) => { if (g.hunks && used + size(g) <= EXPORT_GENERATED_BUDGET) { used += size(g); kept.add(g); } });
    return list.map((g) => ({ ...g, hunks: kept.has(g) ? g.hunks : null }));
  };
  const model = { compares: Object.fromEntries(Object.entries(data.model.compares).map(([k, c]) => [k, { ...c, generated: generated(c.generated) }])) };
  // Served, the highlighter's URL carries its content's hash: a browser never keeps an old one.
  const version = shiki ? crypto.createHash('sha256').update(shiki).digest('hex').slice(0, 12) : '';
  const highlight = !shiki ? '' : mode === 'served' ? `<script src="assets/highlight.js?v=${version}"></script>` : `<script>${shiki.toString('utf8')}</script>`;
  const parts: Array<[string, string]> = [
    ['/*TITLE*/', escapeHtml(title + ' · untangle')],
    ['<!--HIGHLIGHT-->', highlight],
    ['/*CORE*/', core],
    ['/*CONFIG*/', '\0'],
    ['/*MODEL*/', inline(model)],
    ['/*DEFS*/', inline(data.defs)],
    ['/*REFS*/', inline(data.refs)],
    ['/*DEFSOLD*/', inline(data.defsOld)],
    ['/*VIEWER*/', viewer],
  ];
  // One pass over the template, so text in the data that looks like a placeholder stays as it is.
  const found = parts.map(([key, value]) => {
    const at = template.indexOf(key);
    if (at < 0 || template.indexOf(key, at + 1) >= 0) throw new Error(`index.html needs exactly one ${key}`);
    return { at, key, value };
  }).sort((a, b) => a.at - b.at);
  const pieces: string[] = [];
  let page = '', last = 0;
  for (const { at, key, value } of found) {
    page += template.slice(last, at);
    if (key === '/*CONFIG*/') { pieces.push(page); page = ''; } else page += value;
    last = at + key.length;
  }
  pieces.push(page + template.slice(last));
  return (config) => pieces[0] + inline(config) + pieces[1];
}

/** The page shown while the review is being built: it follows the steps and reloads when done. */
export function progressPage(): string {
  return read('progress.html');
}
