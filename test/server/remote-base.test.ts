import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { reviewClient, waitForReview, jsonScript, type ReviewClient } from '../helpers/http.ts';
import { stubGh, type GhStub } from '../helpers/gh.ts';
import { pubspec } from '../helpers/review.ts';
import { TempRepo, type Person } from '../helpers/repo.ts';
import { startUntangle, type UntangleRun } from '../helpers/run.ts';
import { slowGit, type SlowGit } from '../helpers/slow-git.ts';

const ada = (date: string): Person => ({ name: 'Ada Review', email: 'ada@example.com', date });

function git(repo: string, args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
}

/** The progress lines the page reported while the review was built. */
async function progressOf(client: ReviewClient): Promise<string[]> {
  const seen: string[] = [];
  const deadline = Date.now() + 180_000;
  await client.open();
  while (Date.now() < deadline) {
    const status = await client.call('status');
    const data = status.data as { phase?: string; steps?: Array<{ detail?: string; notes?: string[] }> };
    for (const step of data.steps ?? []) {
      if (step.detail && !seen.includes(step.detail)) seen.push(step.detail);
      for (const note of step.notes ?? []) if (!seen.includes(note)) seen.push(note);
    }
    const page = await client.page();
    if (data.phase === 'ready' || (page.status === 200 && page.text.includes('id="d-model"'))) return seen;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`the review did not become ready\n${seen.join('\n')}`);
}

/**
 * A feature whose parent is the new main, while the clone's main and origin/main still name the old one.
 * Returns the old main, the new main, and the feature head.
 */
function staleClone(origin: TempRepo): { repo: TempRepo; oldMain: string; newMain: string } {
  const repo = TempRepo.create();
  repo.write('pubspec.yaml', pubspec);
  repo.write('lib/a.dart', "void greet() {\n  print('hi');\n}\n");
  const oldMain = repo.commit({ subject: 'start', author: ada('2020-06-01T00:00:00Z'), committer: ada('2020-06-01T00:00:00Z') });
  repo.remoteAdd('origin', origin.dir);
  repo.push('origin', 'main');
  repo.write('lib/a.dart', "void greet() {\n  print('hi');\n  print('on main');\n}\n");
  const newMain = repo.commit({ subject: 'move main', author: ada('2020-06-02T00:00:00Z'), committer: ada('2020-06-02T00:00:00Z') });
  repo.push('origin', 'main');
  repo.branch('feature');
  repo.write('lib/a.dart', "void greet() {\n  print('hi');\n  print('on main');\n  print('on feature');\n}\n");
  repo.commit({ subject: 'change', author: ada('2020-06-03T00:00:00Z'), committer: ada('2020-06-03T00:00:00Z') });
  git(repo.dir, ['update-ref', 'refs/heads/main', oldMain]);
  git(repo.dir, ['update-ref', 'refs/remotes/origin/main', oldMain]);
  git(repo.dir, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);
  return { repo, oldMain, newMain };
}

describe('Given a clone whose origin main has moved and whose branch has no pull request, ', () => {
  let origin: TempRepo | undefined;
  let repo: TempRepo | undefined;
  let gh: GhStub | undefined;
  let gitBin: SlowGit | undefined;
  let cache = '';
  let newMain = '';

  before(() => {
    origin = TempRepo.bare();
    const built = staleClone(origin);
    repo = built.repo;
    newMain = built.newMain;
    gh = stubGh();
    gitBin = slowGit(['fetch']);
    cache = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-cache-'));
  });

  after(() => {
    gh?.remove();
    repo?.remove();
    origin?.remove();
    gitBin?.remove();
    if (cache) fs.rmSync(cache, { recursive: true, force: true });
  });

  describe('when the directory is reviewed, ', () => {
    let run: UntangleRun | undefined;
    let fetching = '';
    let notes = '';
    let base = '';

    before(async () => {
      run = await startUntangle(repo!.dir, {
        base: null,
        cacheDir: cache,
        gh,
        quiet: false,
        env: { PATH: `${gitBin!.dir}${path.delimiter}${gh!.env.PATH}` },
      });
      const client = reviewClient(run.url);
      fetching = (await progressOf(client)).filter((line) => line.startsWith('fetching')).join('\n');
      base = (jsonScript(await waitForReview(client), 'd-model') as { compares: { base: { left: string } } }).compares.base.left;
      notes = run.output().split('\n').filter((line) => line.includes('no pull request')).map((line) => line.trim()).join('\n');
    });

    after(async () => {
      await run?.stop();
    });

    it('then the progress says it fetches origin/main.', () => {
      assert.equal(fetching, 'fetching origin/main');
    });

    it('then it says the branch has no pull request and compares with main.', () => {
      assert.equal(notes, 'no pull request for this branch: comparing with main');
    });

    it('then the review compares with the new main.', () => {
      assert.equal(base, newMain.slice(0, 7));
    });
  });
});

describe('Given a clone whose origin cannot be fetched, ', () => {
  let origin: TempRepo | undefined;
  let repo: TempRepo | undefined;
  let gh: GhStub | undefined;
  let cache = '';
  let oldMain = '';

  before(() => {
    origin = TempRepo.bare();
    const built = staleClone(origin);
    repo = built.repo;
    oldMain = built.oldMain;
    git(repo.dir, ['remote', 'set-url', 'origin', path.join(os.tmpdir(), 'untangle-no-such-origin')]);
    gh = stubGh();
    cache = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-cache-'));
  });

  after(() => {
    gh?.remove();
    repo?.remove();
    origin?.remove();
    if (cache) fs.rmSync(cache, { recursive: true, force: true });
  });

  describe('when the directory is reviewed, ', () => {
    let run: UntangleRun | undefined;
    let notes = '';
    let base = '';

    before(async () => {
      run = await startUntangle(repo!.dir, { base: null, cacheDir: cache, gh, quiet: false });
      base = (jsonScript(await waitForReview(reviewClient(run.url)), 'd-model') as { compares: { base: { left: string } } }).compares.base.left;
      notes = run.output().split('\n').filter((line) => line.includes('could not fetch')).map((line) => line.trim()).join('\n');
    });

    after(async () => {
      await run?.stop();
    });

    it('then it says it uses the local copy of main.', () => {
      assert.equal(notes, 'could not fetch origin/main; using the local copy');
    });

    it('then the review compares with the old main.', () => {
      assert.equal(base, oldMain.slice(0, 7));
    });
  });
});
