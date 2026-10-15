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

const beforeFile = [
  'int price(int a) => a;',
  '',
  'int checkout() => price(2);',
  '',
  'void report() {',
  '  print(0);',
  '}',
  '',
  'void main() {',
  '  report();',
  '}',
  '',
].join('\n');

const afterFile = [
  'int price(int a, {int tax = 0}) => a + tax;',
  '',
  'int checkout() => price(2, tax: 1);',
  '',
  'void report({bool short = false}) {',
  '  print(price);',
  '}',
  '',
  'void main() {',
  '  report(short: true);',
  '}',
  '',
].join('\n');

async function chain(page: Browser, name: string): Promise<void> {
  await page.click('[data-tab="chains"]');
  await page.until(`!!document.querySelector('[data-chain]')`);
  const id = await read(page, `([...document.querySelectorAll('[data-chain]')].find((el) => (el.textContent || '').includes(${JSON.stringify(name)})) || {}).dataset?.chain ?? ''`);
  if (!id) throw new Error(`no chain ${name}`);
  await page.click(`[data-chain="${id}"]`);
  await page.until(`(document.querySelector('.crumbs')?.textContent || '').includes(${JSON.stringify(name)})`);
}

describe('Given a served review where report mentions price, ', { skip, timeout: 180_000 }, () => {
  let repo: TempRepo | undefined;
  let run: UntangleRun | undefined;
  let page: Browser | undefined;
  let cache = '';

  before(async () => {
    const author = ada('2020-08-01T15:00:00Z');
    repo = TempRepo.create();
    repo.write('pubspec.yaml', pubspec);
    repo.write('lib/a.dart', beforeFile);
    repo.commit({ subject: 'Start the prices', author, committer: author });
    repo.branch('feature');
    repo.write('lib/a.dart', afterFile);
    repo.commit({ subject: 'Pass the tax', author, committer: author });
    cache = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-cache-'));
    run = await startUntangle(repo.dir, { base: 'main', cacheDir: cache });
    await waitForReview(reviewClient(run.url));
    page = await launchBrowser();
    await page.reducedMotion(true);
    await page.goto(run.url);
    await page.until(`!!document.querySelector('.t-head')`, 30_000);
  });

  after(async () => {
    await page?.close();
    await run?.stop();
    repo?.remove();
    if (cache) fs.rmSync(cache, { recursive: true, force: true });
  });

  describe('when the chain map is opened, ', () => {
    let shown: string;

    before(async () => {
      await rest(page!);
      await page!.click('[data-tab="chains"]');
      await page!.click('.sb-row[data-map]');
      await page!.until(`(document.querySelector('.facts')?.textContent || '').includes('level')`);
      const family = await read(page!, `document.querySelector('.sb-group span')?.textContent ?? ''`);
      const levels = await read(page!, `[...document.querySelectorAll('.sb-row.chain')].map((el) => (el.style.getPropertyValue('--d') || '?') + ' ' + (el.querySelector('.nm')?.textContent || '')).join(', ')`);
      const facts = await read(page!, `document.querySelector('.facts')?.textContent ?? ''`);
      shown = `${family}\n${facts}\n${levels}`;
    });

    it('then the two chains are one family drawn in levels.', () => {
      assert.equal(shown, 'The price family\n2 linked chains · 2 levels\n0 report(short), 1 price');
    });
  });

  describe('when Uses is chosen on report, ', () => {
    let opened: string;

    before(async () => {
      await rest(page!);
      await chain(page!, 'report(short)');
      await page!.click('[data-act="menu"][data-menu="view"]');
      await page!.until(`(document.querySelector('.menu')?.textContent || '').includes('Uses')`);
      await page!.click('.menu [data-chain]');
      await page!.until(`(document.querySelector('.crumbs')?.textContent || '').includes('price')`);
      opened = await read(page!, `document.querySelector('.crumbs')?.textContent ?? ''`);
    });

    it('then price opens.', () => {
      assert.equal(opened, 'Map/price');
    });
  });

  describe('when Used by is chosen on price, ', () => {
    let opened: string;

    before(async () => {
      await rest(page!);
      await chain(page!, 'price');
      await page!.click('[data-act="menu"][data-menu="view"]');
      await page!.until(`(document.querySelector('.menu')?.textContent || '').includes('Used by')`);
      await page!.click('.menu [data-chain]');
      await page!.until(`(document.querySelector('.crumbs')?.textContent || '').includes('report(short)')`);
      opened = await read(page!, `document.querySelector('.crumbs')?.textContent ?? ''`);
    });

    it('then report opens.', () => {
      assert.equal(opened, 'Map/report(short)');
    });
  });
});
