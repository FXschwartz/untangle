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
import { read, rest } from './page.ts';

const skip = e2eSkip();
const ada = (date: string): Person => ({ name: 'Ada Review', email: 'ada@example.com', date });
const pads = '  print(0);\n'.repeat(20);

const beforeApp = [
  'void greet() {',
  "  print('hi');",
  '}',
  '',
  'void gone() {',
  "  print('bye');",
  '}',
  '',
  'void one() {',
  "  print('hi');",
  '}',
  '',
  'void two() {',
  "  print('hi');",
  '}',
  '',
  'void main() {',
  "  var name = 'a';",
  '  print(name);',
  pads.trimEnd(),
  '  print(name);',
  '}',
  '',
].join('\n');

const afterApp = [
  'void one() {',
  "  print('hello');",
  '}',
  '',
  'void two() {',
  "  print('hello');",
  '}',
  '',
  'void main() {',
  "  var title = 'a';",
  '  print(title);',
  pads.trimEnd(),
  '  print(title);',
  '}',
  '',
].join('\n');

const beforeTest = [
  'void helper(String name) {',
  '  print(name);',
  '}',
  '',
  'void main() {',
  "  group('names', () {",
  "    test('one', () {",
  "      helper('a');",
  '    });',
  '  });',
  '}',
  '',
].join('\n');

const afterTest = [
  'void helper(String title) {',
  '  print(title);',
  '}',
  '',
  'void main() {',
  "  group('names', () {",
  "    test('one', () {",
  "      helper('b');",
  '    });',
  '  });',
  '}',
  '',
].join('\n');

const beforeUsed = "void used(String name) {\n  print(name);\n}\n\nvoid caller() {\n  used('z');\n}\n";
const afterUsed = "void used(String title) {\n  print(title);\n}\n\nvoid caller() {\n  used('y');\n}\n";

async function openChain(page: Browser, name: string): Promise<void> {
  await page.click('[data-tab="chains"]');
  await page.until(`!!document.querySelector('[data-chain]')`);
  const id = await read(page, `([...document.querySelectorAll('[data-chain]')].find((el) => (el.textContent || '').includes(${JSON.stringify(name)})) || {}).dataset?.chain ?? ''`);
  if (!id) throw new Error(`no chain ${name}\n${await read(page, `document.querySelector('#vw-side')?.textContent ?? ''`)}`);
  await page.click(`[data-chain="${id}"]`);
  await page.until(`!!document.querySelector('.fv-head')`);
}

describe('Given a served review of a moved function, a deletion, a repeated edit, a local rename, a test and a generated file, ', { skip, timeout: 300_000 }, () => {
  let repo: TempRepo | undefined;
  let run: UntangleRun | undefined;
  let page: Browser | undefined;
  let client: ReviewClient | undefined;
  let cache = '';
  let url = '';

  before(async () => {
    const author = ada('2020-03-01T15:00:00Z');
    const later = ada('2020-03-02T15:00:00Z');
    repo = TempRepo.create();
    repo.write('pubspec.yaml', pubspec);
    repo.write('lib/a.dart', beforeApp);
    repo.write('lib/app.g.dart', 'const generated = 1;\n');
    repo.write('test/app_test.dart', beforeTest);
    repo.write('lib/c.dart', beforeUsed);
    repo.commit({ subject: 'Start', author, committer: author });
    repo.branch('feature');
    repo.write('lib/a.dart', afterApp);
    repo.write('lib/b.dart', "void greet() {\n  print('hello');\n}\n");
    repo.write('lib/app.g.dart', 'const generated = 2;\n');
    repo.write('test/app_test.dart', afterTest);
    repo.write('lib/c.dart', afterUsed);
    repo.commit({ subject: 'Change', author: later, committer: later });
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

  async function openFile(file: string): Promise<void> {
    await page!.click('[data-tab="files"]');
    await page!.until(`!!document.querySelector(${JSON.stringify(`[data-open="${file}"]`)})`);
    await page!.click(`[data-open="${file}"]`);
    await page!.until(`!!document.querySelector(${JSON.stringify(`.code[data-p="${file}"]`)})`);
  }

  describe('when the old file is opened, ', () => {
    let moved: string;

    before(async () => {
      await rest(page!);
      await openFile('lib/a.dart');
      moved = await read(page!, `document.querySelector('.mv-away')?.textContent ?? ''`);
    });

    it('then the removed copy points at where the function moved.', () => {
      assert.equal(moved.replace(/\s+/g, ' ').includes('moved to') && moved.includes('b.dart'), true);
    });
  });

  describe('when the moved function is shown side by side, ', () => {
    let moved: string;

    before(async () => {
      await rest(page!);
      await openFile('lib/b.dart');
      await page!.click('[data-act="menu"][data-menu="view"]');
      await page!.until(`!!document.querySelector('[data-act="layout"]')`);
      const on = await read(page!, `document.querySelector('[data-act="layout"]')?.getAttribute('aria-checked') ?? ''`);
      if (on !== 'true') await page!.click('[data-act="layout"]');
      else await page!.key('Escape');
      await page!.until(`!!document.querySelector('.mv-head, .mv-away')`);
      moved = await read(page!, `document.querySelector('.mv-head, .mv-away')?.textContent ?? ''`);
    });

    after(async () => {
      await client!.call('state', { method: 'PUT', body: { rev: { base: [] }, layout: 'unified' } });
      await page!.goto(url);
      await page!.until(`!!document.querySelector('.t-head')`, 30_000);
    });

    it('then the move is shown in two columns.', () => {
      assert.equal(moved.includes('Moved from') || moved.includes('moved to'), true);
    });
  });

  describe('when a reviewed deletion is shown side by side, ', () => {
    let gone: string;

    before(async () => {
      await rest(page!);
      await openFile('lib/a.dart');
      await page!.click('.ln.del .tick, .tick');
      await page!.until(`!!document.querySelector('.ln.gone, .sl.gone') || (document.querySelector('.tick.on') !== null)`);
      await page!.click('[data-act="menu"][data-menu="view"]');
      await page!.until(`!!document.querySelector('[data-act="layout"]')`);
      const on = await read(page!, `document.querySelector('[data-act="layout"]')?.getAttribute('aria-checked') ?? ''`);
      if (on !== 'true') await page!.click('[data-act="layout"]');
      else await page!.key('Escape');
      await page!.until(`(document.querySelector('.sl.gone, .ln.gone')?.textContent || '').includes('removed')`);
      gone = await read(page!, `document.querySelector('.sl.gone, .ln.gone')?.textContent ?? ''`);
    });

    after(async () => {
      await client!.call('state', { method: 'PUT', body: { rev: { base: [] }, layout: 'unified' } });
      await page!.goto(url);
      await page!.until(`!!document.querySelector('.t-head')`, 30_000);
    });

    it('then the removed lines are one reviewed row.', () => {
      assert.equal(gone.replace(/\s+/g, ' ').includes('removed line') && gone.includes('reviewed'), true);
    });
  });

  describe('when the same change is opened, ', () => {
    let places: string;

    before(async () => {
      await rest(page!);
      await openFile('lib/a.dart');
      await page!.until(`(document.querySelector('.code[data-p="lib/a.dart"]')?.textContent || '').includes('hello')`);
      await page!.until(`!!document.querySelector('[data-group]')`);
      await page!.click('[data-group]');
      await page!.until(`(document.querySelector('.fv-head')?.textContent || '').includes('Same change')`);
      places = await read(page!, `document.querySelector('.fv-head')?.textContent ?? ''`);
    });

    it('then its places are listed.', () => {
      assert.equal(places.includes('Same change'), true);
    });
  });

  describe('when Not in a chain is opened, ', () => {
    let heading: string;

    before(async () => {
      await rest(page!);
      await page!.click('[data-tab="chains"]');
      await page!.until(`!!document.querySelector('[data-standalone]')`);
      await page!.click('[data-standalone]');
      await page!.until(`(document.querySelector('.fv-head')?.textContent || '').includes('Not in a chain')`);
      heading = await read(page!, `document.querySelector('.crumbs')?.textContent ?? ''`);
    });

    it('then the changes outside chains are shown.', () => {
      assert.equal(heading.includes('Not in a chain'), true);
    });
  });

  describe('when the test chain is opened, ', () => {
    let list: string;

    before(async () => {
      await rest(page!);
      await openChain(page!, 'helper');
      await page!.until(`(document.querySelector('main, #vw-main')?.textContent || '').includes('names')`);
      list = await read(page!, `document.querySelector('#vw-main')?.textContent ?? ''`);
    });

    it('then the tests are listed by group.', () => {
      assert.equal(list.includes('names') && list.includes('one') && list.includes('group'), true);
    });
  });

  describe('when the generated file is opened, ', () => {
    let shown: string;

    before(async () => {
      await rest(page!);
      await page!.click('[data-tab="files"]');
      await page!.until(`(document.querySelector('#vw-side')?.textContent || '').includes('Generated')`);
      await page!.click('[data-open="lib/app.g.dart"]');
      await page!.until(`(document.querySelector('.code')?.textContent || '').includes('generated = 2')`);
      shown = await read(page!, `[document.querySelector('.fv-head')?.textContent ?? '', document.querySelector('.code')?.textContent ?? ''].join('\\n')`);
    });

    it('then its changed lines are shown for reference.', () => {
      assert.equal(shown.includes('Generated') && shown.includes('generated = 2'), true);
    });
  });

  describe('when the graph is hidden and shown again, ', () => {
    let shown: string;

    before(async () => {
      await rest(page!);
      await openChain(page!, 'used');
      await page!.until(`!!document.querySelector('[data-act="graph"]')`);
      if (await read(page!, `document.querySelector('.graph-box') ? 'shown' : 'hidden'`) === 'shown') {
        await page!.click('[data-act="graph"]');
        await page!.until(`!document.querySelector('.graph-box')`);
      }
      await page!.click('[data-act="graph"]');
      await page!.until(`!!document.querySelector('.graph-box')`);
      shown = await read(page!, `document.querySelector('.graph-box') ? 'shown' : 'hidden'`);
    });

    it('then the graph is on the page again.', () => {
      assert.equal(shown, 'shown');
    });
  });

  describe('when the right arrow is pressed on the sidebar splitter, ', () => {
    let widths: string;

    before(async () => {
      await rest(page!);
      const beforeWidth = await read(page!, `document.querySelector('#vw-split')?.getAttribute('aria-valuenow') ?? ''`);
      await page!.eval(`document.querySelector('#vw-split').focus()`);
      await page!.key('ArrowRight');
      const afterWidth = await read(page!, `document.querySelector('#vw-split')?.getAttribute('aria-valuenow') ?? ''`);
      widths = `${beforeWidth}\n${afterWidth}`;
    });

    it('then the sidebar grows by 16 pixels.', () => {
      const [beforeWidth, afterWidth] = widths.split('\n').map(Number);
      assert.equal(afterWidth - beforeWidth, 16);
    });
  });
});
