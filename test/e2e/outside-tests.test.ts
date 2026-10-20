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

// A new test file as a formatter writes long titles: each call's title on a line of its own, its
// tests in a labelled wrapper, and a helper after main. Each change runs on to where the next one
// starts: main's own lines to the wrapper, and the last test's to the brace that closes main.
const cartTest = `import 'package:sample/cart.dart';
import 'package:test/test.dart';

void main() {
  final start = [1, 2];

  withCart(
    '[Cart]',
    (cart) {
      cart.addAll(start);

      group(
        'Given a cart with two items,',
        () {
          test(
            'then it adds the prices.',
            () {
              expect(total(cart), 3);
            },
          );

          test(
            'then the total is positive.',
            () {
              expect(total(cart) > 0, isTrue);
            },
          );
        },
      );
    },
  );
}

void withCart(String label, void Function(List<int> cart) body) => group(label, () => body([]));
`;

describe('Given a served review of a new test file whose titles sit on lines of their own, its tests in a labelled wrapper, with a helper after main, ', { skip, timeout: 240_000 }, () => {
  let repo: TempRepo | undefined;
  let run: UntangleRun | undefined;
  let page: Browser | undefined;
  let cache = '';

  before(async () => {
    repo = TempRepo.create();
    repo.write('pubspec.yaml', pubspec);
    repo.write('lib/cart.dart', 'int total(List<int> prices) => prices.fold(0, (sum, price) => sum + price);\n');
    repo.commit({ subject: 'Start the cart', author: ada('2020-09-01T15:00:00Z'), committer: ada('2020-09-01T15:00:00Z') });
    repo.branch('feature');
    repo.write('test/cart_test.dart', cartTest);
    repo.commit({ subject: 'test: Cover the cart', author: ada('2020-09-02T15:00:00Z'), committer: ada('2020-09-02T15:00:00Z') });
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

  describe('when the commit’s chain is opened, ', () => {
    let tests = '';
    let outside = '';

    before(async () => {
      await rest(page!);
      await page!.click('[data-tab="chains"]');
      await page!.until(`!!document.querySelector('.sb-row[data-chain]')`);
      await page!.click('.sb-row[data-chain]');
      await page!.until(`!!document.querySelector('#vw-main .ol-out .ln')`);
      tests = await read(page!, `[...document.querySelectorAll('#vw-main .ol-row, #vw-main .ol-fold')].map((el) => el.matches('.ol-row') ? '  '.repeat(Number(el.style.getPropertyValue('--d')) + 1) + (el.querySelector('.ol-mk').textContent || '·') + ' ' + el.querySelector('.ol-tt').textContent.trim() : el.textContent.trim()).join('\\n')`);
      outside = await read(page!, `[...document.querySelectorAll('#vw-main .ol-out .ln')].map((row) => row.querySelector('.no').textContent + ' ' + row.querySelector('.tx').textContent).join('\\n')`);
    });

    it('then the wrapper heads its tests in its outline, the last test too, and the code outside them is a line of its own.', () => {
      assert.equal(tests, [
        '  · [Cart]',
        '    + Given a cart with two items,',
        '      + then it adds the prices.',
        '      + then the total is positive.',
        'Outside the tests: withCart · +7 −0',
      ].join('\n'));
    });

    it('then the code outside the tests is the imports, main’s own lines and the helper, without the calls next to them.', () => {
      assert.equal(outside, [
        "1 import 'package:sample/cart.dart';",
        "2 import 'package:test/test.dart';",
        '3 ',
        '4 void main() {',
        '5   final start = [1, 2];',
        '6 ',
        '34 void withCart(String label, void Function(List<int> cart) body) => group(label, () => body([]));',
      ].join('\n'));
    });
  });
});
