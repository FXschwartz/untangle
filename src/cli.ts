#!/usr/bin/env node
// untangle: review a pull request chain by chain, in the browser.
//
//   untangle [flags] [directory]
//   untangle [flags] <pr-url>
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, usage, UsageError, type Options } from './args.js';
import { buildReview } from './build.js';
import { gitMaybe } from './exec.js';
import { LiveSession } from './live.js';
import { Narrator } from './narrate.js';
import { openBrowser } from './open.js';
import { highlighter, progressPage, reviewPage, type PageConfig } from './page.js';
import { ReviewServer } from './server.js';
import { editorFrom, ReviewSession } from './session.js';
import { isPrUrl, resolveDirectory, resolveUrl, type Target } from './target.js';
import { VERSION } from './version.js';

async function main(): Promise<number> {
  let opts: Options;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    process.stderr.write(`${e.message}\n${usage(VERSION)}`);
    return 2;
  }
  if (opts.help) {
    process.stdout.write(usage(VERSION));
    return 0;
  }
  if (opts.version) {
    process.stdout.write(`untangle ${VERSION} (${process.platform}/${process.arch})\n`);
    return 0;
  }

  // Cheap checks first, so a typo doesn't open a browser.
  const byUrl = isPrUrl(opts.target);
  // A file stands for the repository it's in.
  let dir = opts.target;
  if (!byUrl) {
    if (/^https?:\/\//.test(opts.target)) throw new Error(`${opts.target} is not a GitHub pull request URL (https://github.com/<owner>/<repo>/pull/<number>)`);
    if (!fs.existsSync(opts.target)) throw new Error(`${opts.target} does not exist`);
    if (!fs.statSync(opts.target).isDirectory()) dir = path.dirname(opts.target);
    if (!gitMaybe(dir, 'rev-parse', '--git-dir')) throw new Error(`${path.resolve(dir)} is not inside a git repository`);
  }
  const exporting = opts.exportTo !== null;

  const say = new Narrator({ quiet: opts.quiet, verbose: opts.verbose, color: opts.color });
  say.header([`untangle ${VERSION}`]);

  // Served, the page shows the build's progress until the review replaces it.
  let session: ReviewSession | null = null;
  let render: ((config: PageConfig) => string) | null = null;
  let server: ReviewServer | null = null;
  let url = '';
  if (!exporting) {
    server = new ReviewServer(
      { host: opts.host, port: opts.port, portExplicit: opts.portExplicit, basePath: opts.basePath },
      say.status,
      {
        page: () => (render && session ? render(session.config()) : null),
        asset: (name) => {
          if (name !== 'highlight.js') return null;
          const body = highlighter();
          return body && { type: 'text/javascript; charset=utf-8', body };
        },
        call: (route, method, query, body) => (session ? session.call(route, method, query, body) : Promise.resolve({ status: 503, data: { error: 'the review is still being built' } })),
      },
      progressPage(),
      (line) => say.verbose(line),
    );
    url = await server.listen();
    say.serving(url);
    if (opts.quiet) process.stdout.write(url + '\n');
    if (opts.open) void openBrowser(url).then((where) => { if (!where) say.note('no browser to open: open the link above'); else say.verbose(where === 'orca' ? 'opened in Orca’s browser' : 'opened in the browser'); });
  }

  let live: LiveSession | null = null;
  const stop = async () => {
    await server?.close();
    await live?.stop();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  let target: Target;
  try {
    say.step(byUrl ? 'pull request' : 'branch');
    target = byUrl ? await resolveUrl(opts.target, (l) => say.detail(l)) : await resolveDirectory(dir, opts.base, (l) => say.detail(l));
    const t = target;
    const pr = t.pr;
    const branch = !pr ? gitMaybe(t.repo, 'rev-parse', '--abbrev-ref', 'HEAD')?.trim() : null;
    const title = pr ? `#${pr.number} ${pr.title}` : `${branch && branch !== 'HEAD' ? branch : t.headSha.slice(0, 7)} against ${t.baseRef}`;
    const repoName = t.repoKey.replace(/^github\.com\//, '').replace(/^local\//, '');
    // A base given as a commit shows once, not as "65bcfb7 65bcfb7".
    const base = t.baseSha.startsWith(t.baseRef) ? t.baseSha.slice(0, 7) : `${t.baseRef} ${t.baseSha.slice(0, 7)}`;
    const where = `${repoName} · ${base} → ${t.headSha.slice(0, 7)}`;
    say.finish();
    say.title(title, where);
    t.notes.forEach((n) => say.note(n));

    const built = await buildReview(t, { noCache: opts.noCache, label: base.replace(' ', ' · '), title, keepServer: !exporting }, say);
    const key = `${t.repoKey}:${t.baseSha.slice(0, 12)}-${t.headSha.slice(0, 12)}`;
    if (exporting) {
      const file = path.resolve(opts.exportTo!);
      fs.writeFileSync(file, reviewPage(built.data, title, 'export')({ served: false, key, state: null, url: pr ? pr.url : null, where }));
      say.finish();
      say.note(`wrote ${file} (${Math.round(fs.statSync(file).size / 1024)} KB)`);
      return 0;
    }
    live = new LiveSession(t, { step: () => {}, detail: () => {}, note: (l) => say.verbose(l), verbose: (l) => say.verbose(l) }, built.checkouts);
    session = new ReviewSession(t, built.data, live, editorFrom(opts.editor), { key, url: pr ? pr.url : null, where, snapshotKey: pr ? `pr-${pr.number}` : branch && branch !== 'HEAD' ? branch : `head-${t.headSha.slice(0, 7)}` }, say);
    render = reviewPage(built.data, title, 'served');
    say.note(`marks go to the branch ${session.snapshot.branch}`);
    say.ready(url);
    // The language server for live go to definition: kept from the build, or started now.
    live.ensure().catch((e) => say.note(`live go to definition is off: ${(e as Error).message}`));
  } catch (e) {
    say.fail((e as Error).message);
    if (opts.verbose && e instanceof Error && e.stack) say.verbose(e.stack);
    // A moment for the page to show the error.
    if (server) {
      await new Promise((r) => setTimeout(r, 1500));
      await server.close();
    }
    await live?.stop();
    return 1;
  }
  return new Promise<number>(() => {});
}

main().then(
  (code) => process.exit(code),
  (e) => {
    process.stderr.write(`untangle: ${(e as Error).message}\n`);
    process.exit(1);
  },
);
