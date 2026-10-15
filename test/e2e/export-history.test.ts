import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { e2eSkip, launchBrowser, staticServer, type Browser } from '../helpers/browser.ts';
import { pubspec } from '../helpers/review.ts';
import type { Person } from '../helpers/repo.ts';
import { exportUntangle } from '../helpers/run.ts';
import { featureHistory, saveReviewedHead, type StoryStep } from '../helpers/story.ts';
import { read, rest } from './page.ts';

const skip = e2eSkip();
const noon = (day: string) => `2020-01-${day}T15:00:00Z`;
const ada = (day: string): Person => ({ name: 'Ada Review', email: 'ada@example.com', date: noon(day) });
const step = (subject: string, day: string, write: Record<string, string>): StoryStep => ({
  subject, author: ada(day), committer: ada(day), write,
});

describe('Given an exported review of a branch that merged two commits from main, with a saved review of that merge, opened over http, ', { skip, timeout: 180_000 }, () => {
  let page: Browser | undefined;
  let closeServer: (() => Promise<void>) | undefined;
  let remove: (() => void) | undefined;
  let head = '';

  before(async () => {
    const { repo, sha } = featureHistory({
      start: step('Start the package', '02', { 'pubspec.yaml': pubspec, 'lib/app.dart': "void main() {\n  print('hi');\n}\n" }),
      feature: [step('Edit the greeting', '04', { 'lib/app.dart': "void main() {\n  print('hey');\n}\n" })],
      main: [
        step('Add extra on main', '05', { 'lib/extra.dart': 'void extra() {}\n' }),
        step('Add a note on main', '06', { 'lib/note.dart': 'void note() {}\n' }),
      ],
      merge: { subject: 'Merge main', author: ada('08'), committer: ada('08') },
      after: [step('Edit the greeting again', '10', { 'lib/app.dart': "void main() {\n  print('hello');\n}\n" })],
    });
    saveReviewedHead(repo, 'untangle/feature', sha['Merge main'], sha.main, ada('20'));
    head = sha['Edit the greeting again'];
    const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-cache-'));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-export-'));
    const html = path.join(dir, 'review.html');
    remove = () => {
      repo.remove();
      fs.rmSync(cache, { recursive: true, force: true });
      fs.rmSync(dir, { recursive: true, force: true });
    };
    try {
      await exportUntangle(repo.dir, html, { base: 'main', cacheDir: cache });
      const server = await staticServer(dir);
      closeServer = () => server.close();
      page = await launchBrowser();
      await page.reducedMotion(true);
      await page.goto(server.url);
      await page.until(`!!document.querySelector('.t-head')`, 30_000);
    } catch (error) {
      await page?.close();
      await closeServer?.();
      remove();
      remove = undefined;
      throw error;
    }
  });

  after(async () => {
    await page?.close();
    await closeServer?.();
    remove?.();
  });

  describe('when History is opened, ', () => {
    let shown: string;

    before(async () => {
      await rest(page!);
      await page!.click('[data-act="history-open"]');
      await page!.until(`!!document.querySelector('.hs-s')`);
      shown = await read(page!, `[
        [...document.querySelectorAll('.hs-s')].map((el) => el.textContent).join('\\n'),
        document.querySelector('[data-act="brought"]') ? 'show them' : 'no show them',
        document.querySelector('.lens-offer') ? 'since offer' : 'no since offer',
      ].join('\\n')`);
    });

    it('then the commits are listed, and Show them and Since your review are absent.', () => {
      assert.equal(shown, [
        'Edit the greeting again',
        'Merge main',
        'Edit the greeting',
        'no show them',
        'no since offer',
      ].join('\n'));
    });
  });

  describe('when a commit is opened, ', () => {
    let commitLine: string;
    let subject: string;

    before(async () => {
      await rest(page!);
      await page!.click('[data-act="history-open"]');
      await page!.until(`!!document.querySelector('.hs-s')`);
      await page!.click(`.hs-main[data-detail="${head}"]`);
      await page!.until(`document.querySelector('.hs-detail')?.dataset.detailOf === ${JSON.stringify(head)}`);
      commitLine = await read(page!, `(() => { const dt = [...document.querySelectorAll('.hd-facts dt')].find((el) => el.textContent === 'Commit'); return 'Commit: ' + (dt?.nextElementSibling?.textContent ?? '').trim(); })()`);
      subject = await read(page!, `document.querySelector('.hd-subj')?.textContent ?? ''`);
    });

    it('then its details name the full commit.', () => {
      assert.equal(commitLine, `Commit: ${head}`);
    });

    it('then its message is shown.', () => {
      assert.equal(subject, 'Edit the greeting again');
    });
  });

  describe('when Changes from is opened, ', () => {
    let presets: string;

    before(async () => {
      await rest(page!);
      await page!.click('.t-head');
      await page!.until(`!!document.querySelector('.menu.lens-pop:not([hidden])')`);
      presets = await read(page!, `[...document.querySelectorAll('.lp-pre span')].map((el) => el.childNodes[0]?.textContent ?? '').join('\\n')`);
    });

    it('then Since your review is absent.', () => {
      assert.equal(presets, 'All changes\nThe last commit with changes');
    });
  });

  describe('when a commit is chosen from Changes from, ', () => {
    let label: string;

    before(async () => {
      await rest(page!);
      await page!.click('.t-head');
      await page!.until(`!!document.querySelector('.menu.lens-pop:not([hidden])')`);
      await page!.click(`.lp-row[data-commit="${head}"]`);
      await page!.until(`document.querySelector('.menu')?.hidden === true`);
      label = await read(page!, `document.querySelector('.t-head')?.textContent ?? ''`);
    });

    it('then that commit is the lens.', () => {
      assert.equal(label, `${head.slice(0, 7)} · Edit the greeting again`);
    });
  });
});
