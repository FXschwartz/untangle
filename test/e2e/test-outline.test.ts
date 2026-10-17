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

const cart = (extra = '') => `int total(List<int> prices) => prices.fold(0, (sum, price) => sum + price);\n${extra}`;
const twoItems = (given: string, thens: string) => `  group('${given}', () {
    late List<int> prices;

    setUp(() {
      prices = [1, 2];
    });

    group('when the total is taken,', () {
      late int sum;

      setUp(() {
        sum = total(prices);
      });

      test('then it adds the prices.', () {
        expect(sum, 3);
      });
${thens}    });
  });
`;
const discount = (tests: string) => `
  group('Given a cart with a discount of one,', () {
    late List<int> prices;

    setUp(() {
      prices = [1, 2];
    });

    test('when the total is taken, then the discount comes off.', () {
      expect(discounted(prices, 1), 2);
    });
${tests}  });
`;
const positive = `
      test('then it is positive.', () {
        expect(sum > 0, isTrue);
      });
`;
const nothing = `
    test('when nothing is bought, then nothing comes off.', () {
      expect(discounted([], 0), 0);
    });
`;
const cartTest = (body: string) => `import 'package:sample/cart.dart';\n\nvoid main() {\n${body}}\n`;

/** The outline's rows as read: indented as nested, its mark, its title ([-removed-] and {+added+} words) and its notes. */
const rowsRead = `[...document.querySelectorAll('#vw-main .ol-row, #vw-main .ol-fold, #vw-main .ol-file')].map((el) => {
  const words = (tt) => [...tt.childNodes].map((x) => (x.nodeName === 'DEL' ? '[-' + x.textContent + '-]' : x.nodeName === 'INS' ? '{+' + x.textContent + '+}' : x.nodeType === 1 ? words(x) : x.textContent)).join('').trim();
  if (el.matches('.ol-file')) return el.querySelector('.nm').textContent + ' · ' + el.querySelector('.n').textContent;
  const d = Number(el.style.getPropertyValue('--d') || 0);
  if (el.matches('.ol-fold')) return '  '.repeat(d + 1) + el.textContent.trim();
  const notes = [...el.querySelectorAll('.ol-tag, .ol-chip')].map((x) => x.textContent.trim());
  const mark = el.querySelector('.ol-mk').textContent || '·';
  return '  '.repeat(d + 1) + mark + ' ' + words(el.querySelector('.ol-tt')) + (notes.length ? ' [' + notes.join(', ') + ']' : '') + (el.classList.contains('done') ? ' (reviewed)' : '');
}).join('\\n')`;

async function openChain(page: Browser, name: string): Promise<void> {
  await page.click('[data-tab="chains"]');
  await page.until(`!!document.querySelector('.sb-row[data-chain]')`);
  const id = await read(page, `([...document.querySelectorAll('.sb-row[data-chain]')].find((el) => (el.textContent || '').includes(${JSON.stringify(name)})) || {}).dataset?.chain ?? ''`);
  if (!id) throw new Error(`no chain ${name}`);
  await page.click(`.sb-row[data-chain="${id}"]`);
  await page.until(`!!document.querySelector('#vw-main .ol-file')`);
}

function rowSelector(page: Browser, title: string): Promise<string> {
  return read(page, `(() => { const row = [...document.querySelectorAll('#vw-main .ol-row')].find((el) => el.querySelector('.ol-tt').textContent.trim() === ${JSON.stringify(title)}); return row ? '.ol-row[data-ol="' + row.dataset.ol + '"]' : ''; })()`);
}

describe('Given a served review by commit: a discount with its tests, more tests for both scenarios, and a renamed Given, ', { skip, timeout: 240_000 }, () => {
  let repo: TempRepo | undefined;
  let run: UntangleRun | undefined;
  let page: Browser | undefined;
  let cache = '';
  let discountSha = '';
  let moreSha = '';
  let nameSha = '';

  before(async () => {
    repo = TempRepo.create();
    repo.write('pubspec.yaml', pubspec);
    repo.write('lib/cart.dart', cart());
    repo.write('test/cart_test.dart', cartTest(twoItems('Given a cart with two items,', '')));
    const start = ada('2020-09-01T15:00:00Z');
    repo.commit({ subject: 'Start the cart', author: start, committer: start });
    repo.branch('feature');
    repo.write('lib/cart.dart', cart('\nint discounted(List<int> prices, int off) => total(prices) - off;\n'));
    repo.write('test/cart_test.dart', cartTest(twoItems('Given a cart with two items,', '') + discount('')));
    const first = ada('2020-09-02T15:00:00Z');
    discountSha = repo.commit({ subject: 'feat: Take a discount', author: first, committer: first });
    repo.write('test/cart_test.dart', cartTest(twoItems('Given a cart with two items,', positive) + discount(nothing)));
    const second = ada('2020-09-03T15:00:00Z');
    moreSha = repo.commit({ subject: 'test: Cover more totals', author: second, committer: second });
    repo.write('test/cart_test.dart', cartTest(twoItems('Given a cart holding two items,', positive) + discount(nothing)));
    const third = ada('2020-09-04T15:00:00Z');
    nameSha = repo.commit({ subject: 'test: Name the scenario', author: third, committer: third });
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

  describe('when the chain of the commit that only adds tests is opened, ', () => {
    let rows = '';

    before(async () => {
      await rest(page!);
      await openChain(page!, 'Cover more totals');
      rows = await read(page!, rowsRead);
    });

    it('then its new thens read under their Given and when, dimmed, with the commit that last wrote each Given named.', () => {
      assert.equal(rows, [
        'cart_test.dart · 2 new',
        `  · Given a cart holding two items, [${nameSha.slice(0, 7)}]`,
        '    · when the total is taken,',
        '      + then it is positive.',
        '      + 1 unchanged then',
        `  · Given a cart with a discount of one, [${discountSha.slice(0, 7)}]`,
        '    + when nothing is bought, then nothing comes off.',
        '    + 1 unchanged when',
      ].join('\n'));
    });
  });

  describe('when a new then is opened, ', () => {
    let code = '';

    before(async () => {
      await rest(page!);
      await openChain(page!, 'Cover more totals');
      await page!.click(await rowSelector(page!, 'then it is positive.'));
      await page!.until(`!!document.querySelector('#vw-main .ol-code')`);
      code = await read(page!, `[...document.querySelectorAll('#vw-main .ol-code .ln')].map((row) => (row.querySelector('.sg').textContent || ' ') + ' ' + row.querySelector('.tx').textContent).join('\\n')`);
    });

    after(async () => {
      await page!.click(await rowSelector(page!, 'then it is positive.'));
    });

    it('then its code opens under it, as the diff shows it.', () => {
      assert.equal(code, [
        "+       test('then it is positive.', () {",
        '+         expect(sum > 0, isTrue);',
        '+       });',
      ].join('\n'));
    });
  });

  describe('when a new then is marked reviewed with its mark, ', () => {
    let rows = '';
    let pill = '';

    before(async () => {
      await rest(page!);
      await openChain(page!, 'Cover more totals');
      await page!.click(`${await rowSelector(page!, 'then it is positive.')} .ol-tick`);
      await page!.until(`!!document.querySelector('#vw-main .ol-row.done')`);
      rows = await read(page!, rowsRead);
      pill = await read(page!, `document.querySelector('#vw-pill .pill-n')?.textContent ?? ''`);
    });

    after(async () => {
      await page!.click(`${await rowSelector(page!, 'then it is positive.')} .ol-tick`);
    });

    it('then that then reads reviewed and the pill counts the one sentence left.', () => {
      assert.equal(`${rows}\n${pill}`, [
        'cart_test.dart · 2 new',
        `  · Given a cart holding two items, [${nameSha.slice(0, 7)}]`,
        '    · when the total is taken,',
        '      + then it is positive. (reviewed)',
        '      + 1 unchanged then',
        `  · Given a cart with a discount of one, [${discountSha.slice(0, 7)}]`,
        '    + when nothing is bought, then nothing comes off.',
        '    + 1 unchanged when',
        '1 of 1',
      ].join('\n'));
    });
  });

  describe('when the commit named on a Given is clicked, ', () => {
    let where = '';

    before(async () => {
      await rest(page!);
      await openChain(page!, 'Cover more totals');
      await page!.click(`${await rowSelector(page!, 'Given a cart with a discount of one,')} .ol-chip`);
      await page!.until(`(document.querySelector('.fv-head .crumbs')?.textContent || '').includes('Take a discount')`);
      where = await read(page!, `document.querySelector('.fv-head .crumbs b').textContent + ' · ' + (document.querySelector('#vw-main .ol-row.flash .ol-tt')?.textContent.trim() ?? 'no row')`);
    });

    it('then the chain of that commit opens at the Given.', () => {
      assert.equal(where, 'Take a discount · Given a cart with a discount of one,');
    });
  });

  describe('when the chain of the commit that changes code and tests is opened, ', () => {
    let page1 = '';

    before(async () => {
      await rest(page!);
      await openChain(page!, 'Take a discount');
      page1 = await read(page!, `[...document.querySelectorAll('#vw-main .sec > .sec-h > b, #vw-main .ol-sect')].map((el) => el.textContent.trim()).join(' | ') + '\\n' + ${rowsRead}`);
    });

    it('then its tests follow its code, as their outline, with the test a later commit added to its new Given.', () => {
      assert.equal(page1, [
        'discounted | Tests',
        'cart_test.dart · 1 new',
        '  + Given a cart with a discount of one,',
        '    + when the total is taken, then the discount comes off.',
        `    · when nothing is bought, then nothing comes off. [${moreSha.slice(0, 7)}]`,
      ].join('\n'));
    });
  });

  describe('when the chain of the commit that renames a Given is opened, ', () => {
    let rows = '';

    before(async () => {
      await rest(page!);
      await openChain(page!, 'Name the scenario');
      rows = await read(page!, rowsRead);
    });

    it('then the Given shows the words that changed, and its test reads reworded through it.', () => {
      assert.equal(rows, [
        'cart_test.dart · 1 reworded',
        '  ~ Given a cart [-with-]{+holding+} two items,',
        '    · when the total is taken,',
        '      ~ then it adds the prices. [reworded above]',
        `      · then it is positive. [${moreSha.slice(0, 7)}]`,
      ].join('\n'));
    });
  });

  describe('when the Tests view is opened from the sidebar, ', () => {
    let page1 = '';

    before(async () => {
      await rest(page!);
      await page!.click('[data-tab="chains"]');
      await page!.click('[data-act="tests-open"]');
      await page!.until(`!!document.querySelector('#vw-main .ol-file')`);
      page1 = await read(page!, `document.querySelector('[data-act="tests-open"]').textContent + '\\n' + document.querySelector('.fv-head .facts').textContent + '\\n' + ${rowsRead}`);
    });

    it('then it lists every sentence the tests add or reword, with the commit that wrote each one.', () => {
      assert.equal(page1, [
        'Tests4',
        '3 new · 1 reworded · 1 file',
        'cart_test.dart · 3 new · 1 reworded',
        `  ~ Given a cart [-with-]{+holding+} two items, [${nameSha.slice(0, 7)}]`,
        '    · when the total is taken,',
        '      ~ then it adds the prices. [reworded above]',
        `      + then it is positive. [${moreSha.slice(0, 7)}]`,
        `  + Given a cart with a discount of one, [${discountSha.slice(0, 7)}]`,
        `    + when the total is taken, then the discount comes off. [${discountSha.slice(0, 7)}]`,
        `    + when nothing is bought, then nothing comes off. [${moreSha.slice(0, 7)}]`,
      ].join('\n'));
    });
  });

  describe('when the Tests view reads each test as its whole sentence, ', () => {
    let rows = '';

    before(async () => {
      await rest(page!);
      await page!.click('[data-tab="chains"]');
      await page!.click('[data-act="tests-open"]');
      await page!.click('[data-act="tests-mode"][data-v="sentences"]');
      await page!.until(`!!document.querySelector('#vw-main .ol-row.sent')`);
      rows = await read(page!, rowsRead);
      await page!.click('[data-act="tests-mode"][data-v="nested"]');
    });

    it('then each test reads whole, and a renamed Given shows its changed words on the first test it heads.', () => {
      assert.equal(rows, [
        'cart_test.dart · 3 new · 1 reworded',
        `  ~ Given a cart [-with-]{+holding+} two items, when the total is taken, then it adds the prices. [${nameSha.slice(0, 7)}]`,
        `  + Given a cart holding two items, when the total is taken, then it is positive. [${moreSha.slice(0, 7)}]`,
        `  + Given a cart with a discount of one, when the total is taken, then the discount comes off. [${discountSha.slice(0, 7)}]`,
        `  + Given a cart with a discount of one, when nothing is bought, then nothing comes off. [${moreSha.slice(0, 7)}]`,
      ].join('\n'));
    });
  });

  describe('when the Tests view keeps only the reworded sentences, ', () => {
    let rows = '';

    before(async () => {
      await rest(page!);
      await page!.click('[data-tab="chains"]');
      await page!.click('[data-act="tests-open"]');
      await page!.click('[data-act="tests-filter"][data-v="reworded"]');
      await page!.until(`!document.querySelector('#vw-main .ol-row.new')`);
      rows = await read(page!, rowsRead);
      await page!.click('[data-act="tests-filter"][data-v="all"]');
    });

    it('then only the reworded test shows, with the groups that complete its sentence.', () => {
      assert.equal(rows, [
        'cart_test.dart · 3 new · 1 reworded',
        `  ~ Given a cart [-with-]{+holding+} two items, [${nameSha.slice(0, 7)}]`,
        '    · when the total is taken,',
        '      ~ then it adds the prices. [reworded above]',
      ].join('\n'));
    });
  });
});
