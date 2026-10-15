import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { jsonScript, reviewClient, waitForReview, type ReviewClient } from '../helpers/http.ts';
import { stubGh, type GhStub } from '../helpers/gh.ts';
import { pubspec } from '../helpers/review.ts';
import { TempRepo, type Person } from '../helpers/repo.ts';
import { startUntangle, type UntangleRun } from '../helpers/run.ts';

const ada: Person = { name: 'Ada Review', email: 'ada@example.com', date: '2020-06-01T00:00:00Z' };
const later: Person = { ...ada, date: '2020-06-02T00:00:00Z' };
const newest: Person = { ...ada, date: '2020-06-03T00:00:00Z' };

function view(number: number, base: string, head: string) {
  return {
    number,
    title: 'Add a greeting',
    url: `https://github.com/acme/sample/pull/${number}`,
    state: 'OPEN',
    baseRefName: 'main',
    baseRefOid: base,
    headRefName: 'feature',
    headRefOid: head,
  };
}

/** The progress lines the page reported while the review was built. */
async function progressOf(client: ReviewClient): Promise<string[]> {
  const seen: string[] = [];
  const deadline = Date.now() + 180_000;
  await client.open();
  while (Date.now() < deadline) {
    const status = await client.call('status');
    const data = status.data as { phase?: string; steps?: Array<{ detail?: string }> };
    for (const step of data.steps ?? []) {
      if (step.detail && !seen.includes(step.detail)) seen.push(step.detail);
    }
    const page = await client.page();
    if (data.phase === 'ready' || (page.status === 200 && page.text.includes('id="d-model"'))) return seen;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`the review did not become ready\n${seen.join('\n')}`);
}

describe('Given a pull request URL whose repository is a local bare repo, ', () => {
  let work: TempRepo | undefined;
  let mirror = '';
  let cache = '';
  let gh: GhStub | undefined;
  let first: UntangleRun | undefined;
  let second: UntangleRun | undefined;
  let base = '';
  let head = '';
  let next = '';
  let env: NodeJS.ProcessEnv = {};
  let firstProgress: string[] = [];
  let secondProgress: string[] = [];
  let offered = '';

  before(async () => {
    mirror = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-mirror-'));
    const bare = path.join(mirror, 'acme', 'sample.git');
    fs.mkdirSync(path.dirname(bare), { recursive: true });
    execFileSync('git', ['init', '--bare', '-b', 'main', bare], { stdio: 'ignore' });
    work = TempRepo.create();
    work.write('pubspec.yaml', pubspec);
    work.write('lib/a.dart', "void greet() {\n  print('hi');\n}\n");
    work.commit({ subject: 'start', author: ada, committer: ada });
    base = work.rev('HEAD');
    work.branch('feature');
    work.write('lib/a.dart', "void greet() {\n  print('hello');\n}\n");
    head = work.commit({ subject: 'change', author: later, committer: later });
    work.remoteAdd('origin', bare);
    work.push('origin', 'main');
    execFileSync('git', ['-C', work.dir, 'push', 'origin', `HEAD:refs/pull/7/head`], { stdio: 'ignore' });
    execFileSync('git', ['-C', work.dir, 'push', 'origin', `HEAD:refs/pull/8/head`], { stdio: 'ignore' });
    cache = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-cache-'));
    env = {
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: `url.file://${mirror}/.insteadOf`,
      GIT_CONFIG_VALUE_0: 'https://github.com/',
    };
    gh = stubGh([{ match: ['pr', 'view'], stdout: view(7, base, head) }]);
    first = await startUntangle('https://github.com/acme/sample/pull/7', { cacheDir: cache, gh, env, quiet: false });
    firstProgress = await progressOf(reviewClient(first.url));
  });

  after(async () => {
    await second?.stop();
    await first?.stop();
    gh?.remove();
    work?.remove();
    if (mirror) fs.rmSync(mirror, { recursive: true, force: true });
    if (cache) fs.rmSync(cache, { recursive: true, force: true });
  });

  describe('when the pull request is reviewed, ', () => {
    it('then the review is served from a clone of that repository.', () => {
      const clone = path.join(cache, 'repos', 'github.com', 'acme', 'sample.git');
      const lines = firstProgress.join('\n');
      assert.equal(
        `${first!.url.startsWith('http://127.0.0.') ? 'served' : first!.url}\n${fs.existsSync(clone) ? 'cloned' : 'missing'}\n${lines.includes('cloning acme/sample') ? 'cloning' : lines}`,
        'served\ncloned\ncloning',
      );
    });
  });

  describe('when a second pull request of the same repository is reviewed, ', () => {
    before(async () => {
      gh!.setReplies([{ match: ['pr', 'view'], stdout: view(8, base, head) }]);
      second = await startUntangle('https://github.com/acme/sample/pull/8', { cacheDir: cache, gh, env, quiet: false });
      secondProgress = await progressOf(reviewClient(second.url));
    });

    it('then it fetches the pull request and does not clone again.', () => {
      const lines = secondProgress.join('\n');
      assert.equal(`${lines.includes('fetching') ? 'fetching' : lines}\n${lines.includes('cloning') ? 'cloned again' : 'not cloned'}`, 'fetching\nnot cloned');
    });
  });

  describe('when the pull request gains a commit, ', () => {
    before(async () => {
      work!.write('lib/a.dart', "void greet() {\n  print('hello');\n  print('again');\n}\n");
      next = work!.commit({ subject: 'again', author: newest, committer: newest });
      execFileSync('git', ['-C', work!.dir, 'push', '--force', 'origin', `HEAD:refs/pull/7/head`], { stdio: 'ignore' });
      gh!.setReplies([{ match: ['pr', 'view'], stdout: view(7, base, next) }]);
      const client = reviewClient(first!.url);
      await client.open();
      const deadline = Date.now() + 60_000;
      let latest = '';
      while (Date.now() < deadline) {
        const answer = await client.call('refresh', { query: { check: '1' } });
        const data = answer.data as { latest?: string };
        latest = data.latest ?? '';
        if (latest === next) break;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      offered = latest === next ? 'offered' : latest;
    });

    it('then the review offers those new commits.', () => {
      assert.equal(offered, 'offered');
    });
  });
});

describe('Given a merged pull request whose recorded base commit is not an ancestor of its head, ', () => {
  let work: TempRepo | undefined;
  let mirror = '';
  let cache = '';
  let gh: GhStub | undefined;
  let baseCommit = '';
  let fork = '';

  before(() => {
    mirror = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-mirror-'));
    const bare = path.join(mirror, 'acme', 'sample.git');
    fs.mkdirSync(path.dirname(bare), { recursive: true });
    execFileSync('git', ['init', '--bare', '-b', 'main', bare], { stdio: 'ignore' });
    execFileSync('git', ['-C', bare, 'config', 'uploadpack.allowReachableSHA1InWant', 'true'], { stdio: 'ignore' });
    work = TempRepo.create();
    work.write('pubspec.yaml', pubspec);
    work.write('lib/a.dart', "void greet() {\n  print('hi');\n}\n");
    fork = work.commit({ subject: 'start', author: ada, committer: ada });
    work.branch('side');
    work.write('lib/a.dart', "void greet() {\n  print('base');\n}\n");
    baseCommit = work.commit({ subject: 'the recorded base', author: later, committer: later });
    work.checkout('main');
    work.branch('feature');
    work.write('lib/a.dart', "void greet() {\n  print('hello');\n}\n");
    const head = work.commit({ subject: 'change', author: newest, committer: newest });
    work.remoteAdd('origin', bare);
    work.push('origin', 'main');
    work.push('origin', 'side');
    execFileSync('git', ['-C', work.dir, 'push', 'origin', `HEAD:refs/pull/7/head`], { stdio: 'ignore' });
    cache = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-cache-'));
    gh = stubGh([{
      match: ['pr', 'view'],
      stdout: { ...view(7, baseCommit, head), state: 'MERGED' },
    }]);
  });

  after(() => {
    gh?.remove();
    work?.remove();
    if (mirror) fs.rmSync(mirror, { recursive: true, force: true });
    if (cache) fs.rmSync(cache, { recursive: true, force: true });
  });

  describe('when the pull request is reviewed, ', () => {
    let run: UntangleRun | undefined;
    let fetched = '';
    let notes = '';
    let base = '';

    before(async () => {
      run = await startUntangle('https://github.com/acme/sample/pull/7', {
        cacheDir: cache,
        gh,
        quiet: false,
        env: {
          GIT_CONFIG_COUNT: '1',
          GIT_CONFIG_KEY_0: `url.file://${mirror}/.insteadOf`,
          GIT_CONFIG_VALUE_0: 'https://github.com/',
        },
      });
      const html = await waitForReview(reviewClient(run.url));
      base = (jsonScript(html, 'd-model') as { compares: { base: { left: string } } }).compares.base.left;
      const clone = path.join(cache, 'repos', 'github.com', 'acme', 'sample.git');
      try {
        execFileSync('git', ['-C', clone, 'cat-file', '-e', `${baseCommit}^{commit}`], { stdio: 'ignore' });
        fetched = 'in the clone';
      } catch {
        fetched = 'missing';
      }
      notes = run.output().split('\n').filter((line) => line.includes('#7 is merged')).map((line) => line.trim()).join('\n');
    });

    after(async () => {
      await run?.stop();
    });

    it('then the recorded base commit is fetched into the clone.', () => {
      assert.equal(fetched, 'in the clone');
    });

    it('then the progress says it compares with main as it was then.', () => {
      assert.equal(notes, '#7 is merged: comparing with main as it was then');
    });

    it('then the comparison starts where the two histories meet.', () => {
      assert.equal(base, fork.slice(0, 7));
    });
  });
});
