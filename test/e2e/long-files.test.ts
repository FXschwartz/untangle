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
import { read, rest } from './page.ts';

const skip = e2eSkip();
const ada = (date: string): Person => ({ name: 'Ada Review', email: 'ada@example.com', date });
// Two hundred and fifty functions; the change adds one to every fifth.
const functions = (changed: boolean) => Array.from({ length: 250 }, (_, index) => {
  const n = index + 1;
  return changed && n % 5 === 0 ? `int f${n}() => ${n} + 1;` : `int f${n}() => ${n};`;
}).join('\n') + '\n';
// A dozen, the fifth changed into a line too long for the pane.
const wide = (changed: boolean) => Array.from({ length: 12 }, (_, index) => (changed && index === 4 ? `const long = '${'x'.repeat(300)}';` : `int w${index + 1}() => ${index + 1};`)).join('\n') + '\n';
const expects = Array.from({ length: 150 }, (_, index) => `      expect(${index + 1}, ${index + 1});`);
const testFile = ["import 'package:test/test.dart';", '', 'void main() {', "  group('Given a long list,', () {", "    test('when it is summed, then each part is right.', () {", ...expects, '    });', '  });', '}', ''].join('\n');

/** The + is a pointer target, so a busy machine can drop the first move. */
async function showAdd(page: Browser, line: number): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.hover(`[data-c="R:${line}"]`);
    try {
      await page.until(`document.querySelector('.cm-add')?.classList.contains('on')`, 5_000);
      return;
    } catch {
      // Try the move again.
    }
  }
  await page.until(`document.querySelector('.cm-add')?.classList.contains('on')`);
}

const blocks = (file: string) => `[...document.querySelectorAll('.code[data-p="${file}"]')]`;
const frames = (n: number) => `new Promise((resolve) => { let k = 0; const tick = () => (++k >= ${n} ? resolve() : requestAnimationFrame(tick)); requestAnimationFrame(tick); })`;

describe('Given a served review of a long file that changes every fifth line, and a long new test, ', { skip, timeout: 240_000 }, () => {
  let repo: TempRepo | undefined;
  let gh: GhStub | undefined;
  let run: UntangleRun | undefined;
  let page: Browser | undefined;
  let cache = '';

  before(async () => {
    repo = TempRepo.create();
    repo.write('pubspec.yaml', pubspec);
    repo.write('lib/long.dart', functions(false));
    repo.write('lib/wide.dart', wide(false));
    repo.commit({ subject: 'Start', author: ada('2020-06-01T15:00:00Z'), committer: ada('2020-06-01T15:00:00Z') });
    repo.branch('feature');
    repo.write('lib/long.dart', functions(true));
    repo.write('lib/wide.dart', wide(true));
    repo.write('test/long_test.dart', testFile);
    repo.commit({ subject: 'Add one to every fifth', author: ada('2020-06-02T15:00:00Z'), committer: ada('2020-06-02T15:00:00Z') });
    gh = stubGh();
    cache = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-cache-'));
    run = await startUntangle(repo.dir, { cacheDir: cache, gh, base: 'main' });
    await waitForReview(reviewClient(run.url));
    page = await launchBrowser();
    await page.reducedMotion(true);
  });

  after(async () => {
    await page?.close();
    await run?.stop();
    gh?.remove();
    repo?.remove();
    if (cache) fs.rmSync(cache, { recursive: true, force: true });
  });

  async function openFile(file: string): Promise<void> {
    await rest(page!);
    await page!.goto(run!.url);
    await page!.until(`!!document.querySelector('.t-head')`, 30_000);
    await page!.click('[data-tab="files"]');
    await page!.until(`!!document.querySelector('[data-open="${file}"]')`);
    await page!.click(`[data-open="${file}"]`);
    await page!.until(`!!document.querySelector('.code[data-p="${file}"] > .ln')`);
    await page!.eval(frames(2));
  }

  describe('when the long file opens, ', () => {
    let shown: string;

    before(async () => {
      await openFile('lib/long.dart');
      shown = await read(page!, `(() => {
        const list = ${blocks('lib/long.dart')};
        const lines = list.flatMap((b) => [...b.querySelectorAll(':scope > .ln[data-n]')].map((r) => Number(r.dataset.n)));
        const inOrder = lines.every((n, i) => !i || n > lines[i - 1]);
        return list.length + ' blocks, ' + list.filter((b) => b.matches('.cont')).length + ' cut from the first; rows ' + list.map((b) => b.querySelectorAll(':scope > .ln').length).join(' + ') + '; new lines ' + lines[0] + ' to ' + lines[lines.length - 1] + (inOrder ? ', in order' : ', out of order');
      })()`);
    });

    it('then its code is in blocks of a hundred rows, one after the other, with its lines in order.', () => {
      assert.equal(shown, '3 blocks, 2 cut from the first; rows 100 + 100 + 99; new lines 2 to 250, in order');
    });
  });

  describe('when a file with a long line is scrolled sideways, then back, ', () => {
    let sideways: string;
    let back: string;

    before(async () => {
      await openFile('lib/wide.dart');
      const gutter = `(() => { const main = document.querySelector('#vw-main'); const g = main.querySelector('.code[data-p="lib/wide.dart"] .ln[data-n="6"] .g'); return getComputedStyle(g).position + ', ' + Math.round(g.getBoundingClientRect().left - main.getBoundingClientRect().left) + 'px from the edge'; })()`;
      await page!.eval(`document.querySelector('#vw-main').scrollLeft = 200`);
      await page!.until(`document.querySelector('#vw-main').classList.contains('aside')`);
      await page!.eval(frames(2));
      sideways = await read(page!, gutter);
      await page!.eval(`document.querySelector('#vw-main').scrollLeft = 0`);
      await page!.until(`!document.querySelector('#vw-main').classList.contains('aside')`);
      await page!.eval(frames(2));
      back = await read(page!, gutter);
    });

    it('then, scrolled, the gutter stays at the left edge.', () => {
      assert.equal(sideways, 'sticky, 0px from the edge');
    });

    it('then, back, it\'s an ordinary part of its row again.', () => {
      assert.equal(back, 'static, 0px from the edge');
    });
  });

  describe('when the + is dragged from the first block\'s last line onto the second block\'s first, ', () => {
    let heading: string;
    let lines: number[];

    before(async () => {
      await openFile('lib/long.dart');
      lines = JSON.parse(await read(page!, `JSON.stringify((() => { const [a, b] = ${blocks('lib/long.dart')}; const last = [...a.querySelectorAll(':scope > .ln[data-n]')].pop(); const first = b.querySelector(':scope > .ln[data-n]'); return [Number(last.dataset.n), Number(first.dataset.n)]; })())`)) as number[];
      await page!.eval(`document.querySelector('.code[data-p="lib/long.dart"] .ln[data-n="${lines[0]}"]').scrollIntoView({ block: 'center' })`);
      await showAdd(page!, lines[0]!);
      await page!.dragOnto('.cm-add', `[data-c="R:${lines[1]}"]`);
      await page!.until(`(document.querySelector('.th-new-h b')?.textContent || '').includes('lines')`);
      heading = await read(page!, `document.querySelector('.th-new-h b')?.textContent ?? ''`);
    });

    it('then the note covers the lines on both sides of the cut.', () => {
      assert.equal(heading, `Note on lines +${lines[0]} to +${lines[1]}`);
    });
  });

  describe('when j goes through thirty of its changes, then k back through ten, ', () => {
    let forth: string;
    let backward: string;

    /** A key, then the frames over which the change it went to is put in place again. */
    async function press(key: string, times: number): Promise<void> {
      for (let i = 0; i < times; i++) {
        await page!.key(key);
        await page!.eval(frames(4));
      }
    }

    before(async () => {
      await openFile('lib/long.dart');
      await press('j', 30);
      forth = await read(page!, `document.querySelector('#vw-pill .pill-n')?.textContent ?? ''`);
      await press('k', 10);
      backward = await read(page!, `document.querySelector('#vw-pill .pill-n')?.textContent ?? ''`);
    });

    it('then the pill counts each one, past the cuts.', () => {
      assert.deepEqual([forth, backward], ['30 of 50', '20 of 50']);
    });
  });

  describe('when a line of the long test\'s second block is scrolled under the header, ', () => {
    let pinned: string;

    before(async () => {
      await openFile('test/long_test.dart');
      await page!.until(`!!document.querySelector('.code[data-p="test/long_test.dart"] .ln[data-n="130"]')`);
      await page!.eval(`(() => { const main = document.querySelector('#vw-main'); const row = main.querySelector('.code[data-p="test/long_test.dart"] .ln[data-n="130"]'); main.scrollTop += row.getBoundingClientRect().top - main.getBoundingClientRect().top - main.querySelector('.fv-head').offsetHeight; })()`);
      await page!.eval(frames(2));
      await page!.until(`!!document.querySelector('.ol-pin.on')`);
      pinned = await read(page!, `[...document.querySelectorAll('.ol-pin .ol-pin-l')].map((el) => el.textContent).join('\\n')`);
    });

    it('then its Given and its test stay pinned above the code.', () => {
      assert.equal(pinned, ['Given a long list,', 'when it is summed, then each part is right.'].join('\n'));
    });
  });

  describe('when the Notes menu opens and closes over a line of the third block, ', () => {
    let shown: string;

    before(async () => {
      await openFile('lib/long.dart');
      // Past the first two blocks, which the browser has drawn: their heights are known now.
      await page!.eval(`(() => { const main = document.querySelector('#vw-main'); const row = main.querySelector('.code[data-p="lib/long.dart"] .ln[data-n="215"]'); main.scrollTop += row.getBoundingClientRect().top - main.getBoundingClientRect().top - main.querySelector('.fv-head').offsetHeight - 100; })()`);
      await page!.eval(frames(2));
      await page!.eval(`window.__blocks = ${blocks('lib/long.dart')}`);
      const look = `(() => { const main = document.querySelector('#vw-main'), list = ${blocks('lib/long.dart')}, row = main.querySelector('.ln[data-n="215"]'); return [list.length === window.__blocks.length && list.every((b, i) => b === window.__blocks[i]) ? 'the blocks as drawn' : 'other blocks', 'line 215 at ' + Math.round(row.getBoundingClientRect().top - main.getBoundingClientRect().top) + ' px'].join(', '); })()`;
      const seen = [await read(page!, look)];
      await page!.click('[data-act="review-toggle"]');
      await page!.until(`!!document.querySelector('.rv-pop')`);
      await page!.eval(frames(2));
      seen.push(await read(page!, look));
      await page!.click('[data-act="review-toggle"]');
      await page!.until(`!document.querySelector('.rv-pop')`);
      await page!.eval(frames(2));
      seen.push(await read(page!, look));
      shown = seen.join('\n');
    });

    it('then the code stays as it was drawn, and doesn\'t move.', () => {
      const [first] = shown.split('\n');
      assert.match(first, /^the blocks as drawn, line 215 at \d+ px$/);
      assert.equal(shown, [first, first, first].join('\n'));
    });
  });

  describe('when the layout goes side by side, with a line of the second block at the top, ', () => {
    let before0: string;
    let after1: string;

    before(async () => {
      await openFile('lib/long.dart');
      const top = `(() => { const main = document.querySelector('#vw-main'); const y = main.getBoundingClientRect().top + main.querySelector('.fv-head').offsetHeight; const row = [...main.querySelectorAll('.code[data-p="lib/long.dart"] [data-n]')].find((r) => r.dataset.n && r.getBoundingClientRect().bottom > y + 1); return row ? row.dataset.n : 'none'; })()`;
      await page!.eval(`(() => { const main = document.querySelector('#vw-main'); const row = main.querySelector('.code[data-p="lib/long.dart"] .ln[data-n="130"]'); main.scrollTop += row.getBoundingClientRect().top - main.getBoundingClientRect().top - main.querySelector('.fv-head').offsetHeight; })()`);
      await page!.eval(frames(2));
      before0 = await read(page!, top);
      // Clicked where they are: brought into view first, the menu's button would scroll the pane.
      await page!.click('[data-act="menu"][data-menu="view"]', { scroll: false });
      await page!.until(`!!document.querySelector('[data-act="layout"]')`);
      await page!.click('[data-act="layout"]', { scroll: false });
      await page!.until(`!!document.querySelector('.code[data-p="lib/long.dart"] > .sl')`);
      await page!.eval(frames(4));
      after1 = await read(page!, top);
    });

    it('then the same line is at the top.', () => {
      assert.deepEqual([before0, after1], ['130', '130']);
    });
  });

});
