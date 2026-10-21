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
const pads = Array.from({ length: 80 }, (_, index) => `// pad ${index + 1}`);
const beforeNotes = ['// start', ...pads, ''].join('\n');
const afterNotes = ['// changed', ...pads, ''].join('\n');
// A change with a hundred lines above it and more below, so a glide to it can land it at the top.
const far = (word: string) => [...pads, ...pads.slice(0, 20), `void mid() {\n  print('${word}');\n}`, ...pads.slice(0, 60), ''].join('\n');

describe('Given a served review with motion left on, ', { skip, timeout: 180_000 }, () => {
  let repo: TempRepo | undefined;
  let run: UntangleRun | undefined;
  let page: Browser | undefined;
  let cache = '';
  let url = '';

  before(async () => {
    const author = ada('2020-04-01T15:00:00Z');
    const later = ada('2020-04-02T15:00:00Z');
    repo = TempRepo.create();
    repo.write('pubspec.yaml', pubspec);
    repo.write('lib/notes.dart', beforeNotes);
    repo.write('lib/end.dart', ['// top', ...pads, "void tail() {\n  print('a');\n}\n"].join('\n'));
    repo.write('lib/far.dart', far('a'));
    repo.commit({ subject: 'Start', author, committer: author });
    repo.branch('feature');
    repo.write('lib/notes.dart', afterNotes);
    repo.write('lib/end.dart', ['// top', ...pads, "void tail() {\n  print('b');\n}\n"].join('\n'));
    repo.write('lib/far.dart', far('b'));
    repo.commit({ subject: 'Change', author: later, committer: later });
    cache = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-cache-'));
    run = await startUntangle(repo.dir, { base: 'main', cacheDir: cache });
    url = run.url;
    await waitForReview(reviewClient(url));
    page = await launchBrowser();
    await page.reducedMotion(false);
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

  describe('when a change is marked reviewed, ', () => {
    let during: string;
    let afterMark: string;

    before(async () => {
      await rest(page!);
      await openFile('lib/notes.dart');
      await page!.until(`!!document.querySelector('.tick')`);
      await page!.click('.tick');
      during = await read(page!, `document.getAnimations().length || document.querySelector('.ghost') ? 'moving' : 'still'`);
      await page!.until(`document.querySelector('.tick.on') || (document.querySelector('#vw-main')?.textContent || '').includes('reviewed')`);
      afterMark = await read(page!, `document.querySelector('.tick.on') || (document.querySelector('#vw-main')?.textContent || '').includes('reviewed') ? 'reviewed' : 'open'`);
    });

    it('then the fold animates and the change ends reviewed.', () => {
      assert.equal(`${during}\n${afterMark}`, 'moving\nreviewed');
    });
  });

  describe('when more lines are opened from a divider, ', () => {
    let during: string;
    let shown: string;

    before(async () => {
      await rest(page!);
      await page!.goto(url);
      await page!.until(`!!document.querySelector('.t-head')`, 30_000);
      await openFile('lib/end.dart');
      await page!.until(`!!document.querySelector('[data-act="more"]')`);
      const beforeMore = await read(page!, `document.querySelector('[data-act="more"]')?.textContent ?? ''`);
      await page!.click('[data-act="more"]');
      during = await read(page!, `document.getAnimations().length || document.querySelector('.grow') ? 'moving' : 'still'`);
      await page!.until(`(document.querySelector('[data-act="more"]')?.textContent || '') !== ${JSON.stringify(beforeMore)}`);
      const afterMore = await read(page!, `document.querySelector('[data-act="more"]')?.textContent ?? ''`);
      shown = afterMore !== beforeMore ? 'open' : 'closed';
    });

    it('then the lines animate open and stay open.', () => {
      assert.equal(`${during}\n${shown}`, 'moving\nopen');
    });
  });

  describe('when the next change is below the screen, ', () => {
    let landed: string;

    before(async () => {
      await rest(page!);
      await page!.goto(url);
      await page!.until(`!!document.querySelector('.t-head')`, 30_000);
      await openFile('lib/end.dart');
      await page!.eval(`document.querySelector('#vw-main').scrollTop = 0`);
      await page!.click('[data-act="nav"][data-step="1"]');
      await page!.until(`document.querySelector('#vw-main').scrollTop > 100 || (document.querySelector('.code[data-p="lib/end.dart"] .tick')?.getBoundingClientRect().top || 0) < 400`);
      const top = Number(await page!.eval(`document.querySelector('#vw-main').scrollTop`));
      const tickTop = Number(await page!.eval(`document.querySelector('.code[data-p="lib/end.dart"] .tick')?.getBoundingClientRect().top ?? -1`));
      landed = top > 100 || (tickTop >= 0 && tickTop < 500) ? 'glided' : `top ${top} tick ${tickTop}`;
    });

    it('then the page glides to that change.', () => {
      assert.equal(landed, 'glided');
    });
  });

  describe('when the wheel turns while the page glides to a change, ', () => {
    let stopped: string;

    before(async () => {
      await rest(page!);
      await page!.goto(url);
      await page!.until(`!!document.querySelector('.t-head')`, 30_000);
      await openFile('lib/far.dart');
      // The whole file, so the change is far below the top.
      await page!.until(`!!document.querySelector('.fv-head [data-act="whole"]')`);
      await page!.click('.fv-head [data-act="whole"]');
      await page!.until(`(document.querySelector('.code[data-p="lib/far.dart"]')?.textContent || '').includes('// pad 40')`);
      await page!.eval(`document.querySelector('#vw-main').scrollTop = 0`);
      // The wheel turns as the glide starts: a glide lasts a quarter of a second, too short to
      // reach with input from outside the page when many browsers run at once.
      await page!.eval(`(() => {
        document.querySelector('[data-act="nav"][data-step="1"]').click();
        document.querySelector('#vw-main').dispatchEvent(new WheelEvent('wheel', { deltaY: -300, bubbles: true }));
      })()`);
      // Long enough for the glide to have landed, had it gone on.
      await new Promise((done) => setTimeout(done, 600));
      const tickTop = Number(await page!.eval(`document.querySelector('.code[data-p="lib/far.dart"] .tick')?.getBoundingClientRect().top ?? -1`));
      stopped = tickTop > 400 ? 'stopped' : `tick at ${tickTop}`;
    });

    it('then the page stops gliding, short of the change.', () => {
      assert.equal(stopped, 'stopped');
    });
  });
  describe('when a peek is closed, ', () => {
    let during: string;
    let afterClose: string;

    before(async () => {
      await rest(page!);
      await page!.goto(url);
      await page!.until(`!!document.querySelector('.t-head')`, 30_000);
      await openFile('lib/end.dart');
      await page!.clickIn('.code[data-p="lib/end.dart"] .ref', 'print', "print('b');");
      await page!.until(`!!document.querySelector('.peek [data-act="close-peek"]') && document.getAnimations().length === 0`);
      await page!.click('.peek [data-act="close-peek"]');
      during = await read(page!, `(() => { const ghost = document.querySelector('.ghost'); if (!ghost) return 'no stand-in'; return 'a stand-in after line ' + (ghost.previousElementSibling?.dataset.n ?? '?') + ' with ' + ghost.querySelectorAll('.pk-h').length + ' peek in it, ' + document.getAnimations().filter((a) => a.effect?.target === ghost).length + ' animations'; })()`);
      await page!.until(`!document.querySelector('.ghost')`);
      afterClose = await read(page!, `[document.querySelector('.peek') ? 'a peek' : 'no peek', 'line 83 followed by line ' + (document.querySelector('.code[data-p="lib/end.dart"] [data-n="83"]')?.nextElementSibling?.dataset.n ?? '?')].join(', ')`);
    });

    it('then a fading stand-in of the peek folds under its line.', () => {
      assert.equal(during, 'a stand-in after line 83 with 1 peek in it, 2 animations');
    });

    it('then the line is followed by the next one, and no peek is left.', () => {
      assert.equal(afterClose, 'no peek, line 83 followed by line 84');
    });
  });

  describe('when a peek under a removed line is closed, ', () => {
    let during: string;

    before(async () => {
      await rest(page!);
      await page!.goto(url);
      await page!.until(`!!document.querySelector('.t-head')`, 30_000);
      await openFile('lib/end.dart');
      await page!.clickIn('.code[data-p="lib/end.dart"] .ln.del .ref', 'print', "print('a');");
      await page!.until(`!!document.querySelector('.peek [data-act="close-peek"]') && document.getAnimations().length === 0`);
      await page!.click('.peek [data-act="close-peek"]');
      during = await read(page!, `(() => { const ghost = document.querySelector('.ghost'); if (!ghost) return 'no stand-in'; return 'a stand-in after ' + (ghost.previousElementSibling?.matches('.ln.del') ? 'the removed line' : 'something else') + ' with ' + ghost.querySelectorAll('.pk-h').length + ' peek in it, ' + document.getAnimations().filter((a) => a.effect?.target === ghost).length + ' animations'; })()`);
      await page!.until(`!document.querySelector('.ghost')`);
    });

    it('then a fading stand-in of the peek folds under that line too.', () => {
      assert.equal(during, 'a stand-in after the removed line with 1 peek in it, 2 animations');
    });
  });

  describe('when a commit\'s details are opened, then closed, ', () => {
    let motion: string;

    before(async () => {
      await rest(page!);
      await page!.goto(url);
      await page!.until(`!!document.querySelector('.t-head')`, 30_000);
      await page!.click('[data-act="history-open"]');
      await page!.until(`!!document.querySelector('.hs-main[data-detail]')`);
      await page!.click('.hs-main[data-detail]');
      const opening = await read(page!, `(() => { const details = document.querySelector('.hs-detail'); if (!details) return 'no details'; return document.getAnimations().some((a) => a.effect?.target === details) ? 'the details grow' : 'the details appear still'; })()`);
      await page!.until(`!!document.querySelector('.hs-detail') && document.getAnimations().length === 0`);
      await page!.click('.hs-row.open .hs-main');
      const closing = await read(page!, `(() => { const ghost = document.querySelector('.ghost'); if (!ghost) return 'no stand-in'; return 'a stand-in after ' + (ghost.previousElementSibling?.matches('.hs-row') ? 'its row' : 'something else') + ' with ' + ghost.querySelectorAll('.hd-in').length + ' details in it'; })()`);
      await page!.until(`!document.querySelector('.ghost') && !document.querySelector('.hs-detail')`);
      motion = `${opening}\n${closing}`;
    });

    it('then they grow from the commit\'s row and fold back into it.', () => {
      assert.equal(motion, 'the details grow\na stand-in after its row with 1 details in it');
    });
  });
});
