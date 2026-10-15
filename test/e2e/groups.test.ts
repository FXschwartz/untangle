import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { e2eSkip, launchBrowser, type Browser } from '../helpers/browser.ts';
import { reviewClient, waitForReview, type ReviewClient } from '../helpers/http.ts';
import { pubspec } from '../helpers/review.ts';
import { TempRepo, type Person } from '../helpers/repo.ts';
import { startUntangle, type UntangleRun } from '../helpers/run.ts';
import { read, rest, waitForSave } from './page.ts';

const skip = e2eSkip();
const ada = (date: string): Person => ({ name: 'Ada Review', email: 'ada@example.com', date });

const shapes = (field: string) => [
  'class Square {',
  `  int ${field} = 0;`,
  '}',
  '',
  'class Circle {',
  `  int ${field} = 0;`,
  '}',
  '',
  'void squares(Square s) {',
  `  print(s.${field});`,
  '}',
  '',
  'void circles(Circle c) {',
  `  print(c.${field});`,
  '}',
  '',
].join('\n');

describe('Given a served review where two classes rename their field count to total, and a function of each reads it, ', { skip, timeout: 240_000 }, () => {
  let repo: TempRepo | undefined;
  let run: UntangleRun | undefined;
  let page: Browser | undefined;
  let client: ReviewClient | undefined;
  let cache = '';
  let url = '';

  before(async () => {
    const author = ada('2020-04-01T15:00:00Z');
    const later = ada('2020-04-02T15:00:00Z');
    repo = TempRepo.create();
    repo.write('pubspec.yaml', pubspec);
    repo.write('lib/shapes.dart', shapes('count'));
    repo.commit({ subject: 'Start', author, committer: author });
    repo.branch('feature');
    repo.write('lib/shapes.dart', shapes('total'));
    repo.commit({ subject: 'Rename count', author: later, committer: later });
    cache = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-cache-'));
    run = await startUntangle(repo.dir, { base: 'main', cacheDir: cache });
    url = run.url;
    client = reviewClient(url);
    await waitForReview(client);
    page = await launchBrowser();
    await page.reducedMotion(true);
    await page.goto(url);
    await page.until(`!!document.querySelector('.t-head')`, 30_000);
  });

  after(async () => {
    await page?.close();
    await run?.stop();
    repo?.remove();
    if (cache) fs.rmSync(cache, { recursive: true, force: true });
  });

  async function openGroupOfTheReads(): Promise<void> {
    await page!.click('[data-tab="files"]');
    await page!.until(`!!document.querySelector('[data-open="lib/shapes.dart"]')`);
    await page!.click('[data-open="lib/shapes.dart"]');
    await page!.until(`!!document.querySelector('.code[data-p="lib/shapes.dart"] [data-group]')`);
    await page!.clickIn('.code[data-p="lib/shapes.dart"] [data-group]', 'same change ×2', 'print(s.count);');
    await page!.until(`(document.querySelector('.fv-head')?.textContent || '').includes('Same change')`);
  }

  describe('when the same change of the two reads is opened, ', () => {
    let head: string;
    let declarations: string;

    before(async () => {
      await rest(page!);
      await openGroupOfTheReads();
      head = await read(page!, `[document.querySelector('.fv-head .crumbs')?.textContent, document.querySelector('.fv-head .facts')?.textContent].join('\\n')`);
      declarations = await read(page!, `[...document.querySelectorAll('.sym-h')].map((el) => [...el.children].map((child) => child.textContent).filter(Boolean).join(' | ')).join('\\n')`);
    });

    it('then the header says its two places resolve to two declarations.', () => {
      assert.equal(head, 'Same change/count → total\n2 places · 1 file · 2 declarations');
    });

    it('then each declaration has its places and its own mark.', () => {
      assert.equal(declarations, 'Square.total | 1 place | Mark it reviewed\nCircle.total | 1 place | Mark it reviewed');
    });
  });

  describe('when one declaration\'s place is marked in the same change, ', () => {
    let facts: string;
    let declarations: string;

    before(async () => {
      await rest(page!);
      await client!.call('state', { method: 'PUT', body: { rev: { base: [] }, cmarks: [], layout: 'unified', showReviewedDiff: false } });
      await page!.goto(url);
      await page!.until(`!!document.querySelector('.t-head')`, 30_000);
      await openGroupOfTheReads();
      await page!.click('.sym-h [data-act="mark-edits"]');
      await waitForSave(page!);
      await page!.until(`(document.querySelector('.fv-head .facts')?.textContent || '').includes('to review')`);
      facts = await read(page!, `document.querySelector('.fv-head .facts')?.textContent ?? ''`);
      declarations = await read(page!, `[...document.querySelectorAll('.sym-h')].map((el) => [...el.children].map((child) => child.textContent).filter(Boolean).join(' | ')).join('\\n')`);
    });

    after(async () => {
      await client!.call('state', { method: 'PUT', body: { rev: { base: [] }, cmarks: [], layout: 'unified', showReviewedDiff: false } });
    });

    it('then one of the two places is left to review.', () => {
      assert.equal(facts, '1 of 2 to review · 1 file · 2 declarations');
    });

    it('then that declaration offers to unmark it and the other one to mark it.', () => {
      assert.equal(declarations, 'Square.total | 1 place | Mark it unreviewed\nCircle.total | 1 place | Mark it reviewed');
    });
  });
});
