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
const report = (first: string) => `import 'price.dart';\n\nvoid keep() {}\n\nvoid report(int total) {\n  print('${first}: \${price(total)}');\n  print('done');\n}\n`;

async function openChain(page: Browser, name: string): Promise<void> {
  await page.click('[data-tab="chains"]');
  await page.until(`!!document.querySelector('[data-chain]')`);
  const id = await read(page, `([...document.querySelectorAll('.sb-row[data-chain]')].find((el) => (el.textContent || '').includes(${JSON.stringify(name)})) || {}).dataset?.chain ?? ''`);
  if (!id) throw new Error(`no chain ${name}`);
  await page.click(`.sb-row[data-chain="${id}"]`);
  await page.until(`!!document.querySelector('.cm-note')`);
}

describe('Given a served review that follows four commits: a follow-up of the first, and tests that build on the second, ', { skip, timeout: 180_000 }, () => {
  let repo: TempRepo | undefined;
  let run: UntangleRun | undefined;
  let page: Browser | undefined;
  let cache = '';
  let reportSha = '';
  let labelSha = '';
  let coverSha = '';

  before(async () => {
    repo = TempRepo.create();
    repo.write('pubspec.yaml', pubspec);
    repo.write('lib/report.dart', 'void keep() {}\n');
    repo.write('lib/price.dart', 'int price(int amount) => amount;\n');
    const start = ada('2020-08-01T15:00:00Z');
    repo.commit({ subject: 'Start the shop', author: start, committer: start });
    repo.branch('feature');
    repo.write('lib/report.dart', report('total'));
    const first = ada('2020-08-02T15:00:00Z');
    reportSha = repo.commit({ subject: 'feat: Add a report', body: 'Prints the total and a closing line.\n\nThe closing line tells the reader the report ended.', author: first, committer: first });
    repo.write('lib/price.dart', 'int price(int amount) => amount * 2;\n');
    const second = ada('2020-08-03T15:00:00Z');
    repo.commit({ subject: 'feat: Double the price', author: second, committer: second });
    repo.write('lib/report.dart', report('sum'));
    const third = ada('2020-08-04T15:00:00Z');
    labelSha = repo.commit({ subject: 'fix: Label the sum', author: third, committer: third });
    repo.write('test/price_test.dart', "import 'package:sample/price.dart';\n\nvoid main() {\n  price(1);\n  price(2);\n}\n");
    repo.write('lib/price.dart', 'int price(int amount) => amount * 3;\n');
    const fourth = ada('2020-08-05T15:00:00Z');
    coverSha = repo.commit({ subject: 'test: Cover the price', author: fourth, committer: fourth });
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

  describe('when the chains are listed, ', () => {
    let listed = '';

    before(async () => {
      await rest(page!);
      await page!.click('[data-tab="chains"]');
      await page!.until(`!!document.querySelector('.sb-row[data-chain]')`);
      listed = await read(page!, `[...document.querySelectorAll('.sb-row[data-chain] .nm')].map((el) => el.textContent).join(', ')`);
    });

    it('then each commit that started changes is one chain, in the order they were made.', () => {
      assert.equal(listed, 'Add a report, Double the price, Cover the price');
    });
  });

  describe('when the report\'s chain is opened, ', () => {
    let note = '';

    before(async () => {
      await rest(page!);
      await openChain(page!, 'Add a report');
      note = await read(page!, `[...document.querySelectorAll('.cm-note > *')].map((el) => el.textContent).join('\\n')`);
    });

    it('then it opens with the commit\'s subject and the first paragraph of its message.', () => {
      assert.equal(note, [
        `feat Add a report ${reportSha.slice(0, 7)}`,
        'Prints the total and a closing line.',
        'Show the whole message',
      ].join('\n'));
    });
  });

  describe('when the report\'s chain is opened, which its follow-up changed, ', () => {
    let bar = '';

    before(async () => {
      await rest(page!);
      await openChain(page!, 'Add a report');
      bar = await read(page!, `[...document.querySelectorAll('.fv-head .wb-seg')].map((s) => s.getAttribute('aria-label') + (s.classList.contains('own') ? ' (its own)' : '')).join(' | ') + ' · ' + [...document.querySelectorAll('.fv-head .wb > .lnk, .fv-head .wb > .wb-n')].map((b) => b.textContent).join(' · ')`);
    });

    it('then a bar under its members shares its lines between its commit and the follow-up, oldest first, then counts them.', () => {
      assert.equal(bar, `${reportSha.slice(0, 7)} Add a report: 86% of the lines (its own) | ${labelSha.slice(0, 7)} Label the sum: 14% of the lines (its own) · 2 commits · Commit details`);
    });
  });

  describe('when the report\'s chain shows its commits in the Commits tab, ', () => {
    let rows = '';

    before(async () => {
      await rest(page!);
      await openChain(page!, 'Add a report');
      await page!.click('[data-act="show-commits"]');
      await page!.until(`!!document.querySelector('.cm-list.follow')`);
      rows = await read(page!, `[[...document.querySelectorAll('.sb-group')].find((group) => group.firstElementChild.textContent === 'Commits').lastElementChild.textContent, ...[...document.querySelectorAll('.cm-row')].map((r) => r.querySelector('.cm-s').textContent + (r.classList.contains('mine') ? ' · ' + r.querySelector('.cm-m b').textContent + (r.querySelector('.ring') ? ' · ringed' : '') : ' · faded'))].join('\\n')`);
    });

    it('then the chain\'s two commits stand out with their changes here, ringed as its own, and the others fade.', () => {
      assert.equal(rows, [
        '2 of 4 in this chain',
        'Cover the price · faded',
        'Label the sum · 1 here · ringed',
        'Double the price · faded',
        'Add a report · 2 here · ringed',
      ].join('\n'));
    });
  });

  describe('when the follow-up is hovered in the Commits tab, ', () => {
    let lit = '';

    before(async () => {
      await rest(page!);
      await openChain(page!, 'Add a report');
      await page!.click('[data-act="show-commits"]');
      await page!.until(`!!document.querySelector('.cm-list.follow')`);
      await page!.hover(`.cm-row[data-commit="${labelSha}"]`);
      await page!.until(`!!document.querySelector('.wb-seg.hl')`);
      lit = await read(page!, `[...new Set([...document.querySelectorAll('.vw-main .ln.add, .vw-main .ln.del')].filter((l) => getComputedStyle(l.querySelector('.tx')).opacity === '1').map((l) => l.querySelector('.tx').textContent.trim()))].join(' ⏎ ') + ' | ' + [...document.querySelectorAll('.wb-seg.hl')].map((s) => s.getAttribute('aria-label')).join(', ')`);
      await page!.hover('.crumbs');
      await page!.until(`!document.querySelector('.wb-seg.hl')`);
    });

    it('then only the line it wrote stays lit, and its part of the bar lights.', () => {
      assert.equal(lit, `print('sum: \${price(total)}'); | ${labelSha.slice(0, 7)} Label the sum: 14% of the lines`);
    });
  });

  describe('when the Commits tab shows and the next chain is asked for, ', () => {
    let followed = '';

    before(async () => {
      await rest(page!);
      await openChain(page!, 'Add a report');
      await page!.click('[data-act="show-commits"]');
      await page!.until(`!!document.querySelector('.cm-list.follow')`);
      await page!.key('n');
      await page!.until(`(document.querySelector('.crumbs b')?.textContent || '') === 'Double the price'`);
      followed = await read(page!, `[document.querySelector('[data-tab="commits"]').getAttribute('aria-selected') === 'true' ? 'Commits shown' : 'Commits hidden', [...document.querySelectorAll('.sb-group')].find((group) => group.firstElementChild.textContent === 'Commits').lastElementChild.textContent, [...document.querySelectorAll('.cm-row.mine .cm-s')].map((s) => s.textContent).join(', ')].join(' | ')`);
    });

    it('then the Commits tab stays and follows the chain that opens.', () => {
      assert.equal(followed, 'Commits shown | 2 of 4 in this chain | Cover the price, Double the price');
    });
  });

  describe('when the tests\' chain lists the other chains its commit wrote in, and one is chosen, ', () => {
    let chosen = '';

    before(async () => {
      await rest(page!);
      await openChain(page!, 'Cover the price');
      await page!.click('[data-menu="also"]');
      await page!.until(`!!document.querySelector('.menu:not([hidden]) .mi')`);
      const menu = await read(page!, `[...document.querySelectorAll('.menu:not([hidden]) .mi-h, .menu:not([hidden]) .mi')].map((el) => el.matches('.mi') ? el.querySelector('span:not(.ic):not(.k)').textContent + ' · ' + el.querySelector('.k').textContent : el.textContent).join(' | ')`);
      await page!.click('.menu:not([hidden]) .mi');
      await page!.until(`(document.querySelector('.crumbs b')?.textContent || '') === 'Double the price'`);
      chosen = [menu, `→ ${await read(page!, `document.querySelector('.crumbs b').textContent + ', through ' + document.querySelector('.t-head span').textContent`)}`].join('\n');
    });

    it('then the menu names the price\'s chain, which opens through the tests\' commit.', () => {
      assert.equal(chosen, [
        `Where ${coverSha.slice(0, 7)} also wrote lines | Double the price · 1 change`,
        `→ Double the price, through ${coverSha.slice(0, 7)} · Cover the price`,
      ].join('\n'));
    });
  });

  describe('when the report\'s commit details are opened, then Esc is pressed, ', () => {
    let card = '';

    before(async () => {
      await rest(page!);
      await openChain(page!, 'Add a report');
      await page!.click('[data-act="card"]');
      await page!.until(`!!document.querySelector('.hs-detail.solo')`);
      const open = await read(page!, `(() => { const el = document.querySelector('.hs-detail.solo'); return [el.previousElementSibling.matches('.cm-note') ? 'under the message' : 'elsewhere', el.querySelector('.hd-facts dd').textContent, el.querySelector('.hd-subj').textContent, [...el.querySelectorAll('.hd-acts .btn')].map((b) => b.textContent).join(', ')].join(' · '); })()`);
      await page!.key('Escape');
      await page!.until(`!document.querySelector('.hs-detail')`);
      card = `${open} | after Esc: ${await read(page!, `document.querySelector('[data-act="card"]').getAttribute('aria-expanded') === 'false' ? 'closed' : 'open'`)}`;
    });

    it('then History\'s card opens under the message with the commit and its actions, and Esc closes it.', () => {
      assert.equal(card, `under the message · ${reportSha} · feat: Add a report · Review its changes · 2, Only its changes | after Esc: closed`);
    });
  });

  describe('when the report\'s commit details close, with motion on, ', () => {
    let during = '';

    before(async () => {
      await rest(page!);
      await page!.reducedMotion(false);
      await openChain(page!, 'Add a report');
      await page!.click('[data-act="card"]');
      await page!.until(`!!document.querySelector('.hs-detail.solo') && document.getAnimations().length === 0`);
      await page!.click('[data-act="card"]');
      during = await read(page!, `(() => { const ghost = document.querySelector('.ghost'); if (!ghost) return 'no stand-in'; return 'a stand-in after ' + (ghost.previousElementSibling?.matches('.cm-note') ? 'the message' : 'something else') + ' with ' + ghost.querySelectorAll('.hd-in').length + ' card in it'; })()`);
      await page!.until(`!document.querySelector('.ghost')`);
    });

    after(async () => {
      await page?.reducedMotion(true);
    });

    it('then a fading stand-in of the card folds under the message.', () => {
      assert.equal(during, 'a stand-in after the message with 1 card in it');
    });
  });

  describe('when the report\'s chain is opened, which calls a function a later commit changes, ', () => {
    let note = '';

    before(async () => {
      await rest(page!);
      await openChain(page!, 'Add a report');
      note = await read(page!, `[...document.querySelectorAll('.sec-note')].map((el) => el.textContent).find((text) => text.startsWith('Uses')) ?? ''`);
    });

    it('then a note under its member says the function changes later, and where.', () => {
      assert.equal(note, 'Uses price, which changes later in Double the price.');
    });
  });

  describe('when the tests\' chain shows the change of the function they call, then follows it, ', () => {
    let followed = '';

    before(async () => {
      await rest(page!);
      await openChain(page!, 'Cover the price');
      const note = await read(page!, `[...document.querySelectorAll('.sec-note')].map((el) => el.textContent).find((text) => text.startsWith('Uses')) ?? ''`);
      await page!.click('.sec-note [data-act="ext-peek"]');
      await page!.until(`!!document.querySelector('.peek .pk-code')`);
      const peek = await read(page!, `[...document.querySelectorAll('.peek .pk-h > b, .peek .pk-h > .pk-src')].map((el) => el.textContent).join(' · ') + ' | ' + [...document.querySelectorAll('.peek .pk-ln.add .tx')].map((el) => el.textContent).join(' ⏎ ')`);
      await page!.click('.peek [data-act="ext"]');
      await page!.until(`(document.querySelector('.crumbs b')?.textContent || '') === 'Double the price'`);
      followed = [note, peek, `→ ${await read(page!, `document.querySelector('.crumbs b').textContent`)}`].join('\n');
    });

    it('then the note names the function and its chain, its name shows the change in place, and the peek opens that chain.', () => {
      assert.equal(followed, [
        'Uses price, changed in Double the price.',
        'price · changed in Double the price · not reviewed | int price(int amount) => amount * 3;',
        '→ Double the price',
      ].join('\n'));
    });
  });

  describe('when the dotted box in the report\'s graph is clicked, ', () => {
    let opened = '';

    before(async () => {
      await rest(page!);
      await openChain(page!, 'Add a report');
      await page!.until(`!!document.querySelector('g[data-act="ext-box"]')`);
      await page!.click('g[data-act="ext-box"]');
      await page!.until(`!!document.querySelector('.peek .pk-code')`);
      opened = await read(page!, `(() => { const peek = document.querySelector('.peek'); return (peek.closest('section')?.querySelector('.sec-h b')?.textContent || '?') + ': ' + [...peek.querySelectorAll('.pk-h > b, .pk-h > .pk-src')].map((el) => el.textContent).join(' · '); })()`);
    });

    it('then the change of the function it calls opens under the member that calls it.', () => {
      assert.equal(opened, 'report: price · changes later in Double the price · not reviewed');
    });
  });

  describe('when the change shown under the tests\' note is closed, with motion on, ', () => {
    let during = '';

    before(async () => {
      await rest(page!);
      await page!.reducedMotion(false);
      await openChain(page!, 'Cover the price');
      await page!.click('.sec-note [data-act="ext-peek"]');
      await page!.until(`!!document.querySelector('.peek .pk-code') && document.getAnimations().length === 0`);
      await page!.click('.peek [data-act="close-peek"]');
      during = await read(page!, `(() => { const ghost = document.querySelector('.ghost'); if (!ghost) return 'no stand-in'; return 'a stand-in after ' + (ghost.previousElementSibling?.matches('.sec-note') ? 'the note' : 'something else') + ' with ' + ghost.querySelectorAll('.pk-h').length + ' peek in it'; })()`);
      await page!.until(`!document.querySelector('.ghost')`);
    });

    after(async () => {
      await page?.reducedMotion(true);
    });

    it('then a fading stand-in of the peek folds under the note.', () => {
      assert.equal(during, 'a stand-in after the note with 1 peek in it');
    });
  });

  describe('when the chain map is opened, ', () => {
    let map = '';

    before(async () => {
      await rest(page!);
      await page!.click('[data-tab="chains"]');
      await page!.click('.sb-row.map[data-map]');
      await page!.until(`!!document.querySelector('.g-node')`);
      map = await read(page!, `[...document.querySelectorAll('.g-node')].map((n) => n.querySelector('.g-l1').textContent + ' ' + n.querySelector('.g-l2').textContent).join(', ') + ' · ' + document.querySelectorAll('.g-edge').length + ' arrow'`);
    });

    it('then each commit\'s chain is a box, and an arrow goes from a chain to the one that builds on it.', () => {
      assert.equal(map, 'feat Add a report, feat Double the price, test Cover the price · 1 arrow');
    });
  });

  describe('when the whole message is shown, ', () => {
    let message = '';

    before(async () => {
      await rest(page!);
      await openChain(page!, 'Add a report');
      await page!.click('[data-act="note-more"]');
      await page!.until(`(document.querySelector('[data-act="note-more"]')?.textContent || '') === 'Show less'`);
      message = await read(page!, `document.querySelector('.cm-text')?.textContent ?? ''`);
    });

    it('then both paragraphs show.', () => {
      assert.equal(message, 'Prints the total and a closing line.\n\nThe closing line tells the reader the report ended.');
    });
  });
});
