import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { e2eSkip, launchBrowser, type Browser } from '../helpers/browser.ts';
import { conversationOf, pendingAnswer, pendingLookup, type ConversationSpec } from '../helpers/conversation.ts';
import type { GhReply, GhStub } from '../helpers/gh.ts';
import { stubGh } from '../helpers/gh.ts';
import { reviewClient, waitForReview } from '../helpers/http.ts';
import { pubspec } from '../helpers/review.ts';
import { TempRepo, type Person } from '../helpers/repo.ts';
import { startUntangle, type UntangleRun } from '../helpers/run.ts';
import { read } from './page.ts';

const skip = e2eSkip();
const ada = (date: string): Person => ({ name: 'Ada Review', email: 'ada@example.com', date });
const beforeApp = "void greet() {\n  print('hi');\n}\n";
const afterApp = "void greet(String name) {\n  print(name);\n}\n";

function replies(repo: TempRepo, head: string, spec: ConversationSpec): GhReply[] {
  return [
    {
      match: ['pr', 'view'],
      stdout: {
        number: 7, title: 'Add a greeting', url: spec.url, state: 'OPEN',
        baseRefName: 'main', baseRefOid: repo.rev('main'), headRefName: 'feature', headRefOid: head,
      },
    },
    { match: ['api', 'graphql'], stdinIncludes: 'statusCheckRollup', stdout: { data: { repository: { pullRequest: { commits: { nodes: [] }, reviews: { nodes: [] }, timelineItems: { nodes: [] } } } } } },
    { match: ['api', 'graphql'], stdinIncludes: pendingLookup, stdout: pendingAnswer(null) },
    { match: ['api', 'graphql'], stdinIncludes: 'organization(login:', stdout: { data: { organization: null } } },
    { match: ['api', 'graphql'], stdout: conversationOf(spec) },
  ];
}

describe('Given a served review whose GitHub conversation has one comment, ', { skip, timeout: 180_000 }, () => {
  let repo: TempRepo | undefined;
  let gh: GhStub | undefined;
  let run: UntangleRun | undefined;
  let page: Browser | undefined;
  let cache = '';
  let head = '';
  let spec: ConversationSpec;

  before(async () => {
    const author = ada('2020-10-01T15:00:00Z');
    repo = TempRepo.create();
    repo.write('pubspec.yaml', pubspec);
    repo.write('lib/app.dart', beforeApp);
    repo.commit({ subject: 'Start', author, committer: author });
    repo.branch('feature');
    repo.write('lib/app.dart', afterApp);
    head = repo.commit({ subject: 'Name it', author, committer: author });
    spec = { number: 7, title: 'Add a greeting', url: 'https://github.com/acme/sample/pull/7', head, threads: [{ id: 'THREAD_1', path: 'lib/app.dart', line: 2, body: 'Why this name?' }] };
    gh = stubGh(replies(repo, head, spec));
    cache = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-cache-'));
    run = await startUntangle(repo.dir, { cacheDir: cache, gh });
    await waitForReview(reviewClient(run.url));
    page = await launchBrowser();
    await page.installClock();
    await page.reducedMotion(true);
    await page.goto(run.url);
    await page.until(`!!document.querySelector('.t-head')`, 30_000);
    await page.click('[data-tab="files"]');
    await page.click('[data-open="lib/app.dart"]');
    await page.until(`(document.body.textContent || '').includes('Why this name?')`);
  });

  after(async () => {
    await page?.close();
    await run?.stop();
    gh?.remove();
    repo?.remove();
    if (cache) fs.rmSync(cache, { recursive: true, force: true });
  });

  describe('when a minute passes, ', () => {
    let shown: string;
    let asked: string;

    before(async () => {
      const calls = gh!.calls().length;
      gh!.setReplies(replies(repo!, head, { ...spec, threads: [{ id: 'THREAD_1', path: 'lib/app.dart', line: 2, body: 'Why this name?', reply: 'A later thought.' }] }));
      await page!.advance(61_000);
      await page!.until(`(document.body.textContent || '').includes('A later thought.')`);
      shown = await read(page!, `(document.body.textContent || '').includes('A later thought.') ? 'shown' : 'hidden'`);
      asked = gh!.calls().length > calls ? 'asked' : 'quiet';
    });

    it('then GitHub is asked again and the new comment is shown.', () => {
      assert.equal(`${asked}\n${shown}`, 'asked\nshown');
    });
  });
});

describe('Given a served review of a greeting, ', { skip, timeout: 180_000 }, () => {
  let repo: TempRepo | undefined;
  let run: UntangleRun | undefined;
  let page: Browser | undefined;
  let cache = '';

  before(async () => {
    const author = ada('2020-10-02T15:00:00Z');
    repo = TempRepo.create();
    repo.write('pubspec.yaml', pubspec);
    repo.write('lib/app.dart', beforeApp);
    repo.commit({ subject: 'Start', author, committer: author });
    repo.branch('feature');
    repo.write('lib/app.dart', afterApp);
    repo.commit({ subject: 'Name it', author, committer: author });
    cache = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-cache-'));
    run = await startUntangle(repo.dir, { base: 'main', cacheDir: cache });
    await waitForReview(reviewClient(run.url));
    page = await launchBrowser();
    await page.installClock();
    await page.goto(run.url);
    await page.until(`!!document.querySelector('.t-head')`, 30_000);
  });

  after(async () => {
    await page?.close();
    await run?.stop();
    repo?.remove();
    if (cache) fs.rmSync(cache, { recursive: true, force: true });
  });

  describe('when two minutes pass after a new commit, ', () => {
    let banner: string;

    before(async () => {
      const author = ada('2020-10-03T15:00:00Z');
      repo!.write('lib/app.dart', "void greet(String name) {\n  print(name);\n  print('again');\n}\n");
      const next = repo!.commit({ subject: 'Say it again', author, committer: author });
      await page!.advance(121_000);
      await page!.until(`(document.querySelector('#vw-fresh')?.textContent || '').includes('New commits:')`);
      banner = await read(page!, `document.querySelector('#vw-fresh')?.textContent ?? ''`);
      banner = banner.includes('New commits:') && banner.includes(next.slice(0, 7)) ? `New commits: ${next.slice(0, 7)}` : banner;
    });

    it('then the new-commits banner shows.', () => {
      assert.equal(banner.startsWith('New commits: '), true);
    });
  });
});
