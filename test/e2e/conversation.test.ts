import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { e2eSkip, launchBrowser, type Browser } from '../helpers/browser.ts';
import { conversationOf, type ConversationSpec } from '../helpers/conversation.ts';
import type { GhStub } from '../helpers/gh.ts';
import { reviewClient, waitForReview } from '../helpers/http.ts';
import { stubGh } from '../helpers/gh.ts';
import { pubspec } from '../helpers/review.ts';
import { TempRepo, type Person } from '../helpers/repo.ts';
import { startUntangle, type UntangleRun } from '../helpers/run.ts';
import { read, rest } from './page.ts';

const skip = e2eSkip();
const ada = (date: string): Person => ({ name: 'Ada Review', email: 'ada@example.com', date });
const html = '<p>Read <a href="https://example.test/docs" onclick="alert(1)">the docs</a> and <a href="javascript:alert(1)">no</a><img src="https://example.test/a.png" onerror="alert(1)"></p>';

async function fill(page: Browser, selector: string, text: string): Promise<void> {
  const want = JSON.stringify(text);
  await page.click(selector);
  await page.key('a', { ctrl: true });
  await page.type(text);
  await page.until(`document.querySelector(${JSON.stringify(selector)})?.value === ${want}`);
}

describe('Given a served review whose pull request description has a link and unsafe HTML, ', { skip, timeout: 180_000 }, () => {
  let repo: TempRepo | undefined;
  let gh: GhStub | undefined;
  let run: UntangleRun | undefined;
  let page: Browser | undefined;
  let cache = '';
  let url = '';
  let spec: ConversationSpec;

  before(async () => {
    const author = ada('2020-06-01T15:00:00Z');
    const later = ada('2020-06-02T15:00:00Z');
    repo = TempRepo.create();
    repo.write('pubspec.yaml', pubspec);
    repo.write('lib/app.dart', "void greet() {\n  print('hi');\n}\n");
    repo.commit({ subject: 'Start', author, committer: author });
    repo.branch('feature');
    repo.write('lib/app.dart', "void greet() {\n  print('hello');\n}\n");
    const head = repo.commit({ subject: 'Name it', author: later, committer: later });
    spec = {
      number: 7,
      title: 'Add a greeting',
      url: 'https://github.com/acme/sample/pull/7',
      head,
      html,
      threads: [{ id: 'THREAD_1', path: 'lib/app.dart', line: 2, body: 'Why this name?' }],
      reviews: [{ id: 'REVIEW_1', state: 'APPROVED', body: 'Ship it.' }],
    };
    const commits = { data: { repository: { pullRequest: { commits: { nodes: [] as [] }, reviews: { nodes: [] as [] }, timelineItems: { nodes: [] as [] } } } } };
    gh = stubGh([
      {
        match: ['pr', 'view'],
        stdout: {
          number: 7, title: 'Add a greeting', url: spec.url, state: 'OPEN',
          baseRefName: 'main', baseRefOid: repo.rev('main'), headRefName: 'feature', headRefOid: head,
        },
      },
      { match: ['api', 'graphql'], stdinIncludes: 'statusCheckRollup', stdout: commits },
      { match: ['api', 'graphql'], stdinIncludes: 'addComment', stdout: conversationOf(spec) },
      { match: ['api', 'graphql'], stdout: conversationOf(spec) },
    ]);
    cache = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-cache-'));
    run = await startUntangle(repo.dir, { cacheDir: cache, gh });
    url = run.url;
    await waitForReview(reviewClient(url));
    page = await launchBrowser();
    await page.reducedMotion(true);
    await page.goto(url);
    await page.until(`!!document.querySelector('.t-head')`, 30_000);
  });

  after(async () => {
    await page?.close();
    await run?.stop();
    gh?.remove();
    repo?.remove();
    if (cache) fs.rmSync(cache, { recursive: true, force: true });
  });

  async function fresh(): Promise<void> {
    await page!.goto(url);
    await page!.until(`!!document.querySelector('.t-head')`, 30_000);
    await page!.click('[data-tab="comments"]');
    await page!.until(`!!document.querySelector('[data-act="conversation"]')`);
  }

  describe('when the conversation is opened, ', () => {
    let shown: string;

    before(async () => {
      await fresh();
      await page!.click('[data-act="conversation"]');
      await page!.until(`(document.querySelector('#vw-main')?.textContent || '').includes('the docs')`);
      shown = await read(page!, `document.querySelector('#vw-main')?.innerHTML ?? ''`);
    });

    it('then the description, the review and the comment box are shown, with the link kept and the unsafe parts gone.', () => {
      const link = shown.includes('href="https://example.test/docs"') && shown.includes('the docs');
      const review = shown.includes('approved these changes') && shown.includes('Ship it.');
      const box = shown.includes('Add a comment to the conversation');
      const unsafe = shown.includes('onclick') || shown.includes('javascript:') || shown.includes('onerror');
      assert.equal(`${link && review && box ? 'shown' : shown}\n${unsafe ? 'unsafe' : 'clean'}`, 'shown\nclean');
    });
  });

  describe('when a comment is posted from the conversation, ', () => {
    let sent: string;

    before(async () => {
      await fresh();
      await page!.click('[data-act="conversation"]');
      await page!.until(`!!document.querySelector('textarea[data-draft="issue"]')`);
      await fill(page!, 'textarea[data-draft="issue"]', 'Looks good.');
      await page!.click('[data-act="gh-comment"]');
      await page!.until(`(document.querySelector('#vw-toast')?.textContent || '') === 'Comment posted'`);
      const call = gh!.calls().find((item) => item.stdin.includes('addComment(input:'));
      sent = call ? JSON.stringify(JSON.parse(call.stdin).variables.input) : '';
    });

    it('then GitHub is asked to comment on the pull request.', () => {
      assert.equal(sent, '{"subjectId":"PR_1","body":"Looks good."}');
    });
  });

  describe('when a thread is opened from the Threads tab, ', () => {
    let where: string;

    before(async () => {
      await rest(page!);
      await page!.click('[data-tab="comments"]');
      await page!.until(`!!document.querySelector('[data-act="thread-open"][data-thread="THREAD_1"]')`);
      await page!.click('[data-act="thread-open"][data-thread="THREAD_1"]');
      await page!.until(`!!document.querySelector('.code[data-p="lib/app.dart"] [data-thread="THREAD_1"]')`);
      where = await read(page!, `document.querySelector('.code[data-p="lib/app.dart"] [data-thread="THREAD_1"]') ? 'on the file' : 'missing'`);
    });

    it('then the file opens at that thread.', () => {
      assert.equal(where, 'on the file');
    });
  });
});
