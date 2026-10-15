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
      peek = await read(page!, `document.querySelector('.peek')?.textContent ?? ''`);
    });

    it('then the peek shows that usage.', () => {
      assert.equal(peek.includes('Usage') && peek.includes('greet'), true);
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
      assert.equal(marked.includes('unreviewed'), true);
    });
  });

  describe('when a name away from the changes is opened, ', () => {
    let opened: string;

    before(async () => {
      await rest(page!);
      await page!.goto(url);
      await page!.until(`!!document.querySelector('.t-head')`, 30_000);
      await openApp();
      await page!.click('[data-act="menu"][data-menu="view"]');
      await page!.until(`!!document.querySelector('[data-act="whole"]')`);
      await page!.click('[data-act="whole"]');
      await page!.until(`(document.querySelector('.code[data-p="lib/app.dart"]')?.textContent || '').includes('StringBuffer')`);
      await page!.until(`[...document.querySelectorAll('.ref.live, .ref')].some((el) => el.textContent === 'StringBuffer')`);
      await page!.eval(`([...document.querySelectorAll('.ref.live, .ref')].find((el) => el.textContent === 'StringBuffer')).click()`);
      await page!.until(`(document.querySelector('.peek')?.textContent || '').includes('Definition')`);
      if (await read(page!, `document.querySelector('[data-act="open-def"]') ? 'yes' : 'no'`) === 'yes') await page!.click('[data-act="open-def"]');
      opened = await read(page!, `document.querySelector('.peek')?.textContent || document.querySelector('.fv-head')?.textContent || ''`);
    });

    it('then the language server’s definition opens.', () => {
      const ok = opened.includes('Definition') || opened.includes('StringBuffer') || opened.includes('dart:');
      assert.equal(ok ? 'opened' : opened, 'opened');
    });
  });
});
