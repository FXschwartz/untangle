import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { e2eSkip, launchBrowser, type Browser } from '../helpers/browser.ts';
import { pubspec } from '../helpers/review.ts';
import { TempRepo, type Person } from '../helpers/repo.ts';
import { startUntangle, type UntangleRun } from '../helpers/run.ts';
import { heldGit, type SlowGit } from '../helpers/slow-git.ts';
import { read } from './page.ts';

const skip = e2eSkip();
const ada: Person = { name: 'Ada Review', email: 'ada@example.com', date: '2020-06-01T00:00:00Z' };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('Given a review opened while it builds, as untangle serves it by default, ', { skip, timeout: 180_000 }, () => {
  let repo: TempRepo | undefined;
  let git: (SlowGit & { release(): void }) | undefined;
  let run: UntangleRun | undefined;
  let page: Browser | undefined;
  let cache = '';
  // Whether untangle still serves a moment after the page changed, longer than it waits for a reload.
  const serving = () => Promise.race([run!.exited.then((code) => `stopped (exit ${code})`), sleep(6500).then(() => 'serving')]);

  before(async () => {
    repo = TempRepo.create();
    repo.write('pubspec.yaml', pubspec);
    repo.write('lib/app.dart', "void greet() {\n  print('hi');\n}\n");
    repo.commit({ subject: 'Start', author: ada, committer: ada });
    repo.branch('feature');
    repo.write('lib/app.dart', "void greet() {\n  print('hello');\n}\n");
    repo.commit({ subject: 'Say hello', author: ada, committer: ada });
    cache = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-cache-'));
    // The checkouts wait, so the startup page is up when the browser opens.
    git = heldGit(['worktree']);
    run = await startUntangle(repo.dir, { base: 'main', cacheDir: cache, autoclose: null, quiet: false, env: { PATH: `${git.dir}${path.delimiter}${process.env.PATH ?? ''}` } });
    page = await launchBrowser();
    await page.goto(run.url);
    await page.until(`[...document.querySelectorAll('.st.running .lb')].some((label) => label.firstChild.textContent === 'checkouts')`);
  });

  after(async () => {
    await page?.close();
    await run?.stop();
    git?.remove();
    repo?.remove();
    if (cache) fs.rmSync(cache, { recursive: true, force: true });
  });

  describe('when the build finishes and the review replaces the startup page, ', () => {
    let seen = '';

    before(async () => {
      git!.release();
      await page!.until(`!!document.getElementById('viewer') && !!document.querySelector('.vw-title')`, 120_000);
      seen = await serving();
    });

    it('then untangle keeps serving it.', () => {
      assert.equal(seen, 'serving');
    });
  });

  describe('when the page is reloaded, ', () => {
    let seen = '';

    before(async () => {
      await page!.goto(run!.url);
      await page!.until(`!!document.getElementById('viewer')`);
      seen = `${await serving()}, ${await read(page!, `document.getElementById('viewer') ? 'the review open' : 'no review'`)}`;
    });

    it('then untangle keeps serving it.', () => {
      assert.equal(seen, 'serving, the review open');
    });
  });

  describe('when the page is closed, ', () => {
    let seen = '';

    before(async () => {
      await page!.goto('about:blank');
      const code = await Promise.race([run!.exited, sleep(20_000).then(() => 'still serving')]);
      const said = run!.output().split('\n').filter((line) => line.includes('page closed')).map((line) => line.trim());
      seen = [`exit ${code}`, ...said].join('\n');
    });

    it('then untangle stops a moment later, and says why.', () => {
      assert.equal(seen, 'exit 0\nThe review’s page closed, so untangle stops (-autoclose=false keeps it serving).');
    });
  });
});

describe('Given the startup page of a review, as untangle serves it by default, ', { skip, timeout: 180_000 }, () => {
  let repo: TempRepo | undefined;
  let git: (SlowGit & { release(): void }) | undefined;
  let run: UntangleRun | undefined;
  let page: Browser | undefined;
  let cache = '';

  before(async () => {
    repo = TempRepo.create();
    repo.write('pubspec.yaml', pubspec);
    repo.write('lib/app.dart', "void greet() {\n  print('hi');\n}\n");
    repo.commit({ subject: 'Start', author: ada, committer: ada });
    repo.branch('feature');
    repo.write('lib/app.dart', "void greet() {\n  print('hello');\n}\n");
    repo.commit({ subject: 'Say hello', author: ada, committer: ada });
    cache = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-cache-'));
    git = heldGit(['worktree']);
    run = await startUntangle(repo.dir, { base: 'main', cacheDir: cache, autoclose: null, env: { PATH: `${git.dir}${path.delimiter}${process.env.PATH ?? ''}` } });
    page = await launchBrowser();
    await page.goto(run.url);
    await page.until(`[...document.querySelectorAll('.st.running .lb')].some((label) => label.firstChild.textContent === 'checkouts')`);
  });

  after(async () => {
    await page?.close();
    await run?.stop();
    git?.remove();
    repo?.remove();
    if (cache) fs.rmSync(cache, { recursive: true, force: true });
  });

  describe('when it is closed before the review is ready, ', () => {
    let seen = '';

    before(async () => {
      await page!.goto('about:blank');
      seen = `exit ${await Promise.race([run!.exited, sleep(20_000).then(() => 'still serving')])}`;
    });

    it('then untangle stops a moment later: nobody waits for that review.', () => {
      assert.equal(seen, 'exit 0');
    });
  });
});
