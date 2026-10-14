// The review page: the viewer with the review's data inlined, as one HTML document.
import fs from 'node:fs';
import path from 'node:path';
import type { ReviewData } from './build.js';
import { ROOT } from './version.js';

export interface PageConfig {
  /** Served by untangle: marks and generated diffs go through its API. */
  served: boolean;
  /** This review, for keys in browser storage. */
  key: string;
  /** The saved marks and layout. */
  state: unknown;
  /** The pull request's page, and where the comparison runs (repo · base → head). */
  url: string | null;
  where: string;
}

const read = (f: string) => fs.readFileSync(path.join(ROOT, 'viewer', f), 'utf8');
// JSON inside <script>: no "<" at all, so nothing in it can close or open a tag.
const inline = (data: unknown) => JSON.stringify(data).replace(/</g, '\\u003c');
const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** Renders the page for a review: everything but the config is inlined once, up front. */
export function reviewPage(data: ReviewData, title: string): (config: PageConfig) => string {
  const template = read('index.html'), core = read('core.js'), viewer = read('viewer.js');
  for (const [name, src] of [['core.js', core], ['viewer.js', viewer]]) if (/<\/script/i.test(src)) throw new Error(`${name} contains </script`);
  // Generated files are listed without their diffs; the page asks for one when it's opened.
  const model = { compares: Object.fromEntries(Object.entries(data.model.compares).map(([k, c]) => [k, { ...c, generated: c.generated.map((g: object) => ({ ...g, hunks: null })) }])) };
  const parts: Array<[string, string]> = [
    ['/*TITLE*/', escapeHtml(title + ' · untangle')],
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
