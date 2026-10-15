import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { e2eSkip, launchBrowser } from '../helpers/browser.ts';
import type { Browser } from '../helpers/browser.ts';
import { reviewClient, waitForReview } from '../helpers/http.ts';
import { pubspec } from '../helpers/review.ts';
import { TempRepo, type Person } from '../helpers/repo.ts';
import { startUntangle, type UntangleRun } from '../helpers/run.ts';
import { read, rest } from './page.ts';

const skip = e2eSkip();
const ada = (date: string): Person => ({ name: 'Ada Review', email: 'ada@example.com', date });

const far = [
  ...Array.from({ length: 30 }, (_, index) => `// pad ${index + 1}`),
  '',
  'void far() {',
  '  final buffer = StringBuffer();',
  "  buffer.write('x');",
  '}',
  '',
].join('\n');

const beforeApp = [
  'void greet(String name) {',
  '  print(name);',
  '}',
  '',
  'void main() {',
  "  greet('ada');",
  '}',
  '',
  far,
].join('\n');

const afterApp = [
  'void greet(String title) {',
  '  print(title);',
  '}',
  '',
  'void main() {',
  "  greet('Ada');",
  '}',
  '',
  far,
].join('\n');

describe('Given a served review of a renamed parameter and its caller, with the language server running, ', { skip, timeout: 180_000 }, () => {
  let repo: TempRepo | undefined;
  let run: UntangleRun | undefined;
  let page: Browser | undefined;
  let cache = '';
  let url = '';

  before(async () => {
    const author = ada('2020-05-01T15:00:00Z');
    const later = ada('2020-05-02T15:00:00Z');
    repo = TempRepo.create();
    repo.write('pubspec.yaml', pubspec);
    repo.write('lib/app.dart', beforeApp);
    repo.commit({ subject: 'Start', author, committer: author });
    repo.branch('feature');
    repo.write('lib/app.dart', afterApp);
    repo.commit({ subject: 'Rename', author: later, committer: later });
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

  async function openApp(): Promise<void> {
    await page!.click('[data-tab="files"]');
    await page!.until(`!!document.querySelector('[data-open="lib/app.dart"]')`);
    await page!.click('[data-open="lib/app.dart"]');
    await page!.until(`!!document.querySelector('.code[data-p="lib/app.dart"]')`);
  }

  describe('when a changed usage is opened, ', () => {
    let peek: string;

    before(async () => {
      await rest(page!);
      await openApp();
      await page!.until(`!!document.querySelector('[data-usage]')`);
      await page!.click('[data-usage]');
      await page!.until(`!!document.querySelector('[data-act="peek-use"]')`);
      await page!.click('[data-act="peek-use"]');
      await page!.until(`(document.querySelector('.peek')?.textContent || '').includes('Usage')`);
      peek = await read(page!, `[[...document.querySelector('.peek .pk-h').children].map((part) => part.textContent).filter(Boolean).join(' | '), ...[...document.querySelectorAll('.peek .pk-code .pk-ln')].map((row) => (row.matches('.hit') ? '> ' : '  ') + row.querySelector('.no')?.textContent + ' ' + (row.querySelector('.sg')?.textContent || ' ') + ' ' + row.querySelector('.tx')?.textContent)].join('\\n')`);
    });

    it('then the peek shows that usage.', () => {
      assert.equal(peek, [
        'Usage 1 of 1 | lib/app.dart:6 | not reviewed | Back to definition | Go to it | Close',
        '  2 +   print(title);',
        '  3   }',
        '  4   ',
        '  5   void main() {',
        "> 6 +   greet('Ada');",
        '  7   }',
        '  8   ',
        '  9   // pad 1',
      ].join('\n'));
    });
  });

  describe('when the changed usages are marked reviewed, ', () => {
    let marked: string;

    before(async () => {
      await rest(page!);
      await page!.goto(url);
      await page!.until(`!!document.querySelector('.t-head')`, 30_000);
      await openApp();
      await page!.until(`!!document.querySelector('[data-usage]')`);
      await page!.click('[data-usage]');
      await page!.until(`!!document.querySelector('[data-act="mark-usages"]')`);
      await page!.click('[data-act="mark-usages"]');
      await page!.until(`(document.querySelector('[data-act="mark-usages"]')?.textContent || '').includes('unreviewed')`);
      marked = await read(page!, `document.querySelector('[data-act="mark-usages"]')?.textContent ?? ''`);
    });

    it('then they are reviewed.', () => {
      assert.equal(marked, 'Mark them unreviewed');
    });
  });

  /** Opens the peek of print from the changed line that calls it. */
  async function peekPrint(): Promise<void> {
    await rest(page!);
    await page!.goto(url);
    await page!.until(`!!document.querySelector('.t-head')`, 30_000);
    await openApp();
    await page!.clickIn('.code[data-p="lib/app.dart"] .ref', 'print', 'print(title)');
    await page!.until(`!!document.querySelector('.peek [data-act="open-def"]')`);
  }

  describe('when print on a changed line is clicked, ', () => {
    let peekHead: string;

    before(async () => {
      await peekPrint();
      peekHead = await read(page!, `[...document.querySelectorAll('.peek .pk-h > *')].map((el) => el.textContent).filter(Boolean).join(' | ')`);
    });

    it('then the peek shows its definition in the Dart SDK, with Open file.', () => {
      assert.match(peekHead, /^Definition \| dart:core\/print\.dart:\d+ \| Dart SDK \| Open file \| Close$/);
    });
  });

  describe('when Open file is clicked in the peek of print, ', () => {
    let view: string;
    let defined: string;

    before(async () => {
      await peekPrint();
      const line = /:(\d+)$/.exec(await read(page!, `document.querySelector('.peek .pk-loc')?.textContent ?? ''`))?.[1] ?? '';
      await page!.click('.peek [data-act="open-def"]');
      await page!.until(`!!document.querySelector('.code.src .ln') || (document.querySelector('.peek [data-act="open-def"]')?.textContent || '') === 'Not found'`, 120_000);
      view = await read(page!, `document.querySelector('.fv-head .crumbs')?.textContent ?? ''`);
      defined = await read(page!, `document.querySelector('.code.src .ln[data-n="${line}"] .tx')?.textContent ?? ''`);
    });

    it('then the Dart SDK\'s print.dart opens.', () => {
      assert.equal(view, 'Dart SDK/print.dart');
    });

    it('then the line the peek named is print\'s declaration.', () => {
      assert.equal(defined, 'void print(Object? object) {');
    });
  });

  describe('when a name away from the changes is opened, ', () => {
    let peekHead: string;
    let hit: string;

    before(async () => {
      await rest(page!);
      await page!.goto(url);
      await page!.until(`!!document.querySelector('.t-head')`, 30_000);
      await openApp();
      await page!.click('[data-act="menu"][data-menu="view"]');
      await page!.until(`!!document.querySelector('[data-act="whole"]')`);
      await page!.click('[data-act="whole"]');
      await page!.until(`[...document.querySelectorAll('.code[data-p="lib/app.dart"] .ref')].some((el) => el.textContent === 'StringBuffer')`);
      await page!.clickIn('.code[data-p="lib/app.dart"] .ref', 'StringBuffer', 'final buffer = StringBuffer();');
      await page!.until(`!!document.querySelector('.peek .pk-h') && !(document.querySelector('.peek')?.textContent || '').includes('looking it up')`, 120_000);
      peekHead = await read(page!, `[...document.querySelectorAll('.peek .pk-h > *')].map((el) => el.textContent).filter(Boolean).join(' | ')`);
      hit = await read(page!, `document.querySelector('.peek .pk-ln.hit .tx')?.textContent ?? ''`);
    });

    it('then the language server\'s definition is in the Dart SDK, with Open file and Open in editor.', () => {
      assert.match(peekHead, /^Definition \| dart:core\/string_buffer\.dart:\d+ \| Dart SDK \| Open file \| Open in editor \| Close$/);
    });

    it('then the line it points at is StringBuffer\'s constructor.', () => {
      assert.equal(hit.trim(), 'external StringBuffer([Object content = ""]);');
    });
  });
});
