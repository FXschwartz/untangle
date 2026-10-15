import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { e2eSkip, launchBrowser, type Browser } from '../helpers/browser.ts';
import { conversationOf, pendingAnswer, pendingLookup } from '../helpers/conversation.ts';
import type { GhStub } from '../helpers/gh.ts';
import { stubGh } from '../helpers/gh.ts';
import { reviewClient, waitForReview } from '../helpers/http.ts';
import { pubspec } from '../helpers/review.ts';
import { TempRepo, type Person } from '../helpers/repo.ts';
import { startUntangle, type UntangleRun } from '../helpers/run.ts';
import { read, rest } from './page.ts';

const skip = e2eSkip();
const ada = (date: string): Person => ({ name: 'Ada Review', email: 'ada@example.com', date });
const behind = 'b'.repeat(40);

const beforeApp = ['void greet() {', "  print('hi');", '}', '', 'void main() {', '  greet();', '}', ''].join('\n');
const afterApp = ['void greet(String name) {', '  print(name);', '}', '', 'void main() {', "  greet('ada');", '}', ''].join('\n');

function posted(gh: GhStub, mutation: string): string {
  const call = [...gh.calls()].reverse().find((item) => item.stdin.includes(`${mutation}(input:`));
  if (!call) throw new Error(`no ${mutation} call`);
  const body = JSON.parse(call.stdin) as { variables: { input: unknown } };
  return JSON.stringify(body.variables.input);
}

describe('Given a served review that is behind pull request 7, which has a pending review, ', { skip, timeout: 300_000 }, () => {
  let repo: TempRepo | undefined;
  let gh: GhStub | undefined;
  let run: UntangleRun | undefined;
  let page: Browser | undefined;
  let cache = '';

  before(async () => {
    const author = ada('2020-06-01T15:00:00Z');
    const later = ada('2020-06-02T15:00:00Z');
    repo = TempRepo.create();
    repo.write('pubspec.yaml', pubspec);
    repo.write('lib/app.dart', beforeApp);
    repo.commit({ subject: 'Start the package', author, committer: author });
    repo.branch('feature');
    repo.write('lib/app.dart', afterApp);
    const head = repo.commit({ subject: 'Name the greeting', author: later, committer: later });
    const spec = {
      number: 7,
      title: 'Add a greeting',
      url: 'https://github.com/acme/sample/pull/7',
      head: behind,
      pending: { id: 'REVIEW_PENDING', comments: 1 },
      threads: [{ id: 'THREAD_1', path: 'lib/app.dart', line: 6, body: 'Please rename it.', pending: true }],
    };
    gh = stubGh([
      {
        match: ['pr', 'view'],
        stdout: {
          number: 7, title: 'Add a greeting', url: 'https://github.com/acme/sample/pull/7', state: 'OPEN',
          baseRefName: 'main', baseRefOid: repo.rev('main'), headRefName: 'feature', headRefOid: head,
        },
      },
      { match: ['api', 'graphql'], stdinIncludes: 'statusCheckRollup', stdout: { data: { repository: { pullRequest: { commits: { nodes: [] }, reviews: { nodes: [] }, timelineItems: { nodes: [] } } } } } },
      { match: ['api', 'graphql'], stdinIncludes: pendingLookup, stdout: pendingAnswer('REVIEW_PENDING') },
      { match: ['api', 'graphql'], stdinIncludes: 'addPullRequestReviewThreadReply', stdout: conversationOf(spec) },
      { match: ['api', 'graphql'], stdinIncludes: 'submitPullRequestReview', stdout: conversationOf(spec) },
      { match: ['api', 'graphql'], stdinIncludes: 'deletePullRequestReview', stdout: conversationOf({ ...spec, pending: null, threads: [] }) },
      { match: ['api', 'graphql'], stdout: conversationOf(spec) },
    ]);
    cache = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-cache-'));
    run = await startUntangle(repo.dir, { cacheDir: cache, gh });
    await waitForReview(reviewClient(run.url));
    page = await launchBrowser();
    await page.reducedMotion(true);
    await page.goto(run.url);
    await page.until(`!!document.querySelector('.t-head')`, 30_000);
    await page.until(`(document.querySelector('.rv-btn')?.textContent || '').includes('Finish review')`, 20_000);
  });

  after(async () => {
    await page?.close();
    await run?.stop();
    gh?.remove();
    repo?.remove();
    if (cache) fs.rmSync(cache, { recursive: true, force: true });
  });

  describe('when the Threads tab is opened, ', () => {
    let warning: string;
    let plus: string;

    before(async () => {
      await rest(page!);
      await page!.click('[data-tab="comments"]');
      await page!.until(`(document.querySelector('.sb-warn')?.textContent || '').includes('Comments on lines wait')`);
      warning = await read(page!, `document.querySelector('.sb-warn')?.textContent ?? ''`);
      await page!.click('[data-tab="files"]');
      await page!.click('[data-open="lib/app.dart"]');
      await page!.until(`!!document.querySelector('.code[data-p="lib/app.dart"]')`);
      await page!.hover('[data-c="R:6"]');
      plus = await read(page!, `document.querySelector('.cm-add')?.classList.contains('on') ? 'shown' : 'hidden'`);
    });

    it('then comments on lines wait until the review is on GitHub\'s head.', () => {
      assert.equal(`${warning}\n${plus}`, `GitHub has newer commits (${behind.slice(0, 7)}). Comments on lines wait for this review to be on them. Refresh\nhidden`);
    });
  });

  describe('when a reply is posted while the review is behind, ', () => {
    let sent: string;

    before(async () => {
      await rest(page!);
      await page!.click('[data-tab="files"]');
      await page!.click('[data-open="lib/app.dart"]');
      await page!.until(`!!document.querySelector('[data-act="away-toggle"]')`);
      await page!.click('[data-act="away-toggle"]');
      await page!.until(`!!document.querySelector('[data-thread="THREAD_1"] [data-act="reply-open"]')`);
      await page!.click('[data-thread="THREAD_1"] [data-act="reply-open"]');
      await page!.until(`!!document.querySelector('[data-thread="THREAD_1"] textarea.cmp-ta')`);
      await page!.click('[data-thread="THREAD_1"] textarea.cmp-ta');
      await page!.type('Still reading.');
      await page!.until(`document.querySelector('[data-thread="THREAD_1"] textarea.cmp-ta')?.value === 'Still reading.'`);
      await page!.click('[data-thread="THREAD_1"] [data-act="gh-reply"]');
      await page!.until(`(document.querySelector('#vw-toast')?.textContent || '') === 'Reply added to your pending review'`);
      sent = posted(gh!, 'addPullRequestReviewThreadReply');
    });

    it('then GitHub is asked to add the reply.', () => {
      assert.equal(sent, '{"pullRequestReviewThreadId":"THREAD_1","body":"Still reading."}');
    });
  });

  describe('when a review is submitted while the review is behind, ', () => {
    let sent: string;

    before(async () => {
      await rest(page!);
      await page!.click('.rv-btn');
      await page!.until(`!!document.querySelector('[data-act="gh-submit"]')`);
      await page!.click('textarea[data-draft="review"]');
      await page!.type('Looks fine.');
      await page!.until(`document.querySelector('textarea[data-draft="review"]')?.value === 'Looks fine.'`);
      await page!.click('[data-act="gh-submit"]');
      await page!.until(`(document.querySelector('#vw-toast')?.textContent || '') === 'Review submitted'`);
      sent = posted(gh!, 'submitPullRequestReview');
    });

    it('then GitHub is asked to submit it.', () => {
      assert.equal(sent, '{"pullRequestReviewId":"REVIEW_PENDING","event":"COMMENT","body":"Looks fine."}');
    });
  });

  describe('when the pending review is discarded, ', () => {
    let sent: string;
    let button: string;

    before(async () => {
      await rest(page!);
      await page!.click('.rv-btn');
      await page!.until(`!!document.querySelector('[data-act="gh-discard"]')`);
      await page!.click('[data-act="gh-discard"]');
      await page!.until(`(document.querySelector('#vw-toast')?.textContent || '') === 'Pending review discarded'`);
      sent = posted(gh!, 'deletePullRequestReview');
      button = await read(page!, `document.querySelector('.rv-btn')?.textContent ?? ''`);
    });

    it('then GitHub is asked to delete it and the review is no longer pending.', () => {
      assert.equal(`${sent}\n${button}`, '{"pullRequestReviewId":"REVIEW_PENDING"}\nReview');
    });
  });
});
