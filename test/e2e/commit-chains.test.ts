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
const report = (first: string) => `void keep() {}\n\nvoid report(int total) {\n  print('${first}: $total');\n  print('done');\n}\n`;

async function openChain(page: Browser, name: string): Promise<void> {
  await page.click('[data-tab="chains"]');
  await page.until(`!!document.querySelector('[data-chain]')`);
  const id = await read(page, `([...document.querySelectorAll('.sb-row[data-chain]')].find((el) => (el.textContent || '').includes(${JSON.stringify(name)})) || {}).dataset?.chain ?? ''`);
  if (!id) throw new Error(`no chain ${name}`);
  await page.click(`.sb-row[data-chain="${id}"]`);
  await page.until(`!!document.querySelector('.cm-note')`);
}

describe('Given a served review that follows four commits: a follow-up of the first, and tests that build on the second, ', { skip, timeout: 180_000 }, () => {
  let repo: TempRepo | undefined;
  let run: UntangleRun | undefined;
  let page: Browser | undefined;
  let cache = '';
  let reportSha = '';
  let labelSha = '';

  before(async () => {
    repo = TempRepo.create();
    repo.write('pubspec.yaml', pubspec);
    repo.write('lib/report.dart', 'void keep() {}\n');
    repo.write('lib/price.dart', 'int price(int amount) => amount;\n');
    const start = ada('2020-08-01T15:00:00Z');
    repo.commit({ subject: 'Start the shop', author: start, committer: start });
    repo.branch('feature');
    repo.write('lib/report.dart', report('total'));
    const first = ada('2020-08-02T15:00:00Z');
    reportSha = repo.commit({ subject: 'feat: Add a report', body: 'Prints the total and a closing line.\n\nThe closing line tells the reader the report ended.', author: first, committer: first });
    repo.write('lib/price.dart', 'int price(int amount) => amount * 2;\n');
    const second = ada('2020-08-03T15:00:00Z');
    repo.commit({ subject: 'feat: Double the price', author: second, committer: second });
    repo.write('lib/report.dart', report('sum'));
    const third = ada('2020-08-04T15:00:00Z');
    labelSha = repo.commit({ subject: 'fix: Label the sum', author: third, committer: third });
    repo.write('test/price_test.dart', "import 'package:sample/price.dart';\n\nvoid main() {\n  price(1);\n  price(2);\n}\n");
    repo.write('lib/price.dart', 'int price(int amount) => amount * 3;\n');
    const fourth = ada('2020-08-05T15:00:00Z');
    repo.commit({ subject: 'test: Cover the price', author: fourth, committer: fourth });
    cache = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-cache-'));
    run = await startUntangle(repo.dir, { base: 'main', cacheDir: cache, args: ['-chains', 'history'] });
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

  describe('when the chains are listed, ', () => {
    let listed = '';

    before(async () => {
      await rest(page!);
      await page!.click('[data-tab="chains"]');
      await page!.until(`!!document.querySelector('.sb-row[data-chain]')`);
      listed = await read(page!, `[...document.querySelectorAll('.sb-row[data-chain] .nm')].map((el) => el.textContent).join(', ')`);
    });

    it('then each commit that started changes is one chain, in the order they were made.', () => {
      assert.equal(listed, 'Add a report, Double the price, Cover the price');
    });
  });

  describe('when the report\'s chain is opened, ', () => {
    let note = '';

    before(async () => {
      await rest(page!);
      await openChain(page!, 'Add a report');
      note = await read(page!, `[...document.querySelectorAll('.cm-note > *')].map((el) => el.textContent).join('\\n')`);
    });

    it('then it opens with the commit\'s subject, the first paragraph of its message, and its follow-up.', () => {
      assert.equal(note, [
        `feat Add a report ${reportSha.slice(0, 7)}`,
        'Prints the total and a closing line.',
        'Show the whole message',
        `Followed up by Label the sum ${labelSha.slice(0, 7)}.`,
      ].join('\n'));
    });
  });

  describe('when the tests\' chain is opened and the function they call is followed, ', () => {
    let followed = '';

    before(async () => {
      await rest(page!);
      await openChain(page!, 'Cover the price');
      const note = await read(page!, `[...document.querySelectorAll('.sec-note')].map((el) => el.textContent).find((text) => text.startsWith('Uses')) ?? ''`);
      await page!.click('.sec-note [data-act="ext"]');
      await page!.until(`(document.querySelector('.crumbs b')?.textContent || '') === 'Double the price'`);
      followed = `${note} → ${await read(page!, `document.querySelector('.crumbs b').textContent`)}`;
    });

    it('then a note names the function and the chain that changes it, and its link opens that chain.', () => {
      assert.equal(followed, 'Uses price, changed in Double the price. → Double the price');
    });
  });

  describe('when the chain map is opened, ', () => {
    let map = '';

    before(async () => {
      await rest(page!);
      await page!.click('[data-tab="chains"]');
      await page!.click('.sb-row.map[data-map]');
      await page!.until(`!!document.querySelector('.g-node')`);
      map = await read(page!, `[...document.querySelectorAll('.g-node')].map((n) => n.querySelector('.g-l1').textContent + ' ' + n.querySelector('.g-l2').textContent).join(', ') + ' · ' + document.querySelectorAll('.g-edge').length + ' arrow'`);
    });

    it('then each commit\'s chain is a box, and an arrow goes from a chain to the one that builds on it.', () => {
      assert.equal(map, 'feat Add a report, feat Double the price, test Cover the price · 1 arrow');
    });
  });

  describe('when the whole message is shown, ', () => {
    let message = '';

    before(async () => {
      await rest(page!);
      await openChain(page!, 'Add a report');
      await page!.click('[data-act="note-more"]');
      await page!.until(`(document.querySelector('[data-act="note-more"]')?.textContent || '') === 'Show less'`);
      message = await read(page!, `document.querySelector('.cm-text')?.textContent ?? ''`);
    });

    it('then both paragraphs show.', () => {
      assert.equal(message, 'Prints the total and a closing line.\n\nThe closing line tells the reader the report ended.');
    });
  });
});
