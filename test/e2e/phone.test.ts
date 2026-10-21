import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { e2eSkip, launchBrowser, type Browser } from '../helpers/browser.ts';
import { stubGh, type GhStub } from '../helpers/gh.ts';
import { reviewClient, waitForReview } from '../helpers/http.ts';
import { pubspec } from '../helpers/review.ts';
import { TempRepo, type Person } from '../helpers/repo.ts';
import { startUntangle, type UntangleRun } from '../helpers/run.ts';
import { read } from './page.ts';

const skip = e2eSkip();
const ada = (date: string): Person => ({ name: 'Ada Review', email: 'ada@example.com', date });

// A box's place on the screen, in whole pixels: left, top, width, height.
const box = (selector: string) => `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return 'none'; const r = el.getBoundingClientRect(); return [r.left, r.top, r.width, r.height].map(Math.round).join(' '); })()`;
const fits = `(() => { const root = document.documentElement, main = document.querySelector('#vw-main'); return root.scrollWidth <= root.clientWidth && main.scrollWidth <= main.clientWidth ? 'fits' : root.scrollWidth + ' / ' + main.scrollWidth; })()`;
const drawer = `document.querySelector('#viewer').classList.contains('side-on') ? 'open' : 'closed'`;
const where = `document.querySelector('#vw-where b')?.textContent ?? ''`;

describe('Given a served review of a greeting, on a phone of 390 by 844 pixels with touch and reduced motion, ', { skip, timeout: 300_000 }, () => {
  let repo: TempRepo | undefined;
  let gh: GhStub | undefined;
  let run: UntangleRun | undefined;
  let page: Browser | undefined;
  let cache = '';

  before(async () => {
    repo = TempRepo.create();
    repo.write('pubspec.yaml', pubspec);
    repo.write('lib/app.dart', "void greet() {\n  print('hi');\n}\n");
    repo.commit({ subject: 'Start the package', author: ada('2020-06-01T15:00:00Z'), committer: ada('2020-06-01T15:00:00Z') });
    repo.branch('feature');
    repo.write('lib/app.dart', [
      "void greet(String name, {bool loud = false, String punctuation = '!'}) {",
      "  final line = loud ? 'HI, ${name.toUpperCase()}$punctuation' : 'hi, $name$punctuation';",
      '  print(line);',
      '}',
      '',
    ].join('\n'));
    repo.commit({ subject: 'Greet by name, loudly if asked', author: ada('2020-06-02T15:00:00Z'), committer: ada('2020-06-02T15:00:00Z') });
    gh = stubGh();
    cache = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-cache-'));
    run = await startUntangle(repo.dir, { cacheDir: cache, gh, base: 'main' });
    await waitForReview(reviewClient(run.url));
    page = await launchBrowser();
    await page.phone(390, 844);
    await page.reducedMotion(true);
    await page.goto(run.url);
    await page.until(`!!document.querySelector('.t-head')`, 30_000);
  });

  after(async () => {
    await page?.close();
    await run?.stop();
    gh?.remove();
    repo?.remove();
    if (cache) fs.rmSync(cache, { recursive: true, force: true });
  });

  describe('when the review opens, ', () => {
    let shown: string;

    before(async () => {
      shown = [await read(page!, box('.vw-bar')), await read(page!, drawer), await read(page!, fits)].join(' | ');
    });

    it('then the app bar is one row the width of the screen, Contents is closed, and nothing scrolls sideways.', () => {
      assert.equal(shown, '0 0 390 52 | closed | fits');
    });
  });

  describe('when a file is chosen in Contents, ', () => {
    let shown: string;

    before(async () => {
      await page!.click('#vw-contents');
      await page!.until(`document.querySelector('#viewer').classList.contains('side-on')`);
      await page!.click('[data-tab="files"]');
      await page!.until(`!!document.querySelector('[data-open="lib/app.dart"]')`);
      await page!.click('[data-open="lib/app.dart"]');
      await page!.until(`!!document.querySelector('.code[data-p="lib/app.dart"]') && !!document.querySelector('.pill-note')`);
      shown = [await read(page!, drawer), await read(page!, where)].join(' | ');
    });

    it('then Contents closes, and the app bar names the file.', () => {
      assert.equal(shown, 'closed | app.dart');
    });
  });

  describe('when the file is read, ', () => {
    let shown: string;

    before(async () => {
      shown = [
        await read(page!, box('#vw-pill')),
        await read(page!, `getComputedStyle(document.querySelector('.pill-l'), '::after').content`),
        await read(page!, fits),
        await read(page!, `document.querySelector('.ln[data-c="R:2"]').offsetHeight > 2 * document.querySelector('.ln[data-c="R:3"]').offsetHeight - 2 ? 'wraps' : 'one row'`),
      ].join(' | ');
    });

    it('then the review bar is docked under it, the screen’s width, saying Mark and next, and its long line wraps instead of running off the side.', () => {
      assert.equal(shown, '0 788 390 56 | "Mark and next" | fits | wraps');
    });
  });

  describe('when ⋯ is opened, then Back is pressed, ', () => {
    let open: string;
    let closed: string;

    before(async () => {
      await page!.click('#vw-more');
      await page!.until(`!document.querySelector('.menu').hidden && document.querySelector('.menu').classList.contains('sheet')`);
      open = await read(page!, `(() => { const r = document.querySelector('.menu').getBoundingClientRect(); return [r.left, r.width, r.bottom].map(Math.round).join(' '); })()`);
      await page!.eval('history.back()');
      await page!.until(`document.querySelector('.menu').hidden`);
      closed = await read(page!, where);
    });

    it('then it rises from the bottom as a sheet the screen’s width, and Back closes it, leaving the file open.', () => {
      assert.deepEqual([open, closed], ['0 390 844', 'app.dart']);
    });
  });

  describe('when Jump to is opened, then Back is pressed, ', () => {
    let open: string;
    let closed: string;

    before(async () => {
      await page!.click('#vw-jump');
      await page!.until(`!document.querySelector('.pal').hidden`);
      open = [await read(page!, box('.pal')), await read(page!, `[...document.querySelectorAll('.pal-scopes .chip-btn')].map((b) => b.textContent).join(', ')`)].join(' | ');
      await page!.eval('history.back()');
      await page!.until(`document.querySelector('.pal').hidden`);
      closed = await read(page!, where);
    });

    it('then it takes the whole screen with its scopes as chips, and Back closes it, leaving the file open.', () => {
      assert.deepEqual([open, closed], ['0 0 390 844 | Everything, Chains, Files, Symbols, Threads', 'app.dart']);
    });
  });

  describe('when two lines are picked from their gutter, ', () => {
    let shown: string;

    before(async () => {
      await page!.click('.ln[data-c="R:2"] > .no');
      await page!.click('.ln[data-c="R:3"] > .no');
      await page!.until(`document.querySelectorAll('.cm-pick').length === 2`);
      shown = await read(page!, `document.querySelector('.pick-what b').textContent`);
    });

    it('then the review bar says which.', () => {
      assert.equal(shown, 'Lines 2–3');
    });
  });

  describe('when a note is started on them, ', () => {
    let shown: string;

    before(async () => {
      await page!.click('[data-act="pick-note"]');
      await page!.until(`!!document.querySelector('#vw-compose .th.new textarea')`);
      shown = [
        await read(page!, `document.querySelector('#vw-compose .th-new-h b').textContent`),
        await read(page!, `(() => { const r = document.querySelector('#vw-compose').getBoundingClientRect(); return [r.left, r.width, r.bottom].map(Math.round).join(' '); })()`),
        await read(page!, `getComputedStyle(document.querySelector('#vw-compose textarea')).fontSize`),
        await read(page!, `[...document.querySelectorAll('#vw-main .cm-sel')].every((row) => row.getBoundingClientRect().bottom <= document.querySelector('#vw-compose').getBoundingClientRect().top + 1) ? 'its lines in view above it' : 'its lines under it'`),
      ].join(' | ');
    });

    it('then the box is a sheet at the bottom of the screen, its text 16 pixels, with the lines it’s on in view above it.', () => {
      assert.equal(shown, 'Note on lines +2 to +3 | 0 390 844 | 16px | its lines in view above it');
    });
  });
});
