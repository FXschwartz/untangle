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

const box = '.th.new textarea';
// The box's height, whether its text runs past it (it scrolls), and the most it grows to.
const size = `(() => { const ta = document.querySelector('${box}'); return { h: ta.clientHeight, scrolls: ta.scrollHeight > ta.clientHeight + 1, max: Math.round(innerHeight * 0.6) }; })()`;

describe('Given a note being written on a line, ', { skip, timeout: 300_000 }, () => {
  let repo: TempRepo | undefined;
  let gh: GhStub | undefined;
  let run: UntangleRun | undefined;
  let page: Browser | undefined;
  let cache = '';
  let empty = 0, twelve = 0;
  const measure = async () => JSON.parse(await read(page!, `JSON.stringify(${size})`)) as { h: number; scrolls: boolean; max: number };
  // Replaces the box's text, as pasting does.
  const paste = (text: string) => page!.eval(`(() => { const ta = document.querySelector('${box}'); ta.focus(); ta.value = ${JSON.stringify(text)}; ta.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);

  before(async () => {
    repo = TempRepo.create();
    repo.write('pubspec.yaml', pubspec);
    repo.write('lib/app.dart', "void greet() {\n  print('hi');\n}\n");
    repo.commit({ subject: 'Start the package', author: ada('2020-06-01T15:00:00Z'), committer: ada('2020-06-01T15:00:00Z') });
    repo.branch('feature');
    repo.write('lib/app.dart', "void greet(String name) {\n  print('hi, $name');\n}\n");
    repo.commit({ subject: 'Name the greeting', author: ada('2020-06-02T15:00:00Z'), committer: ada('2020-06-02T15:00:00Z') });
    gh = stubGh();
    cache = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-cache-'));
    run = await startUntangle(repo.dir, { cacheDir: cache, gh, base: 'main' });
    await waitForReview(reviewClient(run.url));
    page = await launchBrowser();
    await page.reducedMotion(true);
    await page.goto(run.url);
    await page.until(`!!document.querySelector('.t-head')`, 30_000);
    await page.click('[data-tab="files"]');
    await page.until(`!!document.querySelector('[data-open="lib/app.dart"]')`);
    await page.click('[data-open="lib/app.dart"]');
    await page.until(`!!document.querySelector('.code[data-p="lib/app.dart"]')`);
    await page.hover('[data-c="R:1"]');
    await page.until(`document.querySelector('.cm-add')?.classList.contains('on')`);
    await page.click('.cm-add');
    await page.until(`!!document.querySelector('${box}')`);
    empty = (await measure()).h;
  });

  after(async () => {
    await page?.close();
    await run?.stop();
    gh?.remove();
    repo?.remove();
    if (cache) fs.rmSync(cache, { recursive: true, force: true });
  });

  describe('when twelve lines are typed, ', () => {
    let got: { h: number; scrolls: boolean };

    before(async () => {
      await page!.click(box);
      for (let i = 1; i <= 12; i++) await page!.type(`Line ${i} of what I would change here.${i < 12 ? '\n' : ''}`);
      await page!.until(`document.querySelector('${box}').value.split('\\n').length === 12`);
      got = await measure();
      twelve = got.h;
    });

    it('then the box grows to hold them all, with nothing to scroll.', () => {
      assert.deepEqual([got.h > empty * 2, got.scrolls], [true, false]);
    });
  });

  describe('when far more is pasted than the window holds, ', () => {
    let got: { h: number; scrolls: boolean; max: number };

    before(async () => {
      await paste(Array.from({ length: 200 }, (_, i) => `Line ${i + 1}.`).join('\n'));
      got = await measure();
    });

    it('then it grows to most of the window, and scrolls past that.', () => {
      assert.deepEqual([Math.abs(got.h - got.max) <= 1, got.scrolls], [true, true]);
    });
  });

  describe('when it is cut back to one line, ', () => {
    let got: { h: number; scrolls: boolean };

    before(async () => {
      await paste('One line.');
      got = await measure();
    });

    it('then it shrinks back to its first size.', () => {
      assert.deepEqual([got.h, got.scrolls], [empty, false]);
    });
  });

  describe('when the page draws it again, ', () => {
    let got: { h: number; scrolls: boolean };

    before(async () => {
      await paste(Array.from({ length: 12 }, (_, i) => `Line ${i + 1} of what I would change here.`).join('\n'));
      await page!.click('[data-pane="preview"]');
      await page!.until(`!document.querySelector('${box}')`);
      await page!.click('[data-pane="write"]');
      await page!.until(`!!document.querySelector('${box}')`);
      got = await measure();
    });

    it('then it opens already sized to its text.', () => {
      assert.deepEqual([got.h, got.scrolls], [twelve, false]);
    });
  });
});
