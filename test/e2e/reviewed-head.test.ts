import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { e2eSkip, launchBrowser, type Browser } from '../helpers/browser.ts';
import type { GhStub } from '../helpers/gh.ts';
import { stubGh } from '../helpers/gh.ts';
import { reviewClient, waitForReview } from '../helpers/http.ts';
import { pullRequestGh } from '../helpers/pull-request.ts';
import { pubspec } from '../helpers/review.ts';
import { TempRepo, type Person } from '../helpers/repo.ts';
import { startUntangle, type UntangleRun } from '../helpers/run.ts';
import { saveReviewedHead } from '../helpers/story.ts';
import { dayOf, read, rest } from './page.ts';

const skip = e2eSkip();
const ada = (date: string): Person => ({ name: 'Ada Review', email: 'ada@example.com', date });
const dot = '\u00b7';
const pushedAt = '2020-01-18T15:00:00Z';
const startApp = "void greet() {\n  print('hi');\n}\n";
const namedApp = "void greet(String name) {\n  print(name);\n}\n";
const amendedApp = "void greet(String name) {\n  print('ada');\n}\n";

const rowText = `[el => el ? [el.dataset.why, el.querySelector('.hs-s')?.textContent ?? '', el.querySelector('.hs-m')?.textContent ?? ''].join('\\n') : 'none'][0](document.querySelector('button.old-head'))`;

function shown(why: string, who: string, sha: string, when: string, extra: string): string {
  return [why, who, `${sha.slice(0, 7)} ${dot} ${dayOf(when)}${extra}`].join('\n');
}

describe('Given a review saved at a head that was then amended, and GitHub reports that force push, ', { skip, timeout: 180_000 }, () => {
  let repo: TempRepo | undefined;
  let gh: GhStub | undefined;
  let run: UntangleRun | undefined;
  let page: Browser | undefined;
  let cache = '';
  let oldHead = '';

  before(async () => {
    const author = ada('2020-01-04T15:00:00Z');
    repo = TempRepo.create();
    repo.write('pubspec.yaml', pubspec);
    repo.write('lib/app.dart', startApp);
    const base = repo.commit({ subject: 'Start', author, committer: author });
    repo.branch('feature');
    repo.write('lib/app.dart', namedApp);
    oldHead = repo.commit({ subject: 'Name it', author: ada('2020-01-05T15:00:00Z'), committer: ada('2020-01-05T15:00:00Z') });
    saveReviewedHead(repo, 'untangle/pr-7', oldHead, base, ada(pushedAt));
    repo.write('lib/app.dart', amendedApp);
    const head = repo.amend({ subject: 'Name it', author: ada('2020-01-06T15:00:00Z'), committer: ada('2020-01-06T15:00:00Z') });
    gh = pullRequestGh({
      number: 7,
      title: 'Add a greeting',
      url: 'https://github.com/acme/sample/pull/7',
      base: 'main',
      baseSha: base,
      head: 'feature',
      headSha: head,
      pushes: [{ actor: 'ada', before: oldHead, after: head, at: pushedAt }],
    });
    cache = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-cache-'));
    run = await startUntangle(repo.dir, { cacheDir: cache, gh });
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
    gh?.remove();
    if (cache) fs.rmSync(cache, { recursive: true, force: true });
  });

  describe('when History is opened, ', () => {
    let row: string;

    before(async () => {
      await rest(page!);
      await page!.click('[data-act="history-open"]');
      await page!.until(`!!document.querySelector('button.old-head:not([disabled])')`, 30_000);
      row = await read(page!, rowText);
    });

    it('then that old head is the force push and your review.', () => {
      assert.equal(row, shown('review', 'Force-pushed by ada', oldHead, pushedAt, ` ${dot} 1 commit replaced ${dot} your review`));
    });
  });
});

describe('Given a review saved at a head that was then amended, and the branch has no pull request, ', { skip, timeout: 180_000 }, () => {
  let repo: TempRepo | undefined;
  let gh: GhStub | undefined;
  let run: UntangleRun | undefined;
  let page: Browser | undefined;
  let cache = '';
  let oldHead = '';
  const reviewedAt = '2020-01-18T15:00:00Z';

  before(async () => {
    const author = ada('2020-01-04T15:00:00Z');
    repo = TempRepo.create();
    repo.write('pubspec.yaml', pubspec);
    repo.write('lib/app.dart', startApp);
    const base = repo.commit({ subject: 'Start', author, committer: author });
    repo.branch('feature');
    repo.write('lib/app.dart', namedApp);
    oldHead = repo.commit({ subject: 'Name it', author: ada('2020-01-05T15:00:00Z'), committer: ada('2020-01-05T15:00:00Z') });
    saveReviewedHead(repo, 'untangle/feature', oldHead, base, ada(reviewedAt));
    repo.write('lib/app.dart', amendedApp);
    repo.amend({ subject: 'Name it', author: ada('2020-01-06T15:00:00Z'), committer: ada('2020-01-06T15:00:00Z') });
    gh = stubGh();
    cache = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-cache-'));
    run = await startUntangle(repo.dir, { base: 'main', cacheDir: cache, gh });
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
    gh?.remove();
    if (cache) fs.rmSync(cache, { recursive: true, force: true });
  });

  describe('when History is opened, ', () => {
    let row: string;

    before(async () => {
      await rest(page!);
      await page!.click('[data-act="history-open"]');
      await page!.until(`!!document.querySelector('button.old-head:not([disabled])')`, 30_000);
      row = await read(page!, rowText);
    });

    it('then that old head is your review of a head the branch no longer has.', () => {
      assert.equal(row, shown('review', 'Your review, of a head the branch no longer has', oldHead, reviewedAt, ` ${dot} 1 commit replaced`));
    });
  });
});
