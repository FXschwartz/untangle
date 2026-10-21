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

const shape = (sum: string, more: string[] = []) => [
  'abstract class Shape {',
  '  double area();',
  '}',
  '',
  'double total(List<Shape> shapes) {',
  '  var sum = 0.0;',
  '  for (final shape in shapes) {',
  `    ${sum}`,
  '  }',
  '  return sum;',
  '}',
  '',
  ...more,
].join('\n');

const kind = (name: string, relation: string, area: number) => [
  "import 'shape.dart';",
  '',
  `class ${name} ${relation} Shape {`,
  '  @override',
  `  double area() => ${area};`,
  '}',
  '',
].join('\n');

describe('Given a served review of shapes that total their areas, with the language server running, ', { skip, timeout: 240_000 }, () => {
  let repo: TempRepo | undefined;
  let run: UntangleRun | undefined;
  let page: Browser | undefined;
  let cache = '';
  let url = '';

  before(async () => {
    const author = ada('2020-10-01T15:00:00Z');
    const later = ada('2020-10-02T15:00:00Z');
    repo = TempRepo.create();
    repo.write('pubspec.yaml', pubspec);
    repo.write('lib/shape.dart', shape('sum += shape.area();'));
    repo.write('lib/square.dart', kind('Square', 'extends', 4));
    repo.write('lib/circle.dart', kind('Circle', 'implements', 3));
    repo.commit({ subject: 'Start', author, committer: author });
    repo.branch('feature');
    repo.write('lib/shape.dart', shape('sum += shape.area() * 2;', ['double half(List<Shape> shapes) => total(shapes) / 2;', '']));
    repo.commit({ subject: 'Double the areas', author: later, committer: later });
    cache = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-cache-'));
    run = await startUntangle(repo.dir, { base: 'main', cacheDir: cache });
    url = run.url;
    await waitForReview(reviewClient(url));
    page = await launchBrowser();
    await page.reducedMotion(true);
    await page.goto(url);
    await page.until(`!!document.querySelector('.t-head')`, 30_000);
    await page.until(`document.querySelector('#lsp-dot')?.classList.contains('ready')`, 180_000);
  });

  after(async () => {
    await page?.close();
    await run?.stop();
    repo?.remove();
    if (cache) fs.rmSync(cache, { recursive: true, force: true });
  });

  async function openShape(): Promise<void> {
    await rest(page!);
    await page!.goto(url);
    await page!.until(`!!document.querySelector('.t-head')`, 30_000);
    await page!.click('[data-tab="files"]');
    await page!.until(`!!document.querySelector('[data-open="lib/shape.dart"]')`);
    await page!.click('[data-open="lib/shape.dart"]');
    await page!.until(`!!document.querySelector('.code[data-p="lib/shape.dart"]')`);
  }

  /** The peek's headers, a line each, then its list: each one's place, type (for a member) and code. */
  const listPeek = `[...document.querySelectorAll('.peek .pk-h')].map((head) => [...head.children].map((part) => part.textContent).filter(Boolean).join(' | '))
    .concat([...document.querySelectorAll('.peek .pk-use')].map((row) => row.querySelector('.pk-up').textContent + ' ' + [...row.querySelector('code').childNodes].map((part) => (part.classList?.contains('pk-in') ? part.textContent + ' › ' : part.textContent)).join(''))).join('\\n')`;
  const listed = (count: string) => `[...document.querySelectorAll('.peek .pk-h b')].some((b) => b.textContent === ${JSON.stringify(count)})`;
  const peekDone = `!!document.querySelector('.peek [data-peek-code$=":file"]')`;
  const hasImpl = `!!document.querySelector('.peek [data-act="peek-impl"]')`;

  describe('when Implementations is clicked in the peek of area, from the changed line that calls it, ', () => {
    let peek: string;
    let picked: string;
    let back: string;

    before(async () => {
      await openShape();
      await page!.clickIn('.code[data-p="lib/shape.dart"] .ref', 'area', 'sum += shape.area() * 2;');
      await page!.until(hasImpl, 60_000);
      await page!.click('.peek [data-act="peek-impl"]');
      await page!.until(listed('2 implementations'), 120_000);
      peek = await read(page!, listPeek);
      await page!.click('.peek [data-act="peek-use"]');
      await page!.until(listed('Implementation 1 of 2'));
      picked = await read(page!, `[[...document.querySelector('.peek .pk-h').children].map((part) => part.textContent).filter(Boolean).join(' | '), document.querySelector('.peek .pk-code .pk-ln.hit .tx')?.textContent].join('\\n')`);
      await page!.click('.peek [data-act="peek-back"]');
      await page!.until(listed('Definition'));
      back = await read(page!, `document.querySelector('.peek .pk-loc')?.textContent ?? ''`);
    });

    it('then the peek lists the methods that override it, from the language server.', () => {
      assert.equal(peek, [
        '2 implementations | area | in the packages this review changes | Click one to show it above, again to go to it | Back | Close',
        'circle.dart:5 Circle › double area() => 3;',
        'square.dart:5 Square › double area() => 4;',
      ].join('\n'));
    });

    it('then a picked one shows above the list.', () => {
      assert.equal(picked, 'Implementation 1 of 2 | lib/circle.dart:5 | this repo | Back | Go to it | Close\n  double area() => 3;');
    });

    it('then Back returns to the definition.', () => {
      assert.equal(back, 'lib/shape.dart:2');
    });
  });

  describe('when Implementations is clicked in the usages of Shape, clicked where it is declared, ', () => {
    let usages: string;
    let peek: string;

    before(async () => {
      await openShape();
      await page!.click('[data-act="menu"][data-menu="view"]');
      await page!.until(`!!document.querySelector('[data-act="whole"]')`);
      await page!.click('[data-act="whole"]');
      await page!.until(`!!document.querySelector('.code[data-p="lib/shape.dart"] .ln[data-n="1"] .ref.live')`);
      await page!.clickIn('.code[data-p="lib/shape.dart"] .ref.live', 'Shape', 'abstract class Shape {');
      await page!.until(`${listed('4 usages')} && ${hasImpl}`, 120_000);
      usages = await read(page!, `[...document.querySelector('.peek .pk-h').children].map((part) => part.textContent).filter(Boolean).join(' | ')`);
      await page!.click('.peek [data-act="peek-impl"]');
      await page!.until(listed('2 implementations'), 120_000);
      peek = await read(page!, listPeek);
    });

    it('then the usages offer its implementations.', () => {
      assert.equal(usages, '4 usages | Shape | in the packages this review changes | Click one to show it above, again to go to it | Implementations | Close');
    });

    it('then the peek lists the classes that extend or implement it.', () => {
      assert.equal(peek, [
        '2 implementations | Shape | in the packages this review changes | Click one to show it above, again to go to it | Back | Close',
        'circle.dart:3 class Circle implements Shape {',
        'square.dart:3 class Square extends Shape {',
      ].join('\n'));
    });
  });

  describe('when a local variable and a top-level function are peeked, ', () => {
    let local: string;
    let fn: string;

    /** The header of the peek of a name on a changed line, once the peek has its whole file. */
    async function header(name: string, line: string): Promise<string> {
      await openShape();
      await page!.clickIn('.code[data-p="lib/shape.dart"] .ref', name, line);
      await page!.until(peekDone, 60_000);
      return read(page!, `[...document.querySelector('.peek .pk-h').children].map((part) => part.textContent).filter(Boolean).join(' | ')`);
    }

    before(async () => {
      local = await header('sum', 'sum += shape.area() * 2;');
      fn = await header('total', 'double half(List<Shape> shapes)');
    });

    it('then the local\'s definition has no Implementations.', () => {
      assert.match(local, /^Definition \| lib\/shape\.dart:6 \| this repo \| Open file \| .*Close$/);
      assert.equal(local.includes('Implementations'), false);
    });

    it('then the function\'s definition has none either.', () => {
      assert.match(fn, /^Definition \| lib\/shape\.dart:5 \| this repo \| Open file \| .*Close$/);
      assert.equal(fn.includes('Implementations'), false);
    });
  });
});
