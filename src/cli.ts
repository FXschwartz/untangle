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
import { Narrator, type Status } from './narrate.js';
import { openBrowser } from './open.js';
import { fonts, highlighter, progressPage, reviewPage, type PageConfig } from './page.js';
import { ReviewServer } from './server.js';
import { editorFrom, ReviewSession } from './session.js';
import { isPrUrl, latestHead, resolveDirectory, resolveUrl, type Target } from './target.js';
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
  let live: LiveSession | null = null;
  let target: Target | null = null;
  let url = '';
  if (!exporting) {
    server = new ReviewServer(
      { host: opts.host, port: opts.port, portExplicit: opts.portExplicit, basePath: opts.basePath },
      say.status,
      {
        page: () => (render && session ? render(session.config()) : null),
        asset: (name) => {
          const body = name === 'highlight.js' ? highlighter() : name === 'fonts.css' ? fonts() : null;
          return body && { type: name.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8', body };
        },
        call: (route, method, query, body, head) => {
          if (route === 'refresh') return method === 'POST' ? refresh() : check(query.has('check'));
          if (!session || !target) return Promise.resolve({ status: 503, data: { error: 'the review is still being built' } });
          // A page from before a refresh shows other commits: what it sends would land on the wrong lines.
          if (head && head !== target.headSha && route !== 'metrics') return Promise.resolve({ status: 409, data: { error: `untangle now reviews ${target.headSha.slice(0, 7)}: reload the page.`, moved: target.headSha } });
          return session.call(route, method, query, body);
        },
      },
      progressPage(),
      (line) => say.verbose(line),
    );
    url = await server.listen();
    say.serving(url);
    if (opts.quiet) process.stdout.write(url + '\n');
    if (opts.open) void openBrowser(url).then((where) => { if (!where) say.note('no browser to open: open the link above'); else say.verbose(where === 'orca' ? 'opened in Orca’s browser' : 'opened in the browser'); });
  }

  const stop = async () => {
    await server?.close();
    await live?.stop();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  const resolve = (progress: Narrator) => (byUrl ? resolveUrl(opts.target, (l) => progress.detail(l)) : resolveDirectory(dir, opts.base, (l) => progress.detail(l)));
  // What a review is called: in the terminal and the page, and the branch that keeps its marks.
  const names = (t: Target) => {
    const pr = t.pr;
    const branch = !pr ? gitMaybe(t.repo, 'rev-parse', '--abbrev-ref', 'HEAD')?.trim() : null;
    const title = pr ? `#${pr.number} ${pr.title}` : `${branch && branch !== 'HEAD' ? branch : t.headSha.slice(0, 7)} against ${t.baseRef}`;
    const repoName = t.repoKey.replace(/^github\.com\//, '').replace(/^local\//, '');
    // A base given as a commit shows once, not as "65bcfb7 65bcfb7".
    const base = t.baseSha.startsWith(t.baseRef) ? t.baseSha.slice(0, 7) : `${t.baseRef} ${t.baseSha.slice(0, 7)}`;
    return {
      title, base,
      where: `${repoName} · ${base} → ${t.headSha.slice(0, 7)}`,
      key: `${t.repoKey}:${t.baseSha.slice(0, 12)}-${t.headSha.slice(0, 12)}`,
      snapshotKey: pr ? `pr-${pr.number}` : branch && branch !== 'HEAD' ? branch : `head-${t.headSha.slice(0, 7)}`,
    };
  };
  // A target's review (built, or read from the cache), opened for the page.
  const open = async (t: Target, progress: Narrator, noCache: boolean) => {
    const n = names(t);
    const built = await buildReview(t, { noCache, label: n.base.replace(' ', ' · '), title: n.title, keepServer: true }, progress);
    const l = new LiveSession(t, { step: () => {}, detail: () => {}, note: (x) => say.verbose(x), verbose: (x) => say.verbose(x) }, built.checkouts);
    const s = new ReviewSession(t, built.data, l, editorFrom(opts.editor), { key: n.key, url: t.pr ? t.pr.url : null, where: n.where, snapshotKey: n.snapshotKey }, progress);
    return { live: l, session: s, render: reviewPage(built.data, n.title, 'served') };
  };

  // Refreshing: the pull request (or the branch) is looked up again. When it moved, the new review
  // is built while the page keeps working on the current one, and then replaces it.
  let refreshing: { state: 'checking' | 'building' | 'ready' | 'failed'; head: string; status: Status; error?: string } | null = null;
  let latest = { at: 0, head: null as string | null };
  const refreshView = () => (refreshing ? { state: refreshing.state, head: refreshing.head, steps: refreshing.status.steps, error: refreshing.error } : { state: 'idle', head: target?.headSha || null });
  const check = async (ask: boolean) => {
    // Asking GitHub at most twice a minute, however many pages ask.
    if (ask && target && Date.now() - latest.at > 30_000) latest = { at: Date.now(), head: await latestHead(target, byUrl).catch(() => latest.head) };
    return { data: { ...refreshView(), latest: ask ? latest.head : undefined } };
  };
  const refresh = async (): Promise<{ status?: number; data: unknown }> => {
    if (!target) return { status: 503, data: { error: 'the review is still being built' } };
    if (refreshing && (refreshing.state === 'checking' || refreshing.state === 'building')) return { data: refreshView() };
    const progress = new Narrator({ quiet: opts.quiet, verbose: opts.verbose, color: opts.color });
    const r: NonNullable<typeof refreshing> = { state: 'checking', head: target.headSha, status: progress.status };
    refreshing = r;
    let t: Target;
    try {
      progress.header(['', 'Refreshing']);
      progress.step(byUrl ? 'pull request' : 'branch');
      t = await resolve(progress);
      progress.finish();
    } catch (e) {
      progress.fail((e as Error).message);
      Object.assign(r, { state: 'failed', error: (e as Error).message });
      return { data: refreshView() };
    }
    latest = { at: Date.now(), head: t.headSha };
    if (t.headSha === target.headSha && t.baseSha === target.baseSha) {
      refreshing = null;
      progress.note('up to date');
      return { data: { state: 'current', head: t.headSha } };
    }
    const n = names(t);
    r.state = 'building';
    r.head = t.headSha;
    progress.title(n.title, n.where);
    t.notes.forEach((x) => progress.note(x));
    void open(t, progress, false).then(async (next) => {
      const old = live;
      target = t;
      live = next.live;
      session = next.session;
      render = next.render;
      progress.finish();
      progress.note(`now reviewing ${n.where}; marks go to the branch ${next.session.snapshot.branch}`);
      r.state = 'ready';
      await old?.stop();
      next.live.ensure().catch((e) => say.note(`live go to definition is off: ${(e as Error).message}`));
    }, (e) => {
      progress.fail((e as Error).message);
      Object.assign(r, { state: 'failed', error: (e as Error).message });
    });
    return { data: refreshView() };
  };

  try {
    say.step(byUrl ? 'pull request' : 'branch');
    const t = await resolve(say);
    const n = names(t);
    say.finish();
    say.title(n.title, n.where);
    t.notes.forEach((x) => say.note(x));
    if (exporting) {
      const built = await buildReview(t, { noCache: opts.noCache, label: n.base.replace(' ', ' · '), title: n.title, keepServer: false }, say);
      const file = path.resolve(opts.exportTo!);
      fs.writeFileSync(file, reviewPage(built.data, n.title, 'export')({ served: false, key: n.key, state: null, url: t.pr ? t.pr.url : null, where: n.where }));
      say.finish();
      say.note(`wrote ${file} (${Math.round(fs.statSync(file).size / 1024)} KB)`);
      return 0;
    }
    const opened = await open(t, say, opts.noCache);
    target = t;
    live = opened.live;
    session = opened.session;
    render = opened.render;
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
