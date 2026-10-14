#!/usr/bin/env node
// untangle: review a pull request chain by chain, in the browser.
//
//   untangle [flags] [directory]
//   untangle [flags] <pr-url>
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, usage, UsageError, type Options } from './args.js';
import { buildReview, type ReviewData } from './build.js';
import { reviewDir } from './cache.js';
import { gitMaybe } from './exec.js';
import { Narrator } from './narrate.js';
import { openBrowser } from './open.js';
import { progressPage, reviewPage, type PageConfig } from './page.js';
import { fileHunks } from './pipeline/diff.js';
import { ReviewServer, writeAtomic } from './server.js';
import { isPrUrl, resolveDirectory, resolveUrl, type Target } from './target.js';
import { VERSION } from './version.js';

// A generated file's diff past this many changed lines isn't shown.
const GENERATED_MAX_LINES = 20_000;

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

  const say = new Narrator({ quiet: opts.quiet, verbose: opts.verbose, color: opts.color });
  say.header([`untangle ${VERSION}`]);

  let render: ((config: PageConfig) => string) | null = null;
  let data: ReviewData | null = null;
  let target: Target | null = null;
  let state: unknown = null;
  let stateFile = '';
  let config: Omit<PageConfig, 'state'> | null = null;

  const server = new ReviewServer(
    { host: opts.host, port: opts.port, portExplicit: opts.portExplicit, basePath: opts.basePath },
    say.status,
    {
      page: () => (render && config ? render({ ...config, state }) : null),
      generated: (p) => {
        const g = data?.model.compares.base.generated.find((x: { p: string }) => x.p === p);
        if (!g || !target) return { error: `${p} is not a generated file of this review` };
        if (g.hunks) return { hunks: g.hunks };
        if (g.a + g.d > GENERATED_MAX_LINES) return { error: `${(g.a + g.d).toLocaleString('en-US')} changed lines: too many to show here` };
        return { hunks: fileHunks(target.repo, target.baseSha, target.headSha, p).map((h) => ({ o: h.o, n: h.n, h: h.h, rows: h.l.map((l) => [l[0], l.slice(1)]) })) };
      },
      saveState: (json) => {
        state = JSON.parse(json);
        if (stateFile) writeAtomic(stateFile, json);
      },
    },
    progressPage(),
    (line) => say.verbose(line),
  );
  const url = await server.listen();
  say.serving(url);
  if (opts.quiet) process.stdout.write(url + '\n');
  if (opts.open && !openBrowser(url)) say.note('no browser to open: open the link above');

  const stop = async () => {
    await server.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

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

    stateFile = path.join(reviewDir(t.repoKey, t.baseSha, t.headSha), 'state.json');
    try {
      state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    } catch {
      state = null;
    }
    data = await buildReview(t, { noCache: opts.noCache, label: base.replace(' ', ' · '), title }, say);
    config = { served: true, key: `${t.repoKey}:${t.baseSha.slice(0, 12)}-${t.headSha.slice(0, 12)}`, url: pr ? pr.url : null, where };
    render = reviewPage(data, title);
    say.ready(url);
  } catch (e) {
    say.fail((e as Error).message);
    if (opts.verbose && e instanceof Error && e.stack) say.verbose(e.stack);
    // A moment for the page to show the error.
    await new Promise((r) => setTimeout(r, 1500));
    await server.close();
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
