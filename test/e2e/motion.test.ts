import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { e2eSkip, launchBrowser, type Browser } from '../helpers/browser.ts';
import { reviewClient, waitForReview } from '../helpers/http.ts';
import { pubspec } from '../helpers/review.ts';
import { TempRepo, type Person } from '../helpers/repo.ts';
import { startUntangle, type UntangleRun } from '../helpers/run.ts';
import { read, rest } from './page.ts';

const skip = e2eSkip();
const ada = (date: string): Person => ({ name: 'Ada Review', email: 'ada@example.com', date });
const pads = Array.from({ length: 80 }, (_, index) => `// pad ${index + 1}`);
const beforeNotes = ['// start', ...pads, ''].join('\n');
const afterNotes = ['// changed', ...pads, ''].join('\n');

describe('Given a served review with motion left on, ', { skip, timeout: 180_000 }, () => {
  let repo: TempRepo | undefined;
  let run: UntangleRun | undefined;
  let page: Browser | undefined;
  let cache = '';
  let url = '';

  before(async () => {
    const author = ada('2020-04-01T15:00:00Z');
    const later = ada('2020-04-02T15:00:00Z');
    repo = TempRepo.create();
    repo.write('pubspec.yaml', pubspec);
    repo.write('lib/notes.dart', beforeNotes);
    repo.write('lib/end.dart', ['// top', ...pads, "void tail() {\n  print('a');\n}\n"].join('\n'));
    repo.commit({ subject: 'Start', author, committer: author });
    repo.branch('feature');
    repo.write('lib/notes.dart', afterNotes);
    repo.write('lib/end.dart', ['// top', ...pads, "void tail() {\n  print('b');\n}\n"].join('\n'));
    repo.commit({ subject: 'Change', author: later, committer: later });
    cache = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-cache-'));
    run = await startUntangle(repo.dir, { base: 'main', cacheDir: cache });
    url = run.url;
    await waitForReview(reviewClient(url));
    page = await launchBrowser();
    await page.reducedMotion(false);
    await page.goto(url);
    await page.until(`!!document.querySelector('.t-head')`, 30_000);
  });

  after(async () => {
    await page?.close();
    await run?.stop();
    repo?.remove();
    if (cache) fs.rmSync(cache, { recursive: true, force: true });
  });

  async function openFile(file: string): Promise<void> {
    await page!.click('[data-tab="files"]');
    await page!.until(`!!document.querySelector(${JSON.stringify(`[data-open="${file}"]`)})`);
    await page!.click(`[data-open="${file}"]`);
    await page!.until(`!!document.querySelector(${JSON.stringify(`.code[data-p="${file}"]`)})`);
  }

  describe('when a change is marked reviewed, ', () => {
    let during: string;
    let afterMark: string;

    before(async () => {
      await rest(page!);
      await openFile('lib/notes.dart');
      await page!.until(`!!document.querySelector('.tick')`);
      await page!.click('.tick');
      during = await read(page!, `document.getAnimations().length || document.querySelector('.ghost') ? 'moving' : 'still'`);
      await page!.until(`document.querySelector('.tick.on') || (document.querySelector('#vw-main')?.textContent || '').includes('reviewed')`);
      afterMark = await read(page!, `document.querySelector('.tick.on') || (document.querySelector('#vw-main')?.textContent || '').includes('reviewed') ? 'reviewed' : 'open'`);
    });

    it('then the fold animates and the change ends reviewed.', () => {
      assert.equal(`${during}\n${afterMark}`, 'moving\nreviewed');
    });
  });

  describe('when more lines are opened from a divider, ', () => {
    let during: string;
    let shown: string;

    before(async () => {
      await rest(page!);
      await page!.goto(url);
      await page!.until(`!!document.querySelector('.t-head')`, 30_000);
      await openFile('lib/end.dart');
      await page!.until(`!!document.querySelector('[data-act="more"]')`);
      const beforeMore = await read(page!, `document.querySelector('[data-act="more"]')?.textContent ?? ''`);
      await page!.click('[data-act="more"]');
      during = await read(page!, `document.getAnimations().length || document.querySelector('.grow') ? 'moving' : 'still'`);
      await page!.until(`(document.querySelector('[data-act="more"]')?.textContent || '') !== ${JSON.stringify(beforeMore)}`);
      const afterMore = await read(page!, `document.querySelector('[data-act="more"]')?.textContent ?? ''`);
      shown = afterMore !== beforeMore ? 'open' : 'closed';
    });

    it('then the lines animate open and stay open.', () => {
      assert.equal(`${during}\n${shown}`, 'moving\nopen');
    });
  });

  describe('when the next change is below the screen, ', () => {
    let landed: string;

    before(async () => {
      await rest(page!);
      await page!.goto(url);
      await page!.until(`!!document.querySelector('.t-head')`, 30_000);
      await openFile('lib/end.dart');
      await page!.eval(`document.querySelector('#vw-main').scrollTop = 0`);
      await page!.click('[data-act="nav"][data-step="1"]');
      await page!.until(`document.querySelector('#vw-main').scrollTop > 100 || (document.querySelector('.code[data-p="lib/end.dart"] .tick')?.getBoundingClientRect().top || 0) < 400`);
      const top = Number(await page!.eval(`document.querySelector('#vw-main').scrollTop`));
      const tickTop = Number(await page!.eval(`document.querySelector('.code[data-p="lib/end.dart"] .tick')?.getBoundingClientRect().top ?? -1`));
      landed = top > 100 || (tickTop >= 0 && tickTop < 500) ? 'glided' : `top ${top} tick ${tickTop}`;
    });

    it('then the page glides to that change.', () => {
      assert.equal(landed, 'glided');
    });
  });
});
