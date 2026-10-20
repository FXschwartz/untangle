import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { e2eSkip, launchBrowser, type Browser } from '../helpers/browser.ts';
import { conversationOf, pendingAnswer, pendingLookup, type ConversationSpec } from '../helpers/conversation.ts';
import { stubGh, type GhStub } from '../helpers/gh.ts';
import { reviewClient, waitForReview, type ReviewClient } from '../helpers/http.ts';
import { pubspec } from '../helpers/review.ts';
import { TempRepo, type Person } from '../helpers/repo.ts';
import { startUntangle, type UntangleRun } from '../helpers/run.ts';
import { read, rest } from './page.ts';

const skip = e2eSkip();
const ada = (date: string): Person => ({ name: 'Ada Review', email: 'ada@example.com', date });

const beforeApp = ['void greet() {', "  print('hi');", '}', '', 'void main() {', '  greet();', '}', ''].join('\n');
const afterApp = ['void greet(String name) {', '  print(name);', '}', '', 'void main() {', "  greet('ada');", '}', ''].join('\n');

// Each row of the file, by its lines ('L:6', or 'L:5/R:5' side by side), with its marks: a thread's
// bar (gh), a note's (note), and the tint of the comment you point at (hot).
const gutter = `[...document.querySelectorAll('.code[data-p="lib/app.dart"] :is(.ln, .sl)')].filter((row) => row.matches('[data-c]') || row.querySelector('[data-c]')).map((row) => [[row, ...row.querySelectorAll('[data-c]')].map((c) => c.dataset.c).filter(Boolean).join('/'), row.matches('.cm-on') ? 'gh' : '', row.matches('.nt-on') ? 'note' : '', row.matches('.cm-hot, .nt-hot') ? 'hot' : ''].filter(Boolean).join(' ')).join(' | ')`;

describe('Given a review of pull request 7, with an open thread on lines 5 to 6, a resolved one on line 2 and a note on lines 1 to 2, ', { skip, timeout: 300_000 }, () => {
  let repo: TempRepo | undefined;
  let gh: GhStub | undefined;
  let run: UntangleRun | undefined;
  let page: Browser | undefined;
  let client: ReviewClient;
  let cache = '';
  let head = '';

  before(async () => {
    repo = TempRepo.create();
    repo.write('pubspec.yaml', pubspec);
    repo.write('lib/app.dart', beforeApp);
    repo.commit({ subject: 'Start the package', author: ada('2020-06-01T15:00:00Z'), committer: ada('2020-06-01T15:00:00Z') });
    repo.branch('feature');
    repo.write('lib/app.dart', afterApp);
    head = repo.commit({ subject: 'Name the greeting', author: ada('2020-06-02T15:00:00Z'), committer: ada('2020-06-02T15:00:00Z') });
    const spec: ConversationSpec = {
      number: 7, title: 'Add a greeting', url: 'https://github.com/acme/sample/pull/7', head,
      threads: [
        { id: 'THREAD_1', path: 'lib/app.dart', startLine: 5, line: 6, body: 'Why this name?' },
        { id: 'THREAD_2', path: 'lib/app.dart', line: 2, body: 'Ship the name.', resolved: true },
      ],
    };
    gh = stubGh([
      {
        match: ['pr', 'view'],
        stdout: { number: 7, title: 'Add a greeting', url: spec.url, state: 'OPEN', baseRefName: 'main', baseRefOid: repo.rev('main'), headRefName: 'feature', headRefOid: head },
      },
      { match: ['api', 'graphql'], stdinIncludes: 'statusCheckRollup', stdout: { data: { repository: { pullRequest: { commits: { nodes: [] }, reviews: { nodes: [] }, timelineItems: { nodes: [] } } } } } },
      { match: ['api', 'graphql'], stdinIncludes: pendingLookup, stdout: pendingAnswer(null) },
      { match: ['api', 'graphql'], stdinIncludes: 'organization(login:', stdout: { data: { organization: null } } },
      { match: ['api', 'graphql'], stdout: conversationOf(spec) },
    ]);
    cache = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-cache-'));
    run = await startUntangle(repo.dir, { cacheDir: cache, gh });
    client = reviewClient(run.url);
    await waitForReview(client);
    await client.call('notes', { method: 'POST', head, body: { action: 'add', path: 'lib/app.dart', side: 'RIGHT', startLine: 1, line: 2, body: 'Name it person?' } });
    page = await launchBrowser();
    await page.reducedMotion(true);
    await page.goto(run.url);
    await page.until(`!!document.querySelector('.t-head')`, 30_000);
    await page.click('[data-tab="files"]');
    await page.until(`!!document.querySelector('[data-open="lib/app.dart"]')`);
    await page.click('[data-open="lib/app.dart"]');
    await page.until(`!!document.querySelector('.th[data-thread="THREAD_1"]') && !!document.querySelector('.th.note[data-note="1"]')`, 30_000);
  });

  after(async () => {
    await page?.close();
    await run?.stop();
    gh?.remove();
    repo?.remove();
    if (cache) fs.rmSync(cache, { recursive: true, force: true });
  });

  describe('when the file is opened, ', () => {
    let shown = '';

    before(async () => {
      shown = await read(page!, gutter);
    });

    it('then the lines under the open thread and the note have a bar, and the resolved thread’s line has only the note’s.', () => {
      assert.equal(shown, 'L:1 | L:2 | R:1 note | R:2 note | R:3 | R:4 | R:5 gh | L:6 gh | R:6 gh | R:7');
    });
  });

  describe('when the pointer is on the open thread, ', () => {
    let shown = '';

    before(async () => {
      await page!.hover('.th[data-thread="THREAD_1"]');
      await page!.until(`!!document.querySelector('.cm-hot')`);
      shown = await read(page!, gutter);
    });

    it('then its lines are tinted.', () => {
      assert.equal(shown, 'L:1 | L:2 | R:1 note | R:2 note | R:3 | R:4 | R:5 gh hot | L:6 gh hot | R:6 gh hot | R:7');
    });
  });

  describe('when the pointer is on the note’s bar, ', () => {
    let shown = '';

    before(async () => {
      await page!.hover('.ln[data-c="R:1"] .g');
      await page!.until(`!!document.querySelector('.nt-hot') && !document.querySelector('.cm-hot')`);
      shown = await read(page!, gutter);
    });

    it('then the note’s lines are tinted instead.', () => {
      assert.equal(shown, 'L:1 | L:2 | R:1 note hot | R:2 note hot | R:3 | R:4 | R:5 gh | L:6 gh | R:6 gh | R:7');
    });
  });

  describe('when the bar is clicked, ', () => {
    let flashed = '';

    before(async () => {
      await page!.click('.ln[data-c="R:1"] .g');
      await page!.until(`document.querySelector('.th.note[data-note="1"]')?.classList.contains('flash-th')`);
      flashed = await read(page!, `[...document.querySelectorAll('.flash-th')].map((th) => th.matches('.note') ? 'N' + th.dataset.note : th.dataset.thread).join(' ')`);
    });

    it('then the page goes to the note, and it flashes.', () => {
      assert.equal(flashed, 'N1');
    });
  });

  describe('when the code is side by side, ', () => {
    let shown = '';

    before(async () => {
      await rest(page!);
      await page!.click('[data-act="menu"][data-menu="view"]');
      await page!.until(`!!document.querySelector('[data-act="layout"]')`);
      await page!.click('[data-act="layout"]');
      await page!.until(`!!document.querySelector('.code[data-p="lib/app.dart"] .sl')`);
      shown = await read(page!, gutter);
    });

    it('then each row has the bar of the lines on either side.', () => {
      assert.equal(shown, 'L:1/R:1 note | L:2/R:2 note | L:3/R:3 | L:4/R:4 | L:5/R:5 gh | L:6/R:6 gh | L:7/R:7');
    });
  });

  describe('when the note is resolved, ', () => {
    let shown = '';

    before(async () => {
      await client.call('notes', { method: 'POST', head, body: { action: 'resolve', n: 1, resolved: true } });
      await page!.until(`!document.querySelector('.nt-on')`, 10_000);
      shown = await read(page!, gutter);
    });

    it('then its bar is gone, and the open thread keeps its own.', () => {
      assert.equal(shown, 'L:1/R:1 | L:2/R:2 | L:3/R:3 | L:4/R:4 | L:5/R:5 gh | L:6/R:6 gh | L:7/R:7');
    });
  });
});
