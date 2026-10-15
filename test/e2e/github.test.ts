import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { e2eSkip, launchBrowser, type Browser } from '../helpers/browser.ts';
import { conversationOf, issueAnswer, mentionAnswer, pendingAnswer, pendingLookup, type ConversationSpec } from '../helpers/conversation.ts';
import type { GhStub } from '../helpers/gh.ts';
import { reviewClient, waitForReview } from '../helpers/http.ts';
import { stubGh } from '../helpers/gh.ts';
import { pubspec } from '../helpers/review.ts';
import { TempRepo, type Person } from '../helpers/repo.ts';
import { startUntangle, type UntangleRun } from '../helpers/run.ts';
import { read, rest } from './page.ts';

const skip = e2eSkip();
const ada = (date: string): Person => ({ name: 'Ada Review', email: 'ada@example.com', date });
const callLine = 6;
const printLine = 2;

const beforeApp = ['void greet() {', "  print('hi');", '}', '', 'void main() {', '  greet();', '}', ''].join('\n');
const afterApp = ['void greet(String name) {', '  print(name);', '}', '', 'void main() {', "  greet('ada');", '}', ''].join('\n');

/** The + is a pointer target, so a busy machine can drop the first move. */
async function showAdd(page: Browser, line: number): Promise<void> {
  const cell = `[data-c="R:${line}"]`;
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.hover(cell);
    try {
      await page.until(`document.querySelector('.cm-add')?.classList.contains('on')`, 5_000);
      return;
    } catch {
      // Try the move again.
    }
  }
  await page.until(`document.querySelector('.cm-add')?.classList.contains('on')`);
}

/** Types into a composer and waits until the box holds the text. */
async function fill(page: Browser, selector: string, text: string): Promise<void> {
  const want = JSON.stringify(text);
  const ready = `document.querySelector(${JSON.stringify(selector)})?.value === ${want}`;
  await page.click(selector);
  await page.type(text);
  try {
    await page.until(ready, 5_000);
  } catch {
    await page.click(selector);
    await page.type(text);
    await page.until(ready);
  }
}

function posted(gh: GhStub, mutation: string): string {
  const call = [...gh.calls()].reverse().find((item) => item.stdin.includes(`${mutation}(input:`));
  if (!call) throw new Error(`no ${mutation} call`);
  const body = JSON.parse(call.stdin) as { variables: { input: unknown } };
  return JSON.stringify(body.variables.input);
}

describe('Given a served review of pull request 7, with an open thread on the call and a resolved thread on the print, ', { skip, timeout: 300_000 }, () => {
  let repo: TempRepo | undefined;
  let gh: GhStub | undefined;
  let run: UntangleRun | undefined;
  let page: Browser | undefined;
  let cache = '';
  let url = '';
  let head = '';
  let baseSpec: ConversationSpec;

  before(async () => {
    const author = ada('2020-06-01T15:00:00Z');
    const later = ada('2020-06-02T15:00:00Z');
    repo = TempRepo.create();
    repo.write('pubspec.yaml', pubspec);
    repo.write('lib/app.dart', beforeApp);
    repo.commit({ subject: 'Start the package', author, committer: author });
    repo.branch('feature');
    repo.write('lib/app.dart', afterApp);
    head = repo.commit({ subject: 'Name the greeting', author: later, committer: later });
    baseSpec = {
      number: 7,
      title: 'Add a greeting',
      url: 'https://github.com/acme/sample/pull/7',
      head,
      threads: [
        { id: 'THREAD_1', path: 'lib/app.dart', line: callLine, body: 'Why this name?' },
        { id: 'THREAD_2', path: 'lib/app.dart', line: printLine, body: 'Ship the name.', resolved: true },
      ],
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
      { match: ['api', 'graphql'], stdinIncludes: pendingLookup, stdout: pendingAnswer(null) },
      { match: ['api', 'graphql'], stdinIncludes: 'organization(login:', stdout: { data: { organization: null } } },
      { match: ['api', 'graphql'], stdinIncludes: 'mentionableUsers', stdout: mentionAnswer() },
      { match: ['api', 'graphql'], stdinIncludes: 'issueOrPullRequest', stdout: issueAnswer() },
      { match: ['api', 'graphql'], stdinIncludes: 'addPullRequestReviewThreadReply', stdout: conversationOf({ ...baseSpec, threads: [{ id: 'THREAD_1', path: 'lib/app.dart', line: callLine, body: 'Why this name?', reply: 'Because it reads clearly.' }, { id: 'THREAD_2', path: 'lib/app.dart', line: printLine, body: 'Ship the name.', resolved: true }] }) },
      { match: ['api', 'graphql'], stdinIncludes: 'unresolveReviewThread', stdout: conversationOf(baseSpec) },
      { match: ['api', 'graphql'], stdinIncludes: 'resolveReviewThread', stdout: conversationOf({ ...baseSpec, threads: [{ id: 'THREAD_1', path: 'lib/app.dart', line: callLine, body: 'Why this name?', resolved: true }, { id: 'THREAD_2', path: 'lib/app.dart', line: printLine, body: 'Ship the name.', resolved: true }] }) },
      { match: ['api', 'graphql'], stdinIncludes: 'addPullRequestReviewThread', stdout: conversationOf({ ...baseSpec, pending: { id: 'REVIEW_PENDING', comments: 1 }, threads: [...baseSpec.threads!, { id: 'THREAD_3', path: 'lib/app.dart', line: callLine, body: 'Please rename it.', pending: true }] }) },
      { match: ['api', 'graphql'], stdinIncludes: 'addPullRequestReview', stdout: conversationOf({ ...baseSpec, reviews: [{ id: 'REVIEW_1', state: 'COMMENTED', body: 'Looks good.' }], threads: [...baseSpec.threads!, { id: 'THREAD_3', path: 'lib/app.dart', line: callLine, body: 'Looks good.' }] }) },
      { match: ['api', 'markdown'], stdout: '<p>ok</p>' },
      { match: ['api', 'graphql'], stdout: conversationOf(baseSpec) },
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

  async function openApp(): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      await page!.click('[data-tab="files"]');
      try {
        await page!.until(`!!document.querySelector('[data-open="lib/app.dart"]')`, 10_000);
        await page!.click('[data-open="lib/app.dart"]');
        await page!.until(`!!document.querySelector('.code[data-p="lib/app.dart"]')`, 10_000);
        return;
      } catch {
        // A click can be lost while the machine is busy.
      }
    }
    await page!.click('[data-tab="files"]');
    await page!.until(`!!document.querySelector('[data-open="lib/app.dart"]')`);
    await page!.click('[data-open="lib/app.dart"]');
    await page!.until(`!!document.querySelector('.code[data-p="lib/app.dart"]')`);
  }

  async function fresh(): Promise<void> {
    await page!.goto(url);
    await page!.until(`!!document.querySelector('.t-head')`, 30_000);
    await openApp();
    await page!.until(`(document.body.textContent || '').includes('Why this name?')`);
  }

  describe('when the file is opened, ', () => {
    let under: string;

    before(async () => {
      await rest(page!);
      await openApp();
      await page!.until(`(document.querySelector('[data-thread="THREAD_1"]')?.textContent || '').includes('Why this name?')`);
      under = await read(page!, `[...document.querySelectorAll('.th')].map((el) => el.textContent).join('\\n')`);
    });

    it('then the open thread sits under the call and the resolved one is folded.', () => {
      assert.equal(under.includes('Why this name?') && under.includes('Resolved by ada'), true);
    });
  });

  describe('when the Threads tab is opened, ', () => {
    let listed: string;

    before(async () => {
      await rest(page!);
      await page!.click('[data-tab="comments"]');
      await page!.until(`(document.querySelector('#vw-side')?.textContent || '').includes('Open threads')`);
      const text = await read(page!, `document.querySelector('#vw-side')?.textContent ?? ''`);
      listed = `${text.includes('Why this name?') ? 'open' : 'missing'}\n${text.includes('Ship the name.') ? 'shown' : 'hidden'}`;
    });

    it('then the open thread is listed and the resolved one is hidden.', () => {
      assert.equal(listed, 'open\nhidden');
    });
  });

  describe('when the resolved group is opened, ', () => {
    let listed: string;

    before(async () => {
      await rest(page!);
      await page!.click('[data-tab="comments"]');
      await page!.until(`(document.querySelector('#vw-side')?.textContent || '').includes('Open threads')`);
      await page!.click('[data-act="resolved-toggle"]');
      await page!.until(`(document.querySelector('#vw-side')?.textContent || '').includes('Ship the name.')`);
      const text = await read(page!, `document.querySelector('#vw-side')?.textContent ?? ''`);
      listed = text.includes('Ship the name.') ? 'shown' : 'hidden';
    });

    it('then the resolved thread is listed.', () => {
      assert.equal(listed, 'shown');
    });
  });

  describe('when a reply is sent on the open thread, ', () => {
    let thread: string;
    let sent: string;

    before(async () => {
      await fresh();
      await page!.click('[data-act="reply-open"]');
      await page!.until(`!!document.querySelector('textarea[data-draft="reply:THREAD_1"]')`);
      await fill(page!, 'textarea[data-draft="reply:THREAD_1"]', 'Because it reads clearly.');
      await page!.click('[data-act="gh-reply"][data-mode="single"]');
      await page!.until(`(document.querySelector('#vw-toast')?.textContent || '') === 'Reply posted'`);
      thread = await read(page!, `document.querySelector('[data-thread="THREAD_1"]')?.textContent ?? ''`);
      sent = posted(gh!, 'addPullRequestReviewThreadReply');
    });

    it('then the reply is under the thread.', () => {
      assert.equal(thread.includes('Why this name?') && thread.includes('Because it reads clearly.'), true);
    });

    it('then GitHub is asked to reply on that thread.', () => {
      assert.equal(sent, '{"pullRequestReviewThreadId":"THREAD_1","body":"Because it reads clearly."}');
    });
  });

  describe('when the open thread is resolved, ', () => {
    let resolved: string;

    before(async () => {
      await fresh();
      await page!.click('[data-act="gh-resolve"][data-thread="THREAD_1"]');
      await page!.until(`(document.querySelector('[data-thread="THREAD_1"] .th-fold')?.textContent || '').includes('Resolved')`);
      resolved = await read(page!, `(document.querySelector('[data-thread="THREAD_1"] .th-fold')?.textContent || '').includes('Resolved') ? 'resolved' : (document.querySelector('[data-thread="THREAD_1"]')?.textContent ?? '')`);
    });

    it('then the thread folds as resolved.', () => {
      assert.equal(resolved, 'resolved');
    });
  });

  describe('when the resolved thread is unresolved, ', () => {
    let opened: string;

    before(async () => {
      await fresh();
      await page!.click('[data-act="gh-resolve"][data-thread="THREAD_1"]');
      await page!.until(`(document.querySelector('[data-thread="THREAD_1"] .th-fold')?.textContent || '').includes('Resolved')`);
      await page!.click('[data-act="thread-toggle"][data-thread="THREAD_1"]');
      await page!.until(`!!document.querySelector('[data-act="gh-resolve"][data-thread="THREAD_1"]')`);
      await page!.click('[data-act="gh-resolve"][data-thread="THREAD_1"]');
      await page!.until(`(document.querySelector('[data-thread="THREAD_1"]')?.textContent || '').includes('Why this name?') && !(document.querySelector('[data-thread="THREAD_1"] .th-fold')?.textContent || '').includes('Resolved')`);
      opened = await read(page!, `(document.querySelector('[data-thread="THREAD_1"]')?.textContent || '').includes('Why this name?') && !(document.querySelector('[data-thread="THREAD_1"] .th-fold')?.textContent || '').includes('Resolved') ? 'open' : (document.querySelector('[data-thread="THREAD_1"]')?.textContent ?? '')`);
    });

    it('then the thread opens again.', () => {
      assert.equal(opened, 'open');
    });
  });

  describe('when the + on the call is clicked, ', () => {
    let buttons: string;

    before(async () => {
      await fresh();
      await showAdd(page!, callLine);
      await page!.click('.cm-add');
      await page!.until(`!!document.querySelector('[data-act="gh-thread"]')`);
      buttons = await read(page!, `[...document.querySelectorAll('[data-act="gh-thread"]')].map((el) => el.textContent).join('\\n')`);
    });

    it('then the comment can be sent on its own or can start a review.', () => {
      assert.equal(buttons, 'Add single comment\nStart a review');
    });
  });

  describe('when the + is dragged onto the print line, ', () => {
    let heading: string;

    before(async () => {
      await fresh();
      await showAdd(page!, callLine);
      await page!.dragOnto('.cm-add', `[data-c="R:${printLine}"]`);
      await page!.until(`(document.querySelector('.th-new-h b')?.textContent || '').includes('lines')`);
      heading = await read(page!, `document.querySelector('.th-new-h b')?.textContent ?? ''`);
    });

    it('then the comment covers the dragged lines.', () => {
      assert.equal(heading, `Comment on lines +${printLine} to +${callLine}`);
    });
  });

  describe('when the + on another line is shift-clicked, ', () => {
    let heading: string;

    before(async () => {
      await fresh();
      await showAdd(page!, printLine);
      await page!.click('.cm-add');
      await page!.until(`!!document.querySelector('.th-new-h')`);
      await showAdd(page!, callLine);
      await page!.shiftClick('.cm-add');
      await page!.until(`(document.querySelector('.th-new-h')?.textContent || '').includes('to +${callLine}')`);
      heading = await read(page!, `document.querySelector('.th-new-h')?.textContent ?? ''`);
    });

    it('then the comment covers the lines from the first to that one.', () => {
      assert.equal(heading, `Comment on lines +${printLine} to +${callLine}Drag the + over more lines, or shift-click it on another line of this hunk, for a range.`);
    });
  });

  describe('when Add single comment is clicked, ', () => {
    let sent: string;

    before(async () => {
      await fresh();
      await showAdd(page!, callLine);
      await page!.click('.cm-add');
      await page!.until(`!!document.querySelector('textarea.cmp-ta')`);
      await fill(page!, 'textarea.cmp-ta', 'Looks good.');
      await page!.click('[data-act="gh-thread"][data-mode="single"]');
      await page!.until(`(document.querySelector('#vw-toast')?.textContent || '') === 'Comment posted'`);
      sent = posted(gh!, 'addPullRequestReview');
    });

    it('then GitHub is asked for one comment on that line.', () => {
      assert.equal(sent, `{"pullRequestId":"PR_1","commitOID":"${head}","event":"COMMENT","threads":[{"path":"lib/app.dart","body":"Looks good.","line":${callLine},"side":"RIGHT"}]}`);
    });
  });

  describe('when Start a review is clicked, ', () => {
    let sent: string;
    let pending: string;

    before(async () => {
      await fresh();
      await showAdd(page!, callLine);
      await page!.click('.cm-add');
      await page!.until(`!!document.querySelector('textarea.cmp-ta')`);
      await fill(page!, 'textarea.cmp-ta', 'Please rename it.');
      await page!.click('[data-act="gh-thread"][data-mode="review"]');
      await page!.until(`(document.querySelector('#vw-toast')?.textContent || '') === 'Added to your pending review'`);
      sent = posted(gh!, 'addPullRequestReviewThread');
      pending = await read(page!, `document.querySelector('.cm.pending') ? 'pending' : 'posted'`);
    });

    it('then the comment joins a review instead of posting on its own.', () => {
      assert.equal(`${pending}\n${sent}`, `pending\n{"pullRequestId":"PR_1","path":"lib/app.dart","body":"Please rename it.","subjectType":"LINE","line":${callLine},"side":"RIGHT"}`);
    });
  });

  describe('when @ is typed in a comment, ', () => {
    let suggestions: string;

    before(async () => {
      await fresh();
      await showAdd(page!, callLine);
      await page!.click('.cm-add');
      await page!.until(`!!document.querySelector('textarea.cmp-ta')`);
      await fill(page!, 'textarea.cmp-ta', '@');
      await page!.until(`document.querySelector('.mn-pop') && !document.querySelector('.mn-pop').hidden && (document.querySelector('.mn-pop')?.textContent || '').includes('grace')`);
      suggestions = await read(page!, `document.querySelector('.mn-pop')?.textContent ?? ''`);
    });

    it('then the people on the pull request are suggested.', () => {
      assert.equal(suggestions.includes('grace'), true);
    });
  });

  describe('when #12 is typed in a comment, ', () => {
    let suggestions: string;

    before(async () => {
      await fresh();
      await showAdd(page!, callLine);
      await page!.click('.cm-add');
      await page!.until(`!!document.querySelector('textarea.cmp-ta')`);
      await fill(page!, 'textarea.cmp-ta', '#12');
      await page!.until(`(document.querySelector('.mn-pop')?.textContent || '').includes('The name')`);
      suggestions = await read(page!, `document.querySelector('.mn-pop')?.textContent ?? ''`);
    });

    it('then issue 12 is suggested.', () => {
      assert.equal(suggestions.includes('#12') && suggestions.includes('The name'), true);
    });
  });

  describe('when the review is approved, ', () => {
    let sent: string;

    before(async () => {
      await fresh();
      await page!.click('.rv-btn');
      await page!.until(`!!document.querySelector('.rv-pop')`);
      await page!.click('input[value="APPROVE"]');
      await fill(page!, 'textarea[data-draft="review"]', 'Ship it.');
      await page!.click('[data-act="gh-submit"]');
      await page!.until(`(document.querySelector('#vw-toast')?.textContent || '') === 'Approved'`);
      sent = posted(gh!, 'addPullRequestReview');
    });

    it('then GitHub is asked to approve, with that comment.', () => {
      assert.equal(sent, `{"pullRequestId":"PR_1","commitOID":"${head}","event":"APPROVE","body":"Ship it."}`);
    });
  });

  describe('when the review requests changes, ', () => {
    let sent: string;

    before(async () => {
      await fresh();
      await page!.click('.rv-btn');
      await page!.until(`!!document.querySelector('.rv-pop')`);
      await page!.click('input[value="REQUEST_CHANGES"]');
      await fill(page!, 'textarea[data-draft="review"]', 'Please rename it.');
      await page!.click('[data-act="gh-submit"]');
      await page!.until(`(document.querySelector('#vw-toast')?.textContent || '') === 'Changes requested'`);
      sent = posted(gh!, 'addPullRequestReview');
    });

    it('then GitHub is asked to request changes.', () => {
      assert.equal(sent, `{"pullRequestId":"PR_1","commitOID":"${head}","event":"REQUEST_CHANGES","body":"Please rename it."}`);
    });
  });

  describe('when the review is submitted as a comment, ', () => {
    let sent: string;

    before(async () => {
      await fresh();
      await page!.click('.rv-btn');
      await page!.until(`!!document.querySelector('.rv-pop')`);
      await fill(page!, 'textarea[data-draft="review"]', 'A note.');
      await page!.click('[data-act="gh-submit"]');
      await page!.until(`(document.querySelector('#vw-toast')?.textContent || '') === 'Review submitted'`);
      sent = posted(gh!, 'addPullRequestReview');
    });

    it('then GitHub is asked to comment.', () => {
      assert.equal(sent, `{"pullRequestId":"PR_1","commitOID":"${head}","event":"COMMENT","body":"A note."}`);
    });
  });
});
